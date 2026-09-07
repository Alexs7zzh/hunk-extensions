import { spawn, spawnSync } from "node:child_process";

export interface PlasticCommandRunner {
  run(
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal,
    maxStdoutBytes?: number,
  ): Promise<Buffer>;
  runSync(args: readonly string[], cwd: string): Buffer;
}

/**
 * Plastic status and inventory output is normally small. This matches the
 * synchronous runner's existing ceiling and prevents a malformed or unusually
 * large response from growing memory without a bound.
 */
export const PLASTIC_COMMAND_MAX_STDOUT_BYTES = 16 * 1024 * 1024;

/** Diagnostics only feed a short user-facing error, so retaining more adds no value. */
const PLASTIC_COMMAND_MAX_STDERR_BYTES = 64 * 1024;

export class PlasticCommandOutputTooLarge extends Error {
  readonly args: readonly string[];
  readonly maxBytes: number;

  constructor(args: readonly string[], maxBytes: number) {
    super(`Plastic command output exceeded ${maxBytes} bytes.`);
    this.name = "PlasticCommandOutputTooLarge";
    this.args = [...args];
    this.maxBytes = maxBytes;
  }
}

export class PlasticCommandFailure extends Error {
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(
    message: string,
    options: {
      args: readonly string[];
      exitCode?: number | null;
      stderr?: string;
      stdout?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "PlasticCommandFailure";
    this.args = [...options.args];
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr ?? "";
    this.stdout = options.stdout ?? "";
  }
}

function commandLabel(executable: string, args: readonly string[]) {
  return [executable, ...args].join(" ");
}

export function createPlasticCommandRunner(
  executable = "cm",
): PlasticCommandRunner {
  return {
    run(args, cwd, signal, maxStdoutBytes = PLASTIC_COMMAND_MAX_STDOUT_BYTES) {
      return new Promise<Buffer>((resolve, reject) => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let settled = false;
        let child: ReturnType<typeof spawn>;

        try {
          child = spawn(executable, args, {
            cwd,
            signal,
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (error) {
          reject(
            new PlasticCommandFailure(
              `Could not start ${commandLabel(executable, args)}.`,
              {
                args,
                cause: error,
              },
            ),
          );
          return;
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          if (settled) return;
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > maxStdoutBytes) {
            settled = true;
            child.kill();
            reject(new PlasticCommandOutputTooLarge(args, maxStdoutBytes));
            return;
          }
          stdout.push(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (settled || stderrBytes >= PLASTIC_COMMAND_MAX_STDERR_BYTES) return;
          const retained = Buffer.from(
            chunk.subarray(
              0,
              PLASTIC_COMMAND_MAX_STDERR_BYTES - stderrBytes,
            ),
          );
          stderr.push(retained);
          stderrBytes += retained.byteLength;
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          reject(
            new PlasticCommandFailure(
              `Could not run ${commandLabel(executable, args)}.`,
              {
                args,
                cause: error,
              },
            ),
          );
        });
        child.on("close", (exitCode) => {
          if (settled) return;
          settled = true;
          const stdoutBuffer = Buffer.concat(stdout, stdoutBytes);
          const stderrText = Buffer.concat(stderr).toString("utf8");
          if (exitCode === 0) {
            resolve(stdoutBuffer);
            return;
          }
          reject(
            new PlasticCommandFailure(
              `${commandLabel(executable, args)} exited with code ${String(exitCode)}.`,
              {
                args,
                exitCode,
                stderr: stderrText,
                stdout: stdoutBuffer.toString("utf8"),
              },
            ),
          );
        });
      });
    },

    runSync(args, cwd) {
      const result = spawnSync(executable, args, {
        cwd,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
        // Status and revision inventories are normally small. This cap also lets
        // large workspaces exceed Node's 1 MiB default without unbounded polling output.
        maxBuffer: PLASTIC_COMMAND_MAX_STDOUT_BYTES,
      });
      if (result.error) {
        if (
          "code" in result.error &&
          (result.error as NodeJS.ErrnoException).code === "ENOBUFS"
        ) {
          throw new PlasticCommandOutputTooLarge(
            args,
            PLASTIC_COMMAND_MAX_STDOUT_BYTES,
          );
        }
        throw new PlasticCommandFailure(
          `Could not run ${commandLabel(executable, args)}.`,
          {
            args,
            cause: result.error,
          },
        );
      }
      const stdout = Buffer.from(result.stdout ?? []);
      const stderr = Buffer.from(result.stderr ?? []).toString("utf8");
      if (result.status !== 0) {
        throw new PlasticCommandFailure(
          `${commandLabel(executable, args)} exited with code ${String(result.status)}.`,
          {
            args,
            exitCode: result.status,
            stderr,
            stdout: stdout.toString("utf8"),
          },
        );
      }
      return stdout;
    },
  };
}
