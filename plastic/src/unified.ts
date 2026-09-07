interface DiffLine {
  text: string;
  newline: boolean;
}

interface DiffOperation {
  kind: "equal" | "add" | "remove";
  line: DiffLine;
  oldBefore: number;
  newBefore: number;
}

// Myers retains one frontier per edit distance. Past this point a coarse middle
// replacement costs less memory and still produces an exact, applicable patch.
const MAX_MYERS_EDIT_DISTANCE = 512;

function splitLines(text: string): DiffLine[] {
  if (!text) return [];
  const pieces = text.split("\n");
  const hasFinalNewline = pieces.at(-1) === "";
  if (hasFinalNewline) pieces.pop();
  return pieces.map((line, index) => ({
    text: line,
    newline: index < pieces.length - 1 || hasFinalNewline,
  }));
}

function sameLine(left: DiffLine, right: DiffLine) {
  return left.text === right.text && left.newline === right.newline;
}

/** Myers' shortest-edit script over complete source lines. */
function diffLines(
  oldLines: readonly DiffLine[],
  newLines: readonly DiffLine[],
) {
  const max = oldLines.length + newLines.length;
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]);

  for (
    let distance = 0;
    distance <= Math.min(max, MAX_MYERS_EDIT_DISTANCE);
    distance += 1
  ) {
    trace.push(new Map(frontier));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
      const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
      let oldIndex =
        diagonal === -distance || (diagonal !== distance && right < down)
          ? Math.max(0, down)
          : Math.max(0, right + 1);
      let newIndex = oldIndex - diagonal;
      while (
        oldIndex < oldLines.length &&
        newIndex < newLines.length &&
        sameLine(oldLines[oldIndex]!, newLines[newIndex]!)
      ) {
        oldIndex += 1;
        newIndex += 1;
      }
      frontier.set(diagonal, oldIndex);
      if (oldIndex >= oldLines.length && newIndex >= newLines.length) {
        return backtrackDiff(trace, oldLines, newLines);
      }
    }
  }

  return coarseDiff(oldLines, newLines);
}

function annotateOperations(
  operations: readonly { kind: DiffOperation["kind"]; line: DiffLine }[],
) {
  let oldBefore = 0;
  let newBefore = 0;
  return operations.map(({ kind, line }): DiffOperation => {
    const operation = { kind, line, oldBefore, newBefore };
    if (kind !== "add") oldBefore += 1;
    if (kind !== "remove") newBefore += 1;
    return operation;
  });
}

function coarseDiff(
  oldLines: readonly DiffLine[],
  newLines: readonly DiffLine[],
) {
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    sameLine(oldLines[prefix]!, newLines[prefix]!)
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    sameLine(
      oldLines[oldLines.length - suffix - 1]!,
      newLines[newLines.length - suffix - 1]!,
    )
  ) {
    suffix += 1;
  }
  return annotateOperations([
    ...oldLines
      .slice(0, prefix)
      .map((line) => ({ kind: "equal" as const, line })),
    ...oldLines
      .slice(prefix, oldLines.length - suffix)
      .map((line) => ({ kind: "remove" as const, line })),
    ...newLines
      .slice(prefix, newLines.length - suffix)
      .map((line) => ({ kind: "add" as const, line })),
    ...oldLines
      .slice(oldLines.length - suffix)
      .map((line) => ({ kind: "equal" as const, line })),
  ]);
}

function backtrackDiff(
  trace: readonly Map<number, number>[],
  oldLines: readonly DiffLine[],
  newLines: readonly DiffLine[],
) {
  const reversed: Array<{ kind: DiffOperation["kind"]; line: DiffLine }> = [];
  let oldIndex = oldLines.length;
  let newIndex = newLines.length;

  for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
    const frontier = trace[distance]!;
    const diagonal = oldIndex - newIndex;
    const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
    const right = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
    const previousDiagonal =
      diagonal === -distance || (diagonal !== distance && right < down)
        ? diagonal + 1
        : diagonal - 1;
    const previousOld = Math.max(0, frontier.get(previousDiagonal) ?? 0);
    const previousNew = previousOld - previousDiagonal;

    while (oldIndex > previousOld && newIndex > previousNew) {
      reversed.push({ kind: "equal", line: oldLines[oldIndex - 1]! });
      oldIndex -= 1;
      newIndex -= 1;
    }
    if (distance === 0) break;
    if (oldIndex === previousOld) {
      reversed.push({ kind: "add", line: newLines[newIndex - 1]! });
      newIndex -= 1;
    } else {
      reversed.push({ kind: "remove", line: oldLines[oldIndex - 1]! });
      oldIndex -= 1;
    }
  }

  return annotateOperations(reversed.reverse());
}

function changedGroups(operations: readonly DiffOperation[], context: number) {
  const changes = operations.flatMap((operation, index) =>
    operation.kind === "equal" ? [] : [index],
  );
  if (!changes.length) return [];
  const groups: Array<{ start: number; end: number }> = [];
  let start = Math.max(0, changes[0]! - context);
  let end = Math.min(operations.length, changes[0]! + context + 1);
  for (const index of changes.slice(1)) {
    const nextStart = Math.max(0, index - context);
    const nextEnd = Math.min(operations.length, index + context + 1);
    if (nextStart <= end) {
      end = nextEnd;
    } else {
      groups.push({ start, end });
      start = nextStart;
      end = nextEnd;
    }
  }
  groups.push({ start, end });
  return groups;
}

function rangeStart(before: number, count: number) {
  return count === 0 ? before : before + 1;
}

/** Build the unified file headers and hunks that follow a git diff header. */
export function createUnifiedFilePatch(
  oldLabel: string,
  newLabel: string,
  oldText: string,
  newText: string,
  context = 3,
) {
  const operations = diffLines(splitLines(oldText), splitLines(newText));
  const output = [`--- ${oldLabel}`, `+++ ${newLabel}`];
  for (const group of changedGroups(operations, context)) {
    const rows = operations.slice(group.start, group.end);
    const oldCount = rows.filter((row) => row.kind !== "add").length;
    const newCount = rows.filter((row) => row.kind !== "remove").length;
    const first = rows[0]!;
    output.push(
      `@@ -${rangeStart(first.oldBefore, oldCount)},${oldCount} +${rangeStart(first.newBefore, newCount)},${newCount} @@`,
    );
    for (const row of rows) {
      const prefix =
        row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " ";
      output.push(`${prefix}${row.line.text}`);
      if (!row.line.newline) output.push("\\ No newline at end of file");
    }
  }
  return `${output.join("\n")}\n`;
}
