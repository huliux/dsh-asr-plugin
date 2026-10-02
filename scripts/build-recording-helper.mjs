import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = resolve(repositoryRoot, "native/recording-helper");
const appSourceRoot = resolve(nativeRoot, "app");
const bitbookRoot = resolve(nativeRoot, "vendor/bitbook-audio");
const stagingRoot = resolve(repositoryRoot, "data/release-staging/recording-helper");
const publicRelease = process.argv.length === 3 && process.argv[2] === "--public-release";
if (!publicRelease && process.argv.length !== 2) throw new Error("unsupported helper build arguments");
const outputRoot = publicRelease ? resolve(repositoryRoot, "dist/recording-helper") : stagingRoot;
const finalApp = resolve(outputRoot, "DSHASRRecordingHelper.app");
const finalManifest = resolve(outputRoot, "manifest.json");
const buildRoot = resolve(dirname(outputRoot), `.recording-helper-build-${randomUUID()}`);
const appRoot = resolve(buildRoot, "DSHASRRecordingHelper.app");
const contentsRoot = resolve(appRoot, "Contents");
const macOSRoot = resolve(contentsRoot, "MacOS");
const embeddedRoot = resolve(contentsRoot, "Helpers");
const protocolTestBinary = resolve(buildRoot, "recording-helper-protocol-tests");
const chunkStoreTestBinary = resolve(buildRoot, "recording-helper-chunk-store-tests");
const processRegistryTestBinary = resolve(buildRoot, "recording-helper-process-registry-tests");
const captureTrackTestBinary = resolve(buildRoot, "recording-helper-capture-track-tests");
const sessionTestBinary = resolve(buildRoot, "recording-helper-session-tests");
const systemFormatTestBinary = resolve(buildRoot, "recording-system-format-tests");
const fakeCaptureRoot = resolve(buildRoot, "fake-capture");
const helperBinary = resolve(macOSRoot, "DSHASRRecordingHelper");
const micBinary = resolve(embeddedRoot, "dsh-asr-capture-mic");
const systemBinary = resolve(embeddedRoot, "dsh-asr-capture-system");
const sourceRevision = "44887f62f7b1a69fcc9d23583aa8df8f11898aca";
const bundleIdentifier = "com.bitbook.dsh-asr.recording-helper";
const developerIDIdentity =
  "Developer ID Application: Example Publisher (EXAMPLE123)";
const developerIDTeamIdentifier = "EXAMPLE123";
const minimumOS = "13.5";

function run(command, args, options = {}) {
  const capture = options.capture === true;
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = capture ? `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() : "";
    throw new Error(
      `Command failed (${String(result.status)}): ${command}${detail ? `\n${detail}` : ""}`,
    );
  }
  return capture ? `${result.stdout ?? ""}${result.stderr ?? ""}` : "";
}

function assertBuildRuntime() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("recording helper build requires Apple Silicon macOS");
  }
}

function requestedSigningIdentity() {
  if (publicRelease) {
    if (process.env.DSH_RECORDING_HELPER_CODESIGN_IDENTITY !== undefined) {
      throw new Error("public helper build must use ad-hoc signing");
    }
    return "-";
  }
  const identity = process.env.DSH_RECORDING_HELPER_CODESIGN_IDENTITY?.trim() || "-";
  if (identity !== "-" && identity !== developerIDIdentity) {
    throw new Error("recording helper signing identity is not the product Developer ID");
  }
  return identity;
}

function compileObjectiveC(output, sources, frameworks) {
  run("/usr/bin/clang", [
    "-fobjc-arc",
    "-O2",
    `-mmacosx-version-min=${minimumOS}`,
    `-I${appSourceRoot}`,
    ...sources,
    ...frameworks.flatMap((framework) => ["-framework", framework]),
    "-o",
    output,
  ]);
}

function compileCxx(output, sources, frameworks, deploymentTarget = minimumOS) {
  run("/usr/bin/clang++", [
    "-std=c++17",
    "-fobjc-arc",
    "-O2",
    `-mmacosx-version-min=${deploymentTarget}`,
    `-I${bitbookRoot}`,
    ...sources.map((path) => resolve(bitbookRoot, path)),
    ...frameworks.flatMap((framework) => ["-framework", framework]),
    "-o",
    output,
  ]);
}

function sign(path, entitlements, identity) {
  const args = ["--force", "--sign", identity, "--options", "runtime"];
  if (identity !== "-") args.push("--timestamp");
  if (entitlements !== undefined) args.push("--entitlements", entitlements);
  args.push(path);
  run("/usr/bin/codesign", args);
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name < right.name
    ? -1
    : left.name > right.name ? 1 : 0)) {
    const path = resolve(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`recording helper output contains symlink: ${path}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`recording helper output contains unsupported file: ${path}`);
  }
  return files;
}

