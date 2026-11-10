import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { z } from "zod";
import { detectDaemonHome, resolveDaemonHome } from "./daemon-home.ts";
import type { HomeContext } from "./daemon-home.ts";
import { createDeskStore, effectiveOwner, repoKeyFor } from "./desk-store.ts";
import type { DeskStore } from "./desk-store.ts";
import { projectDeskWorkflow } from "./desk-assignment.ts";
import { taskQueueCounts } from "./desk-task.ts";
import { GetWorkspaceWorkflowInput, GetWorkspaceWorkflowOutput, StartWorkspaceTeamInput, StartWorkspaceTeamOutput } from "../shared/workflow-view.ts";
import type { StartWorkspaceTeamResult, WorkspaceWorkflowResult } from "../shared/workflow-view.ts";
import { configFile, agentProfiles } from "./runtime/cli/host-config.ts";
import { MAX_RPC_BYTES, OperationConflict } from "../shared/contracts.ts";

/** Human reads use the selected workspace on the connected daemon. A client
 * cannot supply a repository or daemon-home path. Older hosts lacking a
 * fresh workspace read produce a gap rather than a guessed repository. */
export interface WorkflowHostApi {
  workspaces?: { ref?: (id: string) => { refresh?: () => Promise<unknown> } };
}

const WorkspaceLocation = z.object({
  id: z.string().min(1).max(256),
  workspaceDirectory: z.string().min(1).max(4096),
  archivingAt: z.string().nullable().optional(),
});

export type WorkspaceDeskBinding = {
  state: "ok";
  home: HomeContext;
  workspaceDirectory: string;
  repo: { hostId: "local"; gitCommonDir: string };
  repoKey: string;
} | {
  state: "unavailable";
  reason: "home-unverified" | "workspace-capability-gap" | "workspace-unavailable" | "repository-unavailable";
  detail: string;
};

export async function bindWorkspaceDesk(workspaceId: string, paseo: WorkflowHostApi | undefined): Promise<WorkspaceDeskBinding> {
  let home: HomeContext;
  try {
    const served = detectDaemonHome();
    if (served.source !== "env") throw new Error("served home is not exported");
    home = resolveDaemonHome({ hostId: "local", daemonHome: served.daemonHome }, "config.json must be a regular file");
  } catch {
    return { state: "unavailable", reason: "home-unverified", detail: "The served daemon home could not be verified; work records were not read." };
  }
  if (typeof paseo?.workspaces?.ref !== "function") {
    return { state: "unavailable", reason: "workspace-capability-gap", detail: "This host does not supply a fresh workspace read." };
  }
  let directory: string;
  try {
    const ref = paseo.workspaces.ref(workspaceId);
    if (typeof ref.refresh !== "function") {
      return { state: "unavailable", reason: "workspace-capability-gap", detail: "This host does not supply a fresh workspace read." };
    }
    const parsed = WorkspaceLocation.safeParse(await ref.refresh());
    if (!parsed.success || parsed.data.id !== workspaceId || parsed.data.archivingAt != null || !parsed.data.workspaceDirectory.startsWith("/")) {
      throw new Error("workspace location is unavailable");
    }
    directory = realpathSync(parsed.data.workspaceDirectory);
    if (!lstatSync(directory).isDirectory()) throw new Error("workspace is not a directory");
  } catch {
    return { state: "unavailable", reason: "workspace-unavailable", detail: "The selected workspace has no verified current directory." };
  }
  try {
    const gitEnv = { ...process.env };
    for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) delete gitEnv[name];
    const probe = spawnSync("git", ["--no-optional-locks", "-C", directory, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { env: gitEnv, encoding: "utf8", timeout: 2_000, maxBuffer: 16 * 1024 });
    if (probe.error || probe.signal || probe.status !== 0) throw new Error("git common dir unavailable");
    const raw = probe.stdout.trim();
    if (!raw.startsWith("/") || raw.length > 4096 || raw.includes("\0")) throw new Error("invalid git common dir");
    const gitCommonDir = realpathSync(raw);
    if (!lstatSync(gitCommonDir).isDirectory()) throw new Error("git common dir is not a directory");
    const repo = { hostId: "local" as const, gitCommonDir };
    return { state: "ok", home, workspaceDirectory: directory, repo, repoKey: repoKeyFor(repo) };
  } catch {
    return { state: "unavailable", reason: "repository-unavailable", detail: "The selected workspace could not be bound to a Git repository." };
  }
}

const workspaceBootstrap = new Map<string, Promise<StartWorkspaceTeamResult>>();

