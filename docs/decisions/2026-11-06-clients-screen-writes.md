# Clientes screen writes are plugin RPCs guarded by convention

- Status: Accepted
- Date: 2026-11-06
- Decided by: Supervisor on behalf of Human
- Source: Human request to edit the central client map inside the Manager (2026-11-06), option C chosen after the S1 reachability finding
- Supersedes: none

## Context

The Manager must edit the central client map, client pools and protocols without
hand-editing files. Probing showed the Paseo daemon accepts `plugin.rpc.invoke`
from any local process of the user with no credential and gives plugin handlers no
caller identity, so no plugin RPC — new or long-standing — is structurally
reachable only by the Manager screen. That is a host CAPABILITY_GAP.

## Decision

Add three write RPCs (`set-clients`, `set-client-pool`, `set-client-protocol`)
with the same reachability as `set-peer-pool`, plus defense in depth that is
convention only: `confirm` = sha256 of the exact reviewed bytes, sha256 CAS, one
content-free audit line before the atomic rename, and paths only below
`slp-clients/` with no symlink followed. Desk tools and `slp.mjs` never expose
the writes; a test proves it from the real registries and import graphs and fails
when an RPC is added without updating the inventory.

## Consequences

An agent with a shell can still call these RPCs or edit the files directly, as it
already can for the other RPCs. Revisit when the host exposes caller identity or
an authenticated RPC channel; then bind the writes to the Manager session.
