import { describe, expect, test } from "bun:test";
import { _liveInternals } from "../tools/live.mjs";

describe("live runner invariants", () => {
  test("requires a baseline check and a fresh check after every replacement", () => {
    expect(_liveInternals.testSequenceIsFresh([
      { interfaceLabel: "model.decide.v1", newlyApplied: false },
      { interfaceLabel: "repo.test.v2", newlyApplied: false },
      { interfaceLabel: "repo.replace.approved.v2", newlyApplied: true },
      { interfaceLabel: "model.decide.v1", newlyApplied: false },
      { interfaceLabel: "repo.test.v2", newlyApplied: false },
      { interfaceLabel: "repo.replace.approved.v2", newlyApplied: true },
      { interfaceLabel: "model.decide.v1", newlyApplied: false },
      { interfaceLabel: "repo.test.v2", newlyApplied: false },
    ])).toBe(true);
    expect(_liveInternals.testSequenceIsFresh([
      { interfaceLabel: "repo.replace.approved.v2", newlyApplied: true },
      { interfaceLabel: "repo.test.v2", newlyApplied: false },
    ])).toBe(false);
    expect(_liveInternals.testSequenceIsFresh([
      { interfaceLabel: "repo.test.v2", newlyApplied: false },
      { interfaceLabel: "repo.replace.approved.v2", newlyApplied: true },
    ])).toBe(false);
    expect(_liveInternals.testSequenceIsFresh([
      { interfaceLabel: "repo.test.v2", newlyApplied: false },
      { interfaceLabel: "repo.replace.approved.v2", newlyApplied: true },
      { interfaceLabel: "repo.replace.approved.v2", newlyApplied: true },
      { interfaceLabel: "repo.test.v2", newlyApplied: false },
    ])).toBe(false);
    expect(_liveInternals.testSequenceIsFresh([
      { interfaceLabel: "repo.test.v2", newlyApplied: false },
      { interfaceLabel: "repo.replace.approved.v2", newlyApplied: false },
      { interfaceLabel: "repo.replace.approved.v2", newlyApplied: true },
      { interfaceLabel: "repo.test.v2", newlyApplied: false },
    ])).toBe(true);
  });
});
