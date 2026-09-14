import { lstat, readdir, readlink } from "node:fs/promises";
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  HUNK_VCS_DETECTION_BASELINE_PRIORITY,
  HunkExtensionUserError,
  type ExtensionVcsAdapter,
  type ExtensionVcsDiffInput,
  type ExtensionVcsExtraFile,
  type ExtensionVcsFileChangeType,
  type ExtensionVcsFileStats,
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
import { forEachOrdered, together } from "./concurrency";
import { PlasticDiskCache } from "./cache";
import { PlasticFileTooLargeError, readPlasticFile } from "./files";
import { PlasticReadSession, type PlasticRevisionRead } from "./read-session";

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

export interface PlasticVcsAdapterOptions {
  cmExecutable?: string;
  runner?: PlasticCommandRunner;
  /** Disable persistent caching with false, or override its directory. */
  cacheDirectory?: string | false;
  /** Enables newer host capabilities while keeping API 14 hosts supported. */
  apiVersion?: number;
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
  stats?: ExtensionVcsFileStats,
): ExtensionVcsSkippedFile {
  return {
    kind: "skipped",
    path,
    ...(previousPath ? { previousPath } : {}),
    reason: "too-large",
    changeType,
    ...(stats ? { stats } : { statsTruncated: true }),
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
  // Replaced checkouts can report plain CO even when they differ from the
  // workspace changeset. Let the content comparison discard identical files.
  if (codes.has("CO")) return "change";
  if (codes.has("IG")) return "skip";
  throw new HunkExtensionUserError(
    `Plastic reported unsupported workspace status ${JSON.stringify(change.code)} for ${JSON.stringify(change.path)}.`,
    {
      suggestions: [
        "Check `cm status --all` and review this item with Plastic's diff tool.",
      ],
    },
  );
}

function reportsWorkspaceChange(change: PlasticWorkspaceChange) {
  const codes = new Set(change.code.split("+"));
  return codes.has("CH") || codes.has("HD") || codes.has("RP");
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
    const [newContent, oldContent] = await together([
      kind === "deleted"
        ? Promise.resolve(null)
        : readWorkspaceContent(repoRoot, change.path, signal),
      kind === "new"
        ? Promise.resolve(null)
        : readWorkspaceBase(
            runner,
            repoRoot,
            change.baseRevisionId ?? "",
            change.baseItemType ?? change.revisionType,
            status,
            signal,
          ),
    ]);
    if (fileExceedsLineLimit(oldContent) || fileExceedsLineLimit(newContent)) {
      return skippedFile(change.path, previousPath, workspaceChangeType(kind));
    }
    return buildPlasticFilePatch({
      path: change.path,
      ...(previousPath ? { previousPath } : {}),
      oldContent,
      newContent,
      preserveEmptyChange:
        kind === "change" && reportsWorkspaceChange(change),
      declaredBinary: isBinaryType(change.revisionType),
      oldMode: modeForItemType(change.baseItemType ?? change.revisionType),
      newMode: modeForItemType(change.revisionType),
    });
  } catch (error) {
    if (error instanceof PlasticFileTooLargeError) {
      return skippedFile(change.path, previousPath, workspaceChangeType(kind));
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

async function readWorkspaceContent(
  repoRoot: string,
  path: string,
  signal?: AbortSignal,
) {
  return readPlasticFile(
    localPath(repoRoot, path),
    PLASTIC_DIFF_FILE_MAX_BYTES,
    signal,
  );
}

function pathIsWithin(path: string, directory: string) {
  return path === directory || path.startsWith(`${directory}/`);
}

function movePath(path: string, from: string, to: string) {
  return `${to}${path.slice(from.length)}`;
}

type PathSelection = (
  path: string,
  previousPath: string | undefined,
  directory: boolean,
) => boolean;

function selectPaths(
  input: PlasticInput,
  cwd: string,
  repoRoot: string,
): PathSelection {
  if (!input.pathspecs?.length) return () => true;
  const scopes = input.pathspecs.map((path) =>
    normalizeScope(path, cwd, repoRoot),
  );
  return (path, previousPath, directory) =>
    scopes.some(
      (scope) =>
        scope !== null &&
        (scope === "" ||
          pathIsWithin(path, scope) ||
          (previousPath !== undefined && pathIsWithin(previousPath, scope)) ||
          (directory &&
            (pathIsWithin(scope, path) ||
              (previousPath !== undefined &&
                pathIsWithin(scope, previousPath))))),
    );
}

function normalizeScope(path: string, cwd: string, repoRoot: string) {
  const fromRoot = relative(repoRoot, resolve(cwd, path)).replaceAll("\\", "/");
  return fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)
    ? null
    : fromRoot;
}

async function listLocalFiles(
  repoRoot: string,
  directory: string,
  select: PathSelection,
  signal?: AbortSignal,
) {
  const files: string[] = [];
  const visit = async (repoPath: string): Promise<void> => {
    const entries = await readdir(localPath(repoRoot, repoPath), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      signal?.throwIfAborted();
      const child = repoPath ? `${repoPath}/${entry.name}` : entry.name;
      if (!select(child, undefined, entry.isDirectory())) continue;
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
  select: PathSelection,
  excludeUntracked: boolean,
  signal?: AbortSignal,
) {
  const changes = status.changes.filter(
    (change) =>
      !(
        excludeUntracked && classifyPlasticWorkspaceCode(change) === "private"
      ) && select(change.path, change.oldPath, isDirectory(change)),
  );
  const basePaths = changes.flatMap((change) => {
    const kind = classifyPlasticWorkspaceCode(change);
    if (kind === "new" || kind === "private" || kind === "skip") return [];
    if (kind === "moved" && !change.oldPath) {
      throw new Error(
        `Plastic did not report the old path for moved item ${JSON.stringify(change.path)}.`,
      );
    }
    return [kind === "moved" ? change.oldPath! : change.path];
  });
  const baseEntriesPromise = readPlasticTreeEntries(
    runner,
    repoRoot,
    `cs:${status.changeset}`,
    [...new Set(basePaths)],
    signal,
  );
  // Status --all already reports many directory descendants. Only query the
  // remaining files, across all new/private directories in one fileinfo batch.
  const reportedFiles = new Set(
    status.changes
      .filter((change) => !isDirectory(change))
      .map((change) => change.path),
  );
  const localInfoPromise = (async () => {
    const owners = new Map<string, PlasticWorkspaceChange>();
    for (const change of changes) {
      const kind = classifyPlasticWorkspaceCode(change);
      if (!isDirectory(change) || (kind !== "private" && kind !== "new"))
        continue;
      for (const path of await listLocalFiles(
        repoRoot,
        change.path,
        select,
        signal,
      )) {
        if (!reportedFiles.has(path)) owners.set(path, change);
      }
    }
    const info = await readPlasticWorkspaceFileInfo(
      runner,
      repoRoot,
      [...owners.keys()].map((path) => localPath(repoRoot, path)),
      signal,
    );
    return info.flatMap((entry) => {
      const owner = owners.get(entry.path);
      if (!owner) return [];
      const kind = classifyPlasticWorkspaceCode(owner);
      if (
        !(kind === "private"
          ? entry.status === "private"
          : entry.status === "added" || entry.status === "copied")
      )
        return [];
      const { oldPath: _oldPath, ...change } = owner;
      return [{ ...change, path: entry.path, revisionType: entry.itemType }];
    });
  })();
  const [baseEntries, localChanges] = await Promise.all([
    baseEntriesPromise,
    localInfoPromise,
  ]);
  const baseByPath = new Map(
    baseEntries.map((entry) => [entry.path, entry] as const),
  );
  const synthesized: PlasticWorkspaceChange[] = localChanges;
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

  for (const change of changes) {
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
  select: PathSelection,
  signal?: AbortSignal,
) {
  const directories = changes.filter((change) => {
    const paths = revisionPaths(change);
    return (
      isDirectoryType(change.itemType) &&
      select(paths.path, paths.previousPath, true)
    );
  });
  const allFiles = coalesceRevisionChanges(
    changes.filter((change) => !isDirectoryType(change.itemType)),
  );
  const files = allFiles.filter((change) => {
    const paths = revisionPaths(change);
    return select(paths.path, paths.previousPath, false);
  });
  if (!directories.length) return files;
  const directMoves = allFiles.filter((change) => change.status === "M");
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

function revisionRead(
  status: PlasticWorkspaceStatus,
  revisionId: string,
  itemType: string,
): PlasticRevisionRead {
  return {
    spec: revisionSpec(revisionId, status),
    symlink: isSymlinkType(itemType),
  };
}

function revisionSides(change: PlasticRevisionChange) {
  const oldRevision =
    change.status === "D"
      ? change.revisionId
      : change.status === "M" && change.baseRevisionId === "-1"
        ? change.parentRevisionId
        : change.baseRevisionId;
  return {
    old:
      change.status === "A" || oldRevision === "-1"
        ? null
        : {
            revisionId: oldRevision,
            itemType: change.oldItemType ?? change.itemType,
          },
    new:
      change.status === "D" || change.revisionId === "-1"
        ? null
        : { revisionId: change.revisionId, itemType: change.itemType },
  };
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
  const sides = revisionSides(change);
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
    const [oldContent, newContent] = await together([
      sides.old === null
        ? Promise.resolve(null)
        : readRevisionContent(
            runner,
            repoRoot,
            workspace,
            sides.old.revisionId,
            oldItemType,
            signal,
          ),
      sides.new === null
        ? Promise.resolve(null)
        : readRevisionContent(
            runner,
            repoRoot,
            workspace,
            sides.new.revisionId,
            change.itemType,
            signal,
          ),
    ]);
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
    // Plastic's file-output mode stores symlink targets as BOM-marked UTF-16.
    // Compare the decoded target with readlink(), not that serialized payload.
    if (isSymlinkType(itemType) && content.length >= 2) {
      const encoding =
        content[0] === 0xff && content[1] === 0xfe
          ? "utf-16le"
          : content[0] === 0xfe && content[1] === 0xff
            ? "utf-16be"
            : undefined;
      if (encoding)
        return Buffer.from(
          new TextDecoder(encoding, { fatal: true }).decode(content),
        );
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
  prepare: (values: readonly T[]) => Promise<void>,
) {
  // Prefetch 64 files at a time: at most 128 one-megabyte revision downloads
  // for a two-sided review. Build four patches at a time to bound live buffers
  // and account for the review-wide source budget in deterministic order.
  const results = new Array<PlasticReviewFile | null>(values.length);
  let retainedSourceBytes = 0;
  for (let start = 0; start < values.length; start += 64) {
    const chunk = values.slice(start, start + 64);
    await prepare(chunk);
    await forEachOrdered(chunk, 4, callback, (file, offset) => {
      const index = start + offset;
      if (
        file !== null &&
        isBuiltFile(file) &&
        retainedSourceBytes + file.sourceBytes > PLASTIC_REVIEW_MAX_SOURCE_BYTES
      ) {
        results[index] = {
          ...skippedFile(
            file.path,
            file.previousPath,
            file.changeType,
            file.stats,
          ),
          ...(file.isUntracked ? { isUntracked: true } : {}),
        };
        return;
      }
      if (file !== null && isBuiltFile(file)) {
        retainedSourceBytes += file.sourceBytes;
      }
      results[index] = file;
    });
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
  return workspaceSignature(
    status,
    status.changes.map(({ path }) => workspacePathSignature(repoRoot, path)),
  );
}

function workspaceSignature(
  status: PlasticWorkspaceStatus,
  worktrees: unknown[],
) {
  return JSON.stringify({
    changeset: status.changeset,
    repository: status.repository,
    server: status.server,
    changes: status.changes.map(
      ({ code, path, oldPath, revisionType, size, lastModified }, index) => {
        return {
          code,
          path,
          oldPath,
          revisionType,
          size,
          lastModified,
          worktree: worktrees[index],
        };
      },
    ),
  });
}

async function asyncWorkspaceSignature(
  status: PlasticWorkspaceStatus,
  repoRoot: string,
  signal?: AbortSignal,
) {
  const worktrees: unknown[] = [];
  for (let start = 0; start < status.changes.length; start += 16) {
    worktrees.push(
      ...(await Promise.all(
        status.changes.slice(start, start + 16).map(async (change) => {
          const entries: unknown[] = [];
          const visit = async (path: string): Promise<void> => {
            signal?.throwIfAborted();
            const absolute = localPath(repoRoot, path);
            const info = await lstat(absolute);
            const type = info.isSymbolicLink()
              ? "symlink"
              : info.isDirectory()
                ? "directory"
                : "file";
            entries.push({
              path,
              type,
              size: info.size,
              mtimeMs: info.mtimeMs,
              ctimeMs: info.ctimeMs,
              ...(type === "symlink"
                ? { target: await readlink(absolute) }
                : {}),
            });
            if (type === "directory")
              for (const name of (await readdir(absolute)).sort())
                await visit(`${path}/${name}`);
          };
          try {
            await visit(change.path);
            return entries;
          } catch {
            signal?.throwIfAborted();
            return null;
          }
        }),
      )),
    );
  }
  signal?.throwIfAborted();
  return workspaceSignature(status, worktrees);
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

async function loadRevisionFiles(
  reader: PlasticReadSession,
  repoRoot: string,
  workspace: PlasticWorkspaceStatus,
  specs: readonly string[],
  select: PathSelection,
  signal?: AbortSignal,
  initialInventory?: PlasticRevisionChange[],
) {
  const inventory = (
    await expandRevisionChanges(
      reader,
      repoRoot,
      specs,
      initialInventory ??
        (await readPlasticDiffInventory(reader, repoRoot, specs, signal)),
      select,
      signal,
    )
  ).filter((change) => {
    const paths = revisionPaths(change);
    return select(paths.path, paths.previousPath, false);
  });
  return (
    await mapFiles(
      inventory,
      (change) =>
        buildRevisionFile(reader, repoRoot, workspace, change, signal),
      (batch) =>
        reader.prefetch(
          batch.flatMap((change) =>
            Object.values(revisionSides(change)).flatMap((side) =>
              side
                ? [revisionRead(workspace, side.revisionId, side.itemType)]
                : [],
            ),
          ),
        ),
    )
  ).filter((file): file is PlasticReviewFile => file !== null);
}

async function loadWorkspaceFiles(
  reader: PlasticReadSession,
  repoRoot: string,
  status: PlasticWorkspaceStatus,
  input: ExtensionVcsDiffInput,
  select: PathSelection,
  signal?: AbortSignal,
) {
  const changes = await expandWorkspaceChanges(
    reader,
    repoRoot,
    status,
    select,
    input.options.excludeUntracked === true,
    signal,
  );
  const reviewChanges = changes.flatMap((change) => {
    const kind = classifyPlasticWorkspaceChange(change);
    return kind === "skip" ||
      (kind === "private" && input.options.excludeUntracked) ||
      !select(change.path, change.oldPath, false)
      ? []
      : [{ change, kind }];
  });
  return (
    await mapFiles(
      reviewChanges,
      async ({ change, kind }) => {
        const file = await buildWorkspaceFile(
          reader,
          repoRoot,
          status,
          change,
          kind === "private" ? "new" : kind,
          signal,
        );
        return file && kind === "private"
          ? { ...file, isUntracked: true }
          : file;
      },
      (batch) =>
        reader.prefetch(
          batch.flatMap(({ change, kind }) => {
            if (
              kind === "new" ||
              kind === "private" ||
              (kind !== "deleted" &&
                Number(change.size) > PLASTIC_DIFF_FILE_MAX_BYTES)
            )
              return [];
            return [
              revisionRead(
                status,
                change.baseRevisionId ?? "",
                change.baseItemType ?? change.revisionType,
              ),
            ];
          }),
        ),
    )
  ).filter((file): file is PlasticReviewFile => file !== null);
}

export function createPlasticVcsAdapter({
  cmExecutable = "cm",
  runner = createPlasticCommandRunner(cmExecutable),
  cacheDirectory,
  apiVersion = 14,
}: Readonly<PlasticVcsAdapterOptions> = {}) {
  const cache = new PlasticDiskCache(cacheDirectory);
  const adapter = {
    id: "plastic",
    name: "Plastic SCM",
    detect(cwd: string) {
      const repoRoot = findPlasticRepoRoot(cwd);
      return repoRoot ? { id: "plastic", repoRoot } : null;
    },
    detectionPriority: HUNK_VCS_DETECTION_BASELINE_PRIORITY + 10,
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
            const [workspace, inventory] = specs.length
              ? await together([
                  readPlasticWorkspaceHeader(runner, repoRoot, signal),
                  readPlasticDiffInventory(runner, repoRoot, specs, signal),
                ])
              : ([
                  await readPlasticWorkspaceStatus(runner, repoRoot, signal),
                  undefined,
                ] as const);
            const reader = new PlasticReadSession(
              runner,
              cache,
              workspace,
              repoRoot,
              PLASTIC_DIFF_FILE_MAX_BYTES,
              signal,
            );
            try {
              const select = selectPaths(input, cwd, repoRoot);
              const built = specs.length
                ? await loadRevisionFiles(
                    reader,
                    repoRoot,
                    workspace,
                    specs,
                    select,
                    signal,
                    inventory,
                  )
                : await loadWorkspaceFiles(
                    reader,
                    repoRoot,
                    workspace,
                    input,
                    select,
                    signal,
                  );
              return {
                repoRoot,
                sourceLabel: repoRoot,
                title: specs.length
                  ? `${basename(repoRoot)} ${specs.join(" to ")}`
                  : `${basename(repoRoot)} working copy`,
                patchText: "",
                extraFiles: toExtraFiles(built),
                ...sourceCapability(built),
              };
            } finally {
              await reader.close();
            }
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
            const explicitRef =
              input.ref === undefined ? undefined : requireRevision(input.ref);
            const [workspace, inventory] = await together([
              readPlasticWorkspaceHeader(runner, repoRoot, signal),
              explicitRef === undefined
                ? Promise.resolve(undefined)
                : readPlasticDiffInventory(
                    runner,
                    repoRoot,
                    [explicitRef],
                    signal,
                  ),
            ]);
            const ref =
              explicitRef ?? requireRevision(`cs:${workspace.changeset}`);
            const reader = new PlasticReadSession(
              runner,
              cache,
              workspace,
              repoRoot,
              PLASTIC_DIFF_FILE_MAX_BYTES,
              signal,
            );
            try {
              const built = await loadRevisionFiles(
                reader,
                repoRoot,
                workspace,
                [ref],
                selectPaths(input, cwd, repoRoot),
                signal,
                inventory,
              );
              return {
                repoRoot,
                sourceLabel: repoRoot,
                title: `${basename(repoRoot)} show ${ref}`,
                patchText: "",
                extraFiles: toExtraFiles(built),
                ...sourceCapability(built),
              };
            } finally {
              await reader.close();
            }
          } catch (error) {
            if (signal?.aborted) signal.throwIfAborted();
            throw translatePlasticError(input, error);
          }
        },
      },
    },
  } satisfies ExtensionVcsAdapter;
  // API 25 adds Promise-returning signatures. The minimum supported host and
  // published npm types are still API 14; never install this hook on them.
  if (apiVersion >= 25) {
    Object.assign(adapter.operations["working-tree-diff"], {
      async watchSignature(
        input: ExtensionVcsDiffInput,
        context: { cwd: string; signal?: AbortSignal },
      ) {
        try {
          const repoRoot = requireRepoRoot(context.cwd);
          if (input.range || input.rangeEndpoints) {
            return (
              await runner.run(
                [
                  "diff",
                  ...inputSpecs(input),
                  "--repositorypaths",
                  `--format=${PLASTIC_DIFF_FORMAT}`,
                  "--encoding=utf-8",
                ],
                repoRoot,
                context.signal,
              )
            ).toString("utf8");
          }
          const status = await readPlasticWorkspaceStatus(
            runner,
            repoRoot,
            context.signal,
          );
          return await asyncWorkspaceSignature(
            status,
            repoRoot,
            context.signal,
          );
        } catch (error) {
          context.signal?.throwIfAborted();
          throw translatePlasticError(input, error);
        }
      },
    });
  }
  return adapter;
}

export const PlasticVcsAdapter = createPlasticVcsAdapter();
