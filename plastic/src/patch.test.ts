import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { applyPatch } from "diff";
import { buildPlasticFilePatch, createPlasticSourceCapability } from "./patch";

function parseOne(patchText: string) {
  const files = parsePatchFiles(patchText, "patch", true).flatMap(
    (patch) => patch.files,
  );
  expect(files).toHaveLength(1);
  return files[0]!;
}

describe("Plastic file patches", () => {
  test("builds a Hunk-parseable text modification", () => {
    const file = buildPlasticFilePatch({
      path: "src/main.ts",
      oldContent: Buffer.from("const value = 1;\n"),
      newContent: Buffer.from("const value = 2;\n"),
    });
    expect(file?.patchText).toContain("-const value = 1;");
    expect(file?.patchText).toContain("+const value = 2;");
    expect(parseOne(file!.patchText).type).toBe("change");
  });

  test("preserves whitespace in the final patch row", () => {
    for (const [before, after] of [
      ["old\n", "new   \n"],
      ["old\n\n", "new\n\n"],
      ["old\r\n", "new\r\n"],
    ] as const) {
      const file = buildPlasticFilePatch({
        path: "whitespace.txt",
        oldContent: Buffer.from(before),
        newContent: Buffer.from(after),
      })!;
      expect(applyPatch(before, file.patchText)).toBe(after);
      expect(parseOne(file.patchText).type).toBe("change");
    }
  });

  test("preserves a UTF-8 BOM in patches and exact source reads", async () => {
    const plain = Buffer.from("one\n");
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), plain]);
    for (const [oldContent, newContent] of [
      [plain, withBom],
      [withBom, plain],
    ] as const) {
      const file = buildPlasticFilePatch({
        path: "bom.txt",
        oldContent,
        newContent,
      })!;
      const source = createPlasticSourceCapability([file]);
      expect(file.oldText).not.toBeNull();
      expect(file.newText).not.toBeNull();
      expect(applyPatch(file.oldText!, file.patchText)).toBe(file.newText!);
      expect(parseOne(file.patchText).type).toBe("change");
      expect(
        await source.readFileSource({
          path: "bom.txt",
          changeType: "change",
          isUntracked: false,
          side: "old",
        }),
      ).toBe(file.oldText);
      expect(file.oldText?.startsWith("\uFEFF")).toBe(oldContent === withBom);
      expect(file.newText?.startsWith("\uFEFF")).toBe(newContent === withBom);
    }
  });

  test("marks additions and deletions with /dev/null", () => {
    const added = buildPlasticFilePatch({
      path: "new.txt",
      oldContent: null,
      newContent: Buffer.from("hello\n"),
    });
    const deleted = buildPlasticFilePatch({
      path: "gone.txt",
      oldContent: Buffer.from("goodbye\n"),
      newContent: null,
    });
    expect(added?.patchText).toContain("--- /dev/null");
    expect(deleted?.patchText).toContain("+++ /dev/null");
    expect(parseOne(added!.patchText).type).toBe("new");
    expect(parseOne(deleted!.patchText).type).toBe("deleted");
  });

  test("keeps empty file additions and deletions visible", () => {
    const added = buildPlasticFilePatch({
      path: "empty-added.txt",
      oldContent: null,
      newContent: Buffer.alloc(0),
    });
    const deleted = buildPlasticFilePatch({
      path: "empty-deleted.txt",
      oldContent: Buffer.alloc(0),
      newContent: null,
    });
    expect(parseOne(added!.patchText).type).toBe("new");
    expect(parseOne(deleted!.patchText).type).toBe("deleted");
  });

  test("counts complete changes for budget-skipped files without counting patch headers", () => {
    const file = buildPlasticFilePatch({
      path: "stats.txt",
      oldContent: Buffer.from("--- old\ncontext\n"),
      newContent: Buffer.from("+++ new\nextra\ncontext\n"),
    })!;
    expect(file.stats).toEqual({ additions: 2, deletions: 1 });
    expect(applyPatch("--- old\ncontext\n", file.patchText)).toBe(
      "+++ new\nextra\ncontext\n",
    );
  });

  test("preserves a pure rename even when file contents do not change", () => {
    const file = buildPlasticFilePatch({
      path: "src/new name.ts",
      previousPath: "src/old name.ts",
      oldContent: Buffer.from("same\n"),
      newContent: Buffer.from("same\n"),
    });
    expect(file?.patchText).toContain('rename from "src/old name.ts"');
    expect(file?.patchText).toContain('rename to "src/new name.ts"');
    expect(parseOne(file!.patchText).type).toBe("rename-pure");
  });

  test("reports a regular-file to symlink replacement", () => {
    const file = buildPlasticFilePatch({
      path: "CLAUDE.md",
      oldContent: Buffer.from("old instructions\n"),
      newContent: Buffer.from("AGENTS.md"),
      oldMode: "100644",
      newMode: "120000",
    })!;
    expect(file.patchText).toContain("old mode 100644");
    expect(file.patchText).toContain("new mode 120000");
    expect(parseOne(file.patchText).type).toBe("change");
  });

  test("keeps a mode-only regular-file to symlink replacement", () => {
    const file = buildPlasticFilePatch({
      path: "same-target",
      oldContent: Buffer.from("target.txt"),
      newContent: Buffer.from("target.txt"),
      oldMode: "100644",
      newMode: "120000",
    })!;
    expect(file.patchText).toContain("old mode 100644");
    expect(file.patchText).toContain("new mode 120000");
    expect(parseOne(file.patchText).type).toBe("change");
  });

  test("emits the binary marker Hunk recognizes", () => {
    const file = buildPlasticFilePatch({
      path: "image.bin",
      oldContent: Buffer.from([0, 1]),
      newContent: Buffer.from([0, 2]),
      declaredBinary: true,
    });
    expect(file?.patchText).toContain(
      "Binary files a/image.bin and b/image.bin differ",
    );
    expect(parseOne(file!.patchText).type).toBe("change");
  });

  test("drops unchanged non-renamed files", () => {
    expect(
      buildPlasticFilePatch({
        path: "same.txt",
        oldContent: Buffer.from("same\n"),
        newContent: Buffer.from("same\n"),
      }),
    ).toBeNull();
  });

  test("keeps a provider-reported change visible when its bytes are equal", () => {
    const file = buildPlasticFilePatch({
      path: "status-only.txt",
      oldContent: Buffer.from("same\n"),
      newContent: Buffer.from("same\n"),
      preserveEmptyChange: true,
    });
    expect(file?.patchText).toBe(
      "diff --git a/status-only.txt b/status-only.txt\n",
    );
    expect(file?.stats).toEqual({ additions: 0, deletions: 0 });
    expect(parseOne(file!.patchText).type).toBe("change");
  });

  test("serves exact source sides and changes the cache identity with full content", async () => {
    const first = buildPlasticFilePatch({
      path: "src/main.ts",
      oldContent: Buffer.from("before\ncontext a\n"),
      newContent: Buffer.from("after\ncontext a\n"),
    })!;
    const second = buildPlasticFilePatch({
      path: "src/main.ts",
      oldContent: Buffer.from("before\ncontext b\n"),
      newContent: Buffer.from("after\ncontext b\n"),
    })!;
    const source = createPlasticSourceCapability([first]);
    const changedSource = createPlasticSourceCapability([second]);
    expect(source.sourceCacheKey).not.toBe(changedSource.sourceCacheKey);
    expect(
      await source.readFileSource({
        path: "src/main.ts",
        changeType: "change",
        isUntracked: false,
        side: "old",
      }),
    ).toBe("before\ncontext a\n");
  });
});
