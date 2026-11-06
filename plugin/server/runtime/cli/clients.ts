// Central client map: <paseoHome>/slp-clients/clients.json maps a repository
// (Git common-dir + origin hash) to a client; each client owns a Peer pool and
// protocol under <paseoHome>/slp-clients/clients/<directory>/.paseo-slp/.
// The map lives outside every repository so a linked worktree whose checkout
// carries no configuration still resolves a trustworthy, per-client source.
//
// Fail-closed by construction: an absent map is the historical behavior; a
// present map that is invalid, ambiguous, drifted or points at a missing or
// non-regular client file BLOCKS — it never falls back to another client's
// pool or to the user-scope pool. Read-only; no secrets belong in these files.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const CLIENT_MAP_MAX_BYTES = 64 * 1024;
export const CLIENT_FILE_MAX_BYTES = 256 * 1024;
export const CLIENT_FILES = ['slp-routing.json', 'workspace-protocol.md'] as const;
export type ClientFileName = typeof CLIENT_FILES[number];
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ROOTS = 64, MAX_CLIENTS = 256, MAX_REPOSITORIES = 1024, MAX_PROJECT = 200, MAX_CONTAINERS = 256;

// Structured per-client rules (map version 2). Closed vocabulary on purpose: an
// enum or a bounded identity, never a free template, so the block delivered to
// an agent is deterministic, small and cannot carry another client's data.
export const TITLE_FORMATS = ['origin-id - pt-title'] as const;
export const AI_FOOTERS = ['forbid', 'allow'] as const;
export type TitleFormat = typeof TITLE_FORMATS[number];
export type AiFooter = typeof AI_FOOTERS[number];
export type CommitIdentity = { name: string; email: string };
export type ClientOrigin =
  | { kind: 'azure'; organization: string; project: string }
  | { kind: 'jira'; site: string }
  | { kind: 'gitlab'; group: string }
  | { kind: 'github'; owner: string };
/** Every key is optional; on a client `null` switches the global value off. */
export interface ClientRules {
  commitIdentity?: CommitIdentity | null;
  titleFormat?: TitleFormat | null;
  aiFooter?: AiFooter | null;
  origin?: ClientOrigin | null;
}
export const RULE_KEYS = ['commitIdentity', 'titleFormat', 'aiFooter', 'origin'] as const;

export type ClientMapErrorCode = 'CLIENT_MAP_INVALID' | 'CLIENT_UNMAPPED' | 'CLIENT_IDENTITY_DRIFT' | 'CLIENT_SOURCE_INVALID';
export class ClientMapError extends Error {
  readonly code: ClientMapErrorCode;
  constructor(code: ClientMapErrorCode, message: string) { super(message); this.name = 'ClientMapError'; this.code = code; }
}
const fail = (code: ClientMapErrorCode, message: string): never => { throw new ClientMapError(code, message); };

/** A project root folder that is NOT a Git repository (version 2 only). It binds the non-Git directories at or under it
 * to a client, anchored by path (file identity) only. It never covers a Git repository: those resolve by their own
 * identity (`repositories`). The deepest container wins. */
export interface ClientMapContainer { client: string; project: string; path: string }
/** `originSha256: null` (version 2 only) declares a local-only repository: it must have ZERO remotes. */
export interface ClientMapRepository { client: string; project: string; gitCommonDir: string; originSha256: string | null }
export interface ClientMap {
  version: 1 | 2;
  /** Version 1 has no field: it reads as `false`. Version 2 `true` blocks every project without an entry. */
  strict: boolean;
  protectedRoots: string[];
  /** Global rules (version 2). Never carries client data: no `origin`. */
  rules?: ClientRules;
  clients: Record<string, { directory: string; rules?: ClientRules }>;
  repositories: ClientMapRepository[];
  /** Version 2 only, optional (absent = none). Needs a runtime that declares `clientContainers`. */
  containers?: ClientMapContainer[];
}
export interface LoadedClientMap { map: ClientMap; sha256: string; path: string; home: string }
export interface ClientFile { text: string; sha256: string }
export interface CentralSource {
  client: string;
  directory: string;
  /** Absolute client directory; its `.paseo-slp/` holds the pool and protocol. */
  repository: string;
  mapSha256: string;
  files: Record<ClientFileName, ClientFile>;
}
export type ClientLookup =
  | { state: 'absent' }
  | { state: 'unmapped' }
  | { state: 'mapped'; client: string; loaded: LoadedClientMap; location: string; gitCommonDir: string | null; entry: ClientMapRepository | null; container: ClientMapContainer | null };
/** What the formation pin carries of a client binding (map version 2 only). */
export interface FormationBinding { client: string; mapSha256: string; rulesSha256: string | null }
/** The binding of one checkout: which client owns it and what rules apply. */
export interface BindingInfo {
  client: string; project: string; strict: boolean; version: 1 | 2; mapSha256: string; localOnly: boolean;
  /** Bound by a project root folder (no Git) instead of a repository entry. */
  container: boolean;
  rules: ClientRules;
  /** Rendered pt-BR block delivered to agents; null when no rule is in effect. */
  rulesText: string | null;
  /** sha256 of `rulesText` (this client only): editing another client never changes it. */
  rulesSha256: string | null;
}

const sha256Hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export const clientsRoot = (home: string) => join(home, 'slp-clients');
export const clientMapPath = (home: string) => join(home, 'slp-clients', 'clients.json');
export const clientDirectoryPath = (home: string, directory: string) => join(home, 'slp-clients', 'clients', directory);
export const defaultPaseoHome = () => process.env.PASEO_HOME || join(homedir(), '.paseo');

/** Read `parts` below `base`: every component is lstat-ed (no symlinks), the
 * leaf must be a regular file within `max` bytes and is opened O_NOFOLLOW.
 * ENOENT at any level reports `null` so callers choose absent-vs-blocked. */
export function readBelow(base: string, parts: string[], max: number, code: ClientMapErrorCode, label: string): Buffer | null {
  let current = base;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return fail(code, `${label} is not readable`);
    }
    if (stat.isSymbolicLink()) return fail(code, `${label} must not traverse a symbolic link`);
    const leaf = index === parts.length - 1;
    if (leaf ? !stat.isFile() : !stat.isDirectory()) return fail(code, `${label} must be a regular ${leaf ? 'file' : 'directory'}`);
  }
  let fd: number;
  try { fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return fail(code, `${label} is not readable as a regular file`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return fail(code, `${label} must be a regular file`);
    if (stat.size > max) return fail(code, `${label} exceeds ${max} bytes`);
    return readFileSync(fd);
  } catch (error) {
    if (error instanceof ClientMapError) throw error;
    return fail(code, `${label} is not readable`);
  } finally { closeSync(fd); }
}

function exactKeys(value: Record<string, unknown>, keys: string[], label: string, optional: string[] = []) {
  const own = Object.keys(value).sort();
  const want = [...keys].sort();
  const unknown = own.filter(key => !want.includes(key) && !optional.includes(key)), missing = want.filter(key => !own.includes(key));
  if (unknown.length || missing.length) {
    fail('CLIENT_MAP_INVALID', `${label} must have exactly ${want.join(', ')}${optional.length ? ` (optional: ${optional.join(', ')})` : ''}${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`);
  }
}
const cleanAbsolute = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) fail('CLIENT_MAP_INVALID', `${label} must be a normalized absolute path`);
  return value as string;
};

/** JSON.parse keeps the last of two equal keys silently; a map is a security
 * boundary, so a repeated key at ANY depth is a defect. Assumes syntactically
 * valid JSON (JSON.parse ran first). */
function assertUniqueKeys(text: string) {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++; };
  const str = (): string => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{') {
      i++; ws();
      const keys = new Set<string>();
      if (text[i] === '}') { i++; return; }
      for (;;) {
        ws();
        const key = str();
        if (keys.has(key)) fail('CLIENT_MAP_INVALID', `duplicate key ${JSON.stringify(key)} in client map`);
        keys.add(key);
        ws(); i++; value(); ws();
        if (text[i++] === '}') return;
      }
    } else if (c === '[') {
      i++; ws();
      if (text[i] === ']') { i++; return; }
      for (;;) { value(); ws(); if (text[i++] === ']') return; }
    } else if (c === '"') str();
    else while (i < text.length && !',]} \t\n\r'.includes(text[i]!)) i++;
  };
  value();
}

