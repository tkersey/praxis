import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { releaseVersion, sourceManifestPath, versionedCandidatePath, versionedConformanceRelative } from "./release-identity.mjs";

export const defaultCandidatePath = versionedCandidatePath;

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const conformanceRoot = path.join(repositoryRoot, "conformance/praxis-v1");
const artifactsRoot = path.join(repositoryRoot, "zig-out/repository-steward");
export const protectedCandidatePaths = Object.freeze([
  ".gitattributes", ".github", "build.zig", "build.zig.zon", "src", "runtime", "fixtures", "test",
  "tools", "package.json", "conformance/praxis-v1/reference-stack.lock.json",
  "conformance/praxis-v1.0.5/obstructions/model-visible-budget-parity/README.md",
  "conformance/praxis-v1.0.5/obstructions/model-visible-budget-parity/result.json",
  versionedConformanceRelative,
  `:(exclude)${versionedConformanceRelative}/candidate.json`,
]);

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || (!allowFailure && result.status !== 0)) throw new Error(`git ${args.join(" ")} failed\n${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result;
}

export async function digestFile(file) {
  return createHash("sha256").update(await fsp.readFile(file)).digest("hex");
}

async function json(file) { return JSON.parse(await fsp.readFile(file, "utf8")); }

function requireDigest(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} is not a SHA-256 digest`);
  return value;
}

const candidateKeys = Object.freeze([
  "format", "praxisCommit", "applicationId", "applicationWasmSha256",
  "decisionContractDigest", "bindingManifestSha256", "workspaceAdapterSha256",
  "openaiAdapterSha256", "codecsSha256", "referenceStackLockSha256",
  "sourceManifestSha256",
  "deterministicReceiptSha256", "retryReceiptSha256", "replayReceiptSha256",
  "measureReceiptSha256",
].sort());

export function assertCandidateShape(candidate) {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("candidate must be an object");
  if (candidate.format !== "praxis-candidate/v1" || !/^[0-9a-f]{40}$/.test(candidate.praxisCommit)) throw new Error("candidate format is invalid");
  if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(candidateKeys)) throw new Error("candidate fields are not exact");
  return candidate;
}

export async function candidateInputs() {
  const [binding, deterministic, retry, replay, measure] = await Promise.all([
    json(path.join(artifactsRoot, "repository-steward.binding-manifest.json")),
    json(path.join(conformanceRoot, "receipts/deterministic.json")),
    json(path.join(conformanceRoot, "receipts/retry.json")),
    json(path.join(conformanceRoot, "receipts/replay.json")),
    json(path.join(conformanceRoot, "receipts/measure.json")),
  ]);
  const proofCommit = deterministic.candidate_commit;
  assert.equal(binding.applicationVersion, releaseVersion, "binding application version differs from package release version");
  const applicationWasmSha256 = await digestFile(path.join(artifactsRoot, "repository-steward.world.wasm"));
  for (const receipt of [deterministic, retry, replay, measure]) {
    if (!/^[0-9a-f]{40}$/.test(receipt.candidate_commit)) throw new Error(`${receipt.mode} receipt candidate is invalid`);
    if (receipt.application_id !== binding.applicationId) throw new Error(`${receipt.mode} application identity mismatch`);
    if (receipt.application_wasm_sha256 !== applicationWasmSha256) throw new Error(`${receipt.mode} application WASM identity mismatch`);
  }
  for (const receipt of [retry, replay, measure]) {
    const diff = git(["diff", "--quiet", receipt.candidate_commit, "HEAD", "--", ...protectedCandidatePaths], { allowFailure: true });
    if (diff.status !== 0) throw new Error(`${receipt.mode} proof is stale for protected candidate files`);
  }
  const deterministicDiff = git(["diff", "--quiet", proofCommit, "HEAD", "--", ...protectedCandidatePaths], { allowFailure: true });
  if (deterministicDiff.status !== 0) throw new Error("deterministic proof is stale for protected candidate files");
  assert.equal(deterministic.hidden_verifier_passed, true);
  assert.equal(deterministic.typed_final_result, true);
  assert.equal(retry.deterministic_retry, true);
  assert.equal(replay.replay_terminal_frame_byte_identical, true);
  assert.ok(Object.values(measure.gates).every(Boolean));
  return { binding, deterministic, retry, replay, measure };
}

