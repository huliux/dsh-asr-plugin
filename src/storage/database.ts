import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { MeetingRepositoryError } from "./errors.js";
import {
  MIGRATE_SCHEMA_V1_TO_V2_SQL,
  MIGRATE_SCHEMA_V2_TO_V3_SQL,
  MIGRATE_SCHEMA_V3_TO_V4_SQL,
  SCHEMA_V4_SQL,
  SCHEMA_VERSION,
} from "./schema.js";

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;
  `);
}

function userVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get();
  const version = (row as Record<string, unknown>).user_version;
  if (!Number.isSafeInteger(version)) throw new Error("Invalid user_version");
  return version as number;
}

function rollbackQuietly(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // Preserve the failure that caused the rollback.
  }
}

function executeSchemaTransaction(database: DatabaseSync, sql: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(database);
    throw error;
  }
}

function migrateV1ToV2(database: DatabaseSync): void {
  verifyDatabase(database);
  database.exec("PRAGMA foreign_keys = OFF");
  try {
    executeSchemaTransaction(database, MIGRATE_SCHEMA_V1_TO_V2_SQL);
  } finally {
    database.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateV2ToV3(database: DatabaseSync): void {
  executeSchemaTransaction(database, MIGRATE_SCHEMA_V2_TO_V3_SQL);
}

function initializeSchema(database: DatabaseSync): void {
  let version = userVersion(database);
  if (version === 0) {
    executeSchemaTransaction(database, SCHEMA_V4_SQL);
    return;
  }
  if (version === 1) {
    migrateV1ToV2(database);
    verifyDatabase(database);
    version = userVersion(database);
  }
  if (version === 2) {
    migrateV2ToV3(database);
    version = userVersion(database);
  }
  if (version === 3) {
    executeSchemaTransaction(database, MIGRATE_SCHEMA_V3_TO_V4_SQL);
    version = userVersion(database);
  }
  if (version === SCHEMA_VERSION) return;
  throw new MeetingRepositoryError(
    "SCHEMA_VERSION_UNSUPPORTED",
    "Database schema version is unsupported by this plugin",
  );
}

function pragmaValue(database: DatabaseSync, name: string): unknown {
  const row = database.prepare(`PRAGMA ${name}`).get();
  if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
  return Object.values(row)[0];
}

function verifyDatabase(database: DatabaseSync): void {
  try {
    const pragmas = [
      ["foreign_keys", 1],
      ["journal_mode", "wal"],
      ["synchronous", 2],
      ["busy_timeout", 5_000],
      ["trusted_schema", 0],
    ] as const;
    if (pragmas.some(([name, expected]) => pragmaValue(database, name) !== expected)) {
      throw new Error("SQLite connection pragma mismatch");
    }
    const quickCheck = database.prepare("PRAGMA quick_check").all();
    if (quickCheck.length !== 1
      || (quickCheck[0] as Record<string, unknown>).quick_check !== "ok") {
      throw new Error("SQLite quick check failed");
    }
    if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
      throw new Error("SQLite foreign key check failed");
    }
    database.exec(`
      INSERT INTO segments_fts(segments_fts, rank) VALUES('integrity-check', 1)
    `);
  } catch (error) {
    throw new MeetingRepositoryError(
      "DATABASE_INTEGRITY_FAILED",
      "Meeting database integrity check failed",
      { cause: error },
    );
  }
}

function closeQuietly(database: DatabaseSync | undefined): void {
  try {
    database?.close();
  } catch {
    // Preserve the original open or verification failure.
  }
}

export function openMeetingDatabase(filename: string): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    configureDatabase(database);
    initializeSchema(database);
    verifyDatabase(database);
    return database;
  } catch (error) {
    closeQuietly(database);
    if (error instanceof MeetingRepositoryError) throw error;
    throw new MeetingRepositoryError(
      "STORAGE_FAILURE",
      "Meeting database could not be opened",
      { cause: error },
    );
  }
}

export function inWriteTransaction<T>(database: DatabaseSync, operation: () => T): T {
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) rollbackQuietly(database);
    if (error instanceof MeetingRepositoryError) throw error;
    throw new MeetingRepositoryError("STORAGE_FAILURE", "Meeting storage write failed", {
      cause: error,
    });
  }
}

export function inReadOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof MeetingRepositoryError) throw error;
    throw new MeetingRepositoryError("STORAGE_FAILURE", "Meeting storage read failed", {
      cause: error,
    });
  }
}

export function inReadTransaction<T>(database: DatabaseSync, operation: () => T): T {
  let transactionStarted = false;
  try {
    database.exec("BEGIN");
    transactionStarted = true;
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (transactionStarted) rollbackQuietly(database);
    if (error instanceof MeetingRepositoryError) throw error;
    throw new MeetingRepositoryError("STORAGE_FAILURE", "Meeting storage read failed", {
      cause: error,
    });
  }
}