const PLAIN = /^[^\u0000-\u001f\u007f<>"'`]+$/;
const EMAIL = /^[^\s@<>"'`]{1,64}@[A-Za-z0-9.-]{1,63}\.[A-Za-z]{2,24}$/;
/** Text that names a place, never a secret or a URL with credentials. */
const plainText = (value: unknown, where: string, max: number, pattern: RegExp = PLAIN): string => {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1 || value.length > max || !pattern.test(value) || value.includes('://') || value.includes('@')) {
    fail('CLIENT_MAP_INVALID', `${where} must be a short plain text (1-${max} characters, no URL, no "@")`);
  }
  return value as string;
};

/** Canonical key order, so the same rules always serialize (and hash) alike. */
function parseRules(value: unknown, where: string, global: boolean): ClientRules {
  if (!isRecord(value)) return fail('CLIENT_MAP_INVALID', `${where} must be an object`);
  exactKeys(value, [], where, global ? RULE_KEYS.filter(key => key !== 'origin') : [...RULE_KEYS]);
  const rules: ClientRules = {};
  if (Object.hasOwn(value, 'commitIdentity')) {
    const identity = value.commitIdentity;
    if (identity === null) { if (global) fail('CLIENT_MAP_INVALID', `${where}.commitIdentity cannot be null on the global rules`); rules.commitIdentity = null; }
    else {
      if (!isRecord(identity)) return fail('CLIENT_MAP_INVALID', `${where}.commitIdentity must be an object`);
      exactKeys(identity, ['name', 'email'], `${where}.commitIdentity`);
      if (typeof identity.name !== 'string' || identity.name !== identity.name.trim() || identity.name.length < 1 || identity.name.length > 80 || !PLAIN.test(identity.name)) fail('CLIENT_MAP_INVALID', `${where}.commitIdentity.name must be a short plain text (1-80 characters)`);
      if (typeof identity.email !== 'string' || identity.email.length > 120 || !EMAIL.test(identity.email)) fail('CLIENT_MAP_INVALID', `${where}.commitIdentity.email must be an e-mail address of at most 120 characters`);
      rules.commitIdentity = { name: identity.name as string, email: identity.email as string };
    }
  }
  if (Object.hasOwn(value, 'titleFormat')) {
    if (value.titleFormat === null) { if (global) fail('CLIENT_MAP_INVALID', `${where}.titleFormat cannot be null on the global rules`); rules.titleFormat = null; }
    else if (!(TITLE_FORMATS as readonly unknown[]).includes(value.titleFormat)) fail('CLIENT_MAP_INVALID', `${where}.titleFormat must be one of ${TITLE_FORMATS.join(', ')}`);
    else rules.titleFormat = value.titleFormat as TitleFormat;
  }
  if (Object.hasOwn(value, 'aiFooter')) {
    if (value.aiFooter === null) { if (global) fail('CLIENT_MAP_INVALID', `${where}.aiFooter cannot be null on the global rules`); rules.aiFooter = null; }
    else if (!(AI_FOOTERS as readonly unknown[]).includes(value.aiFooter)) fail('CLIENT_MAP_INVALID', `${where}.aiFooter must be one of ${AI_FOOTERS.join(', ')}`);
    else rules.aiFooter = value.aiFooter as AiFooter;
  }
  if (Object.hasOwn(value, 'origin')) {
    const origin = value.origin;
    if (origin === null) rules.origin = null;
    else {
      if (!isRecord(origin)) return fail('CLIENT_MAP_INVALID', `${where}.origin must be an object`);
      const at = `${where}.origin`;
      switch (origin.kind) {
        case 'azure': exactKeys(origin, ['kind', 'organization', 'project'], at);
          rules.origin = { kind: 'azure', organization: plainText(origin.organization, `${at}.organization`, 80), project: plainText(origin.project, `${at}.project`, 80) }; break;
        case 'jira': exactKeys(origin, ['kind', 'site'], at);
          rules.origin = { kind: 'jira', site: plainText(origin.site, `${at}.site`, 80, /^[A-Za-z0-9][A-Za-z0-9.-]*$/) }; break;
        case 'gitlab': exactKeys(origin, ['kind', 'group'], at);
          rules.origin = { kind: 'gitlab', group: plainText(origin.group, `${at}.group`, 80, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/) }; break;
        case 'github': exactKeys(origin, ['kind', 'owner'], at);
          rules.origin = { kind: 'github', owner: plainText(origin.owner, `${at}.owner`, 80, /^[A-Za-z0-9][A-Za-z0-9-]*$/) }; break;
        default: return fail('CLIENT_MAP_INVALID', `${at}.kind must be azure, jira, gitlab or github`);
      }
    }
  }
  return rules;
}

/** Strict schema: version 1, exact keys, bounded, no duplicates. Throws
 * CLIENT_MAP_INVALID naming the first violated rule. */
export function parseClientMap(text: string): ClientMap {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('CLIENT_MAP_INVALID', 'client map is not valid JSON'); }
  assertUniqueKeys(text);
  if (!isRecord(parsed)) return fail('CLIENT_MAP_INVALID', 'client map must be a JSON object');
  const version = parsed.version;
  if (version !== 1 && version !== 2) fail('CLIENT_MAP_INVALID', 'client map version must be 1 or 2');
  const v2 = version === 2;
  if (v2) exactKeys(parsed, ['version', 'strict', 'protectedRoots', 'clients', 'repositories'], 'client map', ['rules', 'containers']);
  else exactKeys(parsed, ['version', 'protectedRoots', 'clients', 'repositories'], 'client map');
  if (v2 && typeof parsed.strict !== 'boolean') fail('CLIENT_MAP_INVALID', 'client map strict must be true or false');
  if (!Array.isArray(parsed.protectedRoots) || parsed.protectedRoots.length > MAX_ROOTS) fail('CLIENT_MAP_INVALID', `protectedRoots must be an array of at most ${MAX_ROOTS} paths`);
  const protectedRoots = (parsed.protectedRoots as unknown[]).map((root, i) => cleanAbsolute(root, `protectedRoots[${i}]`));
  if (!isRecord(parsed.clients) || Object.keys(parsed.clients).length > MAX_CLIENTS) fail('CLIENT_MAP_INVALID', 'clients must be an object');
  const clients: Record<string, { directory: string; rules?: ClientRules }> = Object.create(null);
  const directories = new Set<string>();
  for (const [name, entry] of Object.entries(parsed.clients as Record<string, unknown>)) {
    if (!NAME.test(name)) fail('CLIENT_MAP_INVALID', `client name ${JSON.stringify(name)} is invalid`);
    if (!isRecord(entry)) return fail('CLIENT_MAP_INVALID', `client ${name} must be an object`);
    exactKeys(entry, ['directory'], `client ${name}`, v2 ? ['rules'] : []);
    const directory = entry.directory;
    if (typeof directory !== 'string' || !NAME.test(directory) || directory.includes('..')) fail('CLIENT_MAP_INVALID', `client ${name}: directory must be a single safe path component`);
    if (directories.has(directory as string)) fail('CLIENT_MAP_INVALID', `client ${name}: directory ${directory} is shared with another client`);
    directories.add(directory as string);
    clients[name] = { directory: directory as string, ...(Object.hasOwn(entry, 'rules') ? { rules: parseRules(entry.rules, `client ${name} rules`, false) } : {}) };
  }
  if (!Array.isArray(parsed.repositories) || parsed.repositories.length > MAX_REPOSITORIES) fail('CLIENT_MAP_INVALID', `repositories must be an array of at most ${MAX_REPOSITORIES} entries`);
  const seen = new Set<string>();
  const repositories: ClientMapRepository[] = (parsed.repositories as unknown[]).map((entry, i) => {
    if (!isRecord(entry)) return fail('CLIENT_MAP_INVALID', `repositories[${i}] must be an object`);
    exactKeys(entry, ['client', 'project', 'gitCommonDir', 'originSha256'], `repositories[${i}]`);
    if (typeof entry.client !== 'string' || !Object.hasOwn(clients, entry.client)) fail('CLIENT_MAP_INVALID', `repositories[${i}]: client is not declared in clients`);
    if (typeof entry.project !== 'string' || !entry.project.trim() || entry.project.length > MAX_PROJECT || /[\u0000-\u001f]/.test(entry.project)) fail('CLIENT_MAP_INVALID', `repositories[${i}]: project must be a short text`);
    const gitCommonDir = cleanAbsolute(entry.gitCommonDir, `repositories[${i}].gitCommonDir`);
    const origin = entry.originSha256;
    if (v2 && origin === null) { /* explicit local-only */ }
    else if (typeof origin !== 'string' || !SHA256.test(origin)) fail('CLIENT_MAP_INVALID', `repositories[${i}]: originSha256 must be 64 lowercase hex characters${v2 ? ' or null (local-only)' : ''}`);
    if (seen.has(gitCommonDir)) fail('CLIENT_MAP_INVALID', `gitCommonDir appears in more than one repository entry (${gitCommonDir})`);
    seen.add(gitCommonDir);
    return { client: entry.client as string, project: entry.project as string, gitCommonDir, originSha256: origin as string | null };
  });
  if (!v2) return { version: 1, strict: false, protectedRoots, clients, repositories };
  let containers: ClientMapContainer[] | undefined;
  if (Object.hasOwn(parsed, 'containers')) {
    if (!Array.isArray(parsed.containers) || parsed.containers.length > MAX_CONTAINERS) fail('CLIENT_MAP_INVALID', `containers must be an array of at most ${MAX_CONTAINERS} entries`);
    const paths = new Set<string>();
    containers = (parsed.containers as unknown[]).map((entry, i) => {
      if (!isRecord(entry)) return fail('CLIENT_MAP_INVALID', `containers[${i}] must be an object`);
      exactKeys(entry, ['client', 'project', 'path'], `containers[${i}]`);
      if (typeof entry.client !== 'string' || !Object.hasOwn(clients, entry.client)) fail('CLIENT_MAP_INVALID', `containers[${i}]: client is not declared in clients`);
      if (typeof entry.project !== 'string' || !entry.project.trim() || entry.project.length > MAX_PROJECT || /[\u0000-\u001f]/.test(entry.project)) fail('CLIENT_MAP_INVALID', `containers[${i}]: project must be a short text`);
      const path = cleanAbsolute(entry.path, `containers[${i}].path`);
      if (paths.has(path)) fail('CLIENT_MAP_INVALID', `path appears in more than one container entry (${path})`);
      paths.add(path);
      return { client: entry.client as string, project: entry.project as string, path };
    });
  }
  return { version: 2, strict: parsed.strict as boolean, protectedRoots, ...(Object.hasOwn(parsed, 'rules') ? { rules: parseRules(parsed.rules, 'global rules', true) } : {}), clients, repositories, ...(containers !== undefined ? { containers } : {}) };
}

