import { app, BrowserWindow, clipboard, dialog, ipcMain, screen, session, shell } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import type { IpcMainInvokeEvent } from 'electron';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Candidate, Pixels, Reply, Snapshot } from '../shared/types';
import { MAX_FILE_BYTES } from '../shared/types';
import { decodeImage } from './image';
import { ProjectStore } from './persistence';
import { CHATGPT_URL, isTrustedSender, requireId } from './security';
import { safeErrorMessage, UserError } from './errors';
import { TextDetectionService } from './ai-manager';

type Source = { name: string; bytes: Uint8Array; path: string | null; pixels: Pixels };

const sources = new Map<string, Source>();
let mainWindow: BrowserWindow | null = null;
let projectStore: ProjectStore;
let rendererEntry = '';
let textDetection: TextDetectionService;

function isPixels(value: unknown): value is Pixels {
  if (!value || typeof value !== 'object') return false;
  const pixels = value as Pixels;
  return Number.isSafeInteger(pixels.width) && Number.isSafeInteger(pixels.height) && pixels.data instanceof Uint8ClampedArray;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Snapshot;
  return isPixels(snapshot.base) && isPixels(snapshot.working) && snapshot.deleteMask instanceof Uint8Array
    && snapshot.protectMask instanceof Uint8Array && typeof snapshot.baseVersion === 'string'
    && Number.isSafeInteger(snapshot.workVersion);
}

function exactLocalEntry(url: string): boolean {
  return url === pathToFileURL(rendererEntry).href;
}

function trustedEvent(event: IpcMainInvokeEvent): boolean {
  const active = mainWindow;
  return Boolean(active && !active.isDestroyed() && event.sender === active.webContents
    && isTrustedSender(event.sender.id, active.webContents.id)
    && event.senderFrame === active.webContents.mainFrame && exactLocalEntry(event.senderFrame.url));
}

function register<T>(channel: string, action: (...args: unknown[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, ...args): Promise<Reply<T>> => {
    if (!trustedEvent(event)) return { ok: false, error: '허용되지 않은 호출입니다.' };
    try { return { ok: true, value: await action(...args) }; }
    catch (error) { return { ok: false, error: safeErrorMessage(error) }; }
  });
}

async function selectedImage(filename: string): Promise<Source> {
  const fileStat = await stat(filename);
  if (!fileStat.isFile()) throw new UserError('일반 파일만 열 수 있습니다.');
  if (fileStat.size > MAX_FILE_BYTES) throw new UserError('입력 파일은 50MB 이하여야 합니다.');
  const bytes = new Uint8Array(await readFile(filename));
  if (bytes.byteLength > MAX_FILE_BYTES) throw new UserError('입력 파일은 50MB 이하여야 합니다.');
  const name = path.basename(filename);
  const decoded = await decodeImage(name, bytes);
  return { name, bytes, path: await realpath(filename), pixels: decoded.pixels };
}

