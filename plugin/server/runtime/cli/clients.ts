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
const MAX_ROOTS = 64, MAX_CLIENTS = 256, MAX_REPOSITORIES = 1024, MAX_PROJECT = 200;

export type ClientMapErrorCode = 'CLIENT_MAP_INVALID' | 'CLIENT_UNMAPPED' | 'CLIENT_IDENTITY_DRIFT' | 'CLIENT_SOURCE_INVALID';
export class ClientMapError extends Error {
  readonly code: ClientMapErrorCode;
  constructor(code: ClientMapErrorCode, message: string) { super(message); this.name = 'ClientMapError'; this.code = code; }
}
const fail = (code: ClientMapErrorCode, message: string): never => { throw new ClientMapError(code, message); };

export interface ClientMapRepository { client: string; project: string; gitCommonDir: string; originSha256: string }
export interface ClientMap {
  version: 1;
  protectedRoots: string[];
  clients: Record<string, { directory: string }>;
  repositories: ClientMapRepository[];
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
  | { state: 'mapped'; client: string; loaded: LoadedClientMap; location: string; gitCommonDir: string };

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

function exactKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const own = Object.keys(value).sort();
  const want = [...keys].sort();
  if (own.length !== want.length || own.some((key, i) => key !== want[i])) {
    const unknown = own.filter(key => !want.includes(key)), missing = want.filter(key => !own.includes(key));
    fail('CLIENT_MAP_INVALID', `${label} must have exactly ${want.join(', ')}${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}${missing.length ? `; missing: ${missing.join(', ')}` : ''}`);
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

/** Strict schema: version 1, exact keys, bounded, no duplicates. Throws
 * CLIENT_MAP_INVALID naming the first violated rule. */
export function parseClientMap(text: string): ClientMap {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return fail('CLIENT_MAP_INVALID', 'client map is not valid JSON'); }
  assertUniqueKeys(text);
  if (!isRecord(parsed)) return fail('CLIENT_MAP_INVALID', 'client map must be a JSON object');
  exactKeys(parsed, ['version', 'protectedRoots', 'clients', 'repositories'], 'client map');
  if (parsed.version !== 1) fail('CLIENT_MAP_INVALID', 'client map version must be 1');
  if (!Array.isArray(parsed.protectedRoots) || parsed.protectedRoots.length > MAX_ROOTS) fail('CLIENT_MAP_INVALID', `protectedRoots must be an array of at most ${MAX_ROOTS} paths`);
  const protectedRoots = (parsed.protectedRoots as unknown[]).map((root, i) => cleanAbsolute(root, `protectedRoots[${i}]`));
  if (!isRecord(parsed.clients) || Object.keys(parsed.clients).length > MAX_CLIENTS) fail('CLIENT_MAP_INVALID', 'clients must be an object');
  const clients: Record<string, { directory: string }> = Object.create(null);
  const directories = new Set<string>();
  for (const [name, entry] of Object.entries(parsed.clients as Record<string, unknown>)) {
    if (!NAME.test(name)) fail('CLIENT_MAP_INVALID', `client name ${JSON.stringify(name)} is invalid`);
    if (!isRecord(entry)) return fail('CLIENT_MAP_INVALID', `client ${name} must be an object`);
    exactKeys(entry, ['directory'], `client ${name}`);
    const directory = entry.directory;
    if (typeof directory !== 'string' || !NAME.test(directory) || directory.includes('..')) fail('CLIENT_MAP_INVALID', `client ${name}: directory must be a single safe path component`);
    if (directories.has(directory as string)) fail('CLIENT_MAP_INVALID', `client ${name}: directory ${directory} is shared with another client`);
    directories.add(directory as string);
    clients[name] = { directory: directory as string };
  }
  if (!Array.isArray(parsed.repositories) || parsed.repositories.length > MAX_REPOSITORIES) fail('CLIENT_MAP_INVALID', `repositories must be an array of at most ${MAX_REPOSITORIES} entries`);
  const seen = new Set<string>();
  const repositories: ClientMapRepository[] = (parsed.repositories as unknown[]).map((entry, i) => {
    if (!isRecord(entry)) return fail('CLIENT_MAP_INVALID', `repositories[${i}] must be an object`);
    exactKeys(entry, ['client', 'project', 'gitCommonDir', 'originSha256'], `repositories[${i}]`);
    if (typeof entry.client !== 'string' || !Object.hasOwn(clients, entry.client)) fail('CLIENT_MAP_INVALID', `repositories[${i}]: client is not declared in clients`);
    if (typeof entry.project !== 'string' || !entry.project.trim() || entry.project.length > MAX_PROJECT || /[\u0000-\u001f]/.test(entry.project)) fail('CLIENT_MAP_INVALID', `repositories[${i}]: project must be a short text`);
    const gitCommonDir = cleanAbsolute(entry.gitCommonDir, `repositories[${i}].gitCommonDir`);
    if (typeof entry.originSha256 !== 'string' || !SHA256.test(entry.originSha256)) fail('CLIENT_MAP_INVALID', `repositories[${i}]: originSha256 must be 64 lowercase hex characters`);
    if (seen.has(gitCommonDir)) fail('CLIENT_MAP_INVALID', `gitCommonDir appears in more than one repository entry (${gitCommonDir})`);
    seen.add(gitCommonDir);
    return { client: entry.client as string, project: entry.project as string, gitCommonDir, originSha256: entry.originSha256 as string };
  });
  return { version: 1, protectedRoots, clients, repositories };
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
export const serializeClientMap = (map: ClientMap): string => `${JSON.stringify({ version: map.version, protectedRoots: map.protectedRoots, clients: map.clients, repositories: map.repositories }, null, 2)}\n`;
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

// Git runs with a fixed C locale so "not a git repository" is recognizable.
const gitRun = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 2500, maxBuffer: 4096,
  env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), LC_ALL: 'C', LANG: 'C' },
}).trim();
export const originSha256Of = (cwd: string) => sha256Hex(gitRun(cwd, 'remote', 'get-url', 'origin'));

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