/** Absent map → null (historical behavior). Present but unreadable, symlinked,
 * oversized or invalid → CLIENT_MAP_INVALID. */
export function loadClientMap(home: string): LoadedClientMap | null {
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('Absolute Paseo home required');
  const bytes = readBelow(home, ['slp-clients', 'clients.json'], CLIENT_MAP_MAX_BYTES, 'CLIENT_MAP_INVALID', 'client map');
  if (bytes === null) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('CLIENT_MAP_INVALID', 'client map is not valid UTF-8'); }
  return { map: parseClientMap(text), sha256: sha256Hex(bytes), path: clientMapPath(home), home };
}

/** Raw map bytes for CAS: unlike loadClientMap this never parses, so an invalid
 * map still has a hash the Human can overwrite under CAS. Absent → null. */
export function readClientMapRaw(home: string): { text: string; sha256: string } | null {
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error('Absolute Paseo home required');
  const bytes = readBelow(home, ['slp-clients', 'clients.json'], CLIENT_MAP_MAX_BYTES, 'CLIENT_MAP_INVALID', 'client map');
  if (bytes === null) return null;
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('CLIENT_MAP_INVALID', 'client map is not valid UTF-8'); }
  return { text, sha256: sha256Hex(bytes) };
}
/** The one serialization the screen shows, hashes (confirm) and writes. */
export const serializeClientMap = (map: ClientMap): string => {
  const body = map.version === 1
    ? { version: map.version, protectedRoots: map.protectedRoots, clients: map.clients, repositories: map.repositories }
    : { version: map.version, strict: map.strict, protectedRoots: map.protectedRoots, ...(map.rules !== undefined ? { rules: map.rules } : {}), clients: map.clients, repositories: map.repositories, ...(map.containers !== undefined ? { containers: map.containers } : {}) };
  return `${JSON.stringify(body, null, 2)}\n`;
};
export const sha256OfText = (text: string) => sha256Hex(text);

/** The client's two files, read without traversing symlinks. A missing file is
 * a block, never a fallback to another source. */
export function readClientSource(loaded: LoadedClientMap, client: string): CentralSource {
  if (!Object.hasOwn(loaded.map.clients, client)) return fail('CLIENT_SOURCE_INVALID', `client ${client} is not declared in the client map`);
  const { directory } = loaded.map.clients[client]!;
  const files = {} as Record<ClientFileName, ClientFile>;
  for (const name of CLIENT_FILES) {
    const bytes = readBelow(loaded.home, ['slp-clients', 'clients', directory, '.paseo-slp', name], CLIENT_FILE_MAX_BYTES, 'CLIENT_SOURCE_INVALID', `client ${client} ${name}`);
    if (bytes === null) return fail('CLIENT_SOURCE_INVALID', `client ${client} is missing ${name}; there is no fallback to another pool`);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('CLIENT_SOURCE_INVALID', `client ${client} ${name} is not valid UTF-8`); }
    files[name] = { text, sha256: sha256Hex(bytes) };
  }
  return { client, directory, repository: clientDirectoryPath(loaded.home, directory), mapSha256: loaded.sha256, files };
}

// Spelling-independent identity: two paths name the same directory when they
// share dev+inode, whatever the case (case-insensitive volumes) or symlink route.
const inodeKey = (path: string): string | null => {
  try { const stat = statSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}`; } catch { return null; }
};
const sameFile = (a: string, b: string) => { const x = inodeKey(a); return x !== null && x === inodeKey(b); };
const nativeReal = (path: string) => realpathSync.native(path);
const canonical = (path: string) => { try { return nativeReal(path); } catch { return path; } };
/** True when `path` (or any ancestor) is one of the roots, compared by file
 * identity. Roots that do not exist on this host cannot contain anything. */
function underProtectedRoot(roots: string[], ...paths: string[]) {
  const keys = new Set(roots.map(inodeKey).filter((key): key is string => key !== null));
  if (keys.size === 0) return false;
  for (const start of paths) {
    for (let current = start; ; current = dirname(current)) {
      const key = inodeKey(current);
      if (key !== null && keys.has(key)) return true;
      if (dirname(current) === current) break;
    }
  }
  return false;
}

// ---- containers: project root folders without Git -------------------------
const SYSTEM_ROOTS = ['/', '/Users', '/home', '/Volumes', '/tmp', '/private', '/etc', '/usr', '/var', '/bin', '/sbin', '/opt', '/System', '/Library', '/Applications', '/root', '/mnt', '/media', '/srv'];
const ancestorsOf = (start: string): string[] => { const out: string[] = []; for (let current = start; ; current = dirname(current)) { out.push(current); if (dirname(current) === current) break; } return out; };
/** A directory that is the root of another file system (st_dev differs from its parent's): a whole disk or share
 * (macOS `/Volumes/<disk>`, WSL `/mnt/<drive>`), never one project. `stat` is injectable for the unit test. */
export function isMountPoint(path: string, stat: (p: string) => { dev: number | bigint } = p => statSync(p)): boolean {
  try { return stat(path).dev !== stat(dirname(path)).dev; } catch { return false; }
}
/** Why a container may never be bound, or null. Blocking everywhere (draft review, `clients validate`, and the lookup
 * itself): the user's home, `/`, a system root, any folder that contains the home, or any ancestor of a protected
 * root would cover far more than one project. Compared by file identity. */
export function containerViolation(path: string, map: Pick<ClientMap, 'protectedRoots'>): string | null {
  const key = inodeKey(path);
  if (key === null) return null; // a missing path is reported by the host check
  const forbidden = new Set<string>();
  for (const root of SYSTEM_ROOTS) { const k = inodeKey(root); if (k !== null) forbidden.add(k); }
  for (const ancestor of ancestorsOf(homedir())) { const k = inodeKey(ancestor); if (k !== null) forbidden.add(k); } // the home and everything above it
  if (forbidden.has(key)) return `container ${path} is the user home, a system root or a folder that contains the home: it would cover everything, so it can never be bound`;
  if (isMountPoint(path)) return `container ${path} is the root of a file system (a whole disk or share): it would cover far more than one project, so it can never be bound`;
  for (const root of map.protectedRoots) {
    if (ancestorsOf(root).some(ancestor => inodeKey(ancestor) === key)) return `container ${path} is, or contains, the protected folder ${root}: it would cover every project under it`;
  }
  return null;
}
/** The container (if any) that binds the non-Git directory `location`: the deepest ancestor-or-self that is a mapped
 * container, by file identity. Two containers naming one directory, or a container the guards forbid, make the map
 * invalid. Never consulted for a Git checkout: a container does not cover a repository. */
export function findContainer(map: ClientMap, location: string): ClientMapContainer | null {
  const containers = map.containers ?? [];
  if (containers.length === 0) return null;
  const byKey = new Map<string, ClientMapContainer>();
  for (const container of containers) {
    const violation = containerViolation(container.path, map);
    if (violation !== null) return fail('CLIENT_MAP_INVALID', violation);
    const key = inodeKey(container.path);
    if (key === null) continue;
    if (byKey.has(key)) return fail('CLIENT_MAP_INVALID', `more than one container entry names the same directory (${container.path})`);
    byKey.set(key, container);
  }
  for (const ancestor of ancestorsOf(location)) {
    const key = inodeKey(ancestor);
    if (key === null || !byKey.has(key)) continue;
    // Git said "not a repository", but a `.git` entry (file or directory) between the directory and the container root means a
    // repository whose Git is broken (HEAD missing, a worktree whose main checkout moved, an unreadable .git): it is NOT a plain
    // folder, so it must not silently take the container's client (or any user pool).
    for (const step of ancestorsOf(location)) {
      if (hasGitEntry(step)) return fail('CLIENT_UNMAPPED', `degraded Git repository inside a client folder (${join(step, '.git')} exists but Git does not recognize a repository): it does not inherit the folder's client; repair or remove it; no user-pool fallback`);
      if (sameFile(step, ancestor)) break;
    }
    return byKey.get(key)!;
  }
  return null;
}
/** Does `.git` exist in `dir` (file or directory, readable or not)? Only a missing entry counts as absent. */
function hasGitEntry(dir: string): boolean {
  try { lstatSync(join(dir, '.git')); return true; }
  catch (error) { return !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''); }
}
/** True when a valid map carries at least one container (older runtimes cannot read it). */
export function mapHasContainers(home: string): boolean {
  try { return (loadClientMap(home)?.map.containers?.length ?? 0) > 0; } catch (error) { if (error instanceof ClientMapError) return false; throw error; }
}

