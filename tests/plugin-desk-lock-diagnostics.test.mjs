// tests/plugin-desk-lock-diagnostics.test.mjs — desk lock ownership diagnostics.
//
// The bridge lifecycle lock (repos/<sha256("desk-bridge|desk-bus")>/lock) and
// the per-repo commit lock share one holder record {pid, instanceNonce,
// startedAt}. A holder with the same pid but another instanceNonce is NOT
// "another process": it is another instance in THIS process (a previous plugin
// instance, or a parallel one) and may still be alive. These tests pin:
//   - the four holder relations (self / same process other instance / other
//     process alive / dead) and the diagnostic each one produces;
//   - the invariant that a lock owned by anyone else is never removed;
//   - the self-cleanup of a lock file this very call created when write/fsync
//     fails, never a file another owner put at the path;
//   - commit() never loses its result or its original error to a failing
//     lock release.
// Everything lives under tmpdir(); nothing touches a real daemon home.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeskStore, deskRepoPaths, repoKeyFor } from '../plugin/server/desk-store.ts';
import { OperationConflict } from '../plugin/shared/contracts.ts';
import * as lockHolder from '../plugin/server/runtime/lock-holder.ts';
import { bridgeFixture, startBridge } from './helpers/desk-bridge-fixture.mjs';

const PIN = 'a'.repeat(64);
const AT = '2026-01-01T00:00:00.000Z';
const NOW = () => new Date('2026-01-01T00:02:05.000Z'); // 125 s after AT → "2m 5s"
const REPO = { hostId: 'host-test', gitCommonDir: '/repo/.git' };
const REPO_KEY = repoKeyFor(REPO);
const BRIDGE_KEY = repoKeyFor({ hostId: 'desk-bridge', gitCommonDir: 'desk-bus' });

const holderBytes = (pid, instanceNonce, startedAt = AT) => JSON.stringify({ pid, instanceNonce, startedAt }) + '\n';

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  await new Promise(resolve => child.once('exit', resolve));
  return child.pid;
}

// --- pure helpers ------------------------------------------------------------

test('lock holder relation: pid and nonce decide self / same-process other instance / other process', () => {
  const self = { pid: 10, instanceNonce: 'me' };
  assert.equal(lockHolder.relateLockHolder({ pid: 10, instanceNonce: 'me' }, self), 'self');
  assert.equal(lockHolder.relateLockHolder({ pid: 10, instanceNonce: 'old' }, self), 'same-process-other-instance');
  assert.equal(lockHolder.relateLockHolder({ pid: 11, instanceNonce: 'me' }, self), 'other-process');
  assert.equal(lockHolder.relateLockHolder({ pid: 11, instanceNonce: 'old' }, self), 'other-process');
});

test('lock holder age is derived from startedAt and never invented', () => {
  const at = Date.parse(AT);
  assert.equal(lockHolder.formatLockAge(AT, at + 5_000), '5s');
  assert.equal(lockHolder.formatLockAge(AT, at + 125_000), '2m 5s');
  assert.equal(lockHolder.formatLockAge(AT, at + (3 * 3600 + 7 * 60) * 1000), '3h 7m');
  assert.equal(lockHolder.formatLockAge(AT, at + (35 * 3600 + 2 * 60) * 1000), '1d 11h');
  assert.match(lockHolder.formatLockAge(undefined, at), /unknown/);
  assert.match(lockHolder.formatLockAge('not-a-date', at), /unknown/);
  assert.match(lockHolder.formatLockAge(AT, at - 1000), /unknown/);
});

// --- bridge lifecycle lock ---------------------------------------------------

function bridgeLock(t, bytes, over = {}) {
  const f = bridgeFixture(t, 'slp-lock-diag-', PIN, { now: NOW, ...over });
  mkdirSync(f.paths.repoDir, { recursive: true });
  if (bytes !== null) writeFileSync(f.paths.lockPath, bytes);
  return f;
}

function assertHolderDetails(reason, f, { pid, nonce }) {
  assert.ok(reason.includes(`pid ${pid}`), `pid in: ${reason}`);
  assert.ok(reason.includes(nonce), `nonce in: ${reason}`);
  assert.ok(reason.includes('age 2m 5s'), `age in: ${reason}`);
  assert.ok(reason.includes(`repoKey ${f.paths.repoKey}`), `labelled repoKey in: ${reason}`);
  assert.ok(reason.includes(f.paths.lockPath), `lock path in: ${reason}`);
}

