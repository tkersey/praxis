import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";

const lockPath = new URL("../conformance/praxis-v1/reference-stack.lock.json", import.meta.url);
const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
const maximumExpandedBytes = 512 * 1024 * 1024;
const maximumEntries = 100_000;

function parseArgs(argv) {
  const result = { offline: false, destination: path.resolve(".praxis/reference-stack"), archives: {} };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]; const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    if (flag === "--offline") {
      if (value !== "true" && value !== "false") throw new Error("--offline must be true or false");
      result.offline = value === "true";
    } else if (flag === "--destination") result.destination = path.resolve(value);
    else if (flag.startsWith("--archive-")) result.archives[flag.slice("--archive-".length)] = path.resolve(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  return result;
}

async function sha256(filePath) {
  const digest = createHash("sha256");
  await pipeline(fs.createReadStream(filePath), digest);
  return digest.digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "praxis-reference-stack/v1" } });
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status}) for ${url}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination, { flags: "wx", mode: 0o600 }));
}

function tar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function validateArchive(archivePath, expectedRoot) {
  const listing = tar(["-tzf", archivePath]);
  const names = listing.split("\n").filter(Boolean);
  if (names.length === 0 || names.length > maximumEntries) throw new Error("archive entry count is outside Praxis bounds");
  const seen = new Set();
  for (const rawName of names) {
    if (/[^\x20-\x7e]/.test(rawName)) throw new Error("archive contains a control or non-ASCII path");
    const name = rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
    if (!name || path.posix.isAbsolute(name) || name.includes("\\")) throw new Error(`inadmissible archive path: ${rawName}`);
    const segments = name.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw new Error(`non-normal archive path: ${rawName}`);
    if (segments[0] !== expectedRoot) throw new Error(`unexpected archive root: ${rawName}`);
    if (seen.has(name)) throw new Error(`duplicate archive entry: ${rawName}`);
    seen.add(name);
  }

  let expandedBytes = 0;
  const verbose = tar(["-tvzf", archivePath]).split("\n").filter(Boolean);
  assert.equal(verbose.length, names.length, "tar listings disagree");
  for (const line of verbose) {
    const type = line[0];
    if (type !== "-" && type !== "d") throw new Error(`archive links or special entries are forbidden: ${line}`);
    const match = line.match(/^\S+\s+\d+\s+\S+\s+\S+\s+(\d+)\s+/);
    if (!match) throw new Error(`unable to validate archive expansion: ${line}`);
    expandedBytes += Number(match[1]);
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > maximumExpandedBytes) throw new Error("archive expansion exceeds Praxis bound");
  }
  return { entries: names.length, expandedBytes };
}

async function verifyExtractedTree(root) {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`inadmissible extracted entry: ${current}`);
    if (stat.isDirectory()) {
      for (const name of await fsp.readdir(current)) stack.push(path.join(current, name));
    }
  }
}

async function acquire(name, descriptor, options) {
  const archiveDirectory = path.join(options.destination, "archives");
  const extractDirectory = path.join(options.destination, "extracted", name);
  await fsp.mkdir(archiveDirectory, { recursive: true, mode: 0o700 });
  let archivePath = options.archives[name];
  if (options.offline) {
    if (!archivePath) throw new Error(`offline mode requires --archive-${name} PATH`);
  } else {
    if (archivePath) throw new Error(`--archive-${name} is only admitted in offline mode`);
    archivePath = path.join(archiveDirectory, `${name}.tar.gz`);
    await fsp.rm(archivePath, { force: true });
    await download(descriptor.url, archivePath);
  }
  const actualDigest = await sha256(archivePath);
  if (actualDigest !== descriptor.sha256) throw new Error(`${name} SHA-256 mismatch`);
  const shape = validateArchive(archivePath, descriptor.root);
  await fsp.rm(extractDirectory, { recursive: true, force: true });
  await fsp.mkdir(extractDirectory, { recursive: true, mode: 0o700 });
  tar(["-xzf", archivePath, "-C", extractDirectory, "--no-same-owner", "--no-same-permissions"]);
  const extractedRoot = path.join(extractDirectory, descriptor.root);
  const children = await fsp.readdir(extractDirectory);
  assert.deepEqual(children, [descriptor.root], `${name} extraction has unexpected roots`);
  await verifyExtractedTree(extractedRoot);
  return { archive: path.resolve(archivePath), root: path.resolve(extractedRoot), ...shape };
}

const options = parseArgs(process.argv.slice(2));
await fsp.mkdir(options.destination, { recursive: true, mode: 0o700 });
const roots = {};
for (const [name, descriptor] of Object.entries(lock.archives)) roots[name] = await acquire(name, descriptor, options);
process.stdout.write(`${JSON.stringify({ format: "praxis-reference-stack-result/v1", tuple: lock.tuple, roots }, null, 2)}\n`);
