# Client binding: strict mode, local-only repositories and per-client rules

- Status: Accepted
- Date: 2026-11-06
- Decided by: Lead on behalf of Human
- Source: Human authority 2026-11-06 ("Um projeto criado dentro do Paseo tem que estar vinculado a um cliente e esse cliente vai ter as regras dele"), relayed by the Supervisor
- Supersedes: none

## Context

The central client map chose a pool and protocol per repository, but only at the last
rung of the source ladder, so a repository with its own configuration was never bound
to a client; a project with no entry silently took the user pool; a repository without
`origin` could not be mapped; and nothing delivered a client's rules (commit identity,
title format, AI footer) to the agent.

## Decision

Separate the *binding* (which client owns the repository) from the source ladder, which
does not change. Map version 2 adds `strict`, `originSha256: null` (local-only: zero
remotes) and structured `rules` (global ← client per key, `null` switches off; only
enums, an identity and an informational origin). One lookup rule: a valid strict map
plus a Git checkout with no entry is `CLIENT_UNMAPPED` everywhere (catalog, routes,
selection, placement at every rung, task deliver, the `agent.create` hook of `slp-*`
providers); creating a project is never blocked. Version 1 stays valid and unchanged,
reads as non-strict and gets no binding in pins; a map created by the screen is version
2 and strict. The rules block is rendered at read time, pinned by its hash per client
(`binding {client, mapSha256, rulesSha256}` in the source pin, so only that client's
edits drift) and delivered by the hook; a new capability `clientBinding` makes an older
candidate refuse. The Git identity check is read-only (`git config --get`; `clients
check`, the screen and a formation warning); SLP never writes a Git config.

## Consequences

Turning strict on blocks every unbound repository, including this plugin's own, until it
is bound (the screen lists pending projects and the review warns). A non-Git directory
cannot be bound and is blocked under strict. An ACP wrapper provider is refused when
rules apply. The hook reads the map on every create (no cache). A rules edit between the
last verify and the create is not detected. The writes stay screen-only plugin RPCs with
the guarantees of the earlier decision. The strict block of the `agent.create` hook depends on the host aborting a create when a `before` hook throws and on its time budget, which the SDK does not declare (host CAPABILITY_GAP); the Desk formation and `task deliver` are blocked by placement and the catalog lookup regardless. Changing the origin identity of an existing entry is warned per repository in the review and needs an explicit "accept new identity" step on the screen; a local-only entry is anchored by path only. Revisit when Paseo exposes caller identity, or
if a strict map must tolerate non-Git directories.
