import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { admitWorkspacePolicy } from "../runtime/workspace-adapter.mjs";
import { verifyCandidate } from "./candidate.mjs";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function command(executable, args, { cwd, allowFailure = false, binary = false, env = process.env } = {}) {
  const result = spawnSync(executable, args, { cwd, encoding: binary ? null : "utf8", maxBuffer: 64 * 1024 * 1024, env });
  if (result.error || (!allowFailure && result.status !== 0)) throw new Error(`${executable} ${args.join(" ")} failed\n${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result;
}

async function readJson(file) { return JSON.parse(await readFile(file, "utf8")); }

function sorted(values) { return [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))); }

function exactPaths(actual, expected, label) {
  assert.deepEqual(sorted(actual), sorted(expected), `${label} path mismatch`);
}

async function approvalCoverage(receipt, approvalRoot) {
  const bindings = receipt.approval_bindings ?? [];
  assert.equal(bindings.length, receipt.mutation_count, "each mutation requires one approval binding");
  const requestIds = new Set();
  for (const binding of bindings) {
    assert.match(binding.request_id, /^[0-9a-f]{64}$/);
    assert.ok(!requestIds.has(binding.request_id), "approval request IDs must be unique");
    requestIds.add(binding.request_id);
    const approval = await readJson(path.join(approvalRoot, `${binding.request_id}.json`));
    assert.equal(approval.format, "praxis-approval/v1");
    assert.equal(approval.approved, true);
    assert.equal(approval.mode, "receiver-policy-verified");
    assert.equal(approval.requestId, binding.request_id);
    assert.equal(approval.proposalDigest, binding.proposal_digest);
    assert.equal(approval.path, binding.path);
    assert.equal(approval.expectedSha256, binding.expected_sha256);
    assert.equal(approval.replacementSha256, binding.replacement_sha256);
    assert.equal(approval.policyDigest, receipt.policy_sha256);
  }
  return true;
}

export async function verifyFinalWorktree(options) {
  const worktree = await import("node:fs/promises").then(({ realpath }) => realpath(path.resolve(options.worktree)));
  const [receipt, rawPolicy, candidate] = await Promise.all([
    typeof options.receipt === "string" ? readJson(path.resolve(options.receipt)) : options.receipt,
    typeof options.policy === "string" ? readJson(path.resolve(options.policy)) : options.policy,
    verifyCandidate(options.candidate),
  ]);
  if (receipt?.praxis_format !== 1 || receipt.mode !== "live" || receipt.terminal_status !== "completed") throw new Error("successful live receipt required");
  assert.equal(receipt.candidate_commit, candidate.praxisCommit);
  assert.equal(receipt.application_id, candidate.applicationId);
  assert.equal(receipt.application_wasm_sha256, candidate.applicationWasmSha256);
  const admitted = admitWorkspacePolicy(rawPolicy, { repository: receipt.repository, baseRevision: receipt.base_revision });
  assert.equal(admitted.digest, receipt.policy_sha256);
  assert.equal(command("git", ["rev-parse", "HEAD"], { cwd: worktree }).stdout.trim(), receipt.base_revision);
  const statusBytes = command("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: worktree, binary: true }).stdout;
  const statusRecords = Buffer.from(statusBytes).toString("utf8").split("\0").filter(Boolean);
  for (const record of statusRecords) {
    const code = record.slice(0, 2); const file = record.slice(3);
    if (code !== " M" || file.length === 0) throw new Error(`non-ordinary worktree change: ${code} ${file}`);
  }
  const nameStatus = command("git", ["diff", "--name-status", "--no-renames", receipt.base_revision, "--"], { cwd: worktree }).stdout.trim().split("\n").filter(Boolean);
  const changedPaths = nameStatus.map((line) => {
    const [status, file] = line.split("\t");
    if (status !== "M" || !file) throw new Error(`non-modification diff: ${line}`);
    return file;
  });
  exactPaths(statusRecords.map((record) => record.slice(3)), changedPaths, "status/diff");
  exactPaths(changedPaths, receipt.changed_paths, "receipt/diff");
  if (changedPaths.length < 1 || changedPaths.length > 4 || receipt.unique_changed_file_count !== changedPaths.length) throw new Error("changed file count is outside Praxis bounds");
  const writable = new Set(admitted.policy.writablePaths);
  if (changedPaths.some((file) => !writable.has(file))) throw new Error("diff contains a non-writable policy path");
  if (command("git", ["diff", "--summary", receipt.base_revision, "--"], { cwd: worktree }).stdout !== "") throw new Error("mode or structural change detected");
  command("git", ["diff", "--check", receipt.base_revision, "--"], { cwd: worktree });
  const perFileDigests = [];
  for (const file of changedPaths) {
    const full = path.join(worktree, file); const info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024) throw new Error(`inadmissible changed file: ${file}`);
    const after = await readFile(full); utf8.decode(after);
    const before = command("git", ["show", `${receipt.base_revision}:${file}`], { cwd: worktree, binary: true }).stdout;
    utf8.decode(before);
    const numstat = command("git", ["diff", "--numstat", receipt.base_revision, "--", file], { cwd: worktree }).stdout.trim();
    if (numstat.startsWith("-\t-\t")) throw new Error(`binary change detected: ${file}`);
    const index = command("git", ["ls-files", "-s", "--", file], { cwd: worktree }).stdout;
    if (index.startsWith("160000 ")) throw new Error(`submodule change detected: ${file}`);
    const afterSha256 = sha256(after);
    if (receipt.terminal_file_digests?.[file] !== afterSha256) throw new Error(`file changed after terminal Frame: ${file}`);
    perFileDigests.push({ path: file, before_sha256: sha256(before), after_sha256: afterSha256 });
  }
  const diffBytes = command("git", ["diff", "--binary", "--no-ext-diff", "--full-index", receipt.base_revision, "--", ...sorted(changedPaths)], { cwd: worktree, binary: true }).stdout;
  const finalDiffSha256 = sha256(diffBytes);
  if (receipt.final_diff_sha256 && receipt.final_diff_sha256 !== finalDiffSha256) throw new Error("final diff digest mismatch");
  if (options.approvalRoot) await approvalCoverage(receipt, path.resolve(options.approvalRoot));
  const zigExecutable = path.resolve(options.zigExecutable);
  assert.equal(command(zigExecutable, ["version"], { cwd: worktree }).stdout.trim(), "0.16.0");
  const verificationHome = path.resolve(options.temporaryHome ?? path.join(path.dirname(worktree), "verify-home"));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(verificationHome, { recursive: true, mode: 0o700 }));
  command(zigExecutable, ["build", "check", "--summary", "all"], {
    cwd: worktree,
    env: { HOME: verificationHome, TMPDIR: verificationHome, NO_COLOR: "1", ZIG_LOCAL_CACHE_DIR: path.join(verificationHome, "local"), ZIG_GLOBAL_CACHE_DIR: path.join(verificationHome, "global"), PATH: `${path.dirname(zigExecutable)}:/usr/bin:/bin` },
  });
  return Object.freeze({
    candidate_verified: true,
    source_base_revision_verified: true,
    changed_paths: sorted(changedPaths),
    per_file_digests: perFileDigests,
    final_diff_sha256: finalDiffSha256,
    final_check_passed: true,
    approval_coverage: options.approvalRoot ? true : null,
    no_post_terminal_change: true,
    independent_verifier_passed: true,
  });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1]; if (!value) throw new Error(`missing ${flag} value`);
    if (flag === "--receipt") result.receipt = value;
    else if (flag === "--worktree") result.worktree = value;
    else if (flag === "--candidate") result.candidate = value;
    else if (flag === "--policy") result.policy = value;
    else if (flag === "--zig") result.zigExecutable = value;
    else if (flag === "--approval-root") result.approvalRoot = value;
    else if (flag === "--temporary-home") result.temporaryHome = value;
    else throw new Error(`unknown argument ${flag}`);
  }
  for (const required of ["receipt", "worktree", "candidate", "policy", "zigExecutable"]) if (!result[required]) throw new Error(`${required} is required`);
  return result;
}

if (import.meta.main) {
  const evidence = await verifyFinalWorktree(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
