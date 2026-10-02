import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stageAssets } from "../dist/assets/stage-assets.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseSources(arguments_) {
  const sources = {};
  for (const argument of arguments_) {
    const separator = argument.indexOf("=");
    if (separator < 1 || separator === argument.length - 1) {
      throw new Error(`Expected id=source_path, received: ${argument}`);
    }
    const id = argument.slice(0, separator);
    if (Object.hasOwn(sources, id)) throw new Error(`Duplicate asset source: ${id}`);
    sources[id] = resolve(argument.slice(separator + 1));
  }
  return sources;
}

const result = await stageAssets({
  assetRoot: resolve(repositoryRoot, "data/assets"),
  manifestPath: resolve(repositoryRoot, "dist/assets/manifest.json"),
  sources: parseSources(process.argv.slice(2).filter((argument) => argument !== "--")),
});

console.log(JSON.stringify({ staged: Object.keys(result).sort() }));
