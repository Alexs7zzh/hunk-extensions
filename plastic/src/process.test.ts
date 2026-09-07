import { describe, expect, test } from "bun:test";
import {
  PlasticCommandFailure,
  PlasticCommandOutputTooLarge,
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
      [
        "-e",
        "process.stdout.write('123456'); setInterval(() => {}, 1000)",
      ],
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
        [
          "-e",
          "process.stderr.write('x'.repeat(100_000)); process.exit(2)",
        ],
        process.cwd(),
      );
      throw new Error("Expected the command to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(PlasticCommandFailure);
      expect((error as PlasticCommandFailure).stderr.length).toBe(64 * 1024);
    }
  });
});
