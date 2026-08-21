# Read-freshness observability correction

Praxis v1.0.5 instructed a stateless model to perform a fresh check and a fresh read before revising an already changed path, but its Memory and DecisionView retained only the current document snapshot. Reading unchanged bytes therefore upserted the same snapshot and produced no semantic state change. In a Poiesis birth, nineteen consecutive model DecisionTurns had one identical context digest while only request counters changed; the model repeated the same read until the Machine fuel bound failed closed.

v1.0.6 adds one typed `ReadEvidence` value owned by the EpistemicStrategy. Every `read_file` observation records the exact path and current test count, and DecisionView exposes that witness. Pre-effect replacement admission now requires a previously changed path to match the latest read path and requires its observed test count to equal the current test count. A new full check automatically makes earlier read evidence stale. The model-visible instructions name the exact witness and direct the model to stop rereading once it is current.

This changes the parent application ID, WASM, Decision Contract, codec, and Machine state schema. It does not change Machine ABI 2, ABL_RNF2, Application ABI 1, Frame 1, Effect protocol 1, host behavior, capability authority, replacement count, changed-file count, or external-effect semantics.
