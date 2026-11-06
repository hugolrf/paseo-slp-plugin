// Server side of the "Clientes" screen: reads, validation parity with the CLI,
// CAS + confirm + audited writes, path safety, isolation, diagnosis, and the
// structural proof (S1) that no agent-facing surface can reach the writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { createClientsStore } from '../plugin/server/clients-store.ts';
import { validateClients, parseClientMap } from '../plugin/server/runtime/cli/clients.ts';
import { validateCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { makeHome, targetOf } from './helpers/plugin-doubles.mjs';
import { fixtureGit, committedRepository } from './helpers/formation-placement-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const cli = new URL('../bin/slp.mjs', import.meta.url).pathname;
const root = new URL('..', import.meta.url).pathname;
const URL_WITH_TOKEN = 'https://oauth2:SECRET-TOKEN-123@git.example.invalid/grupo/api.git';
const pool = (id = 'client-a', notes = 'pool of ClienteA') => ({ version: 1, policy: 'Fixture pool', quotaFallback: { enabled: false, optionId: null },
  options: [{ id, provider: 'codex', roles: ['peer'], model: 'model/variant', enabled: true, availability: 'ready', suitableFor: ['coding'], avoidFor: [], notes }] });
const PROTOCOL = '---\nagent_mode: full-access\n---\nProtocolo.\n';

function fixture(t) {
  const home = realpathSync(makeHome(t));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slp-clients-ui-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'work/api'); const commonDir = committedRepository(repo);
  fixtureGit(repo, 'remote', 'add', 'origin', URL_WITH_TOKEN);
  const other = join(dir, 'work/other'); const otherCommon = committedRepository(other);
  fixtureGit(other, 'remote', 'add', 'origin', 'https://git.example.invalid/outro/app.git');
  let tick = 0;
  const store = createClientsStore({ now: () => new Date(Date.UTC(2026, 10, 6, 12, 0, tick++)) });
  const target = targetOf(home);
  const call = (name, extra) => store[name]({ schemaVersion: 1, target, ...extra });
  const clientsDir = join(home, 'slp-clients');
  const mapPath = join(clientsDir, 'clients.json');
  const map = (...repos) => ({ version: 1, protectedRoots: [], clients: { ClienteA: { directory: 'clienteA' }, ClienteB: { directory: 'clienteB' } }, repositories: repos });
  const entry = (client, project, gitCommonDir, url) => ({ client, project, gitCommonDir, originSha256: sha(url) });
  const save = async (draft, expected = null) => {
    const v = await call('validateClientsDraft', { draft: { kind: 'map', map: draft } });
    assert.equal(v.ok, true, JSON.stringify(v));
    return call('setClients', { map: draft, expectedSha256: expected, confirm: v.confirm });
  };
  const savePool = async (client, p, expected = null) => {
    const v = await call('validateClientsDraft', { draft: { kind: 'pool', client, pool: p } });
    assert.equal(v.ok, true, JSON.stringify(v));
    return call('setClientPool', { client, pool: p, expectedSha256: expected, confirm: v.confirm });
  };
  const saveProtocol = async (client, text, expected = null) => {
    const v = await call('validateClientsDraft', { draft: { kind: 'protocol', client, text } });
    assert.equal(v.ok, true, JSON.stringify(v));
    return call('setClientProtocol', { client, text, expectedSha256: expected, confirm: v.confirm });
  };
  return { home, dir, repo, commonDir, other, otherCommon, store, target, call, clientsDir, mapPath, map, entry, save, savePool, saveProtocol,
    audit: () => existsSync(join(clientsDir, 'audit.log')) ? readFileSync(join(clientsDir, 'audit.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
}
const conflict = async (promise, code) => assert.rejects(promise, error => { assert.equal(error.code, code, error.message); return true; });

test('U1/S3: nothing exists until the Human saves; the first save creates the map and audits it', async t => {
  const f = fixture(t);
  const absent = await f.call('getClients', {});
  assert.deepEqual([absent.mapState, absent.mapSha256, absent.map, absent.clients], ['absent', null, null, []]);
  assert.equal(existsSync(f.clientsDir), false, 'reading creates nothing');
  const saved = await f.save(f.map());
  assert.equal(existsSync(f.mapPath), true);
  const view = await f.call('getClients', {});
  assert.equal(view.mapState, 'valid'); assert.equal(view.mapSha256, saved.sha256); assert.equal(view.mapSha256, sha(readFileSync(f.mapPath)));
  const [line] = f.audit();
  assert.deepEqual(Object.keys(line).sort(), ['action', 'actor', 'after', 'at', 'before', 'file', 'hostId']);
  assert.deepEqual([line.action, line.file, line.before, line.after, line.hostId], ['set-clients', 'clients.json', null, saved.sha256, 'test-host']);
});

test('U2: identifyRepository fills the canonical common-dir and origin hash and never returns the URL or credentials', async t => {
  const f = fixture(t);
  const identity = await f.call('identifyRepository', { path: f.repo });
  assert.equal(identity.gitCommonDir, f.commonDir); assert.equal(identity.originSha256, sha(URL_WITH_TOKEN));
  assert.equal(identity.projectSuggestion, 'grupo/api'); assert.equal(identity.linked, false); assert.equal(identity.mappedClient, null);
  assert.equal(JSON.stringify(identity).includes('SECRET-TOKEN'), false);
  const worktree = join(f.dir, 'work/api-wt'); fixtureGit(f.repo, 'worktree', 'add', '--detach', worktree, 'HEAD');
  const linked = await f.call('identifyRepository', { path: worktree });
  assert.equal(linked.gitCommonDir, f.commonDir); assert.equal(linked.linked, true);
  await f.save(f.map(f.entry('ClienteA', identity.projectSuggestion, identity.gitCommonDir, URL_WITH_TOKEN)));
  assert.equal((await f.call('identifyRepository', { path: worktree })).mappedClient, 'ClienteA');
  await conflict(f.call('identifyRepository', { path: f.dir }), 'INVALID_REQUEST');
  const noOrigin = join(f.dir, 'work/no-origin'); committedRepository(noOrigin);
  await conflict(f.call('identifyRepository', { path: noOrigin }), 'INVALID_REQUEST');
});

test('U4: draft validation is the CLI validation — same messages for the same map', async t => {
  const f = fixture(t);
  const bad = f.map(f.entry('ClienteA', 'p', join(f.dir, 'nowhere/.git'), 'x'), f.entry('ClienteA', 'q', f.commonDir, URL_WITH_TOKEN));
  bad.protectedRoots = [join(f.dir, 'no-root')];
  const draft = await f.call('validateClientsDraft', { draft: { kind: 'map', map: bad } });
  assert.equal(draft.ok, false); assert.equal(draft.confirm, null);
  mkdirSync(f.clientsDir, { recursive: true });
  writeFileSync(f.mapPath, JSON.stringify(bad));
  const cliErrors = validateClients(f.home, parsed => validateCatalog(parsed)).errors.filter(e => /does not exist|not canonical|same Git/.test(e));
  assert.deepEqual(draft.errors.filter(e => /does not exist|not canonical|same Git/.test(e)).sort(), cliErrors.sort());
  assert.ok(cliErrors.length >= 2);
  // structural defects use the CLI parser's text verbatim
  for (const broken of [{ ...f.map(), version: 2 }, { ...f.map(), extra: 1 }, { ...f.map(), clients: { A: { directory: '../x' } } }]) {
    let expected; try { parseClientMap(JSON.stringify(broken)); } catch (error) { expected = error.message; }
    const result = await f.call('validateClientsDraft', { draft: { kind: 'map', map: broken } });
    assert.deepEqual(result.errors, [expected]);
  }
  // an invalid map already on disk is shown with the same error and can be replaced under CAS
  writeFileSync(f.mapPath, '{"version":1,');
  const view = await f.call('getClients', {});
  assert.equal(view.mapState, 'invalid'); assert.match(view.mapError, /not valid JSON/); assert.equal(view.mapSha256, sha('{"version":1,'));
  await f.save(f.map(), view.mapSha256);
  assert.equal((await f.call('getClients', {})).mapState, 'valid');
});

test('U4: saving an invalid map is refused by the server whatever the screen sent', async t => {
  const f = fixture(t);
  const good = f.map(f.entry('ClienteA', 'p', f.commonDir, URL_WITH_TOKEN));
  const ok = await f.call('validateClientsDraft', { draft: { kind: 'map', map: good } });
  const dup = { ...good, repositories: [good.repositories[0], { ...good.repositories[0], client: 'ClienteB' }] };
  await conflict(f.call('setClients', { map: dup, expectedSha256: null, confirm: ok.confirm }), 'INVALID_REQUEST');
  const missing = { ...good, repositories: [{ ...good.repositories[0], gitCommonDir: join(f.dir, 'nowhere/.git') }] };
  await conflict(f.call('setClients', { map: missing, expectedSha256: null, confirm: sha('whatever') }), 'INVALID_REQUEST');
  assert.equal(existsSync(f.clientsDir), false, 'no directory is created by a refused save');
});

test('confirm: the save must echo the hash of the validated bytes', async t => {
  const f = fixture(t);
  const good = f.map(f.entry('ClienteA', 'p', f.commonDir, URL_WITH_TOKEN));
  const ok = await f.call('validateClientsDraft', { draft: { kind: 'map', map: good } });
  await conflict(f.call('setClients', { map: good, expectedSha256: null, confirm: sha('other draft') }), 'INVALID_REQUEST');
  const edited = { ...good, repositories: [{ ...good.repositories[0], project: 'edited-after-review' }] };
  await conflict(f.call('setClients', { map: edited, expectedSha256: null, confirm: ok.confirm }), 'INVALID_REQUEST');
  assert.equal(existsSync(f.mapPath), false);
  await f.call('setClients', { map: good, expectedSha256: null, confirm: ok.confirm });
  assert.equal(existsSync(f.mapPath), true);
});

test('CAS: a stale map hash is refused and nothing changes (draft stays with the caller)', async t => {
  const f = fixture(t);
  const first = await f.save(f.map(f.entry('ClienteA', 'p', f.commonDir, URL_WITH_TOKEN)));
  const next = f.map(f.entry('ClienteA', 'renamed', f.commonDir, URL_WITH_TOKEN));
  const ok = await f.call('validateClientsDraft', { draft: { kind: 'map', map: next } });
  await conflict(f.call('setClients', { map: next, expectedSha256: null, confirm: ok.confirm }), 'IDEMPOTENCY_CONFLICT');
  await conflict(f.call('setClients', { map: next, expectedSha256: sha('stale'), confirm: ok.confirm }), 'IDEMPOTENCY_CONFLICT');
  assert.equal(sha(readFileSync(f.mapPath)), first.sha256);
  assert.equal(f.audit().length, 1, 'refused saves are not audited as writes');
  await f.call('setClients', { map: next, expectedSha256: first.sha256, confirm: ok.confirm });
  assert.equal(f.audit().length, 2);
});

test('U3/isolation: pool and protocol writes need a declared client, CAS and confirm; client A never touches B', async t => {
  const f = fixture(t);
  await f.save(f.map(f.entry('ClienteA', 'p', f.commonDir, URL_WITH_TOKEN)));
  await f.savePool('ClienteB', pool('only-b', 'pool of ClienteB')); await f.saveProtocol('ClienteB', 'B protocol\n');
  const bPool = readFileSync(join(f.clientsDir, 'clients/clienteB/.paseo-slp/slp-routing.json'));
  const bProtocol = readFileSync(join(f.clientsDir, 'clients/clienteB/.paseo-slp/workspace-protocol.md'));
  const a1 = await f.savePool('ClienteA', pool()); const p1 = await f.saveProtocol('ClienteA', PROTOCOL);
  assert.equal(readFileSync(join(f.clientsDir, 'clients/clienteB/.paseo-slp/slp-routing.json')).equals(bPool), true);
  assert.equal(readFileSync(join(f.clientsDir, 'clients/clienteB/.paseo-slp/workspace-protocol.md')).equals(bProtocol), true);
  const files = await f.call('getClientFiles', { client: 'ClienteA' });
  assert.equal(files.pool.pool.options[0].id, 'client-a'); assert.equal(files.pool.sha256, a1.sha256); assert.equal(files.protocol.text, PROTOCOL); assert.equal(files.protocol.sha256, p1.sha256);
  const next = pool('client-a', 'edited notes');
  const v = await f.call('validateClientsDraft', { draft: { kind: 'pool', client: 'ClienteA', pool: next } });
  await conflict(f.call('setClientPool', { client: 'ClienteA', pool: next, expectedSha256: sha('stale'), confirm: v.confirm }), 'IDEMPOTENCY_CONFLICT');
  await conflict(f.call('setClientPool', { client: 'ClienteA', pool: next, expectedSha256: a1.sha256, confirm: sha('x') }), 'INVALID_REQUEST');
  await conflict(f.call('setClientPool', { client: 'Ghost', pool: next, expectedSha256: null, confirm: v.confirm }), 'INVALID_REQUEST');
  await conflict(f.call('getClientFiles', { client: 'Ghost' }), 'INVALID_REQUEST');
  await f.call('setClientPool', { client: 'ClienteA', pool: next, expectedSha256: a1.sha256, confirm: v.confirm });
  assert.equal(readFileSync(join(f.clientsDir, 'clients/clienteB/.paseo-slp/slp-routing.json')).equals(bPool), true);
  const view = await f.call('getClients', {});
  assert.deepEqual(view.clients.map(c => [c.name, c.options, c.error]), [['ClienteA', 1, null], ['ClienteB', 1, null]]);
  // the readers the CLI and seat formation use see the saved client pool
  const v2 = validateClients(f.home, parsed => validateCatalog(parsed));
  assert.equal(v2.ok, true, JSON.stringify(v2));
  assert.equal(v2.clients.find(c => c.name === 'ClienteA').routingSha256, sha(readFileSync(join(f.clientsDir, 'clients/clienteA/.paseo-slp/slp-routing.json'))));
});

test('(c) changes made outside the screen are flagged against the last audited hash', async t => {
  const f = fixture(t);
  const saved = await f.save(f.map(f.entry('ClienteA', 'p', f.commonDir, URL_WITH_TOKEN)));
  await f.savePool('ClienteA', pool()); await f.saveProtocol('ClienteA', PROTOCOL);
  let view = await f.call('getClients', {});
  assert.equal(view.mapExternalChange, false); assert.deepEqual(view.clients.map(c => c.externalChange), [false, false]);
  writeFileSync(join(f.clientsDir, 'clients/clienteA/.paseo-slp/workspace-protocol.md'), 'edited by hand\n');
  view = await f.call('getClients', {});
  assert.equal(view.clients.find(c => c.name === 'ClienteA').externalChange, true);
  assert.equal(view.mapExternalChange, false);
  writeFileSync(f.mapPath, readFileSync(f.mapPath, 'utf8') + '\n');
  assert.equal((await f.call('getClients', {})).mapExternalChange, true);
  assert.notEqual(saved.sha256, (await f.call('getClients', {})).mapSha256);
});

test('path safety: writes stay under slp-clients, create only validated directories and never follow a symlink', async t => {
  for (const [name, arrange, expectMessage] of [
    ['slp-clients is a symlink', f => { mkdirSync(join(f.dir, 'elsewhere')); symlinkSync(join(f.dir, 'elsewhere'), f.clientsDir); }, /real directory/],
    ['clients.json is a symlink', f => { mkdirSync(f.clientsDir); writeFileSync(join(f.dir, 'target.json'), '{}'); symlinkSync(join(f.dir, 'target.json'), f.mapPath); }, /regular file|symbolic link|not readable/],
  ]) {
    const f = fixture(t); arrange(f);
    const v = await f.call('validateClientsDraft', { draft: { kind: 'map', map: f.map() } });
    await assert.rejects(f.call('setClients', { map: f.map(), expectedSha256: null, confirm: v.confirm }), expectMessage, name);
    assert.equal(existsSync(join(f.dir, 'elsewhere/clients.json')), false, name);
  }
  const f = fixture(t); await f.save(f.map());
  // a client directory that is a symlink, then a .paseo-slp symlink, then a leaf symlink
  mkdirSync(join(f.clientsDir, 'clients')); mkdirSync(join(f.dir, 'evil'));
  symlinkSync(join(f.dir, 'evil'), join(f.clientsDir, 'clients/clienteA'));
  await assert.rejects(f.savePool('ClienteA', pool()), /real directory|symbolic link/);
  assert.deepEqual(readdirSync(join(f.dir, 'evil')), []);
  rmSync(join(f.clientsDir, 'clients/clienteA'));
  mkdirSync(join(f.clientsDir, 'clients/clienteA')); symlinkSync(join(f.dir, 'evil'), join(f.clientsDir, 'clients/clienteA/.paseo-slp'));
  await assert.rejects(f.savePool('ClienteA', pool()), /real directory|symbolic link/);
  rmSync(join(f.clientsDir, 'clients/clienteA/.paseo-slp'));
  mkdirSync(join(f.clientsDir, 'clients/clienteA/.paseo-slp'));
  writeFileSync(join(f.dir, 'evil/pool.json'), 'untouched'); symlinkSync(join(f.dir, 'evil/pool.json'), join(f.clientsDir, 'clients/clienteA/.paseo-slp/slp-routing.json'));
  await assert.rejects(f.savePool('ClienteA', pool(), null), /symbolic|regular|not readable/);
  assert.equal(readFileSync(join(f.dir, 'evil/pool.json'), 'utf8'), 'untouched');
});

test('audit: who/when/file/hash only — never content or secrets — append-only, and an unwritable audit aborts the save', async t => {
  const f = fixture(t);
  await f.save(f.map(f.entry('ClienteA', 'p', f.commonDir, URL_WITH_TOKEN)));
  const secret = 'API_TOKEN=SECRET-ZZZ-9999';
  const p1 = await f.savePool('ClienteA', pool('client-a', secret)); const pr = await f.saveProtocol('ClienteA', `${PROTOCOL}${secret}\n`);
  const raw = readFileSync(join(f.clientsDir, 'audit.log'), 'utf8');
  assert.equal(raw.includes('SECRET'), false); assert.equal(raw.includes('Protocolo'), false); assert.equal(raw.includes('ClienteA'), false);
  const lines = f.audit();
  assert.deepEqual(lines.map(l => l.action), ['set-clients', 'set-client-pool', 'set-client-protocol']);
  assert.deepEqual(lines.slice(1).map(l => l.file), ['clients/clienteA/.paseo-slp/slp-routing.json', 'clients/clienteA/.paseo-slp/workspace-protocol.md']);
  assert.deepEqual([lines[1].before, lines[1].after, lines[2].before, lines[2].after], [null, p1.sha256, null, pr.sha256]);
  assert.equal(new Set(lines.map(l => l.at)).size, 3);
  // the audit file never enters the map: validation and the map hash ignore it
  assert.equal(validateClients(f.home, parsed => validateCatalog(parsed)).errors.some(e => /audit/.test(e)), false);
  // symlinked audit log: the write is refused and the target file is untouched
  const before = readFileSync(join(f.clientsDir, 'clients/clienteA/.paseo-slp/workspace-protocol.md'));
  rmSync(join(f.clientsDir, 'audit.log')); writeFileSync(join(f.dir, 'audit-elsewhere'), ''); symlinkSync(join(f.dir, 'audit-elsewhere'), join(f.clientsDir, 'audit.log'));
  await assert.rejects(f.saveProtocol('ClienteA', 'new text\n', pr.sha256), /audit log/);
  assert.equal(readFileSync(join(f.clientsDir, 'clients/clienteA/.paseo-slp/workspace-protocol.md')).equals(before), true);
  assert.equal(readFileSync(join(f.dir, 'audit-elsewhere'), 'utf8'), '');
  assert.deepEqual(readdirSync(join(f.clientsDir, 'clients/clienteA/.paseo-slp')).filter(n => n.endsWith('.tmp')), []);
});

test('U6: the preview names the clients whose in-flight seats drift and whether the map hash changes', async t => {
  const f = fixture(t);
  const base = f.map(f.entry('ClienteA', 'p', f.commonDir, URL_WITH_TOKEN), f.entry('ClienteB', 'o', f.otherCommon, 'https://git.example.invalid/outro/app.git'));
  await f.save(base);
  const renamed = { ...base, repositories: [{ ...base.repositories[0], project: 'renamed' }, base.repositories[1]] };
  const preview = await f.call('validateClientsDraft', { draft: { kind: 'map', map: renamed } });
  assert.deepEqual([preview.ok, preview.affectedClients, preview.mapHashChanges], [true, ['ClienteA'], true]);
  const same = await f.call('validateClientsDraft', { draft: { kind: 'map', map: base } });
  assert.deepEqual([same.affectedClients, same.mapHashChanges], [[], false]);
  const roots = await f.call('validateClientsDraft', { draft: { kind: 'map', map: { ...base, protectedRoots: [realpathSync(f.dir)] } } });
  assert.deepEqual(roots.affectedClients, ['ClienteA', 'ClienteB']);
  const pools = await f.call('validateClientsDraft', { draft: { kind: 'pool', client: 'ClienteB', pool: pool('x') } });
  assert.deepEqual([pools.affectedClients, pools.mapHashChanges], [['ClienteB'], false]);
  // a client without files is a warning (its repositories block), not an error
  assert.ok(preview.warnings.some(w => /ClienteA has no/.test(w)));
});

test('U5: explainResolution reuses the resolver — scope and formation label match readCatalog and seat formation', async t => {
  const f = fixture(t);
  const worktree = join(f.dir, 'work/api-wt'); fixtureGit(f.repo, 'worktree', 'add', '--detach', worktree, 'HEAD');
  const user = pool('user-only'); mkdirSync(join(f.home, 'slp-runtime/state'), { recursive: true }); writeFileSync(join(f.home, 'slp-runtime/state/peer-pool.json'), JSON.stringify(user));
  const explain = path => f.call('explainResolution', { path });
  let r = await explain(worktree);
  assert.deepEqual([r.decidedBy, r.formation, r.catalogScope], ['none', 'gap', 'user']);
  r = await explain(f.repo); assert.deepEqual([r.decidedBy, r.formation, r.catalogScope], ['none', 'user-pool', 'user']);
  await f.save(f.map(f.entry('ClienteA', 'p', f.commonDir, URL_WITH_TOKEN))); await f.savePool('ClienteA', pool()); await f.saveProtocol('ClienteA', PROTOCOL);
  for (const path of [f.repo, worktree]) {
    r = await explain(path);
    assert.deepEqual([r.decidedBy, r.formation, r.catalogScope, r.client, r.code], ['central', 'central', 'central:ClienteA', 'ClienteA', null], path);
  }
  r = await explain(join(f.clientsDir, 'clients/clienteA')); assert.deepEqual([r.decidedBy, r.client], ['client-directory', 'ClienteA']);
  mkdirSync(join(f.repo, '.paseo-slp')); writeFileSync(join(f.repo, '.paseo-slp/slp-routing.json'), JSON.stringify(pool('local-only')));
  r = await explain(f.repo); assert.deepEqual([r.decidedBy, r.formation, r.catalogScope], ['local', 'local', 'repository']);
  r = await explain(worktree); assert.deepEqual([r.decidedBy, r.formation], ['main', 'main'], 'main checkout configuration wins over the map');
  rmSync(join(f.repo, '.paseo-slp'), { recursive: true });
  await f.save({ ...f.map(), protectedRoots: [realpathSync(join(f.dir, 'work'))] }, (await f.call('getClients', {})).mapSha256);
  r = await explain(f.other);
  assert.deepEqual([r.decidedBy, r.formation, r.code, r.catalogScope], ['blocked', 'blocked', 'CLIENT_UNMAPPED', null]);
  assert.match(r.reason, /no client mapping/);
  await conflict(f.call('explainResolution', { path: join(f.dir, 'missing') }), 'INVALID_REQUEST');
});

// ---------------------------------------------------------------------------
// S1 — structural proof that no agent-facing surface reaches the writes. Sources
// and registries are enumerated from the real files, never from a copied list.
// ---------------------------------------------------------------------------
const importsOf = file => {
  const text = readFileSync(file, 'utf8');
  const info = ts.preProcessFile(text, true, true);
  return info.importedFiles.map(i => i.fileName).filter(name => name.startsWith('.')).map(name => resolve(dirname(file), name));
};
const closure = entry => {
  const seen = new Set(), queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    const real = [file, `${file}.ts`, `${file}.mjs`].find(candidate => existsSync(candidate) && lstatSync(candidate).isFile());
    if (!real || seen.has(real)) continue;
    seen.add(real);
    if (/\.(ts|tsx|mjs)$/.test(real)) queue.push(...importsOf(real));
  }
  return seen;
};
const rel = set => [...set].map(file => file.slice(root.length));

test('S1(1): the Desk MCP tool catalog and its whole static import graph exclude every client write', async () => {
  const { DESK_TOOL_CATALOG } = await import('../plugin/server/desk-bridge.ts');
  assert.ok(DESK_TOOL_CATALOG.length > 5);
  assert.deepEqual(DESK_TOOL_CATALOG.map(tool => tool.name).filter(name => /client|clients|slp-clients/i.test(name)), []);
  const graph = rel(closure(join(root, 'plugin/server/desk-bridge.ts')));
  assert.ok(graph.length > 20, 'the closure was actually traversed');
  assert.deepEqual(graph.filter(file => /clients-store/.test(file)), []);
  assert.deepEqual(graph.filter(file => file === 'plugin/index.server.ts'), []);
  const relay = rel(closure(join(root, 'bin/slp-desk-mcp.mjs')));
  assert.deepEqual(relay.filter(file => /clients-store|plugin\/server\//.test(file)), [], 'the stdio relay imports no plugin server code');
  // the runtime payload shipped to installed candidates (what seats execute) has no store either
  const payload = readFileSync(join(root, 'plugin/server/generated/runtime-payload.ts'), 'utf8');
  assert.equal(/clients-store/.test(payload), false);
});

test('S1(2): slp.mjs commands never reach a client write; `clients validate` is read-only', () => {
  const usage = spawnSync(process.execPath, [cli, 'no-such-command'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } }).stderr;
  const commandsInUsage = usage.replace(/^Usage: slp\.mjs /, '').split(' | ').map(part => part.split(' ')[0]);
  assert.ok(commandsInUsage.includes('clients'));
  assert.deepEqual(usage.match(/clients [a-z-]+/g), ['clients validate']);
  const graph = rel(closure(join(root, 'plugin/server/runtime/cli/cli.ts')));
  assert.ok(graph.includes('plugin/server/runtime/cli/clients.ts'));
  assert.deepEqual(graph.filter(file => /clients-store/.test(file) || file === 'plugin/index.server.ts'), []);
  const readers = readFileSync(join(root, 'plugin/server/runtime/cli/clients.ts'), 'utf8');
  assert.deepEqual(readers.match(/\b(writeFileSync|appendFileSync|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|O_WRONLY|O_RDWR|O_CREAT|O_APPEND)\b/g) ?? [], [], 'the runtime clients module can only read');
  // run it against a real tree: nothing on disk changes
  const home = mkdtempSync(join(tmpdir(), 'slp-validate-ro-')); mkdirSync(join(home, 'slp-clients'), { recursive: true });
  writeFileSync(join(home, 'slp-clients/clients.json'), '{}');
  const snapshot = () => readdirSync(join(home, 'slp-clients')).sort().join(',') + readFileSync(join(home, 'slp-clients/clients.json'));
  const before = snapshot();
  spawnSync(process.execPath, [cli, 'clients', 'validate', '--paseo-home', home], { encoding: 'utf8' });
  assert.equal(snapshot(), before); rmSync(home, { recursive: true, force: true });
});

test('S1(3): RPC inventory — every handler registered in index.server.ts, with exactly the expected client writes', async () => {
  const file = join(root, 'plugin/index.server.ts');
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const contracts = await import('../plugin/shared/contracts.ts');
  const supervision = await import('../plugin/shared/supervision.ts');
  const enforcement = await import('../plugin/shared/enforcement.ts');
  const workflow = await import('../plugin/shared/workflow-view.ts');
  const lookup = { ...contracts, ...supervision, ...enforcement, ...workflow };
  const handlers = [];
  const walk = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'handle' && node.expression.expression.getText() === 'server') {
      const contract = node.arguments[0].getText();
      handlers.push({ contract, name: lookup[contract]?.name, body: node.arguments[1].getText() });
    }
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.ok(handlers.every(h => typeof h.name === 'string'), 'every handler maps to a defineRpc contract');
  assert.deepEqual(handlers.map(h => h.name).sort(), [
    'activate', 'catalog', 'deactivate', 'disable-supervision-notifications', 'enforcement-recover-lock', 'enforcement-runtime-pin', 'enforcement-status',
    'explain-resolution', 'get-client-files', 'get-clients', 'get-jev', 'get-peer-pool', 'get-role-routing', 'get-supervision', 'get-supervision-status',
    'get-workspace-workflow', 'identify-repository', 'local-target', 'reconcile', 'set-client-pool', 'set-client-protocol', 'set-clients', 'set-jev',
    'set-jev-key', 'set-language', 'set-peer-pool', 'set-role-routing', 'set-supervision', 'start-workspace-team', 'status', 'test-jev', 'validate-clients-draft',
  ].sort(), 'a new RPC must be added to this inventory deliberately');
  // client writes = handlers whose body calls the store's write methods — enumerated from source
  const writes = handlers.filter(h => /\bclients\.set(Clients|ClientPool|ClientProtocol)\b/.test(h.body)).map(h => h.name).sort();
  assert.deepEqual(writes, ['set-client-pool', 'set-client-protocol', 'set-clients']);
  // and the module that implements them is imported by index.server.ts alone
  const sources = readdirSync(join(root, 'plugin'), { recursive: true }).filter(p => /\.(ts|tsx)$/.test(p) && !p.includes('node_modules')).map(p => join(root, 'plugin', p));
  const importers = sources.filter(p => importsOf(p).some(imported => /clients-store(\.ts)?$/.test(imported))).map(p => p.slice(root.length));
  assert.deepEqual(importers, ['plugin/index.server.ts']);
});

test('S1: the daemon cannot attribute RPC callers (documented host gap; the writes stay convention-level)', () => {
  const contract = readFileSync(join(root, 'node_modules/@getpaseo/plugin/dist/server/contracts.d.ts'), 'utf8');
  assert.match(contract, /interface PluginHandlerContext \{\s*paseo: PaseoApi;\s*\}/, 'handler context carries no caller identity');
  const docs = readFileSync(join(root, 'docs/operations.md'), 'utf8');
  assert.match(docs, /plugin\.rpc\.invoke/); assert.match(docs, /CAPABILITY_GAP/);
});

test('C1: the project suggestion is derived from the repository path only — no query, fragment, userinfo, host or password ever reaches the RPC answer or the saved map', async t => {
  const f = fixture(t);
  const cases = [
    ['https://git.example.invalid/org/sub/repo.git?token=SECRET', 'org/sub/repo'],
    ['https://git.example.invalid/org/repo.git#SECRET', 'org/repo'],
    ['https://user:pa/ss-SECRET@git.example.invalid/grupo/api.git', 'grupo/api'],
    ['https://user:pa#SECRET@git.example.invalid/grupo/api.git', 'grupo/api'],
    ['https://user:p?SECRET=1@git.example.invalid/grupo/api', 'grupo/api'],
    ['ssh://git:SECRET@git.example.invalid:22/grupo/api.git', 'grupo/api'],
    ['git@git.example.invalid:grupo/api.git', 'grupo/api'],
    ['https://oauth2:SECRET@git.example.invalid/grupo/api.git', 'grupo/api'],
    ['file:///srv/git/grupo/api.git', 'grupo/api'],
    ['/srv/git/grupo/api.git', 'grupo/api'],
  ];
  for (const [url, expected] of cases) {
    fixtureGit(f.repo, 'remote', 'set-url', 'origin', url);
    const identity = await f.call('identifyRepository', { path: f.repo });
    assert.equal(identity.projectSuggestion, expected, url);
    assert.equal(JSON.stringify(identity).includes('SECRET'), false, url);
    assert.equal(identity.originSha256, sha(url), 'the hash still covers the full remote');
    await f.save(f.map(f.entry('ClienteA', identity.projectSuggestion, identity.gitCommonDir, url)), (await f.call('getClients', {})).mapSha256);
    assert.equal(readFileSync(f.mapPath, 'utf8').includes('SECRET'), false, url);
  }
  fixtureGit(f.repo, 'remote', 'set-url', 'origin', 'https://git.example.invalid');
  assert.match((await f.call('identifyRepository', { path: f.repo })).projectSuggestion, /^api$/, 'falls back to the folder name');
});

test('H-c: a new client that reuses a folder left behind by a removed client is warned before saving', async t => {
  const f = fixture(t);
  await f.save(f.map(f.entry('ClienteA', 'p', f.commonDir, URL_WITH_TOKEN)));
  await f.savePool('ClienteA', pool()); await f.saveProtocol('ClienteA', PROTOCOL);
  const current = (await f.call('getClients', {}));
  const removed = { ...f.map(), clients: { ClienteB: { directory: 'clienteB' } } };
  const afterRemoval = await f.save(removed, current.mapSha256);
  assert.ok(existsSync(join(f.clientsDir, 'clients/clienteA/.paseo-slp/slp-routing.json')), 'removing a client leaves its files on disk');
  const reuse = { ...removed, clients: { ...removed.clients, ClienteZ: { directory: 'clienteA' } } };
  const preview = await f.call('validateClientsDraft', { draft: { kind: 'map', map: reuse } });
  assert.equal(preview.ok, true);
  assert.ok(preview.warnings.some(w => /ClienteZ: folder clienteA already contains slp-routing\.json and workspace-protocol\.md; the new client inherits them/.test(w)), JSON.stringify(preview.warnings));
  // an unchanged client with the same folder is not warned again, and a fresh folder is not warned
  const unchanged = await f.call('validateClientsDraft', { draft: { kind: 'map', map: removed } });
  assert.equal(unchanged.warnings.some(w => /inherits/.test(w)), false);
  const fresh = await f.call('validateClientsDraft', { draft: { kind: 'map', map: { ...removed, clients: { ...removed.clients, ClienteY: { directory: 'clienteY' } } } } });
  assert.equal(fresh.warnings.some(w => /inherits/.test(w)), false);
  void afterRemoval;
});