test('bridge: a lock held by ANOTHER live process is desk-busy with full diagnostics and the file is byte-intact', async t => {
  const bytes = holderBytes(424242, 'foreign-live');
  const f = bridgeLock(t, bytes, { kill: () => { /* alive */ } });
  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'unavailable');
  const { code, reason } = f.bridge.state();
  assert.equal(code, 'CAPABILITY_GAP');
  assert.match(reason, /desk-busy/);
  assert.match(reason, /do not respawn the bridge/);
  assert.match(reason, /another process/);
  assert.doesNotMatch(reason, /same process/);
  assertHolderDetails(reason, f, { pid: 424242, nonce: 'foreign-live' });
  assert.match(reason, /desk-recover --bridge/);
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), bytes, 'foreign live lock is never rewritten or removed');
  assert.equal(existsSync(deskRepoPaths(f.stableRoot, f.paths.repoKey).auditPath), false);
  assert.equal(f.paths.repoKey, BRIDGE_KEY);
});

test('bridge: same pid with another instanceNonce is a previous/parallel instance in THIS process — diagnosed, never removed', async t => {
  const bytes = holderBytes(process.pid, 'previous-instance');
  const f = bridgeLock(t, bytes);
  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'unavailable');
  const { code, reason } = f.bridge.state();
  assert.equal(code, 'CAPABILITY_GAP');
  assert.match(reason, /desk-busy/);
  assert.match(reason, /same process/);
  assert.doesNotMatch(reason, /another process/);
  assertHolderDetails(reason, f, { pid: process.pid, nonce: 'previous-instance' });
  assert.match(reason, /refuses a live pid/);
  assert.match(reason, /restart/);
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), bytes, 'same-process lock is never removed automatically');
  assert.equal(existsSync(deskRepoPaths(f.stableRoot, f.paths.repoKey).auditPath), false);
  assert.equal(existsSync(f.paths.socketPath), false);
});

test('bridge: a second instance in the same process sees the live first instance; stop() frees the next start', async t => {
  const f = bridgeLock(t, null);
  const first = await startBridge(t, f);
  assert.equal(first.outcome, 'listening');
  const ownBytes = readFileSync(f.paths.lockPath, 'utf8');
  const second = f.makeBridge();
  t.after(() => second.stop());
  void second.start();
  assert.equal(await second.whenReady(), 'unavailable');
  assert.match(second.state().reason, /same process/);
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), ownBytes, 'the live first instance keeps its lock');
  assert.equal(f.bridge.state().kind, 'listening');

  f.bridge.stop();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(existsSync(f.paths.lockPath), false, 'a clean stop releases the lifecycle lock');
  const third = f.makeBridge();
  t.after(() => third.stop());
  void third.start();
  assert.equal(await third.whenReady(), 'listening', 'no permanent block once the owner stopped');
});

test('bridge: re-entry by the very same instance (pid + nonce) is adopted', async t => {
  const f = bridgeLock(t, holderBytes(process.pid, 'adopt-me'), { uuid: () => 'adopt-me' });
  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'listening');
});

test('bridge: an uncertain holder (EPERM) stays RECOVERY_REQUIRED with diagnostics and an intact file', async t => {
  const bytes = holderBytes(424242, 'uncertain');
  const f = bridgeLock(t, bytes, { kill: () => { throw Object.assign(new Error('nope'), { code: 'EPERM' }); } });
  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'unavailable');
  const { code, reason } = f.bridge.state();
  assert.equal(code, 'RECOVERY_REQUIRED');
  assert.match(reason, /dead pid/);
  assertHolderDetails(reason, f, { pid: 424242, nonce: 'uncertain' });
  assert.match(reason, /desk-recover --bridge/);
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), bytes);
});

test('bridge: a malformed holder names the repoKey and lock path', async t => {
  const f = bridgeLock(t, 'not-json-at-all\n');
  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'unavailable');
  const { code, reason } = f.bridge.state();
  assert.equal(code, 'RECOVERY_REQUIRED');
  assert.match(reason, /malformed/);
  assert.ok(reason.includes(`repoKey ${f.paths.repoKey}`));
  assert.ok(reason.includes(f.paths.lockPath));
  assert.match(reason, /desk-recover --bridge/);
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), 'not-json-at-all\n');
});

