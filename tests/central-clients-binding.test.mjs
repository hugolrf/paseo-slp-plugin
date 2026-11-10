// Client binding on top of the central map (map version 2): strict mode,
// local-only repositories, structured rules (pin + create hook), the read-only
// Git-identity warning and the guarantee that a version 1 map / no map behave
// exactly as before. Each test names the contract item it proves (P1-P7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRoleInjection } from '../plugin/server/role-injection.ts';
import { install } from '../plugin/server/runtime/cli/package.ts';
import { readCatalog, routeChoices } from '../plugin/server/runtime/cli/routing.ts';
import * as C from '../plugin/server/runtime/cli/clients.ts';
// Names that exist in every version are used directly; the version 2 API is reached through C.* so that
// running this file against an older tree fails test by test (not at import time).
const { ClientMapError, identifyCheckout, lookupClient, parseClientMap, serializeClientMap, validateClients } = C;
import { validateCatalog } from '../plugin/server/runtime/cli/routing.ts';
import { makeHome } from './helpers/plugin-doubles.mjs';
import { fixtureGit, committedRepository } from './helpers/formation-placement-fixture.mjs';
import { centralFixture, baseMap, baseMapV2, writeClient, writeMap, sha256, ORIGIN, RULES } from './helpers/central-clients-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'bin/slp.mjs');
const slp = (args, home, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, ...(home ? { PASEO_HOME: home } : {}), ...extraEnv } });
const pool = (id = 'client-a') => ({ version: 1, policy: 'Fixture pool', quotaFallback: { enabled: false, optionId: null },
  options: [{ id, provider: 'codex', roles: ['peer'], model: 'model/variant', enabled: true, availability: 'ready', suitableFor: ['coding'], avoidFor: [], notes: 'fixture' }] });
const created = f => f.hostCalls.filter(c => c.kind === 'create' || c.kind === 'open').length;
const codeOf = error => error instanceof ClientMapError ? error.code : null;

function world(t) {
  const home = realpathSync(makeHome(t));
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slp-bind-'))); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = (name, remote = ORIGIN) => {
    const path = join(dir, name); const common = committedRepository(path);
    if (remote) fixtureGit(path, 'remote', 'add', 'origin', remote);
    return { path, common };
  };
  writeClient(home, 'clienteA', pool('client-a'));
  writeClient(home, 'clienteB', pool('client-b'));
  return { home, dir, repo };
}
const A = { client: 'ClienteA', directory: 'clienteA' }, B = { client: 'ClienteB', directory: 'clienteB' };
const mapV2 = (entries, extra = {}) => ({
  version: 2, strict: false, protectedRoots: [], clients: { ClienteA: { directory: 'clienteA' }, ClienteB: { directory: 'clienteB' } },
  repositories: entries, ...extra });
const entry = (client, project, repo, origin = ORIGIN) => ({ client, project, gitCommonDir: repo.common, originSha256: origin === null ? null : sha256(origin) });
const fileSha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

// ---------------------------------------------------------------- P2 strict
test('P2: a strict map blocks a project with no client in readCatalog, the routes CLI and clients check (CLIENT_UNMAPPED), outside protectedRoots too', t => {
  const w = world(t); const mapped = w.repo('mapped'); const loose = w.repo('loose', 'https://git.example.invalid/outro/app.git');
  writeMap(w.home, mapV2([entry('ClienteA', 'grupo/api', mapped)], { strict: true }));
  assert.equal(readCatalog(mapped.path, w.home).scope, 'central:ClienteA');
  assert.throws(() => readCatalog(loose.path, w.home), error => codeOf(error) === 'CLIENT_UNMAPPED' && /strict client map/.test(error.message));
  const routes = slp(['routes', loose.path, '--paseo-home', w.home]);
  assert.notEqual(routes.status, 0); assert.match(routes.stderr + routes.stdout, /CLIENT_UNMAPPED|strict client map/);
  const check = JSON.parse(slp(['clients', 'check', loose.path, '--paseo-home', w.home]).stdout);
  assert.equal(check.ok, false); assert.equal(check.binding.state, 'blocked'); assert.equal(check.error.code, 'CLIENT_UNMAPPED');
});

test('P2: route choices, the routes CLI and Peer selection share the strict block (the same lookup rule everywhere)', async t => {
  const w = world(t); const loose = w.repo('loose', 'https://git.example.invalid/outro/app.git');
  writeMap(w.home, mapV2([], { strict: true }));
  assert.throws(() => routeChoices({ repository: loose.path, paseoHome: w.home }), error => codeOf(error) === 'CLIENT_UNMAPPED');
  const { selectPeerSeat } = await import('../plugin/server/runtime/cli/seat-selection.ts');
  await assert.rejects(Promise.resolve().then(() => selectPeerSeat({ repository: loose.path, assignment: 'x', paseoHome: w.home }, {})), error => codeOf(error) === 'CLIENT_UNMAPPED');
});

test('P2: the same project is the historical path under a non-strict v2 map and under a v1 map (strict is the only switch)', t => {
  const w = world(t); const loose = w.repo('loose', 'https://git.example.invalid/outro/app.git');
  mkdirSync(join(w.home, 'slp-runtime/state'), { recursive: true });
  writeFileSync(join(w.home, 'slp-runtime/state/peer-pool.json'), JSON.stringify(pool('user-only')));
  for (const map of [mapV2([], { strict: false }), { version: 1, protectedRoots: [], clients: { ClienteA: { directory: 'clienteA' } }, repositories: [] }]) {
    writeMap(w.home, map);
    assert.equal(readCatalog(loose.path, w.home).scope, 'user');
  }
  writeMap(w.home, mapV2([], { strict: true }));
  assert.throws(() => readCatalog(loose.path, w.home), error => codeOf(error) === 'CLIENT_UNMAPPED');
});

