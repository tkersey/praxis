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
const ignoredGeneratedDirectories = new Set([".git", ".ledger", ".praxis", ".zig-cache", "node_modules", "release", "zig-cache", "zig-out", "zig-pkg"]);
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

export async function createSourceManifestAt(root = repositoryRoot) {
  const listed = spawnSync("git", ["ls-files", "--stage", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (listed.error || listed.status !== 0) throw new Error("source manifest requires an exact Git checkout");
  const excluded = new Set(sourceManifestExcludedPaths);
  const entries = [];
  for (const record of listed.stdout.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Git source inventory is malformed");
    const [mode, , stage] = record.slice(0, separator).split(" ");
    const relative = record.slice(separator + 1);
    if (stage !== "0" || !["100644", "100755"].includes(mode)) throw new Error(`unsupported Git source entry: ${relative}`);
    if (!excluded.has(relative)) entries.push(await sourceEntry(root, relative, mode));
  }
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return { format: "praxis-source-manifest/v1", entries };
}

async function currentSourcePaths(root, excluded, relativeRoot = "") {
  const entries = (await readdir(path.join(root, ...relativeRoot.split("/").filter(Boolean)), { withFileTypes: true }))
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  const paths = [];
  for (const entry of entries) {
    const relative = relativeRoot === "" ? entry.name : `${relativeRoot}/${entry.name}`;
    if ((entry.isDirectory() && ignoredGeneratedDirectories.has(entry.name)) || (relativeRoot === "" && entry.name === ".git")) continue;
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
  if (manifest?.format !== "praxis-source-manifest/v1" || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(["entries", "format"])) throw new Error("source manifest format is invalid");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0 || manifest.entries.length > 1024) throw new Error("source manifest entry count is invalid");
  const excluded = new Set([...sourceManifestExcludedPaths, ...additionalExcludedPaths]);
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

export async function sourceCommitAt(root, candidatePath, manifestPath = path.join(root, ...sourceManifestRelative.split("/"))) {
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8" });
  if (!gitRoot.error && gitRoot.status === 0) {
    const [resolvedRoot, resolvedGitRoot] = await Promise.all([
      realpath(root),
      realpath(gitRoot.stdout.trim()).catch(() => null),
    ]);
    if (resolvedGitRoot === resolvedRoot) {
      const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
      if (!git.error && git.status === 0 && /^[0-9a-f]{40}\n?$/.test(git.stdout)) return git.stdout.trim();
    }
  }
  const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
  if (candidate?.format !== "praxis-candidate/v1" || !/^[0-9a-f]{40}$/.test(candidate.praxisCommit)) throw new Error("source candidate commit is unavailable");
  const relativeCandidate = path.relative(root, candidatePath).split(path.sep).join("/");
  const relativeManifest = path.relative(root, manifestPath).split(path.sep).join("/");
  await verifySourceManifestAt(root, manifestPath, candidate.sourceManifestSha256, [relativeCandidate, relativeManifest]);
  return candidate.praxisCommit;
}

export async function sourceCommit() {
  return sourceCommitAt(repositoryRoot, versionedCandidatePath);
}

export async function verifyCurrentSourceManifest() {
  const candidate = JSON.parse(await readFile(versionedCandidatePath, "utf8"));
  return verifySourceManifestAt(repositoryRoot, sourceManifestPath, candidate.sourceManifestSha256);
}
