import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const CADENCE_MS = 5_000;
const SAMPLE_RATE = 16_000;
const RECORDING_ASSET_IDS = [
  "vad-model", "asr-cmvn", "asr-config", "asr-model", "asr-tokens", "fbank-native",
  "punc-config", "punc-model", "punc-tokens", "speaker-embedding-model", "hcluster-native",
];

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`MISSING_${name}`);
  return value;
}

function requestedDuration(argument, availableMs) {
  if (argument === "full") return availableMs;
  const value = Number(argument);
  if (!Number.isSafeInteger(value) || value <= 0 || value > availableMs) {
    throw new Error("AUDIO_DURATION_INVALID");
  }
  return value;
}

async function loadInstalledModules(packageRoot) {
  const load = (path) => import(pathToFileURL(join(packageRoot, "dist", path)).href);
  const modules = await Promise.all([
    load("assets/runtime-assets.js"), load("assets/verify-assets.js"),
    load("asr/bounded-vad.js"), load("asr/funasr/factory.js"),
    load("asr/funasr/pipeline.js"), load("asr/vad-model.js"),
    load("audio/recording-audio-candidate.js"), load("audio/recording-timeline.js"),
    load("audio/wav-reader.js"), load("diarization/factory.js"),
    load("diarization/meeting-diarizer.js"), load("recording/authoritative-engine.js"),
    load("recording/draft-engine.js"), load("recording/draft-recognizer.js"),
    load("recording/final-cache.js"), load("storage/meeting-repository.js"),
  ]);
  const names = [
    "runtime", "assets", "boundedVad", "funasrFactory", "funasrPipeline", "vadModel",
    "candidate", "timeline", "wav", "diarizationFactory", "diarizer", "authority",
    "draft", "draftRecognizer", "cache", "repository",
  ];
  return Object.fromEntries(names.map((name, index) => [name, modules[index]]));
}

class GrowingChunks {
  constructor(reader, durationMs, buildTimeline) {
    this.reader = reader;
    this.durationFrames = Math.min(
      reader.metadata.frameCount,
      Math.floor(durationMs * SAMPLE_RATE / 1_000),
    );
    this.availableFrames = 0;
    this.buildTimeline = buildTimeline;
  }

  setAvailableMs(value) {
    this.availableFrames = Math.min(
      this.durationFrames,
      Math.floor(value * SAMPLE_RATE / 1_000),
    );
  }

  async scan() {
    if (this.availableFrames === 0) return null;
    const chunks = [];
    const cadenceFrames = CADENCE_MS * SAMPLE_RATE / 1_000;
    for (let start = 0; start < this.availableFrames; start += cadenceFrames) {
      const end = Math.min(this.availableFrames, start + cadenceFrames);
      chunks.push({
        id: String(start),
        track: "mic",
        startUs: 1_000_000 + Math.round(start * 1_000_000 / SAMPLE_RATE),
        endUs: 1_000_000 + Math.round(end * 1_000_000 / SAMPLE_RATE),
        frameCount: end - start,
      });
    }
    return this.buildTimeline(chunks);
  }

  read(chunk, start, end) {
    return this.reader.readFrames(Number(chunk.id) + start, Number(chunk.id) + end);
  }
}

function required(paths, id) {
  const value = paths[id];
  if (value === undefined) throw new Error(`ASSET_MISSING_${id}`);
  return value;
}

