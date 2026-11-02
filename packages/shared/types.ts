export type AssetKind = "music" | "sfx" | "voice" | "ambience";
export type SyncJobType = "import_media" | "apply_timeline";
export type SyncJobStatus =
  | "queued" | "downloading" | "verifying" | "importing"
  | "applying" | "completed" | "failed" | "cancelled";

export interface TimelinePlacement {
  assetVersionId: string;
  startMs: number;
  sourceInMs: number;
  sourceOutMs: number;
  track: "A1" | "A2" | "A3" | "A4";
  volumePercent: number;
  fadeInMs: number;
  fadeOutMs: number;
}

export interface SyncJobRequest {
  jobType: SyncJobType;
  workspaceId: string;
  projectId: string;
  deviceId: string;
  idempotencyKey: string;
  assetVersionIds: string[];
  timeline?: TimelinePlacement[];
}

export interface AssetVersion {
  id: string;
  assetId: string;
  version: number;
  storagePath: string;
  sha256: string;
  sizeBytes: number;
  durationMs?: number;
  mimeType: string;
  createdBy: string;
  createdAt: string;
}
