import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as workspaceAdapter from "../runtime/workspace-adapter.mjs";
import { createFixtureModelAdapter } from "../runtime/fixture-model-adapter.mjs";
import { createPraxisRouter } from "../runtime/bindings.mjs";
import { decodeFinalResult } from "../runtime/codecs.mjs";
import { sourceReceiptIdentity } from "./release-identity.mjs";
import { verifyFixture } from "../test/hidden-verifier.mjs";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const artifactsRoot = path.join(repositoryRoot, "zig-out/repository-steward");
const stackRoot = path.join(repositoryRoot, ".praxis/reference-stack/extracted");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: options.cwd ?? repositoryRoot, encoding: options.binary ? null : "utf8", maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024, env: options.env ?? process.env });
  if (result.error || (!options.allowFailure && result.status !== 0)) throw new Error(`${executable} ${args.join(" ")} failed\n${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result;
}

function parseArgs(argv) {
  const result = { runId: `deterministic-${Date.now()}`, zigExecutable: null, receipt: path.join(repositoryRoot, "conformance/praxis-v1/receipts/deterministic.json") };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1]; if (!value) throw new Error(`missing value for ${flag}`);
    if (flag === "--run-id") result.runId = value;
    else if (flag === "--zig") result.zigExecutable = path.resolve(value);
    else if (flag === "--receipt") result.receipt = path.resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!result.zigExecutable) result.zigExecutable = command("which", ["zig"]).stdout.trim();
  if (!path.isAbsolute(result.zigExecutable)) throw new Error("Zig executable must be absolute");
  return result;
}

export async function prepareRepository(runRoot) {
  const source = path.join(runRoot, "source"); const worktree = path.join(runRoot, "worktree");
  await fsp.mkdir(path.join(source, "src"), { recursive: true }); await fsp.mkdir(path.join(source, "test"), { recursive: true });
  for (const relative of ["build.zig", "build.zig.zon", "src/range.zig", "test/range_test.zig"]) {
    await fsp.copyFile(path.join(repositoryRoot, "fixtures/zig-repository-v1", relative), path.join(source, relative));
  }
  command("git", ["init", "--quiet"], { cwd: source });
  command("git", ["add", "--", "build.zig", "build.zig.zon", "src/range.zig", "test/range_test.zig"], { cwd: source });
  command("git", ["-c", "user.name=Praxis Fixture", "-c", "user.email=praxis@example.invalid", "commit", "--quiet", "-m", "fixture baseline"], {
    cwd: source,
    env: { ...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" },
  });
  const baseRevision = command("git", ["rev-parse", "HEAD"], { cwd: source }).stdout.trim();
  command("git", ["worktree", "add", "--quiet", "--detach", worktree, baseRevision], { cwd: source });
  assert.equal(command("git", ["status", "--porcelain"], { cwd: worktree }).stdout, "");
  return { source, worktree, baseRevision };
}

export async function initialArgs(options, taskPath, baseRevision) {
  const executable = path.join(repositoryRoot, "zig-out/bin/praxis-initial-args");
  const result = command(executable, ["--task-file", taskPath, "--repository", "tkersey/praxis-fixture", "--base-revision", baseRevision], { binary: true });
  return Buffer.from(result.stdout);
}

function publicApproval(value) {
  return { request_id: value.requestId, proposal_digest: value.proposalDigest, path: value.path, expected_sha256: value.expectedSha256, replacement_sha256: value.replacementSha256, policy_digest: value.policyDigest };
}

export async function runDeterministic(rawOptions = {}) {
  const options = { ...parseArgs([]), ...rawOptions };
  const version = command(options.zigExecutable, ["version"]).stdout.trim(); assert.equal(version, "0.16.0");
  const runRoot = path.resolve(rawOptions.runRoot ?? path.join(repositoryRoot, ".praxis/runs", options.runId));
  await fsp.rm(runRoot, { recursive: true, force: true }); await fsp.mkdir(runRoot, { recursive: true, mode: 0o700 });
  const prepared = await prepareRepository(runRoot);
  const rawPolicy = JSON.parse(await fsp.readFile(path.join(repositoryRoot, "fixtures/zig-repository-v1/policy.json"), "utf8"));
  rawPolicy.baseRevision = prepared.baseRevision;
  const admittedPolicy = workspaceAdapter.admitWorkspacePolicy(rawPolicy, { repository: rawPolicy.repository, baseRevision: prepared.baseRevision });
  const policyPath = path.join(runRoot, "policy.json"); await fsp.writeFile(policyPath, `${JSON.stringify(admittedPolicy.policy, null, 2)}\n`, { mode: 0o600 });
  const temporaryHome = path.join(runRoot, "home"); const approvalRoot = path.join(runRoot, "approvals"); await fsp.mkdir(temporaryHome, { recursive: true });
  const preflight = command(options.zigExecutable, ["build", "check", "--summary", "all"], {
    cwd: prepared.worktree, allowFailure: true,
    env: { HOME: temporaryHome, TMPDIR: temporaryHome, NO_COLOR: "1", ZIG_LOCAL_CACHE_DIR: path.join(temporaryHome, "preflight-local"), ZIG_GLOBAL_CACHE_DIR: path.join(temporaryHome, "preflight-global"), PATH: `${path.dirname(options.zigExecutable)}:/usr/bin:/bin` },
  });
  assert.notEqual(preflight.status, null); assert.notEqual(preflight.status, 0, "fixture baseline must fail");

  const taskPath = path.join(runRoot, "task.md");
  await fsp.writeFile(taskPath, "Replace the ambiguous half-open range helper with an explicitly named inclusive operation, update its existing behavioral test, and verify closed ranges including singleton ranges.\n", { mode: 0o600 });
  const bindingManifest = JSON.parse(await fsp.readFile(path.join(artifactsRoot, "repository-steward.binding-manifest.json"), "utf8"));
  const decisionContract = JSON.parse(await fsp.readFile(path.join(artifactsRoot, "repository-steward.decision-contract.json"), "utf8"));
  const wasmBytes = await fsp.readFile(rawOptions.wasmPath ?? path.join(artifactsRoot, "repository-steward.world.wasm"));
  const fixtureAdapter = createFixtureModelAdapter({ applicationId: bindingManifest.applicationId, policyDigest: admittedPolicy.digest, decisionContractDigest: bindingManifest.decisionContractDigest });
  const router = await createPraxisRouter({
    worldCapabilitiesRoot: path.join(stackRoot, "worldCapabilities/world-capabilities-v2.3.2-deterministic"),
    bindingManifest, workspaceAdapter, modelAdapter: fixtureAdapter, modelBindingId: "praxis-fixture-model.v1",
  });
  const host = await import(pathToFileURL(path.join(stackRoot, "worldHost/world-host-v1.0.2-runtime/src/v1/index.mjs")).href);
  const admissionLimits = Object.freeze({ ...host.DEFAULT_ADMISSION_LIMITS, maximumFuelPerStep: 1_000_000n });
  const blockStore = new host.MemoryBlockStore(); const headStore = new host.MemoryBranchHeadStore();
  const effectJournal = new host.MemoryEffectJournalV1({ blockStore });
  let workerCount = 0;
  const controller = await host.RunControllerV1.create({
    wasmBytes, blockStore, headStore, admissionLimits, effectJournal,
    workerFactory: () => { workerCount += 1; return new host.ApplicationWorker({ admissionLimits, maximumMemoryBytes: 256 * 1024 * 1024 }); },
    preflight: async (manifest) => ({ blockers: Buffer.from(manifest.applicationId).toString("hex") === bindingManifest.applicationId ? [] : ["application_id_mismatch"] }),
    faultInjector: rawOptions.faultInjector ?? (async () => {}),
  });
  const context = {
    applicationId: bindingManifest.applicationId, runId: options.runId,
    workspaceRoot: prepared.worktree, workspaceRootReal: await fsp.realpath(prepared.worktree),
    repository: admittedPolicy.policy.repository, baseRevision: prepared.baseRevision,
    policy: admittedPolicy.policy, policyDigest: admittedPolicy.digest,
    zigExecutable: options.zigExecutable, zigVersion: version, temporaryHome, approvalRoot,
    decisionContract, decisionContractDigest: bindingManifest.decisionContractDigest,
    manualFileEdits: 0, unapprovedWrites: 0,
  };
  const args = await initialArgs(options, taskPath, prepared.baseRevision);
  const runId = options.runId; const branchId = "main";
  const trace = { frames: [], results: [], stepNanoseconds: [] };
  rawOptions.onEnvironment?.({ controller, context, prepared, runId, branchId, args, wasmBytes, bindingManifest, host });
  let started = process.hrtime.bigint();
  let transition = await controller.initialize(runId, branchId, { initialArgsBytes: args });
  trace.stepNanoseconds.push(Number(process.hrtime.bigint() - started));
  const genesisFrameId = Buffer.from(transition.frame.frameId).toString("hex");
  const orderedInterfaces = []; let fuelYields = 0; let identicalYields = 0; let previousYieldDigest = null;
  let firstDecisionPayloadBytes = null; let peakDecisionPayloadBytes = 0;
  while (true) {
    assert.equal(transition.status, "advanced");
    const frame = transition.frame; trace.frames.push(Buffer.from(transition.frameBytes).toString("base64"));
    if (frame.status === host.FrameStatus.completed) break;
    if (frame.status === host.FrameStatus.failed || frame.status === host.FrameStatus.cancelled) throw new Error(`deterministic World run terminated with status ${frame.status}`);
    if (frame.status === host.FrameStatus.yieldedFuel) {
      fuelYields += 1; const digest = sha256(frame.stateBytes); identicalYields = digest === previousYieldDigest ? identicalYields + 1 : 1; previousYieldDigest = digest;
      if (identicalYields >= 10) throw new Error("fuel stall: ten identical yielded state digests");
      started = process.hrtime.bigint();
      transition = await controller.advance(runId, branchId);
      trace.stepNanoseconds.push(Number(process.hrtime.bigint() - started));
      continue;
    }
    assert.equal(frame.status, host.FrameStatus.needsEffect);
    const requestBytes = frame.pendingEffect.encodedBytes; const inspected = router.inspect(requestBytes);
    const interfaceEntry = bindingManifest.interfaces.find((entry) => entry.interfaceId === Buffer.from(frame.pendingEffect.interfaceId).toString("hex"));
    assert.ok(interfaceEntry); orderedInterfaces.push(interfaceEntry.interfaceLabel);
    if (interfaceEntry.interfaceLabel === "model.decide.v1") {
      const payloadBytes = frame.pendingEffect.payloadBytes.length;
      if (firstDecisionPayloadBytes === null) firstDecisionPayloadBytes = payloadBytes;
      peakDecisionPayloadBytes = Math.max(peakDecisionPayloadBytes, payloadBytes);
    }
    const resolution = await router.resolve(context, requestBytes);
    const metadata = { handlerId: resolution.handlerIdentity, handlerConfigurationId: resolution.handlerConfigurationIdentity, recoveryClass: resolution.recoveryClass };
    trace.results.push({ encodedBytes: Buffer.from(resolution.result.encodedBytes).toString("base64"), metadata, interfaceLabel: interfaceEntry.interfaceLabel });
    await rawOptions.beforeEffectAdvance?.({ transition, resolution, interfaceEntry, metadata, context });
    started = process.hrtime.bigint();
    transition = await controller.advance(runId, branchId, {
      effectResult: resolution.result,
      effectMetadata: metadata,
    });
    trace.stepNanoseconds.push(Number(process.hrtime.bigint() - started));
    assert.equal(inspected.effectAttempted, false);
  }
  const terminal = transition.frame; const finalResult = decodeFinalResult(terminal.finalResultBytes);
  const changedPaths = command("git", ["diff", "--name-only", prepared.baseRevision], { cwd: prepared.worktree }).stdout.trim().split("\n").filter(Boolean);
  assert.deepEqual(finalResult.changed_files, changedPaths); assert.equal(finalResult.mutation_count, context.mutationCount); assert.equal(finalResult.tests_passed, true);
  const hidden = verifyFixture({ worktree: prepared.worktree, baseRevision: prepared.baseRevision, policy: admittedPolicy.policy, zigExecutable: options.zigExecutable, evidence: context });
  const receipt = {
    praxis_format: 1, mode: "deterministic",
    ...await sourceReceiptIdentity(),
    application_id: bindingManifest.applicationId, application_wasm_sha256: sha256(wasmBytes),
    policy_digest: admittedPolicy.digest, base_revision: prepared.baseRevision,
    genesis_frame_id: genesisFrameId, terminal_frame_id: Buffer.from(terminal.frameId).toString("hex"),
    ordered_interfaces: orderedInterfaces,
    external_effect_count: orderedInterfaces.length,
    model_effect_count: orderedInterfaces.filter((item) => item === "model.decide.v1").length,
    non_model_effect_count: orderedInterfaces.filter((item) => item !== "model.decide.v1").length,
    test_count: context.testCount ?? 0, mutation_count: context.mutationCount ?? 0,
    changed_paths: changedPaths, approval_bindings: (context.approvalBindings ?? []).map(publicApproval),
    hidden_verifier_passed: hidden.hiddenVerifierPassed, typed_final_result: true,
    fresh_worker_per_step: workerCount === trace.frames.length + 1,
    manual_file_edits: context.manualFileEdits, unapproved_writes: context.unapprovedWrites,
  };
  trace.measurements = {
    applicationWasmBytes: wasmBytes.length,
    firstFrameBytes: Buffer.from(trace.frames[0], "base64").length,
    peakFrameBytes: Math.max(...trace.frames.map((value) => Buffer.from(value, "base64").length)),
    peakMachineStateBytes: Math.max(...trace.frames.map((value) => host.decodeFrame(Buffer.from(value, "base64"), controller.manifest.limits).stateBytes.length)),
    firstDecisionPayloadBytes,
    peakDecisionPayloadBytes,
    coldStepNanoseconds: trace.stepNanoseconds[0],
    warmStepNanoseconds: trace.stepNanoseconds.length > 1 ? Math.min(...trace.stepNanoseconds.slice(1)) : trace.stepNanoseconds[0],
    stepCount: trace.frames.length,
    fuelYieldCount: fuelYields,
  };
  assert.ok(receipt.mutation_count >= 2); assert.equal(receipt.test_count, receipt.mutation_count + 1); assert.equal(receipt.approval_bindings.length, receipt.mutation_count);
  assert.equal(receipt.fresh_worker_per_step, true);
  await fsp.writeFile(path.join(runRoot, "trace.json"), `${JSON.stringify({ ...trace, receipt, finalResult, fuelYields }, null, 2)}\n`, { mode: 0o600 });
  await fsp.mkdir(path.dirname(options.receipt), { recursive: true }); await fsp.writeFile(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, finalResult, runRoot, worktree: prepared.worktree, trace, hidden, controller, context, prepared, args, wasmBytes, bindingManifest, host };
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2));
  const result = await runDeterministic(options);
  process.stdout.write(`praxis_deterministic_terminal=${result.receipt.terminal_frame_id}\npraxis_deterministic=true\n`);
}
