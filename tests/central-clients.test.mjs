import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createFormationPlanner } from '../plugin/server/desk-formation.ts';
import { createTaskRuntimeResolver } from '../plugin/server/desk-task-runtime.ts';
import { resolveBinding } from '../plugin/server/runtime/cli/launch.ts';
import { readCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { ClientMapError, parseClientMap } from '../plugin/server/runtime/cli/clients.ts';
import { fixtureGit, committedRepository } from './helpers/formation-placement-fixture.mjs';
import { centralFixture, baseMap, writeClient, writeMap, sha256, ORIGIN, PROTOCOL } from './helpers/central-clients-fixture.mjs';

const cli = new URL('../bin/slp.mjs', import.meta.url).pathname;
const slp = (args, home) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(home ? { PASEO_HOME: home } : {}) } });
const created = f => f.hostCalls.filter(c => c.kind === 'create' || c.kind === 'open').length;

// (a) worktree without local configuration + mapping → seat form with receipts.
for (const placement of [undefined, { kind: 'caller' }, { kind: 'existing', workspaceId: 'target', reason: 'client lane' }]) {
  test('central map seats a worktree without local configuration: ' + (placement?.kind ?? 'omitted'), async t => {
    const f = centralFixture(t);
    const input = { ...f.input, ...(placement ? { placement } : {}) };
    const out = await f.run(input);
    assert.equal(out.result.state, 'awaiting-caller-delivery', JSON.stringify(out));
    const selected = out.phases.find(p => p.name === 'route-selected').value;
    assert.equal(selected.source.central.client, 'ClienteA');
    assert.equal(selected.source.scope, 'central:ClienteA');
    assert.equal(selected.source.repository, f.clientDir.replace(/\/\.paseo-slp$/, ''));
    assert.equal(selected.route.optionId, 'client-a');
    const prepared = out.phases.find(p => p.name === 'prepared').value;
    assert.equal(prepared.routing.catalogScope, 'central:ClienteA');
    assert.equal(prepared.routing.optionId, 'client-a');
    const pin = (placement ? out.phases.find(p => p.name === 'target-observed').value : prepared).source;
    assert.equal(pin.central.client, 'ClienteA'); assert.equal(pin.repository, selected.source.repository);
    assert.match(prepared.warnings.join('\n'), /routing\/protocol source central:ClienteA \(map [0-9a-f]{8}\)/);
    const calls = f.hostCalls.length;
    assert.equal((await f.run(input)).receiptSha256, out.receiptSha256);
    assert.equal(f.hostCalls.length, calls);
  });
  test('central protocol is pinned for a Lead seat: ' + (placement?.kind ?? 'omitted'), async t => {
    const f = centralFixture(t, { role: 'lead' });
    const out = await f.run({ ...f.input, ...(placement ? { placement } : {}) });
    assert.equal(out.result.state, 'awaiting-caller-delivery', JSON.stringify(out));
    const pin = (placement ? out.phases.find(p => p.name === 'target-observed').value : out.phases.find(p => p.name === 'prepared').value).source;
    assert.equal(pin.central.client, 'ClienteA');
    assert.ok(out.result.delivery.prompt.includes('Use ' + pin.repository + '/.paseo-slp/workspace-protocol.md'));
    assert.ok(out.result.delivery.prompt.includes('Routing/protocol repository: ' + pin.repository));
  });
}

// (b) no mapping keeps today's behavior; protectedRoots turns it into a block.
test('without a map a linked worktree still reports CAPABILITY_GAP and a plain checkout keeps the user pool', async t => {
  const f = centralFixture(t);
  rmSync(join(f.home, 'slp-clients'), { recursive: true });
  const gap = await f.run(f.input);
  assert.equal(gap.code ?? gap.result?.code, 'CAPABILITY_GAP', JSON.stringify(gap));
  assert.match(gap.message ?? gap.result.message, /configuration source/i);
  assert.equal(created(f), 0);
  f.row.createCwd = f.repository; f.row.workspaceId = 'caller';
  const plain = await f.run({ ...f.input, requestId: 'plain' });
  assert.equal(plain.result.state, 'awaiting-caller-delivery', JSON.stringify(plain));
  assert.equal(plain.phases.find(p => p.name === 'route-selected').value.source.scope, 'user');
});
test('a map that does not list the repository leaves an unprotected repository on the historical path', async t => {
  const f = centralFixture(t);
  f.remapped(baseMap(join(f.foreign, '.git')));
  f.row.createCwd = f.repository; f.row.workspaceId = 'caller';
  const out = await f.run(f.input);
  assert.equal(out.phases.find(p => p.name === 'route-selected').value.source.scope, 'user');
  f.row.createCwd = f.target; f.row.workspaceId = 'target';
  const gap = await f.run({ ...f.input, requestId: 'linked' });
  assert.equal(gap.code ?? gap.result?.code, 'CAPABILITY_GAP');
});
for (const cwd of ['main', 'worktree']) test('unmapped repository under protectedRoots blocks (never the user pool): ' + cwd, async t => {
  const f = centralFixture(t);
  f.remapped(baseMap(join(f.foreign, '.git'), { protectedRoots: [realpathSync(f.dir)] }));
  f.row.createCwd = cwd === 'main' ? f.repository : f.target; f.row.workspaceId = cwd === 'main' ? 'caller' : 'target';
  const out = await f.run(f.input);
  assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP', JSON.stringify(out));
  assert.match(out.message ?? out.result.message, /no client mapping|CLIENT_UNMAPPED/);
  assert.equal(created(f), 0);
  assert.throws(() => readCatalog(f.row.createCwd, f.home), /CLIENT_UNMAPPED|no client mapping/);
});

