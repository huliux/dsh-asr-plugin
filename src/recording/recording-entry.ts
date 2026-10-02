import { parseRecordingWorkerEntryConfig } from "./entry-config.js";
import { loadRecordingWorkerRuntime } from "./worker-runtime.js";
import { runRecordingWorkerServer } from "./worker-server.js";

process.exitCode = await runRecordingWorkerServer({
  input: process.stdin,
  output: process.stdout,
  diagnostics: process.stderr,
  load: () => loadRecordingWorkerRuntime(
    parseRecordingWorkerEntryConfig(process.argv.slice(2)),
  ),
});
