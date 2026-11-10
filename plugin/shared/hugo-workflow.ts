/**
 * Hugo's policy-only workflow reducer.
 *
 * This module NEVER launches agents, changes the Multica card, writes to the
 * repository, or performs production actions. It validates an observed,
 * externally-authorized step before an SLP integration may persist it.
 *
 * The task authority/lease must be obtained and verified by the adapter.
 * Passing a matching string is NOT itself a distributed lock.
 */
export type HugoPhase =
  | "triage"
  | "planning"
  | "implementation"
  | "review"
  | "qa"
  | "ready_for_approval"
  | "blocked";

export type HugoRoles = {
  planner: string;
  dev: string;
  reviewer: string;
  qa: string;
};

export type HugoWorkflowState = {
  taskKey: string;
  phase: HugoPhase;
  revision: number;
  reworks: number;
  maxReworks: number;
  candidateRef: string | null;
  controllerId: string;
  roles: HugoRoles;
  lastEvidenceRef: string | null;
  blockedReason: string | null;
};

export type HugoAuthority = {
  /** The current external task executor, read from the source of truth. */
  executor: "paseo" | "multica" | null;
  /** A verified external reservation; never inferred from agent idle status. */
  controllerId: string | null;
  taskKey: string;
};

type ActionBase = { by: string; expectedRevision: number };
export type HugoWorkflowAction =
  | (ActionBase & { type: "triaged" })
  | (ActionBase & { type: "planned" })
  | (ActionBase & {
      type: "implemented";
      candidateRef: string;
      testEvidenceRefs: readonly string[];
    })
  | (ActionBase & {
      type: "review_pass" | "review_fail" | "qa_pass" | "qa_fail";
      candidateRef: string;
      evidenceRef: string;
    })
  | (ActionBase & { type: "blocked"; reason: string });

export type HugoWorkflowResult =
  | { ok: true; state: HugoWorkflowState }
  | {
      ok: false;
      code:
        | "authority_required"
        | "stale_revision"
        | "wrong_role"
        | "invalid_phase"
        | "invalid_evidence"
        | "invalid_candidate"
        | "not_independent"
        | "invalid_state"
        | "unsupported_event";
    };

export function applyHugoWorkflow(
  state: HugoWorkflowState,
  authority: HugoAuthority,
  action: HugoWorkflowAction,
): HugoWorkflowResult {
  const refuse = (code: Extract<HugoWorkflowResult, { ok: false }>["code"]): HugoWorkflowResult =>
    ({ ok: false, code });
  const ok = (change: Partial<HugoWorkflowState>): HugoWorkflowResult => ({
    ok: true,
    state: { ...state, ...change, revision: state.revision + 1 },
  });
  const evidence = (value: string): boolean => typeof value === "string" && value.trim().length > 0;
  if (
    !state.taskKey ||
    !state.controllerId ||
    !Number.isSafeInteger(state.revision) ||
    state.revision < 0 ||
    !Number.isSafeInteger(state.reworks) ||
    state.reworks < 0 ||
    !Number.isSafeInteger(state.maxReworks) ||
    state.maxReworks < 0 ||
    state.reworks > state.maxReworks
  ) return refuse("invalid_state");
  if (
    authority.executor !== "paseo" ||
    authority.controllerId !== state.controllerId ||
    authority.taskKey !== state.taskKey
  ) return refuse("authority_required");
  if (action.expectedRevision !== state.revision) return refuse("stale_revision");
  if (!evidence(action.by)) return refuse("wrong_role");

  if (action.type === "blocked") {
    if (!evidence(action.reason)) return refuse("invalid_evidence");
    if (!Object.values(state.roles).includes(action.by) && action.by !== state.controllerId) {
      return refuse("wrong_role");
    }
    if (state.phase === "ready_for_approval") return refuse("invalid_phase");
    return ok({ phase: "blocked", blockedReason: action.reason.trim() });
  }
  if (state.phase === "blocked" || state.phase === "ready_for_approval") return refuse("invalid_phase");

  if (action.type === "triaged") {
    if (state.phase !== "triage") return refuse("invalid_phase");
    if (action.by !== state.roles.planner) return refuse("wrong_role");
    return ok({ phase: "planning" });
  }
  if (action.type === "planned") {
    if (state.phase !== "planning") return refuse("invalid_phase");
    if (action.by !== state.roles.planner) return refuse("wrong_role");
    return ok({ phase: "implementation" });
  }
  if (action.type === "implemented") {
    if (state.phase !== "implementation") return refuse("invalid_phase");
    if (action.by !== state.roles.dev) return refuse("wrong_role");
    if (!evidence(action.candidateRef)) return refuse("invalid_candidate");
    if (!Array.isArray(action.testEvidenceRefs) ||
      action.testEvidenceRefs.length === 0 ||
      !action.testEvidenceRefs.every(evidence)) return refuse("invalid_evidence");
    return ok({ phase: "review", candidateRef: action.candidateRef, lastEvidenceRef: action.testEvidenceRefs[0] });
  }
  if (action.type === "review_pass" || action.type === "review_fail") {
    if (state.phase !== "review") return refuse("invalid_phase");
    if (action.by !== state.roles.reviewer) return refuse("wrong_role");
    if (state.roles.reviewer === state.roles.dev) return refuse("not_independent");
    if (!state.candidateRef || action.candidateRef !== state.candidateRef) return refuse("invalid_candidate");
    if (!evidence(action.evidenceRef)) return refuse("invalid_evidence");
    if (action.type === "review_pass") return ok({ phase: "qa", lastEvidenceRef: action.evidenceRef });
    const reworks = state.reworks + 1;
    if (reworks > state.maxReworks) {
      return ok({ phase: "blocked", reworks: state.maxReworks, blockedReason: "Review rework budget exhausted", lastEvidenceRef: action.evidenceRef });
    }
    return ok({ phase: "implementation", reworks, candidateRef: null, lastEvidenceRef: action.evidenceRef });
  }
  if (action.type === "qa_pass" || action.type === "qa_fail") {
    if (state.phase !== "qa") return refuse("invalid_phase");
    if (action.by !== state.roles.qa) return refuse("wrong_role");
    if (state.roles.qa === state.roles.dev) return refuse("not_independent");
    if (!state.candidateRef || action.candidateRef !== state.candidateRef) return refuse("invalid_candidate");
    if (!evidence(action.evidenceRef)) return refuse("invalid_evidence");
    if (action.type === "qa_pass") return ok({ phase: "ready_for_approval", lastEvidenceRef: action.evidenceRef });
    const reworks = state.reworks + 1;
    if (reworks > state.maxReworks) {
      return ok({ phase: "blocked", reworks: state.maxReworks, blockedReason: "QA rework budget exhausted", lastEvidenceRef: action.evidenceRef });
    }
    return ok({ phase: "implementation", reworks, candidateRef: null, lastEvidenceRef: action.evidenceRef });
  }
  return refuse("unsupported_event");
}