// (c) the same repository in two entries is ambiguous → block.
test('one repository in two entries blocks formation and readCatalog', async t => {
  const f = centralFixture(t);
  writeClient(f.home, 'clienteB', f.clientPool);
  const map = baseMap(f.commonDir);
  map.clients.ClienteB = { directory: 'clienteB' };
  map.repositories.push({ ...map.repositories[0], client: 'ClienteB' });
  f.remapped(map);
  const out = await f.run(f.input);
  assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP', JSON.stringify(out));
  assert.match(out.message ?? out.result.message, /more than one repository entry/);
  assert.equal(created(f), 0);
  assert.throws(() => readCatalog(f.target, f.home), /more than one repository entry/);
});

// (d) invalid/unreadable map or client source blocks — with a user pool present.
const mapCases = {
  'corrupt JSON': () => '{"version":1,',
  'empty file': () => '',
  'oversized (>64KiB)': ({ commonDir }) => JSON.stringify(baseMap(commonDir, { protectedRoots: [] })) + ' '.repeat(65 * 1024),
  'unknown top-level key': ({ commonDir }) => ({ ...baseMap(commonDir), extra: true }),
  'unknown client key': ({ commonDir }) => ({ ...baseMap(commonDir), clients: { ClienteA: { directory: 'clienteA', pool: 'x' } } }),
  'unknown repository key': ({ commonDir }) => { const m = baseMap(commonDir); m.repositories[0].branch = 'main'; return m; },
  'missing key': ({ commonDir }) => { const m = baseMap(commonDir); delete m.protectedRoots; return m; },
  'wrong version': ({ commonDir }) => ({ ...baseMap(commonDir), version: 2 }),
  'directory with ..': ({ commonDir }) => ({ ...baseMap(commonDir), clients: { ClienteA: { directory: '../clienteA' } } }),
  'directory with slash': ({ commonDir }) => ({ ...baseMap(commonDir), clients: { ClienteA: { directory: 'a/clienteA' } } }),
  'directory absolute': ({ commonDir }) => ({ ...baseMap(commonDir), clients: { ClienteA: { directory: '/etc' } } }),
  'repository names undeclared client': ({ commonDir }) => { const m = baseMap(commonDir); m.repositories[0].client = 'Ghost'; return m; },
  'relative gitCommonDir': () => { const m = baseMap('relative/.git'); return m; },
  'non-hex origin hash': ({ commonDir }) => { const m = baseMap(commonDir); m.repositories[0].originSha256 = 'abc'; return m; },
  'missing origin hash': ({ commonDir }) => { const m = baseMap(commonDir); delete m.repositories[0].originSha256; return m; },
  'shared directory between clients': ({ commonDir }) => ({ ...baseMap(commonDir), clients: { ClienteA: { directory: 'clienteA' }, ClienteB: { directory: 'clienteA' } } }),
};
for (const [name, build] of Object.entries(mapCases)) test('invalid map blocks: ' + name, t => {
  const f = centralFixture(t);
  f.remapped(build(f));
  assert.throws(() => readCatalog(f.target, f.home), error => {
    assert.ok(error instanceof ClientMapError, String(error));
    assert.equal(error.code, 'CLIENT_MAP_INVALID'); return true;
  });
});
test('map defects also block the seat formation end to end', async t => {
  for (const name of ['corrupt JSON', 'unknown top-level key', 'directory with ..']) {
    const f = centralFixture(t);
    f.remapped(mapCases[name](f));
    const out = await f.run(f.input);
    assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP', name + JSON.stringify(out));
    assert.match(out.message ?? out.result.message, /central client map blocks formation/);
    assert.equal(created(f), 0, name);
  }
});
const sourceCases = {
  'pool missing': f => rmSync(join(f.clientDir, 'slp-routing.json')),
  'protocol missing': f => rmSync(join(f.clientDir, 'workspace-protocol.md')),
  'client directory missing': f => rmSync(join(f.home, 'slp-clients/clients/clienteA'), { recursive: true }),
  'pool is a symlink': f => { renameSync(join(f.clientDir, 'slp-routing.json'), join(f.dir, 'pool.json')); symlinkSync(join(f.dir, 'pool.json'), join(f.clientDir, 'slp-routing.json')); },
  'protocol is a symlink': f => { renameSync(join(f.clientDir, 'workspace-protocol.md'), join(f.dir, 'p.md')); symlinkSync(join(f.dir, 'p.md'), join(f.clientDir, 'workspace-protocol.md')); },
  '.paseo-slp is a symlink': f => { renameSync(f.clientDir, join(f.dir, 'moved')); symlinkSync(join(f.dir, 'moved'), f.clientDir); },
  'client directory is a symlink': f => { renameSync(join(f.home, 'slp-clients/clients/clienteA'), join(f.dir, 'moved')); symlinkSync(join(f.dir, 'moved'), join(f.home, 'slp-clients/clients/clienteA')); },
  'slp-clients is a symlink': f => { renameSync(join(f.home, 'slp-clients'), join(f.dir, 'moved')); symlinkSync(join(f.dir, 'moved'), join(f.home, 'slp-clients')); },
  'map is a symlink': f => { renameSync(f.mapPath, join(f.dir, 'map.json')); symlinkSync(join(f.dir, 'map.json'), f.mapPath); },
  'pool oversized': f => writeFileSync(join(f.clientDir, 'slp-routing.json'), ' '.repeat(257 * 1024)),
  'pool is a directory': f => { rmSync(join(f.clientDir, 'slp-routing.json')); mkdirSync(join(f.clientDir, 'slp-routing.json')); },
};
for (const [name, mutate] of Object.entries(sourceCases)) test('unreadable client source blocks without fallback: ' + name, t => {
  const f = centralFixture(t);
  mutate(f);
  assert.throws(() => readCatalog(f.target, f.home), error => error instanceof ClientMapError);
  assert.throws(() => readCatalog(f.clientDir.replace(/\/\.paseo-slp$/, ''), f.home));
});
test('client source defects block the seat formation end to end (user pool exists)', async t => {
  for (const name of ['pool missing', 'pool is a symlink', 'map is a symlink', 'client directory is a symlink']) {
    const f = centralFixture(t);
    sourceCases[name](f);
    const out = await f.run(f.input);
    assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP', name + JSON.stringify(out));
    assert.equal(created(f), 0, name);
    assert.equal(JSON.stringify(out).includes('user-only'), false, name);
  }
});
test('an invalid pool in the client file is a block, not a fallback', t => {
  const f = centralFixture(t);
  writeClient(f.home, 'clienteA', '{"version":1,"policy":"x","options":[{"id":"BAD"}]}');
  assert.throws(() => readCatalog(f.target, f.home), /Invalid or duplicate routing option id/);
});

