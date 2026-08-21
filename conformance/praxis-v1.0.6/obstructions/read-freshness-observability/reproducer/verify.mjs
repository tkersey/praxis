import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const result = JSON.parse(await readFile(new URL("../result.json", import.meta.url), "utf8"));
assert.equal(result.owner, "parent_application_obstruction");
assert.equal(result.failed_release, "v1.0.5");
assert.equal(result.failed_instruction_requires_fresh_read, true);
assert.equal(result.failed_decision_view_exposes_read_epoch, false);
assert.equal(result.failed_identical_decision_context_count, 19);
assert.match(result.failed_identical_decision_context_sha256, /^[0-9a-f]{64}$/);
assert.equal(result.successor_read_evidence_typed, true);
assert.equal(result.successor_changed_path_revision_requires_current_read_evidence, true);
assert.equal(result.successor_new_check_stales_prior_read_evidence, true);
assert.equal(result.selected_model_changed, false);
assert.equal(result.machine_abi, 2);
assert.equal(result.application_abi, 1);
assert.equal(result.effect_protocol, 1);
process.stdout.write(`${JSON.stringify({ format: "praxis-obstruction-reproducer/v1", corrected: true })}\n`);