// Git runs with a fixed C locale so "not a git repository" is recognizable.
const gitRun = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2500, maxBuffer: 4096,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), LC_ALL: 'C', LANG: 'C' },
}).trim();
export const originSha256Of = (cwd: string) => sha256Hex(gitRun(cwd, 'remote', 'get-url', 'origin'));
/** Names of every configured remote (empty = a local-only repository). */
export const remotesOf = (cwd: string): string[] => gitRun(cwd, 'remote').split('\n').map(line => line.trim()).filter(Boolean);

type GitView = { state: 'git'; location: string; top: string | null; gitCommonDir: string } | { state: 'not-git'; location: string };
/** Identity criterion (map present): a directory is "not Git" only when Git ran
 * and said so ("not a git repository", exit 128). Anything else — Git missing
 * from PATH, timeout, safe.directory/ownership refusal, any other failure —
 * leaves the identity unobservable and BLOCKS; it is never read as "unmapped". */
function observeGit(cwd: string): GitView {
  let location: string;
  try { location = nativeReal(cwd); } catch { return fail('CLIENT_UNMAPPED', 'checkout directory cannot be resolved while a client map is present'); }
  try {
    const [top, common] = gitRun(location, 'rev-parse', '--show-toplevel', '--git-common-dir').split('\n');
    if (!top || !common) throw new Error('unexpected rev-parse output');
    return { state: 'git', location, top: nativeReal(resolve(location, top)), gitCommonDir: nativeReal(resolve(location, common)) };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number; stderr?: string };
    if (failure.status === 128 && /not a git repository/i.test(String(failure.stderr ?? ''))) return { state: 'not-git', location };
    return fail('CLIENT_UNMAPPED', `Git identity of the checkout cannot be observed (${failure.code ?? (failure.status !== undefined && failure.status !== null ? `git exit ${failure.status}` : 'git failed')}) while a client map is present; no user-pool fallback`);
  }
}

type Probes = { origin: (cwd: string) => string; remotes: (cwd: string) => string[] };
function lookupIn(loaded: LoadedClientMap, view: GitView, probes: Probes): ClientLookup {
  const strict = loaded.map.strict;
  if (view.state === 'not-git') {
    const container = findContainer(loaded.map, view.location);
    if (container !== null) return { state: 'mapped', client: container.client, loaded, location: view.location, gitCommonDir: null, entry: null, container };
    if (underProtectedRoot(loaded.map.protectedRoots, view.location)) fail('CLIENT_UNMAPPED', 'protected directory is not a Git checkout; no user-pool fallback');
    if (strict) fail('CLIENT_UNMAPPED', 'strict client map: the directory is not a Git checkout, so it cannot be bound to a client; no user-pool fallback');
    return { state: 'unmapped' };
  }
  const key = inodeKey(view.gitCommonDir);
  if (key === null) return fail('CLIENT_UNMAPPED', 'Git common-dir cannot be inspected while a client map is present');
  const hits = loaded.map.repositories.filter(item => inodeKey(item.gitCommonDir) === key);
  if (hits.length > 1) fail('CLIENT_MAP_INVALID', 'more than one repository entry names the same Git common-dir');
  const entry = hits[0];
  if (entry === undefined) {
    if (underProtectedRoot(loaded.map.protectedRoots, view.location, view.gitCommonDir)) fail('CLIENT_UNMAPPED', 'protected repository has no client mapping; no user-pool fallback');
    // One rule for every consumer (placement, readCatalog, routes, prepare, task
    // deliver, the screen): a strict map leaves no project without a client.
    if (strict) fail('CLIENT_UNMAPPED', 'strict client map: this project has no client; map it on the Clients screen; no user-pool fallback');
    return { state: 'unmapped' };
  }
  if (entry.originSha256 === null) {
    let remotes: string[];
    try { remotes = probes.remotes(view.location); } catch { return fail('CLIENT_IDENTITY_DRIFT', 'remote identity drift: remotes cannot be verified for a repository declared local-only'); }
    if (remotes.length > 0) fail('CLIENT_IDENTITY_DRIFT', 'remote identity drift: a repository declared local-only now has a remote');
  } else {
    let actual: string;
    try { actual = probes.origin(view.location); } catch { return fail('CLIENT_IDENTITY_DRIFT', 'remote identity drift: origin cannot be verified'); }
    if (actual !== entry.originSha256) fail('CLIENT_IDENTITY_DRIFT', 'remote identity drift: origin differs from the client map entry');
  }
  return { state: 'mapped', client: entry.client, loaded, location: view.location, gitCommonDir: view.gitCommonDir, entry, container: null };
}

type LookupRequest = { home: string; cwd: string; gitCommonDir?: string; origin?: (cwd: string) => string; remotes?: (cwd: string) => string[] };
function lookupLoaded(loaded: LoadedClientMap, request: LookupRequest): ClientLookup {
  const view: GitView = request.gitCommonDir === undefined ? observeGit(request.cwd)
    : (() => { try { return { state: 'git' as const, location: nativeReal(request.cwd), top: null, gitCommonDir: nativeReal(request.gitCommonDir!) }; }
      catch { return fail('CLIENT_UNMAPPED', 'checkout directory cannot be resolved while a client map is present'); } })();
  return lookupIn(loaded, view, { origin: request.origin ?? originSha256Of, remotes: request.remotes ?? remotesOf });
}
/** Resolve which client (if any) owns the checkout at `cwd`. `gitCommonDir` may
 * be supplied by a caller that already observed it (placement); identity is
 * compared by file identity, never by spelling. */
export function lookupClient(request: LookupRequest): ClientLookup {
  const loaded = loadClientMap(request.home);
  if (loaded === null) return { state: 'absent' };
  return lookupLoaded(loaded, request);
}