// (e) local configuration (and the main checkout) win; the map is not read.
test('configuration of the checkout itself wins and the map is never read', async t => {
  const f = centralFixture(t);
  mkdirSync(join(f.target, '.paseo-slp'), { recursive: true });
  writeFileSync(join(f.target, '.paseo-slp/slp-routing.json'), JSON.stringify({ ...f.catalog, options: [{ ...f.options[0], id: 'local-only' }] }));
  writeFileSync(f.mapPath, '{not json');
  const out = await f.run(f.input);
  assert.equal(out.result?.state, 'awaiting-caller-delivery', JSON.stringify(out));
  const selected = out.phases.find(p => p.name === 'route-selected').value;
  assert.equal(selected.source.scope, 'repository'); assert.equal(selected.route.optionId, 'local-only');
  assert.equal(selected.source.central, undefined);
  assert.equal(readCatalog(f.target, f.home).scope, 'repository');
});
test('main checkout configuration wins over the map for its linked worktree', async t => {
  const f = centralFixture(t);
  mkdirSync(join(f.repository, '.paseo-slp'), { recursive: true });
  writeFileSync(join(f.repository, '.paseo-slp/slp-routing.json'), JSON.stringify({ ...f.catalog, options: [{ ...f.options[0], id: 'main-only' }] }));
  writeFileSync(f.mapPath, '{not json');
  const out = await f.run(f.input);
  const selected = out.phases.find(p => p.name === 'route-selected').value;
  assert.equal(selected.route.optionId, 'main-only'); assert.equal(selected.source.repository, f.repository);
  writeMap(f.home, baseMap(f.commonDir));
  // J1 (REOPEN_REQUEST): a raw linked worktree keeps its historical readCatalog resolution; formation (above) is the one that reads main.
  assert.equal(readCatalog(f.target, f.home).scope, 'user');
});

// (f) client isolation.
test('ClienteA never resolves ClienteB catalog or option, and a vanished file never reaches the user pool', async t => {
  const f = centralFixture(t);
  const poolB = JSON.parse(JSON.stringify(f.clientPool)); poolB.options[0].id = 'only-b';
  writeClient(f.home, 'clienteB', poolB);
  const mapped = readCatalog(f.target, f.home);
  const map = baseMap(f.commonDir); map.clients.ClienteB = { directory: 'clienteB' };
  map.repositories.push({ client: 'ClienteB', project: 'outro/app', gitCommonDir: join(f.foreign, '.git'), originSha256: sha256('x') });
  f.remapped(map);
  const a = readCatalog(f.target, f.home);
  assert.equal(a.scope, 'central:ClienteA'); assert.deepEqual(a.options.map(o => o.id), ['client-a']);
  assert.equal(a.sha256, mapped.sha256);
  const out = await f.run({ ...f.input, runtime: { optionId: 'only-b', catalogSha256: a.sha256 } });
  assert.notEqual(out.result?.state, 'awaiting-caller-delivery', JSON.stringify(out));
  assert.equal(created(f), 0);
  rmSync(join(f.clientDir, 'slp-routing.json'));
  assert.throws(() => readCatalog(f.target, f.home), ClientMapError);
});

