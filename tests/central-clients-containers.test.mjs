// Fase 3b: project root folders WITHOUT Git bound as `containers` (map version 2, optional key, path only), the
// guards that forbid covering everything, the capability gate, and the differential proof that homes without a
// map, with a version 1 map or with a version 2 map WITHOUT containers read exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRoleInjection } from '../plugin/server/role-injection.ts';
import { install } from '../plugin/server/runtime/cli/package.ts';
import { readCatalog, validateCatalog } from '../plugin/server/runtime/cli/routing.ts';
import * as C from '../plugin/server/runtime/cli/clients.ts';
import { makeHome } from './helpers/plugin-doubles.mjs';
import { fixtureGit, committedRepository } from './helpers/formation-placement-fixture.mjs';
import { centralFixture, baseMapV2, writeClient, writeMap, sha256, ORIGIN, RULES } from './helpers/central-clients-fixture.mjs';
import { runScenario } from './helpers/clients-differential-scenario.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin/slp.mjs');
const slp = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv } });
const pool = id => ({ version: 1, policy: 'Fixture', quotaFallback: { enabled: false, optionId: null },
  options: [{ id, provider: 'codex', roles: ['peer'], model: 'model/variant', enabled: true, availability: 'ready', suitableFor: ['coding'], avoidFor: [], notes: 'n' }] });
const codeOf = error => error instanceof C.ClientMapError ? error.code : null;

function world(t) {
  const home = realpathSync(makeHome(t));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slp-cont-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeClient(home, 'clienteA', pool('client-a')); writeClient(home, 'clienteB', pool('client-b'));
  const folder = (...parts) => { const path = join(dir, ...parts); mkdirSync(path, { recursive: true }); return path; };
  const map = (containers, extra = {}) => ({ version: 2, strict: false, protectedRoots: [], clients: { ClienteA: { directory: 'clienteA' }, ClienteB: { directory: 'clienteB' } }, repositories: [], ...(containers === undefined ? {} : { containers }), ...extra });
  return { home, dir, folder, map };
}
const cont = (client, project, path) => ({ client, project, path });

// ------------------------------------------------------------------ schema
test('containers: optional key of version 2 only; v1 rejects it; entries are validated; serialization keeps the canonical position', () => {
  const base = { version: 2, strict: false, protectedRoots: [], clients: { A: { directory: 'a' } }, repositories: [] };
  const parse = extra => C.parseClientMap(JSON.stringify({ ...base, ...extra }));
  assert.equal(parse({}).containers, undefined);
  const parsed = parse({ containers: [{ client: 'A', project: 'DWLaw / Geral', path: '/tmp/geral' }] });
  assert.deepEqual(parsed.containers, [{ client: 'A', project: 'DWLaw / Geral', path: '/tmp/geral' }]);
  assert.deepEqual(Object.keys(JSON.parse(C.serializeClientMap(parsed))), ['version', 'strict', 'protectedRoots', 'clients', 'repositories', 'containers']);
  assert.equal('containers' in JSON.parse(C.serializeClientMap(parse({}))), false, 'absent stays absent');
  const bad = (extra, pattern) => assert.throws(() => parse(extra), error => codeOf(error) === 'CLIENT_MAP_INVALID' && pattern.test(error.message), pattern.source);
  bad({ containers: [{ client: 'Z', project: 'p', path: '/tmp/x' }] }, /client is not declared/);
  bad({ containers: [{ client: 'A', project: 'p', path: 'relative' }] }, /normalized absolute path/);
  bad({ containers: [{ client: 'A', project: 'p', path: '/tmp/x', extra: 1 }] }, /unknown: extra/);
  bad({ containers: [{ client: 'A', project: 'p', path: '/tmp/x' }, { client: 'A', project: 'q', path: '/tmp/x' }] }, /more than one container entry/);
  bad({ containers: 'no' }, /containers must be an array/);
  assert.throws(() => C.parseClientMap(JSON.stringify({ version: 1, protectedRoots: [], clients: { A: { directory: 'a' } }, repositories: [], containers: [] })), error => /unknown: containers/.test(error.message), 'v1 has no containers');
});

