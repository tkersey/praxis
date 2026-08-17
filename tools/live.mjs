import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as openaiAdapter from "../runtime/openai-adapter.mjs";
import * as workspaceAdapter from "../runtime/workspace-adapter.mjs";
import { createPraxisRouter } from "../runtime/bindings.mjs";
import { decodeFinalResult } from "../runtime/codecs.mjs";
import { verifyCandidate } from "./candidate.mjs";
import { verifyFinalWorktree } from "./verify-final-worktree.mjs";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const artifactsRoot = path.join(repositoryRoot, "zig-out/repository-steward");
const stackRoot = path.join(repositoryRoot, ".praxis/reference-stack/extracted");
const utf8 = new TextDecoder("utf-8", { fatal: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: options.cwd ?? repositoryRoot, encoding: options.binary ? null : "utf8", maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024, env: options.env ?? process.env });
  if (result.error || (!options.allowFailure && result.status !== 0)) throw new Error(`${executable} ${args.join(" ")} failed\n${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1]; if (!value) throw new Error(`missing value for ${flag}`);
    const names = {
      "--repository-root": "repositoryRoot", "--repository": "repository", "--base-revision": "baseRevision",
      "--task-file": "taskFile", "--policy": "policy", "--zig": "zigExecutable", "--candidate": "candidate",
      "--store": "store", "--receipt": "receipt",
    };
    if (!names[flag]) throw new Error(`unknown argument ${flag}`);
    result[names[flag]] = value;
  }
  for (const key of ["repositoryRoot", "repository", "baseRevision", "taskFile", "policy", "zigExecutable", "candidate", "store", "receipt"]) if (!result[key]) throw new Error(`${key} is required`);
  for (const key of ["repositoryRoot", "taskFile", "policy", "zigExecutable", "candidate", "store", "receipt"]) result[key] = path.resolve(result[key]);
  if (!/^[0-9a-f]{40}$/.test(result.baseRevision)) throw new Error("baseRevision must be forty lowercase hexadecimal characters");
  if (!path.isAbsolute(result.repositoryRoot) || !path.isAbsolute(result.zigExecutable) || !path.isAbsolute(result.store)) throw new Error("live paths must be absolute");
  return result;
}

function fixedCheckEnvironment(zigExecutable, temporaryHome) {
  return { HOME: temporaryHome, TMPDIR: temporaryHome, NO_COLOR: "1", ZIG_LOCAL_CACHE_DIR: path.join(temporaryHome, "operator-local"), ZIG_GLOBAL_CACHE_DIR: path.join(temporaryHome, "operator-global"), PATH: `${path.dirname(zigExecutable)}:/usr/bin:/bin` };
}

function publicApproval(value) {
  return { request_id: value.requestId, proposal_digest: value.proposalDigest, path: value.path, expected_sha256: value.expectedSha256, replacement_sha256: value.replacementSha256, policy_digest: value.policyDigest };
}

function testSequenceIsFresh(interfaces) {
  let mutations = 0; let lastTestMutationCount = -1;
  for (const label of interfaces) {
    if (label === "repo.test.v2") lastTestMutationCount = mutations;
    if (label === "repo.replace.approved.v2") {
      if (lastTestMutationCount !== mutations) return false;
      mutations += 1;
    }
  }
  return mutations > 0 && lastTestMutationCount === mutations;
}

async function attemptCount(store) {
  const directory = path.join(store, "attempts");
  const entries = await readdir(directory).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  return entries.filter((entry) => entry.endsWith(".json")).length;
}

async function writePublicReceipt(target, receipt) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`);
}

