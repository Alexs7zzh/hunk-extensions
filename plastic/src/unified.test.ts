import { describe, expect, test } from "bun:test";
import { applyPatch, parsePatch } from "diff";
import { createUnifiedFilePatch } from "./unified";

describe("unified diff", () => {
  test("round-trips separated edits with bounded context", () => {
    const before =
      Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") +
      "\n";
    const after = before
      .replace("line 2", "changed 2")
      .replace("line 18", "changed 18");
    const patch = createUnifiedFilePatch(
      "a/file.txt",
      "b/file.txt",
      before,
      after,
    );
    expect(parsePatch(patch)[0]?.hunks).toHaveLength(2);
    expect(applyPatch(before, patch)).toBe(after);
  });

  test("handles insertions and deletions at file boundaries", () => {
    const before = "middle\nlast\n";
    const after = "first\nmiddle\n";
    const patch = createUnifiedFilePatch(
      "a/file.txt",
      "b/file.txt",
      before,
      after,
    );
    expect(applyPatch(before, patch)).toBe(after);
  });

  test("reports missing final newlines", () => {
    const patch = createUnifiedFilePatch(
      "a/file.txt",
      "b/file.txt",
      "old",
      "new",
    );
    expect(patch.match(/No newline at end of file/g)).toHaveLength(2);
    expect(applyPatch("old", patch)).toBe("new");
  });

  test("emits zero-length ranges for empty sides", () => {
    const added = createUnifiedFilePatch(
      "/dev/null",
      "b/file.txt",
      "",
      "hello\n",
    );
    const deleted = createUnifiedFilePatch(
      "a/file.txt",
      "/dev/null",
      "hello\n",
      "",
    );
    expect(added).toContain("@@ -0,0 +1,1 @@");
    expect(deleted).toContain("@@ -1,1 +0,0 @@");
    expect(applyPatch("", added)).toBe("hello\n");
    expect(applyPatch("hello\n", deleted)).toBe("");
  });

  test("round-trips varied edit scripts", () => {
    let state = 0x5eed1234;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
    for (let sample = 0; sample < 250; sample += 1) {
      const before =
        Array.from(
          { length: Math.floor(random() * 30) },
          () => `line-${Math.floor(random() * 12)}`,
        ).join("\n") + (random() > 0.25 ? "\n" : "");
      const after =
        Array.from(
          { length: Math.floor(random() * 30) },
          () => `line-${Math.floor(random() * 12)}`,
        ).join("\n") + (random() > 0.25 ? "\n" : "");
      const patch = createUnifiedFilePatch(
        "a/file.txt",
        "b/file.txt",
        before,
        after,
      );
      expect(applyPatch(before, patch)).toBe(after);
    }
  });

  test("falls back to a bounded whole-middle replacement for divergent files", () => {
    const before =
      Array.from({ length: 600 }, (_, index) => `old ${index}`).join("\n") +
      "\n";
    const after =
      Array.from({ length: 600 }, (_, index) => `new ${index}`).join("\n") +
      "\n";
    const patch = createUnifiedFilePatch(
      "a/file.txt",
      "b/file.txt",
      before,
      after,
    );
    expect(applyPatch(before, patch)).toBe(after);
  });
});