test('P2: a checkout with its own .paseo-slp and no entry is blocked under a valid strict map; with an entry its configuration still wins the source; an absent or invalid map keeps today', t => {
  const w = world(t); const repo = w.repo('local');
  mkdirSync(join(repo.path, '.paseo-slp'), { recursive: true });
  writeFileSync(join(repo.path, '.paseo-slp/slp-routing.json'), JSON.stringify(pool('repo-pool')));
  writeFileSync(join(repo.path, '.paseo-slp/workspace-protocol.md'), 'Local protocol.\n');
  assert.equal(readCatalog(repo.path, w.home).scope, 'repository'); // no map
  writeMap(w.home, mapV2([], { strict: true }));
  assert.throws(() => readCatalog(repo.path, w.home), error => codeOf(error) === 'CLIENT_UNMAPPED');
  writeMap(w.home, mapV2([entry('ClienteA', 'grupo/api', repo)], { strict: true }));
  const catalog = readCatalog(repo.path, w.home);
  assert.equal(catalog.scope, 'repository'); assert.equal(catalog.options[0].id, 'repo-pool');
  assert.equal(catalog.binding.client, 'ClienteA'); assert.equal(catalog.binding.mapSha256, fileSha(join(w.home, 'slp-clients/clients.json')));
  writeMap(w.home, '{ not json'); // invalid map at the local rung: today's behavior, no block
  assert.equal(readCatalog(repo.path, w.home).scope, 'repository');
});

test('P2: under a strict map a directory that is not a Git checkout cannot be bound and is blocked; a non-strict map keeps it historical', t => {
  const w = world(t); const plain = join(w.dir, 'plain'); mkdirSync(plain);
  writeMap(w.home, mapV2([], { strict: true }));
  assert.throws(() => lookupClient({ home: w.home, cwd: plain }), error => codeOf(error) === 'CLIENT_UNMAPPED' && /not a Git checkout/.test(error.message));
  writeMap(w.home, mapV2([], { strict: false }));
  assert.deepEqual(lookupClient({ home: w.home, cwd: plain }), { state: 'unmapped' });
});

test('P2: an identity drift still blocks a mapped project under a strict map, at the central rung and at the local rung', t => {
  const w = world(t); const repo = w.repo('drift');
  writeMap(w.home, mapV2([entry('ClienteA', 'grupo/api', repo, 'https://git.example.invalid/other/else.git')], { strict: true }));
  assert.throws(() => readCatalog(repo.path, w.home), error => codeOf(error) === 'CLIENT_IDENTITY_DRIFT');
  mkdirSync(join(repo.path, '.paseo-slp'), { recursive: true });
  writeFileSync(join(repo.path, '.paseo-slp/slp-routing.json'), JSON.stringify(pool('repo-pool')));
  assert.throws(() => readCatalog(repo.path, w.home), error => codeOf(error) === 'CLIENT_IDENTITY_DRIFT');
});

// ------------------------------------------------------------ P4 local-only
test('P4: a v2 entry with originSha256 null is a local-only repository; any remote afterwards is CLIENT_IDENTITY_DRIFT; v1 rejects null', t => {
  const w = world(t); const local = w.repo('local', null);
  writeMap(w.home, mapV2([entry('ClienteA', 'local/app', local, null)]));
  const catalog = readCatalog(local.path, w.home);
  assert.equal(catalog.scope, 'central:ClienteA'); assert.equal(catalog.binding.client, 'ClienteA');
  assert.deepEqual(C.bindingFor(local.path, w.home).info.localOnly, true);
  fixtureGit(local.path, 'remote', 'add', 'upstream', 'https://git.example.invalid/x/y.git'); // ANY remote, not only origin
  assert.throws(() => readCatalog(local.path, w.home), error => codeOf(error) === 'CLIENT_IDENTITY_DRIFT' && /local-only now has a remote/.test(error.message));
  const v1 = JSON.parse(JSON.stringify(baseMap(local.common))); v1.repositories[0].originSha256 = null;
  assert.throws(() => parseClientMap(JSON.stringify(v1)), error => codeOf(error) === 'CLIENT_MAP_INVALID' && /64 lowercase hex/.test(error.message));
});

test('P4: identifyCheckout reports local-only for zero remotes, the origin hash for origin, and a clear error for remotes without origin', t => {
  const w = world(t);
  const none = identifyCheckout(w.repo('none', null).path);
  assert.equal(none.originSha256, null); assert.equal(none.localOnly, true);
  const withOrigin = identifyCheckout(w.repo('origin').path);
  assert.equal(withOrigin.originSha256, sha256(ORIGIN)); assert.equal(withOrigin.localOnly, false);
  const other = w.repo('upstream', null); fixtureGit(other.path, 'remote', 'add', 'upstream', 'https://git.example.invalid/x/y.git');
  assert.throws(() => identifyCheckout(other.path), error => /no readable "origin"/.test(error.message));
});

test('P4: clients validate lists localOnly entries and reports one that gained a remote', t => {
  const w = world(t); const local = w.repo('local', null);
  writeMap(w.home, mapV2([entry('ClienteA', 'local/app', local, null)]));
  const ok = validateClients(w.home, parsed => validateCatalog(parsed));
  assert.equal(ok.ok, true, JSON.stringify(ok.errors)); assert.equal(ok.mapVersion, 2); assert.equal(ok.strict, false);
  assert.deepEqual(ok.repositories.map(r => r.localOnly), [true]);
  fixtureGit(local.path, 'remote', 'add', 'origin', ORIGIN);
  const drift = validateClients(w.home, parsed => validateCatalog(parsed));
  assert.equal(drift.ok, false); assert.match(drift.errors.join('\n'), /declared local-only but now has a remote/);
});

