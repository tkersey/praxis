# Praxis

Praxis applies the released Boundary → World → Agent stack to external software work.

Praxis v1 is currently stopped by a preserved Agent v2.2.0 obstruction: a custom
epistemic strategy can reject a terminal result, but cannot reject an effect action
before the compiler emits that effect. The executable counterexample reaches a
replacement request while Memory says no baseline test has been observed.

Run the counterexample with the exact released dependency:

```sh
zig build check --summary all
```

The counterexample neither invokes a repository capability nor writes a file. See
[`conformance/praxis-v1/obstructions/agent-pre-effect-admission/README.md`](conformance/praxis-v1/obstructions/agent-pre-effect-admission/README.md)
for the owner analysis and smallest required upstream semantic change.
