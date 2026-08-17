import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as workspaceAdapter from "../runtime/workspace-adapter.mjs";
import * as openAiAdapter from "../runtime/openai-adapter.mjs";
import { createPraxisBindings } from "../runtime/bindings.mjs";

const capabilitiesRoot = path.resolve(process.argv[2] ?? ".praxis/reference-stack/extracted/worldCapabilities/world-capabilities-v2.3.2-deterministic");
const bindingManifest = JSON.parse(fs.readFileSync("zig-out/repository-steward/repository-steward.binding-manifest.json", "utf8"));
const bindings = await createPraxisBindings({ worldCapabilitiesRoot: capabilitiesRoot, bindingManifest, workspaceAdapter, modelAdapter: openAiAdapter });
const bindingIds = new Set(bindings.map((binding) => binding.bindingId));
for (const filename of ["workspace.json", "openai.json", "fixture-model.json"]) {
  const manifest = JSON.parse(fs.readFileSync(path.join("runtime/manifests", filename), "utf8"));
  assert.equal(manifest.format, "praxis-capability-pack/v1");
  assert.equal(manifest.bindingManifest, "repository-steward.binding-manifest.json");
  assert.ok(!Object.hasOwn(manifest, "applicationId"));
  assert.ok(JSON.stringify(manifest).includes("praxis-"));
  for (const bindingId of manifest.bindings) {
    if (bindingId === "praxis-fixture-model.v1") continue;
    assert.ok(bindingIds.has(bindingId), `${filename} references unknown binding ${bindingId}`);
  }
}
const recognizedSchemas = new Set(bindingManifest.interfaces.flatMap((entry) => [entry.payloadSchemaId, entry.resultSchemaId]));
for (const binding of bindings) {
  assert.ok(recognizedSchemas.has(Buffer.from(binding.payloadSchemaId).toString("hex")));
  assert.ok(recognizedSchemas.has(Buffer.from(binding.resultSchemaId).toString("hex")));
}
process.stdout.write(`praxis_capability_bindings=${bindings.length}\npraxis_packs=true\n`);
