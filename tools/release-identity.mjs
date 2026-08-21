import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

export const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const packageManifest = await readFile(path.join(repositoryRoot, "build.zig.zon"), "utf8");
const matches = [...packageManifest.matchAll(/\.version\s*=\s*"([0-9]+\.[0-9]+\.[0-9]+)"/g)];
if (matches.length !== 1) throw new Error("package version must occur exactly once");

export const releaseVersion = matches[0][1];
export const releasePrefix = `praxis-v${releaseVersion}`;
export const versionedConformanceRelative = `conformance/praxis-v${releaseVersion}`;
export const versionedConformanceRoot = path.join(repositoryRoot, versionedConformanceRelative);
export const versionedCandidatePath = path.join(versionedConformanceRoot, "candidate.json");
export const sourceManifestRelative = `${versionedConformanceRelative}/source-manifest.json`;
export const sourceManifestPath = path.join(repositoryRoot, sourceManifestRelative);
export const successorReleaseFormat = "praxis-successor-artifact-release/v1";
export const sourceManifestExcludedPaths = Object.freeze([
  sourceManifestRelative,
  `${versionedConformanceRelative}/candidate.json`,
  "conformance/praxis-v1/receipts/deterministic.json",
  "conformance/praxis-v1/receipts/measure.json",
  "conformance/praxis-v1/receipts/replay.json",
  "conformance/praxis-v1/receipts/retry.json",
]);
const ignoredGeneratedPaths = new Set([
  ".git", ".ledger", ".praxis", ".zig-cache", "node_modules", "release", "zig-cache", "zig-out", "zig-pkg",
  "conformance/praxis-v1/obstructions/agent-text-comparison/reproducer/.zig-cache",
  "conformance/praxis-v1/obstructions/agent-text-comparison/reproducer/zig-pkg",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const safeRelativePath = (value) => typeof value === "string"
  && value.length > 0
  && !value.includes("\\")
  && !value.includes("\0")
  && !path.posix.isAbsolute(value)
  && path.posix.normalize(value) === value
  && value !== ".."
  && !value.startsWith("../");

async function sourceEntry(root, relative, expectedMode = null) {
  if (!safeRelativePath(relative)) throw new Error(`source manifest path is invalid: ${relative}`);
  const absolute = path.join(root, ...relative.split("/"));
  const status = await lstat(absolute);
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`source manifest path is not an ordinary file: ${relative}`);
  const mode = (status.mode & 0o111) === 0 ? "100644" : "100755";
  if (expectedMode !== null && mode !== expectedMode) throw new Error(`source manifest mode mismatch: ${relative}`);
  return { path: relative, mode, sha256: sha256(await readFile(absolute)) };
}

function gitBytes(root, args, label) {
  const result = spawnSync("git", args, { cwd: root, encoding: null, maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${label} is unavailable`);
  return Buffer.from(result.stdout);
}

export function committedFileBytesAt(root, commit, relative) {
  if (!/^[0-9a-f]{40}$/.test(commit) || !safeRelativePath(relative)) throw new Error("committed source identity is invalid");
  return gitBytes(root, ["show", `${commit}:${relative}`], `committed source ${relative}`);
}

export async function createSourceManifestFromCommitAt(root, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("source manifest commit is invalid");
  const tree = spawnSync("git", ["ls-tree", "-rz", "--full-tree", commit], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (tree.error || tree.status !== 0) throw new Error("committed source tree is unavailable");
  const tracked = [];
  for (const record of tree.stdout.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("committed source tree is malformed");
    const [mode, type, oid] = record.slice(0, separator).split(" ");
    const relative = record.slice(separator + 1);
    if (type !== "blob" || !["100644", "100755"].includes(mode) || !/^[0-9a-f]{40}$/.test(oid)) throw new Error(`unsupported committed source entry: ${relative}`);
    tracked.push({ mode, oid, relative });
  }
  const archive = gitBytes(root, ["archive", "--format=tar", commit], "committed source archive");
  const inventory = spawnSync("tar", ["-tf", "-"], { cwd: root, input: archive, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (inventory.error || inventory.status !== 0) throw new Error("committed source archive inventory is unavailable");
  const archivedPaths = new Set(inventory.stdout.split("\n").filter((relative) => relative !== "" && !relative.endsWith("/")));
  const excluded = new Set(sourceManifestExcludedPaths);
  const exportIgnoredPaths = [];
  const entries = [];
  for (const { mode, oid, relative } of tracked) {
    if (!archivedPaths.has(relative)) exportIgnoredPaths.push(relative);
    else if (!excluded.has(relative)) entries.push({ path: relative, mode, sha256: sha256(gitBytes(root, ["cat-file", "blob", oid], `committed source blob ${relative}`)) });
  }
  exportIgnoredPaths.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return { format: "praxis-source-manifest/v1", export_ignored_paths: exportIgnoredPaths, entries };
}

export async function verifyCommittedSourceManifestAt(root, commit, expectedDigest) {
  const bytes = committedFileBytesAt(root, commit, sourceManifestRelative);
  if (sha256(bytes) !== expectedDigest) throw new Error("committed source manifest digest mismatch");
  const actual = JSON.parse(bytes);
  const expected = await createSourceManifestFromCommitAt(root, commit);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("committed source differs from its source manifest");
  return actual;
}

export async function createSourceManifestAt(root = repositoryRoot) {
  const listed = spawnSync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (listed.error || listed.status !== 0) throw new Error("source manifest requires an exact Git checkout");
  const excluded = new Set(sourceManifestExcludedPaths);
  const tracked = [];
  for (const record of listed.stdout.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Git source inventory is malformed");
    const [mode, , stage] = record.slice(0, separator).split(" ");
    const relative = record.slice(separator + 1);
    if (stage !== "0" || !["100644", "100755"].includes(mode)) throw new Error(`unsupported Git source entry: ${relative}`);
    tracked.push({ mode, relative });
  }
  const attributes = spawnSync("git", ["check-attr", "-z", "--stdin", "export-ignore"], {
    cwd: root,
    encoding: "utf8",
    input: `${tracked.map(({ relative }) => relative).join("\0")}\0`,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (attributes.error || attributes.status !== 0) throw new Error("Git export-ignore inventory is unavailable");
  const attributeFields = attributes.stdout.split("\0").filter((value, index, values) => value !== "" || index < values.length - 1);
  if (attributeFields.length !== tracked.length * 3) throw new Error("Git export-ignore inventory is malformed");
  const exportIgnoredPaths = [];
  const entries = [];
  for (let index = 0; index < tracked.length; index += 1) {
    const { mode, relative } = tracked[index];
    const [attributePath, attributeName, attributeValue] = attributeFields.slice(index * 3, index * 3 + 3);
    if (attributePath !== relative || attributeName !== "export-ignore") throw new Error("Git export-ignore inventory path mismatch");
    if (attributeValue !== "unspecified" && attributeValue !== "unset") exportIgnoredPaths.push(relative);
    else if (!excluded.has(relative)) entries.push(await sourceEntry(root, relative, mode));
  }
  exportIgnoredPaths.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return { format: "praxis-source-manifest/v1", export_ignored_paths: exportIgnoredPaths, entries };
}

async function currentSourcePaths(root, excluded, relativeRoot = "") {
  const entries = (await readdir(path.join(root, ...relativeRoot.split("/").filter(Boolean)), { withFileTypes: true }))
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  const paths = [];
  for (const entry of entries) {
    const relative = relativeRoot === "" ? entry.name : `${relativeRoot}/${entry.name}`;
    if ((entry.isDirectory() && ignoredGeneratedPaths.has(relative)) || (relativeRoot === "" && entry.name === ".git")) continue;
    if (excluded.has(relative)) continue;
    if (entry.isDirectory()) paths.push(...await currentSourcePaths(root, excluded, relative));
    else if (entry.isFile() && !entry.isSymbolicLink()) paths.push(relative);
    else throw new Error(`exported source path is not an ordinary file: ${relative}`);
  }
  return paths;
}

export async function verifySourceManifestAt(root, manifestPath, expectedDigest, additionalExcludedPaths = []) {
  if (!/^[0-9a-f]{64}$/.test(expectedDigest)) throw new Error("source manifest digest is unavailable");
  const bytes = await readFile(manifestPath);
  if (sha256(bytes) !== expectedDigest) throw new Error("source manifest digest mismatch");
  const manifest = JSON.parse(bytes);
  if (manifest?.format !== "praxis-source-manifest/v1" || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(["entries", "export_ignored_paths", "format"])) throw new Error("source manifest format is invalid");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0 || manifest.entries.length > 1024) throw new Error("source manifest entry count is invalid");
  if (!Array.isArray(manifest.export_ignored_paths) || manifest.export_ignored_paths.length > 128) throw new Error("source manifest export-ignore inventory is invalid");
  let previousIgnored = null;
  const fixedExcluded = new Set([...sourceManifestExcludedPaths, ...additionalExcludedPaths]);
  for (const relative of manifest.export_ignored_paths) {
    if (!safeRelativePath(relative) || (previousIgnored !== null && Buffer.from(previousIgnored).compare(Buffer.from(relative)) >= 0)) throw new Error("source manifest export-ignore paths are invalid");
    if (!fixedExcluded.has(relative)) {
      const status = await lstat(path.join(root, ...relative.split("/"))).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
      if (status !== null) throw new Error(`export-ignored source path is present: ${relative}`);
    }
    previousIgnored = relative;
  }
  const excluded = new Set([...fixedExcluded, ...manifest.export_ignored_paths]);
  const actual = [];
  let previous = null;
  for (const entry of manifest.entries) {
    if (!entry || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["mode", "path", "sha256"])) throw new Error("source manifest entry is malformed");
    if (!/^[0-9a-f]{64}$/.test(entry.sha256) || !["100644", "100755"].includes(entry.mode)) throw new Error(`source manifest entry is invalid: ${entry.path}`);
    if (previous !== null && Buffer.from(previous).compare(Buffer.from(entry.path)) >= 0) throw new Error("source manifest paths are not byte-sorted and unique");
    if (excluded.has(entry.path)) throw new Error(`source manifest includes an excluded path: ${entry.path}`);
    previous = entry.path;
    actual.push(await sourceEntry(root, entry.path, entry.mode));
  }
  const currentPaths = await currentSourcePaths(root, excluded);
  currentPaths.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (JSON.stringify(currentPaths) !== JSON.stringify(manifest.entries.map((entry) => entry.path))) throw new Error("exported source inventory differs from the candidate manifest");
  if (JSON.stringify(actual) !== JSON.stringify(manifest.entries)) throw new Error("exported source bytes differ from the candidate manifest");
  return manifest;
}

export async function verifyCheckoutSourceManifestAt(root, manifestPath = path.join(root, ...sourceManifestRelative.split("/"))) {
  const actual = JSON.parse(await readFile(manifestPath, "utf8"));
  const expected = await createSourceManifestAt(root);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("checkout source differs from the generated source manifest");
  return actual;
}

export async function sourceReceiptIdentityAt(root, candidatePath, manifestPath = path.join(root, ...sourceManifestRelative.split("/")), expectedManifestDigest = null) {
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  if (!gitRoot.error && gitRoot.status === 0) {
    const [resolvedRoot, resolvedGitRoot] = await Promise.all([
      realpath(root),
      realpath(gitRoot.stdout.trim()).catch(() => null),
    ]);
    if (resolvedGitRoot === resolvedRoot) {
      const allowedDirtyPaths = sourceManifestExcludedPaths.filter((relative) => relative !== sourceManifestRelative);
      const status = spawnSync("git", [
        "status", "--porcelain=v1", "--untracked-files=all", "--", ".",
        ...allowedDirtyPaths.map((relative) => `:(exclude)${relative}`),
      ], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (status.error || status.status !== 0 || status.stdout !== "") throw new Error("Git source identity requires a clean source tree");
      const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
      if (!git.error && git.status === 0 && /^[0-9a-f]{40}\n?$/.test(git.stdout)) {
        return { source_identity: "git-commit", candidate_commit: git.stdout.trim(), source_manifest_sha256: null };
      }
    }
  }
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  if (candidate?.format !== "praxis-candidate/v1") throw new Error("source candidate metadata is unavailable");
  if (!/^[0-9a-f]{64}$/.test(expectedManifestDigest ?? "")) throw new Error("authenticated source manifest digest is required for no-Git verification");
  if (candidate.sourceManifestSha256 !== expectedManifestDigest) throw new Error("candidate source manifest differs from the authenticated digest");
  const relativeCandidate = path.relative(root, candidatePath).split(path.sep).join("/");
  const relativeManifest = path.relative(root, manifestPath).split(path.sep).join("/");
  await verifySourceManifestAt(root, manifestPath, expectedManifestDigest, [relativeCandidate, relativeManifest]);
  return { source_identity: "export-manifest", candidate_commit: null, source_manifest_sha256: sha256(await readFile(manifestPath)) };
}

export async function sourceReceiptIdentity() {
  return sourceReceiptIdentityAt(repositoryRoot, versionedCandidatePath, sourceManifestPath, process.env.PRAXIS_SOURCE_MANIFEST_SHA256 ?? null);
}

export async function verifyCurrentSourceManifest() {
  const candidate = JSON.parse(await readFile(versionedCandidatePath, "utf8"));
  const bytes = await readFile(sourceManifestPath);
  if (sha256(bytes) !== candidate.sourceManifestSha256) throw new Error("source manifest digest mismatch");
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: repositoryRoot, encoding: "utf8" });
  const resolvedGitRoot = !gitRoot.error && gitRoot.status === 0 ? await realpath(gitRoot.stdout.trim()).catch(() => null) : null;
  if (resolvedGitRoot === await realpath(repositoryRoot)) return verifyCheckoutSourceManifestAt(repositoryRoot, sourceManifestPath);
  const expectedManifestDigest = process.env.PRAXIS_SOURCE_MANIFEST_SHA256 ?? null;
  if (!/^[0-9a-f]{64}$/.test(expectedManifestDigest ?? "") || candidate.sourceManifestSha256 !== expectedManifestDigest) throw new Error("authenticated source manifest digest is required for no-Git verification");
  return verifySourceManifestAt(repositoryRoot, sourceManifestPath, expectedManifestDigest);
}

export async function verifyCheckoutSourceManifest() {
  return verifyCheckoutSourceManifestAt(repositoryRoot, sourceManifestPath);
}

export async function verifyCommittedSourceManifest(commit, expectedDigest) {
  return verifyCommittedSourceManifestAt(repositoryRoot, commit, expectedDigest);
}
