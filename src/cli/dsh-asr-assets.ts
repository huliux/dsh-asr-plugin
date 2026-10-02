#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expandHomePath, resolveDshHome } from "@deepseek-ai/dsh-home-paths";

import { RuntimeAssetsError } from "../assets/runtime-assets-error.js";
import {
  doctorRuntimeAssets,
  stageModelPack,
} from "../assets/runtime-assets.js";
import { AssetVerificationError } from "../assets/verify-assets.js";

const USAGE_ERROR = "dsh-asr-assets: expected `stage <model-pack>` or `doctor`\n";
const PLUGIN_DATA_DIRECTORY = "dsh-asr-plugin";
const MAX_PATH_LENGTH = 4_096;

export interface AssetsCliOptions {
  readonly env?: Record<string, string | undefined>;
  readonly packageRoot?: string;
  readonly signal?: AbortSignal;
}

export interface AssetsCliOutcome {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface ParsedCommand {
  readonly command: "doctor" | "stage";
  readonly dataDirectory?: string;
  readonly modelPackPath?: string;
}

class UsageError extends Error {
  constructor() {
    super("Invalid dsh-asr-assets arguments");
    this.name = "UsageError";
  }
}

function defaultPackageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../..");
}

function validPathArgument(value: string): boolean {
  return value.trim().length > 0 && value.length <= MAX_PATH_LENGTH && !value.includes("\0");
}

function parseArguments(argv: readonly string[]): ParsedCommand {
  const command = argv[0];
  if (command !== "doctor" && command !== "stage") throw new UsageError();
  let dataDirectory: string | undefined;
  const positional: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--data-dir") {
      const value = argv[index + 1];
      if (dataDirectory !== undefined || value === undefined || !validPathArgument(value)) {
        throw new UsageError();
      }
      dataDirectory = value;
      index += 1;
    } else if (argument === undefined || argument.startsWith("--")) {
      throw new UsageError();
    } else {
      positional.push(argument);
    }
  }
  if ((command === "doctor" && positional.length !== 0) ||
    (command === "stage" &&
      (positional.length !== 1 || !validPathArgument(positional[0] ?? "")))) {
    throw new UsageError();
  }
  return {
    command,
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
    ...(command === "stage" ? { modelPackPath: positional[0] } : {}),
  };
}

function resolveDataRoot(
  configured: string | undefined,
  env: Record<string, string | undefined> | undefined,
): string {
  if (configured !== undefined) return resolve(expandHomePath(configured));
  return join(resolveDshHome(undefined, env), PLUGIN_DATA_DIRECTORY);
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function errorOutcome(error: unknown): AssetsCliOutcome {
  if (error instanceof UsageError) return { exitCode: 2, stderr: USAGE_ERROR, stdout: "" };
  if (error instanceof RuntimeAssetsError || error instanceof AssetVerificationError) {
    return {
      exitCode: 1,
      stderr: jsonLine({
        code: error.code,
        ...(error.assetId === undefined ? {} : { assetId: error.assetId }),
      }),
      stdout: "",
    };
  }
  return {
    exitCode: 1,
    stderr: jsonLine({ code: "ASSET_COMMAND_FAILED" }),
    stdout: "",
  };
}

export async function runAssetsCli(
  argv: readonly string[],
  options: AssetsCliOptions = {},
): Promise<AssetsCliOutcome> {
  try {
    const command = parseArguments(argv);
    const packageRoot = resolve(options.packageRoot ?? defaultPackageRoot());
    const dataRoot = resolveDataRoot(command.dataDirectory, options.env);
    if (command.command === "stage") {
      const result = await stageModelPack({
        dataRoot,
        packageRoot,
        modelPackPath: resolve(expandHomePath(command.modelPackPath ?? "")),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      return { exitCode: 0, stderr: "", stdout: jsonLine(result) };
    }
    const report = await doctorRuntimeAssets({ dataRoot, packageRoot });
    return { exitCode: report.ready ? 0 : 1, stderr: "", stdout: jsonLine(report) };
  } catch (error) {
    return errorOutcome(error);
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const cancellation = new AbortController();
  const abort = (): void => cancellation.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const outcome = await runAssetsCli(process.argv.slice(2), { signal: cancellation.signal });
    if (outcome.stdout.length > 0) process.stdout.write(outcome.stdout);
    if (outcome.stderr.length > 0) process.stderr.write(outcome.stderr);
    process.exitCode = outcome.exitCode;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

if (isDirectExecution()) await main();
