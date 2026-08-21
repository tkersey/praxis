import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  admitWorkspacePolicy,
  preflight,
  replacementProposalDigest,
  resolve,
  _workspaceInternals,
} from "../runtime/workspace-adapter.mjs";

const roots = [];
afterEach(async () => { while (roots.length > 0) await rm(roots.pop(), { recursive: true, force: true }); });
const baseRevision = "0123456789abcdef0123456789abcdef01234567";
const applicationId = "c1f1aa7fffda9444dc327b724256397bd32857c5215d6a5588e0658f6cfa7306";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function rawPolicy(overrides = {}) {
  return {
    format: "praxis-workspace-policy/v1",
    repository: "tkersey/fixture",
    baseRevision,
    readablePaths: ["build.zig", "src/main.zig", "test/main.zig"],
    writablePaths: ["src/main.zig", "test/main.zig"],
    check: { kind: "zig-build-check-v1", argv: ["build", "check", "--summary", "all"] },
    limits: { maximumFileBytes: 16384, maximumListedFiles: 64, maximumChangedFiles: 4, maximumMutationOperations: 10 },
    ...overrides,
  };
}

async function fixture(maximumMutationOperations = 10) {
  const root = await mkdtemp(join(tmpdir(), "praxis-workspace-test-")); roots.push(root);
  await mkdir(join(root, "src")); await mkdir(join(root, "test"));
  await writeFile(join(root, "build.zig"), "// build\n");
  await writeFile(join(root, "src/main.zig"), "const value = 0;\n");
  await writeFile(join(root, "test/main.zig"), "test value\n");
  const admitted = admitWorkspacePolicy(rawPolicy({
    limits: { ...rawPolicy().limits, maximumMutationOperations },
  }), { repository: "tkersey/fixture", baseRevision });
  const workspaceRootReal = await realpath(root);
  const privateRoot = join(root, ".private"); await mkdir(privateRoot);
  return {
    root,
    context: {
      applicationId, runId: "run-test", workspaceRoot: root, workspaceRootReal,
      repository: "tkersey/fixture", baseRevision, policy: admitted.policy, policyDigest: admitted.digest,
      zigExecutable: "/absolute/zig", temporaryHome: privateRoot, approvalRoot: join(privateRoot, "approvals"),
    },
  };
}

function request(operation, payload = {}, requestId = "1".repeat(64)) {
  return { requestId, idempotencyKey: "2".repeat(64), payload: { operation, ...payload } };
}

