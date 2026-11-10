// "Clientes" screen, client side: drafts per target, review → confirm save with
// the server's token, CAS conflicts that keep the draft, server-computed
// repository identity, diagnosis, the ROUTE_DRIFT warning, and the pool/protocol
// adapters. Behavior is exercised with the real hook against faked RPCs.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { act, loadHooks, renderHook } from './helpers/client-hooks-harness.mjs';

const H = n => String(n).repeat(64);
const targetA = { hostId: 'mac', daemonHome: '/home/a' }, targetB = { hostId: 'wsl', daemonHome: '/home/b' };
const colors = Object.fromEntries(['foreground', 'foregroundMuted', 'statusDanger', 'statusWarning', 'statusSuccess', 'surface0', 'surface1', 'surface2', 'border', 'accent', 'accentForeground'].map(key => [key, '#123456']));
const baseMap = () => ({ version: 1, protectedRoots: ['/work'], clients: { ClienteA: { directory: 'clienteA' } },
  repositories: [{ client: 'ClienteA', project: 'grupo/api', gitCommonDir: '/work/api/.git', originSha256: H('a') }] });
const clientsView = (map, sha = H('1'), extra = {}) => ({ schemaVersion: 1, canonicalHome: '/home/a', mapState: map ? 'valid' : 'absent', mapSha256: map ? sha : null, map,
  mapError: null, hostErrors: [], mapExternalChange: false, strict: false, containerWrites: { allowed: true, reason: null },
  clients: map ? Object.entries(map.clients).map(([name, { directory }]) => ({ name, directory, referenced: true, repositories: 1, routingSha256: H('2'), protocolSha256: H('3'), options: 1, error: null, externalChange: false })) : [], ...extra });
const review = (over = {}) => ({ schemaVersion: 1, ok: true, errors: [], warnings: [], confirm: H('c'), affectedClients: ['ClienteA'], mapHashChanges: true, ...over });

const projectRow = (over = {}) => ({ key: '/work/x/.git', kind: 'repository', containerBlocked: null, state: 'pending', name: 'x', projectId: null, projectLabel: null, projects: [], repoName: over.name ?? 'x', workspaceCount: 1, mainPath: '/work/x',
  workspaceIds: ['wx'], paths: ['/work/x'], gitCommonDir: '/work/x/.git', originSha256: H('7'), localOnly: false,
  projectSuggestion: 'grupo/x', linked: false, client: null, code: null, reason: null, identity: null, ...over });
const projectsView = (rows, extra = {}) => { const projects = rows ?? [
  projectRow({ key: '/work/api/.git', state: 'bound', name: 'api', workspaceIds: ['w1', 'w2'], paths: ['/work/api', '/work/api-wt'], gitCommonDir: '/work/api/.git', originSha256: H('a'), projectSuggestion: 'grupo/api', client: 'ClienteA' }),
  projectRow({ key: '/work/novo/.git', name: 'novo', workspaceIds: ['w3'], paths: ['/work/novo'], gitCommonDir: '/work/novo/.git', originSha256: H('b'), projectSuggestion: 'grupo/novo' }),
  projectRow({ key: '/work/rascunho/.git', name: 'rascunho', workspaceIds: ['w4'], paths: ['/work/rascunho'], gitCommonDir: '/work/rascunho/.git', originSha256: null, localOnly: true, projectSuggestion: 'rascunho' }),
  projectRow({ key: 'path:/work/plain', state: 'not-git', name: 'plain', gitCommonDir: null, originSha256: null, projectSuggestion: 'plain' }),
]; return { schemaVersion: 1, mapState: 'valid', strict: false, pending: projects.filter(r => r.state === 'pending').length, projects, ...extra }; };

const fourWorkspaces = [{ id: 'w1', name: 'api', directory: '/work/api' }, { id: 'w2', name: 'api (pr)', directory: '/work/api-wt' }, { id: 'w3', name: 'novo', directory: '/work/novo' }, { id: 'w4', name: 'rascunho', directory: '/work/rascunho' }];
const makeProjectApi = (over = {}) => makeApi({ listWorkspaces: async () => fourWorkspaces, ...over });

function makeApi(over = {}) {
  const calls = [];
  const rec = (name, fn) => async input => { calls.push([name, input]); return fn(input); };
  let current = clientsView(baseMap());
  const api = {
    getClients: rec('getClients', async () => current),
    getClientFiles: rec('getClientFiles', async input => ({ schemaVersion: 1, client: input.client, directory: 'clienteA',
      pool: { pool: { version: 1, policy: 'p', quotaFallback: { enabled: false, optionId: null }, options: [] }, sha256: H('4'), error: null },
      protocol: { text: 'old protocol\n', sha256: H('5'), error: null } })),
    validate: rec('validate', async () => review()),
    identify: rec('identify', async () => ({ schemaVersion: 1, gitCommonDir: '/work/new/.git', originSha256: H('9'), projectSuggestion: 'grupo/new', linked: false, mappedClient: null })),
    explain: rec('explain', async () => ({ schemaVersion: 1, path: '/work/api', decidedBy: 'central', catalogScope: 'central:ClienteA', catalogPath: '/x', formation: 'central', client: 'ClienteA', code: null, reason: 'listed in the map' })),
    setClients: rec('setClients', async () => { current = clientsView(null); return { sha256: H('7') }; }),
    setClientPool: rec('setClientPool', async () => ({ sha256: H('8') })),
    setClientProtocol: rec('setClientProtocol', async () => ({ sha256: H('6') })),
    listWorkspaces: rec('listWorkspaces', async () => [{ id: 'w1', name: 'api', directory: '/work/api' }]),
    listProjects: rec('listProjects', async () => projectsView()),
    ...over,
  };
  return { api, calls, setCurrent: value => { current = value; } };
}
const mount = async (t, api, target = targetA) => {
  const mod = await loadHooks(t);
  const key = mod.targetKey(target);
  const update = () => {};
  const props = { target, targetKey: key, api, update };
  const rendered = await renderHook(t, p => mod.useClientsCard(p), props);
  await act(async () => {});
  return { mod, rendered, state: () => rendered.state.current, props, switchTo: async next => { await rendered.update({ ...props, target: next, targetKey: mod.targetKey(next) }); await act(async () => {}); } };
};

test('loads the map and its client rows from the server', async t => {
  const { api, calls } = makeApi();
  const m = await mount(t, api);
  assert.equal(m.state().data.mapState, 'valid'); assert.deepEqual(Object.keys(m.state().map.clients), ['ClienteA']);
  assert.equal(m.state().dirty, false); assert.equal(calls[0][0], 'getClients');
});

test('review then confirm: the save echoes the server confirm token and the CAS hash read, then clears the draft', async t => {
  const { api, calls } = makeApi();
  const m = await mount(t, api);
  await act(async () => m.state().addRoot('/work/extra'));
  assert.equal(m.state().dirty, true); assert.equal(m.state().draft.review, null);
  await act(async () => m.state().saveMap());
  assert.equal(calls.filter(([n]) => n === 'setClients').length, 0, 'no save without a review');
  await act(async () => m.state().reviewMap());
  assert.equal(m.state().draft.review.result.confirm, H('c'));
  await act(async () => m.state().saveMap());
  const save = calls.find(([n]) => n === 'setClients')[1];
  assert.deepEqual([save.confirm, save.expectedSha256, save.map.protectedRoots], [H('c'), H('1'), ['/work', '/work/extra']]);
  assert.equal(m.state().dirty, false);
  assert.equal(calls.filter(([n]) => n === 'getClients').length, 2, 'reloads after saving');
});

