import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";

import { TranscriptProjectionError } from "./transcript-export-error.js";
import type { TranscriptExportFormat } from "./transcript-projection.js";

export interface PublishTranscriptExportInput {
  readonly content: Buffer;
  readonly dataRoot: string;
  readonly format: TranscriptExportFormat;
  readonly outputPath: string;
  readonly overwrite: boolean;
  readonly signal?: AbortSignal;
}

export interface PublishedTranscriptExport {
  readonly bytes: number;
  readonly outputPath: string;
  readonly sha256: string;
}

function errno(error: unknown, codes: readonly string[]): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" && codes.includes(error.code);
}

function cancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new TranscriptProjectionError("CANCELLED_BY_USER", "Transcript export was cancelled");
  }
}

export function validateTranscriptExportPathSyntax(
  outputPath: unknown,
  format: TranscriptExportFormat,
): asserts outputPath is string {
  if (typeof outputPath !== "string") {
    throw new TranscriptProjectionError("EXPORT_PATH_INVALID", "Export path is invalid");
  }
  const name = basename(outputPath);
  if (!isAbsolute(outputPath) || outputPath.includes("\0") || outputPath.endsWith(sep)
    || Array.from(outputPath).length > 4_096 || name === "" || name === "." || name === ".."
    || extname(name).toLowerCase() !== `.${format}`) {
    throw new TranscriptProjectionError("EXPORT_PATH_INVALID", "Export path is invalid");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

async function canonicalOutputPath(input: PublishTranscriptExportInput): Promise<string> {
  validateTranscriptExportPathSyntax(input.outputPath, input.format);
  const [dataRoot, parent] = await Promise.all([
    realpath(input.dataRoot),
    realpath(dirname(input.outputPath)),
  ]);
  if (!(await stat(parent)).isDirectory()) {
    throw new TranscriptProjectionError("EXPORT_PATH_INVALID", "Export parent is not a directory");
  }
  const outputPath = join(parent, basename(input.outputPath));
  if (isWithin(dataRoot, outputPath)) {
    throw new TranscriptProjectionError(
      "EXPORT_PATH_INVALID",
      "Export path must be outside managed data",
    );
  }
  return outputPath;
}

async function targetExists(outputPath: string): Promise<boolean> {
  try {
    const value = await lstat(outputPath);
    if (!value.isFile() || value.isSymbolicLink()) {
      throw new TranscriptProjectionError("EXPORT_PATH_INVALID", "Export target is not a regular file");
    }
    return true;
  } catch (error) {
    if (errno(error, ["ENOENT"])) return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function openTemporaryFile(directory: string): Promise<{
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly path: string;
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const path = join(directory, `.dsh-asr-export-${randomUUID()}.tmp`);
    try {
      return { handle: await open(path, "wx", 0o600), path };
    } catch (error) {
      if (!errno(error, ["EEXIST"])) throw error;
    }
  }
  throw new TranscriptProjectionError(
    "EXPORT_WRITE_FAILED",
    "Could not reserve a temporary export file",
  );
}

function mapPublishError(error: unknown): TranscriptProjectionError {
  if (error instanceof TranscriptProjectionError) return error;
  if (errno(error, ["EACCES", "EPERM", "EROFS"])) {
    return new TranscriptProjectionError(
      "EXPORT_PERMISSION_DENIED",
      "Export destination is not writable",
      { cause: error },
    );
  }
  if (errno(error, ["EEXIST"])) {
    return new TranscriptProjectionError("EXPORT_TARGET_EXISTS", "Export target already exists");
  }
  if (errno(error, ["ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "ENAMETOOLONG"])) {
    return new TranscriptProjectionError("EXPORT_PATH_INVALID", "Export path changed", {
      cause: error,
    });
  }
  return new TranscriptProjectionError("EXPORT_WRITE_FAILED", "Transcript export failed", {
    cause: error,
  });
}

export async function publishTranscriptExport(
  input: PublishTranscriptExportInput,
): Promise<PublishedTranscriptExport> {
  let temporaryPath: string | undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    cancelled(input.signal);
    const outputPath = await canonicalOutputPath(input);
    const exists = await targetExists(outputPath);
    if (exists && !input.overwrite) {
      throw new TranscriptProjectionError("EXPORT_TARGET_EXISTS", "Export target already exists");
    }
    cancelled(input.signal);
    const temporary = await openTemporaryFile(dirname(outputPath));
    temporaryPath = temporary.path;
    handle = temporary.handle;
    cancelled(input.signal);
    await handle.writeFile(input.content);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    cancelled(input.signal);
    if (input.overwrite) await rename(temporaryPath, outputPath);
    else {
      await link(temporaryPath, outputPath);
      await unlink(temporaryPath);
    }
    await syncDirectory(dirname(outputPath));
    return {
      outputPath: input.outputPath,
      bytes: input.content.byteLength,
      sha256: createHash("sha256").update(input.content).digest("hex"),
    };
  } catch (error) {
    throw mapPublishError(error);
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporaryPath !== undefined) await unlink(temporaryPath).catch(() => undefined);
  }
}
