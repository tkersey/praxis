# Model-visible replacement-budget parity correction

Praxis v1.0.4 raised the Machine mutation vector and workspace-adapter ceiling to ten, but its emitted Decision Contract still instructed the model to use at most six replacements and to abort when more capacity was required. Poiesis birth therefore did not exercise one coherent ten-replacement parent envelope.

v1.0.5 derives the model-visible replacement count from `maximum_mutation_operations` and proves the emitted Decision Contract, Machine constant, workspace adapter, and receiver policy use the same value. No authority, ABI, effect protocol, file-count bound, or fuel bound changes.
