import { readFile } from "node:fs/promises";
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
export const successorReleaseFormat = "praxis-successor-artifact-release/v1";

export async function sourceCommit() {
  const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  if (!git.error && git.status === 0 && /^[0-9a-f]{40}\n?$/.test(git.stdout)) return git.stdout.trim();
  const candidate = JSON.parse(await readFile(versionedCandidatePath, "utf8"));
  if (candidate?.format !== "praxis-candidate/v1" || !/^[0-9a-f]{40}$/.test(candidate.praxisCommit)) throw new Error("source candidate commit is unavailable");
  return candidate.praxisCommit;
}