async function loadComponents(modules, paths) {
  const vad = await modules.vadModel.loadVadModel(required(paths, "vad-model"));
  const factory = modules.funasrFactory.createFunAsrRuntimeFactory({
    asrCmvnPath: required(paths, "asr-cmvn"),
    asrConfigPath: required(paths, "asr-config"),
    asrModelPath: required(paths, "asr-model"),
    asrTokensPath: required(paths, "asr-tokens"),
    fbankPath: required(paths, "fbank-native"),
    punctuationConfigPath: required(paths, "punc-config"),
    punctuationModelPath: required(paths, "punc-model"),
    punctuationTokensPath: required(paths, "punc-tokens"),
  });
  const recognizer = await factory.loadRecognizer();
  const punctuator = await factory.loadPunctuator();
  const diarization = await modules.diarizationFactory.loadMeetingDiarizationComponents({
    embeddingModelPath: required(paths, "speaker-embedding-model"),
    fbankPath: required(paths, "fbank-native"),
    hclusterPath: required(paths, "hcluster-native"),
  });
  return { vad, recognizer, punctuator, diarization };
}

function authoritativeEngine(modules, components, chunks, cache, fingerprint) {
  return new modules.authority.RecordingAuthoritativeEngine({
    cache,
    chunks,
    engineFingerprint: fingerprint,
    kernels: {
      embeddingModel: components.diarization.embeddingModel,
      createVad: (reader) => new modules.boundedVad.StreamingBoundedVad(reader, components.vad),
      transcribe: (reader, regions) => modules.funasrPipeline.runFunAsrWithLoadedRuntime(
        reader, regions, components,
      ),
      async diarize(reader, blocks, regions, embeddingModel) {
        const diarizer = modules.diarizer.createMeetingDiarizer({
          clusterer: components.diarization.clusterer,
          embeddingModel,
        });
        try {
          return await diarizer.diarize(reader, blocks, regions);
        } finally {
          await diarizer.close();
        }
      },
    },
  });
}

function transcriptSignature(segments) {
  const facts = segments.map((segment) => ({
    seq: segment.seq,
    startMs: segment.startMs,
    endMs: segment.endMs,
    speakerLabel: segment.speakerLabel,
    text: segment.text,
  }));
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex");
}

function rounded(value) {
  return Number(value.toFixed(3));
}

async function exerciseCadence(engines, chunks, durationMs) {
  const draftTimes = [];
  const authoritativeTimes = [];
  const backlogs = [];
  let simulatedFinishMs = 0;
  for (let availableMs = CADENCE_MS; availableMs < durationMs; availableMs += CADENCE_MS) {
    chunks.incremental.setAvailableMs(availableMs);
    const startAtMs = Math.max(availableMs, simulatedFinishMs);
    const draftStarted = performance.now();
    const revision = await engines.draft.nextRevision();
    if (revision === null) throw new Error("DRAFT_REVISION_MISSING");
    const draftMs = performance.now() - draftStarted;
    const authorityStarted = performance.now();
    await engines.authoritative.advance();
    const authorityMs = performance.now() - authorityStarted;
    backlogs.push(startAtMs - availableMs);
    draftTimes.push(draftMs);
    authoritativeTimes.push(authorityMs);
    simulatedFinishMs = startAtMs + draftMs + authorityMs;
  }
  const maximumBacklogMs = Math.max(0, ...backlogs);
  const worstCaseFreshnessMs = CADENCE_MS + Math.max(
    0,
    ...draftTimes.map((time, index) => time + backlogs[index]),
  );
  return {
    maximumBacklogMs: rounded(maximumBacklogMs),
    worstCaseFreshnessMs: rounded(worstCaseFreshnessMs),
    draftMaxMs: rounded(Math.max(0, ...draftTimes)),
    authoritativeMaxMs: rounded(Math.max(0, ...authoritativeTimes)),
  };
}