export async function startManagedWorkspaceTeam(input: unknown, paseo: WorkflowHostApi | undefined): Promise<StartWorkspaceTeamResult> {
  const parsed = StartWorkspaceTeamInput.safeParse(input);
  if (!parsed.success) throw new OperationConflict("INVALID_REQUEST", "invalid workspace team bootstrap request");
  const binding = await bindWorkspaceDesk(parsed.data.workspaceId, paseo);
  if (binding.state !== "ok") throw new Error(binding.detail);
  const store = createDeskStore({ stableRoot: binding.home.stableRoot });
  const existing = store.read(binding.repoKey);
  if (existing.state === "ok") return StartWorkspaceTeamOutput.parse({
    schemaVersion: 1, workspaceId: parsed.data.workspaceId, state: "already-managed",
    repoKey: binding.repoKey, agentId: null,
  });
  if (existing.state !== "absent") {
    throw new Error("the repository desk reads " + existing.state);
  }
  const prior = workspaceBootstrap.get(binding.repoKey);
  if (prior) return prior;
  const run = (async () => {
    const file = configFile(binding.home.canonicalHome);
    const profiles = agentProfiles(file.config).filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry));
    const matches = profiles.filter(profile => profile.id === "slp-supervisor");
    if (matches.length !== 1) throw new Error("saved SLP Supervisor profile is unavailable or ambiguous");
    const profile = matches[0];
    if (typeof profile.provider !== "string" || !/^slp-[a-z0-9-]+-supervisor$/.test(profile.provider)) {
      throw new Error("saved SLP Supervisor provider is invalid");
    }
    for (const key of ["model", "modeId", "thinkingOptionId"] as const) {
      const value = profile[key];
      if (value !== undefined && value !== null && typeof value !== "string") {
        throw new Error("saved SLP Supervisor " + key + " is invalid");
      }
    }
    if (profile.featureValues !== undefined && profile.featureValues !== null &&
        (typeof profile.featureValues !== "object" || Array.isArray(profile.featureValues))) {
      throw new Error("saved SLP Supervisor feature values are invalid");
    }
    const rawHandle = paseo?.workspaces?.ref?.(parsed.data.workspaceId);
    const handle = rawHandle as unknown as { agents?: { create?: (options: {
      idempotencyKey: string; config: Record<string, unknown>; title: string; prompt: string; labels: Record<string, string>;
    }) => Promise<{ id: string }> } };
    if (!handle?.agents?.create) throw new Error("this host cannot create an agent in the selected workspace");
    const provider = typeof profile.model === "string" && profile.model.length
      ? profile.provider + "/" + profile.model : profile.provider;
    const config = {
      provider,
      ...(typeof profile.modeId === "string" ? { modeId: profile.modeId } : {}),
      ...(typeof profile.thinkingOptionId === "string" ? { thinkingOptionId: profile.thinkingOptionId } : {}),
      ...(profile.featureValues && typeof profile.featureValues === "object"
        ? { featureValues: structuredClone(profile.featureValues) } : {}),
    };
    const agent = await handle.agents.create({
      idempotencyKey: "slp-workspace-bootstrap:" + binding.repoKey,
      config,
      title: "Equipes · Supervisor do workspace",
      prompt: [
        "Você é o Supervisor do Equipes para este workspace Git já existente.",
        "Inicialize a mesa gerenciada deste repositório e registre uma atribuição para o trabalho representado pelo workspace atual.",
        "Inspecione a branch, o checkout e qualquer contexto de PR disponível no Paseo antes de decidir o objetivo. Não invente requisitos ausentes.",
        "Conduza planejamento interno → Líder → Dev quando houver mudança solicitada → Revisor independente → QA com evidências.",
        "Se o workspace representar apenas revisão de PR, não altere código sem necessidade: priorize revisão, testes e evidências.",
        "Não faça merge, push, tag, deploy, produção ou qualquer ação externa irreversível sem autorização explícita.",
        "Se não for possível determinar com segurança o objetivo do workspace/PR, registre BLOCKED e peça apenas a informação faltante.",
      ].join("\n\n"),
      labels: { "slp.bootstrap": "workspace", "slp.repo": binding.repoKey },
    });
    return StartWorkspaceTeamOutput.parse({
      schemaVersion: 1, workspaceId: parsed.data.workspaceId, state: "started",
      repoKey: binding.repoKey, agentId: agent.id,
    });
  })().finally(() => workspaceBootstrap.delete(binding.repoKey));
  workspaceBootstrap.set(binding.repoKey, run);
  return run;
}

export interface WorkflowViewDeps {
  deskStore?: (stableRoot: string) => Pick<DeskStore, "read">;
  now?: () => Date;
}

/** One validated full-chain read supplies an entire page. Cursors pin that
 * ledger revision, and continuation never silently changes the snapshot. */
