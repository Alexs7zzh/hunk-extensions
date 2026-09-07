import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "hunk-extensions-install-"));
const source = join(temporaryRoot, "hunk-extensions");
const home = join(temporaryRoot, "home");
const configHome = join(home, ".config");
const workspace = join(temporaryRoot, "workspace");
const commandDirectory = join(temporaryRoot, "bin");
const hunkEntrypoint = join(root, "node_modules", "hunkdiff", "bin", "hunk.cjs");
const version = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  }
).version;

function run(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    expectStatus?: number;
  } = {},
) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  const expected = options.expectStatus ?? 0;
  if (result.status !== expected) {
    throw new Error(
      [
        `${command} ${args.join(" ")} exited with ${String(result.status)}; expected ${expected}.`,
        result.stdout,
        result.stderr,
        result.error?.message,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}

function copyCandidate() {
  mkdirSync(source, { recursive: true });
  const listed = run("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]).stdout;

  for (const relativePath of listed.split("\0")) {
    if (!relativePath) continue;
    const from = join(root, relativePath);
    if (!existsSync(from)) continue;
    const to = join(source, relativePath);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }

  run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: source });
  run("git", ["config", "user.name", "Hunk install smoke test"], {
    cwd: source,
  });
  run("git", ["config", "user.email", "hunk-install@example.invalid"], {
    cwd: source,
  });
  run("git", ["add", "."], { cwd: source });
  run("git", ["commit", "--quiet", "-m", "install smoke test"], {
    cwd: source,
  });
}

try {
  copyCandidate();
  mkdirSync(join(configHome, "hunk"), { recursive: true });
  mkdirSync(join(workspace, ".plastic"), { recursive: true });
  mkdirSync(commandDirectory, { recursive: true });

  const cmExecutable =
    process.platform === "win32"
      ? join(commandDirectory, "cm.cmd")
      : join(commandDirectory, "cm");
  writeFileSync(
    cmExecutable,
    process.platform === "win32"
      ? "@echo hunk-install-smoke 1>&2\r\n@exit /b 17\r\n"
      : "#!/bin/sh\nprintf '%s\\n' hunk-install-smoke >&2\nexit 17\n",
  );
  if (process.platform !== "win32") chmodSync(cmExecutable, 0o755);

  const environment = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: configHome,
    PATH: `${commandDirectory}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
  };

  const install = run(
    process.execPath,
    [hunkEntrypoint, "extension", "install", "--yes", source],
    { env: environment },
  );
  if (!install.stdout.includes(`Installed hunk-extensions v${version}`)) {
    throw new Error(`Unexpected install output:\n${install.stdout}${install.stderr}`);
  }

  const list = run(process.execPath, [hunkEntrypoint, "extension", "list"], {
    env: environment,
  });
  if (!list.stdout.includes(`hunk-extensions  v${version}`)) {
    throw new Error(`Installed collection was not listed:\n${list.stdout}`);
  }

  writeFileSync(join(source, "smoke-update.txt"), "updated\n");
  run("git", ["add", "smoke-update.txt"], { cwd: source });
  run("git", ["commit", "--quiet", "-m", "smoke-test update"], {
    cwd: source,
  });
  const update = run(
    process.execPath,
    [hunkEntrypoint, "extension", "update", "hunk-extensions"],
    { env: environment },
  );
  if (!update.stdout.includes("Updated hunk-extensions")) {
    throw new Error(`Unexpected update output:\n${update.stdout}${update.stderr}`);
  }

  writeFileSync(join(configHome, "hunk", "config.toml"), 'vcs = "plastic"\n');
  const review = run(process.execPath, [hunkEntrypoint, "diff"], {
    cwd: workspace,
    env: environment,
    expectStatus: 1,
  });
  if (!review.stderr.includes("hunk-install-smoke")) {
    throw new Error(
      `Installed Plastic adapter did not handle the review:\n${review.stdout}${review.stderr}`,
    );
  }

  const installedManifest = join(
    configHome,
    "hunk",
    "extensions",
    "installed",
    "hunk-extensions",
    "plastic",
    "package.json",
  );
  const manifest = JSON.parse(readFileSync(installedManifest, "utf8")) as {
    hunk?: { extensions?: string[]; apiVersion?: number };
  };
  if (
    manifest.hunk?.apiVersion !== 14 ||
    manifest.hunk.extensions?.[0] !== "./index.ts"
  ) {
    throw new Error("Installed Plastic extension manifest is invalid.");
  }

  console.log(
    "Hunk installed and updated the collection, then loaded the Plastic adapter.",
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
