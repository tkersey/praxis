import { createHash } from "node:crypto";
import { encodeAction } from "./codecs.mjs";

export const responsesEndpoint = "https://api.openai.com/v1/responses";
const defaultFetch = fetch;
const maximumResponseBytes = 4 * 1024 * 1024;

function outcome(request, status, payload, claims) { return { requestId: request?.requestId ?? "unknown", status, payload, ...(claims ? { claims } : {}) }; }
function reject(request, reason) { return outcome(request, "rejected", { reason }); }
function failed(request, reason) { return outcome(request, "failed", { reason }); }
function recordedFailure(context, request, reason) {
  context.lastOpenAiFailure = reason;
  return failed(request, reason);
}

function normalizeStrictNode(value) {
  if (Array.isArray(value)) return value.map(normalizeStrictNode);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema" || key === "title") continue;
    result[key] = normalizeStrictNode(child);
  }
  if (Object.hasOwn(result, "const") && !result.type) {
    if (typeof result.const !== "string") throw new TypeError("action schema const must be a string");
    result.type = "string";
  }
  if (result.type === "object") {
    result.properties ??= {};
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  return result;
}

function strictSchema(actionSchema) {
  if (!Array.isArray(actionSchema?.oneOf) || actionSchema.oneOf.length === 0) throw new TypeError("action schema variants are required");
  return {
    type: "object",
    properties: {
      value: { anyOf: actionSchema.oneOf.map(normalizeStrictNode) },
    },
    required: ["value"],
    additionalProperties: false,
  };
}

function actionFromProviderText(text) {
  const envelope = JSON.parse(text);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
      Object.keys(envelope).length !== 1 || !Object.hasOwn(envelope, "value")) {
    throw new Error("openai_action_envelope_not_admitted");
  }
  encodeAction(envelope.value);
  return envelope.value;
}

function admittedContract(context) {
  const contract = context.decisionContract;
  if (contract?.format !== "agent-decision-contract/v2" || contract.semanticDigest !== context.decisionContractDigest) throw new TypeError("decision_contract_mismatch");
  return contract;
}

function admissionReason(context, request) {
  if (!request || typeof request.requestId !== "string") return "invalid_request";
  if (typeof context?.secrets?.OPENAI_API_KEY !== "string" || context.secrets.OPENAI_API_KEY.length === 0) return "openai_api_key_required";
  if (typeof context.model !== "string" || context.model.length === 0) return "openai_model_required";
  if (!Array.isArray(context.allowedModels) || !context.allowedModels.includes(context.model)) return "openai_model_not_allowed";
  if (request.payload?.contract_digest !== context.decisionContractDigest) return "decision_contract_mismatch";
  try { admittedContract(context); } catch { return "decision_contract_mismatch"; }
  return null;
}

export async function preflight(context, request) {
  const reason = admissionReason(context, request);
  return reason ? reject(request, reason) : outcome(request, "ok", { admitted: true });
}

function responsesRequest(context, request) {
  const contract = admittedContract(context);
  return {
    model: context.model,
    store: false,
    background: false,
    input: [
      { role: "developer", content: [{ type: "input_text", text: contract.instructions }] },
      { role: "user", content: [{ type: "input_text", text: JSON.stringify(request.payload) }] },
    ],
    text: { format: { type: "json_schema", name: "praxis_repository_steward_action", strict: true, schema: strictSchema(contract.actionSchema) } },
    tools: [],
    metadata: { application_id: context.applicationId, effect_request_id: request.requestId, decision_contract: context.decisionContractDigest },
  };
}

function exactResponse(value, requestedModel) {
  if (!value || typeof value !== "object" || value.status !== "completed" || value.model !== requestedModel || typeof value.id !== "string") throw new Error("openai_response_not_admitted");
  if (!Array.isArray(value.output)) throw new Error("openai_output_count_not_admitted");
  const messages = value.output.filter((item) => item?.type === "message");
  if (messages.length !== 1) throw new Error("openai_output_count_not_admitted");
  if (value.output.some((item) => item?.type !== "message" && item?.type !== "reasoning")) throw new Error("openai_output_type_not_admitted");
  const message = messages[0];
  if (message?.type !== "message" || message.role !== "assistant" || !Array.isArray(message.content) || message.content.length !== 1) throw new Error("openai_message_not_admitted");
  const content = message.content[0];
  if (content?.type === "refusal") throw new Error("openai_refusal");
  if (content?.type !== "output_text" || typeof content.text !== "string") throw new Error("openai_output_not_text");
  const usage = value.usage;
  for (const field of ["input_tokens", "output_tokens", "total_tokens"]) if (!Number.isSafeInteger(usage?.[field]) || usage[field] < 0) throw new Error("openai_usage_not_admitted");
  return { id: value.id, model: value.model, text: content.text, usage };
}

export async function resolve(context, request) {
  const admitted = await preflight(context, request); if (admitted.status !== "ok") return admitted;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), context.timeoutMs ?? 180_000);
  let response;
  try {
    response = await (context.fetchImplementation ?? defaultFetch)(responsesEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${context.secrets.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(responsesRequest(context, request)), signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout); return recordedFailure(context, request, error?.name === "AbortError" ? "openai_timeout" : "openai_transport_failed");
  }
  clearTimeout(timeout);
  if (!response || response.status < 200 || response.status >= 300) return recordedFailure(context, request, `openai_http_${Number(response?.status) || 0}`);
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximumResponseBytes) return recordedFailure(context, request, "openai_response_too_large");
  const text = await response.text(); if (Buffer.byteLength(text, "utf8") > maximumResponseBytes) return recordedFailure(context, request, "openai_response_too_large");
  try {
    const parsed = exactResponse(JSON.parse(text), context.model);
    const action = actionFromProviderText(parsed.text);
    return outcome(request, "ok", action, {
      provider: "openai", endpointClass: "responses", requestedModel: context.model, returnedModel: parsed.model,
      responseIdSha256: createHash("sha256").update(parsed.id).digest("hex"),
      inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens, totalTokens: parsed.usage.total_tokens, store: false,
    });
  } catch (error) { return recordedFailure(context, request, String(error?.message ?? error).slice(0, 256)); }
}

export async function recover(_context, effectRecord) {
  return effectRecord?.recordedResolution ? structuredClone(effectRecord.recordedResolution) : { status: "failed", payload: { reason: "recorded_resolution_required" } };
}

export const _openAiInternals = { normalizeStrictNode, strictSchema, actionFromProviderText, responsesRequest, exactResponse };
