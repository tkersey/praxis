import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { decodeDecisionTurn } from "../../../../../runtime/codecs.mjs";

const root = new URL("../../../../../", import.meta.url).pathname;
function run(executable, args) {
  const child = spawnSync(executable, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed\n${child.stdout ?? ""}${child.stderr ?? ""}`);
}

run("zig", ["build", "check", "--summary", "all"]);
run(process.execPath, ["tools/check-codecs.mjs"]);
const result = JSON.parse(await readFile(new URL("../result.json", import.meta.url), "utf8"));
const contract = JSON.parse(await readFile(new URL("../../../../../zig-out/repository-steward/repository-steward.decision-contract.json", import.meta.url), "utf8"));
const binding = JSON.parse(await readFile(new URL("../../../../../zig-out/repository-steward/repository-steward.binding-manifest.json", import.meta.url), "utf8"));
const vectors = JSON.parse(await readFile(new URL("../../../../../zig-out/repository-steward/repository-steward.codec-vectors.json", import.meta.url), "utf8"));
const decision = (name) => {
  const vector = vectors.vectors.find((candidate) => candidate.name === name);
  assert.ok(vector, `missing ${name}`);
  return decodeDecisionTurn(Buffer.from(vector.hex, "hex"));
};

assert.equal(result.owner, "parent_application_obstruction");
assert.equal(result.failed_release, "v1.0.5");
assert.equal(result.failed_instruction_requires_fresh_read, true);
assert.equal(result.failed_decision_view_exposes_read_epoch, false);
assert.equal(result.successor_read_evidence_typed, true);
assert.equal(result.successor_changed_path_revision_requires_current_read_evidence, true);
assert.equal(result.successor_new_check_stales_prior_read_evidence, true);
assert.equal(result.successor_application_id, binding.applicationId);
assert.equal(result.successor_decision_contract_digest, contract.semanticDigest);
assert.match(contract.instructions, /latest read path and its observed test count/);
const stale = decision("decision_turn_same_path").context.evidence;
assert.equal(stale.latest_read.path, "src/file-0.zig");
assert.notEqual(stale.latest_read.observed_test_count, stale.test_count);
const fresh = decision("decision_turn_multi_path").context.evidence;
assert.equal(fresh.latest_read.path, "src/file-0.zig");
assert.equal(fresh.latest_read.observed_test_count, fresh.test_count);
assert.equal(result.selected_model_changed, false);
assert.equal(result.machine_abi, 2);
assert.equal(result.application_abi, 1);
assert.equal(result.effect_protocol, 1);
process.stdout.write(`${JSON.stringify({ format: "praxis-obstruction-reproducer/v1", corrected: true })}\n`);