function lookupIn(loaded: LoadedClientMap, view: GitView, origin: (cwd: string) => string): ClientLookup {
  if (view.state === 'not-git') {
    if (underProtectedRoot(loaded.map.protectedRoots, view.location)) fail('CLIENT_UNMAPPED', 'protected directory is not a Git checkout; no user-pool fallback');
    return { state: 'unmapped' };
  }
  const key = inodeKey(view.gitCommonDir);
  if (key === null) return fail('CLIENT_UNMAPPED', 'Git common-dir cannot be inspected while a client map is present');
  const hits = loaded.map.repositories.filter(item => inodeKey(item.gitCommonDir) === key);
  if (hits.length > 1) fail('CLIENT_MAP_INVALID', 'more than one repository entry names the same Git common-dir');
  const entry = hits[0];
  if (entry === undefined) {
    if (underProtectedRoot(loaded.map.protectedRoots, view.location, view.gitCommonDir)) fail('CLIENT_UNMAPPED', 'protected repository has no client mapping; no user-pool fallback');
    return { state: 'unmapped' };
  }
  let actual: string;
  try { actual = origin(view.location); } catch { return fail('CLIENT_IDENTITY_DRIFT', 'remote identity drift: origin cannot be verified'); }
  if (actual !== entry.originSha256) fail('CLIENT_IDENTITY_DRIFT', 'remote identity drift: origin differs from the client map entry');
  return { state: 'mapped', client: entry.client, loaded, location: view.location, gitCommonDir: view.gitCommonDir };
}

/** Resolve which client (if any) owns the checkout at `cwd`. `gitCommonDir` may
 * be supplied by a caller that already observed it (placement); identity is
 * compared by file identity, never by spelling. */
