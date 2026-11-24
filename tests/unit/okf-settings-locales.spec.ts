import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { modelEn, modelZh } from "../../src/client/model-settings-locales.js";

const OKF_KEYS = ["okf", "okfFolder", "okfAutoIngest", "okfConsent", "okfSaveFailed"] as const;
const OKF_JSON_KEYS = ["title", "folder", "autoIngest", "consent", "saveFailed"] as const;
const MIRROR: ReadonlyArray<readonly [string, (typeof OKF_KEYS)[number]]> = [
  ["title", "okf"],
  ["folder", "okfFolder"],
  ["autoIngest", "okfAutoIngest"],
  ["consent", "okfConsent"],
  ["saveFailed", "okfSaveFailed"],
];

async function readLocale(name: "en" | "zh"): Promise<Record<string, unknown>> {
  const body = await readFile(new URL(`../../locale/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(body) as Record<string, unknown>;
}

function section(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error("missing locale section");
  return value as Record<string, unknown>;
}

describe("Open knowledge base settings locales", () => {
  it("defines every OKF string in both client locales", () => {
    expect(Object.keys(modelEn).sort()).toEqual(Object.keys(modelZh).sort());
    for (const key of OKF_KEYS) {
      expect(modelZh[key].trim()).not.toBe("");
      expect(modelEn[key].trim()).not.toBe("");
    }
  });

  it("names both consequences in the consent sentence", () => {
    expect(modelEn.okfConsent).toContain("Git");
    expect(modelEn.okfConsent).toMatch(/commit/iu);
    expect(modelZh.okfConsent).toContain("Git");
    expect(modelZh.okfConsent).toContain("提交");
  });

  it("keeps locale JSON files structurally identical", async () => {
    const en = await readLocale("en");
    const zh = await readLocale("zh");
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
    expect(Object.keys(section(en.meta)).sort()).toEqual(Object.keys(section(zh.meta)).sort());
    const expected = [...OKF_JSON_KEYS].sort();
    expect(Object.keys(section(en.okf)).sort()).toEqual(expected);
    expect(Object.keys(section(zh.okf)).sort()).toEqual(expected);
  });

  it("mirrors the TypeScript strings in both JSON files", async () => {
    const en = section((await readLocale("en")).okf);
    const zh = section((await readLocale("zh")).okf);
    for (const [jsonKey, tsKey] of MIRROR) {
      expect(en[jsonKey]).toBe(modelEn[tsKey]);
      expect(zh[jsonKey]).toBe(modelZh[tsKey]);
    }
  });

  it("uses an English label for the section and the toggle", () => {
    expect(modelEn.okf).toBe("Open knowledge base");
    expect(modelEn.okfAutoIngest).toContain("transcripts");
  });
});
