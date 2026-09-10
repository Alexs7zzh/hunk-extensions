import { lstat, open, readdir, readlink } from "node:fs/promises";
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  HUNK_VCS_DETECTION_BASELINE_PRIORITY,
  HunkExtensionUserError,
  type ExtensionVcsAdapter,
  type ExtensionVcsDiffInput,
  type ExtensionVcsExtraFile,
  type ExtensionVcsFileChangeType,
  type ExtensionVcsShowInput,
  type ExtensionVcsSkippedFile,
} from "hunkdiff/extension";
import {
  buildPlasticFilePatch,
  createPlasticSourceCapability,
  type PlasticBuiltFile,
} from "./patch";
import {
  findPlasticRepoRoot,
  PLASTIC_DIFF_FORMAT,
  pathMatchesPlasticPathspecs,
  readPlasticDiffInventory,
  readPlasticWorkspaceHeader,
  readPlasticWorkspaceStatus,
  readPlasticWorkspaceStatusSync,
  readPlasticTreeEntries,
  readPlasticWorkspaceFileInfo,
  resolvePlasticChangesetPair,
  type PlasticRevisionChange,
  type PlasticTreeEntry,
  type PlasticWorkspaceChange,
  type PlasticWorkspaceStatus,
} from "./plastic";
import {
  PlasticCommandFailure,
  PlasticCommandOutputTooLarge,
  createPlasticCommandRunner,
  type PlasticCommandRunner,
} from "./process";

type PlasticInput = ExtensionVcsDiffInput | ExtensionVcsShowInput;
type PlasticReviewFile = (PlasticBuiltFile | ExtensionVcsSkippedFile) & {
  isUntracked?: boolean;
};

/** Matches Hunk 0.21.1's built-in per-file render ceiling. */
export const PLASTIC_DIFF_FILE_MAX_BYTES = 1_000_000;

/** Matches Hunk 0.21.1's built-in line ceiling for automatically rendered files. */
export const PLASTIC_DIFF_FILE_MAX_LINES = 20_000;

/**
 * Bounds retained source text for one review. Sixteen maximum-size changed
 * files can fit with both sides present; further files remain listed as skipped.
 */
export const PLASTIC_REVIEW_MAX_SOURCE_BYTES = 32_000_000;

class PlasticFileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Plastic file exceeds ${maxBytes} bytes.`);
    this.name = "PlasticFileTooLargeError";
  }
}

export interface PlasticVcsAdapterOptions {
  cmExecutable?: string;
  runner?: PlasticCommandRunner;
}

function firstErrorLine(error: PlasticCommandFailure) {
  const output = error.stderr.trim() || error.stdout.trim();
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? error.message
  );
}

function formatInput(input: PlasticInput) {
  if (input.kind === "show")
    return input.ref ? `hunk show ${input.ref}` : "hunk show";
  if (input.staged) return "hunk diff --staged";
  if (input.rangeEndpoints)
    return `hunk diff ${input.rangeEndpoints.from} ${input.rangeEndpoints.to}`;
  return input.range ? `hunk diff ${input.range}` : "hunk diff";
}

function translatePlasticError(input: PlasticInput, error: unknown): Error {
  if (error instanceof HunkExtensionUserError) return error;
  if (error instanceof PlasticCommandOutputTooLarge) {
    return new HunkExtensionUserError(
      `\`${formatInput(input)}\` produced more Plastic SCM data than Hunk can safely load.`,
      {
        suggestions: [
          `The command output exceeded ${error.maxBytes} bytes. Narrow the review or report the workspace shape if this persists.`,
        ],
      },
    );
  }
  if (error instanceof PlasticCommandFailure) {
    const missing =
      error.cause instanceof Error &&
      "code" in error.cause &&
      error.cause.code === "ENOENT";
    if (missing) {
      return new HunkExtensionUserError(
        `Plastic SCM is required for \`${formatInput(input)}\`, but \`cm\` was not found in PATH.`,
        {
          suggestions: [
            "Install the Plastic SCM command-line client and try again.",
          ],
        },
      );
    }
    return new HunkExtensionUserError(
      `\`${formatInput(input)}\` could not read Plastic SCM.`,
      {
        suggestions: [firstErrorLine(error)],
      },
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function requireRepoRoot(cwd: string) {
  const repoRoot = findPlasticRepoRoot(cwd);
  if (!repoRoot) {
    throw new HunkExtensionUserError(
      `\`${cwd}\` is not inside a Plastic SCM workspace.`,
      {
        suggestions: [
          "Run Hunk from a Plastic workspace, or select another VCS in Hunk config.",
        ],
      },
    );
  }
  return repoRoot;
}

function requireRevision(value: string) {
  if (!value || value.startsWith("-")) {
    throw new HunkExtensionUserError(
      `Plastic refused revision ${JSON.stringify(value)}.`,
      {
        suggestions: [
          "Pass a non-empty changeset, branch, label, or shelveset specification.",
        ],
      },
    );
  }
  return value;
}

function isDirectoryType(type: string) {
  const normalized = type.toLowerCase();
  return normalized === "d" || normalized.includes("dir");
}

function isBinaryType(type: string) {
  const normalized = type.toLowerCase();
  return (
    normalized === "b" ||
    normalized === "bin" ||
    normalized === "file" ||
    normalized.includes("binary")
  );
}

function isSymlinkType(type: string) {
  const normalized = type.toLowerCase();
  return (
    normalized === "s" ||
    normalized === "link" ||
    normalized.includes("symlink")
  );
}

function modeForItemType(type: string | undefined) {
  return type && isSymlinkType(type) ? "120000" : "100644";
}

function isDirectory(change: PlasticWorkspaceChange) {
  return isDirectoryType(change.revisionType);
}

type WorkspaceChangeKind =
  "change" | "new" | "deleted" | "moved" | "private" | "skip";

function workspaceChangeType(
  kind: Exclude<WorkspaceChangeKind, "private" | "skip">,
): ExtensionVcsFileChangeType {
  switch (kind) {
    case "new":
      return "new";
    case "deleted":
      return "deleted";
    case "moved":
      return "rename-changed";
    case "change":
      return "change";
  }
}

function skippedFile(
  path: string,
  previousPath: string | undefined,
  changeType: ExtensionVcsFileChangeType,
): ExtensionVcsSkippedFile {
  return {
    kind: "skipped",
    path,
    ...(previousPath ? { previousPath } : {}),
    reason: "too-large",
    changeType,
  };
}

export function classifyPlasticWorkspaceChange(
  change: PlasticWorkspaceChange,
): WorkspaceChangeKind {
  if (isDirectory(change)) return "skip";
  return classifyPlasticWorkspaceCode(change);
}

function classifyPlasticWorkspaceCode(
  change: PlasticWorkspaceChange,
): WorkspaceChangeKind {
  const codes = new Set(change.code.split("+"));
  if (codes.has("PR")) return "private";
  if (codes.has("LD") || codes.has("DE")) return "deleted";
  if (codes.has("LM") || codes.has("MV")) return "moved";
  if (codes.has("AD") || codes.has("CP")) return "new";
  if (codes.has("CH") || codes.has("HD") || codes.has("RP")) return "change";
  if (codes.has("CO") || codes.has("IG")) return "skip";
  throw new HunkExtensionUserError(
    `Plastic reported unsupported workspace status ${JSON.stringify(change.code)} for ${JSON.stringify(change.path)}.`,
    {
      suggestions: [
        "Check `cm status --all` and review this item with Plastic's diff tool.",
      ],
    },
  );
}

function localPath(repoRoot: string, repoPath: string) {
  const absolute = resolve(repoRoot, repoPath);
  const fromRoot = relative(repoRoot, absolute);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(
      `Plastic returned a path outside its workspace: ${JSON.stringify(repoPath)}.`,
    );
  }
  return absolute;
}

async function readWorkspaceBase(
  runner: PlasticCommandRunner,
  repoRoot: string,
  revisionId: string,
  itemType: string,
  workspace: PlasticWorkspaceStatus,
  signal?: AbortSignal,
) {
  return readRevisionContent(
    runner,
    repoRoot,
    workspace,
    revisionId,
    itemType,
    signal,
  );
}

async function buildWorkspaceFile(
  runner: PlasticCommandRunner,
  repoRoot: string,
  status: PlasticWorkspaceStatus,
  change: PlasticWorkspaceChange,
  kind: Exclude<WorkspaceChangeKind, "private" | "skip">,
  signal?: AbortSignal,
) {
  const previousPath = kind === "moved" ? change.oldPath : undefined;
  if (kind === "moved" && !previousPath) {
    throw new Error(
      `Plastic did not report the old path for moved file ${JSON.stringify(change.path)}.`,
    );
  }
  try {
    const oldContent =
      kind === "new"
        ? null
        : await readWorkspaceBase(
            runner,
            repoRoot,
            change.baseRevisionId ?? "",
            change.baseItemType ?? change.revisionType,
            status,
            signal,
          );
    const newContent =
      kind === "deleted"
        ? null
        : await readWorkspaceContent(repoRoot, change.path, signal);
    if (fileExceedsLineLimit(oldContent) || fileExceedsLineLimit(newContent)) {
      return skippedFile(
        change.path,
        previousPath,
        workspaceChangeType(kind),
      );
    }
    return buildPlasticFilePatch({
      path: change.path,
      ...(previousPath ? { previousPath } : {}),
      oldContent,
      newContent,
      declaredBinary: isBinaryType(change.revisionType),
      oldMode: modeForItemType(change.baseItemType ?? change.revisionType),
      newMode: modeForItemType(change.revisionType),
    });
  } catch (error) {
    if (error instanceof PlasticFileTooLargeError) {
      return skippedFile(
        change.path,
        previousPath,
        workspaceChangeType(kind),
      );
    }
    throw error;
  }
}

function fileExceedsLineLimit(content: Buffer | null) {
  if (content === null || content.byteLength === 0) return false;
  let lines = 0;
  for (const byte of content) {
    if (byte === 0x0a && ++lines > PLASTIC_DIFF_FILE_MAX_LINES) return true;
  }
  return content.at(-1) !== 0x0a && ++lines > PLASTIC_DIFF_FILE_MAX_LINES;
}

async function readFileWithLimit(
  path: string,
  signal: AbortSignal | undefined,
  maxBytes: number,
) {
  const handle = await open(path, "r");
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maxBytes + 1 - bytes),
      );
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) return Buffer.concat(chunks, bytes);
      bytes += bytesRead;
      if (bytes > maxBytes) throw new PlasticFileTooLargeError(maxBytes);
      chunks.push(chunk.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
}

