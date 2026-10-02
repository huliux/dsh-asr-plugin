import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WAV_SOURCE = resolve(REPOSITORY_ROOT, "data/p0-wav/four-zh.wav");
const MP3_SOURCE = resolve(REPOSITORY_ROOT, "data/private-audio/4人中文.mp3");
const BUSY_SOURCE = resolve(REPOSITORY_ROOT, "data/private-audio/ex01.m4a");
const INPUT_DIRECTORY = resolve(REPOSITORY_ROOT, "data/p1a-input");
const M4A_TARGET = resolve(INPUT_DIRECTORY, "four-zh.m4a");
const M4A_NEXT = resolve(INPUT_DIRECTORY, "four-zh.m4a.next");
const DOGFOOD_DIRECTORY = resolve(REPOSITORY_ROOT, "data/dogfood");
const DOGFOOD_CHECKLIST = resolve(DOGFOOD_DIRECTORY, "p1a-week.md");

const CHECKLIST = `# P1a 一周 / 五场 dogfood

只记录会议标签或哈希，不粘贴转写正文。每场至少完成一次读取、提问或总结。

| 日期 | 会议标签/哈希 | 导入 | 读取/提问/总结 | 成功 | 故障等级 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
|  | 1 |  |  |  | 无/一般/严重/阻断 |  |
|  | 2 |  |  |  | 无/一般/严重/阻断 |  |
|  | 3 |  |  |  | 无/一般/严重/阻断 |  |
|  | 4 |  |  |  | 无/一般/严重/阻断 |  |
|  | 5 |  |  |  | 无/一般/严重/阻断 |  |
`;

async function requirePrivateFixtures() {
  for (const path of [WAV_SOURCE, MP3_SOURCE, BUSY_SOURCE]) {
    try {
      await access(path);
    } catch {
      throw new Error(`缺少私有 P1a 测试样本：${path}`);
    }
  }
}

async function prepareM4aFixture() {
  await rm(M4A_NEXT, { force: true });
  const result = spawnSync(
    "/usr/bin/afconvert",
    [WAV_SOURCE, "-f", "m4af", "-d", "aac ", M4A_NEXT],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    await rm(M4A_NEXT, { force: true });
    throw new Error(`afconvert 生成 M4A 失败：${result.stderr.trim()}`);
  }
  await chmod(M4A_NEXT, 0o600);
  await rename(M4A_NEXT, M4A_TARGET);
}

async function prepareDogfoodChecklist() {
  try {
    await access(DOGFOOD_CHECKLIST);
    return;
  } catch {
    await writeFile(DOGFOOD_CHECKLIST, CHECKLIST, { mode: 0o600 });
  }
}

async function main() {
  await requirePrivateFixtures();
  for (const directory of [INPUT_DIRECTORY, DOGFOOD_DIRECTORY]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  await prepareM4aFixture();
  await prepareDogfoodChecklist();
  process.stdout.write("P1a 私有样本与 dogfood 清单已就绪。\n");
}

await main();
