const args = process.argv.slice(2);
const modeIndex = args.indexOf("--mode");
if (modeIndex < 0 || !args[modeIndex + 1]) throw new Error("--mode is required");
const mode = args[modeIndex + 1]; const rest = [...args.slice(0, modeIndex), ...args.slice(modeIndex + 2)];
if (mode === "deterministic") {
  const { runDeterministic } = await import("./deterministic.mjs");
  await runDeterministic(Object.fromEntries(Array.from({ length: rest.length / 2 }, (_, index) => [rest[index * 2].replace(/^--/, ""), rest[index * 2 + 1]])));
  process.stdout.write("praxis_deterministic=true\n");
} else throw new Error(`unsupported Praxis mode: ${mode}`);
