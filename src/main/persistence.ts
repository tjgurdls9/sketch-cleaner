import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Candidate, ExportResult, Pixels, Project, RecentProject, RequestBundle, RequestInfo, Snapshot } from '../shared/types';
import { MAX_FILE_BYTES, MAX_PIXELS } from '../shared/types';
import { decodeImage } from './image';
import { UserError } from './errors';

type Revision = { id: string; baseVersion: string; workVersion: number; width: number; height: number };
type StoredRequest = Omit<RequestInfo, 'folder'>;
type StoredCandidate = { id: string; requestId: string; name: string; file: string; format: 'jpeg' | 'png'; sha256: string; width: number; height: number };
type Manifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  original: { file: string; format: 'jpeg' | 'png'; bytes: number; sha256: string; sourcePath: string | null };
  currentRevision: string;
  revisions: Revision[];
  requests: StoredRequest[];
  candidates: StoredCandidate[];
  forkedFrom?: { projectId: string; requestId: string };
};
type Opened = { folder: string; manifest: Manifest; snapshot: Snapshot; recovered: boolean };
type ParsedManifest = { manifest: Manifest; recovered: boolean };
type ReplaceFile = (temporaryPath: string, targetPath: string) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION = /^r\d{6}$/;
const FORMAT = /^(jpeg|png)$/;
const REQUEST_FILES = ['base.png', 'working.png', 'delete-mask.png', 'protect-mask.png'] as const;
const EXPORTED_MASKS = ['delete-mask.png', 'protect-mask.png'] as const;
const MAX_NAME_LENGTH = 180;
const REQUEST_TEXT_MAX = 20_000;
const MAX_INTERNAL_RASTER_BYTES = MAX_PIXELS * 5 + 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isInteger(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

function validVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160 && !hasControl(value);
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function stripControls(value: string): string {
  return [...value].filter(character => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  }).join('');
}

function safeName(input: string): string {
  const base = stripControls(path.basename(input.replace(/\\/g, '/'))).trim().slice(0, MAX_NAME_LENGTH);
  if (!base || base === '.' || base === '..') throw new UserError('파일 이름을 확인해 주세요.');
  return base;
}

function projectName(name: string): string {
  return path.basename(name, path.extname(name)).slice(0, MAX_NAME_LENGTH) || '새 작업';
}

function inside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function safeRelative(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || path.isAbsolute(value) || value.includes('\0')) throw new UserError('프로젝트 파일 경로가 올바르지 않습니다.');
  const normalized = value.replace(/\\/g, '/');
  if (normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new UserError('프로젝트 파일 경로가 올바르지 않습니다.');
  return normalized;
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function clonePixels(pixels: Pixels): Pixels {
  return { width: pixels.width, height: pixels.height, data: new Uint8ClampedArray(pixels.data) };
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    base: clonePixels(snapshot.base), working: clonePixels(snapshot.working),
    deleteMask: new Uint8Array(snapshot.deleteMask), protectMask: new Uint8Array(snapshot.protectMask),
    baseVersion: snapshot.baseVersion, workVersion: snapshot.workVersion,
  };
}

function validatePixels(pixels: Pixels, label: string): void {
  if (!isRecord(pixels) || !isInteger(pixels.width, 1, MAX_PIXELS) || !isInteger(pixels.height, 1, MAX_PIXELS) || pixels.width * pixels.height > MAX_PIXELS) {
    throw new UserError(`${label} 이미지 크기가 올바르지 않습니다.`);
  }
  const data = pixels.data;
  if (!(data instanceof Uint8ClampedArray) || data.byteLength !== pixels.width * pixels.height * 4) throw new UserError(`${label} 이미지 데이터가 올바르지 않습니다.`);
}

function validateSnapshot(snapshot: Snapshot): void {
  if (!isRecord(snapshot) || !validVersion(snapshot.baseVersion) || !isInteger(snapshot.workVersion)) throw new UserError('작업 버전 정보가 올바르지 않습니다.');
  validatePixels(snapshot.base, '기준');
  validatePixels(snapshot.working, '작업');
  const count = snapshot.base.width * snapshot.base.height;
  if (snapshot.working.width !== snapshot.base.width || snapshot.working.height !== snapshot.base.height) throw new UserError('작업 이미지와 기준 이미지의 크기가 다릅니다.');
  if (!(snapshot.deleteMask instanceof Uint8Array) || snapshot.deleteMask.byteLength !== count || !(snapshot.protectMask instanceof Uint8Array) || snapshot.protectMask.byteLength !== count) {
    throw new UserError('마스크 크기가 이미지와 일치하지 않습니다.');
  }
  for (let pixel = 0; pixel < count; pixel += 1) {
    if (snapshot.protectMask[pixel] !== 255) continue;
    const offset = pixel * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      if (snapshot.working.data[offset + channel] !== snapshot.base.data[offset + channel]) {
        throw new UserError('완전히 보호된 픽셀은 기준 이미지와 같아야 합니다.');
      }
    }
  }
}

