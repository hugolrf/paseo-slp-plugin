// Central client map — server side of the "Clientes" screen.
//
// Reads, validation and diagnosis reuse plugin/server/runtime/cli/clients.ts
// and routing.ts (the code `slp.mjs clients validate`, readCatalog and seat
// formation run); nothing here restates a rule. Writes are three whole-file
// replacements (map, one client's pool, one client's protocol) that
//   1. re-run the same validation the screen showed,
//   2. require `confirm` = sha256 of the exact bytes to be written,
//   3. require the sha256 CAS token of the file as it was read,
//   4. append one audit line (who/when/file/hash before and after — never
//      content) BEFORE the atomic rename, aborting the write if it fails,
//   5. only touch paths below <canonicalHome>/slp-clients, creating
//      directories only for a validated client directory, never following a
//      symlink.
// These are plugin-only RPCs: no Desk tool and no slp.mjs command imports this
// module (tests/central-clients-ui-server.test.mjs proves it structurally).
// The daemon cannot tell the Manager screen from another local process, so
// confirm/CAS/audit are convention-level defense in depth, not a boundary.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import {
  OperationConflict,
  PeerPool,
  type ExplainResolutionResult,
  type GetClientFilesResult,
  type GetClientsResult,
  type IdentifyRepositoryResult,
  type SetClientPoolRequest,
  type SetClientProtocolRequest,
  type SetClientsRequest,
  type SetClientsResult,
  type ValidateClientsDraftRequest,
  type ValidateClientsDraftResult,
  ExplainResolutionInput,
  GetClientFilesInput,
  GetClientsInput,
  IdentifyRepositoryInput,
  SetClientPoolInput,
  SetClientProtocolInput,
  SetClientsInput,
  ValidateClientsDraftInput,
} from "../shared/contracts.ts";
import { catalogTokenConflicts } from "../shared/runtime/routing-vocabulary.ts";
import { sha256Hex } from "./config-view.ts";
import { resolveDaemonHome } from "./daemon-home.ts";
import { guardPresetWrite } from "./peer-pool-compatibility.ts";
import {
  CLIENT_FILE_MAX_BYTES,
  ClientMapError,
  checkMapHost,
  entryForCommonDir,
  identifyCheckout,
  parseClientMap,
  readBelow,
  readClientMapRaw,
  serializeClientMap,
  traceSourceFor,
  type ClientMap,
} from "./runtime/cli/clients.ts";
import { readCatalog, validateCatalog } from "./runtime/cli/routing.ts";

const AUDIT_FILE = "audit.log";
const AUDIT_ROTATE_BYTES = 512 * 1024;
const AUDIT_READ_BYTES = 1024 * 1024;
const POOL = "slp-routing.json";
const PROTOCOL = "workspace-protocol.md";

export interface ClientsStoreDeps {
  guardPresetWrite?: typeof guardPresetWrite;
  uuid?: () => string;
  now?: () => Date;
}

