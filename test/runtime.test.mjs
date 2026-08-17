import { describe, expect, test } from "bun:test";
import {
  decodeAction,
  decodeEffectPayload,
  decodeEffectResult,
  decodeFinalResult,
  encodeAction,
  encodeEffectPayload,
  encodeEffectResult,
} from "../runtime/codecs.mjs";

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const snapshot = { path: "src/main.zig", sha256: digest, contents: "const ready = true;\n" };

const actions = [
  { action: "list_repository", arguments: {} },
  { action: "read_file", arguments: { path: "src/main.zig" } },
  { action: "search_text", arguments: { query: "ready", path_prefix: "src" } },
  { action: "run_tests", arguments: { suite: "full" } },
  { action: "replace_file", arguments: { path: "src/main.zig", expected_sha256: digest, replacement: "const ready = true;\n", rationale: "Repair behavior." } },
  { action: "final", arguments: { summary: "Repaired behavior.", changed_files: ["src/main.zig"], tests_passed: true, mutation_count: 1 } },
  { action: "abort", arguments: "authored_abort" },
];

describe("Praxis action codec", () => {
  for (const value of actions) test(`round trips ${value.action}`, () => {
    expect(decodeAction(encodeAction(value))).toEqual(value);
  });

  test("rejects unknown, missing, over-bound, and invalid values", () => {
    expect(() => encodeAction({ action: "read_file", arguments: { path: "x", extra: true } })).toThrow();
    expect(() => encodeAction({ action: "read_file", arguments: {} })).toThrow();
    expect(() => encodeAction({ action: "read_file", arguments: { path: "x".repeat(257) } })).toThrow();
    expect(() => encodeAction({ action: "run_tests", arguments: { suite: "quick" } })).toThrow();
    expect(() => encodeAction({ action: "unknown", arguments: {} })).toThrow();
  });

  test("rejects truncated, extended, unknown-tag, malformed UTF-8, and over-bound bytes", () => {
    const encoded = encodeAction(actions[1]);
    expect(() => decodeAction(encoded.subarray(0, encoded.length - 1))).toThrow();
    expect(() => decodeAction(Uint8Array.from([...encoded, 0]))).toThrow();
    expect(() => decodeAction(Uint8Array.of(99, 0, 0, 0))).toThrow();
    expect(() => decodeAction(Uint8Array.of(1, 0, 0, 0, 1, 0, 0, 0, 0xff))).toThrow();
    expect(() => decodeAction(Uint8Array.of(1, 0, 0, 0, 1, 1, 0, 0))).toThrow();
  });
});

describe("Praxis effect codecs", () => {
  const cases = [
    ["list", {}, { entries: [{ path: "src/main.zig", size_bytes: 21, writable: true }], truncated: false }],
    ["read", { path: "src/main.zig" }, snapshot],
    ["search", { query: "ready", path_prefix: "src" }, { hits: [{ path: "src/main.zig", line: 1, excerpt: "const ready" }], truncated: false }],
    ["test", { suite: "full" }, { exit_code: -1, passed: false, output: "failed", truncated: false }],
    ["replace", { path: "src/main.zig", expected_sha256: digest, replacement: snapshot.contents, rationale: "repair" }, { outcome: "applied", value: { path: "src/main.zig", old_sha256: digest, new_sha256: otherDigest, already_applied: false, current: { ...snapshot, sha256: otherDigest } } }],
  ];
  for (const [operation, payload, result] of cases) test(`round trips ${operation}`, () => {
    expect(decodeEffectPayload(operation, encodeEffectPayload(operation, payload))).toEqual(payload);
    expect(decodeEffectResult(operation, encodeEffectResult(operation, result))).toEqual(result);
  });

  test("round trips denied and conflict replacement outcomes", () => {
    for (const value of [
      { outcome: "denied", value: { path: "src/main.zig", reason: "not approved" } },
      { outcome: "conflict", value: { path: "src/main.zig", expected_sha256: digest, actual_sha256: otherDigest } },
    ]) expect(decodeEffectResult("replace", encodeEffectResult("replace", value))).toEqual(value);
  });

  test("decodes terminal FinalResult independently", () => {
    const final = actions[5].arguments;
    expect(decodeFinalResult(encodeAction(actions[5]).subarray(4))).toEqual(final);
  });
});