function validateManifest(value: unknown): Manifest {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > MAX_NAME_LENGTH) {
    throw new UserError('프로젝트 정보가 손상되었거나 지원하지 않는 버전입니다.');
  }
  const original = value.original;
  if (!isRecord(original) || !FORMAT.test(String(original.format)) || typeof original.file !== 'string' || typeof original.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(original.sha256) || !isInteger(original.bytes, 1, MAX_FILE_BYTES) || !(original.sourcePath === null || (typeof original.sourcePath === 'string' && path.isAbsolute(original.sourcePath) && original.sourcePath.length <= 4096))) {
    throw new UserError('프로젝트 원본 정보가 올바르지 않습니다.');
  }
  const expectedOriginalFile = original.format === 'jpeg' ? 'original.jpg' : 'original.png';
  if (original.file !== expectedOriginalFile) throw new UserError('프로젝트 원본 경로가 올바르지 않습니다.');
  if (!REVISION.test(String(value.currentRevision)) || !Array.isArray(value.revisions) || value.revisions.length === 0 || value.revisions.length > 100_000) throw new UserError('프로젝트 리비전 정보가 올바르지 않습니다.');
  const revisions: Revision[] = [];
  const revisionIds = new Set<string>();
  for (const item of value.revisions) {
    if (!isRecord(item) || typeof item.id !== 'string' || !REVISION.test(item.id) || revisionIds.has(item.id) || !validVersion(item.baseVersion) || !isInteger(item.workVersion) || !isInteger(item.width, 1, MAX_PIXELS) || !isInteger(item.height, 1, MAX_PIXELS) || item.width * item.height > MAX_PIXELS) throw new UserError('프로젝트 리비전 정보가 올바르지 않습니다.');
    revisionIds.add(item.id);
    revisions.push({ id: item.id, baseVersion: item.baseVersion, workVersion: item.workVersion, width: item.width, height: item.height });
  }
  if (!revisionIds.has(String(value.currentRevision))) throw new UserError('현재 리비전을 찾을 수 없습니다.');
  if (!Array.isArray(value.requests) || value.requests.length > 100_000) throw new UserError('요청 정보가 올바르지 않습니다.');
  const requests: StoredRequest[] = [];
  const requestIds = new Set<string>();
  for (const item of value.requests) {
    if (!isRecord(item) || typeof item.id !== 'string' || !UUID.test(item.id) || requestIds.has(item.id) || item.projectId !== value.id || !validVersion(item.baseVersion) || !isInteger(item.workVersion) || !isInteger(item.width, 1, MAX_PIXELS) || !isInteger(item.height, 1, MAX_PIXELS) || item.width * item.height > MAX_PIXELS || typeof item.createdAt !== 'string' || Number.isNaN(Date.parse(item.createdAt))) throw new UserError('요청 정보가 올바르지 않습니다.');
    requestIds.add(item.id);
    requests.push({ id: item.id, projectId: item.projectId, baseVersion: item.baseVersion, workVersion: item.workVersion, width: item.width, height: item.height, createdAt: item.createdAt });
  }
  if (!Array.isArray(value.candidates) || value.candidates.length > 100_000) throw new UserError('후보 이미지 정보가 올바르지 않습니다.');
  const candidates: StoredCandidate[] = [];
  const candidateIds = new Set<string>();
  for (const item of value.candidates) {
    if (!isRecord(item) || typeof item.id !== 'string' || !UUID.test(item.id) || candidateIds.has(item.id) || typeof item.requestId !== 'string' || !requestIds.has(item.requestId) || typeof item.name !== 'string' || !item.name || item.name.length > MAX_NAME_LENGTH || !FORMAT.test(String(item.format)) || typeof item.file !== 'string' || item.file !== `candidates/${item.id}.${item.format === 'jpeg' ? 'jpg' : 'png'}` || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) || !isInteger(item.width, 1, MAX_PIXELS) || !isInteger(item.height, 1, MAX_PIXELS) || item.width * item.height > MAX_PIXELS) throw new UserError('후보 이미지 정보가 올바르지 않습니다.');
    candidateIds.add(item.id);
    candidates.push({ id: item.id, requestId: item.requestId, name: item.name, file: item.file, format: item.format as 'jpeg' | 'png', sha256: item.sha256, width: item.width, height: item.height });
  }
  let forkedFrom: Manifest['forkedFrom'];
  if (value.forkedFrom !== undefined) {
    if (!isRecord(value.forkedFrom) || typeof value.forkedFrom.projectId !== 'string' || !UUID.test(value.forkedFrom.projectId) || typeof value.forkedFrom.requestId !== 'string' || !UUID.test(value.forkedFrom.requestId)) throw new UserError('프로젝트 출처 정보가 올바르지 않습니다.');
    forkedFrom = { projectId: value.forkedFrom.projectId, requestId: value.forkedFrom.requestId };
  }
  return {
    schemaVersion: 1, id: value.id, name: value.name,
    original: { file: original.file, format: original.format as 'jpeg' | 'png', bytes: original.bytes, sha256: original.sha256, sourcePath: original.sourcePath },
    currentRevision: value.currentRevision as string, revisions, requests, candidates, ...(forkedFrom ? { forkedFrom } : {}),
  };
}

function validateRequestMetadata(value: unknown, manifest: Manifest, request: StoredRequest): Record<string, unknown> {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.projectId !== manifest.id || value.requestId !== request.id || value.baseVersion !== request.baseVersion || value.workVersion !== request.workVersion || value.width !== request.width || value.height !== request.height || value.createdAt !== request.createdAt || !isRecord(value.snapshot)) throw new UserError('요청 스냅샷 정보가 손상되었습니다.');
  for (const file of REQUEST_FILES) if (value.snapshot[file === 'delete-mask.png' ? 'deleteMask' : file === 'protect-mask.png' ? 'protectMask' : file === 'base.png' ? 'base' : 'working'] !== file) throw new UserError('요청 스냅샷 경로가 올바르지 않습니다.');
  if (value.sourceProjectId !== undefined && (typeof value.sourceProjectId !== 'string' || !UUID.test(value.sourceProjectId))) throw new UserError('요청 출처 정보가 올바르지 않습니다.');
  return value;
}

async function writePng(pixels: Pixels): Promise<Buffer> {
  validatePixels(pixels, '저장');
  return sharp(Buffer.from(pixels.data.buffer, pixels.data.byteOffset, pixels.data.byteLength), { raw: { width: pixels.width, height: pixels.height, channels: 4 } }).png().toBuffer();
}

async function writeMask(mask: Uint8Array, width: number, height: number): Promise<Buffer> {
  if (mask.byteLength !== width * height) throw new UserError('마스크 크기가 이미지와 일치하지 않습니다.');
  return sharp(Buffer.from(mask.buffer, mask.byteOffset, mask.byteLength), { raw: { width, height, channels: 1 } }).png().toBuffer();
}

