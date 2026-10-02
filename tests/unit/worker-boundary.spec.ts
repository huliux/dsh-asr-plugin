import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve("src");
const importPattern = /(?:from\s+|import\s*\()(["'])([^"']+)\1/g;

function relativeImports(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  return [...source.matchAll(importPattern)]
    .map((match) => match[2]!)
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => resolve(dirname(filePath), specifier.replace(/\.js$/, ".ts")));
}

function sourceClosure(entries: readonly string[]): string[] {
  const pending = entries.map((entry) => resolve(sourceRoot, entry));
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...relativeImports(current));
  }
  return [...visited];
}

describe("Worker dependency boundaries", () => {
  it("keeps both entry closures free of DSH, Electron, SQLite, spawn and network APIs", () => {
    const closure = sourceClosure([
      "worker/asr-entry.ts",
      "worker/diarization-entry.ts",
    ]);
    const sources = closure.map((path) => readFileSync(path, "utf8")).join("\n");

    expect(sources).not.toMatch(/@deepseek-ai|electron|node:sqlite/);
    expect(sources).not.toMatch(/node:(?:child_process|net|http|https|dgram)/);
    expect(closure).not.toContain(resolve(sourceRoot, "assets/stage-assets.ts"));
    expect(closure).not.toContain(resolve(sourceRoot, "assets/supply-chain.ts"));
  });

  it("keeps the Host client closure free of ONNX and native engine modules", () => {
    const closure = sourceClosure([
      "worker/worker-client.ts",
      "worker/dsh-spawner.ts",
      "worker/launch.ts",
    ]);
    const relativePaths = closure.map((path) => path.slice(sourceRoot.length + 1));
    const sources = closure.map((path) => readFileSync(path, "utf8")).join("\n");

    expect(sources).not.toContain("onnxruntime-node");
    expect(relativePaths.some((path) => path.startsWith("asr/"))).toBe(false);
    expect(relativePaths.some((path) => path.startsWith("diarization/"))).toBe(false);
    expect(relativePaths.some((path) => path.startsWith("native/"))).toBe(false);
  });
});