export function lookupClient(request: { home: string; cwd: string; gitCommonDir?: string; origin?: (cwd: string) => string }): ClientLookup {
  const loaded = loadClientMap(request.home);
  if (loaded === null) return { state: 'absent' };
  const view: GitView = request.gitCommonDir === undefined ? observeGit(request.cwd)
    : (() => { try { return { state: 'git' as const, location: nativeReal(request.cwd), top: null, gitCommonDir: nativeReal(request.gitCommonDir!) }; }
      catch { return fail('CLIENT_UNMAPPED', 'checkout directory cannot be resolved while a client map is present'); } })();
  return lookupIn(loaded, view, request.origin ?? originSha256Of);
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
 * suggestion derived from its path. Throws ClientMapError (not Git / no origin). */
export function identifyCheckout(cwd: string): { gitCommonDir: string; originSha256: string; projectSuggestion: string; linked: boolean; location: string } {
  const view = observeGit(cwd);
  if (view.state !== 'git') return fail('CLIENT_UNMAPPED', 'the path is not a Git checkout');
  let url: string;
  try { url = gitRun(view.location, 'remote', 'get-url', 'origin'); } catch { return fail('CLIENT_IDENTITY_DRIFT', 'the checkout has no readable origin remote; the map requires its hash'); }
  const project = projectFromRemote(url);
  const top = view.top ?? view.location;
  return { gitCommonDir: view.gitCommonDir, originSha256: sha256Hex(url), projectSuggestion: project || (top.split('/').pop() ?? 'repository'),
    linked: view.top !== null && !sameFile(dirname(view.gitCommonDir), view.top), location: view.location };
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
        reason: `the path is the client directory of ${client}` };
    }
  }
  if (hasConfiguration(lexical)) return { resolution: null, decidedBy: 'local', mapPresent: loadClientMapPresent(home), reason: 'the checkout has its own .paseo-slp configuration; the map is not opened' };
  let view: GitView | undefined, unobservable: ClientMapError | undefined;
  try { view = observeGit(lexical); } catch (error) { if (!(error instanceof ClientMapError)) throw error; unobservable = error; }
  const linked = view?.state === 'git' && view.top !== null && !sameFile(dirname(view.gitCommonDir), view.top);
  if (view?.state === 'git' && view.top !== null && linked) {
    const main = dirname(view.gitCommonDir);
    if (hasConfiguration(main)) return { resolution: null, decidedBy: 'main', mapPresent: loadClientMapPresent(home), linked, gitCommonDir: view.gitCommonDir,
      reason: 'the linked checkout inherits its main checkout configuration, which wins over the map' };
  }
  const loaded = loadClientMap(home);
  const gitCommonDir = view?.state === 'git' ? view.gitCommonDir : undefined;
  if (loaded === null) return { resolution: null, decidedBy: 'none', mapPresent: false, linked, gitCommonDir, reason: 'no client map exists: historical behavior' };
  if (unobservable !== undefined) throw unobservable;
  const found = lookupIn(loaded, view!, originSha256Of);
  if (found.state !== 'mapped') return { resolution: null, decidedBy: 'none', mapPresent: true, linked, gitCommonDir, reason: 'the repository is not listed in the client map and lies outside the protected roots' };
  return { resolution: { kind: 'central', source: readClientSource(loaded, found.client) }, decidedBy: 'central', client: found.client, mapPresent: true, linked, gitCommonDir,
    reason: `the repository is listed in the client map for ${found.client} (origin verified)` };
}
const loadClientMapPresent = (home: string) => { try { return readClientMapRaw(home) !== null; } catch { return true; } };
export const resolveSourceFor = (repository: string, home: string): SourceResolution => traceSourceFor(repository, home).resolution;
/** Central source only (placement/validate-style callers). */
export const centralSourceFor = (repository: string, home: string): CentralSource | null => {
  const resolved = resolveSourceFor(repository, home);
  return resolved?.kind === 'central' ? resolved.source : null;
};

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
    const entry: Record<string, unknown> = { name, directory: loaded!.map.clients[name]!.directory, referenced: referenced.has(name) };
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
    .map(({ client, project, gitCommonDir }) => ({ client, project, gitCommonDir }));
  return { ok: errors.length === 0, ...base, mapSha256: loaded.sha256, protectedRoots: [...loaded.map.protectedRoots].sort(),
    clients, repositories, errors: [...errors].sort() };
}
