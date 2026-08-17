import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { resolve, preflight } from "../runtime/openai-adapter.mjs";

const decisionContract = JSON.parse(fs.readFileSync("zig-out/repository-steward/repository-steward.decision-contract.json", "utf8"));
const applicationId = "c1f1aa7fffda9444dc327b724256397bd32857c5215d6a5588e0658f6cfa7306";
const request = {
  requestId: "1".repeat(64),
  payload: {
    contract_digest: decisionContract.semanticDigest,
    goal: { task: "repair", repository: "tkersey/fixture", base_revision: "0".repeat(40) },
    counters: { turns: 0, decisions: 0, effect_actions: 0, child_actions: 0 },
    phase: "decide",
    context: { listing: null, documents: [], latest_search: null, latest_test: null, latest_replace: null, mutations: [], evidence: { baseline_test_observed: false, latest_test_passed: false, mutation_count: 0, last_test_mutation_count: 0, test_count: 0 } },
    strategy_local: null,
  },
};

function context(fetchImplementation) {
  return {
    applicationId, model: "gpt-test", allowedModels: ["gpt-test"], secrets: { OPENAI_API_KEY: "test-secret" },
    decisionContract, decisionContractDigest: decisionContract.semanticDigest, fetchImplementation, timeoutMs: 1000,
  };
}

function response(body, status = 200) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function completed(outputText) {
  return {
    id: "resp_private", model: "gpt-test", status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: outputText }] }],
    usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
  };
}

const providerAction = (action) => JSON.stringify({ value: action });

describe("OpenAI decision adapter", () => {
  test("binds one strict Responses request and emits only redacted claims", async () => {
    let calls = 0; let sent;
    const fetchImplementation = async (_url, init) => { calls += 1; sent = JSON.parse(init.body); return response(completed(providerAction({ action: "list_repository", arguments: {} }))); };
    const result = await resolve(context(fetchImplementation), request);
    expect(calls).toBe(1); expect(result.status).toBe("ok"); expect(result.payload).toEqual({ action: "list_repository", arguments: {} });
    expect(sent.store).toBe(false); expect(sent.background).toBe(false); expect(sent.tools).toEqual([]); expect(sent.text.format.strict).toBe(true);
    expect(sent.text.format.schema.required).toEqual(["value"]);
    const readVariant = sent.text.format.schema.properties.value.anyOf.find((variant) => variant.properties.action.const === "read_file");
    expect(readVariant.properties.action.type).toBe("string");
    expect(readVariant.properties.arguments.required).toEqual(["path"]);
    expect(result.claims).toEqual({ provider: "openai", endpointClass: "responses", requestedModel: "gpt-test", returnedModel: "gpt-test", responseIdSha256: expect.stringMatching(/^[0-9a-f]{64}$/), inputTokens: 10, outputTokens: 4, totalTokens: 14, store: false });
    expect(JSON.stringify(result.claims)).not.toContain("resp_private"); expect(JSON.stringify(result.claims)).not.toContain("test-secret");
  });

  test("admits one message accompanied by a reasoning item", async () => {
    const body = completed(providerAction({ action: "list_repository", arguments: {} }));
    body.output.unshift({ type: "reasoning", id: "reasoning_private", summary: [] });
    const result = await resolve(context(async () => response(body)), request);
    expect(result.status).toBe("ok");
    expect(result.payload).toEqual({ action: "list_repository", arguments: {} });
    expect(JSON.stringify(result.claims)).not.toContain("reasoning_private");
  });

  test("admits one structured action split across message items", async () => {
    const body = completed("");
    body.output = [
      { type: "reasoning", id: "reasoning_private", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"value":' }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: '{"action":"list_repository","arguments":{}}}' }] },
    ];
    const result = await resolve(context(async () => response(body)), request);
    expect(result.status).toBe("ok");
    expect(result.payload).toEqual({ action: "list_repository", arguments: {} });
  });

  test("rejects missing authority and never calls the provider", async () => {
    let calls = 0; const denied = context(async () => { calls += 1; }); denied.secrets = {};
    expect((await preflight(denied, request)).status).toBe("rejected");
    expect((await resolve(denied, request)).status).toBe("rejected"); expect(calls).toBe(0);
  });

  test("rejects refusal, model mismatch, multiple output, and malformed action", async () => {
    const cases = [
      { ...completed(providerAction({ action: "list_repository", arguments: {} })), model: "other" },
      { ...completed("{}"), output: [completed("{}").output[0], completed("{}").output[0]] },
      { ...completed("{}"), output: [{ type: "tool_call" }, completed("{}").output[0]] },
      { ...completed("{}"), output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] },
      completed(providerAction({ action: "read_file", arguments: { path: "src/main.zig", extra: true } })),
      completed(JSON.stringify({ action: "list_repository", arguments: {} })),
    ];
    for (const body of cases) expect((await resolve(context(async () => response(body)), request)).status).toBe("failed");
  });

  test("retains a redacted zero-message failure class", async () => {
    const admitted = context(async () => response({ ...completed(""), output: [{ type: "reasoning" }] }));
    expect((await resolve(admitted, request)).status).toBe("failed");
    expect(admitted.lastOpenAiFailure).toBe("openai_output_message_count_0");
  });

  test("does not retry provider failures", async () => {
    let calls = 0; const receiver = context(async () => { calls += 1; throw new Error("offline"); });
    const result = await resolve(receiver, request);
    expect(result.status).toBe("failed"); expect(calls).toBe(1);
    expect(receiver.lastOpenAiFailure).toBe("openai_transport_failed");
    expect(receiver.lastOpenAiFailure).not.toContain("test-secret");
  });
});