export async function freezeCandidate({ output = defaultCandidatePath } = {}) {
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]).stdout !== "") throw new Error("candidate freeze requires a clean working tree");
  const inputs = await candidateInputs();
  const candidate = {
    format: "praxis-candidate/v1",
    praxisCommit: git(["rev-parse", "HEAD"]).stdout.trim(),
    applicationId: requireDigest(inputs.binding.applicationId, "applicationId"),
    applicationWasmSha256: await digestFile(path.join(artifactsRoot, "repository-steward.world.wasm")),
    decisionContractDigest: requireDigest(inputs.binding.decisionContractDigest, "decisionContractDigest"),
    bindingManifestSha256: await digestFile(path.join(artifactsRoot, "repository-steward.binding-manifest.json")),
    workspaceAdapterSha256: await digestFile(path.join(repositoryRoot, "runtime/workspace-adapter.mjs")),
    openaiAdapterSha256: await digestFile(path.join(repositoryRoot, "runtime/openai-adapter.mjs")),
    codecsSha256: await digestFile(path.join(repositoryRoot, "runtime/codecs.mjs")),
    referenceStackLockSha256: await digestFile(path.join(conformanceRoot, "reference-stack.lock.json")),
    sourceManifestSha256: await digestFile(sourceManifestPath),
    deterministicReceiptSha256: await digestFile(path.join(conformanceRoot, "receipts/deterministic.json")),
    retryReceiptSha256: await digestFile(path.join(conformanceRoot, "receipts/retry.json")),
    replayReceiptSha256: await digestFile(path.join(conformanceRoot, "receipts/replay.json")),
    measureReceiptSha256: await digestFile(path.join(conformanceRoot, "receipts/measure.json")),
  };
  await fsp.mkdir(path.dirname(output), { recursive: true });
  await fsp.writeFile(output, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
  return candidate;
}

export async function verifyCandidate(candidatePath) {
  const candidate = assertCandidateShape(await json(path.resolve(candidatePath)));
  const inputs = await candidateInputs();
  const expected = {
    applicationId: inputs.binding.applicationId,
    applicationWasmSha256: await digestFile(path.join(artifactsRoot, "repository-steward.world.wasm")),
    decisionContractDigest: inputs.binding.decisionContractDigest,
    bindingManifestSha256: await digestFile(path.join(artifactsRoot, "repository-steward.binding-manifest.json")),
    workspaceAdapterSha256: await digestFile(path.join(repositoryRoot, "runtime/workspace-adapter.mjs")),
    openaiAdapterSha256: await digestFile(path.join(repositoryRoot, "runtime/openai-adapter.mjs")),
    codecsSha256: await digestFile(path.join(repositoryRoot, "runtime/codecs.mjs")),
    referenceStackLockSha256: await digestFile(path.join(conformanceRoot, "reference-stack.lock.json")),
    sourceManifestSha256: await digestFile(sourceManifestPath),
    deterministicReceiptSha256: await digestFile(path.join(conformanceRoot, "receipts/deterministic.json")),
    retryReceiptSha256: await digestFile(path.join(conformanceRoot, "receipts/retry.json")),
    replayReceiptSha256: await digestFile(path.join(conformanceRoot, "receipts/replay.json")),
    measureReceiptSha256: await digestFile(path.join(conformanceRoot, "receipts/measure.json")),
  };
  for (const [key, value] of Object.entries(expected)) if (candidate[key] !== value) throw new Error(`candidate ${key} mismatch`);
  const protectedDiff = git(["diff", "--quiet", candidate.praxisCommit, "HEAD", "--", ...protectedCandidatePaths], { allowFailure: true });
  if (protectedDiff.status !== 0) throw new Error("candidate protected files changed after freeze");
  return Object.freeze(candidate);
}

if (import.meta.main) {
  const candidate = await freezeCandidate();
  process.stdout.write(`praxis_candidate_commit=${candidate.praxisCommit}\n`);
}