for (const stage of ['created', 'written']) {
  test(`bridge: a lock file created by this call is removed when its ${stage} stage fails (no orphan)`, async t => {
    const f = bridgeLock(t, null, {
      faults: { lockStage: s => { if (s === stage) throw Object.assign(new Error('EIO injected'), { code: 'EIO' }); } },
    });
    const started = await startBridge(t, f);
    assert.equal(started.outcome, 'unavailable');
    assert.equal(f.bridge.state().code, 'CAPABILITY_GAP');
    assert.match(f.bridge.state().reason, /cannot be created/);
    assert.equal(existsSync(f.paths.lockPath), false, 'the half-created lock must not outlive the failed acquire');
  });
}

test('bridge: a file another owner put at the lock path is never unlinked by the failed acquire cleanup', async t => {
  const foreign = holderBytes(424242, 'foreign-owner');
  let f;
  f = bridgeLock(t, null, {
    kill: () => { /* alive */ },
    faults: {
      lockStage: stage => {
        if (stage !== 'written') return;
        unlinkSync(f.paths.lockPath);
        writeFileSync(f.paths.lockPath, foreign);
        throw Object.assign(new Error('EIO injected'), { code: 'EIO' });
      },
    },
  });
  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'unavailable');
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), foreign, 'identity check: not our inode → left alone');
  assert.match(f.bridge.state().reason, /lock file left in place/, 'fail-closed: the unverified file is diagnosed, not silently kept');
  assert.ok(f.bridge.state().reason.includes(f.paths.lockPath));
});

// --- store commit lock -------------------------------------------------------

function storeFixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'slp-lock-diag-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'stable');
  let n = 0;
  const warnings = [];
  const store = createDeskStore({
    stableRoot: root,
    now: NOW,
    uuid: () => (n++ === 0 ? 'self-nonce' : randomUUID()),
    warn: line => warnings.push(line),
    ...extra,
  });
  const paths = deskRepoPaths(root, REPO_KEY);
  mkdirSync(paths.repoDir, { recursive: true });
  return { dir, root, store, paths, warnings };
}

const envelope = (over = {}) => ({
  repo: { ...REPO },
  actorKey: 'actor-1',
  assignmentId: 'assign-1',
  requestId: 'req-1',
  command: { action: 'grant' },
  ...over,
});
const decideCommit = () => ({ ok: true, events: [{ kind: 'test.event', payload: { v: 1 } }] });
const decideReject = () => ({ ok: false, code: 'AUTHORITY_REQUIRED', message: 'authority required', recovery: 'change the command' });

function assertStoreDetails(text, f, { pid, nonce }) {
  assert.ok(text.includes(`pid ${pid}`), `pid in: ${text}`);
  assert.ok(text.includes(nonce), `nonce in: ${text}`);
  assert.ok(text.includes('age 2m 5s'), `age in: ${text}`);
  assert.ok(text.includes(`repoKey ${REPO_KEY}`), `labelled repoKey in: ${text}`);
  assert.ok(text.includes(f.paths.lockPath), `lock path in: ${text}`);
}

test('store: a lock held by ANOTHER live process is desk-busy with diagnostics; file byte-intact', async t => {
  const f = storeFixture(t);
  const bytes = holderBytes(process.ppid, 'other-process');
  writeFileSync(f.paths.lockPath, bytes);
  const busy = await f.store.transact(REPO_KEY, envelope(), decideCommit);
  assert.equal(busy.ok, false);
  assert.equal(busy.code, 'CAPABILITY_GAP');
  assert.match(busy.recovery, /desk-busy/);
  assert.match(busy.message, /another process/);
  assertStoreDetails(busy.message, f, { pid: process.ppid, nonce: 'other-process' });
  assert.match(busy.recovery, /desk-recover/);
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), bytes);
});

test('store: same pid with another instanceNonce is diagnosed as a previous/parallel instance in this process', async t => {
  const f = storeFixture(t);
  const bytes = holderBytes(process.pid, 'previous-instance');
  writeFileSync(f.paths.lockPath, bytes);
  const busy = await f.store.transact(REPO_KEY, envelope(), decideCommit);
  assert.equal(busy.code, 'CAPABILITY_GAP');
  assert.match(busy.recovery, /desk-busy/);
  assert.match(busy.message, /same process/);
  assert.doesNotMatch(busy.message, /another process/);
  assertStoreDetails(busy.message, f, { pid: process.pid, nonce: 'previous-instance' });
  assert.match(busy.recovery, /refuses a live pid/);
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), bytes, 'never removed automatically');
});

