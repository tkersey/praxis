import { readFile } from "node:fs/promises";
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
