import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlasticDiskCache } from "./cache";
import { PlasticReadSession } from "./read-session";
import {
  PlasticCommandOutputTooLarge,
  PlasticDownloadTooLarge,
  type PlasticCommandRunner,
} from "./process";

const workspace = {
  repository: "repo",
  server: "cloud",
  changeset: "7",
  changes: [],
};
const spec = (id: number) => `revid:${id}@rep:repo@repserver:cloud`;
const read = (id: number, symlink = false) => ({ spec: spec(id), symlink });

function downloadPairs(args: readonly string[]) {
  return args
    .slice(1)
    .filter((arg) => !arg.startsWith("--"))
    .map((pair) => {
      const separator = pair.lastIndexOf(";");
      return {
        spec: pair.slice(0, separator),
        path: pair.slice(separator + 1),
      };
    });
}
const noSync = () => {
  throw new Error("Unexpected synchronous command");
};

describe("Plastic read sessions", () => {
  test("batches exact bytes, separates symlinks, and reuses revisions and immutable inventories across sessions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunk-cache-test-"));
    const contents = new Map([
      [spec(1), Buffer.from([0, 0xff, 0x80, 13, 10])],
      [spec(2), Buffer.from("\uFEFFtext\r\n")],
      [spec(3), Buffer.from("target.txt")],
    ]);
    const calls: string[][] = [];
    const paths: string[] = [];
    const runner: PlasticCommandRunner = {
      runSync: noSync,
      async run(args, _cwd, _signal, _limit, downloads) {
        calls.push([...args]);
        if (args[0] === "ls")
          return Buffer.from("txt\u001ffile.txt\u001f1\u001e");
        expect(downloads?.maxBytes).toBe(100);
        for (const pair of downloadPairs(args)) {
          paths.push(pair.path);
          if (pair.spec === spec(3)) expect(args).toContain("--symlink");
          await writeFile(pair.path, contents.get(pair.spec)!);
        }
        return Buffer.alloc(0);
      },
    };
    try {
      for (let pass = 0; pass < 2; pass++) {
        const session = new PlasticReadSession(
          runner,
          new PlasticDiskCache(directory),
          workspace,
          directory,
          100,
        );
        try {
          await session.run(["ls", "/file.txt", "--tree=cs:7"], directory);
          await session.prefetch([read(1), read(2), read(1), read(3, true)]);
          for (const [index, content] of [...contents.values()].entries()) {
            const args = [
              "cat",
              spec(index + 1),
              ...(index === 2 ? ["--symlink"] : []),
            ];
            expect(await session.run(args, directory, undefined, 100)).toEqual(
              content,
            );
          }
        } finally {
          await session.close();
        }
      }
      expect(calls.map((args) => args[0])).toEqual(["ls", "cat", "cat"]);
      expect(downloadPairs(calls[1]!)).toHaveLength(2);
      expect(paths.every((path) => !existsSync(path))).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("warm prefetch defers byte verification until consumption and recovers from corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunk-warm-cache-"));
    class CountingCache extends PlasticDiskCache {
      reads = 0;
      override async read(key: readonly unknown[], maxBytes: number) {
        this.reads++;
        return super.read(key, maxBytes);
      }
    }
    const cache = new CountingCache(directory);
    await cache.write(["revision", spec(1), false], Buffer.from("cached"));
    let downloads = 0;
    const session = new PlasticReadSession(
      {
        runSync: noSync,
        async run(args) {
          downloads++;
          for (const pair of downloadPairs(args))
            await writeFile(pair.path, "fresh");
          return Buffer.alloc(0);
        },
      },
      cache,
      workspace,
      directory,
      100,
    );
    try {
      await session.prefetch([read(1)]);
      expect(cache.reads).toBe(0);
      expect(await session.run(["cat", spec(1)], directory)).toEqual(
        Buffer.from("cached"),
      );
      expect(cache.reads).toBe(1);
      expect(downloads).toBe(0);
      const name = (await readdir(directory)).find((name) =>
        name.endsWith(".cache"),
      )!;
      await writeFile(join(directory, name), Buffer.alloc(71));
      await session.prefetch([read(1)]);
      expect(await session.run(["cat", spec(1)], directory)).toEqual(
        Buffer.from("fresh"),
      );
      expect(downloads).toBe(1);
    } finally {
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("patch reads proceed while persistence is blocked, but cleanup waits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunk-persist-cache-"));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const writing = new Promise<void>((resolve) => {
      started = resolve;
    });
    class SlowCache extends PlasticDiskCache {
      override async write(key: readonly unknown[], content: Buffer) {
        started();
        await blocked;
        await super.write(key, content);
      }
    }
    const cache = new SlowCache(directory);
    const paths: string[] = [];
    const session = new PlasticReadSession(
      {
        runSync: noSync,
        async run(args) {
          for (const pair of downloadPairs(args)) {
            paths.push(pair.path);
            await writeFile(pair.path, "content");
          }
          return Buffer.alloc(0);
        },
      },
      cache,
      workspace,
      directory,
      100,
    );
    try {
      await session.prefetch([read(1)]);
      await writing;
      expect(await session.run(["cat", spec(1)], directory)).toEqual(
        Buffer.from("content"),
      );
      let closed = false;
      const closing = session.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(existsSync(paths[0]!)).toBe(true);
      release();
      await closing;
      expect(existsSync(paths[0]!)).toBe(false);
      expect(await cache.read(["revision", spec(1), false], 100)).toEqual(
        Buffer.from("content"),
      );
    } finally {
      release();
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("does not cache moving trees or mix repositories that share changeset numbers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunk-tree-cache-test-"));
    let calls = 0;
    const runner: PlasticCommandRunner = {
      runSync: noSync,
      async run() {
        calls++;
        return Buffer.from(`txt\u001ffile.txt\u001f${calls}\u001e`);
      },
    };
    try {
      for (const repository of ["repo", "other"]) {
        const session = new PlasticReadSession(
          runner,
          new PlasticDiskCache(directory),
          { ...workspace, repository },
          directory,
          100,
        );
        try {
          await session.run(["ls", "/file.txt", "--tree=cs:7"], directory);
          await session.run(["ls", "/file.txt", "--tree=cs:7"], directory);
          await session.run(["ls", "/file.txt", "--tree=br:/main"], directory);
          await session.run(["ls", "/file.txt", "--tree=br:/main"], directory);
        } finally {
          await session.close();
        }
      }
      expect(calls).toBe(6);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("discards interrupted batch outputs and retries only the revisions within the size limit", async () => {
    const paths: string[] = [];
    let calls = 0;
    const runner: PlasticCommandRunner = {
      runSync: noSync,
      async run(args) {
        calls++;
        const pairs = downloadPairs(args);
        paths.push(...pairs.map((pair) => pair.path));
        if (calls === 1) {
          await writeFile(pairs[0]!.path, "partial");
          await writeFile(pairs[1]!.path, "too large");
          throw new PlasticDownloadTooLarge([pairs[1]!.path], 8);
        }
        expect(pairs.map((pair) => pair.spec)).toEqual([spec(1), spec(3)]);
        for (const pair of pairs) {
          expect(existsSync(pair.path)).toBe(false);
          await writeFile(pair.path, "complete");
        }
        return Buffer.alloc(0);
      },
    };
    const session = new PlasticReadSession(
      runner,
      new PlasticDiskCache(false),
      workspace,
      tmpdir(),
      8,
    );
    try {
      await session.prefetch([read(1), read(2), read(3)]);
      expect(
        await session.run(["cat", spec(1)], tmpdir(), undefined, 8),
      ).toEqual(Buffer.from("complete"));
      await expect(
        session.run(["cat", spec(2)], tmpdir(), undefined, 8),
      ).rejects.toBeInstanceOf(PlasticCommandOutputTooLarge);
      expect(
        await session.run(["cat", spec(3)], tmpdir(), undefined, 8),
      ).toEqual(Buffer.from("complete"));
      expect(calls).toBe(2);
    } finally {
      await session.close();
    }
    expect(paths.every((path) => !existsSync(path))).toBe(true);
  });

  test("never caches partial downloads after a provider failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunk-partial-cache-"));
    const paths: string[] = [];
    const runner: PlasticCommandRunner = {
      runSync: noSync,
      async run(args) {
        for (const pair of downloadPairs(args)) {
          paths.push(pair.path);
          await writeFile(pair.path, "partial");
        }
        throw new Error("connection lost");
      },
    };
    const session = new PlasticReadSession(
      runner,
      new PlasticDiskCache(directory),
      workspace,
      tmpdir(),
      100,
    );
    try {
      await expect(session.prefetch([read(1), read(2)])).rejects.toThrow(
        "connection lost",
      );
    } finally {
      await session.close();
    }
    expect(paths.every((path) => !existsSync(path))).toBe(true);
    expect(await readdir(directory)).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  });

  test("does not retain downloads from prior prefetch chunks", async () => {
    const paths: string[] = [];
    const runner: PlasticCommandRunner = {
      runSync: noSync,
      async run(args) {
        for (const pair of downloadPairs(args)) {
          paths.push(pair.path);
          await writeFile(pair.path, pair.spec);
        }
        return Buffer.alloc(0);
      },
    };
    const session = new PlasticReadSession(
      runner,
      new PlasticDiskCache(false),
      workspace,
      tmpdir(),
      100,
    );
    try {
      await session.prefetch([read(1)]);
      expect((await readFile(paths[0]!)).toString()).toBe(spec(1));
      await session.prefetch([read(2)]);
      expect(existsSync(paths[0]!)).toBe(false);
      expect((await readFile(paths[1]!)).toString()).toBe(spec(2));
    } finally {
      await session.close();
    }
  });
});