async function identifyFile(root, path) {
  const bytes = await readFile(path);
  return {
    relativePath: relative(root, path),
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function buildManifest(identity) {
  const files = await Promise.all(
    (await listFiles(appRoot)).map((path) => identifyFile(appRoot, path)),
  );
  const treeHash = createHash("sha256");
  for (const file of files) {
    treeHash.update(`${file.relativePath}\0${file.byteLength}\0${file.sha256}\n`);
  }
  const details = run("/usr/bin/codesign", ["-dvvv", appRoot], { capture: true });
  const requirements = run("/usr/bin/codesign", ["-d", "-r-", appRoot], { capture: true });
  const rawTeamIdentifier = /TeamIdentifier=([^\r\n]+)/u.exec(details)?.[1].trim() ?? null;
  const teamIdentifier = rawTeamIdentifier === "not set" ? null : rawTeamIdentifier;
  const leafIdentity = /^Authority=([^\r\n]+)/mu.exec(details)?.[1].trim() ?? null;
  const designatedRequirement = /designated => (.+)/u.exec(requirements)?.[1] ?? null;
  const developerID = identity === developerIDIdentity;
  if (developerID &&
      (leafIdentity !== developerIDIdentity || teamIdentifier !== developerIDTeamIdentifier)) {
    throw new Error("recording helper certificate identity does not match the product owner");
  }
  return {
    schemaVersion: 1,
    source: {
      project: "Bitbook",
      historicalRepository: "https://github.com/kunji163/clerki.git",
      revision: sourceRevision,
      sourcePath: "audio-native/",
      license: "BSD-2-Clause",
    },
    product: {
      bundleIdentifier,
      architecture: "arm64",
      minimumOS,
      systemAudioMinimumOS: "14.2",
      distribution: publicRelease ? "public" : "closed-pilot-only",
      signingMode: developerID ? "developer-id" : "ad-hoc",
      signingIdentity: developerID ? leafIdentity : null,
      teamIdentifier,
      designatedRequirement: developerID ? designatedRequirement : null,
      permissionProbeEligible: publicRelease || developerID,
      hardenedRuntime: true,
      notarization: "not-verified",
      entitlements: {
        app: ["com.apple.security.device.audio-input"],
        microphone: ["com.apple.security.device.audio-input"],
        systemAudio: [],
      },
    },
    components: {
      helper: {
        minimumOS,
        relativePath: "Contents/MacOS/DSHASRRecordingHelper",
      },
      microphone: {
        minimumOS,
        relativePath: "Contents/Helpers/dsh-asr-capture-mic",
      },
      systemAudio: {
        minimumOS: "14.2",
        relativePath: "Contents/Helpers/dsh-asr-capture-system",
      },
    },
    treeSha256: treeHash.digest("hex"),
    files,
  };
}

async function build() {
  assertBuildRuntime();
  const identity = requestedSigningIdentity();
  if (publicRelease) await assertOutputAbsent(outputRoot);
  await mkdir(embeddedRoot, { recursive: true, mode: 0o700 });
  await mkdir(macOSRoot, { recursive: true, mode: 0o700 });
  await mkdir(fakeCaptureRoot, { recursive: true, mode: 0o700 });
  await copyFile(resolve(appSourceRoot, "Info.plist"), resolve(contentsRoot, "Info.plist"));
  await cp(resolve(appSourceRoot, "resources"), resolve(contentsRoot, "Resources"), { recursive: true });

  compileCxx(micBinary, [
    "audio_device_manager.mm",
    "utils/logger.mm",
    "cli/audio_fmt_convert_no_ct_main.mm",
  ], ["Foundation", "AVFoundation", "CoreAudio", "AudioToolbox", "CoreFoundation"]);
  compileCxx(systemBinary, [
    "audio_device_manager.mm",
    "audio_recorder_v4.mm",
    "business/audio_process.mm",
    "business/audio_tap.mm",
    "config/aggregate_device_config.cpp",
    "config/config_types.cpp",
    "config/recorder_config.cpp",
    "config/runtime_config.cpp",
    "config/tap_config.cpp",
    "managers/aggregate_device_manager.mm",
    "managers/process_monitor.mm",
    "managers/process_tap_manager.mm",
    "managers/recording_engine.cpp",
    "managers/system_resource_manager.mm",
    "utils/logger.mm",
    "cli/audio_fmt_convert_main.cpp",
  ], ["Foundation", "CoreAudio", "AudioToolbox", "CoreFoundation"], "14.2");
  compileObjectiveC(helperBinary, [
    resolve(appSourceRoot, "RHJournal.m"),
    resolve(appSourceRoot, "RHChunkStore.m"),
    resolve(appSourceRoot, "RHProcessRegistry.m"),
    resolve(appSourceRoot, "RHCaptureTrack.m"),
    resolve(appSourceRoot, "RHRecordingSession.m"),
    resolve(appSourceRoot, "RHPermissions.m"),
    resolve(appSourceRoot, "main.m"),
  ], ["Foundation", "AVFoundation"]);
  compileObjectiveC(protocolTestBinary, [
    resolve(appSourceRoot, "RHJournal.m"),
    resolve(nativeRoot, "tests/protocol_tests.m"),
  ], ["Foundation"]);
  compileObjectiveC(chunkStoreTestBinary, [
    resolve(appSourceRoot, "RHJournal.m"),
    resolve(appSourceRoot, "RHChunkStore.m"),
    resolve(nativeRoot, "tests/chunk_store_tests.m"),
  ], ["Foundation"]);
  compileObjectiveC(processRegistryTestBinary, [
    resolve(appSourceRoot, "RHJournal.m"),
    resolve(appSourceRoot, "RHProcessRegistry.m"),
    resolve(nativeRoot, "tests/process_registry_tests.m"),
  ], ["Foundation"]);
  compileObjectiveC(resolve(fakeCaptureRoot, "dsh-asr-capture-mic"), [
    resolve(nativeRoot, "tests/fake_capture.m"),
  ], ["Foundation"]);
  await copyFile(
    resolve(fakeCaptureRoot, "dsh-asr-capture-mic"),
    resolve(fakeCaptureRoot, "dsh-asr-capture-system"),
  );
  await chmod(resolve(fakeCaptureRoot, "dsh-asr-capture-system"), 0o755);
  compileObjectiveC(captureTrackTestBinary, [
    resolve(appSourceRoot, "RHJournal.m"),
    resolve(appSourceRoot, "RHChunkStore.m"),
    resolve(appSourceRoot, "RHProcessRegistry.m"),
    resolve(appSourceRoot, "RHCaptureTrack.m"),
    resolve(nativeRoot, "tests/capture_track_tests.m"),
  ], ["Foundation"]);
  compileObjectiveC(sessionTestBinary, [
    resolve(appSourceRoot, "RHJournal.m"),
    resolve(appSourceRoot, "RHChunkStore.m"),
    resolve(appSourceRoot, "RHProcessRegistry.m"),
    resolve(appSourceRoot, "RHCaptureTrack.m"),
    resolve(appSourceRoot, "RHRecordingSession.m"),
    resolve(nativeRoot, "tests/session_tests.m"),
  ], ["Foundation"]);
  compileCxx(systemFormatTestBinary, [
    resolve(nativeRoot, "tests/system_format_tests.mm"),
    "config/recorder_config.cpp",
  ], ["Foundation", "CoreAudio", "AudioToolbox"], "14.2");
  run(systemFormatTestBinary, []);
  run(protocolTestBinary, []);
  run(chunkStoreTestBinary, []);
  run(processRegistryTestBinary, []);
  run(captureTrackTestBinary, [fakeCaptureRoot]);
  run(sessionTestBinary, [fakeCaptureRoot]);
  for (const binary of [micBinary, systemBinary, helperBinary]) {
    run("/usr/bin/strip", ["-S", binary]);
  }

  sign(micBinary, resolve(appSourceRoot, "capture-entitlements.plist"), identity);
  sign(systemBinary, resolve(appSourceRoot, "system-capture-entitlements.plist"), identity);
  sign(appRoot, resolve(appSourceRoot, "entitlements.plist"), identity);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", appRoot]);

  const manifest = await buildManifest(identity);
  await writeFile(resolve(buildRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  if (publicRelease) {
    await Promise.all([
      rm(protocolTestBinary), rm(chunkStoreTestBinary), rm(processRegistryTestBinary),
      rm(captureTrackTestBinary), rm(sessionTestBinary), rm(systemFormatTestBinary),
      rm(fakeCaptureRoot, { recursive: true }),
    ]);
    await rename(buildRoot, outputRoot);
  } else {
    await rm(finalApp, { recursive: true, force: true });
    await rm(finalManifest, { force: true });
    await rename(appRoot, finalApp);
    await rename(resolve(buildRoot, "manifest.json"), finalManifest);
    await chmod(finalManifest, 0o600);
    await rm(buildRoot, { recursive: true, force: true });
  }
  const manifestStat = await stat(finalManifest);
  process.stdout.write(`${JSON.stringify({
    app: relative(repositoryRoot, finalApp),
    manifest: relative(repositoryRoot, finalManifest),
    manifestBytes: manifestStat.size,
    signingMode: manifest.product.signingMode,
    treeSha256: manifest.treeSha256,
  })}\n`);
}

async function assertOutputAbsent(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("public helper output already exists");
}

try {
  await build();
} catch (error) {
  await rm(buildRoot, { recursive: true, force: true });
  throw error;
}
