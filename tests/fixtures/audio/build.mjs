import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const wavePath = join(directory, "alternating-stereo.source.wav");
const mp3Path = join(directory, "alternating-stereo.mp3");
const temporaryMp3Path = `${mp3Path}.${process.pid}.tmp`;
const expectedSha256 = "399f859d65955d838b4d94a29324f319ad78e7d0b726bf4156ca16ccbbbad708";

function createAlternatingStereoWave() {
  const sampleRate = 44_100;
  const frameCount = sampleRate * 2;
  const data = Buffer.alloc(frameCount * 4);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const frequency = frame < sampleRate ? 440 : 660;
    const sample = Math.round(Math.sin((2 * Math.PI * frequency * frame) / sampleRate) * 16_000);
    data.writeInt16LE(sample, frame * 4 + (frame < sampleRate ? 0 : 2));
  }
  const wave = Buffer.alloc(44 + data.length);
  wave.write("RIFF", 0, 4, "ascii");
  wave.writeUInt32LE(36 + data.length, 4);
  wave.write("WAVEfmt ", 8, 8, "ascii");
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 4, 28);
  wave.writeUInt16LE(4, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36, 4, "ascii");
  wave.writeUInt32LE(data.length, 40);
  data.copy(wave, 44);
  return wave;
}

await writeFile(wavePath, createAlternatingStereoWave());
try {
  const result = spawnSync(process.env.FFMPEG ?? "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", wavePath,
    "-codec:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", temporaryMp3Path,
  ], { encoding: "utf8" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr?.trim() || "ffmpeg failed");
  const sha256 = createHash("sha256").update(await readFile(temporaryMp3Path)).digest("hex");
  if (sha256 !== expectedSha256) {
    throw new Error(`ffmpeg output SHA-256 differs: ${sha256}`);
  }
  await chmod(temporaryMp3Path, 0o644);
  await rename(temporaryMp3Path, mp3Path);
} finally {
  await rm(wavePath, { force: true });
  await rm(temporaryMp3Path, { force: true });
}
