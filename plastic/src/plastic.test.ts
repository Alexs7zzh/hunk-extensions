import { describe, expect, test } from "bun:test";
import {
  normalizeRepoPath,
  parsePlasticDiffInventory,
  parsePlasticTreeEntries,
  parsePlasticWorkspaceFileInfo,
  parsePlasticStatusXml,
  pathMatchesPlasticPathspecs,
} from "./plastic";

const STATUS_XML = `<?xml version="1.0" encoding="utf-8"?>
<StatusOutput>
  <WorkspaceStatus><Status><RepSpec><Server>cloud.example</Server><Name>demo</Name></RepSpec><Changeset>42</Changeset></Status></WorkspaceStatus>
  <Changes><Change><Type>CH</Type><Path>src/main.ts</Path><OldPath /><Size>12</Size><RevisionType>enTextFile</RevisionType><LastModified>2026-09-07T01:02:03Z</LastModified></Change>
  <Change><Type>LM</Type><Path>src/new name.ts</Path><OldPath>src/old name.ts</OldPath><RevisionType>enTextFile</RevisionType></Change>
  <Change><Type>PR</Type><Path>notes/&amp;todo.txt</Path><OldPath /><RevisionType>enTextFile</RevisionType></Change></Changes>
</StatusOutput>`;

describe("Plastic machine output", () => {
  test("parses workspace identity, paths, moves, and XML entities", () => {
    expect(parsePlasticStatusXml(STATUS_XML)).toEqual({
      changeset: "42",
      repository: "demo",
      server: "cloud.example",
      changes: [
        {
          code: "CH",
          path: "src/main.ts",
          revisionType: "enTextFile",
          size: "12",
          lastModified: "2026-09-07T01:02:03Z",
        },
        {
          code: "LM",
          path: "src/new name.ts",
          oldPath: "src/old name.ts",
          revisionType: "enTextFile",
        },
        {
          code: "PR",
          path: "notes/&todo.txt",
          revisionType: "enTextFile",
        },
      ],
    });
  });

  test("parses revision inventory records and Plastic quoting", () => {
    const unit = "\u001f";
    const record = "\u001e";
    const output =
      [
        ["C", '"/src/main.ts"', '""', '""', "F", "12", "9", "9"].join(unit),
        [
          "M",
          '"/src/old.ts"',
          '"/src/old.ts"',
          '"/src/new.ts"',
          "F",
          "13",
          "12",
          "12",
        ].join(unit),
      ].join(`${record}\n`) + record;

    expect(parsePlasticDiffInventory(output)).toEqual([
      {
        status: "C",
        path: "src/main.ts",
        itemType: "F",
        revisionId: "12",
        baseRevisionId: "9",
        parentRevisionId: "9",
      },
      {
        status: "M",
        path: "src/old.ts",
        sourcePath: "src/old.ts",
        destinationPath: "src/new.ts",
        itemType: "F",
        revisionId: "13",
        baseRevisionId: "12",
        parentRevisionId: "12",
      },
    ]);
  });

  test("parses recursive tree entries", () => {
    const unit = "\u001f";
    const record = "\u001e";
    const output =
      [
        ["dir", '"/Config/Linux"', "21"].join(unit),
        ["txt", '"/Config/Linux/LinuxGame.ini"', "22"].join(unit),
      ].join(`${record}\n`) + record;
    expect(parsePlasticTreeEntries(output)).toEqual([
      { itemType: "dir", path: "Config/Linux", revisionId: "21" },
      {
        itemType: "txt",
        path: "Config/Linux/LinuxGame.ini",
        revisionId: "22",
      },
    ]);
  });

  test("parses file information without trimming path whitespace", () => {
    const unit = "\u001f";
    const record = "\u001e";
    expect(
      parsePlasticWorkspaceFileInfo(
        `"/ private/file.txt "${unit}private${unit}txt${record}\n`,
      ),
    ).toEqual([
      {
        path: " private/file.txt ",
        status: "private",
        itemType: "txt",
      },
    ]);
  });

  test("preserves leading and trailing spaces in status paths", () => {
    const xml = `<?xml version="1.0"?><StatusOutput><WorkspaceStatus><Status><RepSpec><Server>cloud</Server><Name>repo</Name></RepSpec><Changeset>1</Changeset></Status></WorkspaceStatus><Changes><Change><Type>PR</Type><Path> dir/file.txt </Path><OldPath/><RevisionType>enTextFile</RevisionType></Change></Changes></StatusOutput>`;
    expect(parsePlasticStatusXml(xml).changes[0]?.path).toBe(" dir/file.txt ");
  });
});

describe("Plastic paths", () => {
  test("normalizes repository paths from both operating-system styles", () => {
    expect(normalizeRepoPath("/src\\lib/file.ts/")).toBe("src/lib/file.ts");
  });

  test("matches file and directory path arguments relative to the invocation directory", () => {
    expect(
      pathMatchesPlasticPathspecs(
        "src/lib/file.ts",
        undefined,
        ["lib"],
        "/repo/src",
        "/repo",
      ),
    ).toBe(true);
    expect(
      pathMatchesPlasticPathspecs(
        "src/lib/file.ts",
        undefined,
        ["docs"],
        "/repo",
        "/repo",
      ),
    ).toBe(false);
  });

  test("matches either side of a move", () => {
    expect(
      pathMatchesPlasticPathspecs(
        "new/place.ts",
        "old/place.ts",
        ["old"],
        "/repo",
        "/repo",
      ),
    ).toBe(true);
  });
});
