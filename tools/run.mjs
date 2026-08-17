const args = process.argv.slice(2);
const modeIndex = args.indexOf("--mode");
if (modeIndex < 0 || !args[modeIndex + 1]) throw new Error("--mode is required");
const mode = args[modeIndex + 1]; const rest = [...args.slice(0, modeIndex), ...args.slice(modeIndex + 2)];
if (rest.length % 2 !== 0) throw new Error("Praxis options require flag/value pairs");
const options = {};
for (let index = 0; index < rest.length; index += 2) {
  const flag = rest[index]; const value = rest[index + 1];
  if (flag === "--zig") options.zigExecutable = value;
  else if (flag === "--run-id") options.runId = value;
  else if (flag === "--receipt") options.receipt = value;
  else throw new Error(`unsupported ${mode} option: ${flag}`);
}
if (mode === "deterministic") {
  const { runDeterministic } = await import("./deterministic.mjs");
  await runDeterministic(options);
  process.stdout.write("praxis_deterministic=true\n");
} else if (mode === "retry" || mode === "replay") {
  const { runLifecycle } = await import("./lifecycle.mjs");
  await runLifecycle(mode, options);
  process.stdout.write(`praxis_${mode}=true\n`);
} else if (mode === "measure") {
  const { proveMeasurements } = await import("./measure.mjs");
  await proveMeasurements(options);
  process.stdout.write("praxis_measure=true\n");
} else throw new Error(`unsupported Praxis mode: ${mode}`);