test('store: a lock still owned by THIS instance names the unreleased previous commit', async t => {
  const f = storeFixture(t);
  const bytes = holderBytes(process.pid, 'self-nonce');
  writeFileSync(f.paths.lockPath, bytes);
  const busy = await f.store.transact(REPO_KEY, envelope(), decideCommit);
  assert.equal(busy.code, 'CAPABILITY_GAP');
  assert.match(busy.recovery, /desk-busy/);
  assert.match(busy.message, /this instance/);
  assertStoreDetails(busy.message, f, { pid: process.pid, nonce: 'self-nonce' });
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), bytes);
});

test('store: a dead holder stays RECOVERY_REQUIRED, file kept, with diagnostics and the recovery step', async t => {
  const f = storeFixture(t);
  const pid = await deadPid();
  const bytes = holderBytes(pid, 'dead-holder');
  writeFileSync(f.paths.lockPath, bytes);
  const dead = await f.store.transact(REPO_KEY, envelope(), decideCommit);
  assert.equal(dead.code, 'RECOVERY_REQUIRED');
  assertStoreDetails(dead.message, f, { pid, nonce: 'dead-holder' });
  assert.match(dead.recovery, /desk-recover/);
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), bytes);
});

test('store: an unparseable holder names the repoKey and lock path', async t => {
  const f = storeFixture(t);
  writeFileSync(f.paths.lockPath, 'garbage');
  const result = await f.store.transact(REPO_KEY, envelope(), decideCommit);
  assert.equal(result.code, 'RECOVERY_REQUIRED');
  assert.match(result.message, /unreadable or unparseable/);
  assert.ok(result.message.includes(`repoKey ${REPO_KEY}`));
  assert.ok(result.message.includes(f.paths.lockPath));
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), 'garbage');
});

for (const stage of ['created', 'written']) {
  test(`store: a lock file created by this call is removed when its ${stage} stage fails (no orphan)`, async t => {
    const f = storeFixture(t, {
      faults: { lockStage: s => { if (s === stage) throw Object.assign(new Error('EIO injected'), { code: 'EIO' }); } },
    });
    await assert.rejects(f.store.transact(REPO_KEY, envelope(), decideCommit), /cannot create desk lock/);
    assert.equal(existsSync(f.paths.lockPath), false, 'no orphan lock with this instance\'s identity');
    const healthy = createDeskStore({ stableRoot: f.root, now: NOW });
    const ok = await healthy.transact(REPO_KEY, envelope(), decideCommit);
    assert.equal(ok.ok, true, 'the next commit is not blocked');
  });
}

test('store: the acquire cleanup never unlinks a file another owner put at the lock path', async t => {
  const foreign = holderBytes(424242, 'foreign-owner');
  let f;
  f = storeFixture(t, {
    faults: {
      lockStage: stage => {
        if (stage !== 'written') return;
        unlinkSync(f.paths.lockPath);
        writeFileSync(f.paths.lockPath, foreign);
        throw Object.assign(new Error('EIO injected'), { code: 'EIO' });
      },
    },
  });
  await assert.rejects(f.store.transact(REPO_KEY, envelope(), decideCommit), error => {
    assert.match(error.message, /cannot create desk lock/);
    assert.match(error.message, /lock file left in place/, 'fail-closed: the unverified file is diagnosed');
    assert.ok(error.message.includes(f.paths.lockPath));
    return true;
  });
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), foreign);
});

// --- commit(): release never masks the result or the original error ----------

const stealLock = (f, nonce = 'stolen') => () => {
  writeFileSync(f.paths.lockPath, holderBytes(424242, nonce));
};

test('commit: success + failing release returns the receipt, reports the failure, leaves the foreign lock', async t => {
  let f;
  f = storeFixture(t, { faults: { ledgerCommitted: () => stealLock(f)() } });
  const result = await f.store.transact(REPO_KEY, envelope(), decideCommit);
  assert.equal(result.ok, true, 'the durable commit must not be reported as failed');
  assert.equal(result.receipt.revision, 1);
  assert.equal(f.warnings.length, 1, 'the release failure is reported explicitly, once');
  assert.match(f.warnings[0], /release/);
  assert.ok(f.warnings[0].includes(`repoKey ${REPO_KEY}`));
  assert.ok(f.warnings[0].includes(f.paths.lockPath));
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), holderBytes(424242, 'stolen'), 'foreign lock left in place');
  assert.equal(JSON.parse(readFileSync(f.paths.ledgerPath, 'utf8')).revision, 1);
});

