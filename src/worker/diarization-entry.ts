import { loadDiarizationWorkerRuntime } from "./diarization-runtime.js";
import { parseWorkerEntryConfig } from "./entry-config.js";
import { runWorkerServer } from "./worker-server.js";

process.exitCode = await runWorkerServer({
  kind: "diarization",
  input: process.stdin,
  output: process.stdout,
  diagnostics: process.stderr,
  load: () => loadDiarizationWorkerRuntime(parseWorkerEntryConfig(process.argv.slice(2))),
});
