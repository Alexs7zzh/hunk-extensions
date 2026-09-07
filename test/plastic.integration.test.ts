import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { ExtensionVcsExtraFile } from "hunkdiff/extension";
import { PlasticVcsAdapter } from "../plastic";

const workspace = process.env.PLASTIC_TEST_WORKSPACE;

if (!workspace) {
  throw new Error(
    "PLASTIC_TEST_WORKSPACE must name a real Plastic SCM workspace.",
  );
}

const cwd = resolve(workspace);

function expectReviewFiles(
  files: readonly ExtensionVcsExtraFile[] | undefined,
  requireFiles = false,
) {
  if (requireFiles) expect(files?.length ?? 0).toBeGreaterThan(0);
  for (const file of files ?? []) {
    if (file.kind === "patch") {
      expect(file.patchText).toStartWith("diff --git ");
    } else {
      expect(file.reason).toBe("too-large");
    }
  }
}

test("reads a real Plastic workspace without changing it", async () => {
  const detected = PlasticVcsAdapter.detect(cwd);
  expect(detected).not.toBeNull();
  if (!detected) throw new Error("Plastic workspace detection failed.");
  expect(detected.id).toBe("plastic");

  const operation = PlasticVcsAdapter.operations?.["working-tree-diff"];
  expect(operation).toBeDefined();
  const result = await operation!.load(
    {
      kind: "vcs",
      staged: false,
      pathspecs: [],
      options: {},
    },
    { cwd },
  );

  expect(result.repoRoot).toBe(detected.repoRoot);
  expectReviewFiles(result.extraFiles);
});

const revision = process.env.PLASTIC_TEST_REF;
const revisionTest = revision ? test : test.skip;

revisionTest("reads a real Plastic revision", async () => {
  const operation = PlasticVcsAdapter.operations?.["revision-show"];
  expect(operation).toBeDefined();
  const result = await operation!.load(
    {
      kind: "show",
      ref: revision!,
      options: {},
    },
    { cwd },
  );

  expectReviewFiles(result.extraFiles, true);
});

const from = process.env.PLASTIC_TEST_FROM;
const to = process.env.PLASTIC_TEST_TO;

if ((from === undefined) !== (to === undefined)) {
  throw new Error(
    "PLASTIC_TEST_FROM and PLASTIC_TEST_TO must be provided together.",
  );
}

const rangeTest = from && to ? test : test.skip;

rangeTest("compares two real Plastic revisions", async () => {
  const operation = PlasticVcsAdapter.operations?.["working-tree-diff"];
  expect(operation).toBeDefined();
  const result = await operation!.load(
    {
      kind: "vcs",
      rangeEndpoints: { from: from!, to: to! },
      staged: false,
      pathspecs: [],
      options: {},
    },
    { cwd },
  );

  expectReviewFiles(result.extraFiles, true);
});
