import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionVcsDiffInput } from "hunkdiff/extension";
import {
  PLASTIC_DIFF_FILE_MAX_BYTES,
  PLASTIC_DIFF_FILE_MAX_LINES,
  PLASTIC_REVIEW_MAX_SOURCE_BYTES,
  classifyPlasticWorkspaceChange,
  createPlasticVcsAdapter,
} from "./adapter";
import {
  PlasticCommandOutputTooLarge,
  type PlasticCommandRunner,
} from "./process";

const unreachableRunner: PlasticCommandRunner = {
  async run() {
    throw new Error("runner should not be called");
  },
  runSync() {
    throw new Error("runner should not be called");
  },
};

describe("Plastic adapter", () => {
  test("detects the nearest Plastic workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-detect-"));
    try {
      await mkdir(join(root, ".plastic"));
      await mkdir(join(root, "src", "nested"), { recursive: true });
      const adapter = createPlasticVcsAdapter({ runner: unreachableRunner });
      expect(adapter.detect(join(root, "src", "nested"))).toEqual({
        id: "plastic",
        repoRoot: root,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects staged review before invoking Plastic", async () => {
    const adapter = createPlasticVcsAdapter({ runner: unreachableRunner });
    const input: ExtensionVcsDiffInput = {
      kind: "vcs",
      staged: true,
      options: {},
    };
    await expect(
      adapter.operations["working-tree-diff"]!.load(input, {
        cwd: "/not-a-workspace",
      }),
    ).rejects.toThrow("Plastic SCM has no staging area");
  });

  test("loads tracked and private workspace changes from read-only Plastic commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-workspace-"));
    const calls: string[][] = [];
    const statusXml = `<?xml version="1.0" encoding="utf-8"?>
<StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>7</Changeset></Status></WorkspaceStatus>
<Changes><Change><Type>CH</Type><Path>src/main;part.ts</Path><OldPath/><RevisionType>enTextFile</RevisionType></Change>
<Change><Type>PR</Type><Path>notes.txt</Path><OldPath/><RevisionType>enTextFile</RevisionType></Change></Changes></StatusOutput>`;
    const runner: PlasticCommandRunner = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "status") return Buffer.from(statusXml);
        if (args[0] === "ls")
          return Buffer.from("txt\u001fsrc/main;part.ts\u001f5\u001e\n");
        if (args[0] === "cat") return Buffer.from("const value = 1;\n");
        throw new Error(`unexpected command ${args.join(" ")}`);
      },
      runSync() {
        throw new Error("sync runner should not be called");
      },
    };

    try {
      await mkdir(join(root, ".plastic"));
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "main;part.ts"), "const value = 2;\n");
      await writeFile(join(root, "notes.txt"), "private\n");
      const adapter = createPlasticVcsAdapter({ runner });
      const result = await adapter.operations["working-tree-diff"]!.load(
        { kind: "vcs", staged: false, options: {} },
        { cwd: root },
      );

      expect(result.extraFiles?.map((file) => file.path)).toEqual([
        "src/main;part.ts",
        "notes.txt",
      ]);
      expect(result.extraFiles?.[1]).toMatchObject({
        path: "notes.txt",
        kind: "patch",
        isUntracked: true,
      });
      expect(
        (result.extraFiles?.[0]?.kind === "patch" &&
          result.extraFiles[0].patchText) ||
          "",
      ).toContain("+const value = 2;");
      expect(calls.map((args) => args[0])).toEqual(["status", "ls", "cat"]);
      expect(calls.find((args) => args[0] === "cat")?.[1]).toBe(
        "revid:5@rep:repo@repserver:cloud",
      );
      expect(
        calls.some((args) =>
          ["add", "checkout", "checkin", "update"].includes(args[0]!),
        ),
      ).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("groups mixed workspace changes by folder, including private files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-order-"));
    const changes = [
      ["CH", "src/z.txt"],
      ["CH", "other/changed.txt"],
      ["AD", "src/a.txt"],
      ["AD", "src/nested/child.txt"],
      ["PR", "src/private.txt"],
      ["PR", "src/large.txt"],
      ["AD", "src-sibling.txt"],
    ];
    const statusXml = `<StatusOutput><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>7</Changeset><Changes>${changes
      .map(([code, path]) =>
        `<Change><Type>${code}</Type><Path>${path}</Path><RevisionType>enTextFile</RevisionType></Change>`,
      )
      .join("")}</Changes></StatusOutput>`;
    const runner: PlasticCommandRunner = {
      async run(args) {
        if (args[0] === "status") return Buffer.from(statusXml);
        if (args[0] === "ls")
          return Buffer.from(
            "txt\u001fsrc/z.txt\u001f5\u001e" +
              "txt\u001fother/changed.txt\u001f6\u001e",
          );
        if (args[0] === "cat") return Buffer.from("before\n");
        throw new Error(`unexpected command ${args.join(" ")}`);
      },
      runSync: unreachableRunner.runSync,
    };
    try {
      await mkdir(join(root, ".plastic"));
      await mkdir(join(root, "src/nested"), { recursive: true });
      await mkdir(join(root, "other"));
      for (const [, path] of changes) {
        await writeFile(
          join(root, path!),
          path === "src/large.txt"
            ? Buffer.alloc(PLASTIC_DIFF_FILE_MAX_BYTES + 1, "x")
            : "after\n",
        );
      }
      const adapter = createPlasticVcsAdapter({ runner });
      for (const excludeUntracked of [false, true]) {
        const result = await adapter.operations["working-tree-diff"].load(
          { kind: "vcs", staged: false, options: { excludeUntracked } },
          { cwd: root },
        );
        expect(result.extraFiles?.map((file) => file.path)).toEqual([
          "other/changed.txt",
          "src/nested/child.txt",
          "src/a.txt",
          ...(excludeUntracked ? [] : ["src/large.txt", "src/private.txt"]),
          "src/z.txt",
          "src-sibling.txt",
        ]);
        if (!excludeUntracked) {
          expect(
            result.extraFiles?.find((file) => file.path === "src/large.txt"),
          ).toMatchObject({ kind: "skipped", isUntracked: true });
          expect(
            result.extraFiles?.find((file) => file.path === "src/private.txt"),
          ).toMatchObject({ kind: "patch", isUntracked: true });
          expect(
            await result.readFileSource?.({
              path: "src/private.txt",
              side: "new",
              changeType: "new",
              isUntracked: true,
            }),
          ).toBe("after\n");
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lists a tracked file when Plastic stops an oversized source read", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-remote-limit-"));
    const statusXml = `<?xml version="1.0"?><StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>7</Changeset></Status></WorkspaceStatus><Changes><Change><Type>CH</Type><Path>large.bin</Path><OldPath/><RevisionType>enBinaryFile</RevisionType></Change></Changes></StatusOutput>`;
    const runner: PlasticCommandRunner = {
      async run(args, _cwd, _signal, maxStdoutBytes) {
        if (args[0] === "status") return Buffer.from(statusXml);
        if (args[0] === "ls")
          return Buffer.from("bin\u001flarge.bin\u001f5\u001e\n");
        if (args[0] === "cat") {
          expect(maxStdoutBytes).toBe(PLASTIC_DIFF_FILE_MAX_BYTES);
          throw new PlasticCommandOutputTooLarge(args, maxStdoutBytes!);
        }
        throw new Error(`unexpected command ${args.join(" ")}`);
      },
      runSync() {
        throw new Error("sync runner should not be called");
      },
    };

    try {
      await mkdir(join(root, ".plastic"));
      const result = await createPlasticVcsAdapter({ runner }).operations[
        "working-tree-diff"
      ]!.load({ kind: "vcs", staged: false, options: {} }, { cwd: root });
      expect(result.extraFiles).toEqual([
        {
          kind: "skipped",
          path: "large.bin",
          reason: "too-large",
          changeType: "change",
        },
      ]);
      expect(
        await result.readFileSource?.({
          path: "large.bin",
          changeType: "change",
          isUntracked: false,
          side: "old",
        }),
      ).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lists a tracked file whose working copy side exceeds the byte limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-local-limit-"));
    const statusXml = `<?xml version="1.0"?><StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>7</Changeset></Status></WorkspaceStatus><Changes><Change><Type>CH</Type><Path>large.bin</Path><OldPath/><RevisionType>enBinaryFile</RevisionType></Change></Changes></StatusOutput>`;
    const runner: PlasticCommandRunner = {
      async run(args) {
        if (args[0] === "status") return Buffer.from(statusXml);
        if (args[0] === "ls")
          return Buffer.from("bin\u001flarge.bin\u001f5\u001e\n");
        if (args[0] === "cat") return Buffer.from([0]);
        throw new Error(`unexpected command ${args.join(" ")}`);
      },
      runSync() {
        throw new Error("sync runner should not be called");
      },
    };

    try {
      await mkdir(join(root, ".plastic"));
      await writeFile(
        join(root, "large.bin"),
        Buffer.alloc(PLASTIC_DIFF_FILE_MAX_BYTES + 1),
      );
      const result = await createPlasticVcsAdapter({ runner }).operations[
        "working-tree-diff"
      ]!.load({ kind: "vcs", staged: false, options: {} }, { cwd: root });
      expect(result.extraFiles?.[0]).toMatchObject({
        kind: "skipped",
        path: "large.bin",
        reason: "too-large",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("lists text beyond Hunk's render line limit without diffing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-line-limit-"));
    const statusXml = `<?xml version="1.0"?><StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>7</Changeset></Status></WorkspaceStatus><Changes><Change><Type>CH</Type><Path>generated.txt</Path><OldPath/><RevisionType>enTextFile</RevisionType></Change></Changes></StatusOutput>`;
    const runner: PlasticCommandRunner = {
      async run(args) {
        if (args[0] === "status") return Buffer.from(statusXml);
        if (args[0] === "ls")
          return Buffer.from("txt\u001fgenerated.txt\u001f5\u001e\n");
        if (args[0] === "cat") return Buffer.from("before\n");
        throw new Error(`unexpected command ${args.join(" ")}`);
      },
      runSync() {
        throw new Error("sync runner should not be called");
      },
    };

    try {
      await mkdir(join(root, ".plastic"));
      await writeFile(
        join(root, "generated.txt"),
        "x\n".repeat(PLASTIC_DIFF_FILE_MAX_LINES + 1),
      );
      const result = await createPlasticVcsAdapter({ runner }).operations[
        "working-tree-diff"
      ]!.load({ kind: "vcs", staged: false, options: {} }, { cwd: root });
      expect(result.extraFiles?.[0]).toMatchObject({
        kind: "skipped",
        path: "generated.txt",
        reason: "too-large",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("caps retained source data across a review", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-review-limit-"));
    const fileCount =
      PLASTIC_REVIEW_MAX_SOURCE_BYTES / (2 * PLASTIC_DIFF_FILE_MAX_BYTES) + 1;
    const changes = Array.from(
      { length: fileCount },
      (_, index) =>
        `<Change><Type>CH</Type><Path>${index}.bin</Path><OldPath/><RevisionType>enBinaryFile</RevisionType></Change>`,
    ).join("");
    const statusXml = `<?xml version="1.0"?><StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>7</Changeset></Status></WorkspaceStatus><Changes>${changes}</Changes></StatusOutput>`;
    const inventory = Array.from(
      { length: fileCount },
      (_, index) => `bin\u001f${index}.bin\u001f${index + 1}\u001e\n`,
    ).join("");
    const runner: PlasticCommandRunner = {
      async run(args) {
        if (args[0] === "status") return Buffer.from(statusXml);
        if (args[0] === "ls") return Buffer.from(inventory);
        if (args[0] === "cat") return Buffer.alloc(PLASTIC_DIFF_FILE_MAX_BYTES);
        throw new Error(`unexpected command ${args.join(" ")}`);
      },
      runSync() {
        throw new Error("sync runner should not be called");
      },
    };

    try {
      await mkdir(join(root, ".plastic"));
      await Promise.all(
        Array.from({ length: fileCount }, (_, index) =>
          writeFile(
            join(root, `${index}.bin`),
            Buffer.alloc(PLASTIC_DIFF_FILE_MAX_BYTES, 1),
          ),
        ),
      );
      const result = await createPlasticVcsAdapter({ runner }).operations[
        "working-tree-diff"
      ]!.load({ kind: "vcs", staged: false, options: {} }, { cwd: root });
      expect(
        result.extraFiles?.filter((file) => file.kind === "patch"),
      ).toHaveLength(fileCount - 1);
      expect(
        result.extraFiles?.filter((file) => file.kind === "skipped"),
      ).toHaveLength(1);
      expect(
        result.extraFiles?.find((file) => file.path === `${fileCount - 1}.bin`),
      ).toMatchObject({
        kind: "skipped",
        path: `${fileCount - 1}.bin`,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("classifies the workspace status codes used by Plastic", () => {
    const change = (code: string) =>
      classifyPlasticWorkspaceChange({
        code,
        path: "file.txt",
        revisionType: "enTextFile",
      });
    expect(change("CH")).toBe("change");
    expect(change("CO+CH")).toBe("change");
    expect(change("AD")).toBe("new");
    expect(change("LD")).toBe("deleted");
    expect(change("LM")).toBe("moved");
    expect(change("CO+RP+MV")).toBe("moved");
    expect(change("CO+RP+CH")).toBe("change");
    expect(change("PR")).toBe("private");
    expect(change("CO")).toBe("skip");
  });

  test("expands private directories without including ignored descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-private-dir-"));
    const unit = "\u001f";
    const record = "\u001e";
    const statusXml = `<?xml version="1.0"?><StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>7</Changeset></Status></WorkspaceStatus><Changes><Change><Type>PR</Type><Path>private-dir</Path><OldPath/><RevisionType>enDirectory</RevisionType></Change></Changes></StatusOutput>`;
    const runner: PlasticCommandRunner = {
      async run(args) {
        if (args[0] === "status") return Buffer.from(statusXml);
        if (args[0] === "fileinfo") {
          expect(args).toContain("--symlink");
          return Buffer.from(
            [
              ["/private-dir/keep.txt", "private", "txt"].join(unit),
              ["/private-dir/ignored.txt", "ignored", "txt"].join(unit),
            ].join(`${record}\n`) + record,
          );
        }
        throw new Error(`unexpected command ${args.join(" ")}`);
      },
      runSync() {
        throw new Error("sync runner should not be called");
      },
    };
    try {
      await mkdir(join(root, ".plastic"));
      await mkdir(join(root, "private-dir"));
      await writeFile(join(root, "private-dir", "keep.txt"), "keep\n");
      await writeFile(join(root, "private-dir", "ignored.txt"), "ignore\n");
      const result = await createPlasticVcsAdapter({ runner }).operations[
        "working-tree-diff"
      ]!.load({ kind: "vcs", staged: false, options: {} }, { cwd: root });
      expect(result.extraFiles).toMatchObject([
        { path: "private-dir/keep.txt", kind: "patch", isUntracked: true },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("expands a pending directory deletion from the loaded tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-deleted-dir-"));
    const statusXml = `<?xml version="1.0"?><StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>7</Changeset></Status></WorkspaceStatus><Changes><Change><Type>LD</Type><Path>gone</Path><OldPath/><RevisionType>enDirectory</RevisionType></Change></Changes></StatusOutput>`;
    const runner: PlasticCommandRunner = {
      async run(args) {
        if (args[0] === "status") return Buffer.from(statusXml);
        if (args[0] === "ls")
          return Buffer.from(
            "dir\u001fgone\u001f40\u001e\ntxt\u001fgone/a.txt\u001f41\u001e\n",
          );
        if (args[0] === "cat" && args[1]?.startsWith("revid:41@"))
          return Buffer.from("removed\n");
        throw new Error(`unexpected command ${args.join(" ")}`);
      },
      runSync() {
        throw new Error("sync runner should not be called");
      },
    };
    try {
      await mkdir(join(root, ".plastic"));
      const result = await createPlasticVcsAdapter({ runner }).operations[
        "working-tree-diff"
      ]!.load({ kind: "vcs", staged: false, options: {} }, { cwd: root });
      expect(result.extraFiles?.map((file) => file.path)).toEqual([
        "gone/a.txt",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("does not synthesize a ghost path for a child moved within a moved directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-moved-dir-"));
    const statusXml = `<?xml version="1.0"?><StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>7</Changeset></Status></WorkspaceStatus><Changes><Change><Type>LM</Type><Path>new-dir</Path><OldPath>old-dir</OldPath><RevisionType>enDirectory</RevisionType></Change><Change><Type>LM</Type><Path>new-dir/b.txt</Path><OldPath>old-dir/a.txt</OldPath><RevisionType>enTextFile</RevisionType></Change></Changes></StatusOutput>`;
    const runner: PlasticCommandRunner = {
      async run(args) {
        if (args[0] === "status") return Buffer.from(statusXml);
        if (args[0] === "ls")
          return Buffer.from(
            "dir\u001fold-dir\u001f80\u001e\ntxt\u001fold-dir/a.txt\u001f81\u001e\n",
          );
        if (args[0] === "cat") return Buffer.from("moved\n");
        throw new Error(`unexpected command ${args.join(" ")}`);
      },
      runSync() {
        throw new Error("sync runner should not be called");
      },
    };
    try {
      await mkdir(join(root, ".plastic"));
      await mkdir(join(root, "new-dir"));
      await writeFile(join(root, "new-dir", "b.txt"), "moved\n");
      const result = await createPlasticVcsAdapter({ runner }).operations[
        "working-tree-diff"
      ]!.load({ kind: "vcs", staged: false, options: {} }, { cwd: root });
      expect(result.extraFiles).toHaveLength(1);
      expect(result.extraFiles?.[0]).toMatchObject({
        path: "new-dir/b.txt",
        previousPath: "old-dir/a.txt",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("changes the watch signature when an expanded child changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-watch-dir-"));
    const statusXml = `<?xml version="1.0"?><StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>7</Changeset></Status></WorkspaceStatus><Changes><Change><Type>PR</Type><Path>private-dir</Path><OldPath/><RevisionType>enDirectory</RevisionType></Change></Changes></StatusOutput>`;
    const runner: PlasticCommandRunner = {
      async run() {
        throw new Error("async runner should not be called");
      },
      runSync() {
        return Buffer.from(statusXml);
      },
    };
    try {
      await mkdir(join(root, ".plastic"));
      await mkdir(join(root, "private-dir"));
      const child = join(root, "private-dir", "keep.txt");
      await writeFile(child, "one\n");
      const operation = createPlasticVcsAdapter({ runner }).operations[
        "working-tree-diff"
      ]!;
      const input: ExtensionVcsDiffInput = {
        kind: "vcs",
        staged: false,
        options: {},
      };
      const before = operation.watchSignature!(input, { cwd: root });
      await writeFile(child, "a different size\n");
      const after = operation.watchSignature!(input, { cwd: root });
      expect(after).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("coalesces edited moves and expands deleted directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunk-plastic-revision-"));
    const unit = "\u001f";
    const record = "\u001e";
    const diffOutput =
      [
        ["C", "/new.txt", "", "", "F", "20", "10", "10"].join(unit),
        ["D", "/gone", "", "", "D", "30", "-1", "-1"].join(unit),
        ["M", "/new.txt", "/old.txt", "/new.txt", "F", "20", "-1", "10"].join(
          unit,
        ),
        [
          "M",
          "/new-dir/a.txt",
          "/old-dir/a.txt",
          "/new-dir/a.txt",
          "F",
          "50",
          "-1",
          "40",
        ].join(unit),
        ["M", "/new-dir", "/old-dir", "/new-dir", "D", "60", "-1", "55"].join(
          unit,
        ),
        ["A", "/CLAUDE.md", "", "", "S", "70", "-1", "-1"].join(unit),
        ["D", "/CLAUDE.md", "", "", "F", "60", "-1", "59"].join(unit),
      ].join(`${record}\n`) + record;
    const oldTree =
      [
        ["dir", "/gone", "30"].join(unit),
        ["txt", "/gone/a.txt", "31"].join(unit),
        ["dir", "/old-dir", "55"].join(unit),
        ["txt", "/old-dir/a.txt", "40"].join(unit),
      ].join(`${record}\n`) + record;
    const newTree =
      [
        ["dir", "/new-dir", "60"].join(unit),
        ["txt", "/new-dir/a.txt", "50"].join(unit),
      ].join(`${record}\n`) + record;
    const statusXml = `<?xml version="1.0"?><StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>2</Changeset></Status></WorkspaceStatus><Changes/></StatusOutput>`;
    const runner: PlasticCommandRunner = {
      async run(args) {
        if (args[0] === "status") return Buffer.from(statusXml);
        if (args[0] === "diff") return Buffer.from(diffOutput);
        if (args[0] === "log") return Buffer.from("2");
        if (args[0] === "find") return Buffer.from("1");
        if (args[0] === "ls")
          return Buffer.from(args.includes("--tree=cs:1") ? oldTree : newTree);
        if (args[0] === "cat") {
          const revision = args[1]?.match(/^revid:(\d+)/)?.[1];
          const contents: Record<string, string> = {
            "10": "before\n",
            "20": "after\n",
            "31": "deleted\n",
            "40": "moved before\n",
            "50": "moved after\n",
            "60": "old instructions\n",
            "70": "AGENTS.md",
          };
          if (revision === "70" && !args.includes("--symlink"))
            throw new Error("symlink revision requires --symlink");
          if (revision && revision in contents)
            return Buffer.from(contents[revision]!);
        }
        throw new Error(`unexpected command ${args.join(" ")}`);
      },
      runSync() {
        throw new Error("sync runner should not be called");
      },
    };

    try {
      await mkdir(join(root, ".plastic"));
      const adapter = createPlasticVcsAdapter({ runner });
      const result = await adapter.operations["working-tree-diff"]!.load(
        {
          kind: "vcs",
          rangeEndpoints: { from: "cs:1", to: "cs:2" },
          staged: false,
          options: {},
        },
        { cwd: root },
      );
      const shown = await adapter.operations["revision-show"].load(
        { kind: "show", ref: "cs:2", options: {} },
        { cwd: root },
      );
      expect(shown.extraFiles).toEqual(result.extraFiles);
      expect(result.extraFiles?.map((file) => file.path)).toEqual([
        "gone/a.txt",
        "new-dir/a.txt",
        "CLAUDE.md",
        "new.txt",
      ]);
      expect(result.extraFiles?.[3]).toMatchObject({
        path: "new.txt",
        previousPath: "old.txt",
      });
      expect(
        await result.readFileSource?.({
          path: "new.txt",
          changeType: "rename-changed",
          isUntracked: false,
          side: "old",
        }),
      ).toBe("before\n");
      const replacement = result.extraFiles?.find(
        (file) => file.path === "CLAUDE.md",
      );
      expect(
        replacement?.kind === "patch" ? replacement.patchText : "",
      ).toContain("new mode 120000");
      expect(
        await result.readFileSource?.({
          path: "CLAUDE.md",
          changeType: "change",
          isUntracked: false,
          side: "old",
        }),
      ).toBe("old instructions\n");
      expect(
        result.extraFiles?.[0]?.kind === "patch"
          ? result.extraFiles[0].patchText
          : "",
      ).toContain("-deleted");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
