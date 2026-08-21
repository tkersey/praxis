import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  const result = spawnSync(executable, args, { cwd: options.cwd ?? repositoryRoot, encoding: options.binary ? null : "utf8", maxBuffer: 128 * 1024 * 1024, env: options.env ?? process.env, input: options.input });
  if (result.error || result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed\n${result.error ?? ""}${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result;
}

async function copy(relative, destination) { const target = path.join(destination, relative); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(repositoryRoot, relative), target, { recursive: true }); }

function tarOctal(value, width) {
  const encoded = value.toString(8);
  if (encoded.length > width - 1) throw new Error("USTAR numeric value exceeds field capacity");
  return `${encoded.padStart(width - 1, "0")}\0`;
}

function splitTarPath(name) {
  if (!/^[ -~]+$/.test(name) || Buffer.byteLength(name) > 256) throw new Error("deterministic USTAR path is invalid");
  if (Buffer.byteLength(name) <= 100) return { name, prefix: "" };
  for (let separator = name.lastIndexOf("/"); separator > 0; separator = name.lastIndexOf("/", separator - 1)) {
    const prefix = name.slice(0, separator); const suffix = name.slice(separator + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) return { name: suffix, prefix };
  }
  throw new Error("deterministic USTAR path cannot be represented");
}