async function commitIncremental(modules, input) {
  const {
    chunks, durationMs, engine, fingerprint, paths, repository, meetingId, runId,
    recordingEndedAtMs,
  } = input;
  chunks.incremental.setAvailableMs(durationMs);
  chunks.candidate.setAvailableMs(durationMs);
  repository.beginRecordingFinalization({
    meetingId,
    runId,
    baseVersion: 0,
    recordingEndedAtMs,
    nowMs: recordingEndedAtMs,
  });
  const started = performance.now();
  const [finalized, candidate] = await Promise.all([
    engine.finalize(),
    modules.candidate.buildRecordingAudioCandidate(paths, chunks.candidate),
  ]);
  const promoted = await modules.candidate.verifyAndPromoteRecordingAudio(paths, candidate);
  const committed = repository.commitTranscript({
    meetingId, runId, baseVersion: 0,
    resultStatus: finalized.resultStatus,
    resultReason: finalized.resultReason,
    durationMs: finalized.durationMs,
    sourceSizeBytes: promoted.sourceSizeBytes,
    sourceSha256: promoted.sourceSha256,
    engineFingerprint: fingerprint,
    segments: finalized.segments,
    nowMs: Date.now(),
  });
  if (committed.outcome !== "committed") throw new Error("SQLITE_COMMIT_FAILED");
  return { finalized, stopToCommitMs: performance.now() - started };
}

async function referenceResult(modules, components, chunks, cacheRoot, fingerprint, durationMs) {
  chunks.reference.setAvailableMs(durationMs);
  const cache = await modules.cache.openRecordingFinalCache(cacheRoot, fingerprint);
  return authoritativeEngine(modules, components, chunks.reference, cache, fingerprint).finalize();
}

async function verifiedAssets(modules, packageRoot, dataRoot) {
  const runtime = await modules.runtime.resolveRuntimeAssets({ packageRoot, dataRoot });
  const paths = await modules.assets.verifyAssetsAtRoots({
    assetIds: RECORDING_ASSET_IDS,
    manifestPath: runtime.manifestPath,
    modelRoot: runtime.modelRoot,
    packagedNativeRoot: runtime.packagedNativeRoot,
  });
  return { paths, runtime };
}

async function prepareRunRoot(root, meetingId) {
  const runRoot = join(root, randomUUID());
  const paths = {
    meetingDirectory: join(runRoot, "meetings", meetingId),
    recordingDirectory: join(runRoot, "meetings", meetingId, "recording"),
    workRecordingDirectory: join(runRoot, "work", meetingId, "recording"),
  };
  await Promise.all([
    mkdir(join(paths.recordingDirectory, "mic", "chunks"), { recursive: true, mode: 0o700 }),
    mkdir(join(paths.recordingDirectory, "system", "chunks"), { recursive: true, mode: 0o700 }),
    mkdir(paths.workRecordingDirectory, { recursive: true, mode: 0o700 }),
  ]);
  return { paths, runRoot };
}

async function closeResources(readers, components) {
  await Promise.allSettled([
    ...readers.map((reader) => reader?.close()),
    components?.vad.close(),
    components?.recognizer.close(),
    components?.punctuator.close(),
    components?.diarization.embeddingModel.close(),
  ].filter(Boolean));
}

function replayWitness(durationMs, cadence, committed, reference) {
  return {
    status: "passed",
    duration_ms: durationMs,
    draft: {
      worst_case_freshness_ms: cadence.worstCaseFreshnessMs,
      maximum_backlog_ms: cadence.maximumBacklogMs,
      draft_max_ms: cadence.draftMaxMs,
      authoritative_max_ms: cadence.authoritativeMaxMs,
    },
    stop: {
      stop_to_commit_ms: rounded(committed.stopToCommitMs),
      under_30_seconds: committed.stopToCommitMs < 30_000,
    },
    correctness: {
      exact_segment_match: transcriptSignature(committed.finalized.segments) ===
        transcriptSignature(reference.segments),
      incremental_segment_count: committed.finalized.segments.length,
      reference_segment_count: reference.segments.length,
      result_status_match: committed.finalized.resultStatus === reference.resultStatus,
      result_reason_match: committed.finalized.resultReason === reference.resultReason,
      duration_ms_match: committed.finalized.durationMs === reference.durationMs,
    },
    resources: { max_rss_bytes: process.resourceUsage().maxRSS * 1_024 },
  };
}