async function writeFailure(options, runId, details) {
  const failure = {
    praxis_format: 1,
    mode: "live-failure",
    run_id_sha256: sha256(runId),
    candidate_commit: details.candidate?.praxisCommit ?? null,
    application_id: details.candidate?.applicationId ?? null,
    repository: options.repository,
    base_revision: options.baseRevision,
    terminal_status: details.terminalStatus ?? "failed",
    failure_class: String(details.error?.message ?? details.error ?? "unknown_failure").slice(0, 256),
    external_effect_count: details.orderedInterfaces?.length ?? 0,
    ordered_interfaces: details.orderedInterfaces ?? [],
    raw_prompt_recorded: false,
    raw_repository_content_recorded: false,
    raw_model_output_recorded: false,
    openai_api_key_recorded: false,
  };
  const target = path.join(options.store, "attempts", `${runId}.failure.json`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writePublicReceipt(target, failure);
  await writePublicReceipt(options.receipt, failure);
  return failure;
}

export async function runLive(options) {
  const runId = `live-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID()}`;
  const runRoot = path.join(options.store, "runs", runId);
  let candidate = null; const orderedInterfaces = []; let terminalStatus = null;
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required");
    if (!process.env.OPENAI_MODEL) throw new Error("OPENAI_MODEL is required");
    candidate = await verifyCandidate(options.candidate);
    assert.equal(command(options.zigExecutable, ["version"]).stdout.trim(), "0.16.0");
    await mkdir(runRoot, { recursive: false, mode: 0o700 });
    const sourceRoot = await realpath(command("git", ["-C", options.repositoryRoot, "rev-parse", "--show-toplevel"]).stdout.trim());
    assert.equal(sourceRoot, await realpath(options.repositoryRoot));
    command("git", ["-C", sourceRoot, "cat-file", "-e", `${options.baseRevision}^{commit}`]);
    const worktree = path.join(runRoot, "worktree");
    command("git", ["-C", sourceRoot, "worktree", "add", "--quiet", "--detach", worktree, options.baseRevision]);
    assert.equal(command("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: worktree }).stdout, "");
    const workspaceRootReal = await realpath(worktree);
    const rawPolicy = JSON.parse(await readFile(options.policy, "utf8"));
    const admitted = workspaceAdapter.admitWorkspacePolicy(rawPolicy, { repository: options.repository, baseRevision: options.baseRevision });
    const retainedPolicyPath = path.join(runRoot, "policy.json");
    await writeFile(retainedPolicyPath, `${JSON.stringify(admitted.policy, null, 2)}\n`, { mode: 0o600 });
    await writeFile(path.join(runRoot, "run-metadata.json"), `${JSON.stringify({
      format: "praxis-private-run-metadata/v1", repository: options.repository, baseRevision: options.baseRevision,
      candidate: options.candidate, zigExecutable: options.zigExecutable, policy: retainedPolicyPath,
    }, null, 2)}\n`, { mode: 0o600 });
    const temporaryHome = path.join(runRoot, "home"); const approvalRoot = path.join(runRoot, "approvals");
    await mkdir(temporaryHome, { recursive: true, mode: 0o700 });
    const bindingManifest = JSON.parse(await readFile(path.join(artifactsRoot, "repository-steward.binding-manifest.json"), "utf8"));
    const decisionContract = JSON.parse(await readFile(path.join(artifactsRoot, "repository-steward.decision-contract.json"), "utf8"));
    const wasmBytes = await readFile(path.join(artifactsRoot, "repository-steward.world.wasm"));
    assert.equal(bindingManifest.applicationId, candidate.applicationId); assert.equal(sha256(wasmBytes), candidate.applicationWasmSha256);
    const context = {
      applicationId: candidate.applicationId, runId, workspaceRoot: worktree, workspaceRootReal,
      repository: options.repository, baseRevision: options.baseRevision, policy: admitted.policy, policyDigest: admitted.digest,
      zigExecutable: options.zigExecutable, zigVersion: "0.16.0", temporaryHome, approvalRoot,
      decisionContract, decisionContractDigest: candidate.decisionContractDigest,
      model: process.env.OPENAI_MODEL, allowedModels: [process.env.OPENAI_MODEL], secrets: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
      timeoutMs: 180_000, manualFileEdits: 0, unapprovedWrites: 0,
    };
    await workspaceAdapter._workspaceInternals.listRepository(context); context.workspaceAdapterInvocations = 0;
    const preflight = command(options.zigExecutable, ["build", "check", "--summary", "all"], { cwd: worktree, allowFailure: true, env: fixedCheckEnvironment(options.zigExecutable, temporaryHome) });
    if (preflight.status !== 0) throw new Error("operator preflight check failed");
    const taskBytes = await readFile(options.taskFile); utf8.decode(taskBytes);
    const initialArgsResult = command(path.join(repositoryRoot, "zig-out/bin/praxis-initial-args"), ["--task-file", options.taskFile, "--repository", options.repository, "--base-revision", options.baseRevision], { binary: true });
    const router = await createPraxisRouter({
      worldCapabilitiesRoot: path.join(stackRoot, "worldCapabilities/world-capabilities-v2.3.2-deterministic"), bindingManifest,
      workspaceAdapter, modelAdapter: openaiAdapter, modelBindingId: "praxis-openai.v1",
    });
    const host = await import(pathToFileURL(path.join(stackRoot, "worldHost/world-host-v1.0.1-runtime/src/v1/index.mjs")).href);
    const runtimeRoot = path.join(runRoot, "runtime-store"); await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    const blockStore = new host.DirectoryBlockStore(runtimeRoot);
    const headStore = new host.DirectoryBranchHeadStore(runtimeRoot, { blockStore });
    const effectJournal = new host.DirectoryEffectJournalV1({ root: runtimeRoot, blockStore });
    let workerCount = 0;
    const controller = await host.RunControllerV1.create({
      wasmBytes, blockStore, headStore, effectJournal,
      workerFactory: () => { workerCount += 1; return new host.ApplicationWorker({ maximumMemoryBytes: 256 * 1024 * 1024 }); },
      preflight: async (manifest) => ({ blockers: Buffer.from(manifest.applicationId).toString("hex") === candidate.applicationId ? [] : ["application_identity_mismatch"] }),
    });
    const branchId = "main"; let frameCount = 0; let transition = await controller.initialize(runId, branchId, { initialArgsBytes: Buffer.from(initialArgsResult.stdout) });
    const genesisFrameId = Buffer.from(transition.frame.frameId).toString("hex");
    let identicalYields = 0; let previousYield = null; const providerClaims = [];
    while (true) {
      assert.equal(transition.status, "advanced"); frameCount += 1;
      const frame = transition.frame;
      if (frame.status === host.FrameStatus.completed) { terminalStatus = "completed"; break; }
      if (frame.status === host.FrameStatus.failed || frame.status === host.FrameStatus.cancelled) {
        terminalStatus = frame.status; throw new Error(`World terminal status ${frame.status}`);
      }
      if (frame.status === host.FrameStatus.yieldedFuel) {
        const digest = sha256(frame.stateBytes); identicalYields = digest === previousYield ? identicalYields + 1 : 1; previousYield = digest;
        if (identicalYields >= 10) throw new Error("fuel stall: ten identical yielded state digests");
        transition = await controller.advance(runId, branchId); continue;
      }
      assert.equal(frame.status, host.FrameStatus.needsEffect);
      const interfaceEntry = bindingManifest.interfaces.find((entry) => entry.interfaceId === Buffer.from(frame.pendingEffect.interfaceId).toString("hex"));
      assert.ok(interfaceEntry); orderedInterfaces.push(interfaceEntry.interfaceLabel);
      process.stderr.write(`effect=${orderedInterfaces.length} interface=${interfaceEntry.interfaceLabel}\n`);
      const inspected = router.inspect(frame.pendingEffect.encodedBytes); assert.equal(inspected.effectAttempted, false);
      const resolution = await router.resolve(context, frame.pendingEffect.encodedBytes);
      if (interfaceEntry.interfaceLabel === "model.decide.v1" && resolution.result.hostClaims.length > 0) {
        const claim = JSON.parse(utf8.decode(resolution.result.hostClaims)); providerClaims.push(claim);
      }
      transition = await controller.advance(runId, branchId, {
        effectResult: resolution.result,
        effectMetadata: { handlerId: resolution.handlerIdentity, handlerConfigurationId: resolution.handlerConfigurationIdentity, recoveryClass: resolution.recoveryClass },
      });
    }
    const terminal = transition.frame; const finalResult = decodeFinalResult(terminal.finalResultBytes);
    const changedPaths = command("git", ["diff", "--name-only", options.baseRevision, "--"], { cwd: worktree }).stdout.trim().split("\n").filter(Boolean);
    assert.deepEqual(finalResult.changed_files, changedPaths); assert.equal(finalResult.mutation_count, context.mutationCount); assert.equal(finalResult.tests_passed, true);
    assert.ok(testSequenceIsFresh(orderedInterfaces));
    const terminalFileDigests = {};
    for (const changed of changedPaths) {
      const info = await lstat(path.join(worktree, changed)); if (!info.isFile()) throw new Error("terminal changed path is not a file");
      terminalFileDigests[changed] = sha256(await readFile(path.join(worktree, changed)));
    }
    const diffBytes = command("git", ["diff", "--binary", "--no-ext-diff", "--full-index", options.baseRevision, "--", ...changedPaths], { cwd: worktree, binary: true }).stdout;
    const privateEvidence = {
      run_id_sha256: sha256(runId), frame_ids: [genesisFrameId, Buffer.from(terminal.frameId).toString("hex")],
      result_ids: [], terminal_file_digests: terminalFileDigests, ordered_interfaces: orderedInterfaces,
    };
    const previousAttempts = await attemptCount(options.store);
    const receipt = {
      praxis_format: 1, mode: "live", candidate_commit: candidate.praxisCommit, application_id: candidate.applicationId,
      application_wasm_sha256: candidate.applicationWasmSha256, repository: options.repository, base_revision: options.baseRevision,
      task_sha256: sha256(taskBytes), policy_sha256: admitted.digest, genesis_frame_id: genesisFrameId,
      terminal_frame_id: Buffer.from(terminal.frameId).toString("hex"), terminal_status: "completed",
      external_effect_count: orderedInterfaces.length, model_effect_count: orderedInterfaces.filter((value) => value === "model.decide.v1").length,
      non_model_effect_count: orderedInterfaces.filter((value) => value !== "model.decide.v1").length,
      test_count: context.testCount ?? 0, mutation_count: context.mutationCount ?? 0, unique_changed_file_count: changedPaths.length,
      changed_paths: changedPaths, ordered_interfaces: orderedInterfaces, approval_bindings: (context.approvalBindings ?? []).map(publicApproval),
      final_diff_sha256: sha256(diffBytes), typed_final_result: true, final_check_passed: false, independent_verifier_passed: false,
      fresh_worker_per_step: workerCount === frameCount + 1, manual_file_edits: context.manualFileEdits, unapproved_writes: context.unapprovedWrites,
      openai_responses_api: true, openai_tools_count: 0, openai_store: false, openai_api_key_recorded: false,
      raw_prompt_recorded: false, raw_repository_content_recorded: false, raw_model_output_recorded: false,
      provider_returned_models: [...new Set(providerClaims.map((claim) => claim.returnedModel))],
      provider_response_id_digests: providerClaims.map((claim) => claim.responseIdSha256),
      input_tokens: providerClaims.reduce((sum, claim) => sum + claim.inputTokens, 0), output_tokens: providerClaims.reduce((sum, claim) => sum + claim.outputTokens, 0),
      total_tokens: providerClaims.reduce((sum, claim) => sum + claim.totalTokens, 0), live_attempt_count: previousAttempts + 1, live_success_count: 1,
      private_evidence_digest: sha256(Buffer.from(JSON.stringify(privateEvidence))), terminal_file_digests: terminalFileDigests,
    };
    assert.equal(receipt.fresh_worker_per_step, true); assert.ok(receipt.mutation_count >= 1 && receipt.mutation_count <= 6);
    assert.ok(receipt.unique_changed_file_count >= 1 && receipt.unique_changed_file_count <= 4);
    const verifier = await verifyFinalWorktree({ receipt, worktree, candidate: options.candidate, policy: rawPolicy, zigExecutable: options.zigExecutable, approvalRoot, temporaryHome: path.join(runRoot, "verify-home") });
    receipt.final_diff_sha256 = verifier.final_diff_sha256; receipt.final_check_passed = verifier.final_check_passed; receipt.independent_verifier_passed = verifier.independent_verifier_passed;
    const attemptReceipt = path.join(options.store, "attempts", `${runId}.success.json`); await mkdir(path.dirname(attemptReceipt), { recursive: true, mode: 0o700 });
    await writePublicReceipt(attemptReceipt, receipt); await writePublicReceipt(options.receipt, receipt);
    return Object.freeze({ receipt, worktree, runRoot, approvalRoot, policy: rawPolicy, verifier });
  } catch (error) {
    await writeFailure(options, runId, { candidate, error, terminalStatus, orderedInterfaces });
    throw error;
  }
}

if (import.meta.main) {
  const result = await runLive(parseArgs(process.argv.slice(2)));
  process.stdout.write(`praxis_live_receipt=${path.resolve(parseArgs(process.argv.slice(2)).receipt)}\npraxis_live_worktree=${result.worktree}\n`);
}

export const _liveInternals = { parseArgs, testSequenceIsFresh };
