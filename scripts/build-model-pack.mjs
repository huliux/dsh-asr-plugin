import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expandHomePath } from "@deepseek-ai/dsh-home-paths";

import { buildModelPack } from "../dist/maintenance/model-pack-builder.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--");
const packIndex = arguments_.indexOf("--pack");
const pack = packIndex === -1 ? undefined : arguments_[packIndex + 1];
if (packIndex !== -1) arguments_.splice(packIndex, 2);

if (arguments_.length < 1 || arguments_.length > 2 ||
  (packIndex !== -1 && pack !== "base" && pack !== "punctuation")) {
  process.stderr.write("usage: pnpm build:model-pack <output.tar> [model-root] [--pack base|punctuation]\n");
  process.exitCode = 2;
} else {
  try {
    const result = await buildModelPack({
      outputPath: resolve(expandHomePath(arguments_[0])),
      modelRoot: resolve(expandHomePath(arguments_[1] ?? resolve(repositoryRoot, "data/assets"))),
      packageRoot: repositoryRoot,
      ...(pack === undefined ? {} : { pack }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "MODEL_PACK_BUILD_FAILED";
    process.stderr.write(`${JSON.stringify({ code })}\n`);
    process.exitCode = 1;
  }
}
