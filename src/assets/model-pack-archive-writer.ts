import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AssetVerificationError } from "./verify-assets.js";
import {
  failModelPackBuildInvalid,
  fileSystemErrorCode,
  ModelPackBuildError,
} from "./model-pack-build-error.js";

const BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = 768 * 1_024 * 1_024;

export interface OpenModelPackFile {
  readonly assetId: string;
  readonly byteLength: number;
  readonly handle: FileHandle;
  readonly relativePath: string;
  readonly sha256: string;
}

interface ArchiveState {
  readonly handle: FileHandle;
  readonly hash: ReturnType<typeof createHash>;
  position: number;
  readonly signal?: AbortSignal;
}

function writeTextField(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) failModelPackBuildInvalid("USTAR field is too long");
  bytes.copy(header, offset);
}

function writeOctalField(header: Buffer, offset: number, length: number, value: number): void {
  const octal = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || octal.length > length - 1) {
    failModelPackBuildInvalid("USTAR numeric field is out of range");
  }
  header.write(`${octal.padStart(length - 1, "0")}\0`, offset, length, "ascii");
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, "utf8") <= 100) return { name: path, prefix: "" };
  const separators = [...path.matchAll(/\//gu)].map((match) => match.index);
  for (const separator of separators.reverse()) {
    const prefix = path.slice(0, separator);
    const name = path.slice(separator + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100) {
      return { name, prefix };
    }
  }
  return failModelPackBuildInvalid("USTAR path is too long");
}

function createUstarHeader(path: string, byteLength: number): Buffer {
  const header = Buffer.alloc(BLOCK_BYTES);
  const { name, prefix } = splitUstarPath(path);
  writeTextField(header, 0, 100, name);
  writeOctalField(header, 100, 8, 0o600);
  writeOctalField(header, 108, 8, 0);
  writeOctalField(header, 116, 8, 0);
  writeOctalField(header, 124, 12, byteLength);
  writeOctalField(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeTextField(header, 257, 6, "ustar\0");
  writeTextField(header, 263, 2, "00");
  writeTextField(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

async function writeArchiveBytes(state: ArchiveState, bytes: Buffer): Promise<void> {
  let completed = 0;
  while (completed < bytes.byteLength) {
    state.signal?.throwIfAborted();
    const { bytesWritten } = await state.handle.write(
      bytes,
      completed,
      bytes.byteLength - completed,
      state.position + completed,
    );
    if (bytesWritten === 0) failModelPackBuildInvalid("Unable to write model pack archive");
    state.hash.update(bytes.subarray(completed, completed + bytesWritten));
    completed += bytesWritten;
  }
  state.position += bytes.byteLength;
}

async function writePadding(state: ArchiveState, byteLength: number): Promise<void> {
  const padding = (BLOCK_BYTES - byteLength % BLOCK_BYTES) % BLOCK_BYTES;
  if (padding > 0) await writeArchiveBytes(state, Buffer.alloc(padding));
}

async function writeBufferMember(state: ArchiveState, path: string, bytes: Buffer): Promise<void> {
  await writeArchiveBytes(state, createUstarHeader(path, bytes.byteLength));
  await writeArchiveBytes(state, bytes);
  await writePadding(state, bytes.byteLength);
}

async function writeFilePayload(state: ArchiveState, file: OpenModelPackFile): Promise<void> {
  const hash = createHash("sha256");
  let position = 0;
  while (position < file.byteLength) {
    state.signal?.throwIfAborted();
    const chunk = Buffer.allocUnsafe(Math.min(1_024 * 1_024, file.byteLength - position));
    const { bytesRead } = await file.handle.read(chunk, 0, chunk.byteLength, position);
    if (bytesRead === 0) break;
    const bytes = chunk.subarray(0, bytesRead);
    hash.update(bytes);
    await writeArchiveBytes(state, bytes);
    position += bytesRead;
  }
  const current = await file.handle.stat();
  if (position !== file.byteLength || current.size !== file.byteLength) {
    throw new AssetVerificationError(
      "ASSET_SIZE_MISMATCH",
      `Asset changed during model pack build: ${file.assetId}`,
      file.assetId,
    );
  }
  if (hash.digest("hex") !== file.sha256) {
    throw new AssetVerificationError(
      "ASSET_HASH_MISMATCH",
      `Asset changed during model pack build: ${file.assetId}`,
      file.assetId,
    );
  }
}

async function writeFileMember(state: ArchiveState, file: OpenModelPackFile): Promise<void> {
  await writeArchiveBytes(state, createUstarHeader(file.relativePath, file.byteLength));
  await writeFilePayload(state, file);
  await writePadding(state, file.byteLength);
}

function paddedBytes(byteLength: number): number {
  return Math.ceil(byteLength / BLOCK_BYTES) * BLOCK_BYTES;
}

function expectedArchiveSize(manifestBytes: Buffer, files: readonly OpenModelPackFile[]): number {
  let total = BLOCK_BYTES + paddedBytes(manifestBytes.byteLength) + BLOCK_BYTES * 2;
  for (const file of files) total += BLOCK_BYTES + paddedBytes(file.byteLength);
  if (!Number.isSafeInteger(total) || total > MAX_ARCHIVE_BYTES) {
    failModelPackBuildInvalid("Model pack archive exceeds the supported size limit");
  }
  return total;
}

async function fsyncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function assertOutputAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (fileSystemErrorCode(error) === "ENOENT") return;
    throw error;
  }
  throw new ModelPackBuildError("MODEL_PACK_OUTPUT_EXISTS", "Model pack output already exists");
}

async function publishArchive(tempPath: string, outputPath: string): Promise<void> {
  try {
    await link(tempPath, outputPath);
  } catch (error) {
    if (fileSystemErrorCode(error) === "EEXIST") {
      throw new ModelPackBuildError("MODEL_PACK_OUTPUT_EXISTS", "Model pack output already exists");
    }
    throw error;
  }
  await rm(tempPath);
  await fsyncDirectory(dirname(outputPath));
}

async function writeArchiveContents(
  state: ArchiveState,
  manifestBytes: Buffer,
  files: readonly OpenModelPackFile[],
): Promise<void> {
  await writeBufferMember(state, "model-pack.json", manifestBytes);
  for (const file of files) await writeFileMember(state, file);
  await writeArchiveBytes(state, Buffer.alloc(BLOCK_BYTES * 2));
  await state.handle.sync();
}

export async function writeModelPackArchive(
  outputPath: string,
  manifestBytes: Buffer,
  files: readonly OpenModelPackFile[],
  signal?: AbortSignal,
): Promise<{ archiveByteLength: number; archiveSha256: string }> {
  signal?.throwIfAborted();
  expectedArchiveSize(manifestBytes, files);
  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await assertOutputAbsent(outputPath);
  const tempPath = join(parent, `.model-pack-${randomUUID()}.tmp`);
  const handle = await open(
    tempPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  const state: ArchiveState = { handle, hash: createHash("sha256"), position: 0,
    ...(signal === undefined ? {} : { signal }) };
  try {
    await writeArchiveContents(state, manifestBytes, files);
  } catch (error) {
    await handle.close();
    await rm(tempPath, { force: true });
    throw error;
  }
  await handle.close();
  const result = { archiveByteLength: state.position, archiveSha256: state.hash.digest("hex") };
  try {
    signal?.throwIfAborted();
    await publishArchive(tempPath, outputPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return result;
}
