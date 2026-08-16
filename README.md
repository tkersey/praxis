# Praxis

Praxis applies the released Boundary → World → Agent stack to external software work.

Praxis v1 now consumes Agent v2.3.0, whose typed pre-effect action-admission
seam resolves the preserved Agent v2.2.0 obstruction. The executable regression
witness proves that a replacement is rejected before an effect request when
Memory says no baseline test has been observed.

Run the current regression proof with the exact released dependency:

```sh
zig build check --summary all
```

The regression proof neither invokes a repository capability nor writes a file.
The original counterexample and owner analysis remain preserved at
[`conformance/praxis-v1/obstructions/agent-pre-effect-admission/README.md`](conformance/praxis-v1/obstructions/agent-pre-effect-admission/README.md)
as historical evidence.

Full Memory admission is now stopped at the next preserved owner-specific
obstruction: Agent Flow does not expose Boundary's existing `text_compare`
operation, so the application cannot compare exact `Path` and digest values.
See
[`conformance/praxis-v1/obstructions/agent-text-comparison/README.md`](conformance/praxis-v1/obstructions/agent-text-comparison/README.md).
