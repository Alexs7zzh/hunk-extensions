import type { HunkExtensionAPI } from "hunkdiff/extension";
import { createPlasticVcsAdapter } from "./src/adapter";

export default function registerPlasticExtension(hunk: HunkExtensionAPI) {
  hunk.registerVcsAdapter(
    createPlasticVcsAdapter({ apiVersion: hunk.apiVersion }),
  );
}

export { createPlasticVcsAdapter, PlasticVcsAdapter } from "./src/adapter";
