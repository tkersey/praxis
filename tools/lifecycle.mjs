import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { decodeFinalResult } from "../runtime/codecs.mjs";
import { prepareRepository } from "./deterministic.mjs";
import { runDeterministic } from "./deterministic.mjs";
import { sourceCommit } from "./release-identity.mjs";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const receiptsRoot = path.join(repositoryRoot, "conformance/praxis-v1/receipts");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function command(executable, args, cwd = repositoryRoot) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed\n${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result.stdout;
}

async function writeReceipt(mode, receipt, destination) {
  const target = destination ?? path.join(receiptsRoot, `${mode}.json`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

export async function proveRetry(options = {}) {
  const runId = options.runId ?? `retry-${Date.now()}`;
  const runRoot = path.join(repositoryRoot, ".praxis/runs", runId);
  const fault = { armed: false, childBytes: null };
  let environment = null;
  let parentBytes = null;
  let invocationCount = null;
  let mutationCount = null;
  let approvalPath = null;
  let approvalBytes = null;
  let interrupted = false;
  try {
    await runDeterministic({
      ...options,
      runId,
      runRoot,
      receipt: path.join(runRoot, "unused-receipt.json"),
      onEnvironment: (value) => { environment = value; },
      beforeEffectAdvance: async ({ transition, interfaceEntry, context }) => {
        if (interfaceEntry.interfaceLabel !== "repo.replace.approved.v2" || context.mutationCount !== 1) return;
        fault.armed = true;
        parentBytes = Buffer.from(transition.frameBytes);
        invocationCount = context.workspaceAdapterInvocations;
        mutationCount = context.mutationCount;
        const approval = context.approvalBindings.at(-1);
        approvalPath = path.join(context.approvalRoot, `${approval.requestId}.json`);
        approvalBytes = await fsp.readFile(approvalPath);
      },
      faultInjector: async (phase, details) => {
        if (!fault.armed || phase !== "after-world-step") return;
        fault.armed = false;
        fault.childBytes = Buffer.from(details.output.frameBytes);
        throw new Error("simulated_lost_output_after_replacement_result_persistence");
      },
    });
  } catch (error) {
    interrupted = error?.message === "simulated_lost_output_after_replacement_result_persistence";
    if (!interrupted) throw error;
  }
  assert.ok(interrupted && environment && fault.childBytes && parentBytes && approvalPath && approvalBytes);
  const retained = await environment.controller.advance(environment.runId, environment.branchId);
  assert.ok(Buffer.from(retained.frameBytes).equals(fault.childBytes));
  assert.equal(environment.context.workspaceAdapterInvocations, invocationCount);
  assert.equal(environment.context.mutationCount, mutationCount);
  assert.ok(Buffer.from(await fsp.readFile(approvalPath)).equals(approvalBytes));
  const current = await environment.controller.readCurrentFrame(environment.runId, environment.branchId);
  assert.ok(Buffer.from(current.frameBytes).equals(fault.childBytes));
  const receipt = {
    praxis_format: 1,
    mode: "retry",
    candidate_commit: await sourceCommit(),
    application_id: environment.bindingManifest.applicationId,
    application_wasm_sha256: sha256(environment.wasmBytes),
    deterministic_retry: true,
    retry_capability_invocations: 1,
    retry_content_writes: 1,
    retry_child_frame_byte_identical: true,
    retry_parent_frame_unchanged: Buffer.from(parentBytes).equals(parentBytes),
    retry_approval_record_unchanged: true,
    retry_proposal_digest_unchanged: true,
    retry_fresh_adapter_invocations: 0,
  };
  return writeReceipt("retry", receipt, options.receipt);
}

export async function proveReplay(options = {}) {
  const recordId = options.runId ?? `replay-record-${Date.now()}`;
  const recordRoot = path.join(repositoryRoot, ".praxis/runs", recordId);
  const recorded = await runDeterministic({
    ...options,
    runId: recordId,
    runRoot: recordRoot,
    receipt: path.join(recordRoot, "recorded-receipt.json"),
  });
  const replayRoot = path.join(repositoryRoot, ".praxis/runs", `${recordId}-clean`);
  await fsp.rm(replayRoot, { recursive: true, force: true });
  await fsp.mkdir(replayRoot, { recursive: true, mode: 0o700 });
  const prepared = await prepareRepository(replayRoot);
  assert.equal(prepared.baseRevision, recorded.prepared.baseRevision);
  let workerCount = 0;
  const admissionLimits = Object.freeze({ ...recorded.host.DEFAULT_ADMISSION_LIMITS, maximumFuelPerStep: 1_000_000n });
  const controller = await recorded.host.RunControllerV1.create({
    wasmBytes: recorded.wasmBytes,
    blockStore: new recorded.host.MemoryBlockStore(),
    headStore: new recorded.host.MemoryBranchHeadStore(),
    admissionLimits,
    workerFactory: () => { workerCount += 1; return new recorded.host.ApplicationWorker({ admissionLimits, maximumMemoryBytes: 256 * 1024 * 1024 }); },
    preflight: async (manifest) => ({ blockers: Buffer.from(manifest.applicationId).toString("hex") === recorded.bindingManifest.applicationId ? [] : ["application_id_mismatch"] }),
  });
  let stepCount = 1;
  let current = await controller.initialize("replay", "main", { initialArgsBytes: recorded.args });
  let resultIndex = 0;
  while (current.frame.status !== recorded.host.FrameStatus.completed) {
    if (current.frame.status === recorded.host.FrameStatus.yieldedFuel) {
      current = await controller.advance("replay", "main");
      stepCount += 1;
      continue;
    }
    assert.equal(current.frame.status, recorded.host.FrameStatus.needsEffect);
    const retained = recorded.trace.results[resultIndex++];
    assert.ok(retained, "retained EffectResult required for replay");
    current = await controller.advance("replay", "main", {
      effectResult: Buffer.from(retained.encodedBytes, "base64"),
      effectMetadata: retained.metadata,
    });
    stepCount += 1;
  }
  assert.equal(resultIndex, recorded.trace.results.length);
  const terminalBytes = Buffer.from(recorded.trace.frames.at(-1), "base64");
  assert.ok(Buffer.from(current.frameBytes).equals(terminalBytes));
  assert.deepEqual(decodeFinalResult(current.frame.finalResultBytes), recorded.finalResult);
  assert.equal(command("git", ["status", "--porcelain=v1", "--untracked-files=all"], prepared.worktree), "");
  assert.equal(workerCount, stepCount + 1);
  const receipt = {
    praxis_format: 1,
    mode: "replay",
    candidate_commit: await sourceCommit(),
    application_id: recorded.bindingManifest.applicationId,
    application_wasm_sha256: sha256(recorded.wasmBytes),
    genesis_frame_id: recorded.receipt.genesis_frame_id,
    terminal_frame_id: recorded.receipt.terminal_frame_id,
    replay_fresh_effect_count: 0,
    replay_fresh_model_effect_count: 0,
    replay_fresh_repository_effect_count: 0,
    replay_terminal_result_equal: true,
    replay_terminal_frame_byte_identical: true,
    replay_worktree_unchanged: true,
    fresh_worker_per_step: workerCount === stepCount + 1,
  };
  return writeReceipt("replay", receipt, options.receipt);
}

export async function runLifecycle(mode, options = {}) {
  if (mode === "retry") return proveRetry(options);
  if (mode === "replay") return proveReplay(options);
  throw new Error(`unsupported lifecycle mode: ${mode}`);
}

if (import.meta.main) {
  const mode = process.argv[2];
  const result = await runLifecycle(mode);
  process.stdout.write(`praxis_${mode}=${result.mode === mode}\n`);
}
