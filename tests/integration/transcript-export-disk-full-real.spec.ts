import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTranscriptProjection } from "../../src/transcript-projection/transcript-projection.js";
import {
  commitMeeting,
  createTemporaryMeetingRepository,
  meetingId,
} from "../helpers/meeting-repository-fixture.js";

const run = promisify(execFile);
const enabled = process.platform === "darwin" && process.env.DSH_RUN_EXPORT_DISK_FULL === "1";

async function detach(mountPath: string): Promise<void> {
  try {
    await run("/usr/bin/hdiutil", ["detach", "-quiet", mountPath]);
  } catch {
    await run("/usr/bin/hdiutil", ["detach", "-quiet", "-force", mountPath]);
  }
}

it.skipIf(!enabled)("真实磁盘写满时返回稳定错误且不留下半成品", async () => {
  const temporary = await createTemporaryMeetingRepository();
  const imageRoot = await mkdtemp(join(tmpdir(), "dsh-asr-full-disk-"));
  const imagePath = join(imageRoot, "export.dmg");
  const mountPath = join(imageRoot, "mount");
  const fillerPath = join(mountPath, "filler.bin");
  let attached = false;
  try {
    await mkdir(mountPath);
    await run("/usr/bin/hdiutil", [
      "create", "-quiet", "-size", "8m", "-fs", "HFS+",
      "-volname", "DSHASRExportTest", imagePath,
    ]);
    await run("/usr/bin/hdiutil", [
      "attach", "-quiet", "-nobrowse", "-mountpoint", mountPath, imagePath,
    ]);
    attached = true;
    await run("/bin/dd", ["if=/dev/zero", `of=${fillerPath}`, "bs=1048576"])
      .catch(() => undefined);
    const free = await statfs(mountPath);
    expect(Number(free.bavail) * Number(free.bsize)).toBeLessThan(1_048_576);
    commitMeeting(temporary.repository, 1, {
      texts: Array.from({ length: 400 }, () => "x".repeat(20_000)),
    });
    const projection = createTranscriptProjection(
      temporary.repository,
      () => null,
      { dataRoot: temporary.root, now: () => 2_000 },
    );

    await expect(projection.exportCommittedTranscript({
      meetingId: meetingId(1),
      format: "md",
      outputPath: join(mountPath, "transcript.md"),
    })).rejects.toMatchObject({ code: "EXPORT_WRITE_FAILED" });
    expect(await readdir(mountPath)).toEqual(["filler.bin"]);
  } finally {
    temporary.repository.close();
    await rm(temporary.root, { recursive: true, force: true });
    if (attached) {
      await rm(fillerPath, { force: true }).catch(() => undefined);
      await detach(mountPath);
    }
    await rm(imageRoot, { recursive: true, force: true });
  }
}, 30_000);