async function readRaster(bytes: Buffer, expectedWidth: number, expectedHeight: number, channels: 1 | 4): Promise<Uint8Array> {
  if (bytes.byteLength > MAX_INTERNAL_RASTER_BYTES) throw new UserError('프로젝트 이미지가 안전한 저장 한도를 초과합니다.');
  const input = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
  const metadata = await input.metadata();
  const allowedChannels = channels === 4 ? metadata.channels === 3 || metadata.channels === 4 : metadata.channels === 1 || metadata.channels === 3;
  if (metadata.format !== 'png' || metadata.width !== expectedWidth || metadata.height !== expectedHeight || !allowedChannels || metadata.width * metadata.height > MAX_PIXELS) throw new UserError('프로젝트 이미지 또는 마스크 크기가 올바르지 않습니다.');
  const decoder = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: 'error' });
  const decoded = await (channels === 4 ? decoder.ensureAlpha() : decoder).raw().toBuffer({ resolveWithObject: true });
  if (decoded.info.width !== expectedWidth || decoded.info.height !== expectedHeight) throw new UserError('프로젝트 이미지 또는 마스크 데이터가 올바르지 않습니다.');
  if (channels === 4) {
    if (decoded.info.channels !== 4) throw new UserError('프로젝트 이미지 데이터가 올바르지 않습니다.');
    return new Uint8Array(decoded.data);
  }
  if (decoded.info.channels === 1) return new Uint8Array(decoded.data);
  if (decoded.info.channels !== 3) throw new UserError('프로젝트 마스크 데이터가 올바르지 않습니다.');
  const mask = new Uint8Array(expectedWidth * expectedHeight);
  for (let i = 0, pixel = 0; i < decoded.data.length; i += 3, pixel += 1) {
    if (decoded.data[i] !== decoded.data[i + 1] || decoded.data[i] !== decoded.data[i + 2]) throw new UserError('프로젝트 마스크에는 회색조 값만 사용할 수 있습니다.');
    mask[pixel] = decoded.data[i];
  }
  return mask;
}

function snapshotFromRasters(revision: Revision, base: Uint8Array, working: Uint8Array, deleteMask: Uint8Array, protectMask: Uint8Array): Snapshot {
  return {
    base: { width: revision.width, height: revision.height, data: new Uint8ClampedArray(base) },
    working: { width: revision.width, height: revision.height, data: new Uint8ClampedArray(working) },
    deleteMask, protectMask, baseVersion: revision.baseVersion, workVersion: revision.workVersion,
  };
}

function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.baseVersion === b.baseVersion && a.workVersion === b.workVersion
    && a.base.width === b.base.width && a.base.height === b.base.height
    && a.working.width === b.working.width && a.working.height === b.working.height
    && Buffer.from(a.base.data).equals(Buffer.from(b.base.data))
    && Buffer.from(a.working.data).equals(Buffer.from(b.working.data))
    && Buffer.from(a.deleteMask).equals(Buffer.from(b.deleteMask))
    && Buffer.from(a.protectMask).equals(Buffer.from(b.protectMask));
}

function requestText(info: Pick<RequestInfo, 'id' | 'projectId' | 'baseVersion' | 'workVersion' | 'width' | 'height'>): string {
  return [
    '첫 번째 이미지를 편집해 주세요. 두 번째 이미지는 삭제·보호 범위를 표시한 참고이며 결과물이 아닙니다.',
    `프로젝트: ${info.projectId} · 요청: ${info.id} · 작업 버전: ${info.workVersion} · 기준 버전: ${info.baseVersion}`,
    '빨강은 제거 요청 영역, 파랑은 보존 요청 영역입니다. 지시 대상 글씨·화살표·표·배경만 정리하고, 의류의 윤곽·주름·봉제선·점선과 원래 펜의 질감을 유지해 주세요.',
    '구성과 비율을 유지하고 새 선·새 디자인·설명·색 표시를 추가하지 마세요. 가려진 선은 확실하게 복원할 수 있을 때만 최소한으로 보완해 주세요.',
    `입력 크기: ${info.width} × ${info.height} 픽셀. 원본과 같은 캔버스 크기로 반환해 주세요.`,
  ].join('\n\n');
}

export interface ProjectStoreOptions {
  root: string;
  replaceFile?: ReplaceFile;
}