// ----------------------------------------------------------------- P5 rules
test('P5: version 2 parses structured rules with exact keys and canonical order; a global origin, an unknown key or a free template is rejected', () => {
  const map = (rules, clientRules) => JSON.stringify(mapV2([], { rules, clients: { ClienteA: { directory: 'clienteA', ...(clientRules ? { rules: clientRules } : {}) } } }));
  const parsed = parseClientMap(map({ aiFooter: 'forbid', titleFormat: 'origin-id - pt-title', commitIdentity: { email: 'exemplo@example.invalid', name: 'Nome Exemplo' } }));
  assert.deepEqual(Object.keys(parsed.rules), ['commitIdentity', 'titleFormat', 'aiFooter'], 'canonical key order');
  assert.deepEqual(Object.keys(parsed.rules.commitIdentity), ['name', 'email']);
  const bad = (rules, clientRules, pattern) => assert.throws(() => parseClientMap(map(rules, clientRules)), error => codeOf(error) === 'CLIENT_MAP_INVALID' && pattern.test(error.message), pattern.source);
  bad({ origin: { kind: 'azure', organization: 'o', project: 'p' } }, undefined, /unknown: origin/);
  bad({ titleFormat: '{id} - {title}' }, undefined, /titleFormat must be one of/);
  bad({ aiFooter: 'sometimes' }, undefined, /aiFooter must be one of/);
  bad({ commitIdentity: { name: 'Hugo', email: 'not-an-email' } }, undefined, /e-mail address/);
  bad({ commitIdentity: { name: 'Hugo\nL', email: 'a@b.co' } }, undefined, /plain text/);
  bad({ madeUp: true }, undefined, /unknown: madeUp/);
  bad(undefined, { origin: { kind: 'azure', organization: 'https://user:pw@evil/', project: 'p' } }, /no URL/);
  bad(undefined, { origin: { kind: 'jira', site: 'a@b' } }, /no "@"/);
  bad(undefined, { origin: { kind: 'svn', site: 'x' } }, /azure, jira, gitlab or github/);
  bad({ commitIdentity: null }, undefined, /cannot be null/);
  assert.equal(parseClientMap(map(undefined, { origin: { kind: 'github', owner: 'acme' }, aiFooter: null })).clients.ClienteA.rules.aiFooter, null);
  assert.throws(() => parseClientMap(JSON.stringify({ version: 1, protectedRoots: [], clients: { A: { directory: 'a', rules: {} } }, repositories: [] })), error => /unknown: rules/.test(error.message), 'v1 has no rules');
  assert.throws(() => parseClientMap(JSON.stringify({ version: 2, protectedRoots: [], clients: {}, repositories: [] })), error => /missing: strict/.test(error.message));
});

