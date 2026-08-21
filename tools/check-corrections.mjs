import { spawnSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot, versionedConformanceRoot } from "./release-identity.mjs";

const obstructionsRoot = path.join(versionedConformanceRoot, "obstructions");

export async function correctionVerifierPaths(root) {
  const entries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const verifiers = [];
  for (const name of entries) {
    const verifier = path.join(root, name, "reproducer/verify.mjs");
    const status = await lstat(verifier).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (status === null) throw new Error(`correction verifier is missing: ${name}`);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error(`correction verifier is not an ordinary file: ${name}`);
    verifiers.push({ name, verifier });
  }
  return verifiers;
}

export async function verifyCorrections() {
  const verifiers = await correctionVerifierPaths(obstructionsRoot);
  if (verifiers.length === 0) throw new Error("no versioned correction verifier was found");
  for (const { name, verifier } of verifiers) {
    const child = spawnSync(process.execPath, [verifier], { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
    if (child.error || child.status !== 0) throw new Error(`${name} correction verification failed\n${child.stdout ?? ""}${child.stderr ?? ""}`);
  }
  return verifiers.length;
}

if (import.meta.main) {
  const verified = await verifyCorrections();
  process.stdout.write(`praxis_correction_verifiers=${verified}\n`);
}
