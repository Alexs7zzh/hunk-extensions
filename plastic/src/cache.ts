import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Keep at most eight reviews' worth of source bytes, plus a bounded number of
// small inventory entries. Cache misses always fall back to Plastic.
export const PLASTIC_CACHE_MAX_BYTES = 256_000_000;
export const PLASTIC_CACHE_MAX_ENTRIES = 4096;

export function defaultPlasticCacheDirectory() {
  const root =
    process.env.XDG_CACHE_HOME ||
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches")
      : process.platform === "win32"
        ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
        : join(homedir(), ".cache"));
  return join(root, "hunk", "plastic", "v1");
}

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

/** Stores checksummed immutable data; cache failures never hide provider errors. */
export class PlasticDiskCache {
  private dirty = false;
  constructor(
    readonly directory: string | false = defaultPlasticCacheDirectory(),
    private readonly maxBytes = PLASTIC_CACHE_MAX_BYTES,
    private readonly maxEntries = PLASTIC_CACHE_MAX_ENTRIES,
  ) {}

  private path(key: readonly unknown[]) {
    return join(this.directory || "", `${digest(JSON.stringify(key))}.cache`);
  }

  // A prefetch hint only. read() still verifies bytes and handles eviction or
  // corruption before any cached content reaches a patch.
  async has(key: readonly unknown[], maxBytes: number): Promise<boolean> {
    if (this.directory === false) return false;
    try {
      const info = await stat(this.path(key));
      return info.isFile() && info.size >= 65 && info.size <= maxBytes + 65;
    } catch {
      return false;
    }
  }

  async read(
    key: readonly unknown[],
    maxBytes: number,
  ): Promise<Buffer | undefined> {
    if (this.directory === false) return undefined;
    const path = this.path(key);
    try {
      const handle = await open(path, "r");
      let data: Buffer;
      try {
        const size = (await handle.stat()).size;
        // The 64-byte hex digest and newline precede the payload.
        if (size < 65 || size > maxBytes + 65) return undefined;
        data = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await handle.read(
            data,
            offset,
            size - offset,
            offset,
          );
          if (!bytesRead) return undefined;
          offset += bytesRead;
        }
      } finally {
        await handle.close();
      }
      const payload = data.subarray(65);
      if (
        data[64] !== 10 ||
        data.subarray(0, 64).toString() !== digest(payload)
      )
        return undefined;
      const now = new Date();
      await utimes(path, now, now).catch(() => {});
      return payload;
    } catch {
      return undefined;
    }
  }

  async write(key: readonly unknown[], data: Buffer) {
    if (this.directory === false || data.length + 65 > this.maxBytes) return;
    const path = this.path(key);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(
        temporary,
        Buffer.concat([Buffer.from(`${digest(data)}\n`), data]),
        { mode: 0o600 },
      );
      await rename(temporary, path);
      this.dirty = true;
    } catch {
      // Read-only caches and a full cache volume must not prevent a review.
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async prune() {
    if (this.directory === false || !this.dirty) return;
    this.dirty = false;
    const directory = this.directory;
    try {
      const names = (await readdir(directory)).filter((name) =>
        /^[a-f0-9]{64}\.cache$/.test(name),
      );
      const entries = [];
      for (let start = 0; start < names.length; start += 64) {
        const batch = await Promise.all(
          names.slice(start, start + 64).map(async (name) => {
            const path = join(directory, name);
            const info = await stat(path).catch(() => undefined);
            return info
              ? { path, size: info.size, modified: info.mtimeMs }
              : undefined;
          }),
        );
        for (const entry of batch) if (entry) entries.push(entry);
      }
      entries.sort((a, b) => b.modified - a.modified);
      let retainedBytes = 0;
      for (const [index, entry] of entries.entries()) {
        retainedBytes += entry.size;
        if (index >= this.maxEntries || retainedBytes > this.maxBytes) {
          await rm(entry.path, { force: true }).catch(() => {});
        }
      }
    } catch {
      // Another process may populate or evict entries concurrently.
    }
  }
}