// ---- rules: effective set, deterministic pt-BR rendering, binding ----------
/** global ← client, per key: the client wins and `null` switches the key off. */
export function effectiveRules(map: ClientMap, client: string): ClientRules {
  const own = Object.hasOwn(map.clients, client) ? map.clients[client]!.rules : undefined;
  const out: Record<string, unknown> = {};
  for (const key of RULE_KEYS) {
    const mine = own?.[key];
    const value = mine !== undefined ? mine : map.rules?.[key];
    if (value !== undefined && value !== null) out[key] = value;
  }
  return out as ClientRules;
}
const ORIGIN_LABEL = (origin: ClientOrigin) => origin.kind === 'azure' ? `Azure DevOps, organização ${origin.organization}, projeto ${origin.project}`
  : origin.kind === 'jira' ? `Jira, site ${origin.site}` : origin.kind === 'gitlab' ? `GitLab, grupo ${origin.group}` : `GitHub, dono ${origin.owner}`;
/** The block an agent receives, rendered at read time (never stored in a
 * workspace-protocol): same rules in, same bytes out. Null when no key applies. */
export function renderClientRules(client: string, rules: ClientRules): string | null {
  const lines: string[] = [];
  if (rules.commitIdentity) lines.push(`- Identidade de commit: "${rules.commitIdentity.name}" <${rules.commitIdentity.email}>. Cada repositório do cliente deve usar user.name/user.email assim; a conferência (\`slp.mjs clients check\`) só lê, nunca grava o git config.`);
  if (rules.titleFormat === 'origin-id - pt-title') lines.push('- Título de tarefa, PR e commit de tarefa: "<ID da origem> - <título em português>".');
  if (rules.aiFooter === 'forbid') lines.push('- Rodapé de IA proibido: nenhum "Co-Authored-By" de IA nem "Generated with" em commit, PR ou comentário.');
  else if (rules.aiFooter === 'allow') lines.push('- Rodapé de IA permitido em commit e PR deste cliente.');
  if (rules.origin) lines.push(`- Origem das tarefas (informativo): ${ORIGIN_LABEL(rules.origin)}.`);
  if (lines.length === 0) return null;
  return [`\n## Regras do cliente ${client} (SLP)`, 'Vínculo verificado pelo Git; vale somente para este cliente e nunca substitui o protocolo do repositório nem autoriza ação externa.', ...lines].join('\n') + '\n';
}
/** Binding facts of a client in a loaded map (pure: no Git). */
function bindingOfClient(loaded: LoadedClientMap, client: string, project: string, localOnly: boolean, container = false): BindingInfo {
  const { map, sha256 } = loaded;
  const rules = map.version === 2 ? effectiveRules(map, client) : {};
  const rulesText = renderClientRules(client, rules);
  return { client, project, strict: map.strict, version: map.version, mapSha256: sha256, localOnly, container,
    rules, rulesText, rulesSha256: rulesText === null ? null : sha256Hex(rulesText) };
}
export const bindingInfo = (found: Extract<ClientLookup, { state: 'mapped' }>): BindingInfo =>
  found.container !== null ? bindingOfClient(found.loaded, found.client, found.container.project, false, true)
    : bindingOfClient(found.loaded, found.client, found.entry!.project, found.entry!.originSha256 === null);
/** What the formation pin records: version 2 maps only, so a version 1 map keeps every pin byte it has today. */
export const formationBindingOf = (info: BindingInfo | null | undefined): FormationBinding | undefined =>
  info && info.version === 2 ? { client: info.client, mapSha256: info.mapSha256, rulesSha256: info.rulesSha256 } : undefined;

export type Binding = { state: 'absent' } | { state: 'unmapped' } | { state: 'mapped'; info: BindingInfo; location: string; gitCommonDir: string | null };
/** Diagnostic binding of a checkout (the one rule `lookupIn` applies: strict ⇒
 * CLIENT_UNMAPPED). Throws ClientMapError like every consumer. */
export function bindingFor(repository: string, home: string, probes: { origin?: (cwd: string) => string; remotes?: (cwd: string) => string[] } = {}): Binding {
  const found = lookupClient({ home, cwd: repository, ...probes });
  return found.state === 'mapped' ? { state: 'mapped', info: bindingInfo(found), location: found.location, gitCommonDir: found.gitCommonDir } : { state: found.state };
}
/** Binding as the agent.create hook and the checkout-config rungs use it: a
 * version 1 map, an absent or invalid map, and any non-strict problem keep
 * today's behavior (no binding, never a block); only a valid STRICT map blocks
 * (unmapped, drift, unobservable Git). */
export function ladderBinding(request: LookupRequest): BindingInfo | null {
  let loaded: LoadedClientMap | null;
  try { loaded = loadClientMap(request.home); } catch (error) { if (error instanceof ClientMapError) return null; throw error; }
  if (loaded === null || loaded.map.version === 1) return null;
  try {
    const found = lookupLoaded(loaded, request);
    return found.state === 'mapped' ? bindingInfo(found) : null;
  } catch (error) {
    if (error instanceof ClientMapError && !loaded.map.strict) return null;
    throw error;
  }
}

/** What the create hook needs to know before touching Git: null for an absent,
 * invalid or version 1 map (today's behavior); otherwise whether the valid
 * version 2 map is strict and whether ANY rule exists anywhere in it. */
export function clientMapPosture(home: string): { strict: boolean; hasRules: boolean } | null {
  let loaded: LoadedClientMap | null;
  try { loaded = loadClientMap(home); } catch (error) { if (error instanceof ClientMapError) return null; throw error; }
  if (loaded === null || loaded.map.version === 1) return null;
  const { map } = loaded;
  const any = (rules?: ClientRules) => rules !== undefined && Object.keys(rules).length > 0;
  return { strict: map.strict, hasRules: any(map.rules) || Object.values(map.clients).some(client => any(client.rules)) };
}

// ---- Git identity (read-only) ---------------------------------------------
export type GitIdentity = { name: string | null; email: string | null };
export type IdentityState = 'ok' | 'differs' | 'unconfigured' | 'unknown';
export interface IdentityCheck { state: IdentityState; expected: CommitIdentity; effective: GitIdentity; local: GitIdentity }
/** `git config --get`: exit 1 means "not set"; any other failure is unobservable (null result of the call). */
function configValue(cwd: string, local: boolean, key: string): string | null | undefined {
  try { return gitRun(cwd, 'config', ...(local ? ['--local'] : []), '--get', key) || null; }
  catch (error) { return (error as { status?: number }).status === 1 ? null : undefined; }
}
/** Compares the EFFECTIVE identity of the checkout (includeIf and global config
 * honored) with the client's rule and also reports the repository-local one.
 * Only `git config --get` runs: nothing here ever writes a Git config. */
export function checkCommitIdentity(cwd: string, expected: CommitIdentity): IdentityCheck {
  const read = (local: boolean): GitIdentity | undefined => {
    const name = configValue(cwd, local, 'user.name'), email = configValue(cwd, local, 'user.email');
    return name === undefined || email === undefined ? undefined : { name, email };
  };
  const effective = read(false), local = read(true);
  if (effective === undefined || local === undefined) return { state: 'unknown', expected, effective: effective ?? { name: null, email: null }, local: local ?? { name: null, email: null } };
  const state: IdentityState = effective.name === null && effective.email === null ? 'unconfigured'
    : effective.name === expected.name && effective.email === expected.email ? 'ok' : 'differs';
  return { state, expected, effective, local };
}
/** One line per problem, the text prepared.warnings carries; empty when fine or not required. */
export const identityWarnings = (client: string, check: IdentityCheck | null): string[] => check === null || check.state === 'ok' ? []
  : [`client ${client}: git identity ${check.state} (rule expects "${check.expected.name}" <${check.expected.email}>; effective ${check.effective.name ?? 'unset'} <${check.effective.email ?? 'unset'}>; read-only check, nothing was changed)`];
/** Identity check of the checkout at `cwd` against the rule of ITS OWN client (never another's). */
export function identityFor(cwd: string, info: BindingInfo | null): IdentityCheck | null {
  const expected = info?.rules.commitIdentity;
  if (!info || !expected) return null;
  return checkCommitIdentity(cwd, expected);
}

