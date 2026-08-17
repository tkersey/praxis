import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";

const utf8 = new TextDecoder("utf-8", { fatal: true });
const maximumExcerptBytes = 512;
const testOutputBytes = 16 * 1024;
const testTimeoutMs = 600_000;
const exactCheck = Object.freeze({ kind: "zig-build-check-v1", argv: ["build", "check", "--summary", "all"] });
const compiledLimits = Object.freeze({ maximumFileBytes: 16 * 1024, maximumListedFiles: 64, maximumChangedFiles: 4, maximumMutationOperations: 6 });

function exactObject(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const actual = Object.keys(value).sort(); const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(`${label} has missing or unknown fields`);
  return value;
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256Bytes(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function sha256Text(value) { return sha256Bytes(Buffer.from(value, "utf8")); }

function validatePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 256) throw new TypeError(`${label} is outside the path bound`);
  if (value.includes("\0") || value.includes("\\") || value.endsWith("/") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new TypeError(`${label} is not a normalized relative path`);
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new TypeError(`${label} is not normalized`);
  return value;
}

function validatePathPrefix(value) {
  if (value === "") return value;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 256) throw new TypeError("path_prefix is outside the path bound");
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  validatePath(normalized, "path_prefix");
  return normalized;
}

function sortedUniquePaths(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${label} is outside its item bound`);
  const paths = value.map((item, index) => validatePath(item, `${label}[${index}]`));
  const sorted = [...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (paths.some((item, index) => item !== sorted[index]) || new Set(paths).size !== paths.length) throw new TypeError(`${label} must be unique and byte-sorted`);
  return Object.freeze(paths);
}

export function admitWorkspacePolicy(value, { repository, baseRevision } = {}) {
  const policy = exactObject(value, ["format", "repository", "baseRevision", "readablePaths", "writablePaths", "check", "limits"], "workspace policy");
  if (policy.format !== "praxis-workspace-policy/v1") throw new TypeError("workspace policy format mismatch");
  if (typeof policy.repository !== "string" || policy.repository !== repository) throw new TypeError("workspace policy repository mismatch");
  if (!/^[0-9a-f]{40}$/.test(policy.baseRevision) || policy.baseRevision !== baseRevision) throw new TypeError("workspace policy base revision mismatch");
  const readablePaths = sortedUniquePaths(policy.readablePaths, compiledLimits.maximumListedFiles, "readablePaths");
  const writablePaths = sortedUniquePaths(policy.writablePaths, compiledLimits.maximumChangedFiles, "writablePaths");
  const readable = new Set(readablePaths);
  if (writablePaths.some((item) => !readable.has(item))) throw new TypeError("writablePaths must be a subset of readablePaths");
  const check = exactObject(policy.check, ["kind", "argv"], "check");
  if (check.kind !== exactCheck.kind || !Array.isArray(check.argv) || check.argv.length !== exactCheck.argv.length || check.argv.some((item, index) => item !== exactCheck.argv[index])) throw new TypeError("workspace policy check mismatch");
  const limits = exactObject(policy.limits, Object.keys(compiledLimits), "limits");
  for (const [name, maximum] of Object.entries(compiledLimits)) {
    if (!Number.isInteger(limits[name]) || limits[name] <= 0 || limits[name] > maximum) throw new TypeError(`workspace policy ${name} exceeds compiled maximum`);
  }
  if (limits.maximumListedFiles < readablePaths.length || limits.maximumChangedFiles < writablePaths.length) throw new TypeError("workspace policy path count exceeds policy limits");
  const admitted = {
    format: policy.format,
    repository: policy.repository,
    baseRevision: policy.baseRevision,
    readablePaths: [...readablePaths],
    writablePaths: [...writablePaths],
    check: { kind: check.kind, argv: [...check.argv] },
    limits: Object.fromEntries(Object.keys(compiledLimits).map((name) => [name, limits[name]])),
  };
  return Object.freeze({ policy: Object.freeze(admitted), digest: sha256Text(canonical(admitted)) });
}

async function admittedFile(context, requested, writable) {
  validatePath(requested, "path");
  const members = new Set(writable ? context.policy.writablePaths : context.policy.readablePaths);
  if (!members.has(requested)) throw new Error(writable ? "path_not_writable" : "path_not_readable");
  const root = await realpath(context.workspaceRoot);
  if (root !== context.workspaceRootReal) throw new Error("workspace_root_changed");
  const full = resolvePath(root, requested);
  const rel = relative(root, full);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("path_escapes_workspace");
  const info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("path_not_ordinary_file");
  return { full, path: requested, info };
}

async function readSnapshot(context, requested) {
  const admitted = await admittedFile(context, requested, false);
  if (admitted.info.size > context.policy.limits.maximumFileBytes) throw new Error("file_too_large");
  const bytes = await readFile(admitted.full);
  if (bytes.length > context.policy.limits.maximumFileBytes) throw new Error("file_too_large");
  let contents;
  try { contents = utf8.decode(bytes); } catch { throw new Error("file_not_utf8"); }
  return { path: admitted.path, sha256: sha256Bytes(bytes), contents };
}

function truncateUtf8(value, maximumBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  let end = maximumBytes;
  while (end > 0) {
    try { return utf8.decode(bytes.subarray(0, end)); } catch { end -= 1; }
  }
  return "";
}

async function listRepository(context) {
  const entries = [];
  const writable = new Set(context.policy.writablePaths);
  for (const admittedPath of context.policy.readablePaths) {
    const file = await admittedFile(context, admittedPath, false);
    if (file.info.size > context.policy.limits.maximumFileBytes) throw new Error("file_too_large");
    await readSnapshot(context, admittedPath);
    entries.push({ path: admittedPath, size_bytes: file.info.size, writable: writable.has(admittedPath) });
  }
  return { entries, truncated: false };
}

async function searchRepository(context, payload) {
  if (typeof payload.query !== "string" || Buffer.byteLength(payload.query, "utf8") === 0 || Buffer.byteLength(payload.query, "utf8") > 256) throw new Error("search_query_not_admitted");
  const pathPrefix = validatePathPrefix(payload.path_prefix);
  const candidates = context.policy.readablePaths.filter((candidate) => pathPrefix === "" || candidate === pathPrefix || candidate.startsWith(`${pathPrefix}/`));
  const hits = []; let truncated = false;
  for (const candidate of candidates) {
    const document = await readSnapshot(context, candidate);
    const lines = document.contents.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(payload.query)) continue;
      if (hits.length === 24) { truncated = true; break; }
      hits.push({ path: candidate, line: index + 1, excerpt: truncateUtf8(lines[index], maximumExcerptBytes) });
    }
    if (truncated) break;
  }
  return { hits, truncated };
}

async function spawnCheck(context) {
  if (!isAbsolute(context.zigExecutable)) throw new Error("zig_executable_not_absolute");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(context.zigExecutable, exactCheck.argv, {
      cwd: context.workspaceRootReal,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        HOME: context.temporaryHome, TMPDIR: context.temporaryHome, NO_COLOR: "1",
        ZIG_LOCAL_CACHE_DIR: join(context.temporaryHome, "zig-local-cache"),
        ZIG_GLOBAL_CACHE_DIR: join(context.temporaryHome, "zig-global-cache"),
        PATH: `${dirname(context.zigExecutable)}:/usr/bin:/bin`,
      },
    });
    const chunks = []; let retained = 0; let truncated = false;
    const capture = (chunk) => {
      const bytes = Buffer.from(chunk);
      const available = Math.max(0, testOutputBytes - retained);
      if (available > 0) { chunks.push(bytes.subarray(0, available)); retained += Math.min(bytes.length, available); }
      if (bytes.length > available) truncated = true;
    };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, testTimeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const bytes = Buffer.concat(chunks);
      let output; try { output = utf8.decode(bytes); } catch { output = bytes.toString("utf8"); }
      const exitCode = Number.isInteger(code) ? code : -1;
      resolvePromise({ exit_code: exitCode, passed: exitCode === 0 && signal === null, output, truncated: truncated || signal !== null });
    });
  });
}

function digestPart(hasher, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4); length.writeUInt32LE(bytes.length); hasher.update(length); hasher.update(bytes);
}

export function replacementProposalDigest(context, request) {
  const hasher = createHash("sha256");
  digestPart(hasher, "praxis.replace.proposal.v1");
  for (const value of ["replace", request.payload.path, request.payload.expected_sha256]) digestPart(hasher, value);
  digestPart(hasher, Buffer.from(request.payload.replacement, "utf8"));
  digestPart(hasher, Buffer.from(request.payload.rationale, "utf8"));
  for (const value of [context.applicationId, context.runId, context.policyDigest]) digestPart(hasher, value);
  return hasher.digest("hex");
}

async function approve(context, request, replacementSha256) {
  const proposalDigest = replacementProposalDigest(context, request);
  const approval = {
    format: "praxis-approval/v1", runId: context.runId, applicationId: context.applicationId,
    requestId: request.requestId, proposalDigest, path: request.payload.path,
    expectedSha256: request.payload.expected_sha256, replacementSha256,
    policyDigest: context.policyDigest, approved: true, mode: "receiver-policy-verified",
  };
  await mkdir(context.approvalRoot, { recursive: true, mode: 0o700 });
  const approvalPath = join(context.approvalRoot, `${request.requestId}.json`);
  const encoded = `${canonical(approval)}\n`;
  try { await writeFile(approvalPath, encoded, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error?.code !== "EEXIST" || await readFile(approvalPath, "utf8") !== encoded) throw error;
  }
  context.approvalBindings ??= [];
  if (!context.approvalBindings.some((item) => item.requestId === approval.requestId)) {
    context.approvalBindings.push({ requestId: approval.requestId, proposalDigest: approval.proposalDigest, path: approval.path, expectedSha256: approval.expectedSha256, replacementSha256: approval.replacementSha256, policyDigest: approval.policyDigest });
  }
  return approval;
}

async function replaceApproved(context, request) {
  const payload = request.payload;
  const admitted = await admittedFile(context, payload.path, true);
  if (Buffer.byteLength(payload.replacement, "utf8") > context.policy.limits.maximumFileBytes) return { outcome: "denied", value: { path: payload.path, reason: "replacement_too_large" } };
  if (!/^[0-9a-f]{64}$/.test(payload.expected_sha256)) return { outcome: "denied", value: { path: payload.path, reason: "expected_digest_invalid" } };
  const current = await readSnapshot(context, payload.path);
  const replacementBytes = Buffer.from(payload.replacement, "utf8");
  const replacementSha256 = sha256Bytes(replacementBytes);
  await approve(context, request, replacementSha256);
  if (current.sha256 === replacementSha256) return { outcome: "applied", value: { path: payload.path, old_sha256: payload.expected_sha256, new_sha256: replacementSha256, already_applied: true, current } };
  if (current.sha256 !== payload.expected_sha256) return { outcome: "conflict", value: { path: payload.path, expected_sha256: payload.expected_sha256, actual_sha256: current.sha256 } };
  const temporary = join(dirname(admitted.full), `.praxis-${randomBytes(12).toString("hex")}.tmp`);
  try {
    const handle = await open(temporary, "wx", admitted.info.mode & 0o777);
    try { await handle.writeFile(replacementBytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, admitted.full);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
  const final = await readSnapshot(context, payload.path);
  if (final.sha256 !== replacementSha256) throw new Error("replacement_digest_mismatch");
  return { outcome: "applied", value: { path: payload.path, old_sha256: current.sha256, new_sha256: replacementSha256, already_applied: false, current: final } };
}

function reject(request, reason) { return { requestId: request?.requestId ?? "unknown", status: "rejected", payload: { reason } }; }
function failed(request, error) { return { requestId: request?.requestId ?? "unknown", status: "failed", payload: { reason: String(error?.message ?? error).slice(0, 256) } }; }
function ok(request, payload) { return { requestId: request.requestId, status: "ok", payload }; }

async function admissionReason(context, request) {
  if (!context || !request || typeof request.requestId !== "string") return "invalid_request";
  if (context.applicationId !== request.applicationId && request.applicationId !== undefined) return "application_mismatch";
  if (context.repository !== context.policy.repository || context.baseRevision !== context.policy.baseRevision) return "policy_context_mismatch";
  if (await realpath(context.workspaceRoot) !== context.workspaceRootReal) return "workspace_root_changed";
  if (!isAbsolute(context.temporaryHome) || !isAbsolute(context.approvalRoot)) return "private_paths_not_absolute";
  return null;
}

export async function preflight(context, request) {
  try { const reason = await admissionReason(context, request); return reason ? reject(request, reason) : ok(request, { admitted: true }); }
  catch (error) { return reject(request, String(error?.message ?? error)); }
}

export async function resolve(context, request) {
  const admitted = await preflight(context, request); if (admitted.status !== "ok") return admitted;
  try {
    context.workspaceAdapterInvocations = (context.workspaceAdapterInvocations ?? 0) + 1;
    if (request.payload.operation === "list") return ok(request, await listRepository(context));
    if (request.payload.operation === "read") return ok(request, await readSnapshot(context, request.payload.path));
    if (request.payload.operation === "search") return ok(request, await searchRepository(context, request.payload));
    if (request.payload.operation === "test") {
      if (request.payload.suite !== "full") return reject(request, "test_suite_not_admitted");
      context.testCount = (context.testCount ?? 0) + 1;
      return ok(request, await spawnCheck(context));
    }
    if (request.payload.operation === "replace") {
      const replacement = await replaceApproved(context, request);
      if (replacement.outcome === "applied" && !replacement.value.already_applied) {
        context.mutationCount = (context.mutationCount ?? 0) + 1;
        context.appliedPaths ??= [];
        context.appliedPaths.push(replacement.value.path);
      }
      return ok(request, replacement);
    }
    return reject(request, "operation_not_admitted");
  } catch (error) {
    context.lastWorkspaceFailure = String(error?.message ?? error).slice(0, 256);
    return failed(request, error);
  }
}

export async function recover(_context, effectRecord) {
  return effectRecord?.recordedResolution ? structuredClone(effectRecord.recordedResolution) : { status: "failed", payload: { reason: "recorded_resolution_required" } };
}

export const _workspaceInternals = { canonical, sha256Text, validatePathPrefix, readSnapshot, listRepository, searchRepository, spawnCheck };