test('commit: a decide rejection + failing release still returns that rejection', async t => {
  let f;
  f = storeFixture(t, { faults: { lockHeld: () => stealLock(f)() } });
  // The foreign lock appears while the lock is held; read/decide proceed.
  const result = await f.store.transact(REPO_KEY, envelope(), decideReject);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTHORITY_REQUIRED');
  assert.equal(f.warnings.length, 1);
});

test('commit: an original error + failing release aggregates both and keeps the original code', async t => {
  let f;
  f = storeFixture(t, {
    faults: { ledgerCommitted: () => { stealLock(f)(); throw new Error('boom-original'); } },
  });
  await assert.rejects(
    f.store.transact(REPO_KEY, envelope(), decideCommit),
    error => {
      assert.equal(error.name, 'OperationConflict');
      assert.equal(error.code, 'IO_FAILURE');
      assert.match(error.message, /boom-original/, 'the original error must survive');
      assert.match(error.message, /release/, 'the release failure is named too');
      return true;
    },
  );
});

test('commit: an original error with a healthy release still releases the lock and rethrows the original', async t => {
  const f = storeFixture(t, { faults: { ledgerCommitted: () => { throw new Error('boom-original'); } } });
  await assert.rejects(f.store.transact(REPO_KEY, envelope(), decideCommit), /boom-original/);
  assert.equal(existsSync(f.paths.lockPath), false, 'release is attempted even on error');
  assert.equal(f.warnings.length, 0);
});

// --- review round 1 ------------------------------------------------------------

// The fixture's literal pin also logs an unrelated graft-drift warning; only lock
// lifecycle lines count here.
const isLockWarning = line => /desk bridge lock/.test(line);

test('lock holder facts label the repoKey separately from the lock path', () => {
  const key = 'c'.repeat(64);
  const text = lockHolder.describeLockHolder({
    repoKey: key,
    lockPath: '/somewhere/else/lock', // deliberately NOT containing the key
    holder: { pid: 7, instanceNonce: 'n-1', startedAt: AT },
    nowMs: Date.parse(AT) + 125_000,
  });
  assert.match(text, new RegExp(`repoKey ${key}; lock /somewhere/else/lock$`));
  assert.match(text, /pid 7, nonce n-1, age 2m 5s \(startedAt /);
  assert.equal(lockHolder.describeLockPath({ repoKey: key, lockPath: '/x/lock' }), `repoKey ${key}; lock /x/lock`);
});

// F1 — the identity check and the unlink happen while the created fd is open.
for (const [name, build] of [
  ['bridge', (t, hook) => {
    const f = bridgeLock(t, null, { faults: { lockStage: hook } });
    return { f, run: async () => { await startBridge(t, f); }, lockPath: f.paths.lockPath };
  }],
  ['store', (t, hook) => {
    const f = storeFixture(t, { faults: { lockStage: hook } });
    return { f, run: () => f.store.transact(REPO_KEY, envelope(), decideCommit).catch(() => undefined), lockPath: f.paths.lockPath };
  }],
]) {
  test(`${name}: orphan cleanup checks identity and unlinks while the created fd is still open`, async t => {
    let seen = null;
    let lockPath;
    const hook = (stage, fd) => {
      if (stage === 'written') throw Object.assign(new Error('EIO injected'), { code: 'EIO' });
      if (stage === 'cleanup') {
        const own = fstatSync(fd); // EBADF here would mean the fd was already closed
        const onDisk = lstatSync(lockPath);
        seen = { open: true, sameFile: own.ino === onDisk.ino && own.dev === onDisk.dev };
      }
    };
    const built = build(t, hook);
    lockPath = built.lockPath;
    await built.run();
    assert.deepEqual(seen, { open: true, sameFile: true });
    assert.equal(existsSync(lockPath), false);
  });
}

// F2 — a failing reporting channel never changes the decided result or error.
test('commit: a warn sink that throws cannot replace the committed receipt', async t => {
  let f;
  f = storeFixture(t, {
    warn: () => { throw new Error('warn-sink-broke'); },
    faults: { ledgerCommitted: () => stealLock(f)() },
  });
  const result = await f.store.transact(REPO_KEY, envelope(), decideCommit);
  assert.equal(result.ok, true);
  assert.equal(result.receipt.revision, 1);
  assert.equal(JSON.parse(readFileSync(f.paths.ledgerPath, 'utf8')).revision, 1);
});

test('commit: a warn sink that throws cannot replace a returned rejection either', async t => {
  let f;
  f = storeFixture(t, {
    warn: () => { throw new Error('warn-sink-broke'); },
    faults: { lockHeld: () => stealLock(f)() },
  });
  const result = await f.store.transact(REPO_KEY, envelope(), decideReject);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUTHORITY_REQUIRED');
});

test('commit: a non-IO_FAILURE original conflict keeps its code when the release also fails', async t => {
  let f;
  f = storeFixture(t, {
    faults: { ledgerCommitted: () => { stealLock(f)(); throw new OperationConflict('COLLISION', 'collision-original'); } },
  });
  await assert.rejects(f.store.transact(REPO_KEY, envelope(), decideCommit), error => {
    assert.equal(error.name, 'OperationConflict');
    assert.equal(error.code, 'COLLISION', 'the original conflict code must survive the aggregation');
    assert.match(error.message, /collision-original/);
    assert.match(error.message, /release failed/);
    return true;
  });
});

test('bridge: a warn sink that throws cannot break stop() or its final state', async t => {
  const calls = [];
  const f = bridgeLock(t, null, { warn: line => { calls.push(line); throw new Error('warn-sink-broke'); } });
  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'listening');
  writeFileSync(f.paths.lockPath, holderBytes(424242, 'foreign-owner')); // release-foreign → warn
  f.bridge.stop();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(calls.filter(isLockWarning).length, 1, 'the release problem was reported to the (broken) sink');
  assert.equal(f.bridge.state().kind, 'unavailable');
  assert.equal(readFileSync(f.paths.lockPath, 'utf8'), holderBytes(424242, 'foreign-owner'));
});