test('an edit after the review invalidates it: the stale token is never sent', async t => {
  const { api, calls } = makeApi();
  const m = await mount(t, api);
  await act(async () => m.state().addRoot('/work/a'));
  await act(async () => m.state().reviewMap());
  await act(async () => m.state().addRoot('/work/b'));
  assert.equal(m.state().draft.review, null);
  await act(async () => m.state().saveMap());
  assert.equal(calls.filter(([n]) => n === 'setClients').length, 0);
});

test('invalid draft: the server errors are shown and save stays impossible', async t => {
  const { api, calls } = makeApi({ validate: async () => review({ ok: false, errors: ['repositories[0].gitCommonDir does not exist on this host: /x'], confirm: null }) });
  const m = await mount(t, api);
  await act(async () => m.state().removeRepository(0));
  await act(async () => m.state().reviewMap());
  assert.equal(m.state().draft.review.result.ok, false);
  await act(async () => m.state().saveMap());
  assert.equal(calls.filter(([n]) => n === 'setClients').length, 0);
});

test('CAS conflict keeps the draft, flags it, and rebasing keeps the draft on the latest hash', async t => {
  let phase = 0;
  const { api, calls, setCurrent } = makeApi({ setClients: async () => { throw new Error('changed since it was read — reload before saving'); } });
  const m = await mount(t, api);
  await act(async () => m.state().addRoot('/work/mine'));
  await act(async () => m.state().reviewMap());
  await act(async () => m.state().saveMap());
  assert.equal(m.state().draft.conflict, true); assert.equal(m.state().dirty, true);
  assert.deepEqual(m.state().map.protectedRoots, ['/work', '/work/mine'], 'the draft survives the conflict');
  setCurrent(clientsView(baseMap(), H('f')));
  await act(async () => m.state().rebase());
  assert.equal(m.state().draft.conflict, false); assert.equal(m.state().baseSha, H('f')); assert.deepEqual(m.state().map.protectedRoots, ['/work', '/work/mine']);
  void phase; void calls;
});

test('drafts belong to the target (host): another host never sees or sends them, and the first returns intact', async t => {
  const { api } = makeApi();
  const m = await mount(t, api, targetA);
  await act(async () => m.state().addRoot('/only/on/mac'));
  assert.equal(m.state().dirty, true);
  await m.switchTo(targetB);
  assert.equal(m.state().dirty, false); assert.deepEqual(m.state().map.protectedRoots, ['/work']);
  await act(async () => m.state().addRoot('/only/on/wsl'));
  await m.switchTo(targetA);
  assert.deepEqual(m.state().map.protectedRoots, ['/work', '/only/on/mac']);
  await m.switchTo(targetB);
  assert.deepEqual(m.state().map.protectedRoots, ['/work', '/only/on/wsl']);
});

test('add repository from a workspace: identity comes from the server verbatim; an already mapped repository is refused', async t => {
  const { api, calls } = makeApi();
  const m = await mount(t, api);
  await act(async () => m.state().setSelected('ClienteA'));
  await act(async () => m.state().loadWorkspaces());
  assert.deepEqual(m.state().workspaces, [{ id: 'w1', name: 'api', directory: '/work/api' }]);
  await act(async () => m.state().identify('/work/new'));
  assert.equal(calls.find(([n]) => n === 'identify')[1].path, '/work/new');
  assert.equal(m.state().project, 'grupo/new');
  await act(async () => m.state().addCandidate());
  const added = m.state().map.repositories.at(-1);
  assert.deepEqual(added, { client: 'ClienteA', project: 'grupo/new', gitCommonDir: '/work/new/.git', originSha256: H('9') });
  const mapped = makeApi({ identify: async () => ({ schemaVersion: 1, gitCommonDir: '/work/api/.git', originSha256: H('a'), projectSuggestion: 'grupo/api', linked: false, mappedClient: 'ClienteA' }) });
  const m2 = await mount(t, mapped.api);
  await act(async () => m2.state().setSelected('ClienteA'));
  await act(async () => m2.state().identify('/work/api'));
  await act(async () => m2.state().addCandidate());
  assert.equal(m2.state().dirty, false);
});

test('diagnosis shows what the server resolved', async t => {
  const { api, calls } = makeApi();
  const m = await mount(t, api);
  await act(async () => m.state().explain('/work/api'));
  assert.equal(calls.find(([n]) => n === 'explain')[1].path, '/work/api');
  assert.deepEqual([m.state().explained.formation, m.state().explained.catalogScope], ['central', 'central:ClienteA']);
});

test('client and directory names are checked before they enter the draft; removing a client removes only its repositories', async t => {
  const { api } = makeApi();
  const m = await mount(t, api);
  await act(async () => { assert.equal(m.state().addClient('bad name', 'x'), false); });
  await act(async () => { assert.equal(m.state().addClient('ClienteB', '../x'), false); });
  await act(async () => { assert.equal(m.state().addClient('ClienteA', 'z'), false); });
  assert.equal(m.state().dirty, false);
  await act(async () => { assert.equal(m.state().addClient('ClienteB', 'clienteB'), true); });
  await act(async () => m.state().removeClient('ClienteA'));
  assert.deepEqual(Object.keys(m.state().map.clients), ['ClienteB']); assert.deepEqual(m.state().map.repositories, []);
});

test('protocol: review then confirm saves with its own token and CAS; a stale review or a conflict never saves silently', async t => {
  const { api, calls } = makeApi();
  const m = await mount(t, api);
  await act(async () => m.state().setSelected('ClienteA'));
  await act(async () => {});
  assert.equal(m.state().protocolText, 'old protocol\n');
  await act(async () => m.state().setProtocolText('new protocol\n'));
  await act(async () => m.state().saveProtocol());
  assert.equal(calls.filter(([n]) => n === 'setClientProtocol').length, 0);
  await act(async () => m.state().reviewProtocol());
  await act(async () => m.state().setProtocolText('edited after review\n'));
  await act(async () => m.state().saveProtocol());
  assert.equal(calls.filter(([n]) => n === 'setClientProtocol').length, 0, 'stale review');
  await act(async () => m.state().reviewProtocol());
  await act(async () => m.state().saveProtocol());
  const sent = calls.find(([n]) => n === 'setClientProtocol')[1];
  assert.deepEqual([sent.client, sent.text, sent.expectedSha256, sent.confirm], ['ClienteA', 'edited after review\n', H('5'), H('c')]);
  const conflict = makeApi({ setClientProtocol: async () => { throw new Error('changed since it was read — reload before saving'); } });
  const m2 = await mount(t, conflict.api);
  await act(async () => m2.state().setSelected('ClienteA'));
  await act(async () => {});
  await act(async () => m2.state().setProtocolText('mine\n'));
  await act(async () => m2.state().reviewProtocol());
  await act(async () => m2.state().saveProtocol());
  assert.equal(m2.state().protocolDraft.conflict, true); assert.equal(m2.state().protocolText, 'mine\n');
});

