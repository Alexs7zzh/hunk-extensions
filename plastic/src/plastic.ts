import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import type { PlasticCommandRunner } from "./process";

export interface PlasticWorkspaceChange {
  code: string;
  path: string;
  oldPath?: string;
  revisionType: string;
  size?: string;
  lastModified?: string;
  baseRevisionId?: string;
  baseItemType?: string;
}

export interface PlasticWorkspaceStatus {
  changeset: string;
  repository: string;
  server: string;
  changes: PlasticWorkspaceChange[];
}

export interface PlasticRevisionChange {
  status: "A" | "C" | "D" | "M";
  path: string;
  sourcePath?: string;
  destinationPath?: string;
  itemType: string;
  revisionId: string;
  baseRevisionId: string;
  parentRevisionId: string;
  oldItemType?: string;
}

export interface PlasticTreeEntry {
  path: string;
  itemType: string;
  revisionId: string;
}

export interface PlasticWorkspaceFileInfo {
  path: string;
  status: string;
  itemType: string;
}

const FIELD_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";

export const PLASTIC_DIFF_FORMAT =
  [
    "{status}",
    "{path}",
    "{srccmpath}",
    "{dstcmpath}",
    "{type}",
    "{revid}",
    "{baserevid}",
    "{parentrevid}",
  ].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;

export const PLASTIC_LS_FORMAT =
  ["{type}", "{path}", "{revid}"].join(FIELD_SEPARATOR) + RECORD_SEPARATOR;

export const PLASTIC_FILEINFO_FORMAT =
  ["{RelativePath}", "{Status}", "{Type}"].join(FIELD_SEPARATOR) +
  RECORD_SEPARATOR;

function decodeXmlText(value: string) {
  return value.replace(
    /&(lt|gt|amp|quot|apos|#\d+|#x[\da-f]+);/gi,
    (entity, name: string) => {
      const named: Record<string, string> = {
        lt: "<",
        gt: ">",
        amp: "&",
        quot: '"',
        apos: "'",
      };
      const lower = name.toLowerCase();
      if (lower in named) return named[lower]!;
      const radix = lower.startsWith("#x") ? 16 : 10;
      const digits = lower.slice(radix === 16 ? 2 : 1);
      const codePoint = Number.parseInt(digits, radix);
      return Number.isSafeInteger(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : entity;
    },
  );
}

function xmlElement(
  xml: string,
  name: string,
  required = false,
  preserveWhitespace = false,
) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const full = xml.match(
    new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, "i"),
  );
  if (full) {
    const value = decodeXmlText(full[1] ?? "");
    return preserveWhitespace ? value : value.trim();
  }
  if (new RegExp(`<${escaped}(?:\\s[^>]*)?\\s*\\/>`, "i").test(xml)) return "";
  if (required)
    throw new Error(`Plastic returned status XML without <${name}>.`);
  return "";
}

export function normalizeRepoPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function parsePlasticStatusXml(xml: string): PlasticWorkspaceStatus {
  const source = xml.replace(/^\uFEFF/, "");
  if (!/<StatusOutput(?:\s[^>]*)?>/i.test(source)) {
    throw new Error("Plastic returned malformed status XML.");
  }
  const rawChanges = [
    ...source.matchAll(/<Change(?:\s[^>]*)?>([\s\S]*?)<\/Change>/gi),
  ];

  return {
    changeset: xmlElement(source, "Changeset", true),
    repository: xmlElement(source, "Name", true),
    server: xmlElement(source, "Server", true),
    changes: rawChanges.map((match) => {
      const raw = match[1] ?? "";
      const path = normalizeRepoPath(xmlElement(raw, "Path", true, true));
      const oldPath = normalizeRepoPath(
        xmlElement(raw, "OldPath", false, true),
      );
      const size = xmlElement(raw, "Size");
      const lastModified = xmlElement(raw, "LastModified");
      return {
        code: xmlElement(raw, "Type", true),
        path,
        ...(oldPath ? { oldPath } : {}),
        revisionType: xmlElement(raw, "RevisionType"),
        ...(size ? { size } : {}),
        ...(lastModified ? { lastModified } : {}),
      };
    }),
  };
}

