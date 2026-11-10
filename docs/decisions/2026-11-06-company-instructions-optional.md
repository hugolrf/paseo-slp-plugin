# Company context `instructions` is optional

- Status: Accepted
- Date: 2026-11-06
- Decided by: Supervisor on behalf of Human
- Source: Human delegation to the Supervisor ("faço o que você achar melhor"), 2026-11-06
- Supersedes: none

## Context

On 2026-11-03 the per-company rules moved to the Cérebro and the `instructions` field left
`~/.config/equipes/companies.json`. The company context still required a non-empty
`instructions` string, so `agent.create.before` failed with "company policy is missing or
invalid" for every client repository folder. The Human decided the rules live only in the
Cérebro and the central map; `companies.json` must not duplicate them.

## Decision

`companies.<name>.instructions` is optional. Absent, empty or whitespace-only: the context is
built from the verified binding, the isolation notice and `sourceNotes` only. Present: a string
of at most 2200 characters, validated as before and appended. Any non-string (including `null`)
is invalid. `sourceNotes` stays mandatory. No identity check changes (registry, protected roots,
unique common-dir, origin drift, non-Git folders, client containers).

## Consequences

A registry without rules text no longer blocks agent creation, but the agent only receives
pointers (`sourceNotes`) to the rules, not the rules. Revisit if enforcement of rule text at
creation time is required again. Older runtimes still reject an entry without `instructions`.