// F3 — a failing unlink is reported; a vanished file is not.
test('bridge: a release unlink failure other than ENOENT leaves the lock and warns with the holder facts', async t => {
  const f = bridgeLock(t, null, {
    faults: { lockStage: stage => { if (stage === 'releasing') throw Object.assign(new Error('EIO injected'), { code: 'EIO' }); } },
  });
  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'listening');
  const own = JSON.parse(readFileSync(f.paths.lockPath, 'utf8'));
  f.bridge.stop();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(existsSync(f.paths.lockPath), true, 'the lock could not be removed');
  const lockWarnings = f.warnings.filter(isLockWarning);
  assert.equal(lockWarnings.length, 1);
  const line = lockWarnings[0];
  assert.match(line, /could not be released/);
  assert.ok(line.includes(`repoKey ${f.paths.repoKey}`));
  assert.ok(line.includes(f.paths.lockPath));
  assert.ok(line.includes(`pid ${process.pid}`));
  assert.ok(line.includes(`nonce ${own.instanceNonce}`));
  assert.match(line, /EIO injected/);
});

test('bridge: a lock that vanished before the release unlink (ENOENT) stays silent', async t => {
  let hookCalls = 0;
  let f;
  f = bridgeLock(t, null, {
    faults: { lockStage: stage => { if (stage === 'releasing') { hookCalls += 1; unlinkSync(f.paths.lockPath); } } },
  });
  const started = await startBridge(t, f);
  assert.equal(started.outcome, 'listening');
  f.bridge.stop();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(hookCalls, 1, 'the release reached its unlink step');
  assert.deepEqual(f.warnings.filter(isLockWarning), []);
  assert.equal(existsSync(f.paths.lockPath), false);
});

// F3/F6 — the same-process message does not assume a stop() that never ran.
test('bridge: the same-process diagnosis admits a failed release and pid reuse', async t => {
  const f = bridgeLock(t, holderBytes(process.pid, 'previous-instance'));
  await startBridge(t, f);
  const { reason } = f.bridge.state();
  assert.match(reason, /stop\(\)\/release (may have )?(failed|never)/, reason);
  assert.match(reason, /pid reuse/);
  assert.match(reason, /process-start identity/);
});

test('store: the same-process diagnosis names pid reuse and the manual path', async t => {
  const f = storeFixture(t);
  writeFileSync(f.paths.lockPath, holderBytes(process.pid, 'previous-instance'));
  const busy = await f.store.transact(REPO_KEY, envelope(), decideCommit);
  assert.match(busy.recovery, /pid reuse/);
  assert.match(busy.recovery, /proving no live/);
});