describe("workspace policy", () => {
  test("v1.0.5 correction evidence is exact and executable", async () => {
    const correction = JSON.parse(await readFile(new URL("../conformance/praxis-v1.0.5/obstructions/model-visible-budget-parity/result.json", import.meta.url), "utf8"));
    expect(correction).toEqual({
      format: "praxis-obstruction-correction/v1",
      owner: "parent_application_obstruction",
      failed_release: "v1.0.4",
      failed_model_visible_maximum_replacements: 6,
      failed_machine_maximum_mutation_operations: 10,
      failed_adapter_maximum_mutation_operations: 10,
      successor_model_visible_maximum_replacements: _workspaceInternals.compiledLimits.maximumMutationOperations,
      successor_machine_maximum_mutation_operations: _workspaceInternals.compiledLimits.maximumMutationOperations,
      successor_adapter_maximum_mutation_operations: _workspaceInternals.compiledLimits.maximumMutationOperations,
      successor_decision_codec_maximum_mutations: _workspaceInternals.compiledLimits.maximumMutationOperations,
      receiver_policy_may_narrow: true,
      receiver_limit_enforced_before_approval: true,
      idempotent_result_permitted_at_receiver_limit: true,
      idempotent_result_requires_request_bound_approval: true,
      fresh_content_equal_request_denied_without_retained_approval: true,
      same_process_write_charged_before_post_write_verification: true,
      exactly_once_external_effect_claimed: false,
      maximum_changed_files: _workspaceInternals.compiledLimits.maximumChangedFiles,
      machine_abi: 2,
      application_abi: 1,
      effect_protocol: 1,
    });
  });

  test("model and adapter expose one compiled ceiling while receiver policy may narrow", async () => {
    const contract = JSON.parse(await readFile(new URL("../zig-out/repository-steward/repository-steward.decision-contract.json", import.meta.url), "utf8"));
    const fixturePolicy = JSON.parse(await readFile(new URL("../fixtures/zig-repository-v1/policy.json", import.meta.url), "utf8"));
    const modelLimit = contract.instructions.match(/Use at most ([0-9]+) applied replacements across at most four distinct files\./);
    expect(modelLimit).not.toBeNull();
    expect(Number(modelLimit[1])).toBe(_workspaceInternals.compiledLimits.maximumMutationOperations);
    expect(fixturePolicy.limits.maximumMutationOperations).toBeLessThan(_workspaceInternals.compiledLimits.maximumMutationOperations);
    expect(() => admitWorkspacePolicy(fixturePolicy, {
      repository: fixturePolicy.repository,
      baseRevision: fixturePolicy.baseRevision,
    })).not.toThrow();
  });

  test("admits only exact sorted bounded policy", () => {
    const admitted = admitWorkspacePolicy(rawPolicy(), { repository: "tkersey/fixture", baseRevision });
    expect(admitted.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => admitWorkspacePolicy(rawPolicy({ readablePaths: ["src/main.zig", "build.zig"] }), { repository: "tkersey/fixture", baseRevision })).toThrow(/byte-sorted/);
    expect(() => admitWorkspacePolicy(rawPolicy({ writablePaths: ["other.zig"] }), { repository: "tkersey/fixture", baseRevision })).toThrow(/subset/);
    expect(() => admitWorkspacePolicy(rawPolicy({ readablePaths: ["../secret"] }), { repository: "tkersey/fixture", baseRevision })).toThrow(/normalized/);
    expect(() => admitWorkspacePolicy(rawPolicy({ check: { kind: "zig-build-check-v1", argv: ["test"] } }), { repository: "tkersey/fixture", baseRevision })).toThrow(/check mismatch/);
    expect(() => admitWorkspacePolicy(rawPolicy({ limits: { ...rawPolicy().limits, maximumMutationOperations: 11 } }), { repository: "tkersey/fixture", baseRevision })).toThrow(/exceeds compiled maximum/);
  });
});

