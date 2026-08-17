import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import * as workspaceAdapter from "../runtime/workspace-adapter.mjs";
import * as modelAdapter from "../runtime/openai-adapter.mjs";
import { createPraxisBindings, _bindingInternals } from "../runtime/bindings.mjs";

const worldCapabilitiesRoot = ".praxis/reference-stack/extracted/worldCapabilities/world-capabilities-v2.3.2-deterministic";
const bindingManifest = JSON.parse(fs.readFileSync("zig-out/repository-steward/repository-steward.binding-manifest.json", "utf8"));

describe("Praxis capability bindings", () => {
  test("derive all identities from the emitted binding manifest", async () => {
    const bindings = await createPraxisBindings({ worldCapabilitiesRoot, bindingManifest, workspaceAdapter, modelAdapter });
    expect(bindings.map((binding) => binding.bindingId)).toEqual([
      "praxis-openai.v1", "praxis-workspace.list.v1", "praxis-workspace.read.v1",
      "praxis-workspace.search.v1", "praxis-workspace.test.v1", "praxis-workspace.replace.v1",
    ]);
    expect(bindings.map((binding) => Buffer.from(binding.applicationIds[0]).toString("hex"))).toEqual(Array(6).fill(bindingManifest.applicationId));
    expect(bindings.map((binding) => Buffer.from(binding.payloadSchemaId).toString("hex"))).toEqual(bindingManifest.interfaces.map((entry) => entry.payloadSchemaId));
    expect(bindings.map((binding) => binding.authorityRequirements.toString())).toEqual(bindingManifest.interfaces.map((entry) => entry.authorityRequirements));
  });

  test("configuration identity excludes credentials", () => {
    const first = _bindingInternals.configurationIdentity([bindingManifest.applicationId, "driver", "/root", "operation"]);
    const second = _bindingInternals.configurationIdentity([bindingManifest.applicationId, "driver", "/root", "operation"]);
    expect(first).toBe(second); expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});
