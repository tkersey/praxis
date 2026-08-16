# Agent pre-effect admission obstruction

## Outcome

`praxis_obstruction`

Praxis v1 requires the generated Agent program to make `replace_file` unreachable
until deterministic Memory records a baseline test at the current mutation count.
The exact released Agent v2.2.0 compiler cannot express that application-owned
pre-effect admission invariant.

## Frozen tuple

The counterexample uses Zig 0.16.0 and the exact public Agent v2.2.0 package hash in
`build.zig.zon`. The complete frozen tuple is in
`conformance/praxis-v1/reference-stack.lock.json`.

## Executable counterexample

Run:

```sh
zig build check --summary all
```

The test initializes a compiled Agent Machine whose Memory says
`baseline_test_observed = false`, resumes the first `model.decide.v1` request with
a `replace_file` action, and observes the next Machine request. That request is
`repo.replace.approved.v2`. The witness stops there: no capability is invoked and no
repository file is written.

This is a runtime reachability proof, not source inference. It also asserts Machine
ABI 2, `ABL_RNF2`, and the residual effect semantic identity.

## Owner

Owner: **Agent compiler**.

Agent v2.2.0's custom epistemic interface admits deterministic Memory construction,
observation folding, projection, and terminal-result admission. It has no action
admission hook. After the decision action is decoded, the compiler checks the effect
budget and directly emits `flow.perform` for the selected effect.

Relevant released source:

- [`src/epistemics.zig`](https://github.com/tkersey/agent/blob/v2.2.0/src/epistemics.zig#L379-L526) defines and forwards the complete custom epistemic surface.
- [`src/compiler.zig`](https://github.com/tkersey/agent/blob/v2.2.0/src/compiler.zig#L273-L366) lowers an effect action from budget check to `flow.perform` without a Memory-dependent admission seam.

Boundary already represents the required branch, state, failure, and effect
primitives. World and world-host receive only the effect request after the Agent
Machine has emitted it. A host-side denial could prevent the write, but would not
make the invalid Agent state unreachable and would create a second authority owner
for the sequencing law.

## Smallest necessary upstream semantic change

A successor Agent release needs one typed, effect-free action-admission lowering
seam, or an observationally equivalent compiler-owned construction, between decoded
action selection and effect performance. It must receive current deterministic
Memory and the typed Action, return an admitted boolean, and route denial to a typed
Agent failure before `flow.perform`.

No upstream change is applied here. Praxis does not widen the host, add a second
reducer, or claim completion from a host-side guard.
