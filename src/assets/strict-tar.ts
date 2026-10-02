import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";
import { createHash } from "node:crypto";

import { RuntimeAssetsError } from "./runtime-assets-error.js";

const BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = 768 * 1_024 * 1_024;
const MAX_MANIFEST_BYTES = 1 * 1_024 * 1_024;

export interface ExpectedTarFile {
  readonly byteLength: number;
  readonly install: boolean;
  readonly relativePath: string;
  readonly sha256: string;
}

interface TarHeader {
  readonly path: string;
  readonly size: number;
}

interface ExtractionOptions {
  readonly destinationRoot?: string;
  readonly onManifest: (bytes: Buffer) => readonly ExpectedTarFile[];
  readonly signal?: AbortSignal;
}

interface ExtractionResult {
  readonly expected: ReadonlyMap<string, ExpectedTarFile>;
  readonly sawTerminator: boolean;
  readonly seen: ReadonlySet<string>;
}

async function readExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let completed = 0;
  while (completed < buffer.byteLength) {
    const { bytesRead } = await handle.read(
      buffer,
      completed,
      buffer.byteLength - completed,
      position + completed,
    );
    if (bytesRead === 0) {
      throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack is truncated");
    }
    completed += bytesRead;
  }
}

async function writeExactly(
  handle: FileHandle,
  buffer: Buffer,
  position: number,
): Promise<void> {
  let completed = 0;
  while (completed < buffer.byteLength) {
    const { bytesWritten } = await handle.write(
      buffer,
      completed,
      buffer.byteLength - completed,
      position + completed,
    );
    if (bytesWritten === 0) {
      throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack member could not be staged");
    }
    completed += bytesWritten;
  }
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function headerString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  const bytes = end === -1 ? field : field.subarray(0, end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack header is invalid");
  }
}

function octalField(header: Buffer, start: number, length: number): number {
  const value = headerString(header, start, length).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack header is invalid");
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack header is invalid");
  }
  return parsed;
}

function safeArchivePath(path: string): boolean {
  if (path.length === 0 || path.length > 4_096 || path.includes("\\") ||
    posix.isAbsolute(path) || posix.normalize(path) !== path) return false;
  return path.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseHeader(header: Buffer): TarHeader {
  const checksum = octalField(header, 148, 8);
  const checksumBytes = Buffer.from(header);
  checksumBytes.fill(0x20, 148, 156);
  const actualChecksum = checksumBytes.reduce((sum, byte) => sum + byte, 0);
  const type = header[156];
  const hasUstarMagic = header.subarray(257, 263).equals(Buffer.from("ustar\0", "ascii")) &&
    header.subarray(263, 265).equals(Buffer.from("00", "ascii"));
  const name = headerString(header, 0, 100);
  const prefix = headerString(header, 345, 155);
  const path = prefix.length === 0 ? name : `${prefix}/${name}`;
  if (checksum !== actualChecksum || !hasUstarMagic || (type !== 0 && type !== 0x30) ||
    !safeArchivePath(path)) {
    throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack member is invalid");
  }
  return { path, size: octalField(header, 124, 12) };
}

function paddedSize(size: number): number {
  return Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
}

function abortIfRequested(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new RuntimeAssetsError("STAGE_ABORTED", "Model pack staging was cancelled");
  }
}

async function readPayload(
  handle: FileHandle,
  position: number,
  size: number,
): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  await readExactly(handle, bytes, position);
  return bytes;
}

