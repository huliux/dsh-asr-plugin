import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClosedPilotNativeReleaseError,
  materializeClosedPilotNatives,
} from "./release/closed-pilot-native.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  if (process.argv.length !== 2) throw new Error("this command does not accept input paths");
  const report = await materializeClosedPilotNatives({ repositoryRoot });
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  const failure = error instanceof ClosedPilotNativeReleaseError
    ? { code: error.code, message: error.message,
      ...(error.assetId === undefined ? {} : { assetId: error.assetId }) }
    : { code: "RELEASE_BUILD_FAILED" };
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}