// ------------------------------------------------------------------ lookup
test('DWLaw / Geral: a non-Git project root binds the directories under it (deepest wins), rules reach the create hook, clients check names the container; a Git repository inside is NOT covered', async t => {
  const w = world(t);
  const geral = w.folder('DWLaw', 'Geral'); const docs = w.folder('DWLaw', 'Geral', 'docs', 'sub'); const nested = w.folder('DWLaw', 'Geral', 'docs');
  const outside = w.folder('Outro'); const inner = join(geral, 'repo'); const innerCommon = committedRepository(inner); fixtureGit(inner, 'remote', 'add', 'origin', ORIGIN);
  writeMap(w.home, w.map([cont('ClienteA', 'DWLaw / Geral', geral), cont('ClienteB', 'DWLaw / Geral / docs', nested)], { strict: true, rules: RULES }));
  assert.equal(C.bindingFor(geral, w.home).info.client, 'ClienteA'); assert.equal(C.bindingFor(geral, w.home).info.container, true);
  assert.equal(C.bindingFor(docs, w.home).info.client, 'ClienteB', 'the deepest container wins');
  const catalog = readCatalog(docs, w.home);
  assert.equal(catalog.scope, 'central:ClienteB'); assert.equal(catalog.binding.client, 'ClienteB');
  // strict: a non-Git directory outside every container is still blocked; a Git repo inside the container is not covered
  assert.throws(() => C.bindingFor(outside, w.home), error => codeOf(error) === 'CLIENT_UNMAPPED');
  assert.throws(() => C.bindingFor(inner, w.home), error => codeOf(error) === 'CLIENT_UNMAPPED' && /strict client map/.test(error.message), 'a repository keeps needing its own binding');
  writeMap(w.home, w.map([cont('ClienteA', 'DWLaw / Geral', geral)], { strict: true, repositories: [{ client: 'ClienteB', project: 'repo', gitCommonDir: innerCommon, originSha256: sha256(ORIGIN) }] }));
  assert.equal(C.bindingFor(inner, w.home).info.client, 'ClienteB', 'the repository entry decides, not the container above it');
  assert.equal(C.bindingFor(inner, w.home).info.container, false);
  // CLI
  const check = JSON.parse(slp(['clients', 'check', geral, '--paseo-home', w.home]).stdout);
  assert.deepEqual([check.binding.state, check.binding.client, check.binding.project], ['mapped', 'ClienteA', 'DWLaw / Geral']);
  // hook
  writeMap(w.home, w.map([cont('ClienteA', 'DWLaw / Geral', geral), cont('ClienteB', 'DWLaw / Geral / docs', nested)], { strict: true, rules: RULES }));
  const dir = mkdtempSync(join(tmpdir(), 'slp-cont-hook-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { candidate: identity } = install(root, join(dir, 'candidate'));
  const { clientContextForCwd } = await import('../plugin/server/client-context.ts');
  const injection = createRoleInjection({ readActiveBinding: () => ({ candidateSha256: identity.sha256, payloadSha256: 'a'.repeat(64), runtimePath: join(dir, 'candidate'), nodePath: process.execPath, daemonHome: w.home }), verifyCandidate: async () => {}, clientContext: cwd => clientContextForCwd(cwd, w.home) });
  const out = await injection.agentCreate({ request: { config: { provider: 'slp-codex-peer', cwd: docs } } });
  assert.match(out.config.systemPrompt, /## Regras do cliente ClienteB \(SLP\)/, 'the deepest container decides which client\'s rules arrive');
  const top = await injection.agentCreate({ request: { config: { provider: 'slp-codex-peer', cwd: geral } } });
  assert.match(top.config.systemPrompt, /## Regras do cliente ClienteA \(SLP\)/);
  await assert.rejects(injection.agentCreate({ request: { config: { provider: 'slp-codex-peer', cwd: outside } } }), error => /mapeie o projeto na tela Clientes/.test(error.message));
});

test('containers: pins and rules ride on the same binding (v2); a v1 reader never sees the key', t => {
  const w = world(t); const geral = w.folder('Geral');
  writeMap(w.home, w.map([cont('ClienteA', 'Geral', geral)], { rules: RULES }));
  const info = C.bindingFor(geral, w.home).info;
  assert.match(info.rulesSha256, /^[0-9a-f]{64}$/); assert.equal(C.formationBindingOf(info).client, 'ClienteA');
  assert.equal(C.mapHasContainers(w.home), true);
  writeMap(w.home, w.map(undefined)); assert.equal(C.mapHasContainers(w.home), false);
});

// ------------------------------------------------------------------ guards
test('guards: the user HOME, `/`, a system root, a folder containing the home and any ancestor of a protected root can never be a container — at lookup, validate and the project list', async t => {
  const w = world(t);
  const fakeHome = w.folder('home', 'user'); const previous = process.env.HOME; process.env.HOME = fakeHome; t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  const protectedRoot = w.folder('clients-root', 'PDCase'); const ancestorOfRoot = join(w.dir, 'clients-root');
  const forbidden = { home: fakeHome, slash: '/', tmp: '/tmp', aboveHome: join(w.dir, 'home'), aboveProtected: ancestorOfRoot, protectedItself: protectedRoot };
  for (const [name, path] of Object.entries(forbidden)) {
    assert.notEqual(C.containerViolation(path, { protectedRoots: [protectedRoot] }), null, name);
    writeMap(w.home, w.map([cont('ClienteA', 'x', path)], { protectedRoots: [protectedRoot] }));
    assert.throws(() => C.bindingFor(w.folder('probe'), w.home), error => codeOf(error) === 'CLIENT_MAP_INVALID' && /can never be bound|cover every project/.test(error.message), `lookup ${name}`);
    const report = C.validateClients(w.home, parsed => validateCatalog(parsed));
    assert.equal(report.ok, false, name); assert.match(report.errors.join('\n'), /can never be bound|cover every project/, `validate ${name}`);
  }
  const ok = w.folder('home', 'user', 'Projetos', 'Geral');
  assert.equal(C.containerViolation(ok, { protectedRoots: [protectedRoot] }), null, 'a project folder below the home is fine');
  // the project list never offers a folder the guards forbid
  const inventory = C.inspectProjects([{ id: 'h', name: 'Casa', path: fakeHome, projectId: 'p', projectLabel: 'Pessoal / Casa', projectRootPath: fakeHome, projectKind: 'non_git' }], w.home);
  writeMap(w.home, w.map(undefined, { protectedRoots: [protectedRoot] }));
  const listed = C.inspectProjects([{ id: 'h', name: 'Casa', path: fakeHome, projectId: 'p', projectLabel: 'Pessoal / Casa', projectRootPath: fakeHome, projectKind: 'non_git' }], w.home);
  assert.deepEqual([listed.projects[0].kind, listed.projects[0].state, listed.projects[0].name], ['folder', 'not-git', 'Pessoal / Casa']);
  assert.match(listed.projects[0].containerBlocked, /user home/); assert.equal(listed.pending, 0, 'a forbidden folder is not "pending"');
  void inventory;
});

test('containers: two entries naming one directory (symlink) are CLIENT_MAP_INVALID, never "first wins"', t => {
  const w = world(t); const real = w.folder('Geral'); const link = join(w.dir, 'GeralLink'); symlinkSync(real, link);
  writeMap(w.home, w.map([cont('ClienteA', 'a', real), cont('ClienteB', 'b', link)]));
  assert.throws(() => C.bindingFor(real, w.home), error => codeOf(error) === 'CLIENT_MAP_INVALID' && /same directory/.test(error.message));
  assert.match(C.validateClients(w.home, parsed => validateCatalog(parsed)).errors.join('\n'), /name the same directory/);
});

test('validate lists containers (only when present) and requires canonical existing paths', t => {
  const w = world(t); const geral = w.folder('Geral');
  writeMap(w.home, w.map([cont('ClienteA', 'Geral', geral)]));
  const report = C.validateClients(w.home, parsed => validateCatalog(parsed));
  assert.equal(report.ok, true, JSON.stringify(report.errors)); assert.deepEqual(report.containers, [cont('ClienteA', 'Geral', geral)]);
  writeMap(w.home, w.map([cont('ClienteA', 'Geral', join(w.dir, 'nao-existe'))]));
  assert.match(C.validateClients(w.home, parsed => validateCatalog(parsed)).errors.join('\n'), /containers\[0\]\.path does not exist on this host/);
  writeMap(w.home, w.map(undefined)); assert.equal('containers' in C.validateClients(w.home, parsed => validateCatalog(parsed)), false);
});

// -------------------------------------------------------------- capability
test('capability: a candidate without clientContainers refuses a map that declares containers (explicit CAPABILITY_GAP) in formation and task deliver; maps without containers do not need it', async t => {
  const { createFormationPlanner } = await import('../plugin/server/desk-formation.ts');
  const { createTaskRuntimeResolver } = await import('../plugin/server/desk-task-runtime.ts');
  const { resolveBinding } = await import('../plugin/server/runtime/cli/launch.ts');
  const launch = await import('../plugin/server/runtime/cli/launch.ts');
  assert.equal(launch.FORMATION_CAPABILITIES.clientContainers, 1);
  const f = centralFixture(t); const geral = join(f.dir, 'Geral'); mkdirSync(geral);
  const caps = { existingPlacement: 1, peerPresets: 2, centralClients: 1, clientBinding: 1 };
  const withMap = (containers) => writeMap(f.home, { ...baseMapV2(f.commonDir), ...(containers ? { containers } : {}) });
  const seat = async () => {
    const importModule = async spec => { const l = await import(spec); return { ...l, FORMATION_CAPABILITIES: caps, selectPeerSeat: (request, deps) => l.selectPeerSeat(request, { ...deps, decide: f.decide }) }; };
    const planner = createFormationPlanner({ runtimePath: f.candidate, daemonHome: f.home, host: () => f.host, importModule });
    Object.assign(f.deps, { plan: planner, placementCapability: planner.placementCapability, preflightPeer: planner.preflightPeer, selectPeer: planner.selectPeer });
    return f.run(f.input);
  };
  withMap([cont('ClienteA', 'Geral', geral)]);
  const refused = await seat();
  assert.equal(refused.code ?? refused.result?.code, 'CAPABILITY_GAP', JSON.stringify(refused)); assert.match(refused.message ?? refused.result.message, /client containers/);
  const resolve = capabilities => createTaskRuntimeResolver({ runtimePath: f.candidate, daemonHome: f.home,
    host: () => ({ providers: { snapshot: async () => ({ entries: [{ provider: 'slp-codex-peer', enabled: true, status: 'ready' }] }) } }), importModule: async () => ({ resolveBinding, FORMATION_CAPABILITIES: capabilities }) });
  const sha = readCatalog(f.repository, f.home).sha256;
  const old = await resolve(caps)(f.repository, { optionId: 'client-a', catalogSha256: sha });
  assert.equal(old.code, 'CAPABILITY_GAP', JSON.stringify(old)); assert.match(old.message ?? old.reason ?? JSON.stringify(old), /client containers/);
  const current = await resolve({ ...caps, clientContainers: 1 })(f.repository, { optionId: 'client-a', catalogSha256: sha });
  assert.equal(current.routing?.catalogScope, 'central:ClienteA', JSON.stringify(current));
  withMap(undefined);
  const fine = await resolve(caps)(f.repository, { optionId: 'client-a', catalogSha256: readCatalog(f.repository, f.home).sha256 });
  assert.equal(fine.routing?.catalogScope, 'central:ClienteA', 'no containers, no new requirement');
});

test('runtime capabilities probe: unknown without a verified binding; copies numbers from the verified candidate only; a really installed candidate declares clientContainers', async t => {
  const { createRuntimeCapabilities } = await import('../plugin/server/runtime-capabilities.ts');
  const dir = mkdtempSync(join(tmpdir(), 'slp-cap-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { candidate: identity } = install(root, join(dir, 'candidate'));
  const binding = { runtimePath: join(dir, 'candidate'), candidateSha256: identity.sha256, payloadSha256: 'p'.repeat(64) };
  const probe = extra => createRuntimeCapabilities({ readActiveBinding: () => binding, verify: () => {}, ...extra })();
  assert.equal(await createRuntimeCapabilities({ readActiveBinding: () => null, verify: () => {} })(), null);
  assert.equal(await createRuntimeCapabilities({ readActiveBinding: () => { throw new Error('x'); }, verify: () => {} })(), null);
  assert.equal(await probe({ verify: () => { throw new Error('tampered'); } }), null, 'a candidate that fails verification declares nothing');
  assert.equal(await probe({ importModule: async () => { throw new Error('boom'); } }), null);
  assert.deepEqual(await createRuntimeCapabilities({ readActiveBinding: () => ({ ...binding, candidateSha256: 'd'.repeat(64) }), verify: () => {}, importModule: async () => ({ FORMATION_CAPABILITIES: { clientContainers: 1, evil: 'yes', other: 2 } }) })(), { clientContainers: 1, other: 2 });
  assert.deepEqual(await createRuntimeCapabilities({ readActiveBinding: () => ({ ...binding, candidateSha256: 'e'.repeat(64) }), verify: () => {}, importModule: async () => ({}) })(), {});
  assert.equal((await probe({}))?.clientContainers, 1, 'the real installed candidate declares it');
});

// ------------------------------------------------------------ differential
test('differential: homes without a map, with a v1 map and with a v2 map WITHOUT containers read exactly as the previous candidate (readCatalog, traceSourceFor, lookupClient, validateClients)', async () => {
  const golden = JSON.parse(readFileSync(join(root, 'tests/fixtures/clients-differential.golden.json'), 'utf8'));
  const actual = await runScenario();
  assert.deepEqual(Object.keys(actual), Object.keys(golden));
  for (const home of Object.keys(golden)) assert.deepEqual(actual[home], golden[home], `home ${home}`);
  assert.ok(Object.keys(golden).length >= 5 && Object.keys(golden.v1).length >= 9, 'the golden really covers the matrix');
});

test('docs: containers, the capability gate and the project-level rows are documented where operators read them', () => {
  const ops = readFileSync(join(root, 'docs/operations.md'), 'utf8');
  for (const pattern of [/Project folders without Git \(`containers`\)/, /A container never covers a Git repository/, /clientContainers/, /Paseo \*\*project\*\*/, /projectId` only groups the UI/, /only a \*suggestion\*/]) assert.match(ops, pattern, pattern.source);
  for (const pattern of [/A degraded Git repository is never "a plain folder"/, /projectRootPath` is validated/, /st_dev` differs/, /WSL case is the same rule but was not exercised/, /pre-selected by the first picked project/]) assert.match(ops, pattern, pattern.source);
  assert.match(readFileSync(join(root, 'docs/decisions/2026-11-06-client-containers.md'), 'utf8'), /Status: Accepted/);
  assert.match(readFileSync(join(root, 'docs/cli.md'), 'utf8'), /`containers`/);
});

// ------------------------------------------------ correction round 1 (F-A, F-B, mount points)
import { chmodSync, renameSync, statSync, unlinkSync } from 'node:fs';

test('F-A: a degraded Git repository inside a client folder is BLOCKED — never inherits the container\'s client (nor B\'s rules, nor the user pool) — strict and not, at every reader', async t => {
  const w = world(t);
  const bFolder = w.folder('ClienteB'); const dir = mkdtempSync(join(tmpdir(), 'slp-cont-hook-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  // (1) a repository mapped to ClienteA whose HEAD is gone
  const broken = join(bFolder, 'mapped-a'); const brokenCommon = committedRepository(broken); fixtureGit(broken, 'remote', 'add', 'origin', ORIGIN);
  // (2) a linked worktree of a repository mapped to ClienteA whose main checkout was moved away
  const main = join(w.dir, 'main-a'); const mainCommon = committedRepository(main); fixtureGit(main, 'remote', 'add', 'origin', 'https://git.example.invalid/outro/app.git');
  const linked = join(bFolder, 'linked-a'); fixtureGit(main, 'worktree', 'add', '--detach', linked, 'HEAD');
  // (3) a plain nested folder stays an ordinary member of the container
  const plain = w.folder('ClienteB', 'docs', 'sub');
  const entries = [{ client: 'ClienteA', project: 'a', gitCommonDir: brokenCommon, originSha256: sha256(ORIGIN) }, { client: 'ClienteA', project: 'm', gitCommonDir: mainCommon, originSha256: sha256('https://git.example.invalid/outro/app.git') }];
  const { clientContextForCwd } = await import('../plugin/server/client-context.ts');
  for (const strict of [true, false]) {
    writeMap(w.home, { ...w.map([cont('ClienteB', 'Geral B', bFolder)], { strict, rules: RULES }), repositories: entries });
    assert.equal(C.bindingFor(plain, w.home).info.client, 'ClienteB', `control: a plain folder still inherits (strict ${strict})`);
    assert.equal(C.bindingFor(broken, w.home).info.client, 'ClienteA', 'control: healthy, the repository entry decides');
    // break them
    unlinkSync(join(broken, '.git', 'HEAD')); renameSync(main, `${main}-moved`);
    const degraded = { head: broken, worktree: linked };
    for (const [name, path] of Object.entries(degraded)) {
      const blocked = error => codeOf(error) === 'CLIENT_UNMAPPED' && /degraded Git repository inside a client folder/.test(error.message);
      assert.throws(() => C.bindingFor(path, w.home), blocked, `bindingFor ${name} strict=${strict}`);
      assert.throws(() => readCatalog(path, w.home), blocked, `readCatalog ${name}`);
      assert.throws(() => C.traceSourceFor(path, w.home), blocked, `traceSourceFor ${name}`);
      assert.throws(() => C.lookupClient({ home: w.home, cwd: path }), blocked, `lookupClient ${name}`);
      if (strict) {
        assert.throws(() => C.ladderBinding({ home: w.home, cwd: path }), blocked, `ladderBinding ${name}`);
        assert.throws(() => clientContextForCwd(path, w.home), error => /mapeie o projeto na tela Clientes/.test(error.message) && /degraded Git repository/.test(error.message), `hook ${name} blocks`);
      } else {
        assert.equal(C.ladderBinding({ home: w.home, cwd: path }), null, `ladderBinding ${name}: a non-strict map never blocks, and never binds B`);
        assert.equal(clientContextForCwd(path, w.home), null, `hook ${name} does not inject B's rules`);
      }
      const listed = C.inspectProjects([{ id: 'x', name: 'n', path, projectId: 'p', projectLabel: 'Geral B', projectRootPath: bFolder, projectKind: 'non_git' }], w.home);
      assert.notEqual(listed.projects[0].client, 'ClienteB', `list ${name}`);
      assert.equal(listed.projects[0].state, 'blocked', `list ${name}`);
    }
    const report = JSON.parse(slp(['clients', 'check', broken, '--paseo-home', w.home]).stdout);
    assert.equal(report.binding.state, 'blocked'); assert.match(report.error.message, /degraded Git repository/);
    assert.equal(C.bindingFor(plain, w.home).info.client, 'ClienteB', 'the plain folder is unaffected');
    // restore for the next round
    renameSync(`${main}-moved`, main); writeFileSync(join(broken, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  }
});

test('F-A: an unreadable .git also blocks (it exists), and a directory with no .git anywhere still inherits', t => {
  const w = world(t); const folder = w.folder('ClienteB'); const repo = join(folder, 'r'); committedRepository(repo);
  writeMap(w.home, w.map([cont('ClienteB', 'B', folder)]));
  const before = C.bindingFor(w.folder('ClienteB', 'plain'), w.home).info.client; assert.equal(before, 'ClienteB');
  if (process.getuid?.() === 0) return; // root ignores permissions
  chmodSync(join(repo, '.git'), 0o000);
  try { assert.throws(() => C.bindingFor(repo, w.home), error => codeOf(error) === 'CLIENT_UNMAPPED', 'blocked whichever way Git fails'); }
  finally { chmodSync(join(repo, '.git'), 0o755); }
});

test('F-B: a projectRootPath that does not contain the real workspace path is ignored — the row never claims a container that does not cover it', t => {
  const w = world(t); const bound = w.folder('BoundFolder'); const unrelated = w.folder('Unrelated'); const inside = w.folder('BoundFolder', 'sub');
  writeMap(w.home, w.map([cont('ClienteB', 'B', bound)]));
  const lie = C.inspectProjects([{ id: 'u', name: 'n', path: unrelated, projectId: 'p', projectLabel: 'Falso / Projeto', projectRootPath: bound, projectKind: 'non_git' }], w.home);
  const row = lie.projects[0];
  assert.notEqual(row.state, 'bound'); assert.equal(row.client, null); assert.equal(row.mainPath, unrelated, 'the row uses the real path'); assert.equal(row.key, `path:${unrelated}`);
  assert.equal(row.name, 'Falso / Projeto', 'the label is display data and survives');
  const honest = C.inspectProjects([{ id: 'i', name: 'n', path: inside, projectId: 'p', projectLabel: 'Honesto', projectRootPath: bound, projectKind: 'non_git' }], w.home);
  assert.deepEqual([honest.projects[0].state, honest.projects[0].client, honest.projects[0].mainPath], ['bound', 'ClienteB', bound], 'a real ancestor root is used');
  const same = C.inspectProjects([{ id: 'i', name: 'n', path: bound, projectRootPath: bound }], w.home);
  assert.equal(same.projects[0].mainPath, bound);
  // symlinked workspace path: file identity decides, not spelling
  const link = join(w.dir, 'link-to-sub'); symlinkSync(inside, link);
  const viaLink = C.inspectProjects([{ id: 'l', name: 'n', path: link, projectRootPath: bound }], w.home);
  assert.equal(viaLink.projects[0].mainPath, bound);
});

test('guard: the root of another file system (a whole disk or share) can never be a container; the rule compares st_dev with the parent', () => {
  assert.equal(C.isMountPoint('/a/b', p => ({ dev: p === '/a/b' ? 7 : 3 })), true);
  assert.equal(C.isMountPoint('/a/b', () => ({ dev: 3 })), false);
  assert.equal(C.isMountPoint('/a/b', () => { throw new Error('ENOENT'); }), false, 'an unreadable path is reported by the host check, not here');
  // with the real machine: /dev (devfs/tmpfs) is its own file system on macOS and Linux, and a real /Volumes entry if any
  const real = ['/dev', ...(() => { try { return require('node:fs').readdirSync('/Volumes').map(n => `/Volumes/${n}`); } catch { return []; } })()].filter(p => C.isMountPoint(p));
  for (const path of real) assert.match(C.containerViolation(path, { protectedRoots: [] }) ?? '', /./, path);
  // an ordinary project folder (same device as its parent) is not a mount point
  const dir = mkdtempSync(join(tmpdir(), 'slp-mnt-')); try { assert.equal(C.isMountPoint(dir), false); assert.equal(C.containerViolation(dir, { protectedRoots: [] }), null); } finally { rmSync(dir, { recursive: true, force: true }); }
});