async function readWorkspaceContent(
  repoRoot: string,
  path: string,
  signal?: AbortSignal,
) {
  const absolute = localPath(repoRoot, path);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    const content = Buffer.from(await readlink(absolute));
    if (content.byteLength > PLASTIC_DIFF_FILE_MAX_BYTES) {
      throw new PlasticFileTooLargeError(PLASTIC_DIFF_FILE_MAX_BYTES);
    }
    return content;
  }
  if (stat.size > PLASTIC_DIFF_FILE_MAX_BYTES) {
    throw new PlasticFileTooLargeError(PLASTIC_DIFF_FILE_MAX_BYTES);
  }
  return readFileWithLimit(absolute, signal, PLASTIC_DIFF_FILE_MAX_BYTES);
}

function pathIsWithin(path: string, directory: string) {
  return path === directory || path.startsWith(`${directory}/`);
}

function movePath(path: string, from: string, to: string) {
  return `${to}${path.slice(from.length)}`;
}

async function listLocalFiles(repoRoot: string, directory: string) {
  const files: string[] = [];
  const visit = async (repoPath: string): Promise<void> => {
    const entries = await readdir(localPath(repoRoot, repoPath), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const child = repoPath ? `${repoPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(child);
      else files.push(child);
    }
  };
  await visit(directory);
  return files;
}

function fileTreeEntries(
  entries: readonly PlasticTreeEntry[],
  directory: string,
) {
  return entries.filter(
    (entry) =>
      pathIsWithin(entry.path, directory) && !isDirectoryType(entry.itemType),
  );
}

async function expandWorkspaceChanges(
  runner: PlasticCommandRunner,
  repoRoot: string,
  status: PlasticWorkspaceStatus,
  signal?: AbortSignal,
) {
  const basePaths = status.changes.flatMap((change) => {
    const kind = classifyPlasticWorkspaceCode(change);
    if (kind === "new" || kind === "private" || kind === "skip") return [];
    if (kind === "moved" && !change.oldPath) {
      throw new Error(
        `Plastic did not report the old path for moved item ${JSON.stringify(change.path)}.`,
      );
    }
    return [kind === "moved" ? change.oldPath! : change.path];
  });
  const baseEntries = await readPlasticTreeEntries(
    runner,
    repoRoot,
    `cs:${status.changeset}`,
    [...new Set(basePaths)],
    signal,
  );
  const baseByPath = new Map(
    baseEntries.map((entry) => [entry.path, entry] as const),
  );
  const synthesized: PlasticWorkspaceChange[] = [];
  const direct: PlasticWorkspaceChange[] = [];
  const directlyMovedOldPaths = new Set(
    status.changes.flatMap((change) =>
      !isDirectory(change) &&
      classifyPlasticWorkspaceCode(change) === "moved" &&
      change.oldPath
        ? [change.oldPath]
        : [],
    ),
  );

  for (const change of status.changes) {
    const kind = classifyPlasticWorkspaceCode(change);
    if (!isDirectory(change)) {
      const oldPath = kind === "moved" ? change.oldPath : change.path;
      const base = oldPath ? baseByPath.get(oldPath) : undefined;
      direct.push({
        ...change,
        ...(base
          ? {
              baseRevisionId: base.revisionId,
              baseItemType: base.itemType,
            }
          : {}),
      });
      continue;
    }
    if (kind === "skip") continue;
    if (kind === "private" || kind === "new") {
      const { oldPath: _oldPath, ...directoryChange } = change;
      const localFiles = await listLocalFiles(repoRoot, change.path);
      const fileInfo = await readPlasticWorkspaceFileInfo(
        runner,
        repoRoot,
        localFiles.map((path) => localPath(repoRoot, path)),
        signal,
      );
      for (const info of fileInfo) {
        const matchesKind =
          kind === "private"
            ? info.status === "private"
            : info.status === "added" || info.status === "copied";
        if (!matchesKind || !pathIsWithin(info.path, change.path)) continue;
        synthesized.push({
          ...directoryChange,
          path: info.path,
          revisionType: info.itemType,
        });
      }
      continue;
    }
    const oldDirectory = kind === "moved" ? change.oldPath : change.path;
    if (!oldDirectory) {
      throw new Error(
        `Plastic did not report the old path for moved directory ${JSON.stringify(change.path)}.`,
      );
    }
    const { oldPath: _oldPath, ...directoryChange } = change;
    for (const entry of fileTreeEntries(baseEntries, oldDirectory)) {
      if (directlyMovedOldPaths.has(entry.path)) continue;
      synthesized.push({
        ...directoryChange,
        path:
          kind === "moved"
            ? movePath(entry.path, oldDirectory, change.path)
            : entry.path,
        ...(kind === "moved" ? { oldPath: entry.path } : {}),
        revisionType: entry.itemType,
        baseRevisionId: entry.revisionId,
        baseItemType: entry.itemType,
      });
    }
  }

  const byPath = new Map<string, PlasticWorkspaceChange>();
  for (const change of synthesized) byPath.set(change.path, change);
  for (const change of direct) {
    const structural = byPath.get(change.path);
    if (
      structural &&
      classifyPlasticWorkspaceCode(structural) === "moved" &&
      classifyPlasticWorkspaceCode(change) === "change"
    ) {
      byPath.set(change.path, {
        ...change,
        code: structural.code,
        oldPath: structural.oldPath!,
        baseRevisionId: change.baseRevisionId ?? structural.baseRevisionId!,
        baseItemType: change.baseItemType ?? structural.baseItemType!,
      });
    } else {
      byPath.set(change.path, change);
    }
  }
  return [...byPath.values()];
}

function revisionPaths(change: PlasticRevisionChange) {
  if (change.status === "M") {
    return {
      path: change.destinationPath ?? change.path,
      previousPath: change.sourcePath ?? change.path,
    };
  }
  return { path: change.path, previousPath: undefined };
}

function coalesceRevisionChanges(changes: readonly PlasticRevisionChange[]) {
  const additions = new Map<string, PlasticRevisionChange>();
  const deletions = new Map<string, PlasticRevisionChange>();
  for (const change of changes) {
    const path = revisionPaths(change).path;
    if (change.status === "A") additions.set(path, change);
    if (change.status === "D") deletions.set(path, change);
  }
  const emittedReplacements = new Set<string>();
  const normalized: PlasticRevisionChange[] = [];
  for (const change of changes) {
    const path = revisionPaths(change).path;
    const addition = additions.get(path);
    const deletion = deletions.get(path);
    if (addition && deletion) {
      if (!emittedReplacements.has(path)) {
        emittedReplacements.add(path);
        normalized.push({
          status: "C",
          path,
          itemType: addition.itemType,
          oldItemType: deletion.itemType,
          revisionId: addition.revisionId,
          baseRevisionId: deletion.revisionId,
          parentRevisionId: deletion.revisionId,
        });
      }
      continue;
    }
    normalized.push(change);
  }

  const contentByPath = new Map<string, PlasticRevisionChange>();
  const firstMoveByPath = new Map<string, PlasticRevisionChange>();
  for (const change of normalized) {
    const path = revisionPaths(change).path;
    if (change.status === "C" && !contentByPath.has(path)) {
      contentByPath.set(path, change);
    }
    if (change.status === "M" && !firstMoveByPath.has(path)) {
      firstMoveByPath.set(path, change);
    }
  }

  const consumedContent = new Set<PlasticRevisionChange>();
  for (const [path] of firstMoveByPath) {
    const content = contentByPath.get(path);
    if (content) consumedContent.add(content);
  }
  const combined: PlasticRevisionChange[] = [];
  for (const change of normalized) {
    const path = revisionPaths(change).path;
    if (change.status === "M") {
      if (firstMoveByPath.get(path) !== change) continue;
      const content = contentByPath.get(path);
      const oldRevision =
        content?.baseRevisionId && content.baseRevisionId !== "-1"
          ? content.baseRevisionId
          : change.baseRevisionId !== "-1"
            ? change.baseRevisionId
            : change.parentRevisionId;
      combined.push({
        ...change,
        itemType: content?.itemType ?? change.itemType,
        oldItemType:
          content?.oldItemType ?? change.oldItemType ?? change.itemType,
        revisionId: content?.revisionId ?? change.revisionId,
        baseRevisionId: oldRevision,
        parentRevisionId: oldRevision,
      });
      continue;
    }
    if (change.status === "C" && consumedContent.has(change)) continue;
    combined.push(change);
  }

  const byPath = new Map<string, PlasticRevisionChange>();
  for (const change of combined) {
    const path = revisionPaths(change).path;
    if (!byPath.has(path)) byPath.set(path, change);
  }
  return [...byPath.values()];
}

function entriesByRelativePath(
  entries: readonly PlasticTreeEntry[],
  directory: string,
) {
  return new Map(
    fileTreeEntries(entries, directory).map((entry) => [
      entry.path.slice(directory.length + 1),
      entry,
    ]),
  );
}

async function expandRevisionChanges(
  runner: PlasticCommandRunner,
  repoRoot: string,
  specs: readonly string[],
  changes: readonly PlasticRevisionChange[],
  signal?: AbortSignal,
) {
  const directories = changes.filter((change) =>
    isDirectoryType(change.itemType),
  );
  const files = changes.filter((change) => !isDirectoryType(change.itemType));
  if (!directories.length) return coalesceRevisionChanges(files);
  const directMoves = coalesceRevisionChanges(files).filter(
    (change) => change.status === "M",
  );
  const directlyMovedOldPaths = new Set(
    directMoves.map((change) => revisionPaths(change).previousPath!),
  );
  const directlyMovedNewPaths = new Set(
    directMoves.map((change) => revisionPaths(change).path),
  );

  const trees =
    specs.length === 2
      ? { from: specs[0]!, to: specs[1]! }
      : await resolvePlasticChangesetPair(runner, repoRoot, specs[0]!, signal);
  const oldPaths = directories.flatMap((change) => {
    if (change.status === "A") return [];
    const paths = revisionPaths(change);
    return [paths.previousPath ?? paths.path];
  });
  const newPaths = directories.flatMap((change) => {
    if (change.status === "D") return [];
    return [revisionPaths(change).path];
  });
  const [oldEntries, newEntries] = await Promise.all([
    readPlasticTreeEntries(
      runner,
      repoRoot,
      trees.from,
      [...new Set(oldPaths)],
      signal,
    ),
    readPlasticTreeEntries(
      runner,
      repoRoot,
      trees.to,
      [...new Set(newPaths)],
      signal,
    ),
  ]);
  const synthesized: PlasticRevisionChange[] = [];

  for (const directory of directories) {
    const paths = revisionPaths(directory);
    const oldDirectory = paths.previousPath ?? paths.path;
    const newDirectory = paths.path;
    const oldFiles = entriesByRelativePath(oldEntries, oldDirectory);
    const newFiles = entriesByRelativePath(newEntries, newDirectory);
    const relativePaths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
    for (const relativePath of relativePaths) {
      const oldEntry = oldFiles.get(relativePath);
      const newEntry = newFiles.get(relativePath);
      if (
        (oldEntry && directlyMovedOldPaths.has(oldEntry.path)) ||
        (newEntry && directlyMovedNewPaths.has(newEntry.path))
      ) {
        continue;
      }
      if (!oldEntry && newEntry) {
        synthesized.push({
          status: "A",
          path: newEntry.path,
          itemType: newEntry.itemType,
          revisionId: newEntry.revisionId,
          baseRevisionId: "-1",
          parentRevisionId: "-1",
        });
      } else if (oldEntry && !newEntry) {
        synthesized.push({
          status: "D",
          path: oldEntry.path,
          itemType: oldEntry.itemType,
          revisionId: oldEntry.revisionId,
          baseRevisionId: "-1",
          parentRevisionId: "-1",
        });
      } else if (oldEntry && newEntry) {
        const moved =
          directory.status === "M" || oldEntry.path !== newEntry.path;
        synthesized.push({
          status: moved ? "M" : "C",
          path: newEntry.path,
          ...(moved
            ? {
                sourcePath: oldEntry.path,
                destinationPath: newEntry.path,
              }
            : {}),
          itemType: newEntry.itemType,
          revisionId: newEntry.revisionId,
          baseRevisionId: oldEntry.revisionId,
          parentRevisionId: oldEntry.revisionId,
        });
      }
    }
  }
  return coalesceRevisionChanges([...files, ...synthesized]);
}

function revisionSpec(revisionId: string, status: PlasticWorkspaceStatus) {
  if (!/^\d+$/.test(revisionId)) {
    throw new Error(
      `Plastic returned invalid revision id ${JSON.stringify(revisionId)}.`,
    );
  }
  if (
    status.repository.includes(";") ||
    status.server.includes(";") ||
    /[\r\n]/.test(status.repository) ||
    /[\r\n]/.test(status.server)
  ) {
    throw new Error("Plastic returned an unsafe repository specification.");
  }
  return `revid:${revisionId}@rep:${status.repository}@repserver:${status.server}`;
}

async function buildRevisionFile(
  runner: PlasticCommandRunner,
  repoRoot: string,
  workspace: PlasticWorkspaceStatus,
  change: PlasticRevisionChange,
  signal?: AbortSignal,
) {
  const paths = revisionPaths(change);
  const previousPath =
    change.status === "M" ? (paths.previousPath ?? paths.path) : undefined;
  const oldRevision =
    change.status === "D"
      ? change.revisionId
      : change.status === "M" && change.baseRevisionId === "-1"
        ? change.parentRevisionId
        : change.baseRevisionId;
  const newRevision = change.status === "D" ? "-1" : change.revisionId;
  const oldItemType = change.oldItemType ?? change.itemType;
  const changeType: ExtensionVcsFileChangeType =
    change.status === "A"
      ? "new"
      : change.status === "D"
        ? "deleted"
        : change.status === "M"
          ? "rename-changed"
          : "change";
  try {
    const oldContent =
      change.status === "A" || oldRevision === "-1"
        ? null
        : await readRevisionContent(
            runner,
            repoRoot,
            workspace,
            oldRevision,
            oldItemType,
            signal,
          );
    const newContent =
      change.status === "D" || newRevision === "-1"
        ? null
        : await readRevisionContent(
            runner,
            repoRoot,
            workspace,
            newRevision,
            change.itemType,
            signal,
          );
    if (fileExceedsLineLimit(oldContent) || fileExceedsLineLimit(newContent)) {
      return skippedFile(paths.path, previousPath, changeType);
    }
    return buildPlasticFilePatch({
      path: paths.path,
      ...(previousPath ? { previousPath } : {}),
      oldContent,
      newContent,
      declaredBinary:
        isBinaryType(change.itemType) || isBinaryType(oldItemType),
      oldMode: modeForItemType(oldItemType),
      newMode: modeForItemType(change.itemType),
    });
  } catch (error) {
    if (error instanceof PlasticFileTooLargeError) {
      return skippedFile(paths.path, previousPath, changeType);
    }
    throw error;
  }
}

async function readRevisionContent(
  runner: PlasticCommandRunner,
  repoRoot: string,
  workspace: PlasticWorkspaceStatus,
  revisionId: string,
  itemType: string,
  signal?: AbortSignal,
) {
  try {
    const content = await runner.run(
      [
        "cat",
        revisionSpec(revisionId, workspace),
        ...(isSymlinkType(itemType) ? ["--symlink"] : []),
      ],
      repoRoot,
      signal,
      PLASTIC_DIFF_FILE_MAX_BYTES,
    );
    if (content.byteLength > PLASTIC_DIFF_FILE_MAX_BYTES) {
      throw new PlasticFileTooLargeError(PLASTIC_DIFF_FILE_MAX_BYTES);
    }
    return content;
  } catch (error) {
    if (error instanceof PlasticCommandOutputTooLarge) {
      throw new PlasticFileTooLargeError(error.maxBytes);
    }
    throw error;
  }
}

function contextSignal(context: { cwd: string }) {
  return (context as { cwd: string; signal?: AbortSignal }).signal;
}

function isBuiltFile(file: PlasticReviewFile): file is PlasticBuiltFile {
  return !("kind" in file);
}

async function mapFiles<T>(
  values: readonly T[],
  callback: (value: T) => Promise<PlasticReviewFile | null>,
) {
  // Four clients keep multi-file reviews responsive without launching one `cm cat`
  // process per changed file. Fixed-size batches make the retained-byte choice
  // deterministic in review order while bounding in-flight source data too.
  const results = new Array<PlasticReviewFile | null>(values.length);
  let retainedSourceBytes = 0;
  for (let start = 0; start < values.length; start += 4) {
    const batch = await Promise.all(
      values.slice(start, start + 4).map(callback),
    );
    for (const [offset, file] of batch.entries()) {
      const index = start + offset;
      if (
        file !== null &&
        isBuiltFile(file) &&
        retainedSourceBytes + file.sourceBytes >
          PLASTIC_REVIEW_MAX_SOURCE_BYTES
      ) {
        results[index] = {
          ...skippedFile(file.path, file.previousPath, file.changeType),
          ...(file.isUntracked ? { isUntracked: true } : {}),
        };
        continue;
      }
      if (file !== null && isBuiltFile(file)) {
        retainedSourceBytes += file.sourceBytes;
      }
      results[index] = file;
    }
  }
  return results;
}

function toExtraFiles(
  files: readonly PlasticReviewFile[],
): ExtensionVcsExtraFile[] {
  // Compare path components with directories first, so each folder stays together
  // even when Plastic groups its inventory by change status.
  const ordered = [...files].sort((left, right) => {
    const a = left.path.split("/");
    const b = right.path.split("/");
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      const aDirectory = index < a.length - 1;
      const bDirectory = index < b.length - 1;
      if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
      if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
    }
    return a.length - b.length;
  });
  return ordered.map((file) =>
    isBuiltFile(file)
      ? {
          kind: "patch",
          path: file.path,
          ...(file.previousPath ? { previousPath: file.previousPath } : {}),
          patchText: file.patchText,
          ...(file.isUntracked ? { isUntracked: true } : {}),
        }
      : file,
  );
}

function sourceCapability(files: readonly PlasticReviewFile[]) {
  return createPlasticSourceCapability(files.filter(isBuiltFile));
}

function workspacePathSignature(repoRoot: string, repoPath: string) {
  const entries: Array<{
    path: string;
    type: "directory" | "file" | "symlink";
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    target?: string;
  }> = [];
  const visit = (path: string) => {
    const absolute = localPath(repoRoot, path);
    const stat = lstatSync(absolute);
    const type = stat.isSymbolicLink()
      ? "symlink"
      : stat.isDirectory()
        ? "directory"
        : "file";
    entries.push({
      path,
      type,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ...(type === "symlink" ? { target: readlinkSync(absolute) } : {}),
    });
    if (type === "directory") {
      for (const name of readdirSync(absolute).sort()) {
        visit(path ? `${path}/${name}` : name);
      }
    }
  };
  try {
    visit(repoPath);
    return entries;
  } catch {
    return null;
  }
}

function stableWorkspaceSignature(
  status: PlasticWorkspaceStatus,
  repoRoot: string,
) {
  return JSON.stringify({
    changeset: status.changeset,
    repository: status.repository,
    server: status.server,
    changes: status.changes.map(
      ({ code, path, oldPath, revisionType, size, lastModified }) => {
        return {
          code,
          path,
          oldPath,
          revisionType,
          size,
          lastModified,
          worktree: workspacePathSignature(repoRoot, path),
        };
      },
    ),
  });
}

function inputSpecs(input: ExtensionVcsDiffInput) {
  if (input.rangeEndpoints) {
    return [
      requireRevision(input.rangeEndpoints.from),
      requireRevision(input.rangeEndpoints.to),
    ];
  }
  return input.range ? [requireRevision(input.range)] : [];
}

export function createPlasticVcsAdapter({
  cmExecutable = "cm",
  runner = createPlasticCommandRunner(cmExecutable),
}: Readonly<PlasticVcsAdapterOptions> = {}) {
  return {
    id: "plastic",
    name: "Plastic SCM",
    detect(cwd) {
      const repoRoot = findPlasticRepoRoot(cwd);
      return repoRoot ? { id: "plastic", repoRoot } : null;
    },
    // A Plastic workspace can contain `.git` for editor and agent tooling. Plastic
    // is authoritative when both markers name the same root, so it must rank above jj (200).
    detectionPriority: HUNK_VCS_DETECTION_BASELINE_PRIORITY + 300,
    operations: {
      "working-tree-diff": {
        async load(input, context) {
          const { cwd } = context;
          const signal = contextSignal(context);
          try {
            if (input.staged) {
              throw new HunkExtensionUserError(
                "Plastic SCM has no staging area, so `hunk diff --staged` is unavailable.",
                { suggestions: ["Run `hunk diff` without `--staged`."] },
              );
            }
            const repoRoot = requireRepoRoot(cwd);
            const specs = inputSpecs(input);
            if (specs.length) {
              const workspace = await readPlasticWorkspaceHeader(
                runner,
                repoRoot,
                signal,
              );
              const inventory = (
                await expandRevisionChanges(
                  runner,
                  repoRoot,
                  specs,
                  await readPlasticDiffInventory(
                    runner,
                    repoRoot,
                    specs,
                    signal,
                  ),
                  signal,
                )
              ).filter((change) => {
                const paths = revisionPaths(change);
                return pathMatchesPlasticPathspecs(
                  paths.path,
                  paths.previousPath,
                  input.pathspecs,
                  cwd,
                  repoRoot,
                );
              });
              const built = (
                await mapFiles(inventory, (change) =>
                  buildRevisionFile(
                    runner,
                    repoRoot,
                    workspace,
                    change,
                    signal,
                  ),
                )
              ).filter((file): file is PlasticReviewFile => file !== null);
              return {
                repoRoot,
                sourceLabel: repoRoot,
                title: `${basename(repoRoot)} ${specs.join(" to ")}`,
                patchText: "",
                extraFiles: toExtraFiles(built),
                ...sourceCapability(built),
              };
            }

            const status = await readPlasticWorkspaceStatus(
              runner,
              repoRoot,
              signal,
            );
            const changes = await expandWorkspaceChanges(
              runner,
              repoRoot,
              status,
              signal,
            );
            const selected = changes.filter((change) =>
              pathMatchesPlasticPathspecs(
                change.path,
                change.oldPath,
                input.pathspecs,
                cwd,
                repoRoot,
              ),
            );
            const reviewChanges = selected.flatMap((change) => {
              const kind = classifyPlasticWorkspaceChange(change);
              return kind === "skip" ||
                (kind === "private" && input.options.excludeUntracked)
                ? []
                : [{ change, kind }];
            });
            const built = (
              await mapFiles(reviewChanges, async ({ change, kind }) => {
                const file = await buildWorkspaceFile(
                  runner,
                  repoRoot,
                  status,
                  change,
                  kind === "private" ? "new" : kind,
                  signal,
                );
                return file && kind === "private"
                  ? { ...file, isUntracked: true }
                  : file;
              })
            ).filter((file): file is PlasticReviewFile => file !== null);
            return {
              repoRoot,
              sourceLabel: repoRoot,
              title: `${basename(repoRoot)} working copy`,
              patchText: "",
              extraFiles: toExtraFiles(built),
              ...sourceCapability(built),
            };
          } catch (error) {
            if (signal?.aborted) signal.throwIfAborted();
            throw translatePlasticError(input, error);
          }
        },
        watchSignature(input, { cwd }) {
          try {
            const repoRoot = requireRepoRoot(cwd);
            if (input.range || input.rangeEndpoints) {
              return runner
                .runSync(
                  [
                    "diff",
                    ...inputSpecs(input),
                    "--repositorypaths",
                    `--format=${PLASTIC_DIFF_FORMAT}`,
                    "--encoding=utf-8",
                  ],
                  repoRoot,
                )
                .toString("utf8");
            }
            return stableWorkspaceSignature(
              readPlasticWorkspaceStatusSync(runner, repoRoot),
              repoRoot,
            );
          } catch (error) {
            throw translatePlasticError(input, error);
          }
        },
      },
      "revision-show": {
        async load(input, context) {
          const { cwd } = context;
          const signal = contextSignal(context);
          try {
            const repoRoot = requireRepoRoot(cwd);
            const workspace = await readPlasticWorkspaceHeader(
              runner,
              repoRoot,
              signal,
            );
            const ref = requireRevision(
              input.ref ?? `cs:${workspace.changeset}`,
            );
            const inventory = (
              await expandRevisionChanges(
                runner,
                repoRoot,
                [ref],
                await readPlasticDiffInventory(runner, repoRoot, [ref], signal),
                signal,
              )
            ).filter((change) => {
              const paths = revisionPaths(change);
              return pathMatchesPlasticPathspecs(
                paths.path,
                paths.previousPath,
                input.pathspecs,
                cwd,
                repoRoot,
              );
            });
            const built = (
              await mapFiles(inventory, (change) =>
                buildRevisionFile(runner, repoRoot, workspace, change, signal),
              )
            ).filter((file): file is PlasticReviewFile => file !== null);
            return {
              repoRoot,
              sourceLabel: repoRoot,
              title: `${basename(repoRoot)} show ${ref}`,
              patchText: "",
              extraFiles: toExtraFiles(built),
              ...sourceCapability(built),
            };
          } catch (error) {
            if (signal?.aborted) signal.throwIfAborted();
            throw translatePlasticError(input, error);
          }
        },
      },
    },
  } satisfies ExtensionVcsAdapter;
}

export const PlasticVcsAdapter = createPlasticVcsAdapter();