test('pool adapters: first Save reviews, the second sends the token for the selected client only; reads map to the pool card shape', async t => {
  const { api, calls } = makeApi();
  const m = await mount(t, api);
  await act(async () => m.state().setSelected('ClienteA'));
  const pool = { version: 1, policy: 'p', quotaFallback: { enabled: false, optionId: null }, options: [] };
  const adapters = () => m.state().poolAdaptersFor('ClienteA');
  let read; await act(async () => { read = await adapters().get({ schemaVersion: 1, target: targetA }); });
  assert.deepEqual([read.sha256, read.legacy, read.legacyError, read.pool.version], [H('4'), null, null, 1]);
  const input = { schemaVersion: 1, target: targetA, pool, expectedSha256: H('4') };
  await act(async () => { await assert.rejects(adapters().set(input), /Review the impact/); });
  assert.equal(calls.filter(([n]) => n === 'setClientPool').length, 0);
  assert.deepEqual(m.state().poolImpact.result.affectedClients, ['ClienteA']); assert.equal(m.state().poolImpact.client, 'ClienteA');
  let saved; await act(async () => { saved = await adapters().set(input); });
  const sent = calls.find(([n]) => n === 'setClientPool')[1];
  assert.deepEqual([sent.client, sent.confirm, sent.expectedSha256, saved.sha256], ['ClienteA', H('c'), H('4'), H('8')]);
  const stale = makeApi({ setClientPool: async () => { throw new Error('changed since it was read — reload before saving'); } });
  const m2 = await mount(t, stale.api);
  await act(async () => m2.state().setSelected('ClienteA'));
  await act(async () => { await assert.rejects(m2.state().poolAdaptersFor('ClienteA').set(input), /Review/); });
  await act(async () => { await assert.rejects(m2.state().poolAdaptersFor('ClienteA').set(input), /peer pool changed/); });
});

test('the rendered card warns about ROUTE_DRIFT with the affected clients and what to do next, and offers no save before a valid review', async t => {
  const { api } = makeApi();
  const m = await mount(t, api);
  await act(async () => m.state().addRoot('/work/x'));
  await act(async () => m.state().reviewMap());
  const mod = m.mod; mod.primitiveState.tree = true;
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(mod.ClientsCard, { colors, compact: false, state: m.state(), poolSlot: null })); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const strings = [], buttons = [];
  const walk = node => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') { strings.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props?.accessibilityRole === 'button') buttons.push({ label: node.props.accessibilityLabel, disabled: node.props.accessibilityState?.disabled === true });
    (node.children ?? []).forEach(walk);
  };
  walk(renderer.toJSON());
  const rendered = strings.join(' ');
  assert.match(rendered, /ROUTE_DRIFT/); assert.match(rendered, /ClienteA/); assert.match(rendered, /novo requestId/);
  assert.match(rendered, /hash do mapa faz parte de todo pin central/, 'rendered in Portuguese');
  const find = label => buttons.find(button => button.label === label);
  assert.equal(find('Confirmar e salvar o mapa')?.disabled, false, 'a valid review enables the confirmed save');
  assert.equal(find('Revisar alteração do mapa')?.disabled, false);
});