/** A human-readable project name derived ONLY from the repository path of a
 * remote. Never carries userinfo, host, port, query or fragment: everything up
 * to the last "@" is dropped first (a password may hold an unencoded "/"),
 * then any "?query"/"#fragment", then the scheme/host (or scp-like "host:"). */
export function projectFromRemote(remote: string): string {
  let rest = remote.trim();
  const at = rest.lastIndexOf('@');
  if (at >= 0) rest = rest.slice(at + 1);
  rest = rest.replace(/[?#].*$/s, '');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(rest);
  let path: string;
  if (scheme) {
    const after = scheme[2]!;
    const isFile = scheme[1]!.toLowerCase() === 'file';
    path = isFile ? after : after.includes('/') ? after.slice(after.indexOf('/') + 1) : '';
  } else if (/^[^/:]+:[^/]/.test(rest)) path = rest.slice(rest.indexOf(':') + 1); // scp-like host:group/repo
  else path = rest; // local path
  const parts = path.replace(/\.git$/, '').split('/').filter(part => part && part !== '.' && part !== '..');
  const local = !scheme || scheme[1]!.toLowerCase() === 'file' ? parts.slice(-2) : parts;
  return local.join('/').replace(/[^A-Za-z0-9._/-]/g, '').slice(0, 200);
}

/** Server-side identity of a checkout for the screen's "add repository": the
 * canonical common-dir and the origin hash are computed here, never typed.
 * The remote URL itself is not returned — only a credential-free project
 * suggestion derived from its path. A checkout with ZERO remotes is local-only
 * (`originSha256: null`); remotes without `origin` have no identity to map.
 * Throws ClientMapError (not Git / remotes without origin). */
export function identifyCheckout(cwd: string): { gitCommonDir: string; originSha256: string | null; localOnly: boolean; projectSuggestion: string; linked: boolean; location: string } {
  const view = observeGit(cwd);
  if (view.state !== 'git') return fail('CLIENT_UNMAPPED', 'the path is not a Git checkout');
  const top = view.top ?? view.location;
  const linked = view.top !== null && !sameFile(dirname(view.gitCommonDir), view.top);
  let remotes: string[];
  try { remotes = remotesOf(view.location); } catch { return fail('CLIENT_IDENTITY_DRIFT', 'the remotes of the checkout cannot be read'); }
  if (remotes.length === 0) return { gitCommonDir: view.gitCommonDir, originSha256: null, localOnly: true, projectSuggestion: top.split('/').pop() ?? 'repository', linked, location: view.location };
  let url: string;
  try { url = gitRun(view.location, 'remote', 'get-url', 'origin'); } catch { return fail('CLIENT_IDENTITY_DRIFT', 'the checkout has remotes but no readable "origin"; the map identifies a repository by its origin hash (or by having no remote at all)'); }
  const project = projectFromRemote(url);
  return { gitCommonDir: view.gitCommonDir, originSha256: sha256Hex(url), localOnly: false, projectSuggestion: project || (top.split('/').pop() ?? 'repository'), linked, location: view.location };
}
/** The map entry (if any) that names this common-dir, compared by file identity. */
export const entryForCommonDir = (map: ClientMap, gitCommonDir: string): ClientMapRepository | undefined => {
  const key = inodeKey(gitCommonDir);
  return key === null ? undefined : map.repositories.find(item => inodeKey(item.gitCommonDir) === key);
};

const present = (path: string) => {
  try { lstatSync(path); return true; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; }
};
const hasConfiguration = (repository: string) => CLIENT_FILES.some(name => present(join(repository, '.paseo-slp', name)));

export type SourceResolution = { kind: 'central'; source: CentralSource } | null;
export type SourceTrace = {
  resolution: SourceResolution;
  /** Which rung decided: the client directory itself, the checkout's own configuration, the main checkout's
   * (it wins over the map), the central map, or none (historical user pool / formation gap). */
  decidedBy: 'client-directory' | 'local' | 'main' | 'central' | 'none';
  reason: string;
  client?: string;
  mapPresent: boolean;
  /** Observations (never policy): used by the screen to label what formation would do. */
  linked?: boolean;
  gitCommonDir?: string;
  /** The client binding of the checkout when the map (version 2) names one, whichever rung decided the source. */
  binding?: BindingInfo;
};
/** The one rule readCatalog, `routes`, the task resolver and the screen's
 * diagnosis share, in order: the checkout's own configuration → the configured
 * same-Git main checkout of a linked checkout (it wins over the map; readCatalog
 * itself does not follow it — see the J1 note) → the central map → none
 * (historical: map absent or repository unmapped outside protected roots).
 * Throws ClientMapError to block. The map is opened only after the first two
 * rungs found nothing. */
export function traceSourceFor(repository: string, home: string): SourceTrace {
  const lexical = resolve(repository);
  const root = join(home, 'slp-clients', 'clients');
  // A path inside the client root is that client's own directory: resolve it by
  // directory name, never as an ordinary repository (no symlinked detours).
  for (const candidate of [lexical, canonical(lexical)]) for (const base of [root, canonical(root)]) {
    const rest = relative(base, candidate);
    if (rest !== '' && rest !== '..' && !rest.startsWith('../') && !isAbsolute(rest)) {
      const loaded = loadClientMap(home);
      if (loaded === null) return { resolution: null, decidedBy: 'none', reason: 'no client map exists; the path is read as an ordinary directory', mapPresent: false };
      const directory = rest.split('/')[0]!;
      if (rest !== directory) return fail('CLIENT_SOURCE_INVALID', 'a path inside a client directory is not a repository');
      const client = Object.keys(loaded.map.clients).find(name => loaded.map.clients[name]!.directory === directory);
      if (client === undefined) return fail('CLIENT_SOURCE_INVALID', `directory ${directory} belongs to no declared client`);
      return { resolution: { kind: 'central', source: readClientSource(loaded, client) }, decidedBy: 'client-directory', client, mapPresent: true,
        binding: bindingOfClient(loaded, client, '', false), reason: `the path is the client directory of ${client}` };
    }
  }
  // The checkout's own configuration still wins the SOURCE, but under a valid
  // strict map a project without a client is blocked, and a version 2 map binds
  // the rules (ladderBinding is a no-op for an absent/invalid/version 1 map).
  if (hasConfiguration(lexical)) {
    const binding = ladderBinding({ home, cwd: lexical }) ?? undefined;
    return { resolution: null, decidedBy: 'local', mapPresent: loadClientMapPresent(home), ...(binding ? { client: binding.client, binding } : {}),
      reason: binding ? `the checkout has its own .paseo-slp configuration, which wins the source; the map binds it to ${binding.client}` : 'the checkout has its own .paseo-slp configuration; the map is not opened' };
  }
  let view: GitView | undefined, unobservable: ClientMapError | undefined;
  try { view = observeGit(lexical); } catch (error) { if (!(error instanceof ClientMapError)) throw error; unobservable = error; }
  const linked = view?.state === 'git' && view.top !== null && !sameFile(dirname(view.gitCommonDir), view.top);
  if (view?.state === 'git' && view.top !== null && linked) {
    const main = dirname(view.gitCommonDir);
    if (hasConfiguration(main)) {
      const binding = ladderBinding({ home, cwd: lexical, gitCommonDir: view.gitCommonDir }) ?? undefined;
      return { resolution: null, decidedBy: 'main', mapPresent: loadClientMapPresent(home), linked, gitCommonDir: view.gitCommonDir, ...(binding ? { client: binding.client, binding } : {}),
        reason: 'the linked checkout inherits its main checkout configuration, which wins over the map' };
    }
  }
  const loaded = loadClientMap(home);
  const gitCommonDir = view?.state === 'git' ? view.gitCommonDir : undefined;
  if (loaded === null) return { resolution: null, decidedBy: 'none', mapPresent: false, linked, gitCommonDir, reason: 'no client map exists: historical behavior' };
  if (unobservable !== undefined) throw unobservable;
  const found = lookupIn(loaded, view!, { origin: originSha256Of, remotes: remotesOf });
  if (found.state !== 'mapped') return { resolution: null, decidedBy: 'none', mapPresent: true, linked, gitCommonDir, reason: 'the repository is not listed in the client map and lies outside the protected roots' };
  return { resolution: { kind: 'central', source: readClientSource(loaded, found.client) }, decidedBy: 'central', client: found.client, mapPresent: true, linked, gitCommonDir, binding: bindingInfo(found),
    reason: found.container !== null ? `the directory is inside the container ${found.container.path} of ${found.client}` : `the repository is listed in the client map for ${found.client} (${found.entry!.originSha256 === null ? 'local-only, no remote' : 'origin verified'})` };
}
const loadClientMapPresent = (home: string) => { try { return readClientMapRaw(home) !== null; } catch { return true; } };
export const resolveSourceFor = (repository: string, home: string): SourceResolution => traceSourceFor(repository, home).resolution;
/** Central source only (placement/validate-style callers). */
export const centralSourceFor = (repository: string, home: string): CentralSource | null => {
  const resolved = resolveSourceFor(repository, home);
  return resolved?.kind === 'central' ? resolved.source : null;
};

// ---- the project list the screen shows (read-only) -----------------------
export type ProjectState = 'bound' | 'pending' | 'blocked' | 'not-git';
export interface ProjectWorkspace { id: string; name: string; path: string; projectId?: string; projectLabel?: string; projectRootPath?: string; projectKind?: 'git' | 'directory' | 'non_git'; workspaceKind?: string }
export interface ProjectRow {
  key: string; state: ProjectState;
  /** The Paseo project label when the host said it, else the repository/folder name — NEVER a workspace name (those are task titles). */
  /** repository: bound by Git identity; folder: a project root without Git, bound as a container (path only). */
  kind: 'repository' | 'folder'; containerBlocked: string | null;
  name: string; projectId: string | null; projectLabel: string | null; projects: { id: string; label: string }[]; repoName: string; workspaceCount: number; mainPath: string | null;
  workspaceIds: string[]; paths: string[];
  gitCommonDir: string | null; originSha256: string | null; localOnly: boolean; projectSuggestion: string; linked: boolean;
  client: string | null; code: string | null; reason: string | null; identity: IdentityCheck | null;
}
export interface ProjectInventory { mapState: 'absent' | 'valid' | 'invalid'; strict: boolean; pending: number; projects: ProjectRow[] }
const MAX_PATHS_PER_ROW = 20;
/** Every project the host lists, collapsed by Git common-dir (worktrees share a
 * row), each with its binding computed here from the paths — never from what the
 * screen claims. Pending = a Git checkout with no map entry (a strict map blocks
 * it at formation and at agent.create; the project itself is never blocked). */
export function inspectProjects(items: ProjectWorkspace[], home: string): ProjectInventory {
  let loaded: LoadedClientMap | null = null, mapError: string | null = null;
  try { loaded = loadClientMap(home); } catch (error) { if (!(error instanceof ClientMapError)) throw error; mapError = error.message; }
  const mapState = mapError !== null ? 'invalid' : loaded === null ? 'absent' : 'valid';
  const rows = new Map<string, ProjectRow>();
  type Item = ProjectWorkspace;
  const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? 'project';
  const attach = (row: ProjectRow, item: Item) => {
    if (!row.workspaceIds.includes(item.id)) { row.workspaceIds.push(item.id); row.workspaceCount = row.workspaceIds.length; }
    if (row.paths.length < MAX_PATHS_PER_ROW && !row.paths.includes(item.path)) row.paths.push(item.path);
    if (item.projectId !== undefined && item.projectLabel && !row.projects.some(project => project.id === item.projectId)) {
      row.projects.push({ id: item.projectId, label: item.projectLabel });
      row.projects.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
      row.projectId = row.projects[0]!.id; row.projectLabel = row.projects[0]!.label; row.name = row.projectLabel;
    }
  };
  // The row is the PROJECT's repository (or its root folder): title = the Paseo project label; a workspace name is never used.
  const blank = (key: string, item: Item, repoName: string, mainPath: string | null): ProjectRow => ({ key, state: 'pending', kind: 'repository', containerBlocked: null,
    name: repoName, projectId: null, projectLabel: null, projects: [], repoName, workspaceCount: 0, mainPath,
    workspaceIds: [], paths: [], gitCommonDir: null, originSha256: null, localOnly: false, projectSuggestion: repoName, linked: false,
    client: null, code: null, reason: null, identity: null });
  for (const item of items) {
    let view: GitView;
    try { view = observeGit(item.path); }
    catch (error) {
      if (!(error instanceof ClientMapError)) throw error;
      const key = `path:${item.path}`; // unobservable path: nothing can verify a claimed root, so the workspace path is the row
      const row = rows.get(key) ?? { ...blank(key, item, folderName(item.path), item.path), state: 'blocked' as const, code: error.code, reason: error.message };
      rows.set(key, row); attach(row, item); continue;
    }
    if (view.state === 'not-git') {
      // A project root without Git: ONE row per root folder (its workspaces share it), bindable as a container (path
      // only) unless the guards forbid it (the home, `/`, system roots, anything above a protected root).
      // The caller's projectRootPath is display/grouping data: it is used only when it is an ancestor-or-equal (by file
      // identity) of the workspace's REAL path; otherwise the real path is the row, so a container can never be claimed for a path it does not cover.
      const root = item.projectRootPath !== undefined && ancestorsOf(view.location).some(ancestor => sameFile(ancestor, item.projectRootPath!)) ? item.projectRootPath : view.location;
      const key = `path:${root}`;
      let row = rows.get(key);
      if (row === undefined) {
        row = { ...blank(key, item, folderName(root), root), kind: 'folder' };
        const violation = containerViolation(root, loaded?.map ?? { protectedRoots: [] });
        if (mapError !== null) { row.state = 'blocked'; row.code = 'CLIENT_MAP_INVALID'; row.reason = mapError; }
        else if (violation !== null) { row.state = 'not-git'; row.containerBlocked = violation; row.reason = violation; }
        else if (loaded !== null) {
          try {
            const container = findContainer(loaded.map, root);
            if (container !== null) { row.state = 'bound'; row.client = container.client; row.projectSuggestion = container.project; row.reason = sameFile(container.path, root) ? null : `covered by the container ${container.path}`; }
            else if (underProtectedRoot(loaded.map.protectedRoots, root)) { row.code = 'CLIENT_UNMAPPED'; row.reason = 'inside a protected folder with no client: blocked'; }
            else if (loaded.map.strict) { row.code = 'CLIENT_UNMAPPED'; row.reason = 'strict map: a project without a client is blocked'; }
          } catch (error) {
            if (!(error instanceof ClientMapError)) throw error;
            row.state = 'blocked'; row.code = error.code; row.reason = error.message;
          }
        }
        rows.set(key, row);
      }
      // Every workspace under the root must itself be an ordinary folder: a degraded Git repository among them blocks the row.
      if (loaded !== null && mapError === null && row.state !== 'blocked') {
        try { findContainer(loaded.map, view.location); }
        catch (error) { if (!(error instanceof ClientMapError)) throw error; row.state = 'blocked'; row.client = null; row.code = error.code; row.reason = error.message; }
      }
      attach(row, item); continue;
    }
    const key = view.gitCommonDir;
    const top = view.top ?? view.location;
    const main = dirname(view.gitCommonDir);
    const existing = rows.get(key);
    if (existing !== undefined) { attach(existing, item); if (view.top !== null && sameFile(main, view.top)) existing.linked = false; continue; }
    const row = blank(key, item, folderName(main), main);
    row.gitCommonDir = view.gitCommonDir; row.linked = view.top !== null && !sameFile(main, view.top);
    row.projectSuggestion = top.split('/').pop() ?? row.projectSuggestion;
    // Identity facts of the checkout itself (for an unbound repository to be added).
    try {
      const remotes = remotesOf(view.location);
      if (remotes.length === 0) { row.localOnly = true; }
      else { const url = gitRun(view.location, 'remote', 'get-url', 'origin'); row.originSha256 = sha256Hex(url); row.projectSuggestion = projectFromRemote(url) || row.projectSuggestion; }
    } catch { row.code = 'CLIENT_IDENTITY_DRIFT'; row.reason = 'the checkout has remotes but no readable "origin"; it cannot be mapped by origin hash'; row.state = 'blocked'; }
    if (mapError !== null) { row.state = 'blocked'; row.code = 'CLIENT_MAP_INVALID'; row.reason = mapError; }
    else if (loaded !== null && row.state !== 'blocked') {
      const entry = entryForCommonDir(loaded.map, view.gitCommonDir);
      if (entry === undefined) {
        row.state = 'pending';
        if (underProtectedRoot(loaded.map.protectedRoots, view.location, view.gitCommonDir)) { row.code = 'CLIENT_UNMAPPED'; row.reason = 'inside a protected folder with no client: blocked'; }
        else if (loaded.map.strict) { row.code = 'CLIENT_UNMAPPED'; row.reason = 'strict map: a project without a client is blocked'; }
      } else {
        try {
          const found = lookupLoaded(loaded, { home, cwd: view.location, gitCommonDir: view.gitCommonDir });
          if (found.state !== 'mapped') throw new Error('unreachable');
          const info = bindingInfo(found);
          row.state = 'bound'; row.client = info.client; row.localOnly = info.localOnly; row.projectSuggestion = entry.project;
          row.originSha256 = entry.originSha256;
          row.identity = identityFor(view.location, info);
        } catch (error) {
          if (!(error instanceof ClientMapError)) throw error;
          row.state = 'blocked'; row.client = entry.client; row.code = error.code; row.reason = error.message;
        }
      }
    }
    rows.set(key, row);
    attach(row, item);
  }
  const projects = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name) || a.repoName.localeCompare(b.repoName) || a.key.localeCompare(b.key));
  return { mapState, strict: loaded?.map.strict ?? false, pending: projects.filter(row => row.state === 'pending').length, projects };
}

