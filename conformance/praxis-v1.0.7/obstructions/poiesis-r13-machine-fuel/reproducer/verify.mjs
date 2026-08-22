import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const result = JSON.parse(await readFile(new URL("../result.json", import.meta.url), "utf8"));
const definition = await readFile(new URL("../../../../../src/definition.zig", import.meta.url), "utf8");
const application = await readFile(new URL("../../../../../src/application.zig", import.meta.url), "utf8");
const packageManifest = await readFile(new URL("../../../../../build.zig.zon", import.meta.url), "utf8");

assert.deepEqual(Object.keys(result).sort(), [
  "application_abi", "effect_protocol", "failed_receipt_sha256", "failed_release",
  "failed_scaffold_commit", "failed_terminal_failure", "failed_terminal_frame_id",
  "failed_total_machine_fuel", "failure_applied_replacements", "failure_external_effect_count",
  "failure_generated_epistemics_bytes", "failure_model_authored_abort", "format", "frame",
  "machine_abi", "machine_state", "maximum_changed_files", "maximum_decisions",
  "maximum_effect_actions", "maximum_mutation_operations", "owner", "successor_total_machine_fuel",
].sort());
assert.equal(result.format, "praxis-obstruction-correction/v1");
assert.equal(result.owner, "parent_application_obstruction");
assert.equal(result.failed_release, "v1.0.6");
assert.match(result.failed_receipt_sha256, /^[0-9a-f]{64}$/);
assert.match(result.failed_terminal_frame_id, /^[0-9a-f]{64}$/);
assert.equal(result.failed_terminal_failure, "Boundary Machine execution budget exceeded");
assert.equal(result.failed_total_machine_fuel, 16_000_000);
assert.equal(result.successor_total_machine_fuel, 32_000_000);
assert.equal(result.failure_external_effect_count, 58);
assert.equal(result.failure_applied_replacements, 6);
assert.equal(result.failure_generated_epistemics_bytes, 14_559);
assert.equal(result.failure_model_authored_abort, false);
assert.equal(result.maximum_decisions, 48);
assert.equal(result.maximum_effect_actions, 47);
assert.equal(result.maximum_mutation_operations, 10);
assert.equal(result.maximum_changed_files, 4);
assert.equal(result.machine_abi, 2);
assert.equal(result.machine_state, "ABL_RNF2");
assert.equal(result.application_abi, 1);
assert.equal(result.frame, 1);
assert.equal(result.effect_protocol, 1);
assert.match(definition, /\.version = "1\.0\.7"/);
assert.match(definition, /\.maximum_machine_fuel = 32_000_000/);
assert.match(definition, /\.maximum_decisions = 48/);
assert.match(definition, /\.maximum_effect_actions = 47/);
assert.match(application, /\.version = "1\.0\.7"/);
assert.match(packageManifest, /\.version = "1\.0\.7"/);

process.stdout.write(`${JSON.stringify({ format: "praxis-obstruction-reproducer/v1", corrected: true })}\n`);
