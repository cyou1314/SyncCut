export type AssetKind = "music" | "sfx" | "voice" | "ambience";
export type SyncJobType = "refresh_record" | "full_sync" | "import_media" | "apply_timeline";
export type SyncJobStatus =
  | "queued" | "downloading" | "verifying" | "importing"
  | "applying" | "completed" | "failed" | "cancelled";

export type TenantRole = "owner" | "admin" | "editor" | "editorial" | "viewer";
export type FeishuConnectionStatus = "active" | "needs_reauth" | "revoked" | "error";

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
  tenantId: string;
  connectionId: string;
  projectId?: string;
  deviceId: string;
  idempotencyKey: string;
  assetVersionIds: string[];
  timeline?: TimelinePlacement[];
}

export interface AssetVersion {
  id: string;
  assetId: string;
  version: number;
  fileToken: string;
  sha256?: string;
  sizeBytes?: number;
  durationMs?: number;
  mimeType?: string;
  createdAt: string;
}

export interface FeishuConnectionSummary {
  id: string;
  tenantId: string;
  appToken: string;
  tableId: string;
  status: FeishuConnectionStatus;
  lastFullSyncAt?: string;
}

export interface BitableWebhookPayload {
  event_type: "record.created" | "record.updated";
  record_id: string;
  modified_time?: string | number;
  app_token: string;
  table_id: string;
}

export interface BitableAssetFieldMapping {
  name: string;
  kind: string;
  attachment: string;
  project?: string;
  episode?: string;
  scene?: string;
  shotId?: string;
  tags?: string;
  notes?: string;
  startSeconds?: string;
  sourceInSeconds?: string;
  sourceOutSeconds?: string;
  track?: string;
  volumePercent?: string;
  fadeInSeconds?: string;
  fadeOutSeconds?: string;
  modifiedTime?: string;
}