/** `slp.mjs clients check <path>`: read-only report of the client binding of one
 * checkout and of its Git identity against the rule of its OWN client. Never
 * throws for map content; a block is reported. `ok` is false when the checkout
 * is blocked or its identity is not `ok`/not required. Only `git config --get`
 * runs; nothing is written anywhere. */
export function checkClientBinding(path: string, home: string) {
  const base = { path, paseoHome: home };
  let bound: Binding;
  try { bound = bindingFor(path, home); }
  catch (error) {
    if (!(error instanceof ClientMapError)) throw error;
    return { ...base, ok: false, binding: { state: 'blocked' as const }, rules: null, identity: null, warnings: [], error: { code: error.code, message: error.message } };
  }
  if (bound.state !== 'mapped') return { ...base, ok: true, binding: { state: bound.state }, rules: null, identity: null, warnings: [] };
  const { info } = bound;
  const identity = identityFor(bound.location, info);
  const warnings = identityWarnings(info.client, identity);
  return { ...base, ok: identity === null || identity.state === 'ok',
    binding: { state: 'mapped' as const, client: info.client, project: info.project, mapVersion: info.version, strict: info.strict, localOnly: info.localOnly },
    rules: { rulesSha256: info.rulesSha256, effective: info.rules }, identity, warnings };
}