function appendTarFile(archive, name, contents, mode = 0o644) {
  const tarPath = splitTarPath(name);
  if (!Buffer.isBuffer(archive) || !Buffer.isBuffer(contents) || ![0o644, 0o755].includes(mode)) throw new Error("deterministic USTAR entry is invalid");
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    if ((header[124] & 0x80) !== 0) throw new Error("base-256 TAR sizes are unsupported");
    const encodedSize = header.subarray(124, 136).toString("ascii").split("\0", 1)[0].trim();
    const size = encodedSize === "" ? 0 : Number.parseInt(encodedSize, 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("TAR entry size is invalid");
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const header = Buffer.alloc(512);
  header.write(tarPath.name, 0, 100, "ascii");
  header.write(tarOctal(mode, 8), 100, 8, "ascii");
  header.write(tarOctal(0, 8), 108, 8, "ascii");
  header.write(tarOctal(0, 8), 116, 8, "ascii");
  header.write(tarOctal(contents.length, 12), 124, 12, "ascii");
  header.write(tarOctal(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(tarPath.prefix, 345, 155, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([archive.subarray(0, offset), header, contents, padding, Buffer.alloc(1024)]);
}

async function deterministicDirectoryFiles(root, relative = "") {
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  const files = [];
  for (const entry of entries) {
    const child = relative === "" ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await deterministicDirectoryFiles(root, child));
    else if (entry.isFile() && !entry.isSymbolicLink()) files.push(child);
    else throw new Error(`release archive entry is not an ordinary file: ${child}`);
  }
  return files;
}

async function tarDirectory(root, target) {
  let archive = Buffer.alloc(1024);
  const prefix = path.basename(root);
  for (const relative of await deterministicDirectoryFiles(root)) {
    const absolute = path.join(root, ...relative.split("/"));
    const mode = ((await stat(absolute)).mode & 0o111) === 0 ? 0o644 : 0o755;
    archive = appendTarFile(archive, `${prefix}/${relative}`, await readFile(absolute), mode);
  }
  const compressed = command("gzip", ["-n", "-c"], { binary: true, input: archive }).stdout;
  await writeFile(target, compressed);
}

function validateReleaseAssetInventory(directoryEntries, expectedAssetNames) {
  const checksumsName = `${prefix}-checksums.txt`;
  const expected = new Set([...expectedAssetNames, checksumsName]);
  const matching = directoryEntries.filter((name) => name.startsWith(prefix));
  const missing = expectedAssetNames.filter((name) => !matching.includes(name)).sort();
  const unexpected = matching.filter((name) => !expected.has(name)).sort();
  if (missing.length > 0) throw new Error(`missing release assets: ${missing.join(", ")}`);
  if (unexpected.length > 0) throw new Error(`unexpected release assets: ${unexpected.join(", ")}`);
  return [...expectedAssetNames].sort();
}

export const _releaseInternals = Object.freeze({ appendTarFile, validateReleaseAssetInventory });

export async function buildRelease({ outputRoot = path.join(repositoryRoot, "release") } = {}) {
  if (command("git", ["status", "--porcelain=v1", "--untracked-files=all"]).stdout !== "") throw new Error("successor release build requires a clean worktree");
  command(process.execPath, ["tools/check-corrections.mjs"], { env: { ...process.env, PRAXIS_REQUIRE_HISTORICAL_GIT: "1" } });
  const candidate = await verifyCandidate(versionedCandidatePath);
  await mkdir(outputRoot, { recursive: true });
  const temporary = await mkdtemp(path.join(tmpdir(), "praxis-release-"));
  try {
    const sourceArchive = path.join(outputRoot, `${prefix}-source.tar.gz`);
    const sourceTar = path.join(temporary, "source.tar");
    command("git", ["archive", "--format=tar", `--prefix=praxis-${releaseVersion}/`, "-o", sourceTar, candidate.praxisCommit]);
    const candidateEntry = `praxis-${releaseVersion}/${versionedConformanceRelative}/candidate.json`;
    await writeFile(sourceTar, appendTarFile(await readFile(sourceTar), candidateEntry, await readFile(versionedCandidatePath)));
    const compressedSource = command("gzip", ["-n", "-c", sourceTar], { binary: true }).stdout;
    await writeFile(sourceArchive, compressedSource);
    const runtimeRoot = path.join(temporary, "runtime", `praxis-${releaseVersion}-runtime`);
    for (const relative of ["runtime", "tools", "src/emit_initial_args.zig", "build.zig", "build.zig.zon", "package.json", "README.md", "LICENSE", "conformance/praxis-v1/reference-stack.lock.json"]) await copy(relative, runtimeRoot);
    const runtimeArchive = path.join(outputRoot, `${prefix}-runtime.tar.gz`); await tarDirectory(runtimeRoot, runtimeArchive);
    const artifactRoot = path.join(temporary, "artifacts", `praxis-${releaseVersion}-artifacts`);
    await copy("zig-out/repository-steward", artifactRoot); await copy("zig-out/bin/praxis-initial-args", artifactRoot);
    await copy("fixtures/zig-repository-v1", artifactRoot);
    for (const name of ["deterministic", "retry", "replay", "measure"]) await copy(`conformance/praxis-v1/receipts/${name}.json`, artifactRoot);
    await cp(versionedCandidatePath, path.join(artifactRoot, "candidate.json"));
    await copy(versionedConformanceRelative, artifactRoot);
    const artifactArchive = path.join(outputRoot, `${prefix}-artifacts.tar.gz`); await tarDirectory(artifactRoot, artifactArchive);
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
    const assetNames = validateReleaseAssetInventory(await readdir(outputRoot), [
      path.basename(sourceArchive),
      path.basename(runtimeArchive),
      path.basename(artifactArchive),
      `${prefix}-candidate.json`,
      `${prefix}-successor-receipt.json`,
    ]);
    const lines = [];
    for (const name of assetNames) lines.push(`${sha256(await readFile(path.join(outputRoot, name)))}  ${name}`);
    await writeFile(path.join(outputRoot, `${prefix}-checksums.txt`), `${lines.join("\n")}\n`);
    for (const archive of [sourceArchive, runtimeArchive, artifactArchive]) {
      const entries = command("tar", ["-tzf", archive]).stdout;
      if (/(^|\/)\.env($|\n)|runtime-store|OPENAI_API_KEY/.test(entries)) throw new Error(`forbidden release archive entry in ${path.basename(archive)}`);
      if (archive === sourceArchive) {
        const candidateEntries = entries.split("\n").filter((entry) => entry.endsWith("/candidate.json"));
        if (candidateEntries.filter((entry) => entry === candidateEntry).length !== 1) throw new Error("source archive candidate inventory mismatch");
        const archivedCandidate = command("tar", ["-xOzf", sourceArchive, candidateEntry], { binary: true }).stdout;
        if (!Buffer.from(archivedCandidate).equals(await readFile(versionedCandidatePath))) throw new Error("source archive candidate bytes mismatch");
      }
    }
    return Object.freeze({ format: successorReleaseFormat, outputRoot, assets: [...assetNames, `${prefix}-checksums.txt`] });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const result = await buildRelease();
  process.stdout.write(`praxis_successor_release_assets=${result.assets.length}\n`);
}
