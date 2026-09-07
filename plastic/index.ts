import type { HunkExtensionAPI } from "hunkdiff/extension";
import { PlasticVcsAdapter } from "./src/adapter";

export default function registerPlasticExtension(hunk: HunkExtensionAPI) {
  hunk.registerVcsAdapter(PlasticVcsAdapter);
}

export { createPlasticVcsAdapter, PlasticVcsAdapter } from "./src/adapter";
