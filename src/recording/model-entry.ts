import { parseRecordingWorkerEntryConfig } from "./entry-config.js";
import { loadRecordingModels } from "./worker-runtime.js";
import { runRecordingModelServer } from "./model-server.js";

process.exitCode = await runRecordingModelServer({
  input: process.stdin, output: process.stdout, diagnostics: process.stderr,
  load: () => loadRecordingModels(parseRecordingWorkerEntryConfig(process.argv.slice(2))),
}).catch(() => 1);
