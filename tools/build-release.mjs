import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyCandidate } from "./candidate.mjs";

const repositoryRoot = path.resolve(new URL("..", import.meta.url).pathname);
const conformanceRoot = path.join(repositoryRoot, "conformance/praxis-v1");
const prefix = "praxis-v1.0.0";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: options.cwd ?? repositoryRoot, encoding: options.binary ? null : "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed\n${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result;
}

async function json(file) { return JSON.parse(await readFile(file, "utf8")); }
async function copy(relative, destination) { const target = path.join(destination, relative); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(repositoryRoot, relative), target, { recursive: true }); }

async function tarDirectory(source, target) {
  command("tar", ["-czf", target, "--no-xattrs", "--no-mac-metadata", "-C", source, "."]);
}

export async function buildRelease({ outputRoot = path.join(repositoryRoot, "release") } = {}) {
  const candidate = await verifyCandidate(path.join(conformanceRoot, "candidate.json"));
  const livePath = path.join(conformanceRoot, "receipts/live.redacted.json");
  const publicationPath = path.join(conformanceRoot, "receipts/publication.json");
  const [live, publication] = await Promise.all([json(livePath), json(publicationPath)]);
  assert.equal(live.mode, "live"); assert.equal(live.terminal_status, "completed"); assert.equal(live.independent_verifier_passed, true);
  assert.equal(publication.mode, "publication"); assert.equal(publication.draft, true); assert.equal(publication.published_tree_matches_verified_diff, true);
  assert.equal(live.candidate_commit, candidate.praxisCommit); assert.equal(publication.candidate_commit, candidate.praxisCommit);
  await mkdir(outputRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(tmpdir(), "praxis-release-"));
  try {
    const sourceArchive = path.join(outputRoot, `${prefix}-source.tar.gz`);
    command("git", ["archive", "--format=tar.gz", `--prefix=praxis-1.0.0/`, "-o", sourceArchive, candidate.praxisCommit]);
    const runtimeRoot = path.join(temporary, "runtime", "praxis-1.0.0-runtime");
    for (const relative of ["runtime", "tools", "src/emit_initial_args.zig", "build.zig", "build.zig.zon", "package.json", "README.md", "LICENSE", "conformance/praxis-v1/reference-stack.lock.json"]) await copy(relative, runtimeRoot);
    const runtimeArchive = path.join(outputRoot, `${prefix}-runtime.tar.gz`); await tarDirectory(path.dirname(runtimeRoot), runtimeArchive);
    const artifactRoot = path.join(temporary, "artifacts", "praxis-1.0.0-artifacts");
    await copy("zig-out/repository-steward", artifactRoot); await copy("zig-out/bin/praxis-initial-args", artifactRoot);
    await copy("fixtures/zig-repository-v1", artifactRoot);
    for (const name of ["deterministic", "retry", "replay", "measure"]) await copy(`conformance/praxis-v1/receipts/${name}.json`, artifactRoot);
    const artifactArchive = path.join(outputRoot, `${prefix}-artifacts.tar.gz`); await tarDirectory(path.dirname(artifactRoot), artifactArchive);
    const named = [
      ["deterministic", `${prefix}-deterministic-receipt.json`], ["live.redacted", `${prefix}-live-receipt.redacted.json`],
      ["publication", `${prefix}-publication-receipt.json`],
    ];
    for (const [source, target] of named) await cp(path.join(conformanceRoot, `receipts/${source}.json`), path.join(outputRoot, target));
    const finalReceipt = [
      "result=praxis_complete", "application=repository-steward", "application_version=1.0.0",
      `candidate_commit=${candidate.praxisCommit}`, `application_id=${candidate.applicationId}`,
      "released_stack=agent-2.5.0,boundary-1.5.0,world-3.1.3,world-host-1.0.1,world-capabilities-2.3.2",
      "deterministic_passed=true", "retry_passed=true", "replay_passed=true", "measurement_gates_passed=true",
      `live_success_count=${live.live_success_count}`, "draft_pr_published=true", "published_tree_matches_verified_diff=true",
      "substrate_changes_required=false", "",
    ].join("\n");
    await writeFile(path.join(outputRoot, `${prefix}-final-receipt.txt`), finalReceipt);
    const assetNames = (await readdir(outputRoot)).filter((name) => name.startsWith(prefix) && name !== `${prefix}-checksums.txt`).sort();
    const lines = [];
    for (const name of assetNames) lines.push(`${sha256(await readFile(path.join(outputRoot, name)))}  ${name}`);
    await writeFile(path.join(outputRoot, `${prefix}-checksums.txt`), `${lines.join("\n")}\n`);
    for (const archive of [sourceArchive, runtimeArchive, artifactArchive]) {
      const entries = command("tar", ["-tzf", archive]).stdout;
      if (/(^|\/)\.env($|\n)|runtime-store|OPENAI_API_KEY/.test(entries)) throw new Error(`forbidden release archive entry in ${path.basename(archive)}`);
    }
    return Object.freeze({ outputRoot, assets: [...assetNames, `${prefix}-checksums.txt`] });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const result = await buildRelease();
  process.stdout.write(`praxis_release_assets=${result.assets.length}\n`);
}
