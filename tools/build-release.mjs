import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyCandidate } from "./candidate.mjs";
import {
  releasePrefix,
  releaseVersion,
  repositoryRoot,
  successorReleaseFormat,
  versionedCandidatePath,
  versionedConformanceRelative,
} from "./release-identity.mjs";

const conformanceRoot = path.join(repositoryRoot, "conformance/praxis-v1");
export { releaseVersion, successorReleaseFormat, versionedCandidatePath as releaseCandidatePath };
const prefix = releasePrefix;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: options.cwd ?? repositoryRoot, encoding: options.binary ? null : "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed\n${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result;
}

async function copy(relative, destination) { const target = path.join(destination, relative); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(repositoryRoot, relative), target, { recursive: true }); }

async function tarDirectory(source, target) {
  command("tar", ["-czf", target, "--no-xattrs", "--no-mac-metadata", "-C", source, "."]);
}

export async function buildRelease({ outputRoot = path.join(repositoryRoot, "release") } = {}) {
  const candidate = await verifyCandidate(versionedCandidatePath);
  await mkdir(outputRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(tmpdir(), "praxis-release-"));
  try {
    const sourceArchive = path.join(outputRoot, `${prefix}-source.tar.gz`);
    command("git", ["archive", "--format=tar.gz", `--prefix=praxis-${releaseVersion}/`, "-o", sourceArchive, candidate.praxisCommit]);
    const runtimeRoot = path.join(temporary, "runtime", `praxis-${releaseVersion}-runtime`);
    for (const relative of ["runtime", "tools", "src/emit_initial_args.zig", "build.zig", "build.zig.zon", "package.json", "README.md", "LICENSE", "conformance/praxis-v1/reference-stack.lock.json"]) await copy(relative, runtimeRoot);
    const runtimeArchive = path.join(outputRoot, `${prefix}-runtime.tar.gz`); await tarDirectory(path.dirname(runtimeRoot), runtimeArchive);
    const artifactRoot = path.join(temporary, "artifacts", `praxis-${releaseVersion}-artifacts`);
    await copy("zig-out/repository-steward", artifactRoot); await copy("zig-out/bin/praxis-initial-args", artifactRoot);
    await copy("fixtures/zig-repository-v1", artifactRoot);
    for (const name of ["deterministic", "retry", "replay", "measure"]) await copy(`conformance/praxis-v1/receipts/${name}.json`, artifactRoot);
    await cp(versionedCandidatePath, path.join(artifactRoot, "candidate.json"));
    await copy(versionedConformanceRelative, artifactRoot);
    const artifactArchive = path.join(outputRoot, `${prefix}-artifacts.tar.gz`); await tarDirectory(path.dirname(artifactRoot), artifactArchive);
    await cp(versionedCandidatePath, path.join(outputRoot, `${prefix}-candidate.json`));
    const successorReceipt = {
      format: successorReleaseFormat,
      release: `v${releaseVersion}`,
      proof_scope: "application-artifacts-and-lifecycle",
      candidate_commit: candidate.praxisCommit,
      application_id: candidate.applicationId,
      application_wasm_sha256: candidate.applicationWasmSha256,
      decision_contract_digest: candidate.decisionContractDigest,
      deterministic_receipt_sha256: candidate.deterministicReceiptSha256,
      retry_receipt_sha256: candidate.retryReceiptSha256,
      replay_receipt_sha256: candidate.replayReceiptSha256,
      measure_receipt_sha256: candidate.measureReceiptSha256,
      live_execution_claimed: false,
      publication_claimed: false,
    };
    await writeFile(path.join(outputRoot, `${prefix}-successor-receipt.json`), `${JSON.stringify(successorReceipt, null, 2)}\n`);
    const assetNames = (await readdir(outputRoot)).filter((name) => name.startsWith(prefix) && name !== `${prefix}-checksums.txt`).sort();
    const lines = [];
    for (const name of assetNames) lines.push(`${sha256(await readFile(path.join(outputRoot, name)))}  ${name}`);
    await writeFile(path.join(outputRoot, `${prefix}-checksums.txt`), `${lines.join("\n")}\n`);
    for (const archive of [sourceArchive, runtimeArchive, artifactArchive]) {
      const entries = command("tar", ["-tzf", archive]).stdout;
      if (/(^|\/)\.env($|\n)|runtime-store|OPENAI_API_KEY/.test(entries)) throw new Error(`forbidden release archive entry in ${path.basename(archive)}`);
      if (archive === sourceArchive && /\/conformance\/praxis-v[^/]*\/candidate\.json(?:\n|$)/.test(entries)) throw new Error("source archive contains a self-freezing candidate record");
    }
    return Object.freeze({ format: successorReleaseFormat, outputRoot, assets: [...assetNames, `${prefix}-checksums.txt`] });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const result = await buildRelease();
  process.stdout.write(`praxis_successor_release_assets=${result.assets.length}\n`);
}
