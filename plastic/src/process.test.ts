import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  PlasticCommandFailure,
  PlasticCommandOutputTooLarge,
  PlasticDownloadTooLarge,
  createPlasticCommandRunner,
} from "./process";

describe("Plastic command runner limits", () => {
  const runner = createPlasticCommandRunner(process.execPath);

  test("accepts stdout at the requested byte ceiling", async () => {
    await expect(
      runner.run(
        ["-e", "process.stdout.write('12345')"],
        process.cwd(),
        undefined,
        5,
      ),
    ).resolves.toEqual(Buffer.from("12345"));
  });

  test("terminates a command whose stdout exceeds its byte ceiling", async () => {
    const result = runner.run(
      ["-e", "process.stdout.write('123456'); setInterval(() => {}, 1000)"],
      process.cwd(),
      undefined,
      5,
    );

    await expect(result).rejects.toBeInstanceOf(PlasticCommandOutputTooLarge);
    await expect(result).rejects.toMatchObject({ maxBytes: 5 });
  });

  test("bounds retained diagnostics from a failed command", async () => {
    try {
      await runner.run(
        ["-e", "process.stderr.write('x'.repeat(100_000)); process.exit(2)"],
        process.cwd(),
      );
      throw new Error("Expected the command to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(PlasticCommandFailure);
      expect((error as PlasticCommandFailure).stderr.length).toBe(64 * 1024);
    }
  });

  test("stops oversized file downloads and waits until the writer has exited", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunk-download-limit-"));
    const output = join(directory, "output");
    const pidFile = join(directory, "pid");
    try {
      const operation = runner.run(
        [
          "-e",
          "const fs = require('node:fs'); fs.writeFileSync(process.argv[2], String(process.pid)); fs.writeFileSync(process.argv[1], '123456'); setInterval(() => {}, 1000)",
          output,
          pidFile,
        ],
        directory,
        undefined,
        100,
        { paths: [output], maxBytes: 5 },
      );
      await expect(operation).rejects.toBeInstanceOf(PlasticDownloadTooLarge);
      await expect(operation).rejects.toMatchObject({
        paths: [output],
        maxBytes: 5,
      });
      const pid = Number(await readFile(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("cancellation reaps a running download before returning", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hunk-download-abort-"));
    const output = join(directory, "pid");
    const controller = new AbortController();
    try {
      const operation = runner
        .run(
          [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)",
            output,
          ],
          directory,
          controller.signal,
          100,
          { paths: [output], maxBytes: 100 },
        )
        .catch((error) => error);
      const deadline = Date.now() + 2000;
      while (!existsSync(output) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      expect(await operation).toBeInstanceOf(PlasticCommandFailure);
      expect(existsSync(output)).toBe(true);
      const pid = Number(await readFile(output, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      controller.abort();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