function unquotePlasticField(field: string) {
  const value = field;
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('""', '"');
  }
  return value;
}

export function parsePlasticDiffInventory(
  output: string,
): PlasticRevisionChange[] {
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\r?\n+|\r?\n+$/g, ""))
    .filter(Boolean)
    .map((record) => {
      const fields = record.split(FIELD_SEPARATOR);
      if (fields.length !== 8) {
        throw new Error(
          `Plastic returned a malformed diff inventory record with ${fields.length} fields.`,
        );
      }
      const status = fields[0]?.trim();
      if (
        status !== "A" &&
        status !== "C" &&
        status !== "D" &&
        status !== "M"
      ) {
        throw new Error(
          `Plastic returned unsupported diff status ${JSON.stringify(status)}.`,
        );
      }
      const sourcePath = normalizeRepoPath(
        unquotePlasticField(fields[2] ?? ""),
      );
      const destinationPath = normalizeRepoPath(
        unquotePlasticField(fields[3] ?? ""),
      );
      return {
        status,
        path: normalizeRepoPath(unquotePlasticField(fields[1] ?? "")),
        ...(sourcePath ? { sourcePath } : {}),
        ...(destinationPath ? { destinationPath } : {}),
        itemType: (fields[4] ?? "").trim(),
        revisionId: (fields[5] ?? "").trim(),
        baseRevisionId: (fields[6] ?? "").trim(),
        parentRevisionId: (fields[7] ?? "").trim(),
      };
    });
}

export function parsePlasticTreeEntries(output: string): PlasticTreeEntry[] {
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\r?\n+|\r?\n+$/g, ""))
    .filter(Boolean)
    .map((record) => {
      const fields = record.split(FIELD_SEPARATOR);
      if (fields.length !== 3) {
        throw new Error(
          `Plastic returned a malformed tree record with ${fields.length} fields.`,
        );
      }
      const revisionId = (fields[2] ?? "").trim();
      if (!/^\d+$/.test(revisionId)) {
        throw new Error(
          `Plastic returned invalid revision id ${JSON.stringify(revisionId)}.`,
        );
      }
      return {
        itemType: (fields[0] ?? "").trim(),
        path: normalizeRepoPath(unquotePlasticField(fields[1] ?? "")),
        revisionId,
      };
    });
}

export function parsePlasticWorkspaceFileInfo(
  output: string,
): PlasticWorkspaceFileInfo[] {
  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.replace(/^\r?\n+|\r?\n+$/g, ""))
    .filter(Boolean)
    .map((record) => {
      const fields = record.split(FIELD_SEPARATOR);
      if (fields.length !== 3) {
        throw new Error(
          `Plastic returned malformed file information with ${fields.length} fields.`,
        );
      }
      return {
        path: normalizeRepoPath(unquotePlasticField(fields[0] ?? "")),
        status: (fields[1] ?? "").trim().toLowerCase(),
        itemType: (fields[2] ?? "").trim(),
      };
    });
}

