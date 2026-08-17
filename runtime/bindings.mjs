import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  decodeDecisionTurn,
  decodeEffectPayload,
  encodeAction,
  encodeEffectResult,
} from "./codecs.mjs";

const hex = (value, label) => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label} must be a SHA-256 hex value`);
  return Buffer.from(value, "hex");
};

function configurationIdentity(parts) {
  const hasher = createHash("sha256"); hasher.update("praxis.capability-configuration.v1");
  for (const part of parts) { const bytes = Buffer.from(String(part), "utf8"); const size = Buffer.alloc(4); size.writeUInt32LE(bytes.length); hasher.update(size); hasher.update(bytes); }
  return hasher.digest("hex");
}

function claims(value) {
  if (!value) return new Uint8Array(0);
  return Buffer.from(JSON.stringify(value), "utf8");
}

const workspaceTargets = Object.freeze({
  list: ["praxis-workspace.list.v1", "desc.praxis-repository-list.v1", "actuator.praxis-repository-list.v1", "idempotent"],
  read: ["praxis-workspace.read.v1", "desc.praxis-repository-read.v1", "actuator.praxis-repository-read.v1", "idempotent"],
  search: ["praxis-workspace.search.v1", "desc.praxis-repository-search.v1", "actuator.praxis-repository-search.v1", "idempotent"],
  test: ["praxis-workspace.test.v1", "desc.praxis-repository-test.v1", "actuator.praxis-repository-test.v1", "retryable"],
  replace: ["praxis-workspace.replace.v1", "desc.praxis-repository-replace-approved.v1", "actuator.praxis-repository-replace-approved.v1", "idempotent"],
});

export async function createPraxisBindings({
  worldCapabilitiesRoot,
  bindingManifest,
  workspaceAdapter,
  modelAdapter,
  modelBindingId,
}) {
  if (!worldCapabilitiesRoot) throw new TypeError("verified worldCapabilitiesRoot is required");
  if (bindingManifest?.format !== "praxis-binding-manifest/v1") throw new TypeError("Praxis binding manifest is required");
  const protocolUrl = pathToFileURL(join(worldCapabilitiesRoot, "src/v1/protocol.mjs")).href;
  const { effectInterfaceId } = await import(protocolUrl);
  const applicationId = hex(bindingManifest.applicationId, "applicationId");
  const byOperation = new Map(bindingManifest.interfaces.map((entry) => [entry.operation, entry]));
  const bindings = [];

  const decision = byOperation.get("decide");
  if (!decision || !modelAdapter) throw new TypeError("decision binding is missing");
  const chosenModelBinding = modelBindingId ?? "praxis-openai.v1";
  bindings.push({
    bindingId: chosenModelBinding,
    driverId: chosenModelBinding,
    packageName: "@tkersey/praxis",
    interfaceId: effectInterfaceId(decision.interfaceLabel),
    payloadSchemaId: hex(decision.payloadSchemaId, "decision payload schema"),
    resultSchemaId: hex(decision.resultSchemaId, "decision result schema"),
    applicationIds: [applicationId],
    authorityRequirements: BigInt(decision.authorityRequirements),
    target: { descriptorFingerprint: "desc.praxis-openai.v1", actuatorRef: "actuator.praxis-openai.v1", actuationClass: "model" },
    adapter: modelAdapter,
    decodePayload: decodeDecisionTurn,
    encodeOutcome: (outcome) => encodeAction(outcome.payload),
    hostClaims: (outcome) => claims(outcome.claims),
    configurationIdentity: (context) => configurationIdentity([
      bindingManifest.applicationId, chosenModelBinding, bindingManifest.decisionContractDigest,
      context.model, "decide",
    ]),
    recoveryClass: "retryable",
  });

  for (const operation of ["list", "read", "search", "test", "replace"]) {
    const site = byOperation.get(operation); const target = workspaceTargets[operation];
    if (!site || !target) throw new TypeError(`workspace binding ${operation} is missing`);
    bindings.push({
      bindingId: target[0], driverId: target[0], packageName: "@tkersey/praxis",
      interfaceId: effectInterfaceId(site.interfaceLabel), payloadSchemaId: hex(site.payloadSchemaId, `${operation} payload schema`),
      resultSchemaId: hex(site.resultSchemaId, `${operation} result schema`), applicationIds: [applicationId],
      authorityRequirements: BigInt(site.authorityRequirements),
      target: { descriptorFingerprint: target[1], actuatorRef: target[2], actuationClass: "repository" },
      adapter: workspaceAdapter,
      decodePayload: (bytes) => Object.freeze({ operation, ...decodeEffectPayload(operation, bytes) }),
      encodeOutcome: (outcome) => encodeEffectResult(operation, outcome.payload),
      hostClaims: (outcome) => claims(outcome.claims),
      configurationIdentity: (context) => configurationIdentity([
        bindingManifest.applicationId, target[0], context.workspaceRootReal, context.baseRevision,
        context.policyDigest, operation,
        operation === "test" ? context.zigExecutable : "",
        operation === "test" ? context.zigVersion : "",
      ]),
      recoveryClass: target[3],
    });
  }

  for (const entry of bindingManifest.interfaces) {
    const derived = Buffer.from(effectInterfaceId(entry.interfaceLabel)).toString("hex");
    if (derived !== entry.interfaceId) throw new Error(`interface derivation mismatch for ${entry.operation}`);
  }
  return Object.freeze(bindings);
}

export async function createPraxisRouter(options) {
  const indexUrl = pathToFileURL(join(options.worldCapabilitiesRoot, "src/v1/index.mjs")).href;
  const { CapabilityRouterV1 } = await import(indexUrl);
  return new CapabilityRouterV1({ bindings: await createPraxisBindings(options) });
}

export const _bindingInternals = { configurationIdentity };
