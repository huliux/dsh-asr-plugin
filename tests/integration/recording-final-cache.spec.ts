import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  openRecordingFinalCache,
  recordingCacheKey,
} from "../../src/recording/final-cache.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

it("binds ASR and embedding entries to engine, time range and audio content", async () => {
  const root = await mkdtemp(join(tmpdir(), "recording-final-cache-"));
  roots.push(root);
  const fingerprint = "a".repeat(64);
  const samples = new Float32Array([0, 0.25, -0.5]);
  const asrKey = recordingCacheKey("asr", fingerprint, 100, 200, samples);
  const embeddingKey = recordingCacheKey("embedding", fingerprint, 100, 200, samples);
  const cache = await openRecordingFinalCache(root, fingerprint);
  const blocks = [{ seq: 0, startMs: 100, endMs: 200, text: "缓存文本。" }];
  const embedding = new Float32Array(256).fill(0.125);

  await cache.putAsr(asrKey, blocks);
  await cache.putEmbedding(embeddingKey, embedding);

  await expect(cache.getAsr(asrKey)).resolves.toEqual(blocks);
  expect(await cache.getEmbedding(embeddingKey)).toEqual(embedding);
  const changed = recordingCacheKey("asr", fingerprint, 100, 200, new Float32Array([0, 0.5]));
  await expect(cache.getAsr(changed)).resolves.toBeNull();
  const otherEngine = await openRecordingFinalCache(root, "b".repeat(64));
  await expect(otherEngine.getAsr(asrKey)).resolves.toBeNull();
});

it("treats a corrupt entry as a cache miss", async () => {
  const root = await mkdtemp(join(tmpdir(), "recording-final-cache-"));
  roots.push(root);
  const fingerprint = "c".repeat(64);
  const key = recordingCacheKey("asr", fingerprint, 0, 100, new Float32Array([0]));
  const cache = await openRecordingFinalCache(root, fingerprint);
  await writeFile(join(root, fingerprint, "asr", `${key}.json`), "not-json");

  await expect(cache.getAsr(key)).resolves.toBeNull();
});

it("detects a syntactically valid cache payload whose integrity seal changed", async () => {
  const root = await mkdtemp(join(tmpdir(), "recording-final-cache-"));
  roots.push(root);
  const fingerprint = "d".repeat(64);
  const key = recordingCacheKey("asr", fingerprint, 0, 100, new Float32Array([0]));
  const cache = await openRecordingFinalCache(root, fingerprint);
  await cache.putAsr(key, [{ seq: 0, startMs: 0, endMs: 100, text: "原文" }]);
  await writeFile(
    join(root, fingerprint, "asr", `${key}.json`),
    JSON.stringify([{ seq: 0, startMs: 0, endMs: 100, text: "被改写" }]),
  );

  await expect(cache.getAsr(key)).resolves.toBeNull();
});