export function findPlasticRepoRoot(cwd: string) {
  let current = resolve(cwd);
  for (;;) {
    if (existsSync(resolve(current, ".plastic"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function readPlasticWorkspaceStatus(
  runner: PlasticCommandRunner,
  repoRoot: string,
  signal?: AbortSignal,
) {
  const output = await runner.run(
    ["status", "--all", "--iscochanged", "--xml", "--encoding=utf-8"],
    repoRoot,
    signal,
  );
  return parsePlasticStatusXml(output.toString("utf8"));
}

export function readPlasticWorkspaceStatusSync(
  runner: PlasticCommandRunner,
  repoRoot: string,
) {
  const output = runner.runSync(
    ["status", "--all", "--iscochanged", "--xml", "--encoding=utf-8"],
    repoRoot,
  );
  return parsePlasticStatusXml(output.toString("utf8"));
}

export async function readPlasticWorkspaceHeader(
  runner: PlasticCommandRunner,
  repoRoot: string,
  signal?: AbortSignal,
) {
  const output = await runner.run(
    ["status", "--header", "--xml", "--encoding=utf-8"],
    repoRoot,
    signal,
  );
  return parsePlasticStatusXml(output.toString("utf8"));
}

export async function readPlasticDiffInventory(
  runner: PlasticCommandRunner,
  repoRoot: string,
  specs: readonly string[],
  signal?: AbortSignal,
) {
  const output = await runner.run(
    [
      "diff",
      ...specs,
      "--repositorypaths",
      `--format=${PLASTIC_DIFF_FORMAT}`,
      "--encoding=utf-8",
    ],
    repoRoot,
    signal,
  );
  return parsePlasticDiffInventory(output.toString("utf8"));
}

export async function readPlasticTreeEntries(
  runner: PlasticCommandRunner,
  repoRoot: string,
  tree: string,
  paths: readonly string[],
  signal?: AbortSignal,
) {
  if (!paths.length) return [];
  const output = await runner.run(
    [
      "ls",
      ...paths.map((path) => `/${normalizeRepoPath(path)}`),
      `--tree=${tree}`,
      "-R",
      `--format=${PLASTIC_LS_FORMAT}`,
    ],
    repoRoot,
    signal,
  );
  return parsePlasticTreeEntries(output.toString("utf8"));
}

export async function readPlasticWorkspaceFileInfo(
  runner: PlasticCommandRunner,
  repoRoot: string,
  absolutePaths: readonly string[],
  signal?: AbortSignal,
) {
  const result: PlasticWorkspaceFileInfo[] = [];
  for (let start = 0; start < absolutePaths.length; start += 128) {
    const paths = absolutePaths.slice(start, start + 128);
    const output = await runner.run(
      [
        "fileinfo",
        ...paths,
        "--symlink",
        `--format=${PLASTIC_FILEINFO_FORMAT}`,
      ],
      repoRoot,
      signal,
    );
    result.push(...parsePlasticWorkspaceFileInfo(output.toString("utf8")));
  }
  return result;
}

export async function resolvePlasticChangesetPair(
  runner: PlasticCommandRunner,
  repoRoot: string,
  spec: string,
  signal?: AbortSignal,
) {
  const resolved = (
    await runner.run(
      ["log", spec, "--csformat={changesetid}", "--itemformat="],
      repoRoot,
      signal,
    )
  )
    .toString("utf8")
    .trim();
  if (!/^\d+$/.test(resolved)) {
    throw new Error(
      `Plastic could not resolve ${JSON.stringify(spec)} to one changeset.`,
    );
  }
  const parent = (
    await runner.run(
      [
        "find",
        "changeset",
        `where changesetid = ${resolved} and returnparent = 'true'`,
        "--format={changesetid}",
        "--nototal",
      ],
      repoRoot,
      signal,
    )
  )
    .toString("utf8")
    .trim();
  if (!/^\d+$/.test(parent)) {
    throw new Error(
      `Plastic did not report a parent for changeset ${resolved}.`,
    );
  }
  return { from: `cs:${parent}`, to: `cs:${resolved}` };
}

export function pathMatchesPlasticPathspecs(
  path: string,
  previousPath: string | undefined,
  pathspecs: readonly string[] | undefined,
  cwd: string,
  repoRoot: string,
) {
  if (!pathspecs?.length) return true;
  const candidates = [path, previousPath].filter((value): value is string =>
    Boolean(value),
  );
  return pathspecs.some((pathspec) => {
    const absolute = isAbsolute(pathspec)
      ? resolve(pathspec)
      : resolve(cwd, pathspec);
    const fromRoot = normalizeRepoPath(relative(repoRoot, absolute));
    if (fromRoot === "" || fromRoot === ".") return true;
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${sep}`) ||
      fromRoot.startsWith("../")
    ) {
      return false;
    }
    return candidates.some(
      (candidate) =>
        candidate === fromRoot || candidate.startsWith(`${fromRoot}/`),
    );
  });
}
