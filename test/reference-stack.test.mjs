import { describe, expect, test } from "bun:test";
import { parseTarVerboseSize } from "../tools/reference-stack.mjs";

describe("reference stack tar listing", () => {
  test("parses BSD tar verbose size", () => {
    expect(parseTarVerboseSize("drwxrwxr-x  0 root wheel        0 Aug 16 22:58 agent-2.5.0/")).toBe(0);
    expect(parseTarVerboseSize("-rw-r--r--  0 root wheel     1234 Aug 16 22:58 agent-2.5.0/build.zig")).toBe(1234);
  });

  test("parses GNU tar verbose size", () => {
    expect(parseTarVerboseSize("drwxrwxr-x root/root         0 2026-08-16 22:58 agent-2.5.0/")).toBe(0);
    expect(parseTarVerboseSize("-rw-r--r-- root/root      1234 2026-08-16 22:58 agent-2.5.0/build.zig")).toBe(1234);
  });

  test("rejects unrecognized verbose output", () => {
    expect(() => parseTarVerboseSize("not a tar listing")).toThrow("unable to validate archive expansion");
  });
});
