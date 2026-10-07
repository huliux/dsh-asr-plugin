export interface RecordingPermissions {
  readonly microphone: "granted" | "denied" | "restricted" | "notDetermined";
  readonly system: "verified" | "unverified" | "unsupported";
}

export interface RecordingPermissionControl {
  read(signal?: AbortSignal): Promise<RecordingPermissions>;
  test(signal?: AbortSignal): Promise<RecordingPermissions>;
  require(signal?: AbortSignal): Promise<void>;
  openSettings(track: "microphone" | "system", signal?: AbortSignal): Promise<void>;
}

export function parseRecordingPermissions(value: unknown): RecordingPermissions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_RESPONSE");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 2 ||
      typeof item.microphone !== "string" || typeof item.system !== "string" ||
      !["granted", "denied", "restricted", "notDetermined"].includes(item.microphone) ||
      !["verified", "unverified", "unsupported"].includes(item.system)) throw new Error("INVALID_RESPONSE");
  return item as unknown as RecordingPermissions;
}