async function executeReplay(modules, installed, resources, durationMs, probeRoot) {
  const buildTimeline = modules.timeline.buildRecordingTimeline;
  const chunks = {
    incremental: new GrowingChunks(resources.readers[0], durationMs, buildTimeline),
    candidate: new GrowingChunks(resources.readers[1], durationMs, buildTimeline),
    reference: new GrowingChunks(resources.readers[2], durationMs, buildTimeline),
  };
  resources.components = await loadComponents(modules, installed.paths);
  const meetingId = randomUUID();
  const runId = randomUUID();
  const prepared = await prepareRunRoot(probeRoot, meetingId);
  resources.runRoot = prepared.runRoot;
  const incrementalCacheRoot = join(resources.runRoot, "incremental-cache");
  const referenceCacheRoot = join(resources.runRoot, "reference-cache");
  const fingerprint = installed.runtime.engineFingerprint;
  const cache = await modules.cache.openRecordingFinalCache(incrementalCacheRoot, fingerprint);
  const authoritative = authoritativeEngine(
    modules, resources.components, chunks.incremental, cache, fingerprint,
  );
  const draft = new modules.draft.RecordingDraftEngine({
    chunks: chunks.incremental,
    recognize: modules.draftRecognizer.createRecordingDraftRecognizer(
      resources.components.vad, resources.components,
    ),
  });
  resources.repository = modules.repository.openMeetingRepository(
    join(resources.runRoot, "meetings.sqlite3"),
  );
  const recordingEndedAtMs = Date.now();
  const recordingStartedAtMs = recordingEndedAtMs - durationMs;
  resources.repository.createRecording({
    meetingId, runId, title: "p1c-replay", nowMs: recordingStartedAtMs,
  });
  resources.repository.recordRecordingStarted({
    meetingId, runId, startedAtMs: recordingStartedAtMs,
  });
  const cadence = await exerciseCadence({ authoritative, draft }, chunks, durationMs);
  const committed = await commitIncremental(modules, {
    chunks, durationMs, engine: authoritative, fingerprint,
    paths: prepared.paths, repository: resources.repository, meetingId, runId, recordingEndedAtMs,
  });
  const reference = await referenceResult(
    modules, resources.components, chunks, referenceCacheRoot, fingerprint, durationMs,
  );
  return replayWitness(durationMs, cadence, committed, reference);
}

async function openReaders(modules, audioPath) {
  return Promise.all([
    modules.wav.openPcm16Wav(audioPath),
    modules.wav.openPcm16Wav(audioPath),
    modules.wav.openPcm16Wav(audioPath),
  ]);
}

async function run() {
  const packageRoot = await realpath(requiredEnvironment("P1C_PACKAGE_ROOT"));
  const dataRoot = await realpath(requiredEnvironment("P1C_DATA_ROOT"));
  const [audioPath, durationArgument] = process.argv.slice(2);
  if (audioPath === undefined || durationArgument === undefined) throw new Error("INVALID_ARGUMENTS");
  const modules = await loadInstalledModules(packageRoot);
  const installed = await verifiedAssets(modules, packageRoot, dataRoot);
  const resources = { readers: [], components: undefined, runRoot: undefined, repository: undefined };
  try {
    resources.readers = await openReaders(modules, audioPath);
    const durationMs = requestedDuration(
      durationArgument,
      resources.readers[0].metadata.durationMs,
    );
    return await executeReplay(
      modules, installed, resources, durationMs, requiredEnvironment("P1C_PROBE_ROOT"),
    );
  } finally {
    resources.repository?.close();
    await closeResources(resources.readers, resources.components);
    if (resources.runRoot !== undefined) {
      await rm(resources.runRoot, { force: true, recursive: true });
    }
  }
}

try {
  process.stdout.write(`${JSON.stringify(await run())}\n`);
} catch (error) {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "P1C_REPLAY_INTERNAL_ERROR";
  process.stdout.write(`${JSON.stringify({ status: "failed", error_code: code })}\n`);
  process.exitCode = 1;
}
