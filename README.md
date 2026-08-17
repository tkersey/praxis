# Praxis

Praxis applies the released Boundary → World → Agent stack to external software work.

Praxis v1 consumes Agent v2.5.0, whose typed pre-effect action-admission and
portable text-comparison seams resolve the preserved Agent v2.2.0 obstructions.
The repository-steward definition now enforces its mutation and final-result
invariants in the compiled Machine before an unauthorized effect can be emitted.

Run the current regression proof with the exact released dependency:

```sh
zig build check --summary all
```

The current check compiles the closed action algebra and working-set epistemics,
runs their invariant suite, closes the Machine into World Application ABI v1,
and verifies the zero-import WASM artifact and native/WASM manifest identity.
It neither invokes a repository capability nor writes a repository file. The
original counterexamples and owner analyses remain preserved at
[`conformance/praxis-v1/obstructions/agent-pre-effect-admission/README.md`](conformance/praxis-v1/obstructions/agent-pre-effect-admission/README.md)
as historical evidence.
