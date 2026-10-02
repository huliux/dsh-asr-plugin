import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { stageModelPack } from "../../src/assets/runtime-assets.js";
import {
  cleanupRuntimeAssetsFixtures,
  createModelPackFixture,
  secondTarHeader,
  tarMemberSpan,
  tarTerminatorOffset,
  updateTarChecksum,
  writeModelPackArchive,
} from "../helpers/runtime-assets-fixture.js";
import type { FixtureAsset } from "../helpers/runtime-assets-fixture.js";

afterEach(cleanupRuntimeAssetsFixtures);

describe("RuntimeAssets 归档格式", () => {
  it("拒绝缺少 USTAR 标识的伪造归档", async () => {
    const fixture = await createModelPackFixture();
    const archive = await readFile(fixture.modelPackPath);
    archive.fill(0, 257, 265);
    updateTarChecksum(archive.subarray(0, 512));
    await writeFile(fixture.modelPackPath, archive);

    await expect(stageModelPack(fixture)).rejects.toMatchObject({ code: "MODEL_PACK_INVALID" });
  });

  it("拒绝用 symlink 替代模型归档入口", async () => {
    const fixture = await createModelPackFixture();
    const linkedPack = join(fixture.archiveRoot, "linked-model-pack.tar");
    await symlink(fixture.modelPackPath, linkedPack);

    await expect(stageModelPack({ ...fixture, modelPackPath: linkedPack })).rejects.toMatchObject({
      code: "MODEL_PACK_INVALID",
    });
  });

  it.each([
    ["absolute path", (header: Buffer) => {
      header.fill(0, 0, 100);
      header.write("/escape.onnx", 0, "ascii");
    }],
    ["path traversal", (header: Buffer) => {
      header.fill(0, 0, 100);
      header.write("../escape.onnx", 0, "ascii");
    }],
    ["symlink", (header: Buffer) => {
      header[156] = 0x32;
    }],
    ["hardlink", (header: Buffer) => {
      header[156] = 0x31;
    }],
  ])("拒绝归档中的 %s 成员", async (_label, mutate) => {
    const fixture = await createModelPackFixture();
    const archive = await readFile(fixture.modelPackPath);
    const header = secondTarHeader(archive);
    mutate(header);
    updateTarChecksum(header);
    await writeFile(fixture.modelPackPath, archive);

    await expect(stageModelPack(fixture)).rejects.toMatchObject({ code: "MODEL_PACK_INVALID" });
  });
});

describe("RuntimeAssets 归档成员", () => {
  it("拒绝未知和重复归档成员", async () => {
    const unknown = await createModelPackFixture();
    const unknownArchive = await readFile(unknown.modelPackPath);
    const unknownHeader = secondTarHeader(unknownArchive);
    unknownHeader.fill(0, 0, 100);
    unknownHeader.write("models/unknown.onnx", 0, "ascii");
    updateTarChecksum(unknownHeader);
    await writeFile(unknown.modelPackPath, unknownArchive);
    await expect(stageModelPack(unknown)).rejects.toMatchObject({ code: "MODEL_PACK_INVALID" });

    const duplicate = await createModelPackFixture();
    const duplicateArchive = await readFile(duplicate.modelPackPath);
    const header = secondTarHeader(duplicateArchive);
    const headerOffset = header.byteOffset - duplicateArchive.byteOffset;
    const member = duplicateArchive.subarray(headerOffset, headerOffset + tarMemberSpan(header));
    const terminator = tarTerminatorOffset(duplicateArchive);
    await writeFile(duplicate.modelPackPath, Buffer.concat([
      duplicateArchive.subarray(0, terminator),
      member,
      duplicateArchive.subarray(terminator),
    ]));
    await expect(stageModelPack(duplicate)).rejects.toMatchObject({ code: "MODEL_PACK_INVALID" });
  });
});

describe("RuntimeAssets 许可材料", () => {
  it("拒绝归档用自签 hash 替换代码包内的许可证材料", async () => {
    const fixture = await createModelPackFixture();
    const manifestPath = join(fixture.archiveRoot, "model-pack.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      assets: FixtureAsset[];
      materials: Array<{ byteLength: number; relativePath: string; sha256: string }>;
    };
    manifest.materials[0] = {
      relativePath: "LICENSE",
      byteLength: 7,
      sha256: "0ab55839dc48167751feca67b9256a6a088bc4d6787e91697c4f6aaae5753d7b",
    };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(fixture.archiveRoot, "LICENSE"), "forged\n");
    await writeModelPackArchive(
      fixture.archiveRoot,
      fixture.modelPackPath,
      manifest.assets.map(({ relativePath }) => relativePath),
    );

    await expect(stageModelPack(fixture)).rejects.toMatchObject({
      code: "MODEL_PACK_INCOMPATIBLE",
    });
  });

  it("许可证记录不依赖 JSON 属性顺序", async () => {
    const fixture = await createModelPackFixture();
    const manifestPath = join(fixture.archiveRoot, "model-pack.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      assets: FixtureAsset[];
      materials: Array<{ byteLength: number; relativePath: string; sha256: string }>;
    };
    manifest.materials = manifest.materials.map(({ byteLength, relativePath, sha256 }) => ({
      sha256,
      relativePath,
      byteLength,
    }));
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeModelPackArchive(
      fixture.archiveRoot,
      fixture.modelPackPath,
      manifest.assets.map(({ relativePath }) => relativePath),
    );

    await expect(stageModelPack(fixture)).resolves.toMatchObject({ installed: true });
  });
});