export async function readWorkspaceWorkflow(input: unknown, paseo: WorkflowHostApi | undefined,
  deps: WorkflowViewDeps = {}): Promise<WorkspaceWorkflowResult> {
  const parsed = GetWorkspaceWorkflowInput.safeParse(input);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > MAX_RPC_BYTES) {
    throw new OperationConflict("INVALID_REQUEST", "invalid workspace workflow request");
  }
  const request = parsed.data;
  const result: WorkspaceWorkflowResult = {
    schemaVersion: 1, workspaceId: request.workspaceId, state: "unavailable",
    generatedAt: (deps.now?.() ?? new Date()).toISOString(), target: null, ledgerRevision: null,
    assignments: [], assignmentTotal: 0, assignmentOffset: 0, assignmentNextCursor: null,
    view: null, problem: null, acceptance: "not-established-by-this-view",
  };
  const fail = (code: string, detail: string, conflict = false): WorkspaceWorkflowResult => {
    result.state = conflict ? "conflict" : "unavailable";
    result.problem = { code, detail };
    result.assignments = [];
    result.assignmentNextCursor = null;
    result.view = null;
    return GetWorkspaceWorkflowOutput.parse(result);
  };
  const binding = await bindWorkspaceDesk(request.workspaceId, paseo);
  if (binding.state !== "ok") return fail(binding.reason, binding.detail);
  result.target = {
    daemonHome: binding.home.canonicalHome, workspaceDirectory: binding.workspaceDirectory, repoKey: binding.repoKey,
  };
  let read;
  try {
    read = (deps.deskStore?.(binding.home.stableRoot) ?? createDeskStore({ stableRoot: binding.home.stableRoot })).read(binding.repoKey);
  } catch {
    return fail("STATE_UNREADABLE", "The bound repository desk could not be read; no work state was inferred.");
  }
  if (read.state === "absent") {
    result.state = "absent";
    return GetWorkspaceWorkflowOutput.parse(result);
  }
  if (read.state !== "ok") return fail("STATE_UNREADABLE", `The bound repository desk reads ${read.state}; no work state was inferred.`);
  const ledger = read.ledger;
  result.ledgerRevision = ledger.revision;
  const wantedRevision = request.page.expectedLedgerRevision;
  if (wantedRevision != null && wantedRevision !== ledger.revision) {
    return fail("REVISION_CONFLICT", "The desk changed. Reload before reading a continuation.", true);
  }
  result.state = "ready";
  if (request.assignmentId !== null) {
    if (request.assignmentCursor !== null) return fail("INVALID_REQUEST", "Assignment-list cursors do not apply to an assignment detail.");
    let limit = request.page.limit;
    while (true) {
      const view = projectDeskWorkflow(ledger, request.assignmentId, { ...request.page, limit });
      if (!view.ok) return fail(view.code, `${view.message}\n${view.recovery}`, view.code === "REVISION_CONFLICT");
      result.view = view;
      if (Buffer.byteLength(JSON.stringify(result)) <= MAX_RPC_BYTES) break;
      if (limit === 1) return fail("VIEW_TOO_LARGE", "A complete work record exceeds the view budget. No shortened record was presented as complete.");
      limit = Math.max(1, Math.floor(limit / 2));
    }
  } else {
    const assignments = [...ledger.assignments].sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
    const cursor = request.assignmentCursor;
    if (cursor && cursor.ledgerRevision !== ledger.revision) return fail("REVISION_CONFLICT", "The assignment list changed. Reload before continuing.", true);
    const offset = cursor?.offset ?? 0;
    if (offset > assignments.length) return fail("INVALID_REQUEST", "The assignment cursor is outside this list.");
    result.assignmentTotal = assignments.length;
    result.assignmentOffset = offset;
    // The whole current operative-brief objective per assignment, resolved
    // once from this page's single verified chain read.
    const latestBrief = new Map<string, typeof ledger.briefRevisions[number]>();
    for (const row of ledger.briefRevisions) {
      const previous = latestBrief.get(row.assignmentId);
      if (previous === undefined || row.revision > previous.revision) latestBrief.set(row.assignmentId, row);
    }
    for (const assignment of assignments.slice(offset, offset + request.limit)) {
      // The legacy registration objective is only a fallback when no
      // structured brief exists. The owner tuple is the effective owner —
      // recorded desk state, not observed host-agent liveness.
      const brief = latestBrief.get(assignment.assignmentId);
      const owner = effectiveOwner(ledger, assignment);
      const row = { id: assignment.assignmentId, objectiveBasis: brief === undefined ? "registration" as const : "brief" as const,
        objective: brief === undefined ? assignment.objective : brief.body.objective,
        briefRevision: brief?.revision ?? 0, state: assignment.state,
        ownerAgentId: owner.agentId, ownerMembershipId: owner.membershipId, ownershipRevision: owner.ownershipRevision,
        workspaceId: assignment.workspaceId,
        // Core's queue counter — a migrated desk with zero task entries is a
        // supported empty queue, not an unavailable one.
        taskCounts: taskQueueCounts(ledger, assignment) };
      result.assignments.push(row);
      const next = offset + result.assignments.length;
      result.assignmentNextCursor = next < assignments.length ? { ledgerRevision: ledger.revision, offset: next } : null;
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RPC_BYTES) {
        result.assignments.pop();
        if (result.assignments.length === 0) return fail("VIEW_TOO_LARGE", "A complete assignment row exceeds the view budget.");
        result.assignmentNextCursor = { ledgerRevision: ledger.revision, offset: offset + result.assignments.length };
        break;
      }
    }
  }
  return GetWorkspaceWorkflowOutput.parse(result);
}
