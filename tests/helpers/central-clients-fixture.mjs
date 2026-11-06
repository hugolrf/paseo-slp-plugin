import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { placementFixture, fixtureGit } from './formation-placement-fixture.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const ORIGIN = 'https://git.example.invalid/grupo/api.git';
export const PROTOCOL = '---\nagent_mode: full-access\n---\nProtocolo do cliente.\n';

/** Writes <home>/slp-clients/clients/<directory>/.paseo-slp/{pool,protocol}. */
export function writeClient(home, directory, catalog, protocol = PROTOCOL) {
  const dir = join(home, 'slp-clients/clients', directory, '.paseo-slp');
  mkdirSync(dir, { recursive: true });
  if (catalog !== null) writeFileSync(join(dir, 'slp-routing.json'), typeof catalog === 'string' ? catalog : JSON.stringify(catalog));
  if (protocol !== null) writeFileSync(join(dir, 'workspace-protocol.md'), protocol);
  return dir;
}
export const writeMap = (home, map) => {
  mkdirSync(join(home, 'slp-clients'), { recursive: true });
  writeFileSync(join(home, 'slp-clients/clients.json'), typeof map === 'string' ? map : JSON.stringify(map));
};
export const baseMap = (commonDir, extra = {}) => ({
  version: 1, protectedRoots: [],
  clients: { ClienteA: { directory: 'clienteA' } },
  repositories: [{ client: 'ClienteA', project: 'grupo/api', gitCommonDir: commonDir, originSha256: sha256(ORIGIN) }],
  ...extra,
});

/** A repository whose main checkout carries NO configuration, a linked
 * worktree seat caller, and a central map that maps the repository to ClienteA. */
export function centralFixture(t, options = {}) {
  const f = placementFixture(t, options);
  fixtureGit(f.repository, 'remote', 'add', 'origin', ORIGIN);
  const userPool = JSON.parse(JSON.stringify(f.catalog));
  userPool.options[0].id = 'user-only';
  writeFileSync(join(f.home, 'slp-runtime/state/peer-pool.json'), JSON.stringify(userPool));
  rmSync(join(f.repository, '.paseo-slp'), { recursive: true, force: true });
  const clientPool = JSON.parse(JSON.stringify(f.catalog));
  clientPool.options[0].id = 'client-a';
  clientPool.options[0].notes = 'pool of ClienteA';
  const clientDir = writeClient(f.home, 'clienteA', clientPool);
  writeMap(f.home, baseMap(f.commonDir));
  f.row.createCwd = f.target; f.row.workspaceId = 'target';
  return { ...f, clientPool, userPool, clientDir,
    mapPath: join(f.home, 'slp-clients/clients.json'), remapped: (map) => writeMap(f.home, map) };
}