const invalid = (message: string) => new OperationConflict("INVALID_REQUEST", message);
const parseInput = <T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string; path: PropertyKey[] }[] } } }, name: string, input: unknown): T => {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(`invalid ${name} input: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "schema"}`);
  }
  return parsed.data;
};
const textOf = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createClientsStore(deps: ClientsStoreDeps = {}) {
  const uuid = deps.uuid ?? randomUUID;
  const now = deps.now ?? (() => new Date());
  const homeOf = (target: { hostId: string; daemonHome: string }) =>
    resolveDaemonHome(target, "config.json must be a regular file, not a link").canonicalHome;

  // ---- audit ------------------------------------------------------------
  type AuditLine = { at: string; actor: string; hostId: string; action: string; file: string; before: string | null; after: string | null };
  const readAudit = (home: string): AuditLine[] => {
    let bytes: Buffer | null;
    try { bytes = readBelow(home, ["slp-clients", AUDIT_FILE], AUDIT_READ_BYTES, "CLIENT_MAP_INVALID", "audit log"); }
    catch { return []; }
    if (bytes === null) return [];
    const lines: AuditLine[] = [];
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line) continue;
      try { lines.push(JSON.parse(line) as AuditLine); } catch { /* ignore a torn line */ }
    }
    return lines;
  };
  const lastWritten = (lines: AuditLine[], file: string): string | null => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.file === file && lines[i]!.action !== "failed") return lines[i]!.after;
    return null;
  };
  const appendAudit = (home: string, line: AuditLine) => {
    ensureDirs(home, ["slp-clients"]);
    const path = join(home, "slp-clients", AUDIT_FILE);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new OperationConflict("IO_FAILURE", "audit log is not a regular file", { path });
      if (stat.size > AUDIT_ROTATE_BYTES) renameSync(path, `${path}.1`);
    } catch (error) {
      if (error instanceof OperationConflict) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new OperationConflict("IO_FAILURE", `audit log unreadable: ${messageOf(error)}`, { path });
    }
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, `${JSON.stringify(line)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  };

  // ---- filesystem under <home>/slp-clients only -------------------------
  const ensureDirs = (home: string, parts: string[]) => {
    if (parts[0] !== "slp-clients") throw new OperationConflict("INVALID_REQUEST", "client files live only under slp-clients");
    let current = home;
    for (const part of parts) {
      current = join(current, part);
      let stat;
      try { stat = lstatSync(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new OperationConflict("IO_FAILURE", `cannot inspect ${part}: ${messageOf(error)}`);
        mkdirSync(current, { mode: 0o700 });
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new OperationConflict("IO_FAILURE", `${part} must be a real directory (no symbolic link)`, { path: current });
    }
  };
  /** Stage bytes in a sibling temp file; commit() renames it, abort() removes it. */
  const stage = (home: string, dirParts: string[], leaf: string, bytes: string) => {
    ensureDirs(home, dirParts);
    const dir = join(home, ...dirParts);
    const file = join(dir, leaf);
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new OperationConflict("IO_FAILURE", `${leaf} is not a regular file`, { path: file });
    } catch (error) {
      if (error instanceof OperationConflict) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temp = `${file}.${uuid()}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeSync(fd, bytes); fsyncSync(fd); } catch (error) { closeSync(fd); rmSync(temp, { force: true }); throw error; }
    closeSync(fd);
    return { commit: () => renameSync(temp, file), abort: () => rmSync(temp, { force: true }) };
  };
  const rawHashOf = (home: string, parts: string[], max: number): string | null => {
    let bytes: Buffer | null;
    try { bytes = readBelow(home, parts, max, "CLIENT_SOURCE_INVALID", parts.at(-1)!); }
    catch (error) { throw new OperationConflict("IO_FAILURE", messageOf(error), { path: join(home, ...parts) }); }
    return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
  };

  // ---- map + client files, read leniently for the screen ----------------
  const readMap = (home: string): { raw: { text: string; sha256: string } | null; map: ClientMap | null; error: string | null } => {
    let raw: { text: string; sha256: string } | null;
    try { raw = readClientMapRaw(home); }
    catch (error) { return { raw: null, map: null, error: messageOf(error) }; }
    if (raw === null) return { raw: null, map: null, error: null };
    try { return { raw, map: parseClientMap(raw.text), error: null }; }
    catch (error) { return { raw, map: null, error: messageOf(error) }; }
  };
  const peek = (home: string, directory: string, name: string): { sha256: string | null; text: string | null; error: string | null } => {
    try {
      const bytes = readBelow(home, ["slp-clients", "clients", directory, ".paseo-slp", name], CLIENT_FILE_MAX_BYTES, "CLIENT_SOURCE_INVALID", name);
      if (bytes === null) return { sha256: null, text: null, error: null };
      return { sha256: sha256Hex(textOf(bytes)), text: textOf(bytes), error: null };
    } catch (error) { return { sha256: null, text: null, error: messageOf(error) }; }
  };
  const clientFile = (directory: string, name: string) => `clients/${directory}/.paseo-slp/${name}`;
  const declared = (home: string, client: string) => {
    const { map, error } = readMap(home);
    if (map === null) throw invalid(error ?? "no client map exists; create the map first");
    if (!Object.hasOwn(map.clients, client)) throw invalid(`client ${client} is not declared in the client map`);
    return { map, directory: map.clients[client]!.directory };
  };

  // ---- reads ------------------------------------------------------------
  async function getClients(input: unknown): Promise<GetClientsResult> {
    const request = parseInput(GetClientsInput, "get-clients", input);
    const home = homeOf(request.target);
    const { raw, map, error } = readMap(home);
    const audit = readAudit(home);
    const mapExternal = raw !== null && lastWritten(audit, "clients.json") !== null && lastWritten(audit, "clients.json") !== raw.sha256;
    const rows = map === null ? [] : Object.keys(map.clients).sort().map(name => {
      const { directory } = map.clients[name]!;
      const pool = peek(home, directory, POOL), protocol = peek(home, directory, PROTOCOL);
      let options: number | null = null;
      let problem = pool.error ?? protocol.error;
      if (problem === null && pool.sha256 === null) problem = `client ${name} is missing ${POOL}; its repositories are blocked until it exists`;
      if (problem === null && protocol.sha256 === null) problem = `client ${name} is missing ${PROTOCOL}; its repositories are blocked until it exists`;
      if (pool.text !== null) {
        try { options = validateCatalog(JSON.parse(pool.text)).options.length; }
        catch (cause) { problem ??= `invalid Peer pool: ${messageOf(cause)}`; }
      }
      const changed = (file: string, sha: string | null) => { const last = lastWritten(audit, clientFile(directory, file)); return last !== null && sha !== last; };
      return { name, directory, referenced: map.repositories.some(entry => entry.client === name),
        repositories: map.repositories.filter(entry => entry.client === name).length,
        routingSha256: pool.sha256, protocolSha256: protocol.sha256, options, error: problem,
        externalChange: changed(POOL, pool.sha256) || changed(PROTOCOL, protocol.sha256) };
    });
    return { schemaVersion: 1, canonicalHome: home, mapState: raw === null ? "absent" : map === null ? "invalid" : "valid",
      mapSha256: raw?.sha256 ?? null, map: map === null ? null : (JSON.parse(serializeClientMap(map)) as NonNullable<GetClientsResult["map"]>), mapError: error, hostErrors: map === null ? [] : checkMapHost(map),
      mapExternalChange: mapExternal, clients: rows };
  }

  async function getClientFiles(input: unknown): Promise<GetClientFilesResult> {
    const request = parseInput(GetClientFilesInput, "get-client-files", input);
    const home = homeOf(request.target);
    const { directory } = declared(home, request.client);
    const pool = peek(home, directory, POOL), protocol = peek(home, directory, PROTOCOL);
    let parsedPool: ReturnType<typeof PeerPool.parse> | null = null;
    let poolError = pool.error;
    if (pool.text !== null && poolError === null) {
      try {
        const parsed = PeerPool.safeParse(JSON.parse(pool.text));
        if (parsed.success) parsedPool = parsed.data; else poolError = `peer pool failed schema validation: ${parsed.error.issues[0]?.message ?? "schema"}`;
      } catch (cause) { poolError = `peer pool is not valid JSON: ${messageOf(cause)}`; }
    }
    return { schemaVersion: 1, client: request.client, directory,
      pool: { pool: parsedPool, sha256: pool.sha256, error: poolError },
      protocol: { text: protocol.text, sha256: protocol.sha256, error: protocol.error } };
  }

  // The validation of a draft, used by the preview RPC and re-run by every
  // write. `bytes` is exactly what a save would write.
  type Evaluated = { errors: string[]; warnings: string[]; bytes: string | null; affectedClients: string[]; mapHashChanges: boolean };
  const evaluate = (home: string, draft: ValidateClientsDraftRequest["draft"]): Evaluated => {
    if (draft.kind === "map") {
      let map: ClientMap;
      try { map = parseClientMap(JSON.stringify(draft.map)); }
      catch (error) { return { errors: [messageOf(error)], warnings: [], bytes: null, affectedClients: [], mapHashChanges: false }; }
      const errors = checkMapHost(map);
      const warnings: string[] = [];
      const current = readMap(home);
      for (const [name, { directory }] of Object.entries(map.clients).sort(([a], [b]) => a.localeCompare(b))) {
        const present = [POOL, PROTOCOL].filter(file => peek(home, directory, file).sha256 !== null);
        const missing = [POOL, PROTOCOL].filter(file => !present.includes(file));
        // A folder left behind by a removed client is inherited by a new client that reuses it.
        if (present.length && current.map?.clients[name]?.directory !== directory) warnings.push(`client ${name}: folder ${directory} already contains ${present.join(" and ")}; the new client inherits them`);
        if (missing.length) warnings.push(`client ${name} has no ${missing.join(" and ")} yet: its repositories are blocked until they exist`);
      }
      const bytes = serializeClientMap(map);
      const affected = new Set<string>();
      if (current.map !== null) {
        for (const name of new Set([...Object.keys(current.map.clients), ...Object.keys(map.clients)])) {
          const mine = (m: ClientMap) => JSON.stringify([m.clients[name] ?? null, m.repositories.filter(e => e.client === name).map(e => [e.project, e.gitCommonDir, e.originSha256]).sort()]);
          if (mine(current.map) !== mine(map)) affected.add(name);
        }
        if (JSON.stringify(current.map.protectedRoots) !== JSON.stringify(map.protectedRoots)) for (const name of Object.keys(map.clients)) affected.add(name);
      } else for (const name of Object.keys(map.clients)) affected.add(name);
      return { errors, warnings, bytes, affectedClients: [...affected].sort(), mapHashChanges: current.raw === null || sha256Hex(bytes) !== current.raw.sha256 };
    }
    // pool / protocol: the client must already be declared in the saved map.
    try { declared(home, draft.client); }
    catch (error) { return { errors: [messageOf(error)], warnings: [], bytes: null, affectedClients: [], mapHashChanges: false }; }
    if (draft.kind === "pool") {
      const errors: string[] = [];
      const conflicts = draft.pool.version === 1 ? catalogTokenConflicts(draft.pool) : [];
      if (conflicts.length) errors.push(`peer pool has unresolved Token conflicts on standard seats: ${conflicts.map(c => c.id).join(", ")}`);
      const bytes = `${JSON.stringify(draft.pool, null, 2)}\n`;
      if (Buffer.byteLength(bytes) > CLIENT_FILE_MAX_BYTES) errors.push(`${POOL} exceeds ${CLIENT_FILE_MAX_BYTES} bytes`);
      try { validateCatalog(JSON.parse(bytes)); } catch (error) { errors.push(messageOf(error)); }
      return { errors, warnings: [], bytes: errors.length ? null : bytes, affectedClients: [draft.client], mapHashChanges: false };
    }
    const errors = Buffer.byteLength(draft.text) > CLIENT_FILE_MAX_BYTES ? [`${PROTOCOL} exceeds ${CLIENT_FILE_MAX_BYTES} bytes`] : [];
    return { errors, warnings: [], bytes: errors.length ? null : draft.text, affectedClients: [draft.client], mapHashChanges: false };
  };

  async function validateClientsDraft(input: unknown): Promise<ValidateClientsDraftResult> {
    const request = parseInput(ValidateClientsDraftInput, "validate-clients-draft", input);
    const result = evaluate(homeOf(request.target), request.draft);
    return { schemaVersion: 1, ok: result.errors.length === 0, errors: result.errors, warnings: result.warnings,
      confirm: result.bytes === null || result.errors.length > 0 ? null : sha256Hex(result.bytes), affectedClients: result.affectedClients, mapHashChanges: result.mapHashChanges };
  }

  async function identifyRepository(input: unknown): Promise<IdentifyRepositoryResult> {
    const request = parseInput(IdentifyRepositoryInput, "identify-repository", input);
    const home = homeOf(request.target);
    let identity;
    try { identity = identifyCheckout(request.path); }
    catch (error) { throw invalid(messageOf(error)); }
    const { map } = readMap(home);
    return { schemaVersion: 1, gitCommonDir: identity.gitCommonDir, originSha256: identity.originSha256,
      projectSuggestion: identity.projectSuggestion, linked: identity.linked,
      mappedClient: map === null ? null : entryForCommonDir(map, identity.gitCommonDir)?.client ?? null };
  }

  async function explainResolution(input: unknown): Promise<ExplainResolutionResult> {
    const request = parseInput(ExplainResolutionInput, "explain-resolution", input);
    const home = homeOf(request.target);
    let stat;
    try { stat = statSync(request.path); } catch { throw invalid("the path does not exist on this host"); }
    if (!stat.isDirectory()) throw invalid("the path is not a directory");
    const base = { schemaVersion: 1 as const, path: request.path };
    let trace;
    try { trace = traceSourceFor(request.path, home); }
    catch (error) {
      if (!(error instanceof ClientMapError)) throw error;
      return { ...base, decidedBy: "blocked", catalogScope: null, catalogPath: null, formation: "blocked", client: null, code: error.code, reason: error.message };
    }
    let catalogScope: string | null = null, catalogPath: string | null = null, tail = "";
    try { const catalog = readCatalog(request.path, home); catalogScope = catalog.scope; catalogPath = catalog.path; }
    catch (error) { tail = ` (reading the pool failed: ${messageOf(error)})`; }
    const formation = trace.decidedBy === "local" ? "local" : trace.decidedBy === "main" ? "main"
      : trace.decidedBy === "central" || trace.decidedBy === "client-directory" ? "central" : trace.linked === true ? "gap" : "user-pool";
    return { ...base, decidedBy: trace.decidedBy, catalogScope, catalogPath, formation, client: trace.client ?? null, code: null, reason: `${trace.reason}${tail}` };
  }

  // ---- writes -----------------------------------------------------------
  const requireConfirm = (confirm: string, bytes: string | null, errors: string[]) => {
    if (errors.length > 0 || bytes === null) throw invalid(`draft is invalid: ${errors[0] ?? "no bytes"}`);
    if (sha256Hex(bytes) !== confirm) throw invalid("confirmation does not match the validated draft — validate and review the draft again");
  };
  const casGate = (file: string, expected: string | null, actual: string | null) => {
    if (actual !== expected) throw new OperationConflict("IDEMPOTENCY_CONFLICT", "changed since it was read — reload before saving", { path: file, expectedSha256: expected, actualSha256: actual });
  };
  const commitWithAudit = (home: string, hostId: string, action: string, file: string, before: string | null, bytes: string, staged: ReturnType<typeof stage>) => {
    const line = (suffix = ""): AuditLine => ({ at: now().toISOString(), actor: "manager-rpc", hostId, action: `${action}${suffix}`, file, before, after: sha256Hex(bytes) });
    try { appendAudit(home, line()); } catch (error) { staged.abort(); throw error instanceof OperationConflict ? error : new OperationConflict("IO_FAILURE", `audit log not writable; nothing was saved: ${messageOf(error)}`); }
    try { staged.commit(); }
    catch (error) {
      staged.abort();
      try { appendAudit(home, { ...line(), action: "failed" }); } catch { /* best effort */ }
      throw new OperationConflict("IO_FAILURE", `write failed: ${messageOf(error)}`);
    }
  };

  async function setClients(input: unknown): Promise<SetClientsResult> {
    const request: SetClientsRequest = parseInput(SetClientsInput, "set-clients", input);
    const home = homeOf(request.target);
    const result = evaluate(home, { kind: "map", map: request.map });
    requireConfirm(request.confirm, result.bytes, result.errors);
    const current = readMap(home);
    casGate("clients.json", request.expectedSha256, current.raw?.sha256 ?? null);
    const bytes = result.bytes!;
    const staged = stage(home, ["slp-clients"], "clients.json", bytes);
    commitWithAudit(home, request.target.hostId, "set-clients", "clients.json", current.raw?.sha256 ?? null, bytes, staged);
    return { schemaVersion: 1, sha256: sha256Hex(bytes), map: JSON.parse(bytes) };
  }

  const writeClientFile = (request: SetClientPoolRequest | SetClientProtocolRequest, name: string, draft: Parameters<typeof evaluate>[1], _action: string) => {
    const home = homeOf(request.target);
    const { directory } = declared(home, request.client);
    const result = evaluate(home, draft);
    requireConfirm(request.confirm, result.bytes, result.errors);
    const parts = ["slp-clients", "clients", directory, ".paseo-slp"];
    const actual = rawHashOf(home, [...parts, name], CLIENT_FILE_MAX_BYTES);
    casGate(clientFile(directory, name), request.expectedSha256, actual);
    return { home, parts, bytes: result.bytes!, actual, directory };
  };

  async function setClientPool(input: unknown) {
    const request = parseInput(SetClientPoolInput, "set-client-pool", input);
    const recheck = request.pool.version === 2 ? await (deps.guardPresetWrite ?? guardPresetWrite)(resolveDaemonHome(request.target, "config.json must be a regular file, not a link").stableRoot) : () => {};
    const w = writeClientFile(request, POOL, { kind: "pool", client: request.client, pool: request.pool }, "set-client-pool");
    recheck();
    const staged = stage(w.home, w.parts, POOL, w.bytes);
    commitWithAudit(w.home, request.target.hostId, "set-client-pool", clientFile(w.directory, POOL), w.actual, w.bytes, staged);
    return { schemaVersion: 1 as const, sha256: sha256Hex(w.bytes) };
  }

  async function setClientProtocol(input: unknown) {
    const request = parseInput(SetClientProtocolInput, "set-client-protocol", input);
    const w = writeClientFile(request, PROTOCOL, { kind: "protocol", client: request.client, text: request.text }, "set-client-protocol");
    const staged = stage(w.home, w.parts, PROTOCOL, w.bytes);
    commitWithAudit(w.home, request.target.hostId, "set-client-protocol", clientFile(w.directory, PROTOCOL), w.actual, w.bytes, staged);
    return { schemaVersion: 1 as const, sha256: sha256Hex(w.bytes) };
  }

  return { getClients, getClientFiles, validateClientsDraft, identifyRepository, explainResolution, setClients, setClientPool, setClientProtocol };
}
