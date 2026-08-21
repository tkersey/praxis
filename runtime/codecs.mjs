const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const failures = [
  "budget_exhausted",
  "arithmetic_overflow",
  "invalid_index",
  "invalid_variant",
  "capacity_exceeded",
  "authored_abort",
];

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has missing or unknown properties`);
  }
  return value;
}

function boundedString(value, maximumBytes, label) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  const encoded = utf8Encoder.encode(value);
  if (utf8Decoder.decode(encoded) !== value) throw new TypeError(`${label} is not scalar UTF-8`);
  if (encoded.length > maximumBytes) throw new RangeError(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
  return encoded;
}

function uint32(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} must be a uint32`);
  }
  return value;
}

function int32(value, label) {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new RangeError(`${label} must be an int32`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function boundedArray(value, maximumItems, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  if (value.length > maximumItems) throw new RangeError(`${label} exceeds ${maximumItems} items`);
  return value;
}

class Writer {
  #bytes = [];
  u8(value) { this.#bytes.push(value & 0xff); }
  u32(value) {
    uint32(value, "uint32");
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }
  i32(value) { this.u32(int32(value, "int32") >>> 0); }
  bool(value) { this.u8(boolean(value, "bool") ? 1 : 0); }
  text(value, maximumBytes, label) {
    const encoded = boundedString(value, maximumBytes, label);
    this.u32(encoded.length);
    this.#bytes.push(...encoded);
  }
  bytes(value) { this.#bytes.push(...value); }
  vector(value, maximumItems, label, encodeItem) {
    boundedArray(value, maximumItems, label);
    this.u32(value.length);
    for (const item of value) encodeItem(item);
  }
  optional(value, encodeValue) {
    if (value === null) this.u8(0);
    else { this.u8(1); encodeValue(value); }
  }
  finish() { return Uint8Array.from(this.#bytes); }
}

class Reader {
  #bytes;
  #offset = 0;
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("codec input must be Uint8Array");
    this.#bytes = bytes;
  }
  take(length) {
    if (length < 0 || this.#offset + length > this.#bytes.length) throw new RangeError("truncated codec input");
    const result = this.#bytes.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return result;
  }
  u8() { return this.take(1)[0]; }
  u32() {
    const bytes = this.take(4);
    return (bytes[0] + bytes[1] * 0x100 + bytes[2] * 0x1_0000 + bytes[3] * 0x100_0000) >>> 0;
  }
  i32() { return this.u32() | 0; }
  bool() {
    const value = this.u8();
    if (value > 1) throw new RangeError("invalid boolean tag");
    return value === 1;
  }
  text(maximumBytes, label) {
    const length = this.u32();
    if (length > maximumBytes) throw new RangeError(`${label} exceeds ${maximumBytes} UTF-8 bytes`);
    const bytes = this.take(length);
    try { return utf8Decoder.decode(bytes); }
    catch { throw new TypeError(`${label} is malformed UTF-8`); }
  }
  vector(maximumItems, label, decodeItem) {
    const length = this.u32();
    if (length > maximumItems) throw new RangeError(`${label} exceeds ${maximumItems} items`);
    return Array.from({ length }, decodeItem);
  }
  optional(decodeValue) {
    const tag = this.u8();
    if (tag === 0) return null;
    if (tag === 1) return decodeValue();
    throw new RangeError("invalid optional tag");
  }
  enum(labels, label) {
    const ordinal = this.u32();
    if (ordinal >= labels.length) throw new RangeError(`invalid ${label} ordinal`);
    return labels[ordinal];
  }
  finish() {
    if (this.#offset !== this.#bytes.length) throw new RangeError("trailing codec bytes");
  }
}

function encodeFileEntry(w, value) {
  exactObject(value, ["path", "size_bytes", "writable"], "FileEntry");
  w.text(value.path, 256, "path"); w.u32(uint32(value.size_bytes, "size_bytes")); w.bool(value.writable);
}
function decodeFileEntry(r) { return { path: r.text(256, "path"), size_bytes: r.u32(), writable: r.bool() }; }
function encodeSnapshot(w, value) {
  exactObject(value, ["path", "sha256", "contents"], "DocumentSnapshot");
  w.text(value.path, 256, "path"); w.text(value.sha256, 64, "sha256"); w.text(value.contents, 16 * 1024, "contents");
}
function decodeSnapshot(r) { return { path: r.text(256, "path"), sha256: r.text(64, "sha256"), contents: r.text(16 * 1024, "contents") }; }
function encodeSearchHit(w, value) {
  exactObject(value, ["path", "line", "excerpt"], "SearchHit");
  w.text(value.path, 256, "path"); w.u32(uint32(value.line, "line")); w.text(value.excerpt, 512, "excerpt");
}
function decodeSearchHit(r) { return { path: r.text(256, "path"), line: r.u32(), excerpt: r.text(512, "excerpt") }; }
function encodeTestResult(w, value) {
  exactObject(value, ["exit_code", "passed", "output", "truncated"], "TestResult");
  w.i32(value.exit_code); w.bool(value.passed); w.text(value.output, 16 * 1024, "output"); w.bool(value.truncated);
}
function decodeTestResult(r) { return { exit_code: r.i32(), passed: r.bool(), output: r.text(16 * 1024, "output"), truncated: r.bool() }; }
function encodeReplaceDenied(w, value) {
  exactObject(value, ["path", "reason"], "ReplaceDenied"); w.text(value.path, 256, "path"); w.text(value.reason, 512, "reason");
}
function decodeReplaceDenied(r) { return { path: r.text(256, "path"), reason: r.text(512, "reason") }; }
function encodeReplaceConflict(w, value) {
  exactObject(value, ["path", "expected_sha256", "actual_sha256"], "ReplaceConflict");
  w.text(value.path, 256, "path"); w.text(value.expected_sha256, 64, "expected_sha256"); w.text(value.actual_sha256, 64, "actual_sha256");
}
function decodeReplaceConflict(r) { return { path: r.text(256, "path"), expected_sha256: r.text(64, "expected_sha256"), actual_sha256: r.text(64, "actual_sha256") }; }
function encodeReplaceOutcome(w, value) {
  exactObject(value, ["outcome", "value"], "ReplaceOutcome");
  if (value.outcome === "applied") {
    w.u32(0); const v = exactObject(value.value, ["path", "old_sha256", "new_sha256", "already_applied", "current"], "ReplaceApplied");
    w.text(v.path, 256, "path"); w.text(v.old_sha256, 64, "old_sha256"); w.text(v.new_sha256, 64, "new_sha256"); w.bool(v.already_applied); encodeSnapshot(w, v.current);
  } else if (value.outcome === "denied") { w.u32(1); encodeReplaceDenied(w, value.value); }
  else if (value.outcome === "conflict") { w.u32(2); encodeReplaceConflict(w, value.value); }
  else throw new RangeError("unknown ReplaceOutcome tag");
}
function decodeReplaceOutcome(r) {
  const tag = r.u32();
  if (tag === 0) return { outcome: "applied", value: { path: r.text(256, "path"), old_sha256: r.text(64, "old_sha256"), new_sha256: r.text(64, "new_sha256"), already_applied: r.bool(), current: decodeSnapshot(r) } };
  if (tag === 1) return { outcome: "denied", value: decodeReplaceDenied(r) };
  if (tag === 2) return { outcome: "conflict", value: decodeReplaceConflict(r) };
  throw new RangeError("unknown ReplaceOutcome tag");
}

const payloadCodecs = {
  list: {
    decode: () => ({}), encodePayload(w, value) { exactObject(value, [], "list payload"); },
    encodeResult(w, value) { const v = exactObject(value, ["entries", "truncated"], "ListResult"); w.vector(v.entries, 64, "entries", (item) => encodeFileEntry(w, item)); w.bool(v.truncated); },
    decodeResult: (r) => ({ entries: r.vector(64, "entries", () => decodeFileEntry(r)), truncated: r.bool() }),
  },
  read: {
    decode: (r) => ({ path: r.text(256, "path") }), encodePayload(w, value) { const v = exactObject(value, ["path"], "read payload"); w.text(v.path, 256, "path"); },
    encodeResult: encodeSnapshot, decodeResult: decodeSnapshot,
  },
  search: {
    decode: (r) => ({ query: r.text(256, "query"), path_prefix: r.text(256, "path_prefix") }),
    encodePayload(w, value) { const v = exactObject(value, ["query", "path_prefix"], "search payload"); w.text(v.query, 256, "query"); w.text(v.path_prefix, 256, "path_prefix"); },
    encodeResult(w, value) { const v = exactObject(value, ["hits", "truncated"], "SearchResult"); w.vector(v.hits, 24, "hits", (item) => encodeSearchHit(w, item)); w.bool(v.truncated); },
    decodeResult: (r) => ({ hits: r.vector(24, "hits", () => decodeSearchHit(r)), truncated: r.bool() }),
  },
  test: {
    decode: (r) => ({ suite: r.enum(["full"], "TestSuite") }), encodePayload(w, value) { const v = exactObject(value, ["suite"], "test payload"); if (v.suite !== "full") throw new RangeError("unknown TestSuite"); w.u32(0); },
    encodeResult: encodeTestResult, decodeResult: decodeTestResult,
  },
  replace: {
    decode: (r) => ({ path: r.text(256, "path"), expected_sha256: r.text(64, "expected_sha256"), replacement: r.text(16 * 1024, "replacement"), rationale: r.text(4 * 1024, "rationale") }),
    encodePayload(w, value) { const v = exactObject(value, ["path", "expected_sha256", "replacement", "rationale"], "replace payload"); w.text(v.path, 256, "path"); w.text(v.expected_sha256, 64, "expected_sha256"); w.text(v.replacement, 16 * 1024, "replacement"); w.text(v.rationale, 4 * 1024, "rationale"); },
    encodeResult: encodeReplaceOutcome, decodeResult: decodeReplaceOutcome,
  },
};

export function decodeEffectPayload(operation, bytes) {
  const codec = payloadCodecs[operation]; if (!codec) throw new RangeError("unknown repository operation");
  const r = new Reader(bytes); const value = codec.decode(r); r.finish(); return value;
}
export function encodeEffectResult(operation, value) {
  const codec = payloadCodecs[operation]; if (!codec) throw new RangeError("unknown repository operation");
  const w = new Writer(); codec.encodeResult(w, value); return w.finish();
}
export function encodeEffectPayload(operation, value) {
  const codec = payloadCodecs[operation]; if (!codec) throw new RangeError("unknown repository operation");
  const w = new Writer(); codec.encodePayload(w, value); return w.finish();
}
export function decodeEffectResult(operation, bytes) {
  const codec = payloadCodecs[operation]; if (!codec) throw new RangeError("unknown repository operation");
  const r = new Reader(bytes); const value = codec.decodeResult(r); r.finish(); return value;
}

function encodeFinal(w, value) {
  const v = exactObject(value, ["summary", "changed_files", "tests_passed", "mutation_count"], "FinalResult");
  w.text(v.summary, 4 * 1024, "summary"); w.vector(v.changed_files, 4, "changed_files", (path) => w.text(path, 256, "changed_file")); w.bool(v.tests_passed); w.u32(uint32(v.mutation_count, "mutation_count"));
}
function decodeFinalFrom(r) { return { summary: r.text(4 * 1024, "summary"), changed_files: r.vector(4, "changed_files", () => r.text(256, "changed_file")), tests_passed: r.bool(), mutation_count: r.u32() }; }

export function encodeAction(value) {
  const action = exactObject(value, ["action", "arguments"], "Action"); const w = new Writer();
  const variants = ["list_repository", "read_file", "search_text", "run_tests", "replace_file", "final", "abort"];
  const tag = variants.indexOf(action.action); if (tag < 0) throw new RangeError("unknown action"); w.u32(tag);
  if (tag === 0) exactObject(action.arguments, [], "list_repository arguments");
  else if (tag === 1) { const v = exactObject(action.arguments, ["path"], "read_file arguments"); w.text(v.path, 256, "path"); }
  else if (tag === 2) { const v = exactObject(action.arguments, ["query", "path_prefix"], "search_text arguments"); w.text(v.query, 256, "query"); w.text(v.path_prefix, 256, "path_prefix"); }
  else if (tag === 3) { const v = exactObject(action.arguments, ["suite"], "run_tests arguments"); if (v.suite !== "full") throw new RangeError("unknown TestSuite"); w.u32(0); }
  else if (tag === 4) { const v = exactObject(action.arguments, ["path", "expected_sha256", "replacement", "rationale"], "replace_file arguments"); w.text(v.path, 256, "path"); w.text(v.expected_sha256, 64, "expected_sha256"); w.text(v.replacement, 16 * 1024, "replacement"); w.text(v.rationale, 4 * 1024, "rationale"); }
  else if (tag === 5) encodeFinal(w, action.arguments);
  else { if (!failures.includes(action.arguments)) throw new RangeError("unknown Failure"); w.u32(failures.indexOf(action.arguments)); }
  return w.finish();
}

export function decodeAction(bytes) {
  const r = new Reader(bytes); const tag = r.u32(); let value;
  if (tag === 0) value = { action: "list_repository", arguments: {} };
  else if (tag === 1) value = { action: "read_file", arguments: { path: r.text(256, "path") } };
  else if (tag === 2) value = { action: "search_text", arguments: { query: r.text(256, "query"), path_prefix: r.text(256, "path_prefix") } };
  else if (tag === 3) value = { action: "run_tests", arguments: { suite: r.enum(["full"], "TestSuite") } };
  else if (tag === 4) value = { action: "replace_file", arguments: { path: r.text(256, "path"), expected_sha256: r.text(64, "expected_sha256"), replacement: r.text(16 * 1024, "replacement"), rationale: r.text(4 * 1024, "rationale") } };
  else if (tag === 5) value = { action: "final", arguments: decodeFinalFrom(r) };
  else if (tag === 6) value = { action: "abort", arguments: r.enum(failures, "Failure") };
  else throw new RangeError("unknown Action tag"); r.finish(); return value;
}

export function decodeFinalResult(bytes) { const r = new Reader(bytes); const value = decodeFinalFrom(r); r.finish(); return value; }

function hex(bytes) { return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""); }
function bytesFromHex(value, expectedBytes, label) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${expectedBytes * 2}}$`).test(value)) {
    throw new TypeError(`${label} must be ${expectedBytes * 2} lowercase hexadecimal characters`);
  }
  return Uint8Array.from({ length: expectedBytes }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}
function encodeMutationSummary(w, value) {
  const v = exactObject(value, ["path", "old_sha256", "new_sha256", "already_applied"], "MutationSummary");
  w.text(v.path, 256, "path"); w.text(v.old_sha256, 64, "old_sha256"); w.text(v.new_sha256, 64, "new_sha256"); w.bool(v.already_applied);
}
function decodeMutationSummary(r) { return { path: r.text(256, "path"), old_sha256: r.text(64, "old_sha256"), new_sha256: r.text(64, "new_sha256"), already_applied: r.bool() }; }
function encodeReplaceSummary(w, value) {
  const v = exactObject(value, ["outcome", "value"], "ReplaceSummary");
  if (v.outcome === "applied") { w.u32(0); encodeMutationSummary(w, v.value); }
  else if (v.outcome === "denied") { w.u32(1); encodeReplaceDenied(w, v.value); }
  else if (v.outcome === "conflict") { w.u32(2); encodeReplaceConflict(w, v.value); }
  else throw new RangeError("unknown ReplaceSummary tag");
}
function decodeReplaceSummary(r) {
  const tag = r.u32();
  if (tag === 0) return { outcome: "applied", value: decodeMutationSummary(r) };
  if (tag === 1) return { outcome: "denied", value: decodeReplaceDenied(r) };
  if (tag === 2) return { outcome: "conflict", value: decodeReplaceConflict(r) };
  throw new RangeError("unknown ReplaceSummary tag");
}
function decodeListResult(r) { return { entries: r.vector(64, "entries", () => decodeFileEntry(r)), truncated: r.bool() }; }
function decodeSearchResult(r) { return { hits: r.vector(24, "hits", () => decodeSearchHit(r)), truncated: r.bool() }; }
function encodeReadEvidence(w, value) {
  const v = exactObject(value, ["path", "observed_test_count", "observed_conflict_count"], "ReadEvidence");
  w.text(v.path, 256, "path"); w.u32(uint32(v.observed_test_count, "observed_test_count")); w.u32(uint32(v.observed_conflict_count, "observed_conflict_count"));
}
function decodeReadEvidence(r) { return { path: r.text(256, "path"), observed_test_count: r.u32(), observed_conflict_count: r.u32() }; }
function encodeListResult(w, value) {
  const v = exactObject(value, ["entries", "truncated"], "ListResult");
  w.vector(v.entries, 64, "entries", (entry) => encodeFileEntry(w, entry)); w.bool(v.truncated);
}
function encodeSearchResult(w, value) {
  const v = exactObject(value, ["hits", "truncated"], "SearchResult");
  w.vector(v.hits, 24, "hits", (hit) => encodeSearchHit(w, hit)); w.bool(v.truncated);
}
function encodeDecisionView(w, value) {
  const v = exactObject(value, ["listing", "documents", "latest_search", "latest_test", "latest_replace", "mutations", "evidence"], "DecisionView");
  w.optional(v.listing, (item) => encodeListResult(w, item));
  w.vector(v.documents, 10, "documents", (item) => encodeSnapshot(w, item));
  w.optional(v.latest_search, (item) => encodeSearchResult(w, item));
  w.optional(v.latest_test, (item) => encodeTestResult(w, item));
  w.optional(v.latest_replace, (item) => encodeReplaceSummary(w, item));
  w.vector(v.mutations, 10, "mutations", (item) => encodeMutationSummary(w, item));
  const evidence = exactObject(v.evidence, ["baseline_test_observed", "latest_test_passed", "mutation_count", "last_test_mutation_count", "test_count", "latest_read", "conflict_count"], "DecisionEvidence");
  w.bool(evidence.baseline_test_observed); w.bool(evidence.latest_test_passed); w.u32(evidence.mutation_count);
  w.u32(evidence.last_test_mutation_count); w.u32(evidence.test_count); encodeReadEvidence(w, evidence.latest_read); w.u32(uint32(evidence.conflict_count, "conflict_count"));
}
function decodeDecisionView(r) {
  return {
    listing: r.optional(() => decodeListResult(r)),
    documents: r.vector(10, "documents", () => decodeSnapshot(r)),
    latest_search: r.optional(() => decodeSearchResult(r)),
    latest_test: r.optional(() => decodeTestResult(r)),
    latest_replace: r.optional(() => decodeReplaceSummary(r)),
    mutations: r.vector(10, "mutations", () => decodeMutationSummary(r)),
    evidence: {
      baseline_test_observed: r.bool(), latest_test_passed: r.bool(), mutation_count: r.u32(),
      last_test_mutation_count: r.u32(), test_count: r.u32(), latest_read: decodeReadEvidence(r), conflict_count: r.u32(),
    },
  };
}

export function decodeDecisionTurn(bytes) {
  const r = new Reader(bytes);
  const value = {
    contract_digest: hex(r.take(32)),
    goal: { task: r.text(8 * 1024, "task"), repository: r.text(128, "repository"), base_revision: r.text(64, "base_revision") },
    counters: { turns: r.u32(), decisions: r.u32(), effect_actions: r.u32(), child_actions: r.u32() },
    phase: r.enum(["decide", "propose", "reflect"], "DecisionPhase"),
    context: decodeDecisionView(r),
    strategy_local: null,
  };
  r.finish(); return value;
}

export function encodeDecisionTurn(value) {
  const v = exactObject(value, ["contract_digest", "goal", "counters", "phase", "context", "strategy_local"], "DecisionTurn");
  const w = new Writer(); w.bytes(bytesFromHex(v.contract_digest, 32, "contract_digest"));
  const goal = exactObject(v.goal, ["task", "repository", "base_revision"], "Goal");
  w.text(goal.task, 8 * 1024, "task"); w.text(goal.repository, 128, "repository"); w.text(goal.base_revision, 64, "base_revision");
  const counters = exactObject(v.counters, ["turns", "decisions", "effect_actions", "child_actions"], "Counters");
  w.u32(counters.turns); w.u32(counters.decisions); w.u32(counters.effect_actions); w.u32(counters.child_actions);
  const phases = ["decide", "propose", "reflect"]; const phase = phases.indexOf(v.phase);
  if (phase < 0) throw new RangeError("unknown DecisionPhase"); w.u32(phase);
  encodeDecisionView(w, v.context);
  if (v.strategy_local !== null) throw new TypeError("strategy_local must be null");
  return w.finish();
}

export const _codecInternals = { Reader, Writer, exactObject, boundedString };
