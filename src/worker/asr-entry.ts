import { loadAsrWorkerRuntime } from "./asr-runtime.js";
import { parseWorkerEntryConfig } from "./entry-config.js";
import { runWorkerServer } from "./worker-server.js";

process.exitCode = await runWorkerServer({
  kind: "asr",
  input: process.stdin,
  output: process.stdout,
  diagnostics: process.stderr,
  load: () => loadAsrWorkerRuntime(parseWorkerEntryConfig(process.argv.slice(2))),
});
