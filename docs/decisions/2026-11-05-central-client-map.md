# Central client map outside repositories

- Status: Accepted
- Date: 2026-11-05
- Decided by: Human
- Source: Human instruction relayed by the Supervisor on 2026-11-05 ("mapear os repositórios por cliente… fica fora dos repositórios")
- Supersedes: none

## Context

A linked worktree whose main checkout has no `.paseo-slp/` configuration failed
closed with CAPABILITY_GAP, and a configuration committed into a client
repository would leak one client's pool and protocol into that repository.
Per-client pool/protocol must be trustworthy, central and never mixed.

## Decision

`<paseoHome>/slp-clients/clients.json` (strict version 1, ≤64KiB, no secrets)
maps `gitCommonDir` + origin hash to a client; each client owns
`<paseoHome>/slp-clients/clients/<directory>/.paseo-slp/{slp-routing.json,workspace-protocol.md}`.
Order: the checkout's own configuration, then its main checkout's, then the
map, then the gap. The map is read only when the first two have none. An absent
map keeps today's behavior; a present map that is invalid, ambiguous, drifted
(`remote identity drift`), under `protectedRoots` without an entry, or whose
client file is missing/symlinked/oversized blocks — never the user pool and
never another client. Pool `scope` is `central:<client>`; the formation source
pin carries `central {client, mapSha256, directory}` and a candidate lacking
`FORMATION_CAPABILITIES.centralClients` refuses instead of reading divergently.
Identity is file identity (dev+inode), never spelling; with a map present an unobservable Git identity blocks. `slp.mjs clients validate` checks layout and host paths read-only.

## Consequences

The map is per host (Mac and WSL keep separate files with their own absolute
paths). Edits during formation surface as ROUTE_DRIFT. `desk-bridge.ts`
constructs the placement without a home; until it passes the daemon home, the
placement defaults to `PASEO_HOME` or `~/.paseo`, and the planner refuses a
central source outside its own daemon home. Revisit if clients need per-project
pools or shared protocols.