async function extractPayload(options: {
  archive: FileHandle;
  destinationRoot?: string;
  expected: ExpectedTarFile;
  position: number;
  signal?: AbortSignal;
}): Promise<void> {
  let output: FileHandle | undefined;
  if (options.destinationRoot !== undefined && options.expected.install) {
    const destination = resolve(options.destinationRoot, options.expected.relativePath);
    const relative = posix.normalize(options.expected.relativePath);
    if (!destination.startsWith(`${resolve(options.destinationRoot)}/`) ||
      relative !== options.expected.relativePath) {
      throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack path escapes staging root");
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    output = await open(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  }
  const hash = createHash("sha256");
  let completed = 0;
  try {
    while (completed < options.expected.byteLength) {
      abortIfRequested(options.signal);
      const length = Math.min(1_024 * 1_024, options.expected.byteLength - completed);
      const chunk = Buffer.allocUnsafe(length);
      await readExactly(options.archive, chunk, options.position + completed);
      if (output !== undefined) await writeExactly(output, chunk, completed);
      hash.update(chunk);
      completed += chunk.byteLength;
    }
    if (hash.digest("hex") !== options.expected.sha256) {
      throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack member hash is invalid");
    }
    if (output !== undefined) await output.sync();
  } finally {
    if (output !== undefined) await output.close();
  }
}

async function assertTrailingZeros(
  handle: FileHandle,
  start: number,
  size: number,
): Promise<void> {
  let position = start;
  while (position < size) {
    const chunk = Buffer.alloc(Math.min(64 * 1_024, size - position));
    await readExactly(handle, chunk, position);
    if (!isZeroBlock(chunk)) {
      throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack has trailing data");
    }
    position += chunk.byteLength;
  }
}

async function openValidatedArchive(archivePath: string): Promise<{
  archive: FileHandle;
  size: number;
}> {
  const archive = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const archiveStat = await archive.stat();
  if (!archiveStat.isFile() || archiveStat.size < BLOCK_BYTES * 3 ||
    archiveStat.size > MAX_ARCHIVE_BYTES) {
    await archive.close();
    throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack file is invalid");
  }
  return { archive, size: archiveStat.size };
}

async function readHeaderBlock(archive: FileHandle, position: number): Promise<Buffer> {
  const header = Buffer.alloc(BLOCK_BYTES);
  await readExactly(archive, header, position);
  return header;
}

async function assertTerminator(
  archive: FileHandle,
  position: number,
  archiveSize: number,
): Promise<void> {
  const second = await readHeaderBlock(archive, position);
  if (!isZeroBlock(second)) {
    throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack terminator is invalid");
  }
  await assertTrailingZeros(archive, position + BLOCK_BYTES, archiveSize);
}

function extractionPayloadOptions(
  options: ExtractionOptions,
  archive: FileHandle,
  expected: ExpectedTarFile,
  position: number,
): Parameters<typeof extractPayload>[0] {
  return {
    archive,
    expected,
    position,
    ...(options.destinationRoot === undefined ? {} : { destinationRoot: options.destinationRoot }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

async function extractManifest(
  options: ExtractionOptions,
  archive: FileHandle,
  header: TarHeader,
  position: number,
): Promise<Map<string, ExpectedTarFile>> {
  if (header.path !== "model-pack.json" || header.size > MAX_MANIFEST_BYTES) {
    throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack manifest must be first");
  }
  const manifestBytes = await readPayload(archive, position, header.size);
  const expected = new Map(
    options.onManifest(manifestBytes).map((file) => [file.relativePath, file]),
  );
  await extractPayload(extractionPayloadOptions(options, archive, {
    relativePath: "model-pack.json",
    byteLength: header.size,
    install: false,
    sha256: createHash("sha256").update(manifestBytes).digest("hex"),
  }, position));
  return expected;
}

async function extractExpectedMember(
  options: ExtractionOptions,
  archive: FileHandle,
  header: TarHeader,
  position: number,
  expected: ReadonlyMap<string, ExpectedTarFile>,
  seen: ReadonlySet<string>,
): Promise<void> {
  const file = expected.get(header.path);
  if (file === undefined || header.size !== file.byteLength || seen.has(header.path)) {
    throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack member is unexpected");
  }
  await extractPayload(extractionPayloadOptions(options, archive, file, position));
}

async function extractArchive(
  options: ExtractionOptions,
  archive: FileHandle,
  archiveSize: number,
): Promise<ExtractionResult> {
  const seen = new Set<string>();
  let expected = new Map<string, ExpectedTarFile>();
  let position = 0;
  while (position < archiveSize) {
    abortIfRequested(options.signal);
    const headerBytes = await readHeaderBlock(archive, position);
    position += BLOCK_BYTES;
    if (isZeroBlock(headerBytes)) {
      await assertTerminator(archive, position, archiveSize);
      return { expected, sawTerminator: true, seen };
    }
    const header = parseHeader(headerBytes);
    if (seen.size === 0) expected = await extractManifest(options, archive, header, position);
    else await extractExpectedMember(options, archive, header, position, expected, seen);
    seen.add(header.path);
    position += paddedSize(header.size);
  }
  return { expected, sawTerminator: false, seen };
}

function assertComplete(result: ExtractionResult): void {
  const missing = [...result.expected.keys()].find((path) => !result.seen.has(path));
  if (!result.sawTerminator || !result.seen.has("model-pack.json") || missing !== undefined) {
    throw new RuntimeAssetsError("MODEL_PACK_INVALID", "Model pack is incomplete");
  }
}

export async function extractStrictTar(options: {
  archivePath: string;
  destinationRoot?: string;
  onManifest: (bytes: Buffer) => readonly ExpectedTarFile[];
  signal?: AbortSignal;
}): Promise<void> {
  abortIfRequested(options.signal);
  const { archive, size } = await openValidatedArchive(options.archivePath);
  let result: ExtractionResult;
  try {
    result = await extractArchive(options, archive, size);
  } finally {
    await archive.close();
  }
  assertComplete(result);
}
