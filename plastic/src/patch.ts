import { createHash } from "node:crypto";
import type {
  ExtensionVcsFileChangeType,
  ExtensionVcsFileSourceReader,
  ExtensionVcsFileStats,
} from "hunkdiff/extension";
import { createUnifiedFilePatch } from "./unified";

export interface PlasticFileVersion {
  path: string;
  previousPath?: string;
  oldContent: Buffer | null;
  newContent: Buffer | null;
  /** Keep a provider-reported metadata change visible when bytes are equal. */
  preserveEmptyChange?: boolean;
  declaredBinary?: boolean;
  oldMode?: string;
  newMode?: string;
}

export interface PlasticBuiltFile {
  path: string;
  previousPath?: string;
  patchText: string;
  changeType: ExtensionVcsFileChangeType;
  stats: ExtensionVcsFileStats;
  oldText: string | null;
  newText: string | null;
  /** Raw bytes consumed while building this patch, used by the review-wide budget. */
  sourceBytes: number;
}

function quoteGitPath(path: string) {
  return /^[A-Za-z0-9._/+@-]+$/.test(path) ? path : JSON.stringify(path);
}

function decodeText(content: Buffer | null, declaredBinary: boolean) {
  if (content === null || declaredBinary || content.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      content,
    );
  } catch {
    return null;
  }
}

function gitHeader(path: string, previousPath: string | undefined) {
  const oldPath = previousPath ?? path;
  return `diff --git ${quoteGitPath(`a/${oldPath}`)} ${quoteGitPath(`b/${path}`)}`;
}

export function buildPlasticFilePatch(
  version: PlasticFileVersion,
): PlasticBuiltFile | null {
  const previousPath = version.previousPath;
  const oldContent = version.oldContent;
  const newContent = version.newContent;
  const renamed = previousPath !== undefined && previousPath !== version.path;
  const contentEqual =
    oldContent !== null && newContent !== null && oldContent.equals(newContent);
  const oldMode = version.oldMode ?? "100644";
  const newMode = version.newMode ?? "100644";
  if (
    !renamed &&
    contentEqual &&
    oldMode === newMode &&
    !version.preserveEmptyChange
  )
    return null;

  const oldMissing = oldContent === null;
  const newMissing = newContent === null;
  const declaredBinary = version.declaredBinary === true;
  const oldText = decodeText(oldContent, declaredBinary);
  const newText = contentEqual
    ? oldText
    : decodeText(newContent, declaredBinary);
  const binary =
    (!oldMissing && oldText === null) || (!newMissing && newText === null);
  const changeType: ExtensionVcsFileChangeType = oldMissing
    ? "new"
    : newMissing
      ? "deleted"
      : renamed
        ? contentEqual
          ? "rename-pure"
          : "rename-changed"
        : "change";
  const lines = [gitHeader(version.path, previousPath)];
  const stats = { additions: 0, deletions: 0 };

  if (oldMissing) lines.push(`new file mode ${newMode}`);
  if (newMissing) lines.push(`deleted file mode ${oldMode}`);
  if (!oldMissing && !newMissing && oldMode !== newMode) {
    lines.push(`old mode ${oldMode}`, `new mode ${newMode}`);
  }
  if (renamed) {
    if (contentEqual) lines.push("similarity index 100%");
    lines.push(`rename from ${quoteGitPath(previousPath!)}`);
    lines.push(`rename to ${quoteGitPath(version.path)}`);
  }

  const oldLabel = oldMissing
    ? "/dev/null"
    : `a/${previousPath ?? version.path}`;
  const newLabel = newMissing ? "/dev/null" : `b/${version.path}`;
  if (binary) {
    lines.push(
      `Binary files ${quoteGitPath(oldLabel)} and ${quoteGitPath(newLabel)} differ`,
    );
  } else if (!contentEqual || oldMissing || newMissing) {
    const patch = createUnifiedFilePatch(
      quoteGitPath(oldLabel),
      quoteGitPath(newLabel),
      oldText ?? "",
      newText ?? "",
      3,
    ).slice(0, -1);
    let inHunk = false;
    for (const line of patch.split("\n")) {
      if (line.startsWith("@@")) inHunk = true;
      else if (inHunk && line.startsWith("+")) stats.additions++;
      else if (inHunk && line.startsWith("-")) stats.deletions++;
    }
    lines.push(patch);
  }

  return {
    path: version.path,
    ...(previousPath ? { previousPath } : {}),
    patchText: `${lines.join("\n")}\n`,
    changeType,
    stats,
    oldText,
    newText,
    sourceBytes: (oldContent?.byteLength ?? 0) + (newContent?.byteLength ?? 0),
  };
}

export function createPlasticSourceCapability(
  files: readonly PlasticBuiltFile[],
) {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const hash = createHash("sha256");
  hash.update("hunk-plastic-source-v1\0");
  for (const file of files) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.previousPath ?? "");
    hash.update("\0");
    hash.update(file.oldText === null ? "\0" : "\x01");
    if (file.oldText !== null) hash.update(file.oldText);
    hash.update("\0");
    hash.update(file.newText === null ? "\0" : "\x01");
    if (file.newText !== null) hash.update(file.newText);
    hash.update("\0");
  }

  const readFileSource: ExtensionVcsFileSourceReader = async ({
    path,
    side,
  }) => {
    const file = byPath.get(path);
    if (!file) return null;
    return side === "old" ? file.oldText : file.newText;
  };

  return {
    readFileSource,
    sourceCacheKey: hash.digest("hex"),
  };
}
