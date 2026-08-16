import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const run = spawnSync("zig", ["build", "--summary", "all"], {
  cwd: root,
  encoding: "utf8",
});
const diagnostics = `${run.stdout}\n${run.stderr}`;
assert.notEqual(run.status, 0, "the locked Agent release unexpectedly exposed text comparison");
assert.match(diagnostics, /no field or member function named 'textCompare'/);
assert.match(diagnostics, /agent-2\.3\.0-/);
console.log("praxis_agent_text_comparison_obstruction=true");
