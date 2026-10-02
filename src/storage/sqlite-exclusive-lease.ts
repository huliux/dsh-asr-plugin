import { chmod } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY = 5;
const SQLITE_PRIMARY_CODE_MASK = 0xff;

interface SqliteFailure {
  readonly code?: unknown;
  readonly errcode?: unknown;
}

export function isSqliteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const failure = error as SqliteFailure;
  return failure.code === "ERR_SQLITE_ERROR" &&
    Number.isInteger(failure.errcode) &&
    ((failure.errcode as number) & SQLITE_PRIMARY_CODE_MASK) === SQLITE_BUSY;
}

function closeQuietly(database: DatabaseSync | undefined): void {
  try {
    if (database?.isOpen === true) database.close();
  } catch {
    // Preserve the acquisition failure.
  }
}

class SqliteExclusiveLease implements AsyncDisposable {
  constructor(private readonly database: DatabaseSync) {}

  async [Symbol.asyncDispose](): Promise<void> {
    if (!this.database.isOpen) return;
    try {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
    } finally {
      if (this.database.isOpen) this.database.close();
    }
  }
}

export async function openSqliteExclusiveLease(path: string): Promise<AsyncDisposable> {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path);
    await chmod(path, 0o600);
    database.exec(`
      PRAGMA busy_timeout = 0;
      PRAGMA journal_mode = MEMORY;
      PRAGMA trusted_schema = OFF;
      BEGIN EXCLUSIVE;
    `);
    return new SqliteExclusiveLease(database);
  } catch (error) {
    closeQuietly(database);
    throw error;
  }
}
