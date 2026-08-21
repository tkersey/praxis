import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  decodeAction,
  decodeDecisionTurn,
  decodeEffectPayload,
  decodeEffectResult,
  decodeFinalResult,
  encodeAction,
  encodeDecisionTurn,
  encodeEffectPayload,
  encodeEffectResult,
} from "../runtime/codecs.mjs";

const vectorsPath = process.argv[2] ?? path.resolve("zig-out/repository-steward/repository-steward.codec-vectors.json");
const document = JSON.parse(fs.readFileSync(vectorsPath, "utf8"));
assert.equal(document.format, "praxis-codec-vectors/v1");
assert.ok(Array.isArray(document.vectors));

const repeated = (character) => character.repeat(64);
const entry = (index) => ({ path: `src/file-${index}.zig`, size_bytes: index + 1, writable: index < 4 });
const hit = (index) => ({ path: `src/file-${index}.zig`, line: index + 1, excerpt: "literal match" });
const snapshot = (pathValue, character, contents) => ({ path: pathValue, sha256: repeated(character), contents });
const mutation = { path: "src/file-0.zig", old_sha256: repeated("a"), new_sha256: repeated("b"), already_applied: false };
const mutationAt = (index) => ({
  path: "src/file-0.zig",
  old_sha256: repeated(String.fromCharCode("a".charCodeAt(0) + index)),
  new_sha256: repeated(String.fromCharCode("b".charCodeAt(0) + index)),
  already_applied: false,
});
const finalResult = { summary: "Repaired and verified.", changed_files: ["src/file-0.zig", "src/file-1.zig"], tests_passed: true, mutation_count: 2 };
const replaceRequest = { path: "src/main.zig", expected_sha256: repeated("a"), replacement: "const repaired = true;\n", rationale: "Repair behavior." };

const expected = new Map([
  ["action_list", { action: "list_repository", arguments: {} }],
  ["action_read", { action: "read_file", arguments: { path: "src/main.zig" } }],
  ["action_search", { action: "search_text", arguments: { query: "needle", path_prefix: "src" } }],
  ["action_test", { action: "run_tests", arguments: { suite: "full" } }],
  ["action_replace", { action: "replace_file", arguments: replaceRequest }],
  ["action_final", { action: "final", arguments: finalResult }],
  ["action_abort", { action: "abort", arguments: "authored_abort" }],
  ["final_result", finalResult],
  ["payload_list", {}],
  ["payload_read", { path: "src/main.zig" }],
  ["payload_search", { query: "needle", path_prefix: "src" }],
  ["payload_test", { suite: "full" }],
  ["payload_replace", replaceRequest],
  ["result_list_empty", { entries: [], truncated: false }],
  ["result_list_maximum", { entries: Array.from({ length: 64 }, (_, index) => entry(index)), truncated: true }],
  ["result_read", snapshot("src/main.zig", "b", "const repaired = true;\n")],
  ["result_search_empty", { hits: [], truncated: false }],
  ["result_search_maximum", { hits: Array.from({ length: 24 }, (_, index) => hit(index)), truncated: true }],
  ["result_test_positive", { exit_code: 0, passed: true, output: "all checks passed", truncated: false }],
  ["result_test_negative", { exit_code: -7, passed: false, output: "check failed", truncated: true }],
  ["result_replace_applied", { outcome: "applied", value: { path: "src/main.zig", old_sha256: repeated("a"), new_sha256: repeated("b"), already_applied: false, current: snapshot("src/main.zig", "b", "const repaired = true;\n") } }],
  ["result_replace_denied", { outcome: "denied", value: { path: "src/main.zig", reason: "not writable" } }],
  ["result_replace_conflict", { outcome: "conflict", value: { path: "src/main.zig", expected_sha256: repeated("a"), actual_sha256: repeated("c") } }],
]);

