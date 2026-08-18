import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const artifacts = resolve(process.argv[2] ?? "zig-out/repository-steward");
const worldHostRoot = resolve(process.argv[3] ?? ".praxis/reference-stack/extracted/worldHost/world-host-v1.0.2-runtime");
const capabilitiesRoot = resolve(process.argv[4] ?? ".praxis/reference-stack/extracted/worldCapabilities/world-capabilities-v2.3.2-deterministic");
const host = await import(pathToFileURL(join(worldHostRoot, "src/v1/index.mjs")).href);
const capability = await import(pathToFileURL(join(capabilitiesRoot, "src/v1/index.mjs")).href);

const binding = JSON.parse(fs.readFileSync(join(artifacts, "repository-steward.binding-manifest.json"), "utf8"));
const admissionLimits = Object.freeze({ ...host.DEFAULT_ADMISSION_LIMITS, maximumFuelPerStep: 1_000_000n });
const manifest = host.decodeApplicationManifest(fs.readFileSync(join(artifacts, "repository-steward.manifest.bin")), admissionLimits);
const contract = JSON.parse(fs.readFileSync(join(artifacts, "repository-steward.decision-contract.json"), "utf8"));
const contractBinary = fs.readFileSync(join(artifacts, "repository-steward.decision-contract.bin"));
const applicationId = Buffer.from(manifest.applicationId).toString("hex");
assert.equal(binding.applicationId, applicationId);
assert.equal(binding.applicationName, manifest.applicationName);
assert.equal(binding.applicationVersion, manifest.applicationVersion);
assert.equal(binding.decisionContractDigest, contract.semanticDigest);
const digestBytes = Buffer.from(contract.semanticDigest, "hex");
assert.ok(contractBinary.indexOf(digestBytes) >= 0, "binary DecisionContract does not carry its semantic digest");
assert.equal(binding.interfaces.length, manifest.residualEffects.length);

const residualByInterface = new Map(manifest.residualEffects.map((effect) => [Buffer.from(effect.interfaceId).toString("hex"), effect]));
for (const entry of binding.interfaces) {
  assert.equal(Buffer.from(capability.effectInterfaceId(entry.interfaceLabel)).toString("hex"), entry.interfaceId);
  const effect = residualByInterface.get(entry.interfaceId); assert.ok(effect, `missing World residual effect ${entry.operation}`);
  assert.equal(Buffer.from(effect.payloadSchemaId).toString("hex"), entry.payloadSchemaId);
  assert.equal(Buffer.from(effect.resultSchemaId).toString("hex"), entry.resultSchemaId);
  assert.equal(effect.authorityRequirements.toString(), entry.authorityRequirements);
  assert.ok(Number.isInteger(entry.maximumResultBytes) && entry.maximumResultBytes > 0);
}

const wasm = fs.readFileSync(join(artifacts, "repository-steward.world.wasm"));
const inspection = host.assertApplicationWasmSurface(host.inspectApplicationWasm(wasm));
assert.equal(inspection.importCount, 0);
assert.equal(inspection.memory.minimumPages, 4096);
assert.equal(inspection.memory.maximumPages, 4096);
process.stdout.write(`praxis_application_id=${applicationId}\npraxis_artifacts=true\n`);
