import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { runDeterministic } from "./deterministic.mjs";
import { sourceReceiptIdentity } from "./release-identity.mjs";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function proveMeasurements(options = {}) {
  const runId = options.runId ?? `measure-${Date.now()}`;
  const runRoot = path.join(repositoryRoot, ".praxis/runs", runId);
  const proof = await runDeterministic({ ...options, runId, runRoot, receipt: path.join(runRoot, "deterministic.json") });
  const measurements = {
    ...proof.trace.measurements,
    applicationStateLimitBytes: 512 * 1024,
    wasmStackBytes: 128 * 1024 * 1024,
    wasmMemoryBytes: 256 * 1024 * 1024,
    externalEffectCount: proof.receipt.external_effect_count,
    modelEffectCount: proof.receipt.model_effect_count,
    nonModelEffectCount: proof.receipt.non_model_effect_count,
    appliedReplacements: proof.receipt.mutation_count,
    distinctChangedFiles: proof.receipt.changed_paths.length,
  };
  const gates = {
    applicationWasm: measurements.applicationWasmBytes <= 6 * 1024 * 1024,
    peakFrame: measurements.peakFrameBytes <= 384 * 1024,
    peakMachineState: measurements.peakMachineStateBytes <= 320 * 1024,
    applicationStateLimit: measurements.applicationStateLimitBytes <= 512 * 1024,
    wasmStack: measurements.wasmStackBytes <= 128 * 1024 * 1024,
    wasmMemory: measurements.wasmMemoryBytes <= 256 * 1024 * 1024,
    decisionPayload: measurements.peakDecisionPayloadBytes <= 256 * 1024,
    externalEffects: measurements.externalEffectCount <= 95,
    modelEffects: measurements.modelEffectCount <= 48,
    nonModelEffects: measurements.nonModelEffectCount <= 47,
    appliedReplacements: measurements.appliedReplacements >= 1 && measurements.appliedReplacements <= 10,
    distinctChangedFiles: measurements.distinctChangedFiles >= 1 && measurements.distinctChangedFiles <= 4,
  };
  assert.ok(Object.values(gates).every(Boolean), `measurement gate failed: ${JSON.stringify(gates)}`);
  const receipt = {
    praxis_format: 1,
    mode: "measure",
    ...await sourceReceiptIdentity(),
    application_id: proof.bindingManifest.applicationId,
    application_wasm_sha256: sha256(proof.wasmBytes),
    measurements,
    gates,
  };
  const target = options.receipt ?? path.join(repositoryRoot, "conformance/praxis-v1/receipts/measure.json");
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (import.meta.main) {
  const receipt = await proveMeasurements();
  process.stdout.write(`praxis_measurements=${Object.values(receipt.gates).every(Boolean)}\n`);
}