test('P5: effective rules merge per key (client wins, null switches a key off) and render a deterministic pt-BR block of at most 1.2 KB', () => {
  const parsed = parseClientMap(JSON.stringify(mapV2([], {
    rules: RULES,
    clients: { ClienteA: { directory: 'clienteA', rules: { aiFooter: 'allow', origin: { kind: 'azure', organization: 'DW SAFER', project: 'Downstream' } } },
      ClienteB: { directory: 'clienteB', rules: { titleFormat: null, commitIdentity: { name: 'Outro Nome', email: 'outro@example.invalid' } } } } })));
  assert.deepEqual(C.effectiveRules(parsed, 'ClienteA'), { commitIdentity: RULES.commitIdentity, titleFormat: RULES.titleFormat, aiFooter: 'allow', origin: { kind: 'azure', organization: 'DW SAFER', project: 'Downstream' } });
  assert.deepEqual(C.effectiveRules(parsed, 'ClienteB'), { commitIdentity: { name: 'Outro Nome', email: 'outro@example.invalid' }, aiFooter: 'forbid' });
  const text = C.renderClientRules('ClienteA', C.effectiveRules(parsed, 'ClienteA'));
  assert.equal(text, C.renderClientRules('ClienteA', C.effectiveRules(parsed, 'ClienteA')), 'deterministic');
  assert.match(text, /^\n## Regras do cliente ClienteA \(SLP\)\n/); assert.match(text, /<ID da origem> - <título em português>/);
  assert.match(text, /Rodapé de IA permitido/); assert.match(text, /Azure DevOps, organização DW SAFER, projeto Downstream/);
  assert.ok(Buffer.byteLength(text) <= 1200, `${Buffer.byteLength(text)} bytes`);
  assert.equal(text.includes('Outro Nome'), false, 'never another client\'s identity');
  assert.equal(C.renderClientRules('X', {}), null);
  // worst case stays inside the budget
  const long = 'x'.repeat(80);
  const worst = C.renderClientRules('c'.repeat(64), { commitIdentity: { name: long, email: `${'e'.repeat(64)}@${'d'.repeat(50)}.com` }, titleFormat: 'origin-id - pt-title', aiFooter: 'forbid', origin: { kind: 'azure', organization: long, project: long } });
  assert.ok(Buffer.byteLength(worst) <= 1200, `${Buffer.byteLength(worst)} bytes`);
});

test('P5: the rules hash of a client changes only with ITS effective rules (another client\'s edit is invisible; a global edit reaches both)', t => {
  const w = world(t); const a = w.repo('a'); const b = w.repo('b', 'https://git.example.invalid/outro/app.git');
  const write = (global, ruleB) => writeMap(w.home, mapV2([entry('ClienteA', 'a', a), entry('ClienteB', 'b', b, 'https://git.example.invalid/outro/app.git')], {
    rules: global, clients: { ClienteA: { directory: 'clienteA' }, ClienteB: { directory: 'clienteB', ...(ruleB ? { rules: ruleB } : {}) } } }));
  const hashes = () => [readCatalog(a.path, w.home).binding.rulesSha256, readCatalog(b.path, w.home).binding.rulesSha256];
  write(RULES, undefined); const [a0, b0] = hashes();
  write(RULES, { aiFooter: 'allow' }); const [a1, b1] = hashes();
  assert.equal(a1, a0, 'editing B does not move A'); assert.notEqual(b1, b0);
  write({ ...RULES, aiFooter: 'allow' }, { aiFooter: 'allow' }); const [a2, b2] = hashes();
  assert.notEqual(a2, a1, 'a global edit reaches A'); assert.equal(b2, b1, 'B overrides that key');
});

test('P5/P7: version 1 and "no map" keep every observable byte: no binding in the catalog, serialize omits v2 keys, validate output has no v2 fields', t => {
  const w = world(t); const repo = w.repo('v1');
  const v1 = baseMap(repo.common);
  const text = JSON.stringify(v1);
  const parsed = parseClientMap(text);
  assert.equal(parsed.version, 1); assert.equal(parsed.strict, false); assert.equal(parsed.rules, undefined);
  assert.deepEqual(JSON.parse(serializeClientMap(parsed)), v1);
  writeMap(w.home, v1);
  const catalog = readCatalog(repo.path, w.home);
  assert.equal(catalog.scope, 'central:ClienteA'); assert.equal(catalog.binding, undefined);
  const report = validateClients(w.home, p => validateCatalog(p));
  assert.equal('strict' in report, false); assert.equal('mapVersion' in report, false);
  assert.equal(report.clients.some(c => 'rulesSha256' in c), false); assert.equal(report.repositories.some(r => 'localOnly' in r), false);
  assert.equal(C.ladderBinding({ home: w.home, cwd: repo.path }), null, 'v1 never binds rules');
  rmSync(join(w.home, 'slp-clients/clients.json'));
  assert.equal(C.ladderBinding({ home: w.home, cwd: repo.path }), null);
});

// ------------------------------------------------------ real v1 map (golden)
// The golden directory is a COPY of ~/.paseo/proposta-mapa-clientes/mac made by the
// engineer under <tmpdir>/slp-golden-v1 (or SLP_GOLDEN_V1_DIR when the runner keeps it);
// the original is never read here and the test skips when no copy exists. Pure
// parse/serialize facts only: no client repository on disk is touched.
const goldenText = t => {
  const dir = process.env.SLP_GOLDEN_V1_DIR ?? join(tmpdir(), 'slp-golden-v1');
  if (!existsSync(join(dir, 'slp-clients/clients.json'))) { t.skip(`no golden copy at ${dir}`); return null; }
  return readFileSync(join(dir, 'slp-clients/clients.json'), 'utf8');
};
// Same assertions must hold on the frozen baseline and on the candidate: this is the non-regression golden.
test('P7 golden: the real version 1 map (39 repositories) still parses to the same content and re-serializes to the same document', t => {
  const text = goldenText(t); if (text === null) return;
  const original = JSON.parse(text);
  const parsed = parseClientMap(text);
  assert.equal(parsed.version, 1); assert.equal(parsed.repositories.length, 39);
  assert.deepEqual(parsed.protectedRoots, original.protectedRoots); assert.deepEqual(JSON.parse(JSON.stringify(parsed.clients)), original.clients);
  assert.deepEqual(parsed.repositories, original.repositories);
  assert.deepEqual(JSON.parse(serializeClientMap(parsed)), original);
  assert.ok(parsed.repositories.every(r => /^[a-f0-9]{64}$/.test(r.originSha256)));
});
// Candidate-only facts about the same map: it reads as non-strict, with no rules anywhere.
test('P7 golden: the real version 1 map is non-strict and carries no rules, so no client gets a rules block', t => {
  const text = goldenText(t); if (text === null) return;
  const parsed = parseClientMap(text);
  assert.equal(parsed.strict, false); assert.equal(parsed.rules, undefined);
  for (const name of Object.keys(parsed.clients)) assert.equal(C.renderClientRules(name, C.effectiveRules(parsed, name)), null);
  assert.ok(Object.values(parsed.clients).every(c => !('rules' in c)));
});

// ------------------------------------------------------ P6 identity (read-only)
test('P6: the effective Git identity is compared with the client rule; ok/differs/unconfigured/unknown; .git/config is never written', t => {
  const w = world(t); const repo = w.repo('ident');
  const emptyHome = mkdtempSync(join(tmpdir(), 'slp-ident-home-')); t.after(() => rmSync(emptyHome, { recursive: true, force: true }));
  const previous = process.env.HOME; process.env.HOME = emptyHome; t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  const config = join(repo.common, 'config'); const before = fileSha(config);
  assert.equal(C.checkCommitIdentity(repo.path, RULES.commitIdentity).state, 'unconfigured');
  fixtureGit(repo.path, 'config', 'user.name', 'Alguém'); fixtureGit(repo.path, 'config', 'user.email', 'alguem@example.invalid');
  const differs = C.checkCommitIdentity(repo.path, RULES.commitIdentity);
  assert.equal(differs.state, 'differs'); assert.deepEqual(differs.local, { name: 'Alguém', email: 'alguem@example.invalid' }); assert.deepEqual(differs.effective, differs.local);
  fixtureGit(repo.path, 'config', 'user.name', 'Nome Exemplo'); fixtureGit(repo.path, 'config', 'user.email', 'exemplo@example.invalid');
  const afterWrites = fileSha(config);
  assert.equal(C.checkCommitIdentity(repo.path, RULES.commitIdentity).state, 'ok');
  assert.equal(C.checkCommitIdentity(join(w.dir, 'does-not-exist'), RULES.commitIdentity).state, 'unknown');
  assert.equal(fileSha(config), afterWrites, 'the checks only read');
  assert.notEqual(before, afterWrites, 'the fixture itself did write (control)');
});

test('P6: clients check reports the divergence of ITS OWN client only, exits 1 on a divergence and never touches .git/config', t => {
  const w = world(t); const a = w.repo('a'); const b = w.repo('b', 'https://git.example.invalid/outro/app.git');
  const emptyHome = mkdtempSync(join(tmpdir(), 'slp-ident-home-')); t.after(() => rmSync(emptyHome, { recursive: true, force: true }));
  writeMap(w.home, mapV2([entry('ClienteA', 'a', a), entry('ClienteB', 'b', b, 'https://git.example.invalid/outro/app.git')], {
    clients: { ClienteA: { directory: 'clienteA', rules: { commitIdentity: RULES.commitIdentity } },
      ClienteB: { directory: 'clienteB', rules: { commitIdentity: { name: 'Segredo do B', email: 'b@example.invalid' } } } } }));
  fixtureGit(a.path, 'config', 'user.name', 'Alguém'); fixtureGit(a.path, 'config', 'user.email', 'alguem@example.invalid');
  const configs = [join(a.common, 'config'), join(b.common, 'config')]; const before = configs.map(fileSha);
  const run = path => slp(['clients', 'check', path, '--paseo-home', w.home], null, { HOME: emptyHome });
  const diff = run(a.path); assert.equal(diff.status, 1);
  const report = JSON.parse(diff.stdout);
  assert.equal(report.identity.state, 'differs'); assert.equal(report.binding.client, 'ClienteA');
  assert.deepEqual(report.identity.expected, RULES.commitIdentity); assert.equal(diff.stdout.includes('Segredo do B'), false);
  assert.match(report.warnings[0], /git identity differs/);
  const missing = JSON.parse(run(b.path).stdout); assert.equal(missing.identity.state, 'unconfigured'); assert.equal(missing.identity.expected.name, 'Segredo do B');
  fixtureGit(a.path, 'config', 'user.name', 'Nome Exemplo'); fixtureGit(a.path, 'config', 'user.email', 'exemplo@example.invalid');
  const shaA = fileSha(configs[0]);
  const good = run(a.path); assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).identity.state, 'ok');
  assert.equal(fileSha(configs[0]), shaA); assert.equal(fileSha(configs[1]), before[1]);
  assert.equal(slp(['clients', 'check', 'relative/path', '--paseo-home', w.home]).status, 1);
  const usage = slp(['clients', 'check', '--paseo-home', w.home]); assert.equal(usage.status, 1); assert.match(usage.stderr, /absolute <path>/);
  assert.equal(slp(['clients', 'validate', a.path, '--paseo-home', w.home]).status, 1);
});

