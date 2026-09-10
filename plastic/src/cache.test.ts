import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlasticDiskCache } from "./cache";

describe("Plastic disk cache", () => {
  test("rejects corrupted and oversized entries and replaces them atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunk-cache-integrity-"));
    const cache = new PlasticDiskCache(directory);
    try {
      await cache.write(["revision", "repo", "1"], Buffer.from("correct"));
      expect(await cache.read(["revision", "repo", "1"], 6)).toBeUndefined();
      const path = join(directory, (await readdir(directory))[0]!);
      await writeFile(path, `${"0".repeat(64)}\ncorrupt`);
      expect(await cache.read(["revision", "repo", "1"], 100)).toBeUndefined();
      await Promise.all([
        cache.write(["revision", "repo", "1"], Buffer.from("first")),
        cache.write(["revision", "repo", "1"], Buffer.from("second")),
      ]);
      expect(["first", "second"]).toContain(
        (await cache.read(["revision", "repo", "1"], 100))!.toString(),
      );
      expect(await readdir(directory)).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("evicts least recently used entries within byte and entry budgets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunk-cache-eviction-"));
    const cache = new PlasticDiskCache(directory, 134, 2);
    try {
      for (const key of [1, 2, 3])
        await cache.write([key], Buffer.from(String(key)));
      for (const name of await readdir(directory))
        await utimes(join(directory, name), new Date(0), new Date(0));
      expect(await cache.read([1], 100)).toEqual(Buffer.from("1"));
      await cache.prune();
      expect(await cache.read([1], 100)).toEqual(Buffer.from("1"));
      expect(await readdir(directory)).toHaveLength(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("unavailable cache storage remains a cache miss", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunk-cache-unavailable-"));
    try {
      const file = join(directory, "file");
      await writeFile(file, "not a directory");
      const cache = new PlasticDiskCache(join(file, "cache"));
      await cache.write(["key"], Buffer.from("value"));
      expect(await cache.read(["key"], 100)).toBeUndefined();
      await cache.prune();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
