import { spawnSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { repositoryRoot, versionedConformanceRoot } from "./release-identity.mjs";

const obstructionsRoot = path.join(versionedConformanceRoot, "obstructions");
const entries = (await readdir(obstructionsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
let verified = 0;
for (const name of entries) {
  const verifier = path.join(obstructionsRoot, name, "reproducer/verify.mjs");
  const status = await lstat(verifier).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (status === null) continue;
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`correction verifier is not an ordinary file: ${name}`);
  const child = spawnSync(process.execPath, [verifier], { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  if (child.error || child.status !== 0) throw new Error(`${name} correction verification failed\n${child.stdout ?? ""}${child.stderr ?? ""}`);
  verified += 1;
}
if (verified === 0) throw new Error("no versioned correction verifier was found");
process.stdout.write(`praxis_correction_verifiers=${verified}\n`);
