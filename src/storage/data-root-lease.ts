import { chmod, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { MeetingRepositoryError } from "./errors.js";
import { isSqliteBusy, openSqliteExclusiveLease } from "./sqlite-exclusive-lease.js";

export async function acquireDataRootLease(dataRoot: string): Promise<AsyncDisposable> {
  if (!isAbsolute(dataRoot)) {
    throw new MeetingRepositoryError("INVALID_INPUT", "Meeting data root must be absolute");
  }
  try {
    await mkdir(dataRoot, { recursive: true, mode: 0o700 });
    await chmod(dataRoot, 0o700);
    const leasePath = join(dataRoot, "host-lease.sqlite3");
    return await openSqliteExclusiveLease(leasePath);
  } catch (error) {
    if (error instanceof MeetingRepositoryError) throw error;
    if (isSqliteBusy(error)) {
      throw new MeetingRepositoryError(
        "DATA_ROOT_IN_USE",
        "Meeting data root is already in use",
        { cause: error },
      );
    }
    throw new MeetingRepositoryError(
      "STORAGE_FAILURE",
      "Meeting data root lease could not be acquired",
      { cause: error },
    );
  }
}
