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
  mapError: null, hostErrors: [], mapExternalChange: false,
  clients: map ? Object.entries(map.clients).map(([name, { directory }]) => ({ name, directory, referenced: true, repositories: 1, routingSha256: H('2'), protocolSha256: H('3'), options: 1, error: null, externalChange: false })) : [], ...extra });
const review = (over = {}) => ({ schemaVersion: 1, ok: true, errors: [], warnings: [], confirm: H('c'), affectedClients: ['ClienteA'], mapHashChanges: true, ...over });

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