// (g) drift between the pin and create → ROUTE_DRIFT; origin swap → block.
const driftCases = {
  'client pool edited': f => writeFileSync(join(f.clientDir, 'slp-routing.json'), JSON.stringify({ ...f.clientPool, policy: 'edited policy' })),
  'client protocol edited': f => writeFileSync(join(f.clientDir, 'workspace-protocol.md'), PROTOCOL + 'edit\n'),
  'map file edited': f => writeMap(f.home, baseMap(f.commonDir, { protectedRoots: ['/elsewhere'] })),
  'map entry project renamed': f => { const m = baseMap(f.commonDir); m.repositories[0].project = 'grupo/renamed'; writeMap(f.home, m); },
  'repository moved to another client': f => { writeClient(f.home, 'clienteB', f.clientPool); const m = baseMap(f.commonDir); m.clients = { ClienteB: { directory: 'clienteB' } }; m.repositories[0].client = 'ClienteB'; writeMap(f.home, m); },
};
for (const [name, mutate] of Object.entries(driftCases)) for (const at of ['create', 'decision']) test('drift is ROUTE_DRIFT before ' + at + ': ' + name, async t => {
  const f = centralFixture(t, { mode: 'armed', count: 2 }); f.setChoice('second');
  const drift = () => mutate(f);
  if (at === 'decision') f.setProviderHook(drift); else f.setAfterCreate(drift);
  const out = await f.run(f.input);
  assert.equal(out.result.code, 'ROUTE_DRIFT', JSON.stringify(out));
  assert.equal(f.hostCalls.some(c => c.kind === 'send'), false);
  assert.equal(Object.hasOwn(out.result, 'delivery'), false);
});
test('origin changed between pin and delivery is a block (remote identity drift)', async t => {
  const f = centralFixture(t);
  f.setAfterCreate(() => fixtureGit(f.repository, 'remote', 'set-url', 'origin', 'https://git.example.invalid/outro/repo.git'));
  const out = await f.run(f.input);
  assert.equal(out.result.code, 'CAPABILITY_GAP', JSON.stringify(out));
  assert.match(out.result.message, /remote identity drift/);
  assert.equal(Object.hasOwn(out.result, 'delivery'), false);
});
test('origin different from the map entry blocks before any effect', async t => {
  const f = centralFixture(t);
  fixtureGit(f.repository, 'remote', 'set-url', 'origin', 'https://git.example.invalid/outro/repo.git');
  const out = await f.run(f.input);
  assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP');
  assert.match(out.message ?? out.result.message, /remote identity drift/);
  assert.equal(created(f), 0);
  assert.throws(() => readCatalog(f.target, f.home), error => error instanceof ClientMapError && error.code === 'CLIENT_IDENTITY_DRIFT');
});
test('a repository without origin cannot be matched to the map and blocks', t => {
  const f = centralFixture(t);
  fixtureGit(f.repository, 'remote', 'remove', 'origin');
  assert.throws(() => readCatalog(f.target, f.home), error => error instanceof ClientMapError && error.code === 'CLIENT_IDENTITY_DRIFT');
});

// Capability: an older candidate must refuse, not read divergently.
test('a candidate without the central capability yields CAPABILITY_GAP', async t => {
  const f = centralFixture(t);
  const importModule = async spec => { const l = await import(spec); return { ...l, FORMATION_CAPABILITIES: { existingPlacement: 1, peerPresets: 2 },
    selectPeerSeat: (request, deps) => l.selectPeerSeat(request, { ...deps, decide: f.decide }) }; };
  const planner = createFormationPlanner({ runtimePath: f.candidate, daemonHome: f.home, host: () => f.host, importModule });
  Object.assign(f.deps, { plan: planner, placementCapability: planner.placementCapability, preflightPeer: planner.preflightPeer, selectPeer: planner.selectPeer });
  const out = await f.run(f.input);
  assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP', JSON.stringify(out));
  assert.match(out.message ?? out.result.message, /central client/);
  assert.equal(created(f), 0);
});
test('a central source outside the planner daemon home is refused', async t => {
  const f = centralFixture(t);
  const other = mkdtempSync(join(tmpdir(), 'slp-other-home-')); t.after(() => rmSync(other, { recursive: true, force: true }));
  const planner = createFormationPlanner({ runtimePath: f.candidate, daemonHome: realpathSync(other), host: () => f.host,
    importModule: async spec => { const l = await import(spec); return { ...l, selectPeerSeat: (request, deps) => l.selectPeerSeat(request, { ...deps, decide: f.decide }) }; } });
  Object.assign(f.deps, { plan: planner, placementCapability: planner.placementCapability, preflightPeer: planner.preflightPeer, selectPeer: planner.selectPeer });
  const out = await f.run(f.input);
  assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP', JSON.stringify(out));
  assert.equal(created(f), 0);
});

