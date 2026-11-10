# Project folders without Git bind to a client as containers

- Status: Accepted
- Date: 2026-11-06
- Decided by: Human (option A) via Supervisor
- Source: Human test of the Clientes screen: the screen listed workspaces, not Paseo projects, and projects that are not repositories ("DWLaw / Geral", "Financeiro") had no way to be bound
- Supersedes: none

## Context

The map identifies a repository by Git common-dir and origin hash, so a Paseo project that is a plain folder cannot be
saved: it is always unmapped, and a strict map would block its agents. The screen also showed one row per workspace,
whose name is a task title, instead of one row per Paseo project.

## Decision

The screen's row is the Paseo project (descriptor `projectId`, `projectCustomName ?? projectDisplayName`,
`projectRootPath`, `projectKind`, `workspaceKind`): one row per repository, titled by the project, with its workspaces
counted; the client prefix of the label is only a suggestion. `projectId` groups the UI and never enters the map or a pin.
Map version 2 gains the optional key `containers: [{client, project, path}]` (no version bump; version 1 rejects it):
a directory Git proves is not a repository, at or under a container, takes its client (deepest wins, one inode named
twice is CLIENT_MAP_INVALID); a container never covers a Git repository. The server forbids the HOME, `/`, system
roots, any folder containing the HOME and any ancestor of a protected root, and warns about a container above others;
the screen asks a separate confirmation. The new capability `clientContainers` makes the screen save containers only when
the verified bound runtime declares it, and makes an older candidate fail with an explicit CAPABILITY_GAP.

## Consequences

Install the runtime that declares `clientContainers` before saving the first container (an older runtime reads such a
map as invalid). Containers are anchored by path only: a folder deleted and recreated at the same path inherits the
binding. A directory with a `.git` entry between it and the container root is blocked, never inherited (a degraded repository is not a plain folder), and the root of another file system is never a container. A container must stay narrow; the guards cover the obvious over-reach, not every wide folder. Revisit if folders
need rules narrower than a client or if a path anchor proves too weak.