function registerHandlers(): void {
  register('image:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '사진 열기', properties: ['openFile'],
      filters: [{ name: 'JPEG 또는 PNG', extensions: ['jpg', 'jpeg', 'png'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const source = await selectedImage(result.filePaths[0]);
    const sourceId = randomUUID();
    sources.set(sourceId, source);
    return { sourceId, name: source.name, pixels: source.pixels };
  });

  register('image:drop', async (...args) => {
    const [input, name] = args;
    if (!(input instanceof Uint8Array) || typeof name !== 'string') throw new UserError('가져온 파일 정보가 올바르지 않습니다.');
    const bytes = new Uint8Array(input);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new UserError('입력 파일은 50MB 이하여야 합니다.');
    const decoded = await decodeImage(name, bytes);
    const sourceId = randomUUID();
    sources.set(sourceId, { name: path.basename(name.replace(/\\/g, '/')), bytes, path: null, pixels: decoded.pixels });
    return { sourceId, name: path.basename(name.replace(/\\/g, '/')), pixels: decoded.pixels };
  });

  register('project:create', async (...args) => {
    const [sourceId, snapshot] = args;
    if (typeof sourceId !== 'string' || !isSnapshot(snapshot)) throw new UserError('새 작업 정보가 올바르지 않습니다.');
    const source = sources.get(sourceId);
    if (!source) throw new UserError('불러온 원본을 찾을 수 없습니다. 다시 사진을 열어 주세요.');
    const project = await projectStore.create(sourceId, source.name, source.bytes, snapshot, source.path);
    sources.delete(sourceId);
    return project;
  });

  register('project:open', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { title: '프로젝트 열기', properties: ['openDirectory'] });
    return result.canceled || !result.filePaths[0] ? null : projectStore.open(result.filePaths[0]);
  });
  register('project:open-recent', async (...args) => projectStore.openRecent(requireId(args[0])));
  register('project:list-recent', () => projectStore.listRecent());
  register('project:save', async (...args) => {
    const [id, snapshot] = args;
    if (!isSnapshot(snapshot)) throw new UserError('저장할 작업 정보가 올바르지 않습니다.');
    return projectStore.save(requireId(id), snapshot);
  });
  register('project:save-as', async (...args) => {
    const [id, snapshot] = args;
    if (!isSnapshot(snapshot)) throw new UserError('저장할 작업 정보가 올바르지 않습니다.');
    const result = await dialog.showOpenDialog(mainWindow!, { title: '다른 폴더에 프로젝트 복사', properties: ['openDirectory', 'createDirectory'] });
    return result.canceled || !result.filePaths[0] ? null : projectStore.cloneProject(requireId(id), snapshot, result.filePaths[0]);
  });

  register('request:create', async (...args) => {
    const [id, snapshot, guide] = args;
    if (!isSnapshot(snapshot) || !isPixels(guide)) throw new UserError('요청 이미지 정보가 올바르지 않습니다.');
    return projectStore.createRequest(requireId(id), snapshot, guide);
  });
  register('request:load', async (...args) => projectStore.loadRequest(requireId(args[0]), requireId(args[1])));
  register('request:fork', async (...args) => projectStore.forkRequest(requireId(args[0]), requireId(args[1])));
  register('request:copy', async (...args) => {
    const bundle = await projectStore.loadRequest(requireId(args[0]), requireId(args[1]));
    clipboard.writeText(bundle.text);
  });

  register('candidate:import', async (...args): Promise<Candidate | null> => {
    const id = requireId(args[0]);
    const requestId = requireId(args[1]);
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: '후보 이미지 열기', properties: ['openFile'],
      filters: [{ name: 'JPEG 또는 PNG', extensions: ['jpg', 'jpeg', 'png'] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const source = await selectedImage(result.filePaths[0]);
    return projectStore.addCandidate(id, requestId, source.name, source.bytes, source.pixels);
  });

  register('export:png', async (...args) => {
    const [id, pixels] = args;
    if (!isPixels(pixels)) throw new UserError('내보낼 이미지 정보가 올바르지 않습니다.');
    const recent = await projectStore.openRecent(requireId(id));
    const defaultPath = path.join(recent.folder, 'exports', `${recent.name}_cleaned.png`);
    const result = await dialog.showSaveDialog(mainWindow!, { title: '결과 PNG 저장', defaultPath, filters: [{ name: 'PNG 이미지', extensions: ['png'] }] });
    if (result.canceled || !result.filePath) return null;
    return projectStore.exportPNG(recent.id, pixels, result.filePath);
  });
  register('folder:open', async (...args) => {
    const id = requireId(args[0]);
    const requestId = args[1] === undefined ? undefined : requireId(args[1]);
    const folder = await projectStore.folderFor(id, requestId);
    const error = await shell.openPath(folder);
    if (error) throw new UserError('저장 폴더를 열지 못했습니다. 폴더가 이동되었는지 확인해 주세요.');
  });
  register('chatgpt:open', async () => {
    await shell.openExternal(CHATGPT_URL);
  });
  register('ai:detect-text', async (pixels, requestId) => textDetection.detect(pixels as Pixels, requireId(requestId)));
  register('ai:cancel-text', (requestId) => textDetection.cancel(requireId(requestId)));
}

function denyNetworkAndPermissions(): void {
  const defaultSession = session.defaultSession;
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  defaultSession.setPermissionCheckHandler(() => false);
  defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] }, (_details, callback) => callback({ cancel: true }));
}

function createWindow(): void {
  rendererEntry = path.resolve(app.getAppPath(), 'dist', 'renderer', 'index.html');
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1420, workArea.width);
  const height = Math.min(920, workArea.height);
  const window = new BrowserWindow({
    width, height, minWidth: Math.min(860, workArea.width), minHeight: Math.min(540, workArea.height),
    title: 'Sketch Cleaner',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(rendererEntry).href) event.preventDefault();
  });
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.on('closed', () => { textDetection.dispose(); if (mainWindow === window) mainWindow = null; });
  void window.loadFile(rendererEntry);
}

if (squirrelStartup) {
  app.quit();
} else {
  if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.SketchCleanerDesktop.SketchCleaner');

  app.whenReady().then(async () => {
    const root = process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'SketchCleaner', 'projects')
      : path.join(app.getPath('userData'), 'projects');
    projectStore = new ProjectStore({ root });
    textDetection = new TextDetectionService(
      path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), app.isPackaged ? 'models' : 'artifacts/models', 'text-det.onnx'),
      path.join(__dirname, 'ai-worker.js'),
    );
    rendererEntry = path.resolve(app.getAppPath(), 'dist', 'renderer', 'index.html');
    denyNetworkAndPermissions();
    registerHandlers();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