export class ProjectStore {
  private readonly root: string;
  private readonly replaceFile: ReplaceFile;
  private readonly managed = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: ProjectStoreOptions) {
    this.root = path.resolve(options.root);
    this.replaceFile = options.replaceFile ?? ((temporaryPath, targetPath) => rename(temporaryPath, targetPath));
  }

  async create(_sourceId: string, name: string, originalBytes: Uint8Array, snapshot: Snapshot, sourcePath: string | null = null): Promise<Project> {
    validateSnapshot(snapshot);
    if (!(originalBytes instanceof Uint8Array) || originalBytes.byteLength > MAX_FILE_BYTES) throw new UserError('입력 파일은 50MB 이하여야 합니다.');
    const sourceName = safeName(name);
    const decoded = await decodeImage(sourceName, originalBytes);
    if (sourcePath !== null && (!path.isAbsolute(sourcePath) || sourcePath.length > 4096)) throw new UserError('원본 파일 경로가 올바르지 않습니다.');
    const id = randomUUID();
    const folder = path.join(this.root, id);
    const temporary = path.join(this.root, `.creating-${id}`);
    const originalFile = decoded.format === 'jpeg' ? 'original.jpg' : 'original.png';
    const image = cloneSnapshot(snapshot);
    const revisionId = 'r000001';
    const manifest: Manifest = {
      schemaVersion: 1, id, name: projectName(sourceName),
      original: { file: originalFile, format: decoded.format, bytes: originalBytes.byteLength, sha256: hash(originalBytes), sourcePath },
      currentRevision: revisionId,
      revisions: [{ id: revisionId, baseVersion: image.baseVersion, workVersion: image.workVersion, width: image.base.width, height: image.base.height }],
      requests: [], candidates: [],
    };
    await mkdir(this.root, { recursive: true });
    await this.assertNoSymlinks(this.root, '');
    await mkdir(temporary, { recursive: false });
    try {
      await mkdir(path.join(temporary, 'revisions', revisionId), { recursive: true });
      await mkdir(path.join(temporary, 'requests'));
      await mkdir(path.join(temporary, 'candidates'));
      await mkdir(path.join(temporary, 'exports'));
      await writeFile(path.join(temporary, originalFile), Buffer.from(originalBytes), { flag: 'wx', mode: 0o600 });
      await writeFile(path.join(temporary, 'base.png'), await writePng(image.base), { flag: 'wx', mode: 0o600 });
      await this.writeRevision(temporary, manifest.revisions[0], image);
      await this.writeManifest(temporary, manifest);
      await rename(temporary, folder);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    this.managed.set(id, folder);
    return { id, name: manifest.name, folder, snapshot: image, requests: [], recovered: false };
  }

  async save(id: string, snapshot: Snapshot): Promise<{ folder: string }> {
    this.requireUuid(id);
    validateSnapshot(snapshot);
    return this.exclusive(id, async () => {
      const opened = await this.findOpened(id);
      await this.saveUnlocked(opened, snapshot);
      return { folder: opened.folder };
    });
  }

  async open(folderInput: string): Promise<Project> {
    if (typeof folderInput !== 'string' || !path.isAbsolute(folderInput)) throw new UserError('프로젝트 위치가 올바르지 않습니다.');
    const folder = path.resolve(folderInput);
    await this.assertNoSymlinks(folder, '');
    const opened = await this.readOpened(folder);
    this.managed.set(opened.manifest.id, folder);
    await this.updateRecent(opened.manifest.id, folder).catch(() => undefined);
    return this.toProject(opened);
  }

  async openRecent(id: string): Promise<Project> {
    this.requireUuid(id);
    let folder = this.managed.get(id) ?? path.join(this.root, id);
    if (!(await this.exists(folder))) folder = (await this.readRecent())[id] ?? '';
    if (!folder) throw new UserError('최근 프로젝트를 찾을 수 없습니다.');
    const project = await this.open(folder);
    if (project.id !== id) throw new UserError('최근 프로젝트 정보가 일치하지 않습니다.');
    return project;
  }

  async listRecent(): Promise<RecentProject[]> {
    await mkdir(this.root, { recursive: true });
    await this.assertNoSymlinks(this.root, '');
    const found = new Map<string, RecentProject>();
    for (const name of await readdir(this.root).catch(() => [])) {
      if (!UUID.test(name)) continue;
      const folder = path.join(this.root, name);
      try {
        const info = await lstat(folder);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const loaded = await this.tryManifest(folder, 'project.json');
        if (loaded?.manifest.id === name) found.set(name, { id: name, name: loaded.manifest.name, folder });
      } catch { /* skip invalid or incomplete project folders */ }
    }
    const recent = await this.readRecent();
    for (const [id, folder] of Object.entries(recent)) {
      if (found.has(id) || !UUID.test(id)) continue;
      try {
        const loaded = await this.tryManifest(folder, 'project.json');
        if (loaded?.manifest.id === id) found.set(id, { id, name: loaded.manifest.name, folder });
      } catch { /* skip invalid recent entries */ }
    }
    for (const [id, folder] of this.managed) {
      if (found.has(id)) continue;
      try {
        const loaded = await this.tryManifest(folder, 'project.json');
        if (loaded?.manifest.id === id) found.set(id, { id, name: loaded.manifest.name, folder });
      } catch { /* skip invalid in-memory entries */ }
    }
    return [...found.values()].sort((a, b) => b.id.localeCompare(a.id));
  }

  async createRequest(id: string, snapshot: Snapshot, guide: Pixels): Promise<RequestBundle> {
    this.requireUuid(id);
    validateSnapshot(snapshot);
    validatePixels(guide, '안내');
    if (guide.width !== snapshot.working.width || guide.height !== snapshot.working.height) {
      throw new UserError('안내 이미지 크기가 작업 이미지와 다릅니다.');
    }
    return this.exclusive(id, async () => {
      const opened = await this.findOpened(id);
      await this.saveUnlocked(opened, snapshot);
      const current = await this.readOpened(opened.folder);
      const requestId = randomUUID();
      const createdAt = new Date().toISOString();
      const info: RequestInfo = {
        id: requestId, projectId: id, baseVersion: snapshot.baseVersion, workVersion: snapshot.workVersion,
        width: snapshot.base.width, height: snapshot.base.height, createdAt,
        folder: path.join(current.folder, 'requests', requestId),
      };
      const text = requestText(info);
      const metadata = {
        schemaVersion: 1, projectId: id, requestId, baseVersion: info.baseVersion, workVersion: info.workVersion,
        width: info.width, height: info.height, createdAt,
        snapshot: { base: 'base.png', working: 'working.png', deleteMask: 'delete-mask.png', protectMask: 'protect-mask.png' },
      };
      const temporary = path.join(current.folder, 'requests', `.creating-${requestId}`);
      await mkdir(temporary);
      try {
        await Promise.all([
          writeFile(path.join(temporary, 'input.png'), await writePng(snapshot.working), { flag: 'wx', mode: 0o600 }),
          writeFile(path.join(temporary, 'guide.png'), await writePng(guide), { flag: 'wx', mode: 0o600 }),
          writeFile(path.join(temporary, 'base.png'), await writePng(snapshot.base), { flag: 'wx', mode: 0o600 }),
          writeFile(path.join(temporary, 'working.png'), await writePng(snapshot.working), { flag: 'wx', mode: 0o600 }),
          writeFile(path.join(temporary, 'delete-mask.png'), await writeMask(snapshot.deleteMask, snapshot.base.width, snapshot.base.height), { flag: 'wx', mode: 0o600 }),
          writeFile(path.join(temporary, 'protect-mask.png'), await writeMask(snapshot.protectMask, snapshot.base.width, snapshot.base.height), { flag: 'wx', mode: 0o600 }),
          writeFile(path.join(temporary, 'request.txt'), text, { flag: 'wx', mode: 0o600 }),
          writeFile(path.join(temporary, 'metadata.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 }),
        ]);
        const inputRaster = await readRaster(await this.readFile(temporary, 'input.png'), snapshot.working.width, snapshot.working.height, 4);
        const guideRaster = await readRaster(await this.readFile(temporary, 'guide.png'), guide.width, guide.height, 4);
        if (!Buffer.from(inputRaster).equals(Buffer.from(snapshot.working.data))) throw new UserError('요청 입력 이미지 검증에 실패했습니다.');
        if (!Buffer.from(guideRaster).equals(Buffer.from(guide.data))) throw new UserError('안내 이미지 검증에 실패했습니다.');
        validateRequestMetadata(JSON.parse(await this.readText(temporary, 'metadata.json')), current.manifest, {
          id: requestId, projectId: id, baseVersion: info.baseVersion, workVersion: info.workVersion,
          width: info.width, height: info.height, createdAt,
        });
        const storedSnapshot = await this.readRequestSnapshot(temporary, {
          id: requestId, projectId: id, baseVersion: info.baseVersion, workVersion: info.workVersion,
          width: info.width, height: info.height, createdAt,
        });
        if (!sameSnapshot(storedSnapshot, snapshot)) throw new UserError('요청 스냅샷 검증에 실패했습니다.');
        await rename(temporary, info.folder);
        const manifest = current.manifest;
        manifest.requests.push({ id: requestId, projectId: id, baseVersion: info.baseVersion, workVersion: info.workVersion, width: info.width, height: info.height, createdAt });
        try { await this.writeManifest(current.folder, manifest); }
        catch (error) { await rm(info.folder, { recursive: true, force: true }); throw error; }
      } catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return { info, snapshot: cloneSnapshot(snapshot), text };
    });
  }

  async loadRequest(id: string, requestId: string): Promise<RequestBundle> {
    this.requireUuid(id);
    this.requireUuid(requestId);
    const opened = await this.findOpened(id);
    const request = opened.manifest.requests.find(item => item.id === requestId);
    if (!request) throw new UserError('요청을 찾을 수 없습니다.');
    const folder = path.join(opened.folder, 'requests', requestId);
    validateRequestMetadata(JSON.parse(await this.readText(folder, 'metadata.json')), opened.manifest, request);
    const snapshot = await this.readRequestSnapshot(folder, request);
    const text = await this.readText(folder, 'request.txt');
    const input = await readRaster(await this.readFile(folder, 'input.png'), request.width, request.height, 4);
    await readRaster(await this.readFile(folder, 'guide.png'), request.width, request.height, 4);
    if (!text.trim() || text.length > REQUEST_TEXT_MAX || !Buffer.from(input).equals(Buffer.from(snapshot.working.data))) throw new UserError('요청 문구 또는 이미지 파일이 올바르지 않습니다.');
    const info: RequestInfo = { ...request, folder };
    return { info, snapshot, text };
  }

  async addCandidate(id: string, requestId: string, name: string, bytes: Uint8Array, pixels: Pixels): Promise<Candidate> {
    this.requireUuid(id);
    this.requireUuid(requestId);
    validatePixels(pixels, '후보');
    const sourceName = safeName(name);
    const decoded = await decodeImage(sourceName, bytes);
    if (decoded.pixels.width !== pixels.width || decoded.pixels.height !== pixels.height || !Buffer.from(decoded.pixels.data).equals(Buffer.from(pixels.data))) throw new UserError('가져온 후보 이미지 데이터가 일치하지 않습니다.');
    return this.exclusive(id, async () => {
      const opened = await this.findOpened(id);
      const request = opened.manifest.requests.find(item => item.id === requestId);
      if (!request) throw new UserError('후보를 연결할 요청이 없습니다.');
      const candidateId = randomUUID();
      const extension = decoded.format === 'jpeg' ? 'jpg' : 'png';
      const file = `candidates/${candidateId}.${extension}`;
      const candidate: StoredCandidate = {
        id: candidateId, requestId, name: sourceName, file, format: decoded.format,
        sha256: hash(bytes), width: pixels.width, height: pixels.height,
      };
      const destination = path.join(opened.folder, ...safeRelative(file).split('/'));
      await writeFile(destination, Buffer.from(bytes), { flag: 'wx', mode: 0o600 });
      opened.manifest.candidates.push(candidate);
      try { await this.writeManifest(opened.folder, opened.manifest); }
      catch (error) { await rm(destination, { force: true }).catch(() => undefined); throw error; }
      return { id: candidateId, requestId, name: sourceName, pixels: clonePixels(pixels) };
    });
  }

  async loadCandidate(id: string, requestId: string): Promise<Candidate | null> {
    this.requireUuid(id);
    this.requireUuid(requestId);
    const opened = await this.findOpened(id);
    const stored = [...opened.manifest.candidates].reverse().find(item => item.requestId === requestId);
    if (!stored) return null;
    const bytes = await this.readFile(opened.folder, stored.file, MAX_FILE_BYTES);
    if (hash(bytes) !== stored.sha256) throw new UserError('후보 이미지가 손상되었습니다.');
    const decoded = await decodeImage(stored.name, bytes);
    if (decoded.pixels.width !== stored.width || decoded.pixels.height !== stored.height) throw new UserError('후보 이미지 크기가 바뀌었습니다.');
    return { id: stored.id, requestId, name: stored.name, pixels: decoded.pixels };
  }

  async forkRequest(id: string, requestId: string): Promise<Project> {
    const source = await this.loadRequest(id, requestId);
    const sourceRecord = await this.findOpened(id);
    const originalBytes = await this.readFile(sourceRecord.folder, sourceRecord.manifest.original.file, MAX_FILE_BYTES);
    const clone = await this.create(randomUUID(), path.basename(sourceRecord.manifest.original.file === 'original.jpg' ? `${sourceRecord.manifest.name}.jpg` : `${sourceRecord.manifest.name}.png`), originalBytes, source.snapshot, sourceRecord.manifest.original.sourcePath);
    return this.cloneHistory(sourceRecord, clone, [requestId], { projectId: id, requestId });
  }

  async cloneProject(id: string, snapshot: Snapshot, destinationParent: string): Promise<Project> {
    this.requireUuid(id);
    validateSnapshot(snapshot);
    if (!path.isAbsolute(destinationParent)) throw new UserError('저장 위치가 올바르지 않습니다.');
    const source = await this.findOpened(id);
    const root = path.resolve(destinationParent);
    await mkdir(root, { recursive: true });
    await this.assertNoSymlinks(root, '');
    const originalBytes = await this.readFile(source.folder, source.manifest.original.file, MAX_FILE_BYTES);
    const extension = source.manifest.original.format === 'jpeg' ? '.jpg' : '.png';
    const destinationStore = new ProjectStore({ root, replaceFile: this.replaceFile });
    const clone = await destinationStore.create(randomUUID(), `${source.manifest.name}${extension}`, originalBytes, snapshot, source.manifest.original.sourcePath);
    try {
      const copied = await destinationStore.cloneHistory(source, clone, source.manifest.requests.map(item => item.id));
      this.managed.set(copied.id, copied.folder);
      return copied;
    } catch (error) {
      await rm(clone.folder, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async exportPNG(id: string, pixels: Pixels, requestedPath: string): Promise<ExportResult> {
    this.requireUuid(id);
    validatePixels(pixels, '내보내기');
    if (!path.isAbsolute(requestedPath) || path.extname(requestedPath).toLowerCase() !== '.png') throw new UserError('PNG 파일로 저장할 위치를 선택해 주세요.');
    const opened = await this.findOpened(id);
    const destination = path.resolve(requestedPath);
    if (await this.isOriginalPath(opened, destination)) throw new UserError('불러온 원본 파일 경로에는 저장할 수 없습니다. 다른 이름을 선택해 주세요.');
    const parent = path.dirname(destination);
    await mkdir(parent, { recursive: true });
    const realParent = await realpath(parent);
    const requested = path.join(realParent, path.basename(destination));
    if (await this.isOriginalPath(opened, requested)) throw new UserError('불러온 원본 파일 경로에는 저장할 수 없습니다. 다른 이름을 선택해 주세요.');
    const png = await writePng(pixels);
    const ext = path.extname(requested);
    const base = path.basename(requested, ext);
    for (let suffix = 0; suffix < 10_000; suffix += 1) {
      const candidate = path.join(realParent, `${base}${suffix ? ` (${suffix})` : ''}.png`);
      if (await this.isOriginalPath(opened, candidate)) throw new UserError('불러온 원본 파일 경로에는 저장할 수 없습니다. 다른 이름을 선택해 주세요.');
      try {
        const file = await open(candidate, 'wx', 0o600);
        try { await file.writeFile(png); await file.sync(); }
        finally { await file.close(); }
        return { path: candidate, width: pixels.width, height: pixels.height };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
    }
    throw new UserError('새 PNG 파일 이름을 만들 수 없습니다.');
  }

  async folderFor(id: string, requestId?: string): Promise<string> {
    this.requireUuid(id);
    const opened = await this.findOpened(id);
    if (!requestId) return opened.folder;
    this.requireUuid(requestId);
    if (!opened.manifest.requests.some(request => request.id === requestId)) throw new UserError('요청 폴더를 찾을 수 없습니다.');
    const folder = path.join(opened.folder, 'requests', requestId);
    await this.assertNoSymlinks(folder, '');
    return folder;
  }

  private async cloneHistory(source: Opened, target: Project, requestIds: string[], forkedFrom?: { projectId: string; requestId: string }): Promise<Project> {
    const folder = target.folder;
    const targetOpened = await this.readOpened(folder);
    const sourceRequests = source.manifest.requests.filter(request => requestIds.includes(request.id));
    for (const request of sourceRequests) {
      const sourceFolder = path.join(source.folder, 'requests', request.id);
      const destFolder = path.join(folder, 'requests', request.id);
      const temp = path.join(folder, 'requests', `.copy-${randomUUID()}`);
      await mkdir(temp);
      try {
        for (const filename of ['input.png', 'guide.png', 'request.txt', 'metadata.json', ...REQUEST_FILES]) {
          const bytes = await this.readFile(sourceFolder, filename);
          if (filename === 'metadata.json') {
            const metadata = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
            metadata.projectId = target.id;
            metadata.sourceProjectId = source.manifest.id;
            await writeFile(path.join(temp, filename), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
          } else await writeFile(path.join(temp, filename), bytes, { flag: 'wx', mode: 0o600 });
        }
        await rename(temp, destFolder);
      } catch (error) {
        await rm(temp, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      targetOpened.manifest.requests.push({ ...request, projectId: target.id });
    }
    for (const item of source.manifest.candidates.filter(candidate => requestIds.includes(candidate.requestId))) {
      const bytes = await this.readFile(source.folder, item.file);
      const targetPath = path.join(folder, ...safeRelative(item.file).split('/'));
      await writeFile(targetPath, bytes, { flag: 'wx', mode: 0o600 });
      targetOpened.manifest.candidates.push(item);
    }
    if (forkedFrom) targetOpened.manifest.forkedFrom = forkedFrom;
    await this.writeManifest(folder, targetOpened.manifest);
    const final = await this.readOpened(folder);
    return this.toProject(final);
  }

  private async saveUnlocked(opened: Opened, input: Snapshot): Promise<void> {
    validateSnapshot(input);
    const currentRevision = opened.manifest.revisions.find(item => item.id === opened.manifest.currentRevision);
    if (!currentRevision) throw new UserError('현재 작업 버전을 찾을 수 없습니다.');
    const current = (await this.readOpened(opened.folder)).snapshot;
    if (input.workVersion < current.workVersion) throw new UserError('오래된 작업 버전은 저장할 수 없습니다. 최신 변경사항을 다시 불러와 주세요.');
    if (input.baseVersion === current.baseVersion && (input.base.width !== current.base.width || input.base.height !== current.base.height || !Buffer.from(input.base.data).equals(Buffer.from(current.base.data)))) throw new UserError('기준 이미지가 바뀌었지만 버전이 갱신되지 않았습니다.');
    if (input.workVersion === current.workVersion) {
      if (!sameSnapshot(input, current)) throw new UserError('같은 작업 버전의 내용이 서로 다릅니다. 최신 변경사항을 다시 불러와 주세요.');
      return;
    }
    const snapshot = cloneSnapshot(input);
    const revisionId = await this.nextRevisionId(opened.folder, opened.manifest);
    const revision: Revision = { id: revisionId, baseVersion: snapshot.baseVersion, workVersion: snapshot.workVersion, width: snapshot.base.width, height: snapshot.base.height };
    const revisionFolder = path.join(opened.folder, 'revisions', revisionId);
    await mkdir(revisionFolder);
    await this.writeRevision(opened.folder, revision, snapshot);
    opened.manifest.revisions.push(revision);
    opened.manifest.currentRevision = revisionId;
    try { await this.writeManifest(opened.folder, opened.manifest); }
    catch (error) { opened.manifest.revisions.pop(); opened.manifest.currentRevision = currentRevision.id; throw error; }
  }

  private async writeRevision(folder: string, revision: Revision, snapshot: Snapshot): Promise<void> {
    const target = path.join(folder, 'revisions', revision.id);
    await mkdir(target, { recursive: true });
    const files = await Promise.all([
      writePng(snapshot.base), writePng(snapshot.working),
      writeMask(snapshot.deleteMask, snapshot.base.width, snapshot.base.height), writeMask(snapshot.protectMask, snapshot.base.width, snapshot.base.height),
    ]);
    for (let i = 0; i < files.length; i += 1) await writeFile(path.join(target, ['base.png', 'working.png', ...EXPORTED_MASKS][i]), files[i], { flag: 'wx', mode: 0o600 });
    const verified = await this.readRevision(folder, revision);
    if (!sameSnapshot(verified, snapshot)) throw new UserError('저장한 작업 이미지 또는 마스크를 검증하지 못했습니다.');
  }

  private async writeManifest(folder: string, manifest: Manifest): Promise<void> {
    validateManifest(manifest);
    const file = path.join(folder, 'project.json');
    const temporary = path.join(folder, `.project-${randomUUID()}.tmp`);
    const previous = path.join(folder, 'project.previous.json');
    let previousTemp = '';
    try {
      if (await this.exists(file)) {
        await this.assertNoSymlinks(folder, 'project.json');
        const recovered = await this.readOpened(folder);
        const backup = Buffer.from(JSON.stringify(recovered.manifest));
        previousTemp = path.join(folder, `.previous-${randomUUID()}.tmp`);
        await writeFile(previousTemp, backup, { flag: 'wx', mode: 0o600 });
        await rename(previousTemp, previous);
        previousTemp = '';
      }
      await writeFile(temporary, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
      await this.replaceFile(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (previousTemp) await rm(previousTemp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readOpened(folder: string): Promise<Opened> {
    const primary = await this.tryManifest(folder, 'project.json');
    if (primary) {
      const checked = await this.openFromManifest(folder, primary.manifest).catch(() => null);
      if (checked) return { ...checked, recovered: checked.recovered || primary.recovered };
      const previous = await this.tryManifest(folder, 'project.previous.json');
      if (previous) {
        const recovered = await this.openFromManifest(folder, previous.manifest).catch(() => null);
        if (recovered) return { ...recovered, recovered: true };
      }
      for (const revision of [...primary.manifest.revisions].reverse()) {
        if (revision.id === primary.manifest.currentRevision) continue;
        try {
          const alternate = { ...primary.manifest, currentRevision: revision.id };
          const opened = await this.openFromManifest(folder, alternate);
          return { ...opened, recovered: true };
        } catch { /* try the next older valid revision */ }
      }
    }
    const previous = await this.tryManifest(folder, 'project.previous.json');
    if (previous) {
      const recovered = await this.openFromManifest(folder, previous.manifest).catch(() => null);
      if (recovered) return { ...recovered, recovered: true };
    }
    throw new UserError('프로젝트를 열 수 없습니다. 저장본이 손상되었거나 파일이 누락되었습니다.');
  }

  private async tryManifest(folder: string, filename: string): Promise<ParsedManifest | null> {
    try {
      const parsed: unknown = JSON.parse(await this.readText(folder, filename));
      try { return { manifest: validateManifest(parsed), recovered: false }; }
      catch {
        if (!isRecord(parsed)) return null;
        const core = validateManifest({ ...parsed, requests: [], candidates: [] });
        const requests: StoredRequest[] = [];
        const requestIds = new Set<string>();
        for (const item of Array.isArray(parsed.requests) ? parsed.requests : []) {
          try {
            const request = validateManifest({ ...parsed, requests: [item], candidates: [] }).requests[0];
            if (!requestIds.has(request.id)) { requests.push(request); requestIds.add(request.id); }
          }
          catch { /* drop unsafe request metadata but preserve its files on disk */ }
        }
        const candidates: StoredCandidate[] = [];
        const candidateIds = new Set<string>();
        for (const item of Array.isArray(parsed.candidates) ? parsed.candidates : []) {
          try {
            const candidate = validateManifest({ ...parsed, requests, candidates: [item] }).candidates[0];
            if (!candidateIds.has(candidate.id)) { candidates.push(candidate); candidateIds.add(candidate.id); }
          }
          catch { /* drop unsafe candidate metadata but preserve its file on disk */ }
        }
        return { manifest: { ...core, requests, candidates }, recovered: true };
      }
    }
    catch { return null; }
  }

  private async openFromManifest(folder: string, manifest: Manifest): Promise<Opened> {
    const source = await this.readFile(folder, manifest.original.file, MAX_FILE_BYTES);
    if (source.byteLength !== manifest.original.bytes || hash(source) !== manifest.original.sha256) throw new UserError('프로젝트 원본 사본이 손상되었습니다.');
    const original = await decodeImage(manifest.original.file, source);
    if (original.format !== manifest.original.format) throw new UserError('프로젝트 원본 형식이 올바르지 않습니다.');
    await this.readFile(folder, 'base.png');
    const current = manifest.revisions.find(item => item.id === manifest.currentRevision);
    if (!current) throw new UserError('현재 작업 버전을 찾을 수 없습니다.');
    const snapshot = await this.readRevision(folder, current);
    let recovered = false;
    for (const request of manifest.requests) {
      try {
        const requestFolder = path.join(folder, 'requests', request.id);
        await this.assertNoSymlinks(requestFolder, '');
        validateRequestMetadata(JSON.parse(await this.readText(requestFolder, 'metadata.json')), manifest, request);
        const requestSnapshot = await this.readRequestSnapshot(requestFolder, request);
        const input = await readRaster(await this.readFile(requestFolder, 'input.png'), request.width, request.height, 4);
        const guideBytes = await this.readFile(requestFolder, 'guide.png');
        await readRaster(guideBytes, request.width, request.height, 4);
        const requestTextBytes = await this.readText(requestFolder, 'request.txt');
        if (!requestTextBytes.trim() || requestTextBytes.length > REQUEST_TEXT_MAX
          || !Buffer.from(input).equals(Buffer.from(requestSnapshot.working.data))) throw new UserError('요청 파일이 손상되었거나 크기가 일치하지 않습니다.');
      } catch { recovered = true; }
    }
    for (const candidate of manifest.candidates) {
      try {
        const bytes = await this.readFile(folder, candidate.file, MAX_FILE_BYTES);
        if (hash(bytes) !== candidate.sha256) throw new UserError('후보 이미지가 손상되었습니다.');
        const decoded = await decodeImage(candidate.name, bytes);
        if (decoded.format !== candidate.format || decoded.pixels.width !== candidate.width || decoded.pixels.height !== candidate.height) throw new UserError('후보 이미지 크기 또는 형식이 바뀌었습니다.');
      } catch { recovered = true; }
    }
    return { folder, manifest, snapshot, recovered };
  }

  private async readRevision(folder: string, revision: Revision): Promise<Snapshot> {
    const prefix = `revisions/${revision.id}`;
    const base = await readRaster(await this.readFile(folder, `${prefix}/base.png`), revision.width, revision.height, 4);
    const working = await readRaster(await this.readFile(folder, `${prefix}/working.png`), revision.width, revision.height, 4);
    const deleteMask = await readRaster(await this.readFile(folder, `${prefix}/delete-mask.png`), revision.width, revision.height, 1);
    const protectMask = await readRaster(await this.readFile(folder, `${prefix}/protect-mask.png`), revision.width, revision.height, 1);
    const snapshot = snapshotFromRasters(revision, base, working, deleteMask, protectMask);
    validateSnapshot(snapshot);
    return snapshot;
  }

  private async readRequestSnapshot(folder: string, request: StoredRequest): Promise<Snapshot> {
    const base = await readRaster(await this.readFile(folder, 'base.png'), request.width, request.height, 4);
    const working = await readRaster(await this.readFile(folder, 'working.png'), request.width, request.height, 4);
    const deleteMask = await readRaster(await this.readFile(folder, 'delete-mask.png'), request.width, request.height, 1);
    const protectMask = await readRaster(await this.readFile(folder, 'protect-mask.png'), request.width, request.height, 1);
    const snapshot = snapshotFromRasters({ id: 'r000001', baseVersion: request.baseVersion, workVersion: request.workVersion, width: request.width, height: request.height }, base, working, deleteMask, protectMask);
    validateSnapshot(snapshot);
    return snapshot;
  }

  private async readFile(folder: string, relative: string, maxBytes = MAX_INTERNAL_RASTER_BYTES): Promise<Buffer> {
    const target = await this.assertNoSymlinks(folder, relative);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new UserError('프로젝트 파일이 파일 형식 또는 크기 한도를 벗어났습니다.');
    const bytes = await readFile(target);
    if (bytes.byteLength > maxBytes) throw new UserError('프로젝트 파일이 파일 형식 또는 크기 한도를 벗어났습니다.');
    return bytes;
  }

  private async readText(folder: string, relative: string): Promise<string> {
    const bytes = await this.readFile(folder, relative, 2_000_000);
    return bytes.toString('utf8');
  }

  private async assertNoSymlinks(rootInput: string, relativeInput: string): Promise<string> {
    const root = path.resolve(rootInput);
    const relative = relativeInput ? safeRelative(relativeInput) : '';
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new UserError('프로젝트 폴더가 올바르지 않습니다.');
    const realRoot = await realpath(root);
    if (relative === '') return root;
    const segments = relative.split('/');
    let current = root;
    for (const segment of segments) {
      current = path.join(current, segment);
      if (!inside(root, current)) throw new UserError('프로젝트 파일 경로가 폴더 밖을 가리킵니다.');
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new UserError('프로젝트에는 심볼릭 링크를 사용할 수 없습니다.');
    }
    const realTarget = await realpath(current);
    if (!inside(realRoot, realTarget)) throw new UserError('프로젝트 파일 경로가 폴더 밖을 가리킵니다.');
    return current;
  }

  private async findOpened(id: string): Promise<Opened> {
    const folder = this.managed.get(id) ?? path.join(this.root, id);
    if (!(await this.exists(folder))) {
      const registered = (await this.readRecent())[id];
      if (!registered) throw new UserError('프로젝트를 찾을 수 없습니다.');
      const opened = await this.readOpened(registered);
      if (opened.manifest.id !== id) throw new UserError('프로젝트 정보가 일치하지 않습니다.');
      this.managed.set(id, registered);
      return opened;
    }
    const opened = await this.readOpened(folder);
    if (opened.manifest.id !== id) throw new UserError('프로젝트 정보가 일치하지 않습니다.');
    this.managed.set(id, folder);
    return opened;
  }

  private async toProject(opened: Opened): Promise<Project> {
    return {
      id: opened.manifest.id, name: opened.manifest.name, folder: opened.folder,
      snapshot: cloneSnapshot(opened.snapshot),
      requests: opened.manifest.requests.map(request => ({ ...request, folder: path.join(opened.folder, 'requests', request.id) })),
      recovered: opened.recovered,
    };
  }

  private async isOriginalPath(opened: Opened, target: string): Promise<boolean> {
    const original = opened.manifest.original.sourcePath;
    const compare = (left: string, right: string): boolean => process.platform === 'win32' ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US') : left === right;
    if (original && compare(path.resolve(original), path.resolve(target))) return true;
    try {
      const targetReal = await realpath(target);
      if (original && compare(await realpath(original), targetReal)) return true;
      const copiedOriginal = path.join(opened.folder, opened.manifest.original.file);
      if (compare(await realpath(copiedOriginal), targetReal)) return true;
    } catch { /* a new export path has no target realpath yet */ }
    try {
      const targetInfo = await stat(target);
      const sourcePaths = [original, path.join(opened.folder, opened.manifest.original.file)].filter((value): value is string => Boolean(value));
      for (const sourcePath of sourcePaths) {
        const sourceInfo = await stat(sourcePath);
        if (targetInfo.dev === sourceInfo.dev && targetInfo.ino === sourceInfo.ino) return true;
      }
    } catch { /* missing targets do not alias an original file */ }
    return false;
  }

  private async nextRevisionId(folder: string, manifest: Manifest): Promise<string> {
    let number = Math.max(0, ...manifest.revisions.map(item => Number(item.id.slice(1)))) + 1;
    while (number < 1_000_000) {
      const id = `r${String(number).padStart(6, '0')}`;
      if (!(await this.exists(path.join(folder, 'revisions', id)))) return id;
      number += 1;
    }
    throw new UserError('더 이상 새 작업 버전을 만들 수 없습니다.');
  }

  private async readRecent(): Promise<Record<string, string>> {
    try {
      const rootInfo = await lstat(this.root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return {};
      const bytes = await this.readFile(this.root, 'recent.json', 2_000_000);
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (!isRecord(parsed)) return {};
      const result: Record<string, string> = {};
      for (const [id, folder] of Object.entries(parsed)) if (UUID.test(id) && typeof folder === 'string' && path.isAbsolute(folder)) result[id] = folder;
      return result;
    } catch { return {}; }
  }

  private async updateRecent(id: string, folder: string): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.assertNoSymlinks(this.root, '');
    const entries = await this.readRecent();
    entries[id] = path.resolve(folder);
    const temporary = path.join(this.root, `.recent-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(entries), { flag: 'wx', mode: 0o600 });
    await this.replaceFile(temporary, path.join(this.root, 'recent.json'));
  }

  private async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(id, current);
    try { return await current; }
    finally { if (this.locks.get(id) === current) this.locks.delete(id); }
  }

  private requireUuid(id: string): void {
    if (typeof id !== 'string' || !UUID.test(id)) throw new UserError('프로젝트 또는 요청 ID가 올바르지 않습니다.');
  }

  private async exists(filename: string): Promise<boolean> {
    try { await lstat(filename); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
}
