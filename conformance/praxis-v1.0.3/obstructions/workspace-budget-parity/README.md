# Workspace budget parity correction

Praxis v1.0.2 raised the Machine mutation budget to 10 but left the immutable workspace adapter admission ceiling at 6. A receiver policy requesting the released Machine capacity therefore failed before execution.

v1.0.3 changes only adapter/compiler-limit parity and the application/package version. It admits at most 10 replacement operations and continues to reject 11; the four-file, digest, check-freshness, authority, ABI, and effect-protocol bounds are unchanged.
