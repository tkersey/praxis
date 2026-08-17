# Praxis

Praxis applies the released Boundary → World → Agent stack to external software work.

Praxis v1 consumes Agent v2.5.0, whose typed pre-effect action-admission and
portable text-comparison seams resolve the preserved Agent v2.2.0 obstructions.
The repository-steward definition now enforces its mutation and final-result
invariants in the compiled Machine before an unauthorized effect can be emitted.

Run the complete non-live proof with the exact released dependency tuple:

```sh
bun run check
```

The check compiles the closed action algebra and working-set epistemics, runs
their invariant suite, closes the Machine into World Application ABI v1,
verifies the zero-import WASM artifact and native/WASM manifest identity, then
proves deterministic repository repair, lost-output retry, zero-fresh-effect
replay, and the declared measurement gates. It never contacts OpenAI and never
publishes.

Live execution is explicit and requires a frozen candidate, a receiver-authored
workspace policy, an exact base commit, an absolute Zig 0.16.0 executable, and
receiver-supplied `OPENAI_API_KEY` and `OPENAI_MODEL` values. The runner retains
raw runtime evidence under the caller's private `--store` and emits a redacted
receipt.

The original counterexamples and owner analyses remain preserved at
[`conformance/praxis-v1/obstructions/agent-pre-effect-admission/README.md`](conformance/praxis-v1/obstructions/agent-pre-effect-admission/README.md)
as historical evidence.