describe("workspace adapter", () => {
  test("lists, reads, and searches only admitted ordinary UTF-8 files", async () => {
    const { context } = await fixture();
    expect((await preflight(context, request("list"))).status).toBe("ok");
    const listed = await resolve(context, request("list"));
    expect(listed.payload.entries.map((entry) => entry.path)).toEqual(["build.zig", "src/main.zig", "test/main.zig"]);
    expect(listed.payload.entries.map((entry) => entry.writable)).toEqual([false, true, true]);
    const read = await resolve(context, request("read", { path: "src/main.zig" }));
    expect(read.payload.sha256).toBe(digest("const value = 0;\n"));
    const searched = await resolve(context, request("search", { query: "value", path_prefix: "src/" }));
    expect(searched.payload.hits).toEqual([{ path: "src/main.zig", line: 1, excerpt: "const value = 0;" }]);
    const invalidPrefix = await resolve(context, request("search", { query: "value", path_prefix: "src//" }));
    expect(invalidPrefix.status).toBe("failed");
    expect(context.lastWorkspaceFailure).toBe("path_prefix is not a normalized relative path");
    const denied = await resolve(context, request("read", { path: "README.md" }));
    expect(denied.status).toBe("failed");
  });

  test("fails closed when an admitted path becomes a symlink", async () => {
    const { root, context } = await fixture();
    await rm(join(root, "src/main.zig")); await symlink(join(root, "test/main.zig"), join(root, "src/main.zig"));
    expect((await resolve(context, request("list"))).status).toBe("failed");
  });

  test("approves a digest-bound atomic replacement and makes retry idempotent", async () => {
    const { root, context } = await fixture();
    const payload = { path: "src/main.zig", expected_sha256: digest("const value = 0;\n"), replacement: "const value = 1;\n", rationale: "Correct value." };
    const effect = request("replace", payload);
    const proposalDigest = replacementProposalDigest(context, effect);
    const first = await resolve(context, effect);
    expect(first.payload.outcome).toBe("applied"); expect(first.payload.value.already_applied).toBe(false);
    expect(await readFile(join(root, "src/main.zig"), "utf8")).toBe(payload.replacement);
    const approval = JSON.parse(await readFile(join(context.approvalRoot, `${effect.requestId}.json`), "utf8"));
    expect(approval.proposalDigest).toBe(proposalDigest); expect(approval.approved).toBe(true);
    const second = await resolve(context, effect);
    expect(second.payload.value.already_applied).toBe(true);
    expect(JSON.parse(await readFile(join(context.approvalRoot, `${effect.requestId}.json`), "utf8"))).toEqual(approval);
  });

  test("fresh content-equal request is denied without retained request-bound approval", async () => {
    const { context } = await fixture(1);
    const payload = {
      path: "src/main.zig",
      expected_sha256: digest("const value = 0;\n"),
      replacement: "const value = 0;\n",
      rationale: "Confirm existing bytes.",
    };
    const effect = request("replace", payload, "4".repeat(64));
    const result = await resolve(context, effect);
    expect(result.payload).toEqual({ outcome: "denied", value: { path: "src/main.zig", reason: "already_applied_without_matching_approval" } });
    expect(context.mutationCount ?? 0).toBe(0);
    expect(context.approvalBindings ?? []).toHaveLength(0);
    expect(await readFile(join(context.approvalRoot, `${effect.requestId}.json`), "utf8").catch((error) => error.code)).toBe("ENOENT");
  });

  test("receiver mutation ceiling denies a new write before approval but permits idempotent replay", async () => {
    const { root, context } = await fixture(1);
    const firstPayload = { path: "src/main.zig", expected_sha256: digest("const value = 0;\n"), replacement: "const value = 1;\n", rationale: "Correct value." };
    const firstEffect = request("replace", firstPayload);
    expect((await resolve(context, firstEffect)).payload.value.already_applied).toBe(false);
    expect((await resolve(context, firstEffect)).payload.value.already_applied).toBe(true);

    const deniedEffect = request("replace", {
      path: "src/main.zig",
      expected_sha256: digest(firstPayload.replacement),
      replacement: "const value = 2;\n",
      rationale: "Exceed the receiver ceiling.",
    }, "3".repeat(64));
    const denied = await resolve(context, deniedEffect);
    expect(denied.payload).toEqual({ outcome: "denied", value: { path: "src/main.zig", reason: "mutation_operation_limit_reached" } });
    expect(context.mutationCount).toBe(1);
    expect(context.approvalBindings).toHaveLength(1);
    expect(await readFile(join(root, "src/main.zig"), "utf8")).toBe(firstPayload.replacement);
  });

  test("post-rename failure remains charged and replay cannot exceed receiver ceiling", async () => {
    const { root, context } = await fixture(1);
    const firstPayload = { path: "src/main.zig", expected_sha256: digest("const value = 0;\n"), replacement: "const value = 1;\n", rationale: "Correct value." };
    const firstEffect = request("replace", firstPayload, "5".repeat(64));
    context.afterReplacementRename = async () => { throw new Error("simulated_post_rename_failure"); };
    const interrupted = await resolve(context, firstEffect);
    expect(interrupted.status).toBe("failed");
    expect(context.mutationCount).toBe(1);
    expect(context.approvalBindings).toHaveLength(1);
    expect(await readFile(join(root, "src/main.zig"), "utf8")).toBe(firstPayload.replacement);

    delete context.afterReplacementRename;
    const replay = await resolve(context, firstEffect);
    expect(replay.payload.value.already_applied).toBe(true);
    expect(context.mutationCount).toBe(1);
    expect(context.approvalBindings).toHaveLength(1);

    const denied = await resolve(context, request("replace", {
      path: "src/main.zig",
      expected_sha256: digest(firstPayload.replacement),
      replacement: "const value = 2;\n",
      rationale: "Exceed recovered receiver ceiling.",
    }, "6".repeat(64)));
    expect(denied.payload.value.reason).toBe("mutation_operation_limit_reached");
    expect(context.mutationCount).toBe(1);
    expect(await readFile(join(root, "src/main.zig"), "utf8")).toBe(firstPayload.replacement);
  });

  test("returns a typed conflict without writing", async () => {
    const { root, context } = await fixture();
    const outcome = await resolve(context, request("replace", { path: "src/main.zig", expected_sha256: "a".repeat(64), replacement: "new\n", rationale: "Try." }));
    expect(outcome.payload.outcome).toBe("conflict");
    expect(await readFile(join(root, "src/main.zig"), "utf8")).toBe("const value = 0;\n");
  });
});
