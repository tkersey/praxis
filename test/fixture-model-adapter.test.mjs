import { describe, expect, test } from "bun:test";
import { createFixtureModelAdapter, _fixtureModel } from "../runtime/fixture-model-adapter.mjs";

const identity = "a".repeat(64); const policyDigest = "b".repeat(64); const contract = "c".repeat(64);
const adapter = createFixtureModelAdapter({ applicationId: identity, policyDigest, decisionContractDigest: contract });
const base = {
  requestId: "1".repeat(64), payload: {
    contract_digest: contract, counters: { decisions: 0 },
    context: { listing: null, documents: [], latest_search: null, evidence: { baseline_test_observed: false, mutation_count: 0, last_test_mutation_count: 0 } },
  },
};
const context = { applicationId: identity, policyDigest, decisionContractDigest: contract };

describe("fixture model adapter", () => {
  test("is exact application, policy, and contract bound", async () => {
    expect((await adapter.preflight(context, base)).status).toBe("ok");
    expect((await adapter.preflight({ ...context, policyDigest: "d".repeat(64) }, base)).status).toBe("rejected");
  });

  test("derives its fixed sequence from projected Memory", () => {
    expect(_fixtureModel.decide(base.payload).action).toBe("list_repository");
    const listed = structuredClone(base.payload); listed.context.listing = { entries: [], truncated: false };
    expect(_fixtureModel.decide(listed).arguments.path).toBe("src/range.zig");
    listed.context.documents.push({ path: "src/range.zig", sha256: "1".repeat(64), contents: "old" });
    expect(_fixtureModel.decide(listed).arguments.path).toBe("test/range_test.zig");
    listed.context.documents.push({ path: "test/range_test.zig", sha256: "2".repeat(64), contents: "old" });
    expect(_fixtureModel.decide(listed).action).toBe("search_text");
    listed.context.latest_search = { hits: [], truncated: false };
    expect(_fixtureModel.decide(listed).action).toBe("run_tests");
    listed.context.evidence.baseline_test_observed = true;
    expect(_fixtureModel.decide(listed).arguments.replacement).toContain("inclusiveSum");
  });
});
