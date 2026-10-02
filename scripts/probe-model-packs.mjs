import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { doctorRuntimeAssets, stageModelPack } from "../dist/assets/runtime-assets.js";
import { fingerprintAssetManifest } from "../dist/assets/verify-assets.js";
import { createPackagedWorkerLaunch } from "../dist/worker/launch.js";
import { createNodeWorkerSpawner } from "../dist/worker/node-spawner.js";
import { WorkerClient } from "../dist/worker/worker-client.js";

const execFile = promisify(execFileCallback);
const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(scriptPath), "..");
const nativeRoot = join(packageRoot, "dist");
const manifestPath = join(nativeRoot, "assets/manifest.json");

async function loadBaseComponents(modelRoot) {
  const { loadVadModel } = await import("../dist/asr/vad-model.js");
  const { loadFunAsrRecognizer } = await import("../dist/asr/funasr/recognizer.js");
  const loaded = [];
  try {
    loaded.push(await loadVadModel(join(modelRoot, "models/vad/model.onnx")));
    loaded.push(await loadFunAsrRecognizer({
      cmvnPath: join(modelRoot, "models/asr/am.mvn"),
      configPath: join(modelRoot, "models/asr/config.yaml"),
      modelPath: join(modelRoot, "models/asr/model_quant.onnx"),
      tokensPath: join(modelRoot, "models/asr/tokens.json"),
      fbankPath: join(nativeRoot, "native/darwin-arm64/fbank.node"),
    }));
    return { loaded: ["vad", "asr"], maxRssBytes: process.resourceUsage().maxRSS * 1024 };
  } finally {
    await Promise.all(loaded.map((component) => component.close()));
  }
}

async function loadPunctuation(modelRoot) {
  const { loadFunAsrPunctuator } = await import("../dist/asr/funasr/punctuator.js");
  const loaded = await loadFunAsrPunctuator({
    configPath: join(modelRoot, "models/punc/config.yaml"),
    modelPath: join(modelRoot, "models/punc/model_quant.onnx"),
    tokensPath: join(modelRoot, "models/punc/tokens.json"),
  });
  try {
    const result = await loaded.punctuate("模型交付验证");
    assert(result.punctuationIds.length > 0);
    return { loaded: ["punctuation"], inference: true,
      maxRssBytes: process.resourceUsage().maxRSS * 1024 };
  } finally {
    await loaded.close();
  }
}

async function loadInProcess(kind, root) {
  const { stdout } = await execFile(process.execPath, [scriptPath, "--load", kind, root], {
    timeout: 180_000, maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function writeSilence(audioPath) {
  const wav = Buffer.alloc(44 + 32_000);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(32_000, 40);
  await writeFile(audioPath, wav);
}

async function probeDiarization(modelRoot, managedAudioDirectory) {
  const audioPath = join(managedAudioDirectory, "silence.wav");
  await writeSilence(audioPath);
  const client = new WorkerClient({
    kind: "diarization", expectedFingerprint: await fingerprintAssetManifest(manifestPath),
    spawner: createNodeWorkerSpawner(),
    launch: createPackagedWorkerLaunch({ kind: "diarization", modelRoot,
      packagedNativeRoot: nativeRoot, manifestPath, managedAudioDirectory, graceMs: 2000 }),
    readyTimeoutMs: 180_000, runDeadlineMs: 180_000, terminationTimeoutMs: 15_000,
  });
  let ready;
  const result = await client.run({ type: "run", kind: "diarization",
    request_id: "model-delivery", base_transcript_version: 0,
    payload: { audio_path: audioPath, duration_ms: 1000,
      blocks: [{ seq: 0, start_ms: 0, end_ms: 1000, text: "probe" }], speech_regions: [] },
  }, { onReady: (message) => { ready = message; } });
  assert(ready && result.kind === "diarization");
  return { ready: true, loadMs: ready.load_ms, segmentCount: result.payload.segments.length,
    maxRssBytes: result.payload.metrics.max_rss_bytes };
}

async function interruptImport(input) {
  const controller = new AbortController();
  const storeRoot = join(input.dataRoot, "assets");
  const watcher = watch(storeRoot, (_event, name) => {
    if (name?.startsWith(".stage-")) controller.abort();
  });
  try {
    await assert.rejects(stageModelPack({ ...input, signal: controller.signal }),
      { code: "STAGE_ABORTED" });
    assert((await readdir(storeRoot)).every((name) => !name.startsWith(".")));
  } finally {
    watcher.close();
  }
}

async function probe(basePath, punctuationPath) {
  const root = await mkdtemp(join(tmpdir(), "dsh-asr-model-packs-"));
  const input = { dataRoot: join(root, "dsh-asr-plugin"), packageRoot };
  try {
    const base = await stageModelPack({ ...input, modelPackPath: basePath });
    const baseDoctor = await doctorRuntimeAssets(input);
    assert(baseDoctor.ready && !baseDoctor.enhancedReady);
    assert(baseDoctor.groups.punctuation.checks.every((check) => check.hashStatus === "missing"));
    const modelRoot = join(input.dataRoot, "assets", base.modelSetFingerprint);
    const baseLoad = await loadInProcess("base", modelRoot);
    const audioRoot = join(root, "audio");
    await mkdir(audioRoot);
    const diarization = await probeDiarization(modelRoot, audioRoot);
    await interruptImport({ ...input, modelPackPath: punctuationPath });
    assert((await doctorRuntimeAssets(input)).ready);
    const punctuation = await stageModelPack({ ...input, modelPackPath: punctuationPath });
    const punctuationLoad = await loadInProcess("punctuation",
      join(input.dataRoot, "assets", punctuation.modelSetFingerprint));
    const enhancedDoctor = await doctorRuntimeAssets(input);
    assert(enhancedDoctor.ready && enhancedDoctor.enhancedReady);
    assert(!(await stageModelPack({ ...input, modelPackPath: basePath })).installed);
    assert(!(await stageModelPack({ ...input, modelPackPath: punctuationPath })).installed);
    return { ok: true, base, punctuation, baseLoad, diarization, punctuationLoad,
      interruptedImportPreservedBase: true, repeatedImports: "idempotent",
      baseDoctor, enhancedDoctor, productModesQualified: false };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

try {
  const args = process.argv.slice(2);
  let report;
  if (args.length === 3 && args[0] === "--load") {
    report = args[1] === "base" ? await loadBaseComponents(args[2]) :
      args[1] === "punctuation" ? await loadPunctuation(args[2]) : undefined;
  } else if (args.length === 2) {
    report = await probe(resolve(args[0]), resolve(args[1]));
  }
  if (report === undefined) throw new Error("INVALID_ARGUMENTS");
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false,
    code: error?.code ?? "MODEL_PACK_PROBE_FAILED" })}\n`);
  process.exitCode = 1;
}
