import { contextBridge, ipcRenderer } from 'electron';
import type {
  Candidate, DesktopAPI, ExportResult, ImportedImage, Pixels, Project, RecentProject,
  Reply, RequestBundle, Snapshot,
} from '../shared/types';

const call = <T>(channel: string, ...args: unknown[]): Promise<Reply<T>> => ipcRenderer.invoke(channel, ...args) as Promise<Reply<T>>;

const api: DesktopAPI = Object.freeze({
  importImage: () => call<ImportedImage | null>('image:import'),
  importDropped: (bytes: Uint8Array, name: string) => call<ImportedImage>('image:drop', bytes, name),
  createProject: (sourceId: string, snapshot: Snapshot) => call<Project>('project:create', sourceId, snapshot),
  openProject: () => call<Project | null>('project:open'),
  openRecent: (id: string) => call<Project>('project:open-recent', id),
  listRecent: () => call<RecentProject[]>('project:list-recent'),
  saveProject: (id: string, snapshot: Snapshot) => call<{ folder: string }>('project:save', id, snapshot),
  saveProjectAs: (id: string, snapshot: Snapshot) => call<Project | null>('project:save-as', id, snapshot),
  createRequest: (id: string, snapshot: Snapshot, guide: Pixels) => call<RequestBundle>('request:create', id, snapshot, guide),
  loadRequest: (id: string, requestId: string) => call<RequestBundle>('request:load', id, requestId),
  importCandidate: (id: string, requestId: string) => call<Candidate | null>('candidate:import', id, requestId),
  forkRequest: (id: string, requestId: string) => call<Project>('request:fork', id, requestId),
  exportPNG: (id: string, pixels: Pixels) => call<ExportResult | null>('export:png', id, pixels),
  openFolder: (id: string, requestId?: string) => call<void>('folder:open', id, requestId),
  openChatGPT: () => call<void>('chatgpt:open'),
  copyRequest: (id: string, requestId: string) => call<void>('request:copy', id, requestId),
  detectText: (pixels: Pixels, requestId: string) => call<Uint8Array>('ai:detect-text', pixels, requestId),
  cancelTextDetection: (requestId: string) => call<void>('ai:cancel-text', requestId),
});

contextBridge.exposeInMainWorld('desktop', api);