/** Non-blocking: a container that sits above other containers or mapped repositories. It never covers a Git repository
 * (those keep their own binding), but the Human should see the overlap before saving. */
export function containerWarnings(map: ClientMap): string[] {
  const warnings: string[] = [];
  const containers = map.containers ?? [];
  for (const container of containers) {
    const below = (path: string) => path !== container.path && ancestorsOf(path).some(ancestor => sameFile(ancestor, container.path));
    const nested = containers.filter(other => below(other.path)).map(other => other.path);
    const repositories = map.repositories.filter(entry => below(entry.gitCommonDir)).length;
    if (nested.length > 0) warnings.push(`container ${container.path} (${container.client}) contains the containers ${nested.join(', ')}; the deepest container wins for each directory`);
    if (repositories > 0) warnings.push(`container ${container.path} (${container.client}) contains ${repositories} mapped repositories; it does not cover Git repositories, each keeps its own binding`);
  }
  return warnings;
}

/** Host-specific checks shared by `clients validate` and the screen's draft
 * validation: every protected root and gitCommonDir exists on this host in its
 * canonical real-path spelling, and no two entries name one common-dir. */
export function checkMapHost(map: ClientMap): string[] {
  const errors: string[] = [];
  const canonicalPath = (value: string, label: string) => {
    let real: string;
    try { real = nativeReal(value); } catch { errors.push(`${label} does not exist on this host: ${value}`); return; }
    if (real !== value) errors.push(`${label} is not canonical (real path is ${real}): ${value}`);
  };
  map.protectedRoots.forEach((root, i) => canonicalPath(root, `protectedRoots[${i}]`));
  map.repositories.forEach((entry, i) => canonicalPath(entry.gitCommonDir, `repositories[${i}].gitCommonDir`));
  (map.containers ?? []).forEach((entry, i) => {
    canonicalPath(entry.path, `containers[${i}].path`);
    const violation = containerViolation(entry.path, map);
    if (violation !== null) errors.push(violation);
  });
  const containerKeys = new Map<string, string>();
  for (const entry of map.containers ?? []) {
    const key = inodeKey(entry.path);
    if (key === null) continue;
    const previous = containerKeys.get(key);
    if (previous !== undefined) errors.push(`containers ${previous} and ${entry.path} name the same directory`); else containerKeys.set(key, entry.path);
  }
  // A local-only entry promises ZERO remotes; one that gained a remote is drift.
  map.repositories.forEach((entry, i) => {
    if (entry.originSha256 !== null) return;
    try { if (remotesOf(entry.gitCommonDir).length > 0) errors.push(`repositories[${i}] is declared local-only but now has a remote: ${entry.gitCommonDir}`); }
    catch { /* an unreadable path is already reported as missing/non-canonical above */ }
  });
  const identities = new Map<string, string>();
  for (const entry of map.repositories) {
    const key = inodeKey(entry.gitCommonDir);
    if (key === null) continue;
    const previous = identities.get(key);
    if (previous !== undefined) errors.push(`repositories ${previous} and ${entry.gitCommonDir} name the same Git common-dir`);
    else identities.set(key, entry.gitCommonDir);
  }
  return errors;
}

/** `slp.mjs clients validate`: deterministic, read-only, never throws for
 * content errors — they are listed. `catalogCheck` throws for an invalid pool.
 * Paths are host-specific: every protected root and gitCommonDir must exist on
 * this host in its canonical (native real path) spelling. */
export function validateClients(home: string, catalogCheck: (parsed: unknown) => { options: unknown[] }) {
  const base = { paseoHome: home, mapPath: clientMapPath(home) };
  const errors: string[] = [];
  let loaded: LoadedClientMap | null = null;
  try { loaded = loadClientMap(home); if (loaded === null) errors.push('client map is absent'); }
  catch (error) { errors.push((error as Error).message); }
  if (loaded === null) return { ok: false, ...base, errors };
  errors.push(...checkMapHost(loaded.map));
  const referenced = new Set(loaded.map.repositories.map(entry => entry.client));
  const clients = Object.keys(loaded.map.clients).sort().map(name => {
    const rulesText = renderClientRules(name, loaded!.map.version === 2 ? effectiveRules(loaded!.map, name) : {});
    const entry: Record<string, unknown> = { name, directory: loaded!.map.clients[name]!.directory, referenced: referenced.has(name),
      ...(loaded!.map.version === 2 ? { rulesSha256: rulesText === null ? null : sha256Hex(rulesText) } : {}) };
    try {
      const source = readClientSource(loaded!, name);
      entry.routingSha256 = source.files['slp-routing.json'].sha256;
      entry.protocolSha256 = source.files['workspace-protocol.md'].sha256;
      try { entry.options = catalogCheck(JSON.parse(source.files['slp-routing.json'].text)).options.length; }
      catch (error) { entry.error = `invalid Peer pool: ${(error as Error).message}`; errors.push(`client ${name}: ${entry.error}`); }
    } catch (error) { entry.error = (error as Error).message; errors.push((error as Error).message); }
    return entry;
  });
  const repositories = [...loaded.map.repositories].sort((a, b) => a.gitCommonDir.localeCompare(b.gitCommonDir))
    .map(({ client, project, gitCommonDir, originSha256 }) => ({ client, project, gitCommonDir, ...(loaded!.map.version === 2 ? { localOnly: originSha256 === null } : {}) }));
  return { ok: errors.length === 0, ...base, mapSha256: loaded.sha256, ...(loaded.map.version === 2 ? { mapVersion: 2, strict: loaded.map.strict } : {}), protectedRoots: [...loaded.map.protectedRoots].sort(),
    clients, repositories,
    ...(loaded.map.containers !== undefined ? { containers: [...loaded.map.containers].sort((a, b) => a.path.localeCompare(b.path)) } : {}), errors: [...errors].sort() };
}
