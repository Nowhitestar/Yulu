export const YULU_HOST_IPC_VERSION = 1;
export const YULU_CAPTURE_IPC_VERSION = 1;
export const YULU_HOST_DATABASE_SCHEMA_VERSION = 1;
export const YULU_HOST_DATABASE_MINIMUM_READABLE_VERSION = 1;

export interface RuntimeDatabaseHealth {
  status: "ok";
  quickCheck: "ok";
  schemaVersion: number;
  minimumReadableVersion: number;
}