// (h) readCatalog, routes, route-choices and the task resolver share one source.
test('readCatalog, the routes CLI and the task resolver read the same central source', async t => {
  const f = centralFixture(t);
  const direct = readCatalog(f.target, f.home);
  assert.equal(direct.scope, 'central:ClienteA');
  assert.deepEqual(direct.central, { client: 'ClienteA', directory: 'clienteA', mapSha256: sha256(readFileSync(f.mapPath)) });
  assert.equal(direct.userPool, undefined);
  const routed = slp(['routes', f.target, '--paseo-home', f.home]);
  assert.equal(routed.status, 0, routed.stderr);
  const parsed = JSON.parse(routed.stdout);
  assert.equal(parsed.scope, 'central:ClienteA'); assert.equal(parsed.sha256, direct.sha256); assert.equal(parsed.central.client, 'ClienteA');
  const seat = await f.run(f.input);
  assert.equal(seat.phases.find(p => p.name === 'route-selected').value.route.catalogSha256, direct.sha256);
  // Task dispatch: the resolver sees the same catalog through the launch module.
  const modulePath = join(f.candidate, 'plugin/server/runtime/cli/launch.ts');
  const resolve = (capability) => createTaskRuntimeResolver({ runtimePath: f.candidate, daemonHome: f.home,
    host: () => ({ providers: { snapshot: async () => ({ entries: [{ provider: 'slp-codex-peer', enabled: true, status: 'ready' }] }) } }),
    importModule: async () => ({ resolveBinding, ...(capability ? { FORMATION_CAPABILITIES: { centralClients: 1 } } : {}) }) });
  const task = await resolve(true)(f.repository, { optionId: 'client-a', catalogSha256: direct.sha256 });
  assert.equal(task.routing.catalogScope, 'central:ClienteA', JSON.stringify(task));
  assert.equal(task.routing.catalogSha256, direct.sha256);
  assert.ok(task.warnings.some(w => /central:ClienteA/.test(w)));
  const old = await resolve(false)(f.repository, { optionId: 'client-a', catalogSha256: direct.sha256 });
  assert.equal(old.code, 'CAPABILITY_GAP', JSON.stringify(old));
  void modulePath;
});
test('without a map the task resolver does not require the central capability', async t => {
  const f = centralFixture(t);
  rmSync(join(f.home, 'slp-clients'), { recursive: true });
  mkdirSync(join(f.repository, '.paseo-slp'), { recursive: true });
  writeFileSync(join(f.repository, '.paseo-slp/slp-routing.json'), JSON.stringify(f.catalog));
  const sha = readCatalog(f.repository, f.home).sha256;
  const resolver = createTaskRuntimeResolver({ runtimePath: f.candidate, daemonHome: f.home,
    host: () => ({ providers: { snapshot: async () => ({ entries: [{ provider: 'slp-codex-peer', enabled: true, status: 'ready' }] }) } }),
    importModule: async () => ({ resolveBinding }) });
  const resolved = await resolver(f.repository, { optionId: 'first', catalogSha256: sha });
  assert.equal(resolved.routing.catalogScope, 'repository', JSON.stringify(resolved));
});

// Unit: strict parse.
test('parseClientMap accepts the documented shape and rejects prototype-shaped names', () => {
  const ok = { version: 1, protectedRoots: ['/work'], clients: { A: { directory: 'a' } }, repositories: [] };
  assert.equal(parseClientMap(JSON.stringify(ok)).clients.A.directory, 'a');
  assert.throws(() => parseClientMap(JSON.stringify({ ...ok, clients: { __proto__x: { directory: 'a' }, '.hidden': { directory: 'b' } } })), ClientMapError);
  assert.throws(() => parseClientMap(JSON.stringify({ ...ok, protectedRoots: ['/work/'] })), ClientMapError);
});

