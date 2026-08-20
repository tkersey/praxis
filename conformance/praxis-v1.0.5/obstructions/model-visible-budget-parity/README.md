# Model-visible replacement-budget parity correction

Praxis v1.0.4 raised the Machine mutation vector and workspace-adapter ceiling to ten, but its emitted Decision Contract still instructed the model to use at most six replacements and to abort when more capacity was required. Poiesis birth therefore did not exercise one coherent ten-replacement parent envelope.

v1.0.5 derives the model-visible compiled ceiling from `maximum_mutation_operations`, proves the emitted Decision Contract and workspace adapter share that ceiling, and enforces any narrower receiver policy before approval or a new write. Idempotent already-applied results remain permitted at the receiver ceiling but still require request-bound approval. No authority, ABI, effect protocol, file-count bound, or fuel bound changes.
