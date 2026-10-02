import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { FunAsrBlock } from "../asr/funasr/pipeline.js";

const KEY = /^[0-9a-f]{64}$/;
const MAX_BLOCKS = 20_000;
const MAX_ASR_BYTES = 24 * 1024 * 1024;
const EMBEDDING_VALUES = 256;
const EMBEDDING_BYTES = EMBEDDING_VALUES * Float32Array.BYTES_PER_ELEMENT;
const HASH_BYTES = 32;

export type RecordingCacheKind = "asr" | "embedding";

export interface RecordingFinalCache {
  getAsr(key: string): Promise<readonly FunAsrBlock[] | null>;
  getEmbedding(key: string): Promise<Float32Array | null>;
  putAsr(key: string, blocks: readonly FunAsrBlock[]): Promise<void>;
  putEmbedding(key: string, embedding: Float32Array): Promise<void>;
}

function assertKey(key: string): void {
  if (!KEY.test(key)) throw new TypeError("Recording cache key must be SHA-256");
}

export function recordingCacheKey(
  kind: RecordingCacheKind,
  engineFingerprint: string,
  startMs: number,
  endMs: number,
  samples: Float32Array,
): string {
  if (
    !KEY.test(engineFingerprint) || !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs ||
    !(samples instanceof Float32Array) || samples.length < 1 || !samples.every(Number.isFinite)
  ) throw new TypeError("Recording cache identity is invalid");
  const content = createHash("sha256")
    .update(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength))
    .digest("hex");
  return createHash("sha256")
    .update(`${kind}\0${engineFingerprint}\0${startMs}\0${endMs}\0${content}`)
    .digest("hex");
}

function validBlocks(value: unknown): value is readonly FunAsrBlock[] {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) return false;
  let previousEnd = 0;
  return value.every((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const block = item as Record<string, unknown>;
    return Object.keys(block).length === 4 &&
      block.seq === index && Number.isSafeInteger(block.startMs) &&
      Number.isSafeInteger(block.endMs) && (block.startMs as number) >= previousEnd &&
      (block.endMs as number) > (block.startMs as number) &&
      typeof block.text === "string" && block.text.length > 0 &&
      block.text.length <= 20_000 && block.text.trim().length > 0 &&
      ((previousEnd = block.endMs as number), true);
  });
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sealedAsr(blocks: readonly FunAsrBlock[]): string {
  const payload = JSON.stringify(blocks);
  return `${JSON.stringify({ payload: blocks, sha256: sha256(payload) })}\n`;
}

function parseSealedAsr(bytes: Buffer): readonly FunAsrBlock[] | null {
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 || !validBlocks(record.payload) ||
    typeof record.sha256 !== "string" ||
    record.sha256 !== sha256(JSON.stringify(record.payload))
  ) return null;
  return record.payload;
}

async function regularBytes(path: string, maximum: number): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > maximum) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

async function atomicWrite(path: string, bytes: string | Buffer): Promise<void> {
  const temporary = `${path}.tmp`;
  await rm(temporary, { force: true });
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function embeddingBytes(embedding: Float32Array): Buffer {
  if (embedding.length !== EMBEDDING_VALUES || !embedding.every(Number.isFinite)) {
    throw new TypeError("Recording cache embedding is invalid");
  }
  const payload = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  return Buffer.concat([createHash("sha256").update(payload).digest(), payload]);
}

class FileRecordingFinalCache implements RecordingFinalCache {
  constructor(
    private readonly asrRoot: string,
    private readonly embeddingRoot: string,
  ) {}

  async getAsr(key: string): Promise<readonly FunAsrBlock[] | null> {
    assertKey(key);
    const bytes = await regularBytes(join(this.asrRoot, `${key}.json`), MAX_ASR_BYTES);
    if (bytes === null) return null;
    try {
      return parseSealedAsr(bytes);
    } catch {
      return null;
    }
  }

  async getEmbedding(key: string): Promise<Float32Array | null> {
    assertKey(key);
    const bytes = await regularBytes(
      join(this.embeddingRoot, `${key}.bin`),
      HASH_BYTES + EMBEDDING_BYTES,
    );
    if (bytes === null || bytes.byteLength !== HASH_BYTES + EMBEDDING_BYTES) return null;
    const payload = bytes.subarray(HASH_BYTES);
    if (!createHash("sha256").update(payload).digest().equals(bytes.subarray(0, HASH_BYTES))) {
      return null;
    }
    const copy = new Float32Array(EMBEDDING_VALUES);
    Buffer.from(copy.buffer).set(payload);
    return copy.every(Number.isFinite) ? copy : null;
  }

  async putAsr(key: string, blocks: readonly FunAsrBlock[]): Promise<void> {
    assertKey(key);
    if (!validBlocks(blocks)) throw new TypeError("Recording cache ASR blocks are invalid");
    const bytes = sealedAsr(blocks);
    if (Buffer.byteLength(bytes) > MAX_ASR_BYTES) {
      throw new TypeError("Recording cache ASR entry is too large");
    }
    await atomicWrite(join(this.asrRoot, `${key}.json`), bytes);
  }

  async putEmbedding(key: string, embedding: Float32Array): Promise<void> {
    assertKey(key);
    await atomicWrite(join(this.embeddingRoot, `${key}.bin`), embeddingBytes(embedding));
  }
}

export async function openRecordingFinalCache(
  root: string,
  engineFingerprint: string,
): Promise<RecordingFinalCache> {
  if (!KEY.test(engineFingerprint)) throw new TypeError("Recording cache fingerprint is invalid");
  const profile = join(root, engineFingerprint);
  const asrRoot = join(profile, "asr");
  const embeddingRoot = join(profile, "embedding");
  for (const directory of [root, profile, asrRoot, embeddingRoot]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  return new FileRecordingFinalCache(asrRoot, embeddingRoot);
}