test('navigation exposes the Clientes section and the Manager mounts the card with its own pool editor for the open client', async t => {
  const mod = await loadHooks(t); mod.primitiveState.tree = true;
  assert.equal(mod.managerSection({ section: 'clients' }), 'clients');
  assert.equal(mod.managerTitle({ section: 'clients' }), 'Equipes · Clientes');
  const calls = [];
  const empty = { schemaVersion: 1, pool: null, sha256: null, error: null, legacy: null, legacyError: null };
  const reads = { 'get-clients': clientsView(baseMap()), 'local-target': { daemonHome: '/home/a' }, 'get-peer-pool': empty };
  mod.paseoState.current = { agents: { list: async () => ({ entries: [] }) }, workspaces: { list: async () => ({ entries: [{ id: 'w1', name: 'api', workspaceDirectory: '/work/api' }, { id: 'w2', name: 'no dir' }] }) },
    rpc: (contract, input) => { calls.push([contract.name, input]); return reads[contract.name] ? Promise.resolve(reads[contract.name])
      : contract.name === 'get-client-files' ? Promise.resolve({ schemaVersion: 1, client: input.client, directory: 'clienteA', pool: { pool: null, sha256: null, error: null }, protocol: { text: null, sha256: null, error: null } })
      : Promise.reject(new Error('unavailable in this fixture')); } };
  let renderer;
  const props = { host: { id: 'mac', label: 'Mac' }, layout: { compact: false, platform: 'web' }, theme: { colors }, params: { section: 'clients' } };
  await act(async () => { renderer = TestRenderer.create(React.createElement(mod.ManagerSurface, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  await act(async () => {});
  const card = renderer.root.findAll(node => node.type.name === 'ClientsCard')[0];
  assert.ok(card, 'Clientes card mounted');
  assert.equal(card.props.state.data.mapState, 'valid');
  assert.deepEqual(card.props.poolSlot, [], 'no pool editor until a client is opened');
  await act(async () => card.props.state.setSelected('ClienteA'));
  await act(async () => {});
  const pools = renderer.root.findAll(node => node.type.name === 'PeerPoolCard');
  assert.equal(pools.length, 2, 'the user pool card and the client pool card are separate instances');
  const clientPool = pools.find(node => node.props.heading);
  assert.equal(clientPool.props.heading.title, 'Client Peer pool');
  assert.ok(calls.some(([name, input]) => name === 'get-client-files' && input.client === 'ClienteA'), 'the client pool is read for the open client');
  assert.equal(calls.filter(([name]) => name === 'get-peer-pool').length >= 1, true);
  await act(async () => card.props.state.loadWorkspaces());
  assert.deepEqual(card.props.state.workspaces ?? renderer.root.findAll(node => node.type.name === 'ClientsCard')[0].props.state.workspaces, [{ id: 'w1', name: 'api', directory: '/work/api' }]);
});

const twoClients = () => ({ version: 1, protectedRoots: [], clients: { ClienteA: { directory: 'clienteA' }, ClienteB: { directory: 'clienteB' } }, repositories: [] });
const filesFor = (name, text) => ({ schemaVersion: 1, client: name, directory: name.toLowerCase(), pool: { pool: { version: 1, policy: `Policy ${name}`, quotaFallback: { enabled: false, optionId: null }, options: [] }, sha256: H(name === 'ClienteA' ? 'a' : 'b'), error: null }, protocol: { text, sha256: H(name === 'ClienteA' ? 'd' : 'e'), error: null } });

test('C2: a dirty protocol draft of client A is invisible to B, never saved through B, and returns when A is reopened', async t => {
  const { api, calls } = makeApi({ getClients: async () => clientsView(twoClients()), getClientFiles: async input => filesFor(input.client, `protocol of ${input.client}\n`) });
  const m = await mount(t, api);
  await act(async () => m.state().setSelected('ClienteA')); await act(async () => {});
  await act(async () => m.state().setProtocolText('DIRTY A\n'));
  await act(async () => m.state().setSelected('ClienteB')); await act(async () => {});
  assert.equal(m.state().protocolText, 'protocol of ClienteB\n'); assert.equal(m.state().protocolDraft, null);
  await act(async () => m.state().saveProtocol());
  await act(async () => m.state().reviewProtocol());
  assert.equal(calls.filter(([n]) => n === 'setClientProtocol').length, 0);
  await act(async () => m.state().setProtocolText('DIRTY B\n'));
  await act(async () => m.state().reviewProtocol()); await act(async () => m.state().saveProtocol());
  const sent = calls.filter(([n]) => n === 'setClientProtocol').map(([, input]) => [input.client, input.text, input.expectedSha256]);
  assert.deepEqual(sent, [['ClienteB', 'DIRTY B\n', H('e')]], 'only B is saved, with B\'s own CAS hash');
  await act(async () => m.state().setSelected('ClienteA')); await act(async () => {});
  assert.equal(m.state().protocolText, 'DIRTY A\n', 'A recovers its draft');
  assert.equal(m.state().protocolDraft.baseSha, H('d'));
});

test('H-e: a pool review dies with the open client and with the target', async t => {
  const { api, calls } = makeApi();
  const m = await mount(t, api);
  const pool = { version: 1, policy: 'p', quotaFallback: { enabled: false, optionId: null }, options: [] };
  const input = { schemaVersion: 1, target: targetA, pool, expectedSha256: H('4') };
  await act(async () => m.state().setSelected('ClienteA'));
  await act(async () => { await assert.rejects(m.state().poolAdaptersFor('ClienteA').set(input), /Review the impact/); });
  await act(async () => m.state().setSelected(null)); await act(async () => m.state().setSelected('ClienteA'));
  await act(async () => { await assert.rejects(m.state().poolAdaptersFor('ClienteA').set(input), /Review the impact/); });
  assert.equal(calls.filter(([n]) => n === 'setClientPool').length, 0, 'switching client discarded the review');
  // the review recorded above (client A, target A) must not survive a target switch even if the same pool is saved straight away
  await m.switchTo(targetB);
  assert.deepEqual(m.state().opened, [], 'sessions are opened per target');
  await act(async () => { await assert.rejects(m.state().poolAdaptersFor('ClienteA').set({ ...input, target: targetB }), /Review the impact/); });
  assert.equal(calls.filter(([n]) => n === 'setClientPool').length, 0, 'switching target discarded the review');
});

test('C2: per-client pool editors keep their drafts apart: B never sees or saves the dirty pool of A, A recovers it, and a pending read never shows another client\'s pool', async t => {
  const mod = await loadHooks(t); mod.primitiveState.tree = true;
  const calls = [], pending = [];
  const three = { ...twoClients(), clients: { ...twoClients().clients, ClienteC: { directory: 'clienteC' } } };
  const reads = { 'get-clients': clientsView(three), 'local-target': { daemonHome: '/home/a' }, 'get-peer-pool': { schemaVersion: 1, pool: null, sha256: null, error: null, legacy: null, legacyError: null } };
  mod.paseoState.current = { agents: { list: async () => ({ entries: [] }) }, workspaces: { list: async () => ({ entries: [] }) },
    rpc: (contract, input) => {
      calls.push([contract.name, input]);
      if (reads[contract.name]) return Promise.resolve(reads[contract.name]);
      if (contract.name === 'get-client-files') {
        if (input.client === 'ClienteC') return new Promise(resolve => pending.push(() => resolve(filesFor('ClienteC', 'c\n'))));
        return Promise.resolve(filesFor(input.client, `p ${input.client}\n`));
      }
      if (contract.name === 'validate-clients-draft') return Promise.resolve(review({ affectedClients: [input.draft.client] }));
      return Promise.reject(new Error('unavailable in this fixture'));
    } };
  let renderer;
  const props = { host: { id: 'mac', label: 'Mac' }, layout: { compact: false, platform: 'web' }, theme: { colors }, params: { section: 'clients' } };
  await act(async () => { renderer = TestRenderer.create(React.createElement(mod.ManagerSurface, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  await act(async () => {});
  const card = () => renderer.root.findAll(node => node.type.name === 'ClientsCard')[0];
  const session = name => renderer.root.findAll(node => node.type.name === 'ClientPoolSession' && node.props.client === name)[0];
  const poolOf = name => session(name).findAll(node => node.type.name === 'PeerPoolCard')[0].props.pool;
  await act(async () => card().props.state.setSelected('ClienteA')); await act(async () => {});
  assert.equal(poolOf('ClienteA').poolForm.policy, 'Policy ClienteA');
  await act(async () => poolOf('ClienteA').updatePool(form => ({ ...form, policy: 'DIRTY-A' })));
  assert.equal(poolOf('ClienteA').poolDirty, true);
  await act(async () => card().props.state.setSelected('ClienteB')); await act(async () => {});
  assert.equal(poolOf('ClienteB').poolForm.policy, 'Policy ClienteB'); assert.equal(poolOf('ClienteB').poolDirty, false);
  assert.equal(session('ClienteA').props.active, false); assert.equal(session('ClienteB').props.active, true);
  await act(async () => { await poolOf('ClienteB').savePeerPool(); });
  const drafts = calls.filter(([n]) => n === 'validate-clients-draft').map(([, input]) => [input.draft.client, input.draft.pool.policy]);
  assert.deepEqual(drafts, [['ClienteB', 'Policy ClienteB']], 'B validates and would save its own pool, never A\'s draft');
  assert.equal(calls.filter(([n]) => n === 'set-client-pool').length, 0);
  await act(async () => card().props.state.setSelected('ClienteA'));
  assert.equal(poolOf('ClienteA').poolForm.policy, 'DIRTY-A', 'A recovers its dirty draft'); assert.equal(poolOf('ClienteA').poolDirty, true);
  // a client whose read is still pending shows nothing of another client
  await act(async () => card().props.state.setSelected('ClienteC'));
  assert.equal(poolOf('ClienteC').poolData, null); assert.notEqual(poolOf('ClienteC').poolForm.policy, 'Policy ClienteA');
  await act(async () => { pending.forEach(resolve => resolve()); });
  await act(async () => {});
  assert.equal(poolOf('ClienteC').poolForm.policy, 'Policy ClienteC');
  // closing the open client keeps every editor mounted: the dirty draft of A is still there afterwards
  await act(async () => card().props.state.setSelected(null));
  assert.equal(poolOf('ClienteA').poolForm.policy, 'DIRTY-A'); assert.equal(session('ClienteA').props.active, false);
  // removing the client whose editor is dirty must not hand that editor's state to another client
  await act(async () => card().props.state.setSelected('ClienteA'));
  await act(async () => card().props.state.removeClient('ClienteA'));
  assert.equal(session('ClienteA'), undefined);
  assert.deepEqual(card().props.state.opened, ['ClienteB', 'ClienteC']);
  assert.equal(poolOf('ClienteB').poolForm.policy, 'Policy ClienteB'); assert.equal(poolOf('ClienteB').poolDirty, false);
  assert.equal(poolOf('ClienteC').poolForm.policy, 'Policy ClienteC'); assert.equal(poolOf('ClienteC').poolDirty, false);
});

// ---------------------------------------------------------------------------
// P1/P2/P3/P4/P5: project list, individual + batch bind, strict, rules, v2
// ---------------------------------------------------------------------------
test('P1/P3: the card loads every project from the server on open (workspaces in, rows out), counts the pending ones and shows the draft binding next to the saved one', async t => {
  const { api, calls } = makeProjectApi();
  const m = await mount(t, api);
  const list = calls.find(([n]) => n === 'listProjects')[1];
  assert.deepEqual(list.workspaces.map(w => [w.id, w.path]), [['w1', '/work/api'], ['w2', '/work/api-wt'], ['w3', '/work/novo'], ['w4', '/work/rascunho']], 'only ids, names and paths go to the server; identity is computed there');
  assert.equal(m.state().projects.pending, 2); assert.equal(m.state().projectRows.length, 4);
  assert.equal(m.state().pendingInDraft, 2, 'the not-git row has no common dir and is not counted');
  const api0 = m.state().projectRows.find(r => r.name === 'api'); assert.deepEqual([api0.draftClient, api0.changed], ['ClienteA', false]);
});

test('P1: individual bind adds the server-computed identity to the draft; a re-bind replaces the entry; unbind removes it; nothing is saved', async t => {
  const { api, calls } = makeProjectApi();
  const m = await mount(t, api);
  await act(async () => m.state().bindProjects(['/work/novo/.git'], null));
  assert.match(m.state().errorText, /Choose the client/); assert.equal(m.state().dirty, false);
  await act(async () => m.state().bindProjects(['/work/novo/.git'], 'ClienteA'));
  assert.deepEqual(m.state().map.repositories.at(-1), { client: 'ClienteA', project: 'grupo/novo', gitCommonDir: '/work/novo/.git', originSha256: H('b') });
  assert.equal(m.state().dirty, true); assert.equal(m.state().pendingInDraft, 1);
  assert.equal(m.state().projectRows.find(r => r.name === 'novo').changed, true);
  assert.equal(calls.filter(([n]) => n === 'setClients').length, 0);
  await act(async () => m.state().unbindProject('/work/novo/.git'));
  assert.equal(m.state().map.repositories.some(r => r.gitCommonDir === '/work/novo/.git'), false);
  await act(async () => m.state().edit(next => { next.clients.ClienteB = { directory: 'clienteB' }; }));
  await act(async () => m.state().bindProjects(['/work/api/.git'], 'ClienteB'));
  const rebound = m.state().map.repositories.filter(r => r.gitCommonDir === '/work/api/.git');
  assert.deepEqual(rebound.map(r => [r.client, r.project]), [['ClienteB', 'grupo/api']], 'one entry per repository; the project name is kept');
});

test('P1: batch bind selects several projects (all without a client in one press), binds them to the chosen client in ONE draft edit, and skips what cannot be bound', async t => {
  const { api } = makeProjectApi();
  const m = await mount(t, api);
  await act(async () => m.state().pickPending());
  assert.deepEqual(m.state().picked.sort(), ['/work/novo/.git', '/work/rascunho/.git']);
  await act(async () => m.state().pickProject('path:/work/plain', true));
  await act(async () => m.state().bindProjects(m.state().picked, 'ClienteA'));
  const added = m.state().map.repositories.filter(r => r.gitCommonDir !== '/work/api/.git');
  assert.deepEqual(added.map(r => r.gitCommonDir).sort(), ['/work/novo/.git', '/work/rascunho/.git'], 'the not-git row is skipped');
  assert.equal(m.state().pendingInDraft, 0); assert.deepEqual(m.state().picked, []);
});

test('P4: binding a local-only project writes originSha256 null and upgrades a version 1 draft to version 2 (strict stays off)', async t => {
  const { api } = makeProjectApi();
  const m = await mount(t, api);
  assert.equal(m.state().map.version, 1);
  await act(async () => m.state().bindProjects(['/work/novo/.git'], 'ClienteA'));
  assert.equal(m.state().map.version, 1, 'a project with an origin does not need version 2');
  await act(async () => m.state().bindProjects(['/work/rascunho/.git'], 'ClienteA'));
  assert.equal(m.state().map.version, 2); assert.equal(m.state().map.strict, false);
  assert.equal(m.state().map.repositories.find(r => r.gitCommonDir === '/work/rascunho/.git').originSha256, null);
});

test('P2: the strict switch edits the draft only, upgrades version 1 to 2, and the review warns what strict will block', async t => {
  const { api, calls } = makeProjectApi({ validate: async () => review({ warnings: ['strict mode: every project without a client is blocked at seat formation and at agent creation until it is bound on this screen; creating the project itself is never blocked'] }) });
  const m = await mount(t, api);
  await act(async () => m.state().setStrict(true));
  assert.deepEqual([m.state().map.version, m.state().map.strict, m.state().dirty], [2, true, true]);
  assert.equal(calls.filter(([n]) => n === 'setClients').length, 0);
  await act(async () => m.state().reviewMap());
  assert.match(m.state().draft.review.result.warnings[0], /creating the project itself is never blocked/);
  await act(async () => m.state().setStrict(false));
  assert.equal(m.state().map.strict, false);
});

test('P5: rules are edited per scope in the draft: global vs client, inherit (drop key) vs switch off (null), empty holders vanish, and a v1 draft becomes v2', async t => {
  const { api } = makeProjectApi();
  const m = await mount(t, api);
  await act(async () => m.state().setRule(null, 'aiFooter', 'forbid'));
  assert.deepEqual([m.state().map.version, m.state().map.rules], [2, { aiFooter: 'forbid' }]);
  await act(async () => m.state().setRule('ClienteA', 'aiFooter', null));
  assert.deepEqual(m.state().map.clients.ClienteA.rules, { aiFooter: null }, 'null switches the inherited key off');
  await act(async () => m.state().setRule('ClienteA', 'origin', { kind: 'azure', organization: 'DW', project: 'SAFER' }));
  await act(async () => m.state().setRule('ClienteA', 'aiFooter', undefined));
  assert.deepEqual(Object.keys(m.state().map.clients.ClienteA.rules), ['origin'], 'inherit drops the key');
  await act(async () => m.state().setRule('ClienteA', 'origin', undefined));
  assert.equal('rules' in m.state().map.clients.ClienteA, false);
  await act(async () => m.state().setRule(null, 'aiFooter', undefined));
  assert.equal('rules' in m.state().map, false);
  await act(async () => m.state().setRule('Inexistente', 'aiFooter', 'allow'));
  assert.equal(m.state().map.clients.Inexistente, undefined);
});

test('P2/P5: a map created on this screen is version 2, strict, with the SUGGESTED rules in the draft only (nothing is written until review + confirm)', async t => {
  const { api, calls, setCurrent } = makeProjectApi();
  setCurrent(clientsView(null));
  const m = await mount(t, api);
  assert.deepEqual([m.state().map.version, m.state().map.strict], [2, true]);
  assert.deepEqual(m.state().map.rules, { titleFormat: 'origin-id - pt-title', aiFooter: 'forbid' }, 'no personal commit identity is suggested');
  assert.equal(m.state().dirty, false, 'suggestions are not a pending change by themselves');
  await act(async () => m.state().addClient('ClienteA', 'clienteA'));
  assert.equal(m.state().dirty, true);
  assert.equal(calls.filter(([n]) => n === 'setClients').length, 0);
  const sent = JSON.stringify(m.state().map);
  await act(async () => m.state().reviewMap());
  assert.equal(JSON.stringify(calls.find(([n]) => n === 'validate')[1].draft.map), sent, 'the reviewed bytes are the draft shown');
});

test('P3: saving the map reloads the project list so pending counts reflect the new binding', async t => {
  const { api, calls } = makeProjectApi();
  const m = await mount(t, api);
  await act(async () => m.state().bindProjects(['/work/novo/.git'], 'ClienteA'));
  await act(async () => m.state().reviewMap());
  const before = calls.filter(([n]) => n === 'listProjects').length;
  await act(async () => m.state().saveMap());
  assert.equal(calls.filter(([n]) => n === 'listProjects').length, before + 1);
});

test('P1/P2/P3/P5/P6: the rendered card shows the project list with pending, local-only and identity badges, the strict switch and the rules editors, all in Portuguese', async t => {
  const rows = [
    projectRow({ key: '/work/api/.git', state: 'bound', name: 'api', gitCommonDir: '/work/api/.git', client: 'ClienteA', projectSuggestion: 'grupo/api',
      identity: { state: 'differs', expected: { name: 'Nome Exemplo', email: 'exemplo@example.invalid' }, effective: { name: 'Outra', email: 'outra@example.invalid' }, local: { name: 'Outra', email: 'outra@example.invalid' } } }),
    projectRow({ key: '/work/rascunho/.git', name: 'rascunho', gitCommonDir: '/work/rascunho/.git', originSha256: null, localOnly: true, projectSuggestion: 'rascunho' }),
    projectRow({ key: '/work/blocked/.git', state: 'blocked', name: 'bloqueado', gitCommonDir: '/work/blocked/.git', code: 'CLIENT_IDENTITY_DRIFT', reason: 'remote identity drift: origin differs from the client map entry' }),
  ];
  const { api } = makeProjectApi({ listProjects: async () => projectsView(rows) });
  const m = await mount(t, api);
  await act(async () => m.state().setStrict(true));
  const mod = m.mod; mod.primitiveState.tree = true;
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(mod.ClientsCard, { colors, compact: false, state: m.state(), poolSlot: null })); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const strings = [];
  const walk = node => { if (node === null || node === undefined) return; if (typeof node === 'string') { strings.push(node); return; } if (Array.isArray(node)) { node.forEach(walk); return; } (node.children ?? []).forEach(walk); };
  walk(renderer.toJSON());
  const text = strings.join(' | ');
  for (const expected of [/Projetos do Paseo/, /1 sem cliente/, /Somente local/, /Identidade Git diverge/, /Aviso somente leitura; nada foi alterado/, /Regra: Nome Exemplo/, /no Git: Outra/, /diverge/, /Bloqueado/, /Modo estrito/, /Regras globais/, /Identidade de commit/, /Rodapé de IA/,
    /O modo estrito está ligado e 2 projeto\(s\) sem cliente neste rascunho/, /Um projeto sem cliente é bloqueado na formação de assentos e na criação de agentes/]) assert.match(text, expected);
  assert.equal(/Strict mode|Paseo projects|Local only/.test(text), false, 'no English left on the new surface');
});

test('F1: a row in CLIENT_IDENTITY_DRIFT is never re-fixed by "bind" (single or batch); accepting the new identity is a separate propose/confirm step that edits only the draft', async t => {
  const rows = [
    projectRow({ key: '/work/api/.git', state: 'blocked', name: 'api', gitCommonDir: '/work/api/.git', client: 'ClienteA', originSha256: H('e'), code: 'CLIENT_IDENTITY_DRIFT', reason: 'remote identity drift: origin differs from the client map entry' }),
    projectRow({ key: '/work/rascunho/.git', state: 'blocked', name: 'rascunho', gitCommonDir: '/work/rascunho/.git', client: 'ClienteA', originSha256: null, localOnly: true, code: 'CLIENT_IDENTITY_DRIFT' }),
    projectRow({ key: '/work/novo/.git', name: 'novo', gitCommonDir: '/work/novo/.git', originSha256: H('b') }),
  ];
  const current = clientsView({ ...baseMap(), repositories: [...baseMap().repositories, { client: 'ClienteA', project: 'rascunho', gitCommonDir: '/work/rascunho/.git', originSha256: H('d') }] });
  const { api, calls, setCurrent } = makeProjectApi({ listProjects: async () => projectsView(rows) });
  setCurrent(current);
  const m = await mount(t, api);
  await act(async () => m.state().bindProjects(['/work/api/.git'], 'ClienteA'));
  assert.equal(m.state().dirty, false, 'single bind of a drifted row does nothing'); assert.match(m.state().errorText, /None of the selected projects can be bound/);
  await act(async () => m.state().pickPending());
  assert.deepEqual(m.state().picked, ['/work/novo/.git'], 'batch selection never includes a drifted row');
  await act(async () => m.state().bindProjects(['/work/api/.git', '/work/rascunho/.git'], 'ClienteA'));
  assert.equal(m.state().map.repositories.find(r => r.gitCommonDir === '/work/api/.git').originSha256, H('a'));
  await act(async () => m.state().acceptIdentity('/work/api/.git'));
  assert.equal(m.state().dirty, false, 'accepting without proposing first does nothing');
  await act(async () => m.state().proposeIdentity('/work/api/.git'));
  assert.deepEqual(m.state().identityChange('/work/api/.git'), { from: H('a'), to: H('e') });
  await act(async () => m.state().cancelIdentity());
  await act(async () => m.state().acceptIdentity('/work/api/.git'));
  assert.equal(m.state().dirty, false, 'cancel really cancels');
  await act(async () => m.state().proposeIdentity('/work/api/.git'));
  await act(async () => m.state().acceptIdentity('/work/api/.git'));
  assert.equal(m.state().map.repositories.find(r => r.gitCommonDir === '/work/api/.git').originSha256, H('e'));
  assert.equal(m.state().map.repositories.find(r => r.gitCommonDir === '/work/api/.git').client, 'ClienteA', 'the client is kept');
  assert.equal(calls.filter(([n]) => n === 'setClients').length, 0, 'nothing is saved');
  await act(async () => m.state().proposeIdentity('/work/rascunho/.git'));
  assert.deepEqual(m.state().identityChange('/work/rascunho/.git'), { from: H('d'), to: null });
  await act(async () => m.state().acceptIdentity('/work/rascunho/.git'));
  assert.equal(m.state().map.repositories.find(r => r.gitCommonDir === '/work/rascunho/.git').originSha256, null);
  assert.equal(m.state().map.version, 2, 'local-only needs version 2');
  // rendering: the drifted row shows the separate action, in Portuguese, and no plain bind for it
  await act(async () => m.state().proposeIdentity('/work/api/.git'));
  const mod = m.mod; mod.primitiveState.tree = true;
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(mod.ClientsCard, { colors, compact: false, state: m.state(), poolSlot: null })); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const strings = []; const buttons = [];
  const walk = node => { if (node == null) return; if (typeof node === 'string') { strings.push(node); return; } if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.props?.accessibilityRole === 'button') buttons.push({ label: node.props.accessibilityLabel, disabled: node.props.accessibilityState?.disabled === true }); (node.children ?? []).forEach(walk); };
  walk(renderer.toJSON());
  const text = strings.join(' | ');
  assert.match(text, /Deriva de identidade/); assert.match(text, /Vincular não corrige um repositório cuja identidade derivou/);
  assert.match(text, /Identidade salva/); assert.match(text, /Nova identidade/);
  assert.ok(buttons.some(b => b.label === 'Confirmar a nova identidade' && !b.disabled)); assert.ok(buttons.some(b => b.label === 'Aceitar a nova identidade'));
  assert.equal(buttons.filter(b => b.label === 'Vincular ao cliente escolhido' && b.disabled).length >= 2, true, 'plain bind is disabled for drifted rows');
});

// ---------------------------------------------------------------------------
// Fase 3b: the row is the Paseo PROJECT; containers (folders without Git)
// ---------------------------------------------------------------------------
const folderRow = (over = {}) => projectRow({ key: 'path:/work/Geral', kind: 'folder', name: 'DWLaw / Geral', projectId: 'p-geral', projectLabel: 'DWLaw / Geral', projects: [{ id: 'p-geral', label: 'DWLaw / Geral' }],
  repoName: 'Geral', workspaceCount: 2, mainPath: '/work/Geral', gitCommonDir: null, originSha256: null, projectSuggestion: 'Geral', ...over });
const textOf = renderer => { const out = []; const walk = n => { if (n == null) return; if (typeof n === 'string') { out.push(n); return; } if (Array.isArray(n)) { n.forEach(walk); return; } (n.children ?? []).forEach(walk); }; walk(renderer.toJSON()); return out.join(' | '); };
const buttonsOf = renderer => { const out = []; const walk = n => { if (n == null || typeof n === 'string') return; if (Array.isArray(n)) { n.forEach(walk); return; } if (n.props?.accessibilityRole === 'button') out.push({ label: n.props.accessibilityLabel, disabled: n.props.accessibilityState?.disabled === true }); (n.children ?? []).forEach(walk); }; walk(renderer.toJSON()); return out; };

test('W1: the host descriptor becomes a workspace with its Paseo PROJECT (custom name wins, kinds validated, no directory = skipped, relative root dropped)', async t => {
  const mod = await loadHooks(t);
  const entry = { id: 'w1', name: 'Corrige erro 500', workspaceDirectory: '/work/api-wt', projectId: 'p1', projectDisplayName: 'CemigSim / client-area-api', projectCustomName: 'CemigSim / API', projectRootPath: '/work/api', projectKind: 'git', workspaceKind: 'worktree' };
  assert.deepEqual(mod.workspaceOfEntry(entry), [{ id: 'w1', name: 'Corrige erro 500', directory: '/work/api-wt', projectId: 'p1', projectLabel: 'CemigSim / API', projectRootPath: '/work/api', projectKind: 'git', workspaceKind: 'worktree' }]);
  assert.equal(mod.workspaceOfEntry({ ...entry, projectCustomName: null })[0].projectLabel, 'CemigSim / client-area-api');
  assert.deepEqual(mod.workspaceOfEntry({ id: 'w2', name: 'n', directory: '/x', projectId: 'p', projectDisplayName: 'P', projectRootPath: 'relative', projectKind: 'weird', kind: 'local_checkout' }),
    [{ id: 'w2', name: 'n', directory: '/x', projectId: 'p', projectLabel: 'P', workspaceKind: 'local_checkout' }], 'the SDK snapshot shape (directory/kind) also works; invalid values are dropped');
  assert.deepEqual(mod.workspaceOfEntry({ id: 'w3', name: 'n' }), []); assert.deepEqual(mod.workspaceOfEntry(null), []);
  assert.deepEqual(mod.workspaceOfEntry({ id: 'w4', name: 'n', workspaceDirectory: '/y' }), [{ id: 'w4', name: 'n', directory: '/y' }], 'an entry without project info still works');
});

test('W1/W2: the card sends the project fields with every workspace, and a repository with 3 worktrees + 1 local checkout is ONE row named by the project with "4 workspaces"', async t => {
  const workspaces = [{ id: 'a', name: 'main', directory: '/work/api', projectId: 'p1', projectLabel: 'CemigSim / client-area-api', projectKind: 'git', workspaceKind: 'local_checkout' },
    ...['b', 'c', 'd'].map((id, i) => ({ id, name: `tarefa ${i}`, directory: `/work/api-wt${i}`, projectId: 'p1', projectLabel: 'CemigSim / client-area-api', projectKind: 'git', workspaceKind: 'worktree' }))];
  const row = projectRow({ key: '/work/api/.git', name: 'CemigSim / client-area-api', projectId: 'p1', projectLabel: 'CemigSim / client-area-api', projects: [{ id: 'p1', label: 'CemigSim / client-area-api' }], repoName: 'api', workspaceCount: 4, mainPath: '/work/api', gitCommonDir: '/work/api/.git', workspaceIds: ['a', 'b', 'c', 'd'] });
  let sentInput = null;
  const { api } = makeApi({ listWorkspaces: async () => workspaces, listProjects: async input => { sentInput = input; return projectsView([row]); } });
  const m = await mount(t, api);
  const sent = sentInput.workspaces;
  assert.deepEqual(sent[1], { id: 'b', name: 'tarefa 0', path: '/work/api-wt0', projectId: 'p1', projectLabel: 'CemigSim / client-area-api', projectKind: 'git', workspaceKind: 'worktree' }, 'flat optional fields, directory renamed to path');
  assert.equal(m.state().projectRows.length, 1); assert.equal(m.state().projectRows[0].workspaceCount, 4);
  const mod = m.mod; mod.primitiveState.tree = true;
  let renderer; await act(async () => { renderer = TestRenderer.create(React.createElement(mod.ClientsCard, { colors, compact: false, state: m.state(), poolSlot: null })); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const text = textOf(renderer);
  assert.match(text, /CemigSim \/ client-area-api/); assert.match(text, /Workspaces \| 4/); assert.match(text, /Checkout principal \| \/work\/api/);
  for (const title of ['tarefa 0', 'tarefa 1', 'tarefa 2']) assert.equal(text.includes(title), false, 'a workspace title is never shown as the row');
});

test('W4/(a): a project with several repositories is grouped under its name with one row per repository; two projects for one repository warn about the duplicate', async t => {
  const rows = [
    projectRow({ key: '/w/a/.git', name: 'DWLaw / Portal', projectId: 'pp', projectLabel: 'DWLaw / Portal', projects: [{ id: 'pp', label: 'DWLaw / Portal' }], repoName: 'portal-api', mainPath: '/w/a', gitCommonDir: '/w/a/.git', originSha256: H('a') }),
    projectRow({ key: '/w/b/.git', name: 'DWLaw / Portal', projectId: 'pp', projectLabel: 'DWLaw / Portal', projects: [{ id: 'pp', label: 'DWLaw / Portal' }], repoName: 'portal-web', mainPath: '/w/b', gitCommonDir: '/w/b/.git', originSha256: H('b') }),
    projectRow({ key: '/w/p/.git', name: 'Pessoal / Paseo Plugins', projectId: 'p1', projectLabel: 'Pessoal / Paseo Plugins', projects: [{ id: 'p2', label: 'Pessoal / Paseo Plugins' }, { id: 'p1', label: 'Pessoal / paseo-plugins' }], repoName: 'paseo-plugins', mainPath: '/w/p', gitCommonDir: '/w/p/.git', originSha256: H('c') }),
  ];
  const { api } = makeApi({ listProjects: async () => projectsView(rows) });
  const m = await mount(t, api);
  const mod = m.mod; mod.primitiveState.tree = true;
  let renderer; await act(async () => { renderer = TestRenderer.create(React.createElement(mod.ClientsCard, { colors, compact: false, state: m.state(), poolSlot: null })); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const text = textOf(renderer);
  assert.match(text, /DWLaw \/ Portal \| 2 repositórios/); assert.match(text, /portal-api/); assert.match(text, /portal-web/);
  assert.match(text, /Projetos duplicados para um mesmo repositório: Pessoal \/ Paseo Plugins \| Pessoal \/ paseo-plugins\. Um único vínculo cobre todos/);
});

test('W5: the client prefix of the project label is only a SUGGESTION — shown, pre-selected on pick, never bound until a human acts', async t => {
  const mod = await loadHooks(t);
  assert.equal(mod.suggestedClientOf('CemigSim / client-area-api', ['ClienteA', 'cemigsim']), 'cemigsim', 'case-insensitive match against the map\'s clients');
  assert.equal(mod.suggestedClientOf('Financeiro', ['Financeiro']), 'Financeiro'); assert.equal(mod.suggestedClientOf('Outro / x', ['ClienteA']), null); assert.equal(mod.suggestedClientOf(null, ['ClienteA']), null);
  const row = projectRow({ key: '/w/c/.git', name: 'ClienteA / api', projectId: 'p', projectLabel: 'ClienteA / api', projects: [{ id: 'p', label: 'ClienteA / api' }], repoName: 'api', mainPath: '/w/c', gitCommonDir: '/w/c/.git' });
  const { api, calls } = makeApi({ listProjects: async () => projectsView([row]) });
  const m = await mount(t, api);
  assert.equal(m.state().projectRows[0].suggestedClient, 'ClienteA');
  assert.deepEqual([m.state().dirty, m.state().bindTo, m.state().map.repositories.length], [false, null, 1], 'loading binds nothing');
  await act(async () => m.state().pickProject('/w/c/.git', true));
  assert.equal(m.state().bindTo, 'ClienteA', 'the suggestion is pre-selected'); assert.equal(m.state().dirty, false, 'but nothing is bound');
  await act(async () => m.state().setBindTo('Outro')); await act(async () => m.state().pickProject('/w/c/.git', false)); await act(async () => m.state().pickProject('/w/c/.git', true));
  assert.equal(m.state().bindTo, 'Outro', 'a choice already made is not overridden');
  assert.equal(calls.filter(([n]) => n === 'setClients').length, 0);
  const mod2 = m.mod; mod2.primitiveState.tree = true;
  let renderer; await act(async () => { renderer = TestRenderer.create(React.createElement(mod2.ClientsCard, { colors, compact: false, state: m.state(), poolSlot: null })); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  assert.match(textOf(renderer), /Cliente sugerido: ClienteA/); assert.ok(buttonsOf(renderer).some(b => b.label === 'Vincular a ClienteA' && !b.disabled), 'an explicit button, pressed by a human');
});

test('containers: a folder without Git binds as a container only when the server says the runtime can read it; HOME is never bindable; a folder above other projects needs its own confirmation; unbind removes it', async t => {
  const geral = folderRow();
  const home = folderRow({ key: 'path:/home/u', name: 'Pessoal / Casa', projectId: 'p-casa', projectLabel: 'Pessoal / Casa', projects: [{ id: 'p-casa', label: 'Pessoal / Casa' }], repoName: 'u', mainPath: '/home/u', state: 'not-git', containerBlocked: 'container /home/u is the user home, a system root or a folder that contains the home: it would cover everything, so it can never be bound', reason: 'x' });
  const inner = projectRow({ key: '/work/Geral/repo/.git', name: 'Repo', mainPath: '/work/Geral/repo', gitCommonDir: '/work/Geral/repo/.git', originSha256: H('9') });
  const { api, calls } = makeApi({ listProjects: async () => projectsView([geral, home, inner]) });
  const m = await mount(t, api);
  assert.deepEqual([m.state().canBind(m.state().projectRows[0]), m.state().canBind(m.state().projectRows[1])], [true, false], 'HOME is not bindable');
  await act(async () => m.state().bindProjects(['path:/home/u'], 'ClienteA'));
  assert.equal(m.state().dirty, false); assert.match(m.state().errorText, /None of the selected projects can be bound/);
  assert.equal(m.state().coversOf(m.state().projectRows[0]), 1, 'one Git repository sits below the folder');
  await act(async () => m.state().bindProjects(['path:/work/Geral'], 'ClienteA'));
  assert.equal(m.state().dirty, false, 'unconfirmed: nothing is bound'); assert.match(m.state().errorText, /separate confirmation/);
  await act(async () => m.state().confirmCover('path:/work/Geral'));
  await act(async () => m.state().bindProjects(['path:/work/Geral'], 'ClienteA'));
  assert.deepEqual(m.state().map.containers, [{ client: 'ClienteA', project: 'DWLaw / Geral', path: '/work/Geral' }]);
  assert.equal(m.state().map.version, 2, 'containers need version 2'); assert.equal(m.state().projectRows[0].draftClient, 'ClienteA');
  assert.equal(calls.filter(([n]) => n === 'setClients').length, 0, 'nothing is saved by binding');
  await act(async () => m.state().unbindProject('path:/work/Geral'));
  assert.equal('containers' in m.state().map, false);
});

test('containers: without the capability the folder row shows the server reason in Portuguese and offers no bind', async t => {
  const geral = folderRow();
  const view = clientsView(baseMap(), H('1'), { containerWrites: { allowed: false, reason: 'containers are not saved: the bound runtime does not declare clientContainers; update the runtime first' } });
  const { api, setCurrent } = makeApi({ listProjects: async () => projectsView([geral]) });
  setCurrent(view);
  const m = await mount(t, api);
  assert.equal(m.state().canBind(m.state().projectRows[0]), false); assert.equal(m.state().containerOk, false);
  await act(async () => m.state().bindProjects(['path:/work/Geral'], 'ClienteA'));
  assert.equal(m.state().dirty, false);
  const mod = m.mod; mod.primitiveState.tree = true;
  let renderer; await act(async () => { renderer = TestRenderer.create(React.createElement(mod.ClientsCard, { colors, compact: false, state: m.state(), poolSlot: null })); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const text = textOf(renderer);
  assert.match(text, /Pasta sem Git/); assert.match(text, /Pasta do projeto \| \/work\/Geral/); assert.match(text, /pastas de projeto não são salvas: o runtime vinculado não declara clientContainers/);
  assert.ok(buttonsOf(renderer).filter(b => /^Vincular/.test(b.label ?? '')).every(b => b.disabled));
});
