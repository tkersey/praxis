import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createSourceManifestAt,
  repositoryRoot,
  sourceManifestPath,
  verifyCurrentSourceManifest,
} from "./release-identity.mjs";

const mode = process.argv[2] ?? "--verify";
if (mode === "--verify") {
  const manifest = await verifyCurrentSourceManifest();
  process.stdout.write(`praxis_source_manifest_entries=${manifest.entries.length}\n`);
} else if (mode === "--emit") {
  const output = path.resolve(process.argv[3] ?? sourceManifestPath);
  const manifest = await createSourceManifestAt(repositoryRoot);
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`praxis_source_manifest_entries=${manifest.entries.length}\n`);
} else {
  throw new Error(`unsupported source manifest mode: ${mode}`);
}
