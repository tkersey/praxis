import { describe, expect, test } from "bun:test";
import { _liveInternals } from "../tools/live.mjs";

describe("live runner invariants", () => {
  test("requires a baseline check and a fresh check after every replacement", () => {
    expect(_liveInternals.testSequenceIsFresh([
      "model.decide.v1", "repo.test.v2", "repo.replace.approved.v2",
      "model.decide.v1", "repo.test.v2", "repo.replace.approved.v2",
      "model.decide.v1", "repo.test.v2", "model.decide.v1",
    ])).toBe(true);
    expect(_liveInternals.testSequenceIsFresh(["repo.replace.approved.v2", "repo.test.v2"])).toBe(false);
    expect(_liveInternals.testSequenceIsFresh(["repo.test.v2", "repo.replace.approved.v2"])).toBe(false);
    expect(_liveInternals.testSequenceIsFresh([
      "repo.test.v2", "repo.replace.approved.v2", "repo.replace.approved.v2", "repo.test.v2",
    ])).toBe(false);
  });
});
