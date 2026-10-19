export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_PIXELS = 25_000_000;
export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export interface Snapshot {
  base: Pixels;
  working: Pixels;
  deleteMask: Uint8Array;
  protectMask: Uint8Array;
  baseVersion: string;
  workVersion: number;
}
export interface ImportedImage { sourceId: string; name: string; pixels: Pixels }
export interface RequestInfo {
  id: string; projectId: string; baseVersion: string; workVersion: number;
  width: number; height: number; createdAt: string; folder: string;
}
export interface Project {
  id: string; name: string; folder: string; snapshot: Snapshot;
  requests: RequestInfo[]; recovered: boolean;
}
export interface RecentProject { id: string; name: string; folder: string }
export interface Candidate { id: string; requestId: string; name: string; pixels: Pixels }
export interface RequestBundle { info: RequestInfo; snapshot: Snapshot; text: string }
export interface ExportResult { path: string; width: number; height: number }
export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
export interface DesktopAPI {
  importImage(): Promise<Reply<ImportedImage | null>>;
  importDropped(bytes: Uint8Array, name: string): Promise<Reply<ImportedImage>>;
  createProject(sourceId: string, snapshot: Snapshot): Promise<Reply<Project>>;
  openProject(): Promise<Reply<Project | null>>;
  openRecent(id: string): Promise<Reply<Project>>;
  listRecent(): Promise<Reply<RecentProject[]>>;
  saveProject(id: string, snapshot: Snapshot): Promise<Reply<{ folder: string }>>;
  saveProjectAs(id: string, snapshot: Snapshot): Promise<Reply<Project | null>>;
  createRequest(id: string, snapshot: Snapshot, guide: Pixels): Promise<Reply<RequestBundle>>;
  loadRequest(id: string, requestId: string): Promise<Reply<RequestBundle>>;
  importCandidate(id: string, requestId: string): Promise<Reply<Candidate | null>>;
  forkRequest(id: string, requestId: string): Promise<Reply<Project>>;
  exportPNG(id: string, pixels: Pixels): Promise<Reply<ExportResult | null>>;
  openFolder(id: string, requestId?: string): Promise<Reply<void>>;
  openChatGPT(): Promise<Reply<void>>;
  copyRequest(id: string, requestId: string): Promise<Reply<void>>;
  detectText(pixels: Pixels, requestId: string): Promise<Reply<Uint8Array>>;
  cancelTextDetection(requestId: string): Promise<Reply<void>>;
}
declare global { interface Window { desktop: DesktopAPI } }
