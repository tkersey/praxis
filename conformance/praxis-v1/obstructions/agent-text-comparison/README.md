# Agent text-comparison obstruction

## Result

`praxis_obstruction`

## Exact tuple

The reproducer uses Zig 0.16.0 and the exact public Agent v2.3.0 package:

```text
Agent              v2.3.0
Boundary           v1.5.0
Machine ABI        2
Machine state      ABL_RNF2
```

Run it with:

```sh
node conformance/praxis-v1/obstructions/agent-text-comparison/reproducer/verify.mjs
```

The verifier requires compilation to fail because Agent's public `Flow` has no
`textCompare` member.

## Required Praxis law

Praxis must admit `replace_file` only when Memory contains the latest
`DocumentSnapshot` for the exact requested `Path` and its exact digest. Final
admission must likewise compare the result's changed paths with the unique
paths retained in Memory. `Path` and `DigestHex` are fixed `boundary.Text`
types.

Agent v2.3.0 now supplies the required typed pre-effect action-admission hook,
but its public Flow authoring surface exposes integer equality and vector
operations only. It does not expose Boundary's existing `text_compare`
operation. A Praxis custom EpistemicStrategy therefore cannot compare either
the selected Action path or digest with the corresponding typed Memory value.

## Why the application cannot own the correction

- `boundary.Text` is a semantic atom in Boundary Control IR; generic product
  extraction is rejected for Text values.
- Agent Flow exposes no text length, copy, compare, or array-index operation.
- Flow's generic `instruction` constructor is private to Agent.
- Adding model-authored numeric aliases to `ReplaceRequest` or
  `DocumentSnapshot` would change the frozen Praxis application contract and
  would not independently authenticate the path.
- Letting the receiver reject a mismatch after emission does not make the
  invalid pre-effect state unreachable in the Agent program.
- Comparing only mutation counts or vector positions cannot establish exact
  path or digest identity.

Boundary v1.5.0 already owns and validates `text_compare` as a pure
`Text, Text -> i8` Control IR operation. No Boundary ABI, Machine-state, World,
host, or effect-protocol change is required.

## Smallest necessary upstream change

Agent Flow must expose a typed, pure lowering for Boundary's existing
`text_compare` operation (or an equivalent typed text-equality operation), with
focused native/WASM tests. Praxis can then derive equality by comparing the
result with zero inside `emitActionAllowed`, document upsert, idempotency, and
final admission.

Do not add a host guard, path code, second reducer, or Praxis-local compiler
fork. The owner is the Agent compiler authoring surface.