// clients validate (read-only, deterministic).
test('clients validate: deterministic report, exit 0 for a sound map, exit 1 for any defect', t => {
  const f = centralFixture(t);
  const first = slp(['clients', 'validate', '--paseo-home', f.home]);
  assert.equal(first.status, 0, first.stderr + first.stdout);
  const second = slp(['clients', 'validate', '--paseo-home', f.home]);
  assert.equal(second.stdout, first.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.ok, true); assert.deepEqual(report.errors, []);
  assert.equal(report.clients[0].name, 'ClienteA'); assert.equal(report.clients[0].options, 1);
  assert.equal(report.repositories[0].project, 'grupo/api');
  const before = readFileSync(f.mapPath, 'utf8');
  rmSync(join(f.clientDir, 'workspace-protocol.md'));
  const broken = slp(['clients', 'validate', '--paseo-home', f.home]);
  assert.equal(broken.status, 1); assert.equal(JSON.parse(broken.stdout).ok, false);
  assert.match(JSON.parse(broken.stdout).errors.join('\n'), /missing workspace-protocol\.md/);
  writeMap(f.home, '{nope');
  assert.equal(slp(['clients', 'validate', '--paseo-home', f.home]).status, 1);
  rmSync(join(f.home, 'slp-clients'), { recursive: true });
  const absent = slp(['clients', 'validate', '--paseo-home', f.home]);
  assert.equal(absent.status, 1); assert.match(absent.stdout, /client map is absent/);
  void before;
  assert.notEqual(slp(['clients', '--paseo-home', f.home]).status, 0);
  assert.notEqual(slp(['clients', 'other', '--paseo-home', f.home]).status, 0);
});
test('the documented example validates once its placeholders name real host paths', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slp-example-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const example = new URL('../examples/central-clients/slp-clients', import.meta.url).pathname;
  const home = join(dir, 'home'); mkdirSync(home);
  cpSync(example, join(home, 'slp-clients'), { recursive: true });
  const unfilled = slp(['clients', 'validate', '--paseo-home', home]);
  assert.equal(unfilled.status, 1, 'placeholders are host-specific and must be replaced');
  assert.match(JSON.parse(unfilled.stdout).errors.join('\n'), /does not exist on this host/);
  const root = join(dir, 'clients-root'); const repo = join(root, 'api'); committedRepository(repo);
  const mapFile = join(home, 'slp-clients/clients.json');
  writeFileSync(mapFile, readFileSync(mapFile, 'utf8').replace('/absolute/path/to/clients-root/api/.git', join(realpathSync(repo), '.git')).replace('/absolute/path/to/clients-root', realpathSync(root)));
  const result = slp(['clients', 'validate', '--paseo-home', home]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

// ---- Correction round 1 --------------------------------------------------
const swapCase = path => path.replace(/\/repo(?=\/|$)/, '/REPO');
const caseInsensitive = f => { try { return realpathSync.native(swapCase(f.repository)) === f.repository && swapCase(f.repository) !== f.repository; } catch { return false; } };
const withEnv = (patch, fn) => {
  const saved = Object.fromEntries(Object.keys(patch).map(key => [key, process.env[key]]));
  Object.assign(process.env, patch);
  try { return fn(); } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
};

// C1 — identity is file identity, not spelling.
test('C1: a mapped repository opened with different case resolves the same client (never the user pool)', t => {
  const f = centralFixture(t);
  if (!caseInsensitive(f)) return t.skip('case-sensitive volume');
  for (const path of [swapCase(f.repository), swapCase(f.target)]) {
    const catalog = readCatalog(path, f.home);
    assert.equal(catalog.scope, 'central:ClienteA', path);
  }
  const routed = slp(['routes', swapCase(f.repository), '--paseo-home', f.home]);
  assert.equal(JSON.parse(routed.stdout).scope, 'central:ClienteA');
});
test('C1: protectedRoots and map entries written in another spelling still protect and match', t => {
  const f = centralFixture(t);
  if (!caseInsensitive(f)) return t.skip('case-sensitive volume');
  const map = baseMap(swapCase(f.commonDir), { protectedRoots: [swapCase(f.repository)] });
  f.remapped(map);
  assert.equal(readCatalog(f.repository, f.home).scope, 'central:ClienteA', 'entry spelled with other case still matches');
  f.remapped(baseMap(join(f.foreign, '.git'), { protectedRoots: [swapCase(f.repository)] }));
  assert.throws(() => readCatalog(f.repository, f.home), error => error instanceof ClientMapError && error.code === 'CLIENT_UNMAPPED');
  assert.throws(() => readCatalog(swapCase(f.repository), f.home), error => error instanceof ClientMapError && error.code === 'CLIENT_UNMAPPED');
});
test('C1: a protected root or entry reached through a symlink still matches by file identity', t => {
  const f = centralFixture(t);
  const link = join(f.dir, 'link-to-repo'); symlinkSync(f.repository, link);
  f.remapped(baseMap(join(link, '.git')));
  assert.equal(readCatalog(f.repository, f.home).scope, 'central:ClienteA');
  f.remapped(baseMap(join(f.foreign, '.git'), { protectedRoots: [link] }));
  assert.throws(() => readCatalog(f.repository, f.home), error => error instanceof ClientMapError && error.code === 'CLIENT_UNMAPPED');
});
test('C1: two entries naming one common-dir by different spellings are ambiguous and block', t => {
  const f = centralFixture(t);
  const link = join(f.dir, 'link-to-repo'); symlinkSync(f.repository, link);
  writeClient(f.home, 'clienteB', f.clientPool);
  const map = baseMap(f.commonDir); map.clients.ClienteB = { directory: 'clienteB' };
  map.repositories.push({ ...map.repositories[0], client: 'ClienteB', gitCommonDir: join(link, '.git') });
  f.remapped(map);
  assert.throws(() => readCatalog(f.repository, f.home), /same Git common-dir/);
  const validated = slp(['clients', 'validate', '--paseo-home', f.home]);
  assert.equal(validated.status, 1); assert.match(validated.stdout, /name the same Git common-dir/);
});
test('C1: task deliver and placement honor the same identity (symlinked entry)', async t => {
  const f = centralFixture(t);
  const link = join(f.dir, 'link-to-repo'); symlinkSync(f.repository, link);
  f.remapped(baseMap(join(link, '.git')));
  const seat = await f.run(f.input);
  assert.equal(seat.phases.find(p => p.name === 'route-selected').value.source.central.client, 'ClienteA', JSON.stringify(seat));
  const resolver = createTaskRuntimeResolver({ runtimePath: f.candidate, daemonHome: f.home,
    host: () => ({ providers: { snapshot: async () => ({ entries: [{ provider: 'slp-codex-peer', enabled: true, status: 'ready' }] }) } }),
    importModule: async () => ({ resolveBinding, FORMATION_CAPABILITIES: { centralClients: 1 } }) });
  const task = await resolver(f.repository, { optionId: 'client-a', catalogSha256: readCatalog(f.repository, f.home).sha256 });
  assert.equal(task.routing.catalogScope, 'central:ClienteA', JSON.stringify(task));
  const old = createTaskRuntimeResolver({ runtimePath: f.candidate, daemonHome: f.home, host: () => ({ providers: { snapshot: async () => ({ entries: [] }) } }),
    importModule: async () => ({ resolveBinding }) });
  assert.equal((await old(f.repository, { optionId: 'client-a', catalogSha256: 'x' })).code, 'CAPABILITY_GAP');
});
test('C1: placement with a differently spelled protected root blocks instead of using the user pool', async t => {
  const f = centralFixture(t);
  if (!caseInsensitive(f)) return t.skip('case-sensitive volume');
  f.remapped(baseMap(join(f.foreign, '.git'), { protectedRoots: [swapCase(f.repository)] }));
  f.row.createCwd = f.repository; f.row.workspaceId = 'caller';
  const out = await f.run(f.input);
  assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP', JSON.stringify(out));
  assert.equal(created(f), 0);
});

// C2 — clients validate is the operational guard for host-specific paths.
test('C2: validate fails for a missing or non-canonical gitCommonDir and protectedRoot', t => {
  const f = centralFixture(t);
  const check = map => { f.remapped(map); return slp(['clients', 'validate', '--paseo-home', f.home]); };
  assert.equal(check(baseMap(f.commonDir)).status, 0);
  const missing = check(baseMap(join(f.dir, 'nowhere/.git')));
  assert.equal(missing.status, 1); assert.match(JSON.parse(missing.stdout).errors.join('\n'), /repositories\[0\]\.gitCommonDir does not exist on this host/);
  const link = join(f.dir, 'link-to-repo'); symlinkSync(f.repository, link);
  const viaLink = check(baseMap(join(link, '.git')));
  assert.equal(viaLink.status, 1); assert.match(JSON.parse(viaLink.stdout).errors.join('\n'), /gitCommonDir is not canonical/);
  const rootMissing = check(baseMap(f.commonDir, { protectedRoots: [join(f.dir, 'no-root')] }));
  assert.equal(rootMissing.status, 1); assert.match(JSON.parse(rootMissing.stdout).errors.join('\n'), /protectedRoots\[0\] does not exist/);
  const rootLink = check(baseMap(f.commonDir, { protectedRoots: [link] }));
  assert.equal(rootLink.status, 1); assert.match(JSON.parse(rootLink.stdout).errors.join('\n'), /protectedRoots\[0\] is not canonical/);
  assert.equal(check(baseMap(f.commonDir, { protectedRoots: [realpathSync(f.dir)] })).status, 0);
  if (caseInsensitive(f)) assert.match(check(baseMap(swapCase(f.commonDir))).stdout, /is not canonical/);
});

// C3 — unobservable Git identity blocks (with a map); a proven non-Git directory does not.
const fakeGit = (dir, stderr) => {
  mkdirSync(join(dir, 'bin'), { recursive: true });
  writeFileSync(join(dir, 'bin/git'), `#!/bin/sh\necho "${stderr}" >&2\nexit 128\n`, { mode: 0o755 });
  return join(dir, 'bin');
};
for (const [name, patch] of Object.entries({
  'git missing from PATH': () => ({ PATH: '/nonexistent' }),
  'dubious ownership refusal': f => ({ PATH: fakeGit(join(f.dir, 'fake1'), 'fatal: detected dubious ownership in repository at x') }),
  'unexpected git failure': f => ({ PATH: fakeGit(join(f.dir, 'fake2'), 'fatal: something else broke') }),
})) test('C3: map present + ' + name + ' blocks readCatalog (mapped and unmapped, protected or not)', t => {
  const f = centralFixture(t);
  withEnv(patch(f), () => {
    for (const repo of [f.repository, f.target]) assert.throws(() => readCatalog(repo, f.home), error => error instanceof ClientMapError && error.code === 'CLIENT_UNMAPPED' && /cannot be observed/.test(error.message), repo);
  });
  f.remapped(baseMap(join(f.foreign, '.git')));
  withEnv(patch(f), () => assert.throws(() => readCatalog(f.repository, f.home), /cannot be observed/));
  assert.equal(readCatalog(f.repository, f.home).scope, 'user', 'healthy git + unmapped keeps the historical path');
});
test('C3: without a map git trouble changes nothing; a proven non-Git directory with a map keeps the historical path', t => {
  const f = centralFixture(t);
  const plain = join(f.dir, 'plain'); mkdirSync(join(plain, '.paseo-slp'), { recursive: true });
  const outside = join(f.dir, 'outside-git'); mkdirSync(outside);
  writeFileSync(join(plain, '.paseo-slp/slp-routing.json'), JSON.stringify(f.catalog));
  assert.equal(readCatalog(outside, f.home).scope, 'user', 'proven non-Git (Git said so) + map: historical user pool');
  f.remapped(baseMap(f.commonDir, { protectedRoots: [realpathSync(f.dir)] }));
  assert.throws(() => readCatalog(outside, f.home), error => error instanceof ClientMapError && error.code === 'CLIENT_UNMAPPED' && /not a Git checkout/.test(error.message));
  rmSync(join(f.home, 'slp-clients'), { recursive: true });
  withEnv({ PATH: '/nonexistent' }, () => assert.equal(readCatalog(f.repository, f.home).scope, 'user'));
  withEnv({ PATH: fakeGit(join(f.dir, 'fake3'), 'fatal: not a git repository (or any of the parent directories): .git') }, () => {
    f.remapped(baseMap(f.commonDir)); assert.equal(readCatalog(outside, f.home).scope, 'user');
  });
});
test('C3: unobservable Git identity blocks the seat formation and the task resolver', async t => {
  const f = centralFixture(t);
  f.remapped(baseMap(f.commonDir));
  const resolver = createTaskRuntimeResolver({ runtimePath: f.candidate, daemonHome: f.home,
    host: () => ({ providers: { snapshot: async () => ({ entries: [{ provider: 'slp-codex-peer', enabled: true, status: 'ready' }] }) } }),
    importModule: async () => ({ resolveBinding, FORMATION_CAPABILITIES: { centralClients: 1 } }) });
  const outcome = await withEnv({ PATH: '/nonexistent' }, () => resolver(f.repository, { optionId: 'client-a', catalogSha256: 'x' }));
  assert.ok(outcome.code === 'INVALID_RECORD' || outcome.code === 'CAPABILITY_GAP', JSON.stringify(outcome));
  assert.match(outcome.message, /cannot be observed|Peer runtime could not be resolved/);
  assert.equal(outcome.provider, undefined);
});

// H1 — the real desk-bridge wiring: no paseoHome dependency, PASEO_HOME decides.
test('H1: placement without an explicit paseoHome resolves PASEO_HOME and seats the central client', async t => {
  const f = centralFixture(t, { placementHome: 'env' });
  const out = await f.run({ ...f.input, placement: { kind: 'caller' } });
  assert.equal(out.result.state, 'awaiting-caller-delivery', JSON.stringify(out));
  assert.equal(out.phases.find(p => p.name === 'target-observed').value.source.central.client, 'ClienteA');
  assert.equal(out.phases.find(p => p.name === 'route-selected').value.source.scope, 'central:ClienteA');
});
for (const placement of [undefined, { kind: 'caller' }, { kind: 'existing', workspaceId: 'target', reason: 'lane' }])
  test('H1: a placement home different from the planner home is refused before any provider call: ' + (placement?.kind ?? 'omitted'), async t => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), 'slp-other-placement-home-'))); t.after(() => rmSync(other, { recursive: true, force: true }));
    const f = centralFixture(t, { placementHome: other });
    // the placement's home carries the map and the client; the planner's home (f.home) is a different one
    mkdirSync(join(other, 'slp-runtime/state'), { recursive: true });
    rmSync(join(other, 'slp-clients'), { recursive: true, force: true });
    cpSync(join(f.home, 'slp-clients'), join(other, 'slp-clients'), { recursive: true });
    const out = await f.run({ ...f.input, ...(placement ? { placement } : {}) });
    assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP', JSON.stringify(out));
    assert.match(out.message ?? out.result.message, /outside this daemon home/);
    assert.equal(created(f), 0);
    assert.equal(f.hostCalls.filter(c => c.kind === 'providers').length, 0, 'guard applies in preflight, before provider observation');
    assert.equal(out.phases?.length ?? 0, 0, 'refused in preflight: no placement/selection phase was recorded');
  });
