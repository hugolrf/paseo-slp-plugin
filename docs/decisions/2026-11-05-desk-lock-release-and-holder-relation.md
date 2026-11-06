# Desk lock: holder relation and release semantics

- Status: Proposed
- Date: 2026-11-05
- Decided by: Supervisor on behalf of Human
- Source: Human authorisation to fix the desk lock diagnostics in the SLP repository, via Supervisor
- Supersedes: none

## Context

A desk lock record carries `{pid, instanceNonce, startedAt}`. A holder with the
live host pid was always reported as another live instance, even when it was a
previous or parallel instance in the same process, and refusals did not say
which file, namespace or age. Separately, a failing lock release in `commit`
replaced the decided result or the original error. The lock seen in the
incident was the bridge lifecycle lock (held for the plugin lifetime), not a
commit lock.

## Decision

Holders are classified self / same-process other instance / other process.
Every refusal names repoKey, lock path, pid, nonce and age and the resolution
step. No holder lock is removed automatically; `desk-recover` keeps refusing a
live pid. A lock file created by a call is unlinked, identity-checked while the
creating descriptor is still open, only when that call fails to write its own
record; if identity cannot be confirmed the file is left and the failure says
so. `commit` releases on every exit: a
decided result is returned unchanged with the release failure reported once
through `deps.warn`; an original error is rethrown with the release failure
appended and its code kept. A failing logging channel never alters a result,
an error or a release. The bridge warns when its release unlink fails for
anything but ENOENT.

## Consequences

A same-process leftover is diagnosed but still needs a restart/reload or a
manual, authorised removal. Without a process-start identity (Linux/WSL only;
not macOS) the same pid with another nonce may also be an orphan of a dead
process whose pid was reused, so the manual path is: remove only after proving
no live bridge or store instance uses the lock. A lock this instance still owns
but cannot release blocks its later commits; reclaiming it (self-reclaim) is a
separate Human decision. Automatic reclaim of a same-process holder is a
separate Human decision: it is unsafe while that instance may still be running.
Callers do not see a release failure after a successful commit except through
the warning; revisit if a typed receipt field is wanted.
