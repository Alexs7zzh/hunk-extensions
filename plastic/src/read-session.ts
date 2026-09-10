import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forEachOrdered } from "./concurrency";
import { PlasticDiskCache } from "./cache";
import { readPlasticFile } from "./files";
import {
  parsePlasticTreeEntries,
  type PlasticWorkspaceStatus,
} from "./plastic";
import {
  PLASTIC_COMMAND_MAX_STDOUT_BYTES,
  PlasticCommandOutputTooLarge,
  PlasticDownloadTooLarge,
  type PlasticCommandRunner,
} from "./process";

export interface PlasticRevisionRead {
  spec: string;
  symlink: boolean;
}

// Keep command lines well below Windows' 32,767-character process limit,
// allowing space for quoting and the executable. The count also bounds the
// temporary files inspected by the download-size monitor.
const MAX_BATCH_CHARACTERS = 16_000;
const MAX_BATCH_FILES = 128;

function revisionKey(read: PlasticRevisionRead) {
  return ["revision", read.spec, read.symlink] as const;
}

/** Own exact revision downloads and immutable inventory caching for one review. */
export class PlasticReadSession implements PlasticCommandRunner {
  private directory: Promise<string> | undefined;
  private nextFile = 0;
  private persistence: Promise<void> = Promise.resolve();
  private readonly files = new Map<string, string>();
  private readonly oversized = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly runner: PlasticCommandRunner,
    private readonly cache: PlasticDiskCache,
    private readonly workspace: PlasticWorkspaceStatus,
    private readonly repoRoot: string,
    private readonly maxFileBytes: number,
    private readonly signal?: AbortSignal,
  ) {}

  runSync: PlasticCommandRunner["runSync"] = (args, cwd) =>
    this.runner.runSync(args, cwd);

  run: PlasticCommandRunner["run"] = (
    args,
    cwd,
    signal = this.signal,
    maxBytes = PLASTIC_COMMAND_MAX_STDOUT_BYTES,
  ) => {
    const operation = this.read(args, cwd, signal, maxBytes);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  };

  private async read(
    args: readonly string[],
    cwd: string,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ) {
    signal?.throwIfAborted();
    if (args[0] === "cat") {
      const request = { spec: args[1]!, symlink: args.includes("--symlink") };
      const key = JSON.stringify(revisionKey(request));
      if (this.oversized.has(key))
        throw new PlasticCommandOutputTooLarge(args, maxBytes);
      let path = this.files.get(key);
      if (!path) {
        const cached = await this.cache.read(
          revisionKey(request),
          Math.min(maxBytes, this.maxFileBytes),
        );
        signal?.throwIfAborted();
        if (cached) return cached;
        await this.download([request]);
        if (this.oversized.has(key))
          throw new PlasticCommandOutputTooLarge(args, maxBytes);
        path = this.files.get(key)!;
      }
      return readPlasticFile(
        path,
        Math.min(maxBytes, this.maxFileBytes),
        signal,
      );
    }

    // Branch and label trees move. Only numbered changesets are persistent
    // cache keys, scoped by the actual repository, not a workspace path.
    const immutableTree =
      args[0] === "ls" && args.some((arg) => /^--tree=cs:\d+$/.test(arg));
    if (!immutableTree) return this.runner.run(args, cwd, signal, maxBytes);
    const key = [
      "tree",
      this.workspace.server,
      this.workspace.repository,
      ...args,
    ];
    const cached = await this.cache.read(key, maxBytes);
    signal?.throwIfAborted();
    if (cached) return cached;
    const output = await this.runner.run(args, cwd, signal, maxBytes);
    parsePlasticTreeEntries(output.toString("utf8"));
    await this.cache.write(key, output);
    return output;
  }

  async prefetch(reads: readonly PlasticRevisionRead[]) {
    // The previous chunk has finished building its patches. Retain at most
    // this chunk's downloads in temporary storage, even on huge reviews.
    await this.persistence;
    await this.cache.prune();
    await Promise.all(
      [...this.files.values()].map((path) => rm(path, { force: true })),
    );
    this.files.clear();
    const unique = [
      ...new Map(
        reads.map((read) => [JSON.stringify(revisionKey(read)), read]),
      ).values(),
    ];
    const missing: PlasticRevisionRead[] = [];
    // Limit concurrent cache reads without retaining all source buffers.
    for (let start = 0; start < unique.length; start += 16) {
      const batch = unique.slice(start, start + 16);
      const hits = await Promise.all(
        batch.map((read) =>
          this.cache.has(revisionKey(read), this.maxFileBytes),
        ),
      );
      this.signal?.throwIfAborted();
      for (const [index, read] of batch.entries()) {
        const key = JSON.stringify(revisionKey(read));
        if (!hits[index] && !this.files.has(key) && !this.oversized.has(key))
          missing.push(read);
      }
    }
    await this.download(missing);
  }

  private async download(reads: readonly PlasticRevisionRead[]) {
    if (!reads.length) return;
    this.signal?.throwIfAborted();
    const directory = await (this.directory ??= mkdtemp(
      join(tmpdir(), "hunk-plastic-"),
    ));
    for (const symlink of [false, true]) {
      let batch: Array<{ read: PlasticRevisionRead; path: string }> = [];
      let characters = 0;
      for (const read of reads.filter((read) => read.symlink === symlink)) {
        const path = join(directory, String(this.nextFile++));
        const length = read.spec.length + path.length + 4;
        if (length > MAX_BATCH_CHARACTERS)
          throw new Error(
            "Plastic revision specification exceeds the download command limit.",
          );
        if (
          batch.length &&
          (batch.length >= MAX_BATCH_FILES ||
            characters + length > MAX_BATCH_CHARACTERS)
        ) {
          await this.downloadBatch(batch, symlink);
          batch = [];
          characters = 0;
        }
        batch.push({ read, path });
        characters += length;
      }
      if (batch.length) await this.downloadBatch(batch, symlink);
    }
  }

  private async downloadBatch(
    batch: Array<{ read: PlasticRevisionRead; path: string }>,
    symlink: boolean,
  ) {
    let remaining = batch;
    while (remaining.length) {
      this.signal?.throwIfAborted();
      try {
        await this.runner.run(
          [
            "cat",
            ...remaining.map(({ read, path }) => `${read.spec};${path}`),
            ...(symlink ? ["--symlink"] : []),
          ],
          this.repoRoot,
          this.signal,
          PLASTIC_COMMAND_MAX_STDOUT_BYTES,
          {
            paths: remaining.map(({ path }) => path),
            maxBytes: this.maxFileBytes,
          },
        );
        break;
      } catch (error) {
        this.signal?.throwIfAborted();
        if (!(error instanceof PlasticDownloadTooLarge)) throw error;
        const oversized = new Set(error.paths);
        for (const { read, path } of remaining) {
          if (oversized.has(path))
            this.oversized.add(JSON.stringify(revisionKey(read)));
          // The interrupted process may have left partial smaller downloads.
          await rm(path, { force: true });
        }
        const retry = remaining.filter(({ path }) => !oversized.has(path));
        if (retry.length === remaining.length) throw error;
        remaining = retry;
      }
    }
    for (const { read, path } of remaining)
      this.files.set(JSON.stringify(revisionKey(read)), path);
    // Cache persistence overlaps patch reads. Only four source buffers are
    // retained by this queue, and the next chunk waits before removing files.
    if (this.cache.directory === false) return;
    const completed = remaining;
    this.persistence = this.persistence.then(() =>
      forEachOrdered(
        completed,
        4,
        async ({ read, path }) => {
          try {
            const content = await readPlasticFile(
              path,
              this.maxFileBytes,
              this.signal,
            );
            await this.cache.write(revisionKey(read), content);
          } catch {
            // Persistence is optional. Foreground reads independently enforce
            // size limits and report provider/filesystem failures.
          }
        },
        () => {},
      ),
    );
  }

  async close() {
    await Promise.allSettled([...this.pending]);
    await this.persistence;
    if (this.directory)
      await rm(await this.directory, { recursive: true, force: true });
    await this.cache.prune();
  }
}
