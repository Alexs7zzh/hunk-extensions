import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

interface Manifest {
  name?: unknown;
  version?: unknown;
  hunk?: {
    extensions?: unknown;
    apiVersion?: unknown;
  };
}

const root = resolve(import.meta.dir, "..");
const rootManifest = readManifest(join(root, "package.json"));

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

if (typeof rootManifest.version !== "string") {
  throw new Error("The collection package.json needs a version.");
}
if (rootManifest.hunk !== undefined) {
  throw new Error(
    "The collection package.json must not declare a hunk entry; Hunk must scan the extension folders.",
  );
}

const extensions: string[] = [];
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
  const manifestPath = join(root, entry.name, "package.json");
  if (!existsSync(manifestPath)) continue;

  const manifest = readManifest(manifestPath);
  if (manifest.hunk === undefined) continue;
  const declaredEntries = manifest.hunk.extensions;
  if (
    !Array.isArray(declaredEntries) ||
    declaredEntries.length === 0 ||
    !declaredEntries.every((path) => typeof path === "string")
  ) {
    throw new Error(`${entry.name}/package.json has no usable hunk.extensions.`);
  }
  if (typeof manifest.hunk.apiVersion !== "number") {
    throw new Error(`${entry.name}/package.json needs a numeric hunk.apiVersion.`);
  }
  if (manifest.version !== rootManifest.version) {
    throw new Error(
      `${entry.name}/package.json version must match the collection version ${rootManifest.version}.`,
    );
  }
  for (const declaredEntry of declaredEntries as string[]) {
    if (!existsSync(resolve(root, entry.name, declaredEntry))) {
      throw new Error(
        `${entry.name}/package.json declares missing entry ${declaredEntry}.`,
      );
    }
  }
  extensions.push(entry.name);
}

if (extensions.length === 0) {
  throw new Error("The collection does not contain a Hunk extension.");
}

const releaseTag = process.env.RELEASE_TAG;
if (releaseTag && releaseTag !== `v${rootManifest.version}`) {
  throw new Error(
    `Release tag ${releaseTag} does not match collection version v${rootManifest.version}.`,
  );
}

console.log(
  `Validated ${extensions.length} extension${extensions.length === 1 ? "" : "s"}: ${extensions.join(", ")}.`,
);
