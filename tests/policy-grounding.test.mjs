// Project grounding is a cross-project invariant delivered to every role in the
// bundle; company-specific sources and identities are not repeated in policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { install } from '../plugin/server/runtime/cli/package.ts';
import { roleBundle } from '../plugin/server/runtime/cli/role-bundle.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const flat = text => text.replace(/\s+/gu, ' ');

test('project grounding reaches Supervisor, Lead and Peer bundles without company-specific rules', t => {
  mkdirSync(join(root, '.local-checks'), { recursive: true });
  const dir = mkdtempSync(join(root, '.local-checks/policy-grounding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installed = join(dir, 'release');
  install(root, installed);
  for (const role of ['supervisor', 'lead', 'peer']) {
    const text = flat(roleBundle(installed, role, {}).instructions);
    assert.match(text, /Project grounding: before acting on a repository/, `${role} gets the cross-project rule`);
    assert.match(text, /injected company context/, `${role} treats injected company context as a named source`);
    assert.match(text, /A named source you cannot read is a CAPABILITY_GAP/, `${role} treats an unreadable source as a gap`);
    assert.match(text, /Evidence, state and identity of one organization never hold for another/, `${role} never mixes organizations`);
    assert.doesNotMatch(text, /fourtime\.dev1@dwlaw|hugolrf@gmail/u, `${role} bundle repeats no company identity`);
  }
  assert.match(flat(roleBundle(installed, 'supervisor', {}).instructions), /Carry project grounding \(common\.md\) in each Lead assignment/);
  assert.match(flat(roleBundle(installed, 'lead', {}).instructions), /Each Peer assignment carries project grounding/);
  assert.match(flat(roleBundle(installed, 'peer', {}).instructions), /project grounding \(organization, git identity, sources or gap\) in handbacks/);
});
