const sourcePath = "src/range.zig";
const testPath = "test/range_test.zig";
const sourceReplacement = `/// Sums every value from \`start\` through \`end\`, including both endpoints.
pub fn inclusiveSum(start: i32, end: i32) i32 {
    var total: i32 = 0;
    var current = start;
    while (current <= end) : (current += 1) total += current;
    return total;
}
`;
const testReplacement = `const std = @import("std");
const range = @import("range");

test "a closed range includes both endpoints and its singleton" {
    try std.testing.expectEqual(@as(i32, 9), range.inclusiveSum(2, 4));
    try std.testing.expectEqual(@as(i32, 5), range.inclusiveSum(5, 5));
}
`;

function rejected(request, reason) { return { requestId: request?.requestId ?? "unknown", status: "rejected", payload: { reason } }; }
function document(context, path) { return context.documents.find((item) => item.path === path); }

function decide(turn) {
  const view = turn.context; const evidence = view.evidence;
  if (view.listing === null) return { action: "list_repository", arguments: {} };
  if (!document(view, sourcePath)) return { action: "read_file", arguments: { path: sourcePath } };
  if (!document(view, testPath)) return { action: "read_file", arguments: { path: testPath } };
  if (view.latest_search === null) return { action: "search_text", arguments: { query: "sumRange", path_prefix: "" } };
  if (!evidence.baseline_test_observed) return { action: "run_tests", arguments: { suite: "full" } };
  if (evidence.mutation_count === 0) return {
    action: "replace_file",
    arguments: { path: sourcePath, expected_sha256: document(view, sourcePath).sha256, replacement: sourceReplacement, rationale: "Expose and implement the task-required inclusive range operation." },
  };
  if (evidence.mutation_count === 1 && evidence.last_test_mutation_count !== 1) return { action: "run_tests", arguments: { suite: "full" } };
  if (evidence.mutation_count === 1) return {
    action: "replace_file",
    arguments: { path: testPath, expected_sha256: document(view, testPath).sha256, replacement: testReplacement, rationale: "Exercise the explicit inclusive API in the existing behavioral test." },
  };
  if (evidence.mutation_count === 2 && evidence.last_test_mutation_count !== 2) return { action: "run_tests", arguments: { suite: "full" } };
  return { action: "final", arguments: { summary: "Implemented and verified inclusive range summation.", changed_files: [sourcePath, testPath], tests_passed: true, mutation_count: 2 } };
}

export function createFixtureModelAdapter({ applicationId, policyDigest, decisionContractDigest }) {
  if (!/^[0-9a-f]{64}$/.test(applicationId) || !/^[0-9a-f]{64}$/.test(policyDigest) || !/^[0-9a-f]{64}$/.test(decisionContractDigest)) throw new TypeError("fixture adapter identities are required");
  async function preflight(context, request) {
    if (context.applicationId !== applicationId) return rejected(request, "fixture_application_mismatch");
    if (context.policyDigest !== policyDigest) return rejected(request, "fixture_policy_mismatch");
    if (context.decisionContractDigest !== decisionContractDigest || request.payload?.contract_digest !== decisionContractDigest) return rejected(request, "fixture_contract_mismatch");
    return { requestId: request.requestId, status: "ok", payload: { admitted: true } };
  }
  async function resolve(context, request) {
    const admitted = await preflight(context, request); if (admitted.status !== "ok") return admitted;
    context.modelAdapterInvocations = (context.modelAdapterInvocations ?? 0) + 1;
    return { requestId: request.requestId, status: "ok", payload: decide(request.payload), claims: { provider: "fixture", sequence: request.payload.counters.decisions } };
  }
  async function recover(_context, effectRecord) {
    return effectRecord?.recordedResolution ? structuredClone(effectRecord.recordedResolution) : { status: "failed", payload: { reason: "recorded_resolution_required" } };
  }
  return Object.freeze({ preflight, resolve, recover });
}

export const _fixtureModel = { decide, sourceReplacement, testReplacement };