test('P6: a client without a commitIdentity rule has nothing to compare (identity null, ok)', t => {
  const w = world(t); const a = w.repo('a');
  writeMap(w.home, mapV2([entry('ClienteA', 'a', a)]));
  const report = C.checkClientBinding(a.path, w.home);
  assert.equal(report.ok, true); assert.equal(report.identity, null); assert.equal(report.binding.state, 'mapped');
  rmSync(join(w.home, 'slp-clients/clients.json'));
  assert.deepEqual(C.checkClientBinding(a.path, w.home).binding, { state: 'absent' });
});

// ------------------------------------------------------- hook: agent.create
async function injectionFor(t, home) {
  const { clientContextForCwd } = await import('../plugin/server/client-context.ts');
  const dir = mkdtempSync(join(tmpdir(), 'slp-bind-hook-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const candidate = join(dir, 'candidate'); const { candidate: identity } = install(root, candidate);
  const binding = { candidateSha256: identity.sha256, payloadSha256: 'a'.repeat(64), runtimePath: candidate, nodePath: process.execPath, daemonHome: home };
  return createRoleInjection({ readActiveBinding: () => binding, verifyCandidate: async () => {}, clientContext: cwd => clientContextForCwd(cwd, home) });
}
test('P2/P5: the agent.create hook appends the client rules to every slp-* system prompt, fails closed for a project with no client under a strict map and lets other providers through', async t => {
  const w = world(t); const mapped = w.repo('mapped'); const loose = w.repo('loose', 'https://git.example.invalid/outro/app.git');
  writeMap(w.home, mapV2([entry('ClienteA', 'grupo/api', mapped)], { strict: true, rules: RULES }));
  const injection = await injectionFor(t, w.home);
  const ok = await injection.agentCreate({ request: { config: { provider: 'slp-codex-peer', cwd: mapped.path } } });
  assert.match(ok.config.systemPrompt, /## Regras do cliente ClienteA \(SLP\)/); assert.match(ok.config.systemPrompt, /"Nome Exemplo" <exemplo@example.invalid>/);
  assert.ok(ok.config.systemPrompt.indexOf('Regras do cliente') > ok.config.systemPrompt.indexOf('SLP role=peer'), 'after the role bundle');
  await assert.rejects(injection.agentCreate({ request: { config: { provider: 'slp-codex-peer', cwd: loose.path } } }),
    error => /mapeie o projeto na tela Clientes/.test(error.message) && /CLIENT_UNMAPPED/.test(error.message));
  assert.equal(await injection.agentCreate({ request: { config: { provider: 'codex', cwd: loose.path } } }), undefined, 'a non-slp provider is untouched');
  writeMap(w.home, mapV2([entry('ClienteA', 'grupo/api', mapped)], { strict: false, rules: RULES }));
  const lenient = await injection.agentCreate({ request: { config: { provider: 'slp-codex-peer', cwd: loose.path } } });
  assert.equal(lenient.config.systemPrompt.includes('Regras do cliente'), false, 'an unmapped project gets no rules and no block when the map is not strict');
  rmSync(join(w.home, 'slp-clients/clients.json'));
  assert.equal((await injection.agentCreate({ request: { config: { provider: 'slp-codex-peer', cwd: loose.path } } })).config.systemPrompt.includes('Regras do cliente'), false, 'no map = today');
});

test('P2: a map that is invalid (or version 1) never blocks and never injects at agent.create (today\'s behavior)', async t => {
  const w = world(t); const loose = w.repo('loose', 'https://git.example.invalid/outro/app.git');
  const injection = await injectionFor(t, w.home);
  for (const map of ['{ broken', baseMap(loose.common, { repositories: [] })]) {
    writeMap(w.home, map);
    const out = await injection.agentCreate({ request: { config: { provider: 'slp-codex-peer', cwd: loose.path } } });
    assert.equal(out.config.systemPrompt.includes('Regras do cliente'), false);
  }
});

test('read-only: the create hook and the client context write nothing under the Paseo home', async t => {
  const w = world(t); const mapped = w.repo('mapped');
  writeMap(w.home, mapV2([entry('ClienteA', 'grupo/api', mapped)], { strict: true, rules: RULES }));
  const tree = () => readdirSync(w.home, { recursive: true }).sort().map(p => `${p}:${(() => { try { return fileSha(join(w.home, p)); } catch { return 'dir'; } })()}`).join('\n');
  const before = tree();
  await (await injectionFor(t, w.home)).agentCreate({ request: { config: { provider: 'slp-codex-peer', cwd: mapped.path } } });
  assert.equal(tree(), before);
  const source = readFileSync(join(root, 'plugin/server/client-context.ts'), 'utf8');
  assert.deepEqual(source.match(/\b(writeFileSync|appendFileSync|renameSync|mkdirSync|rmSync|unlinkSync|copyFileSync|O_WRONLY|O_RDWR|O_CREAT)\b/g) ?? [], []);
  assert.equal(/clients-store/.test(source), false, 'the hook cannot reach the screen\'s writes');
});

// -------------------------------------------- formation: pins, strict, capability
test('P5: the formation source pin carries the client binding at the central, main and local rungs, and only ITS client\'s rules move the pin', async t => {
  const f = centralFixture(t);
  const write = (a, b) => writeMap(f.home, { version: 2, strict: false, protectedRoots: [], rules: RULES,
    clients: { ClienteA: { directory: 'clienteA', ...(a ? { rules: a } : {}) }, ClienteB: { directory: 'clienteB', ...(b ? { rules: b } : {}) } },
    repositories: [{ client: 'ClienteA', project: 'grupo/api', gitCommonDir: f.commonDir, originSha256: sha256(ORIGIN) }] });
  writeClient(f.home, 'clienteB', f.clientPool);
  write(undefined, undefined);
  const central = await f.placement.source(f.row);
  assert.equal(central.central.client, 'ClienteA'); assert.equal(central.binding.client, 'ClienteA');
  assert.match(central.binding.rulesSha256, /^[0-9a-f]{64}$/); assert.match(central.binding.mapSha256, /^[0-9a-f]{64}$/);
  // main rung: the main checkout has its own configuration, which wins the source; the binding still rides along.
  mkdirSync(join(f.repository, '.paseo-slp'), { recursive: true });
  writeFileSync(join(f.repository, '.paseo-slp/slp-routing.json'), JSON.stringify(f.catalog));
  writeFileSync(join(f.repository, '.paseo-slp/workspace-protocol.md'), 'Main protocol.\n');
  const main = await f.placement.source({ ...f.row, createCwd: f.target });
  assert.equal(main.central, undefined); assert.equal(main.binding.client, 'ClienteA');
  const local = await f.placement.source({ ...f.row, createCwd: f.repository });
  assert.equal(local.central, undefined); assert.equal(local.binding.client, 'ClienteA'); assert.equal(local.binding.rulesSha256, central.binding.rulesSha256);
  rmSync(join(f.repository, '.paseo-slp'), { recursive: true, force: true });
  // editing client B's rules: this pin is unaffected (map hash aside, only rules are the subject: compare the rules hash)
  write(undefined, { aiFooter: 'allow' });
  const afterB = await f.placement.source(f.row);
  assert.equal(afterB.binding.rulesSha256, central.binding.rulesSha256, 'B\'s rules do not move A\'s rules hash');
  write({ aiFooter: 'allow' }, undefined);
  const afterA = await f.placement.source(f.row);
  assert.notEqual(afterA.binding.rulesSha256, central.binding.rulesSha256);
  await assert.rejects(f.placement.verifySource(f.row, central), error => error.code === 'ROUTE_DRIFT', 'verifySource detects the drift');
});

test('P7: a version 1 map leaves every pin byte as before (no binding key)', async t => {
  const f = centralFixture(t);
  const pin = await f.placement.source(f.row);
  assert.equal(pin.central.client, 'ClienteA'); assert.equal('binding' in pin, false);
});

test('P5: the receipt names the pinned rules, and a divergent Git identity is a read-only warning on prepared (never a block)', async t => {
  const f = centralFixture(t);
  const emptyHome = mkdtempSync(join(tmpdir(), 'slp-ident-home-')); t.after(() => rmSync(emptyHome, { recursive: true, force: true }));
  const previous = process.env.HOME; process.env.HOME = emptyHome; t.after(() => { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; });
  writeMap(f.home, { ...baseMapV2(f.commonDir, { rules: RULES }), repositories: [{ client: 'ClienteA', project: 'grupo/api', gitCommonDir: f.commonDir, originSha256: sha256(ORIGIN) }] });
  fixtureGit(f.repository, 'config', 'user.name', 'Alguém'); fixtureGit(f.repository, 'config', 'user.email', 'alguem@example.invalid');
  const config = join(f.commonDir, 'config'); const before = fileSha(config);
  const out = await f.run(f.input);
  assert.equal(out.result.state, 'awaiting-caller-delivery', JSON.stringify(out));
  const prepared = out.phases.find(p => p.name === 'prepared').value;
  const text = prepared.warnings.join('\n');
  assert.match(text, /client rules ClienteA \([0-9a-f]{8}\)/); assert.match(text, /git identity differs/);
  const selected = out.phases.find(p => p.name === 'route-selected').value;
  assert.equal(selected.source.binding.client, 'ClienteA'); assert.match(selected.source.binding.rulesSha256, /^[0-9a-f]{64}$/);
  assert.equal(fileSha(config), before, 'the formation never writes the Git config');
  fixtureGit(f.repository, 'config', 'user.name', 'Nome Exemplo'); fixtureGit(f.repository, 'config', 'user.email', 'exemplo@example.invalid');
  const again = await f.run({ ...f.input, requestId: 'placement-2' });
  assert.equal(again.phases.find(p => p.name === 'prepared').value.warnings.join('\n').includes('git identity'), false);
});

test('P2: strict map + project with no client blocks the formation before any effect (central rung, main rung and local rung)', async t => {
  const f = centralFixture(t);
  writeMap(f.home, baseMapV2(f.commonDir, { strict: true, repositories: [] }));
  const out = await f.run(f.input);
  assert.equal(out.code ?? out.result?.code, 'CAPABILITY_GAP', JSON.stringify(out)); assert.match(out.message ?? out.result.message, /CLIENT_UNMAPPED/);
  assert.equal(created(f), 0);
  for (const where of ['main', 'local']) {
    mkdirSync(join(f.repository, '.paseo-slp'), { recursive: true });
    writeFileSync(join(f.repository, '.paseo-slp/slp-routing.json'), JSON.stringify(f.catalog));
    writeFileSync(join(f.repository, '.paseo-slp/workspace-protocol.md'), 'Config.\n');
    f.row.createCwd = where === 'main' ? f.target : f.repository;
    const blocked = await f.run({ ...f.input, requestId: `placement-${where}` });
    assert.equal(blocked.code ?? blocked.result?.code, 'CAPABILITY_GAP', `${where}: ${JSON.stringify(blocked)}`); assert.match(blocked.message ?? blocked.result.message, /CLIENT_UNMAPPED/);
  }
  assert.equal(created(f), 0);
});

test('P2: without a map the formation is what it was (no binding, no block); with a v1 map a stale-capability candidate (centralClients only) still seats', async t => {
  const f = centralFixture(t);
  rmSync(join(f.home, 'slp-clients/clients.json'));
  mkdirSync(join(f.repository, '.paseo-slp'), { recursive: true });
  writeFileSync(join(f.repository, '.paseo-slp/slp-routing.json'), JSON.stringify(f.catalog));
  writeFileSync(join(f.repository, '.paseo-slp/workspace-protocol.md'), 'Config.\n');
  const pin = await f.placement.source(f.row);
  assert.equal('binding' in pin, false); assert.equal('central' in pin, false);
});

test('capability: a candidate without clientBinding refuses a version 2 binding instead of reading it divergently; a version 1 map does not need it', async t => {
  const { createFormationPlanner } = await import('../plugin/server/desk-formation.ts');
  const run = async (writeThe) => {
    const f = centralFixture(t);
    writeThe(f);
    const importModule = async spec => { const l = await import(spec); return { ...l, FORMATION_CAPABILITIES: { existingPlacement: 1, peerPresets: 2, centralClients: 1 },
      selectPeerSeat: (request, deps) => l.selectPeerSeat(request, { ...deps, decide: f.decide }) }; };
    const planner = createFormationPlanner({ runtimePath: f.candidate, daemonHome: f.home, host: () => f.host, importModule });
    Object.assign(f.deps, { plan: planner, placementCapability: planner.placementCapability, preflightPeer: planner.preflightPeer, selectPeer: planner.selectPeer });
    return { f, out: await f.run(f.input) };
  };
  const v2 = await run(f => writeMap(f.home, baseMapV2(f.commonDir, { rules: RULES })));
  assert.equal(v2.out.code ?? v2.out.result?.code, 'CAPABILITY_GAP', JSON.stringify(v2.out)); assert.match(v2.out.message ?? v2.out.result.message, /client binding/);
  assert.equal(created(v2.f), 0);
  const v1 = await run(() => {});
  assert.equal(v1.out.result?.state, 'awaiting-caller-delivery', JSON.stringify(v1.out));
});

test('capability: task deliver (resolveBinding) reads the same strict block and binding; a candidate without clientBinding is refused only where a v2 map binds or blocks', async t => {
  const { createTaskRuntimeResolver } = await import('../plugin/server/desk-task-runtime.ts');
  const { resolveBinding } = await import('../plugin/server/runtime/cli/launch.ts');
  const f = centralFixture(t);
  const resolve = capabilities => createTaskRuntimeResolver({ runtimePath: f.candidate, daemonHome: f.home,
    host: () => ({ providers: { snapshot: async () => ({ entries: [{ provider: 'slp-codex-peer', enabled: true, status: 'ready' }] }) } }),
    importModule: async () => ({ resolveBinding, FORMATION_CAPABILITIES: capabilities }) });
  writeMap(f.home, baseMapV2(f.commonDir, { rules: RULES }));
  const sha = readCatalog(f.repository, f.home).sha256;
  const full = await resolve({ centralClients: 1, peerPresets: 2, clientBinding: 1 })(f.repository, { optionId: 'client-a', catalogSha256: sha });
  assert.equal(full.routing.catalogScope, 'central:ClienteA', JSON.stringify(full));
  assert.ok(full.warnings.some(w => /client rules ClienteA \([0-9a-f]{8}\)/.test(w)), full.warnings.join('|'));
  const old = await resolve({ centralClients: 1, peerPresets: 2 })(f.repository, { optionId: 'client-a', catalogSha256: sha });
  assert.equal(old.code, 'CAPABILITY_GAP', JSON.stringify(old)); assert.match(old.message ?? old.reason ?? JSON.stringify(old), /client binding/);
  // a strict map that blocks the repository is also refused for an old candidate (it would never see the block) ...
  writeMap(f.home, baseMapV2(f.commonDir, { strict: true, repositories: [] }));
  const blockedOld = await resolve({ centralClients: 1, peerPresets: 2 })(f.repository, { optionId: 'client-a', catalogSha256: sha });
  assert.equal(blockedOld.code, 'CAPABILITY_GAP', JSON.stringify(blockedOld));
  // ... and the current candidate itself fails closed with CLIENT_UNMAPPED
  const blockedNew = await resolve({ centralClients: 1, peerPresets: 2, clientBinding: 1 })(f.repository, { optionId: 'client-a', catalogSha256: sha });
  assert.match(JSON.stringify(blockedNew), /CLIENT_UNMAPPED|strict client map/);
});

test('the installed candidate advertises clientBinding alongside centralClients', async () => {
  const launch = await import('../plugin/server/runtime/cli/launch.ts');
  assert.deepEqual(launch.FORMATION_CAPABILITIES, { existingPlacement: 1, peerPresets: 2, centralClients: 1, clientBinding: 1, clientContainers: 1 });
});

// ------------------------------------------------ correction round 1 (H1, H2, H4)
test('H1: under a strict map the create hook fails closed for a missing, empty or relative cwd; without a map, with v1 or non-strict it is today\'s behavior', async t => {
  const w = world(t); const mapped = w.repo('mapped');
  const injection = await injectionFor(t, w.home);
  const create = cwd => injection.agentCreate({ request: { config: { provider: 'slp-codex-peer', ...(cwd === undefined ? {} : { cwd }) } } });
  writeMap(w.home, mapV2([entry('ClienteA', 'grupo/api', mapped)], { strict: true }));
  for (const cwd of [undefined, '', 'relative/dir', './mapped']) {
    await assert.rejects(create(cwd), error => /mapeie o projeto na tela Clientes/.test(error.message) && /CLIENT_UNMAPPED/.test(error.message), `cwd ${JSON.stringify(cwd)}`);
  }
  assert.match((await create(mapped.path)).config.systemPrompt, /SLP role=peer/, 'an absolute mapped cwd still passes');
  for (const map of [mapV2([], { strict: false }), baseMap(mapped.common), '{ broken', null]) {
    if (map === null) rmSync(join(w.home, 'slp-clients/clients.json'), { force: true }); else writeMap(w.home, map);
    for (const cwd of [undefined, '', 'relative/dir']) {
      const out = await create(cwd);
      assert.equal(out.config.systemPrompt.includes('Regras do cliente'), false, `${typeof map} ${JSON.stringify(cwd)}`);
    }
  }
});

test('H2: the hook stays cheap — a non-strict map with no rule anywhere answers before any Git call, and the posture probe is null for absent/invalid/v1 maps', async t => {
  const w = world(t); const ghost = join(w.dir, 'not-created');
  assert.equal(C.clientMapPosture(w.home), null);
  writeMap(w.home, '{ broken'); assert.equal(C.clientMapPosture(w.home), null);
  writeMap(w.home, baseMap('/x/.git')); assert.equal(C.clientMapPosture(w.home), null);
  writeMap(w.home, mapV2([], { strict: false }));
  assert.deepEqual(C.clientMapPosture(w.home), { strict: false, hasRules: false });
  const { clientContextForCwd } = await import('../plugin/server/client-context.ts');
  const previousPath = process.env.PATH; process.env.PATH = '/nonexistent'; // Git cannot even start: proves no Git call is made
  try { assert.equal(clientContextForCwd(ghost, w.home), null); } finally { process.env.PATH = previousPath; }
  writeMap(w.home, mapV2([], { strict: false, rules: RULES }));
  assert.deepEqual(C.clientMapPosture(w.home), { strict: false, hasRules: true });
  writeMap(w.home, mapV2([], { strict: false, clients: { ClienteA: { directory: 'clienteA', rules: { aiFooter: 'allow' } } } }));
  assert.equal(C.clientMapPosture(w.home).hasRules, true);
  const docs = readFileSync(join(root, 'docs/operations.md'), 'utf8');
  assert.match(docs, /Hook reach — host-dependent \(CAPABILITY_GAP\)/); assert.match(docs, /lifecycle\.d\.ts:91-93/);
  assert.match(docs, /Accepted limits, documented/); assert.match(readFileSync(join(root, 'docs/decisions/2026-11-06-client-binding-strict-and-rules.md'), 'utf8'), /depends on the host aborting a create/);
});

test('H4: no real personal name or e-mail in the versioned feature files; the screen suggests no commit identity', async () => {
  const personal = new RegExp(['hugolrf@', 'gmail', '|Hugo', ' L\\b'].join(''));
  const files = ['plugin/client/cards/clients.tsx', 'plugin/client/pt-br.ts', 'plugin/server/client-context.ts', 'plugin/server/clients-store.ts', 'plugin/server/runtime/cli/clients.ts',
    'docs/operations.md', 'docs/cli.md', 'docs/contract.md', 'docs/decisions/2026-11-06-client-binding-strict-and-rules.md',
    'tests/central-clients-binding.test.mjs', 'tests/central-clients-ui-server.test.mjs', 'tests/client-clients-card.test.mjs', 'tests/helpers/central-clients-fixture.mjs'];
  for (const file of files) assert.doesNotMatch(readFileSync(join(root, file), 'utf8'), personal, file);
  assert.equal(RULES.commitIdentity.email.endsWith('@example.invalid'), true);
});
