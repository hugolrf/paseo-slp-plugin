import test from "node:test";
import assert from "node:assert/strict";
import { applyHugoWorkflow } from "../plugin/shared/hugo-workflow.ts";

const makeState = () => ({
  taskKey: "PES-PILOT-LOCAL",
  phase: "triage",
  revision: 0,
  reworks: 0,
  maxReworks: 2,
  candidateRef: null,
  controllerId: "paseo-slp-pilot",
  roles: { planner: "planner", dev: "developer", reviewer: "reviewer", qa: "qa" },
  lastEvidenceRef: null,
  blockedReason: null,
});
const authority = {
  executor: "paseo", controllerId: "paseo-slp-pilot", taskKey: "PES-PILOT-LOCAL",
};
const advance = (state, type, by, details = {}) => {
  const result = applyHugoWorkflow(state, authority, { type, by, expectedRevision: state.revision, ...details });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.state;
};
const toReview = () => {
  let s = makeState();
  s = advance(s, "triaged", "planner");
  s = advance(s, "planned", "planner");
  return advance(s, "implemented", "developer", {
    candidateRef: "commit-123", testEvidenceRefs: ["unit-tests-log"],
  });
};
const toQA = () => advance(toReview(), "review_pass", "reviewer", {
  candidateRef: "commit-123", evidenceRef: "review-diff-123",
});

test("happy path stops at human release approval, not production", () => {
  let s = toQA();
  s = advance(s, "qa_pass", "qa", { candidateRef: "commit-123", evidenceRef: "qa-checks-123" });
  assert.equal(s.phase, "ready_for_approval");
  assert.equal(s.revision, 5);
  assert.equal(s.lastEvidenceRef, "qa-checks-123");
  const denied = applyHugoWorkflow(s, authority, { type: "qa_pass", by: "qa", expectedRevision: s.revision, candidateRef: "commit-123", evidenceRef: "new-check" });
  assert.deepEqual(denied, { ok: false, code: "invalid_phase" });
  const unsafe = applyHugoWorkflow(s, authority, { type: "deploy", by: "paseo-slp-pilot", expectedRevision: s.revision });
  assert.deepEqual(unsafe, { ok: false, code: "invalid_phase" });
});

test("Multi-orchestrator authority mismatch refuses execution", () => {
  const s = makeState();
  for (const other of [
    { ...authority, executor: "multica" },
    { ...authority, controllerId: "other-lead" },
    { ...authority, taskKey: "OTHER" },
    { ...authority, executor: null },
  ]) {
    const result = applyHugoWorkflow(s, other, { type: "triaged", by: "planner", expectedRevision: 0 });
    assert.deepEqual(result, { ok: false, code: "authority_required" });
  }
  assert.equal(s.revision, 0);
});

test("stale revision is rejected without modifying state", () => {
  const s = toReview();
  const result = applyHugoWorkflow(s, authority, {
    type: "review_pass", by: "reviewer", expectedRevision: s.revision - 1, candidateRef: "commit-123", evidenceRef: "review",
  });
  assert.deepEqual(result, { ok: false, code: "stale_revision" });
  assert.equal(s.phase, "review");
});

test("no QA before review", () => {
  const s = toReview();
  const result = applyHugoWorkflow(s, authority, {
    type: "qa_pass", by: "qa", expectedRevision: s.revision, candidateRef: "commit-123", evidenceRef: "qa",
  });
  assert.deepEqual(result, { ok: false, code: "invalid_phase" });
});

test("candidate identity is pinned through review and QA", () => {
  const s = toQA();
  const result = applyHugoWorkflow(s, authority, {
    type: "qa_pass", by: "qa", expectedRevision: s.revision, candidateRef: "different-commit", evidenceRef: "qa",
  });
  assert.deepEqual(result, { ok: false, code: "invalid_candidate" });
});

test("review and QA cannot approve their own implementation", () => {
  const reviewState = toReview();
  reviewState.roles.reviewer = "developer";
  assert.deepEqual(applyHugoWorkflow(reviewState, authority, {
    type: "review_pass", by: "developer", expectedRevision: reviewState.revision, candidateRef: "commit-123", evidenceRef: "review",
  }), { ok: false, code: "not_independent" });

  const qaState = toQA();
  qaState.roles.qa = "developer";
  assert.deepEqual(applyHugoWorkflow(qaState, authority, {
    type: "qa_pass", by: "developer", expectedRevision: qaState.revision, candidateRef: "commit-123", evidenceRef: "qa",
  }), { ok: false, code: "not_independent" });
});

test("rework returns to developer and stops after budget", () => {
  let s = toQA();
  s = advance(s, "qa_fail", "qa", { candidateRef: "commit-123", evidenceRef: "failed-qa-1" });
  assert.equal(s.phase, "implementation");
  assert.equal(s.reworks, 1);
  assert.equal(s.candidateRef, null);
  s = advance(s, "implemented", "developer", { candidateRef: "commit-124", testEvidenceRefs: ["tests-124"] });
  s = advance(s, "review_fail", "reviewer", { candidateRef: "commit-124", evidenceRef: "review-124" });
  assert.equal(s.phase, "implementation");
  assert.equal(s.reworks, 2);
  s = advance(s, "implemented", "developer", { candidateRef: "commit-125", testEvidenceRefs: ["tests-125"] });
  s = advance(s, "review_fail", "reviewer", { candidateRef: "commit-125", evidenceRef: "review-125" });
  assert.equal(s.phase, "blocked");
  assert.equal(s.reworks, 2);
  assert.match(s.blockedReason, /budget exhausted/i);
});

test("evidence required for each acceptance stage", () => {
  let s = makeState();
  s = advance(s, "triaged", "planner");
  s = advance(s, "planned", "planner");
  const missingTests = applyHugoWorkflow(s, authority, {
    type: "implemented", by: "developer", expectedRevision: s.revision, candidateRef: "c", testEvidenceRefs: [],
  });
  assert.deepEqual(missingTests, { ok: false, code: "invalid_evidence" });
  s = advance(s, "implemented", "developer", { candidateRef: "c", testEvidenceRefs: ["test-c"] });
  const missingReview = applyHugoWorkflow(s, authority, {
    type: "review_pass", by: "reviewer", expectedRevision: s.revision, candidateRef: "c", evidenceRef: " ",
  });
  assert.deepEqual(missingReview, { ok: false, code: "invalid_evidence" });
});

test("blocked work cannot bypass its safety stop", () => {
  const s = toReview();
  const stopped = advance(s, "blocked", "paseo-slp-pilot", { reason: "client clarification required" });
  assert.equal(stopped.phase, "blocked");
  const resume = applyHugoWorkflow(stopped, authority, {
    type: "review_pass", by: "reviewer", expectedRevision: stopped.revision, candidateRef: "commit-123", evidenceRef: "review",
  });
  assert.deepEqual(resume, { ok: false, code: "invalid_phase" });
});