const contractDigest = "52dd0677dfa232923d47a8f563dd2ab4b4fb456a5d0d0a6e3cb697a3b7d0e114";
const baseTurn = (counters, context) => ({
  contract_digest: contractDigest,
  goal: { task: "Repair the admitted Zig fixture.", repository: "tkersey/fixture", base_revision: "0123456789abcdef0123456789abcdef01234567" },
  counters,
  phase: "decide",
  context,
  strategy_local: null,
});
const emptyContext = {
  listing: null, documents: [], latest_search: null, latest_test: null, latest_replace: null, mutations: [],
  evidence: { baseline_test_observed: false, latest_test_passed: false, mutation_count: 0, last_test_mutation_count: 0, test_count: 0, latest_read: { path: "", observed_test_count: 0, observed_conflict_count: 0 }, conflict_count: 0 },
};
const retainedContext = (secondDocument, passing) => ({
  listing: { entries: [entry(0), entry(1)], truncated: false },
  documents: [snapshot("src/file-0.zig", "b", "const value = 1;\n"), ...(secondDocument ? [snapshot("src/file-1.zig", "c", "const other = 0;\n")] : [])],
  latest_search: { hits: [hit(0)], truncated: false },
  latest_test: passing
    ? { exit_code: 0, passed: true, output: "all checks passed", truncated: false }
    : { exit_code: 1, passed: false, output: "check failed", truncated: false },
  latest_replace: { outcome: "applied", value: mutation },
  mutations: [mutation],
  evidence: { baseline_test_observed: true, latest_test_passed: passing, mutation_count: 1, last_test_mutation_count: passing ? 1 : 0, test_count: passing ? 2 : 1, latest_read: { path: "src/file-0.zig", observed_test_count: passing ? 2 : 0, observed_conflict_count: 0 }, conflict_count: 0 },
});
expected.set("decision_turn_empty", baseTurn({ turns: 0, decisions: 0, effect_actions: 0, child_actions: 0 }, emptyContext));
expected.set("decision_turn_same_path", baseTurn({ turns: 5, decisions: 5, effect_actions: 5, child_actions: 0 }, retainedContext(false, false)));
expected.set("decision_turn_multi_path", baseTurn({ turns: 8, decisions: 8, effect_actions: 8, child_actions: 0 }, retainedContext(true, true)));
const maximumMutations = Array.from({ length: 10 }, (_, index) => mutationAt(index));
expected.set("decision_turn_maximum_mutations", baseTurn(
  { turns: 33, decisions: 33, effect_actions: 33, child_actions: 0 },
  {
    listing: { entries: [entry(0), entry(1)], truncated: false },
    documents: [
      snapshot("src/file-0.zig", "k", "const value = 10;\n"),
      snapshot("src/file-1.zig", "c", "const other = 0;\n"),
    ],
    latest_search: { hits: [hit(0)], truncated: false },
    latest_test: { exit_code: 0, passed: true, output: "all checks passed", truncated: false },
    latest_replace: { outcome: "applied", value: maximumMutations.at(-1) },
    mutations: maximumMutations,
    evidence: { baseline_test_observed: true, latest_test_passed: false, mutation_count: 10, last_test_mutation_count: 9, test_count: 10, latest_read: { path: "src/file-0.zig", observed_test_count: 10, observed_conflict_count: 0 }, conflict_count: 0 },
  },
));

function bytes(vector) {
  assert.match(vector.hex, /^(?:[0-9a-f]{2})*$/);
  return Uint8Array.from(Buffer.from(vector.hex, "hex"));
}

function decode(vector, encoded) {
  if (vector.kind === "action") return decodeAction(encoded);
  if (vector.kind === "final_result") return decodeFinalResult(encoded);
  if (vector.kind === "payload") return decodeEffectPayload(vector.operation, encoded);
  if (vector.kind === "result") return decodeEffectResult(vector.operation, encoded);
  if (vector.kind === "decision_turn") return decodeDecisionTurn(encoded);
  throw new Error(`unknown vector kind: ${vector.kind}`);
}

function encode(vector, value) {
  if (vector.kind === "action") return encodeAction(value);
  if (vector.kind === "final_result") return encodeAction({ action: "final", arguments: value }).subarray(4);
  if (vector.kind === "payload") return encodeEffectPayload(vector.operation, value);
  if (vector.kind === "result") return encodeEffectResult(vector.operation, value);
  if (vector.kind === "decision_turn") return encodeDecisionTurn(value);
  throw new Error(`unknown vector kind: ${vector.kind}`);
}

const seen = new Set();
for (const vector of document.vectors) {
  assert.equal(typeof vector.name, "string");
  assert.ok(!seen.has(vector.name), `duplicate vector ${vector.name}`);
  seen.add(vector.name);
  assert.ok(expected.has(vector.name), `missing logical oracle for ${vector.name}`);
  const encoded = bytes(vector);
  const logical = decode(vector, encoded);
  assert.deepEqual(logical, expected.get(vector.name), `${vector.name} logical mismatch`);
  assert.deepEqual(encode(vector, logical), encoded, `${vector.name} byte mismatch`);
}
assert.deepEqual(seen, new Set(expected.keys()), "Zig vector set differs from JavaScript oracle set");

const read = document.vectors.find((vector) => vector.name === "action_read");
const readBytes = bytes(read);
assert.throws(() => decodeAction(readBytes.subarray(0, readBytes.length - 1)), /truncated/);
assert.throws(() => decodeAction(Uint8Array.from([...readBytes, 0])), /trailing/);
assert.throws(() => decodeAction(Uint8Array.of(255, 255, 255, 255)), /unknown Action tag/);
assert.throws(() => decodeAction(Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 0, 255)), /malformed UTF-8/);
assert.throws(() => decodeAction(Uint8Array.of(1, 0, 0, 0, 1, 1, 0, 0)), /exceeds 256/);
assert.throws(() => decodeAction(Uint8Array.of(3, 0, 0, 0, 1, 0, 0, 0)), /invalid TestSuite ordinal/);
assert.throws(() => encodeAction({ action: "list_repository", arguments: {}, extra: true }), /unknown properties/);

process.stdout.write(`praxis_codec_vectors=${document.vectors.length}\npraxis_codec_parity=true\n`);