test('H1: the receipt always carries central provenance — a pool read from elsewhere is refused', async t => {
  const f = centralFixture(t);
  const importModule = async spec => { const l = await import(spec); return { ...l,
    selectPeerSeat: async (request, deps) => { const selected = await l.selectPeerSeat(request, { ...deps, decide: f.decide });
      return { ...selected, source: { ...selected.source, scope: 'repository', central: undefined } }; } }; };
  const planner = createFormationPlanner({ runtimePath: f.candidate, daemonHome: f.home, host: () => f.host, importModule });
  Object.assign(f.deps, { plan: planner, placementCapability: planner.placementCapability, preflightPeer: planner.preflightPeer, selectPeer: planner.selectPeer });
  const out = await f.run(f.input);
  assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP', JSON.stringify(out));
  assert.match(out.message ?? out.result.message, /was not the source of the selected pool/);
  assert.equal(created(f), 0);
});

// H2a — duplicate keys at any depth.
const duplicateCases = {
  'top-level key': ({ commonDir }) => JSON.stringify(baseMap(commonDir)).replace('"version":1', '"version":1,"version":1'),
  'client name': () => '{"version":1,"protectedRoots":[],"clients":{"A":{"directory":"a"},"A":{"directory":"b"}},"repositories":[]}',
  'client field': () => '{"version":1,"protectedRoots":[],"clients":{"A":{"directory":"a","directory":"b"}},"repositories":[]}',
  'repository field': ({ commonDir }) => JSON.stringify(baseMap(commonDir)).replace('"project":"grupo/api"', '"project":"grupo/api","project":"outro"'),
  'escaped spelling of one key': () => '{"version":1,"\\u0076ersion":1,"protectedRoots":[],"clients":{},"repositories":[]}',
};
for (const [name, build] of Object.entries(duplicateCases)) test('H2a: duplicate key blocks (' + name + ')', t => {
  const f = centralFixture(t);
  f.remapped(build(f));
  assert.throws(() => readCatalog(f.target, f.home), error => error instanceof ClientMapError && error.code === 'CLIENT_MAP_INVALID' && /duplicate key/.test(error.message));
  assert.equal(slp(['clients', 'validate', '--paseo-home', f.home]).status, 1);
});
test('H2a: keys that merely repeat in different objects are fine', () => {
  const ok = '{"version":1,"protectedRoots":[],"clients":{"A":{"directory":"a"},"B":{"directory":"b"}},"repositories":[]}';
  assert.equal(parseClientMap(ok).clients.B.directory, 'b');
});
