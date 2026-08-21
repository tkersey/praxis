import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { decodeDecisionTurn } from "../../../../../runtime/codecs.mjs";
import { _workspaceInternals } from "../../../../../runtime/workspace-adapter.mjs";

const root = new URL("../../../../../", import.meta.url).pathname;
function run(executable, args) {
  const child = spawnSync(executable, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed\n${child.stdout ?? ""}${child.stderr ?? ""}`);
}

run("zig", ["build", "check", "--summary", "all"]);
run(process.execPath, ["tools/check-codecs.mjs"]);
const result = JSON.parse(await readFile(new URL("../result.json", import.meta.url), "utf8"));
const resultKeys = [
  "format", "owner", "failed_release",
  "failed_definition_blob_oid", "failed_epistemics_blob_oid", "failed_codec_blob_oid",
  "failed_candidate_blob_oid", "failed_decision_contract_digest",
  "failed_instruction_requires_fresh_read", "failed_decision_view_exposes_read_epoch",
  "successor_read_evidence_typed", "successor_read_evidence_contains_path",
  "successor_read_evidence_contains_observed_test_count",
  "successor_changed_path_revision_requires_current_read_evidence",
  "successor_new_check_stales_prior_read_evidence",
  "successor_conflict_invalidates_read_evidence",
  "successor_conflict_invalidates_test_evidence",
  "successor_model_instructions_name_read_evidence",
  "successor_implementation_semantic_identity", "successor_application_id",
  "successor_decision_contract_digest", "maximum_replacements", "maximum_changed_files",
  "machine_abi", "machine_state", "application_abi", "frame", "effect_protocol",
].sort();
assert.deepEqual(Object.keys(result).sort(), resultKeys);
const contract = JSON.parse(await readFile(new URL("../../../../../zig-out/repository-steward/repository-steward.decision-contract.json", import.meta.url), "utf8"));
const binding = JSON.parse(await readFile(new URL("../../../../../zig-out/repository-steward/repository-steward.binding-manifest.json", import.meta.url), "utf8"));
const vectors = JSON.parse(await readFile(new URL("../../../../../zig-out/repository-steward/repository-steward.codec-vectors.json", import.meta.url), "utf8"));
const manifest = await readFile(new URL("../../../../../zig-out/repository-steward/repository-steward.manifest.txt", import.meta.url), "utf8");
const referenceLock = JSON.parse(await readFile(new URL("../../../../../conformance/praxis-v1/reference-stack.lock.json", import.meta.url), "utf8"));
const successorDefinition = await readFile(new URL("../../../../../src/definition.zig", import.meta.url), "utf8");
const successorTests = await readFile(new URL("../../../../../src/epistemics_test.zig", import.meta.url), "utf8");
const failedRoot = new URL("./failed-v1.0.5/", import.meta.url);
const failedDefinitionBytes = await readFile(new URL("definition.zig", failedRoot));
const failedEpistemicsBytes = await readFile(new URL("epistemics.zig", failedRoot));
const failedCodecBytes = await readFile(new URL("codecs.mjs", failedRoot));
const failedCandidateBytes = await readFile(new URL("candidate.json", failedRoot));
const gitBlobOid = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const decision = (name) => {
  const vector = vectors.vectors.find((candidate) => candidate.name === name);
  assert.ok(vector, `missing ${name}`);
  return decodeDecisionTurn(Buffer.from(vector.hex, "hex"));
};

assert.equal(result.owner, "parent_application_obstruction");
assert.equal(result.format, "praxis-obstruction-correction/v1");
assert.equal(result.failed_release, "v1.0.5");
assert.equal(gitBlobOid(failedDefinitionBytes), result.failed_definition_blob_oid);
assert.equal(gitBlobOid(failedEpistemicsBytes), result.failed_epistemics_blob_oid);
assert.equal(gitBlobOid(failedCodecBytes), result.failed_codec_blob_oid);
assert.equal(gitBlobOid(failedCandidateBytes), result.failed_candidate_blob_oid);
const failedDefinition = failedDefinitionBytes.toString("utf8");
const failedEpistemics = failedEpistemicsBytes.toString("utf8");
const failedCodec = failedCodecBytes.toString("utf8");
const failedCandidate = JSON.parse(failedCandidateBytes);
assert.equal(failedCandidate.decisionContractDigest, result.failed_decision_contract_digest);
assert.match(failedDefinition, /fresh check and a fresh read/);
assert.doesNotMatch(failedDefinition.match(/pub const Memory = struct \{[\s\S]*?\n\};/)?.[0] ?? "", /latest_read|conflict_count|conflicted_path/);
assert.doesNotMatch(failedDefinition.match(/pub const DecisionEvidence = struct \{[\s\S]*?\n\};/)?.[0] ?? "", /latest_read|conflict_count|conflicted_path/);
assert.match(failedEpistemics, /lowering\.v1/);
assert.doesNotMatch(failedCodec, /ReadEvidence|conflict_count|conflicted_path/);
assert.equal(result.failed_instruction_requires_fresh_read, true);
assert.equal(result.failed_decision_view_exposes_read_epoch, false);
assert.equal(result.successor_read_evidence_typed, true);
assert.equal(result.successor_read_evidence_contains_path, true);
assert.equal(result.successor_read_evidence_contains_observed_test_count, true);
assert.equal(result.successor_changed_path_revision_requires_current_read_evidence, true);
assert.equal(result.successor_new_check_stales_prior_read_evidence, true);
assert.equal(result.successor_conflict_invalidates_read_evidence, true);
assert.equal(result.successor_conflict_invalidates_test_evidence, true);
assert.equal(result.successor_model_instructions_name_read_evidence, true);
assert.equal(result.successor_application_id, binding.applicationId);
assert.equal(result.successor_decision_contract_digest, contract.semanticDigest);
assert.match(contract.instructions, /latest read path and its observed test and conflict counts/);
assert.match(contract.instructions, /After any replacement conflict.*run a fresh full check and then reread that exact path/);
const stale = decision("decision_turn_same_path").context.evidence;
assert.equal(stale.latest_read.path, "src/file-0.zig");
assert.notEqual(stale.latest_read.observed_test_count, stale.test_count);
const fresh = decision("decision_turn_multi_path").context.evidence;
assert.equal(fresh.latest_read.path, "src/file-0.zig");
assert.equal(fresh.latest_read.observed_test_count, fresh.test_count);
assert.match(successorDefinition, new RegExp(result.successor_implementation_semantic_identity.replaceAll(".", "\\.")));
assert.match(successorTests, /conflict invalidates read evidence until the exact path is reread/);
assert.match(successorTests, /multiple conflicts keep every pre-conflict read stale/);
assert.equal(result.maximum_replacements, _workspaceInternals.compiledLimits.maximumMutationOperations);
assert.equal(result.maximum_changed_files, _workspaceInternals.compiledLimits.maximumChangedFiles);
assert.match(manifest, /application_version=1\.0\.6/);
assert.match(manifest, new RegExp(`application_id=${result.successor_application_id}`));
assert.equal(result.machine_abi, referenceLock.tuple.machineAbi);
assert.equal(result.machine_state, referenceLock.tuple.machineStateFormat);
assert.equal(result.application_abi, referenceLock.tuple.applicationAbi);
assert.equal(result.frame, referenceLock.tuple.frame);
assert.equal(result.effect_protocol, referenceLock.tuple.effectProtocol);
assert.equal(result.machine_abi, 2);
assert.equal(result.application_abi, 1);
assert.equal(result.effect_protocol, 1);
process.stdout.write(`${JSON.stringify({ format: "praxis-obstruction-reproducer/v1", corrected: true })}\n`);
