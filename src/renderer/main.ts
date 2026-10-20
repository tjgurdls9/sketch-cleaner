import './styles.css';
import {
  createHistory, createSnapshot, historySnapshot, redoHistory, undoHistory, viewToImage,
  commitHistory, eraseStroke, fillSelection, marqueeRect, rectPolygon, selectLasso,
} from '../core/engine';
import type { Affine, Brush, Fill, History, PixelJob, Point, Rect, SelectionCombine, ViewTransform } from '../core/engine';
import type {
  Candidate, ExportResult, ImportedImage, Pixels, Project, RecentProject,
  Reply, RequestBundle, RequestInfo, Snapshot,
} from '../shared/types';
import { MAX_FILE_BYTES, MAX_PIXELS } from '../shared/types';
import type { PixelJobRequest, PixelJobResponse } from '../core/worker-protocol';
import { candidateReadiness, fitCandidateTransform } from './state';

type Tool = 'erase' | 'marquee' | 'pen' | 'delete' | 'protect' | 'unselect' | 'restore' | 'lasso' | 'pan' | 'crop' | 'sample';

const BRUSH_TOOLS: readonly Tool[] = ['erase', 'delete', 'protect', 'unselect', 'restore'];
const SELECTION_TOOLS: readonly Tool[] = ['marquee', 'pen', 'lasso'];
const TOOL_KEYS: Readonly<Record<string, Tool>> = { e: 'erase', m: 'marquee', p: 'pen', l: 'lasso' };
const PEN_CLOSE_DISTANCE = 8;
const BRUSH_SIZE_MIN = 2;
const BRUSH_SIZE_MAX = 220;
type Panel = 'edit' | 'request' | 'review' | 'export';
type CompareMode = 'side' | 'overlay';
type AutoCleanStatus = 'idle' | 'running' | 'complete' | 'review' | 'unchanged' | 'cancelled' | 'failed';

interface AppState {
  project: Project | null;
  snapshot: Snapshot | null;
  history: History | null;
  imported: ImportedImage | null;
  tool: Tool;
  panel: Panel;
  lassoMode: 'inside' | 'outside';
  showMasks: boolean;
  compareMode: CompareMode;
  requestBundle: RequestBundle | null;
  requestId: string;
  guide: Pixels | null;
  candidate: Candidate | null;
  candidateScale: number;
  candidateRotation: number;
  candidateX: number;
  candidateY: number;
  alignmentAcknowledged: boolean;
  brushSize: number;
  brushStrength: number;
  brushSoftness: number;
  sampledColor: [number, number, number] | null;
  sampledPoint: Point | null;
  brightness: number;
  contrast: number;
  adjustmentPreview: Snapshot | null;
  cropRect: Rect | null;
  fineRotation: number;
  view: ViewTransform;
  dirty: boolean;
  saveFailed: boolean;
  exportResult: ExportResult | null;
  autoCleanStatus: AutoCleanStatus;
}

const state: AppState = {
  project: null, snapshot: null, history: null, imported: null,
  tool: 'delete', panel: 'edit', lassoMode: 'inside', showMasks: true,
  compareMode: 'side', requestBundle: null, requestId: '', guide: null,
  candidate: null, candidateScale: 1, candidateRotation: 0,
  candidateX: 0, candidateY: 0, alignmentAcknowledged: false,
  brushSize: 32, brushStrength: 100, brushSoftness: 25,
  sampledColor: null, sampledPoint: null, brightness: 0, contrast: 0,
  adjustmentPreview: null, cropRect: null, fineRotation: 0,
  view: { zoom: 1, panX: 0, panY: 0 }, dirty: false,
  saveFailed: false, exportResult: null, autoCleanStatus: 'idle',
};

const $ = <T extends Element = HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`화면 요소를 찾을 수 없습니다: ${selector}`);
  return element;
};
const sceneCanvas = $('#sceneCanvas') as HTMLCanvasElement;
const overlayCanvas = $('#overlayCanvas') as HTMLCanvasElement;
const stage = $('#stage');
const inspector = $('#inspectorContent');
const liveMessage = $('#liveMessage');
const errorBanner = $('#errorBanner');
let saveTimer = 0;
let saveAsInProgress = false;
let editRevision = 0;
let projectEpoch = 0;
let savePump: Promise<void> | null = null;
let pendingSave: { projectId: string; revision: number; snapshot: Snapshot } | null = null;
let worker: Worker | null = null;
let cancelCurrentWorker: (() => void) | null = null;
let jobId = 0;
let blockedControls: Array<{ element: HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement; wasDisabled: boolean }> = [];
let requestLoadRevision = 0;
let openProjectRevision = 0;
let draftPoints: Point[] = [];
let draftKind: 'brush' | 'lasso' | 'crop' | 'marquee' | 'pen' | null = null;
let gesture: 'draw' | 'lasso' | 'crop' | 'marquee' | 'pan' | 'candidate' | null = null;
let penHover: Point | null = null;
let marqueeModifiers = { square: false, fromCenter: false };
/** Photoshop: Shift or Alt held when a selection starts adds or subtracts. */
let selectionCombine: SelectionCombine = 'replace';
/** A key that started an add/subtract only squares or centers the marquee after being pressed again. */
let marqueeHeld = { shift: false, alt: false };
let lastGesturePoint: Point | null = null;
let gestureStart: Point | null = null;
let gestureViewStart: { x: number; y: number; panX: number; panY: number } | null = null;
let spaceDown = false;
let resizeFrame = 0;

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

function desktop() {
  if (!window.desktop) throw new Error('데스크톱 파일 연결을 사용할 수 없습니다. 앱을 다시 실행해 주세요.');
  return window.desktop;
}

function value<T>(reply: Reply<T>, context: string): T {
  if (!reply.ok) throw new Error(`${context} ${reply.error}`.trim());
  return reply.value;
}

function announce(message: string): void {
  liveMessage.textContent = message;
}

function showError(message: string, saveError = false): void {
  $('#errorText').textContent = message;
  $('#retrySaveButton').toggleAttribute('hidden', !saveError);
  errorBanner.removeAttribute('hidden');
  announce(message);
}

function clearError(): void {
  errorBanner.setAttribute('hidden', '');
  $('#retrySaveButton').setAttribute('hidden', '');
}

function displaySnapshot(): Snapshot | null { return state.adjustmentPreview ?? state.snapshot; }
function currentPixels(): Pixels | null { return displaySnapshot()?.working ?? null; }
function activeRequest(): RequestInfo | null {
  return state.project?.requests.find(request => request.id === state.requestId) ?? null;
}

function setSaveStatus(status: 'clean' | 'dirty' | 'saving' | 'saved' | 'error'): void {
  const node = $('.save-state');
  const labels = {
    clean: '사진을 열어 시작하세요', dirty: '저장할 변경사항이 있습니다',
    saving: '자동 저장 중…', saved: '모든 변경사항 저장됨', error: '저장 실패',
  };
  node.className = `save-state ${status === 'saved' || status === 'clean' ? 'saved' : status === 'saving' || status === 'dirty' ? 'saving' : 'error'}`;
  node.querySelector('span')!.textContent = labels[status];
}

function renderHeader(): void {
  $('#projectName').textContent = state.project?.name ?? '새 작업';
  if (!state.project) setSaveStatus('clean');
  else if (state.saveFailed) setSaveStatus('error');
  else if (state.dirty) setSaveStatus(savePump ? 'saving' : 'dirty');
  else setSaveStatus('saved');
  $('#saveProjectButton').toggleAttribute('disabled', !state.project);
  $('#undoButton').toggleAttribute('disabled', !state.history?.past.length);
  $('#redoButton').toggleAttribute('disabled', !state.history?.future.length);
}

function scheduleAutosave(): void {
  if (!state.project || !state.snapshot) return;
  window.clearTimeout(saveTimer);
  if (saveAsInProgress) {
    renderHeader();
    return;
  }
  saveTimer = window.setTimeout(() => { void requestSave(); }, 1200);
  renderHeader();
}

function markCommitted(next: Snapshot): void {
  if (state.snapshot
    && next.baseVersion === state.snapshot.baseVersion
    && next.workVersion === state.snapshot.workVersion
    && next.working.width === state.snapshot.working.width
    && next.working.height === state.snapshot.working.height) {
    state.adjustmentPreview = null;
    renderCanvas();
    renderInspector();
    return;
  }
  const wasTruncated = Boolean(state.history?.truncated);
  if (!state.history) state.history = createHistory(next);
  else state.history = commitHistory(state.history, next);
  state.snapshot = historySnapshot(state.history);
  if (state.project) state.project = { ...state.project, snapshot: state.snapshot };
  state.adjustmentPreview = null;
  state.dirty = true;
  state.saveFailed = false;
  state.exportResult = null;
  editRevision += 1;
  renderCanvas();
  renderInspector();
  refreshEditSummary();
  if (!wasTruncated && state.history.truncated) announce('이미지 크기로 인해 오래된 실행 취소 기록 일부를 정리했습니다. 바로 이전 상태는 유지됩니다.');
  scheduleAutosave();
}

interface EditToken {
  projectId: string | null;
  projectEpoch: number;
  revision: number;
  snapshot: Snapshot;
}

function captureEditToken(snapshot: Snapshot): EditToken {
  return { projectId: state.project?.id ?? null, projectEpoch, revision: editRevision, snapshot };
}

function isEditTokenCurrent(token: EditToken): boolean {
  return state.project?.id === token.projectId
    && projectEpoch === token.projectEpoch
    && editRevision === token.revision
    && state.snapshot === token.snapshot;
}

function preserveBasisPixels(next: Snapshot, source: Snapshot): Snapshot {
  if (next.baseVersion !== source.baseVersion
    || next.base.width !== source.base.width
    || next.base.height !== source.base.height) return next;
  return { ...next, base: source.base };
}

function commitWorkerSnapshot(next: Snapshot, token: EditToken): boolean {
  if (!isEditTokenCurrent(token)) {
    announce('작업 상태가 바뀌어 늦게 끝난 처리 결과는 적용하지 않았습니다.');
    return false;
  }
  markCommitted(preserveBasisPixels(next, token.snapshot));
  return true;
}

async function requestSave(): Promise<void> {
  if (saveAsInProgress) return;
  const snapshot = state.snapshot;
  const project = state.project;
  if (!snapshot || !project) return;
  window.clearTimeout(saveTimer);
  pendingSave = { projectId: project.id, revision: editRevision, snapshot };
  if (savePump) return savePump;
  savePump = (async () => {
    try {
      while (pendingSave) {
        const item: { projectId: string; revision: number; snapshot: Snapshot } = pendingSave;
        pendingSave = null;
        if (item.projectId !== project.id) {
          pendingSave = item;
          break;
        }
        setSaveStatus('saving');
        const saved = value(await desktop().saveProject(project.id, item.snapshot), '프로젝트를 저장하지 못했습니다.');
        if (state.project?.id !== project.id) continue;
        state.project = { ...state.project, folder: saved.folder };
        if (item.revision !== editRevision && state.snapshot) {
          pendingSave = { projectId: project.id, revision: editRevision, snapshot: state.snapshot };
          continue;
        }
        state.dirty = false;
        state.saveFailed = false;
      }
      clearError();
    } catch (error) {
      pendingSave = null;
      if (state.project?.id === project.id) {
        state.dirty = true;
        state.saveFailed = true;
        showError(error instanceof Error ? error.message : '저장하지 못했습니다. 저장 위치를 확인하고 다시 시도해 주세요.', true);
      }
    } finally {
      savePump = null;
      renderHeader();
      if (pendingSave && state.project?.id === pendingSave.projectId) void requestSave();
      else if (pendingSave && state.project?.id !== pendingSave.projectId) pendingSave = null;
    }
  })();
  renderHeader();
  return savePump;
}

async function saveProjectNow(): Promise<void> {
  if (!state.project || !state.snapshot || saveAsInProgress) return;
  window.clearTimeout(saveTimer);
  await requestSave();
  if (!state.saveFailed) announce('프로젝트를 저장했습니다.');
}

function commitFromEngine(next: Snapshot): void {
  markCommitted(next);
}

function setProject(project: Project): void {
  window.clearTimeout(saveTimer);
  pendingSave = null;
  openProjectRevision += 1;
  projectEpoch += 1;
  requestLoadRevision += 1;
  state.project = project;
  state.snapshot = project.snapshot;
  state.history = createHistory(project.snapshot);
  state.panel = 'edit';
  state.tool = 'delete';
  state.showMasks = false;
  state.autoCleanStatus = 'idle';
  state.compareMode = 'side';
  state.candidateScale = 1;
  state.candidateRotation = 0;
  state.candidateX = 0;
  state.candidateY = 0;
  selectPanelTab('edit');
  setTool('delete');
  state.showMasks = false;
  state.imported = null;
  state.requestBundle = null;
  state.requestId = project.requests.at(-1)?.id ?? '';
  state.guide = null;
  state.candidate = null;
  state.alignmentAcknowledged = false;
  state.adjustmentPreview = null;
  state.cropRect = null;
  state.dirty = false;
  state.saveFailed = false;
  state.exportResult = null;
  syncMaskToggle();
  editRevision = 0;
  fitView();
  renderHeader();
  renderCanvas();
  renderInspector();
  refreshEditSummary();
  const recoveryBadge = $('#recoveryBadge');
  if (project.recovered) {
    recoveryBadge.removeAttribute('hidden');
    recoveryBadge.setAttribute('title', '마지막 정상 작업을 열었습니다. 일부 파일을 확인해 주세요.');
    recoveryBadge.setAttribute('aria-label', '마지막 정상 작업을 열었습니다. 일부 파일을 확인해 주세요.');
    announce('마지막 정상 작업을 열었습니다. 일부 파일을 확인해 주세요.');
  } else {
    recoveryBadge.setAttribute('hidden', '');
    recoveryBadge.removeAttribute('title');
    recoveryBadge.removeAttribute('aria-label');
    announce(`${project.name} 작업을 열었습니다.`);
  }
}

async function confirmReplace(): Promise<boolean> {
  while (true) {
    if (!state.dirty && !pendingSave && !savePump && !state.saveFailed && !document.body.classList.contains('is-processing')) return true;
    const projectId = state.project?.id ?? null;
    const snapshot = state.snapshot;
    const revision = editRevision;
    const epoch = projectEpoch;
    if (!window.confirm('저장되지 않은 변경사항이나 진행 중인 처리가 있습니다. 현재 작업을 닫고 새 작업을 여시겠어요? 마지막 정상 저장본은 보존됩니다.')) return false;
    window.clearTimeout(saveTimer);
    if (cancelCurrentWorker) cancelWorker();
    if (savePump) await savePump;
    if (state.project?.id !== projectId || state.snapshot !== snapshot || editRevision !== revision || projectEpoch !== epoch) continue;
    pendingSave = null;
    return true;
  }
}

function safeTextError(error: unknown, fallback: string): string {
  if (!(error instanceof Error) || !error.message) return fallback;
  return /[가-힣]/.test(error.message) ? error.message : `${fallback} (${error.message})`;
}

function setProcessing(label: string, percent = 0, indeterminate = false): void {
  if (!document.body.classList.contains('is-processing')) {
    blockedControls = Array.from(document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>(
      '.tool-rail button, .tool-rail input, .inspector button, .inspector input, .inspector textarea, .top-actions button, .project-menu button, .canvas-toolbar button, .canvas-footer button',
    )).filter(element => element.id !== 'cancelJobButton').map(element => {
      const saved = { element, wasDisabled: element.disabled };
      element.disabled = true;
      return saved;
    });
    document.body.classList.add('is-processing');
  }
  $('#processingLabel').textContent = label;
  $('#progressText').textContent = indeterminate ? '로컬 분석' : percent > 0 ? `${Math.round(percent)}%` : '준비 중';
  const progress = $('#progressBar') as HTMLProgressElement;
  if (indeterminate) progress.removeAttribute('value');
  else progress.value = Math.max(4, Math.min(100, percent));
  $('#processingOverlay').removeAttribute('hidden');
}

function clearProcessing(): void {
  for (const control of blockedControls) control.element.disabled = control.wasDisabled;
  blockedControls = [];
  document.body.classList.remove('is-processing');
  $('#processingOverlay').setAttribute('hidden', '');
}

function cancelWorker(): void { cancelCurrentWorker?.(); }

function runPixelJob(job: PixelJob, label: string): Promise<Snapshot | Pixels> {
  cancelWorker();
  const id = String(++jobId);
  const nextWorker = new Worker(new URL('../core/pixel-worker.ts', import.meta.url), { type: 'module' });
  worker = nextWorker;
  setProcessing(label);
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (worker === nextWorker) worker = null;
      if (cancelCurrentWorker === cancel) cancelCurrentWorker = null;
      nextWorker.terminate();
      clearProcessing();
    };
    const cancel = (): void => {
      finish();
      reject(new DOMException('이미지 처리를 취소했습니다.', 'AbortError'));
    };
    cancelCurrentWorker = cancel;
    nextWorker.onmessage = (event: MessageEvent<PixelJobResponse>): void => {
      if (finished) return;
      const response = event.data;
      if (response.id !== id) return;
      if (response.type === 'progress') {
        const percent = response.total > 0 ? response.completed / response.total * 100 : 0;
        setProcessing(label, percent);
      } else if (response.type === 'result') {
        finish();
        resolve(response.value);
      } else {
        finish();
        reject(new Error(response.error));
      }
    };
    nextWorker.onerror = (event: ErrorEvent): void => {
      if (finished) return;
      finish();
      reject(new Error(event.message || '이미지를 처리하지 못했습니다.'));
    };
    try {
      nextWorker.postMessage({ id, job } satisfies PixelJobRequest);
    } catch (error) {
      finish();
      reject(error instanceof Error ? error : new Error('이미지 처리 요청을 전달하지 못했습니다.'));
    }
  });
}

function fitView(): void {
  const snapshot = displaySnapshot();
  if (!snapshot) return;
  const bounds = stage.getBoundingClientRect();
  const inset = 44;
  const candidate = state.panel === 'review' && state.compareMode === 'side' ? state.candidate?.pixels : null;
  const availableWidth = candidate ? (bounds.width / 2) - inset : bounds.width - inset * 2;
  const zoom = Math.min(
    1,
    (availableWidth - inset) / snapshot.working.width,
    (bounds.height - inset * 2) / snapshot.working.height,
    ...(candidate ? [(availableWidth - inset) / candidate.width, (bounds.height - inset * 2) / candidate.height] : []),
  );
  state.view = {
    zoom: Math.max(0.03, zoom),
    panX: candidate ? 0 : (bounds.width - snapshot.working.width * Math.max(0.03, zoom)) / 2,
    panY: candidate ? 0 : (bounds.height - snapshot.working.height * Math.max(0.03, zoom)) / 2,
  };
  renderCanvas();
}

function zoomAt(nextZoom: number, point?: Point): void {
  const snapshot = displaySnapshot();
  if (!snapshot) return;
  const bounds = stage.getBoundingClientRect();
  const anchor = point ?? { x: bounds.width / 2, y: bounds.height / 2 };
  const zoom = Math.min(8, Math.max(0.03, nextZoom));
  if (state.panel === 'review' && state.compareMode === 'side' && state.candidate) {
    const baseSlot = anchor.x < bounds.width / 2;
    const source = baseSlot ? state.snapshot!.base : state.candidate.pixels;
    const slotWidth = bounds.width / 2;
    const slotX = baseSlot ? 0 : slotWidth;
    const oldLeft = slotX + (slotWidth - source.width * state.view.zoom) / 2 + state.view.panX;
    const oldTop = (bounds.height - source.height * state.view.zoom) / 2 + state.view.panY;
    const imageX = (anchor.x - oldLeft) / state.view.zoom;
    const imageY = (anchor.y - oldTop) / state.view.zoom;
    state.view = {
      zoom,
      panX: anchor.x - slotX - (slotWidth - source.width * zoom) / 2 - imageX * zoom,
      panY: anchor.y - (bounds.height - source.height * zoom) / 2 - imageY * zoom,
    };
  } else {
    const image = viewToImage(anchor, state.view);
    state.view = { zoom, panX: anchor.x - image.x * zoom, panY: anchor.y - image.y * zoom };
  }
  renderCanvas();
  $('#zoomReadout').textContent = `${Math.round(zoom * 100)}%`;
}

function fitPixels(canvas: HTMLCanvasElement, pixels: Pixels | null, masks?: Snapshot | null): void {
  const width = 260;
  const height = 150;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return;
  context.fillStyle = '#edf1ef';
  context.fillRect(0, 0, width, height);
  if (!pixels) return;
  const scale = Math.min((width - 12) / pixels.width, (height - 12) / pixels.height);
  const drawWidth = Math.max(1, Math.round(pixels.width * scale));
  const drawHeight = Math.max(1, Math.round(pixels.height * scale));
  const offsetX = Math.floor((width - drawWidth) / 2);
  const offsetY = Math.floor((height - drawHeight) / 2);
  const image = context.createImageData(drawWidth, drawHeight);
  for (let y = 0; y < drawHeight; y += 1) {
    const iy = Math.min(pixels.height - 1, Math.floor(y / scale));
    for (let x = 0; x < drawWidth; x += 1) {
      const ix = Math.min(pixels.width - 1, Math.floor(x / scale));
      const source = (iy * pixels.width + ix) * 4;
      const target = (y * drawWidth + x) * 4;
      const alpha = pixels.data[source + 3] / 255;
      image.data[target] = Math.round(pixels.data[source] * alpha + 255 * (1 - alpha));
      image.data[target + 1] = Math.round(pixels.data[source + 1] * alpha + 255 * (1 - alpha));
      image.data[target + 2] = Math.round(pixels.data[source + 2] * alpha + 255 * (1 - alpha));
      image.data[target + 3] = 255;
      if (masks) {
        const maskIndex = iy * masks.working.width + ix;
        const protect = masks.protectMask[maskIndex] / 255;
        const remove = masks.deleteMask[maskIndex] / 255;
        const alpha = Math.max(protect, remove) * 0.34;
        if (protect > 0 || remove > 0) {
          const color = protect > 0 ? [74, 123, 154] : [202, 87, 73];
          image.data[target] = image.data[target] * (1 - alpha) + color[0] * alpha;
          image.data[target + 1] = image.data[target + 1] * (1 - alpha) + color[1] * alpha;
          image.data[target + 2] = image.data[target + 2] * (1 - alpha) + color[2] * alpha;
        }
      }
    }
  }
  context.putImageData(image, offsetX, offsetY);
}

function sample(pixels: Pixels, x: number, y: number): [number, number, number, number] | null {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= pixels.width || iy >= pixels.height) return null;
  const offset = (iy * pixels.width + ix) * 4;
  return [pixels.data[offset], pixels.data[offset + 1], pixels.data[offset + 2], pixels.data[offset + 3]];
}

function candidateTransform(): Affine {
  const base = state.snapshot!.base;
  const candidate = state.candidate!.pixels;
  return fitCandidateTransform(
    base.width, base.height, candidate.width, candidate.height,
    state.candidateScale, state.candidateRotation, state.candidateX, state.candidateY,
  );
}

function renderCanvas(): void {
  const bounds = stage.getBoundingClientRect();
  const cssWidth = Math.max(1, Math.floor(bounds.width));
  const cssHeight = Math.max(1, Math.floor(bounds.height));
  const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.floor(cssWidth * pixelRatio));
  const height = Math.max(1, Math.floor(cssHeight * pixelRatio));
  if (sceneCanvas.width !== width || sceneCanvas.height !== height) {
    sceneCanvas.width = width;
    sceneCanvas.height = height;
    overlayCanvas.width = width;
    overlayCanvas.height = height;
  }
  const context = sceneCanvas.getContext('2d', { alpha: false });
  const overlayContext = overlayCanvas.getContext('2d');
  if (!context || !overlayContext) return;
  const image = context.createImageData(width, height);
  const base = state.panel === 'review' && state.candidate && state.snapshot
    ? state.snapshot.base
    : currentPixels();
  const snapshot = displaySnapshot();
  const review = state.panel === 'review' && state.candidate && snapshot;
  const transform = review && state.compareMode === 'overlay' ? candidateTransform() : null;
  const determinant = transform ? transform.a * transform.d - transform.b * transform.c : 1;
  const halfWidth = cssWidth / 2;
  const sideBySide = Boolean(review && state.compareMode === 'side');
  const zoom = state.view.zoom;
  const sideLeft = (source: Pixels, slotX: number): number => slotX + (halfWidth - source.width * zoom) / 2 + state.view.panX;
  const sideTop = (source: Pixels): number => (cssHeight - source.height * zoom) / 2 + state.view.panY;
  const baseLeft = sideBySide ? sideLeft(snapshot!.base, 0) : 0;
  const candidate = review ? state.candidate!.pixels : null;
  const candidateLeft = sideBySide && candidate ? sideLeft(candidate, halfWidth) : 0;
  const baseTop = sideBySide ? sideTop(snapshot!.base) : 0;
  const candidateTop = sideBySide && candidate ? sideTop(candidate) : 0;
  const overlayReady = Boolean(review && transform && Number.isFinite(determinant) && Math.abs(determinant) > 1e-8);
  for (let py = 0; py < height; py += 1) {
    const screenY = (py + 0.5) / pixelRatio;
    const imageY = sideBySide ? (screenY - baseTop) / zoom : (screenY - state.view.panY) / zoom;
    const iy = Math.floor(imageY);
    for (let px = 0; px < width; px += 1) {
      const target = (py * width + px) * 4;
      if (!base || !snapshot) {
        image.data[target] = 235; image.data[target + 1] = 239; image.data[target + 2] = 237; image.data[target + 3] = 255;
        continue;
      }
      const screenX = (px + 0.5) / pixelRatio;
      const onBase = sideBySide && screenX < halfWidth;
      const source = sideBySide ? (onBase ? snapshot.base : candidate!) : base;
      const sourceY = sideBySide ? (screenY - (onBase ? baseTop : candidateTop)) / zoom : imageY;
      const imageX = sideBySide
        ? (screenX - (onBase ? baseLeft : candidateLeft)) / zoom
        : (screenX - state.view.panX) / zoom;
      const ix = Math.floor(imageX);
      const sourceYIndex = Math.floor(sourceY);
      const inSource = ix >= 0 && sourceYIndex >= 0 && ix < source.width && sourceYIndex < source.height;
      const sourceOffset = inSource ? (sourceYIndex * source.width + ix) * 4 : -1;
      let red = inSource ? source.data[sourceOffset] : 234;
      let green = inSource ? source.data[sourceOffset + 1] : 238;
      let blue = inSource ? source.data[sourceOffset + 2] : 236;
      let alpha = inSource ? source.data[sourceOffset + 3] / 255 : 1;
      if (overlayReady && !sideBySide && transform && candidate) {
        const dx = imageX - transform.e;
        const dy = imageY - transform.f;
        const candidateX = (transform.d * dx - transform.c * dy) / determinant;
        const candidateY = (transform.a * dy - transform.b * dx) / determinant;
        const cx = Math.floor(candidateX);
        const cy = Math.floor(candidateY);
        if (cx >= 0 && cy >= 0 && cx < candidate.width && cy < candidate.height) {
          const candidateOffset = (cy * candidate.width + cx) * 4;
          const baseAlpha = alpha;
          const candidateAlpha = candidate.data[candidateOffset + 3] / 255;
          red = Math.round((red * baseAlpha + 255 * (1 - baseAlpha)) * 0.5 + (candidate.data[candidateOffset] * candidateAlpha + 255 * (1 - candidateAlpha)) * 0.5);
          green = Math.round((green * baseAlpha + 255 * (1 - baseAlpha)) * 0.5 + (candidate.data[candidateOffset + 1] * candidateAlpha + 255 * (1 - candidateAlpha)) * 0.5);
          blue = Math.round((blue * baseAlpha + 255 * (1 - baseAlpha)) * 0.5 + (candidate.data[candidateOffset + 2] * candidateAlpha + 255 * (1 - candidateAlpha)) * 0.5);
          alpha = 1;
        }
      }
      image.data[target] = Math.round(red * alpha + 255 * (1 - alpha));
      image.data[target + 1] = Math.round(green * alpha + 255 * (1 - alpha));
      image.data[target + 2] = Math.round(blue * alpha + 255 * (1 - alpha));
      image.data[target + 3] = 255;
      const drawMask = !sideBySide || onBase;
      if (state.showMasks && snapshot && drawMask) {
        if (imageX >= 0 && imageY >= 0 && imageX < snapshot.working.width && imageY < snapshot.working.height) {
          const maskIndex = (iy * snapshot.working.width) + ix;
          const protect = snapshot.protectMask[maskIndex] / 255;
          const remove = snapshot.deleteMask[maskIndex] / 255;
          const weight = Math.max(protect, remove) * 0.36;
          if (weight > 0) {
            const overlayRed = protect > 0 ? 67 : 200;
            const overlayGreen = protect > 0 ? 122 : 83;
            const overlayBlue = protect > 0 ? 157 : 69;
            image.data[target] = Math.round(image.data[target] * (1 - weight) + overlayRed * weight);
            image.data[target + 1] = Math.round(image.data[target + 1] * (1 - weight) + overlayGreen * weight);
            image.data[target + 2] = Math.round(image.data[target + 2] * (1 - weight) + overlayBlue * weight);
          }
        }
      }
    }
  }
  context.putImageData(image, 0, 0);
  renderDraft(overlayContext, pixelRatio);
  $('#emptyState').toggleAttribute('hidden', Boolean(state.snapshot));
  $('#canvasTitle').textContent = state.panel === 'review' && state.candidate
    ? `작업 기준 / 후보${state.compareMode === 'overlay' ? ' · 겹쳐 보기' : ' · 나란히'}`
    : state.project?.name ?? state.imported?.name ?? '사진을 열어 시작하세요';
  $('#imageDimensions').textContent = state.snapshot ? `${state.snapshot.working.width.toLocaleString()} × ${state.snapshot.working.height.toLocaleString()} px` : '';
  $('#zoomReadout').textContent = state.snapshot ? `${Math.round(state.view.zoom * 100)}%` : '맞춤';
  stage.dataset.tool = state.tool;
  stage.setAttribute('aria-label', state.panel === 'review' && state.candidate
    ? state.compareMode === 'side'
      ? '결과 비교 캔버스. 왼쪽은 작업 기준, 오른쪽은 후보입니다. 확대하거나 이동해 차이를 확인할 수 있습니다.'
      : '결과 비교 캔버스. 작업 기준 위에 후보를 겹쳐 표시합니다. 후보는 드래그해 정렬할 수 있습니다.'
    : '이미지 작업 캔버스. 마우스 휠로 확대하거나 스페이스바를 누른 채 이동할 수 있습니다.');
  const compareLabels = $('#compareLabels');
  if (state.panel === 'review' && state.candidate) {
    compareLabels.removeAttribute('hidden');
    compareLabels.classList.toggle('overlay', state.compareMode === 'overlay');
    compareLabels.innerHTML = state.compareMode === 'side'
      ? '<span>작업 기준</span><span>후보</span>'
      : '<span>작업 기준 / 후보</span>';
  } else {
    compareLabels.setAttribute('hidden', '');
  }
}

function renderDraft(context: CanvasRenderingContext2D, pixelRatio: number): void {
  context.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  if (!draftPoints.length || !state.snapshot) return;
  const sideReview = state.panel === 'review' && state.compareMode === 'side';
  if (sideReview) return;
  const { zoom, panX, panY } = state.view;
  context.save();
  context.setTransform(pixelRatio * zoom, 0, 0, pixelRatio * zoom, pixelRatio * panX, pixelRatio * panY);
  if (draftKind === 'brush') {
    const paper = state.sampledPoint && state.sampledColor ? `rgb(${state.sampledColor.join(', ')})` : '#ffffff';
    const color = state.tool === 'erase' ? paper : state.tool === 'protect' ? '#477fa2' : state.tool === 'restore' ? '#688178' : '#cc6254';
    context.strokeStyle = color;
    context.fillStyle = color;
    // The eraser preview is the result itself, so it is drawn at the stroke's real strength.
    context.globalAlpha = state.tool === 'erase' ? state.brushStrength / 100 : Math.max(0.18, state.brushStrength / 100 * 0.45);
    context.lineWidth = Math.max(1 / zoom, state.brushSize * 2);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(draftPoints[0].x, draftPoints[0].y);
    for (const point of draftPoints.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
    if (draftPoints.length === 1) {
      context.beginPath();
      context.arc(draftPoints[0].x, draftPoints[0].y, state.brushSize, 0, Math.PI * 2);
      context.fill();
    }
  } else if (draftKind === 'lasso') {
    context.strokeStyle = '#31566b';
    context.fillStyle = 'rgb(65 103 119 / 11%)';
    context.lineWidth = 1.5 / zoom;
    context.setLineDash([5 / zoom, 3 / zoom]);
    context.beginPath();
    context.moveTo(draftPoints[0].x, draftPoints[0].y);
    for (const point of draftPoints.slice(1)) context.lineTo(point.x, point.y);
    context.closePath();
    context.fill();
    context.stroke();
  } else if (draftKind === 'marquee' && draftPoints.length > 1) {
    const { x, y, width, height } = marqueeRect(draftPoints[0], draftPoints.at(-1)!, marqueeModifiers);
    context.fillStyle = 'rgb(204 98 84 / 14%)';
    context.fillRect(x, y, width, height);
    context.strokeStyle = '#31566b';
    context.lineWidth = 1.5 / zoom;
    context.setLineDash([5 / zoom, 3 / zoom]);
    context.strokeRect(x, y, width, height);
  } else if (draftKind === 'pen') {
    context.strokeStyle = '#31566b';
    context.fillStyle = '#ffffff';
    context.lineWidth = 1.5 / zoom;
    context.beginPath();
    context.moveTo(draftPoints[0].x, draftPoints[0].y);
    for (const point of draftPoints.slice(1)) context.lineTo(point.x, point.y);
    if (penHover) context.lineTo(penHover.x, penHover.y);
    context.stroke();
    const handle = 6 / zoom;
    for (const point of draftPoints) {
      context.fillRect(point.x - handle / 2, point.y - handle / 2, handle, handle);
      context.strokeRect(point.x - handle / 2, point.y - handle / 2, handle, handle);
    }
  } else if (draftKind === 'crop' && draftPoints.length > 1) {
    const [start, end] = [draftPoints[0], draftPoints.at(-1)!];
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const right = Math.max(start.x, end.x);
    const bottom = Math.max(start.y, end.y);
    context.fillStyle = 'rgb(25 42 49 / 35%)';
    context.fillRect(0, 0, state.snapshot.working.width, Math.max(0, top));
    context.fillRect(0, top, Math.max(0, left), Math.max(0, bottom - top));
    context.fillRect(right, top, Math.max(0, state.snapshot.working.width - right), Math.max(0, bottom - top));
    context.fillRect(0, bottom, state.snapshot.working.width, Math.max(0, state.snapshot.working.height - bottom));
    context.strokeStyle = '#31566b';
    context.lineWidth = 1.5 / zoom;
    context.setLineDash([5 / zoom, 3 / zoom]);
    context.strokeRect(left, top, right - left, bottom - top);
  }
  context.restore();
}

function refreshEditSummary(): void {
  $('#selectionSummary').textContent = state.snapshot ? '빨강 삭제 · 파랑 보호' : '삭제 범위 0 · 보호 범위 0';
}

function localPoint(event: PointerEvent): Point {
  const bounds = stage.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function imagePoint(screen: Point): Point {
  const snapshot = state.snapshot;
  if (!snapshot) return { x: 0, y: 0 };
  const point = viewToImage(screen, state.view);
  return {
    x: Math.max(0, Math.min(snapshot.working.width - 1, point.x)),
    y: Math.max(0, Math.min(snapshot.working.height - 1, point.y)),
  };
}

function brush(): Brush {
  return { radius: state.brushSize, strength: state.brushStrength / 100, hardness: 1 - state.brushSoftness / 100 };
}

function endDraft(): void {
  draftKind = null;
  draftPoints = [];
  penHover = null;
  if (overlayCanvas.width) overlayCanvas.getContext('2d')?.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
}

function sampleBackground(point: Point): void {
  const pixels = state.snapshot?.working;
  if (!pixels) return;
  const color = sample(pixels, point.x, point.y);
  if (!color) return;
  state.sampledColor = [color[0], color[1], color[2]];
  state.sampledPoint = point;
  const swatch = inspector.querySelector<HTMLCanvasElement>('#sampledColorSwatch');
  const text = inspector.querySelector<HTMLElement>('#sampledColorText');
  if (swatch) paintColorSwatch(swatch, [color[0], color[1], color[2]]);
  if (text) text.textContent = `RGB ${color[0]}, ${color[1]}, ${color[2]}`;
  setTool(toolBeforeSample);
  announce('배경색을 선택했습니다. 삭제 범위를 선택한 뒤 채우기를 실행하세요.');
}

function paintColorSwatch(canvas: HTMLCanvasElement, color: [number, number, number]): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  context.fillStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
}

function eraserFill(): Fill {
  return state.sampledPoint ? { kind: 'sample', point: state.sampledPoint } : { kind: 'white' };
}

/** Photoshop-style edits run on the main thread: a worker would clone the whole snapshot both ways. */
function applyNow(edit: (snapshot: Snapshot) => Snapshot, failure: string): void {
  const snapshot = state.snapshot;
  if (!snapshot || document.body.classList.contains('is-processing')) return;
  try {
    commitFromEngine(edit(snapshot));
  } catch (error) {
    showError(safeTextError(error, failure));
  }
}

function finishMarquee(): void {
  const [start, end] = [draftPoints[0], draftPoints.at(-1)];
  endDraft();
  if (!start || !end) return;
  const rect = marqueeRect(start, end, marqueeModifiers);
  // A plain click without a drag deselects; a Shift or Alt click keeps the selection, as in Photoshop.
  if (rect.width < 1 || rect.height < 1) { if (selectionCombine === 'replace') deselect(); return; }
  const combine = selectionCombine;
  applyNow(snapshot => selectLasso(snapshot, rectPolygon(rect), 'inside', combine), '사각 선택을 만들지 못했습니다.');
}

function finishPen(): void {
  const polygon = draftPoints;
  endDraft();
  if (polygon.length < 3) { renderCanvas(); return; }
  const combine = selectionCombine;
  applyNow(snapshot => selectLasso(snapshot, polygon, 'inside', combine), '펜 선택을 만들지 못했습니다.');
}

function combineFor(event: MouseEvent): SelectionCombine {
  return event.shiftKey ? 'add' : event.altKey ? 'subtract' : 'replace';
}

function trackMarqueeModifiers(event: MouseEvent): void {
  marqueeHeld = { shift: marqueeHeld.shift && event.shiftKey, alt: marqueeHeld.alt && event.altKey };
  marqueeModifiers = { square: event.shiftKey && !marqueeHeld.shift, fromCenter: event.altKey && !marqueeHeld.alt };
}

function addPenPoint(point: Point, event: MouseEvent): void {
  const first = draftPoints[0];
  if (draftKind === 'pen' && first && draftPoints.length >= 3
    && Math.hypot(point.x - first.x, point.y - first.y) * state.view.zoom <= PEN_CLOSE_DISTANCE) {
    finishPen();
    return;
  }
  if (draftKind !== 'pen') { draftKind = 'pen'; draftPoints = []; selectionCombine = combineFor(event); }
  draftPoints = [...draftPoints, point];
}

function deselect(): void {
  applyNow(snapshot => {
    const { width, height } = snapshot.working;
    return selectLasso(snapshot, rectPolygon({ x: 0, y: 0, width, height }), 'outside');
  }, '선택을 해제하지 못했습니다.');
}

function deleteSelection(): void {
  if (state.panel !== 'edit') return;
  applyNow(snapshot => fillSelection(snapshot, { kind: 'white' }), '선택 영역을 지우지 못했습니다.');
}

function stepBrushSize(direction: 1 | -1): void {
  const size = state.brushSize;
  const step = size <= 10 ? 1 : size <= 50 ? 5 : 10;
  const input = $('#brushSize') as HTMLInputElement;
  input.value = String(Math.max(BRUSH_SIZE_MIN, Math.min(BRUSH_SIZE_MAX, size + direction * step)));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Returns true when the key was a pen-path key and has been handled. */
function penKey(key: string): boolean {
  if (draftKind !== 'pen') return false;
  if (key === 'enter') finishPen();
  else if (key === 'escape') { endDraft(); renderCanvas(); }
  else if (key === 'backspace') {
    draftPoints = draftPoints.slice(0, -1);
    if (!draftPoints.length) endDraft();
    renderDraft(overlayCanvas.getContext('2d')!, Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
  } else if (key === 'delete') { /* Photoshop ignores Delete while a path is open. */ }
  else return false;
  return true;
}

function finishLasso(): void {
  const polygon = draftPoints;
  endDraft();
  if (polygon.length < 3) { renderCanvas(); return; }
  const combine = selectionCombine;
  applyNow(snapshot => selectLasso(snapshot, polygon, state.lassoMode, combine), '올가미 선택을 만들지 못했습니다.');
}

async function finishStroke(snapshot: Snapshot, points: Point[], tool: Tool): Promise<void> {
  if (state.snapshot !== snapshot) return;
  const token = captureEditToken(snapshot);
  try {
    const job: PixelJob = tool === 'restore'
      ? { type: 'restore', snapshot, points, brush: brush() }
      : { type: 'stroke', snapshot, points, brush: brush(), tool: tool as 'delete' | 'protect' | 'unselect' };
    const next = await runPixelJob(job, tool === 'restore' ? '선택한 영역을 원본 픽셀로 복원하고 있습니다' : '브러시 표시를 적용하고 있습니다') as Snapshot;
    commitWorkerSnapshot(next, token);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) showError(safeTextError(error, '브러시 작업을 적용하지 못했습니다.'));
  }
}

function pointerDown(event: PointerEvent): void {
  if (!state.snapshot || event.button > 1) return;
  const screen = localPoint(event);
  const overlayReview = state.panel === 'review' && Boolean(state.candidate) && state.compareMode === 'overlay';
  const panGesture = spaceDown || event.button === 1 || (state.tool === 'pan' && !overlayReview);
  if (panGesture) {
    gesture = 'pan';
    gestureViewStart = { x: screen.x, y: screen.y, panX: state.view.panX, panY: state.view.panY };
    stage.classList.add('is-panning');
  } else if (state.panel === 'review' && state.candidate && state.compareMode === 'overlay') {
    gesture = 'candidate';
    lastGesturePoint = screen;
  } else if (state.panel === 'edit' && state.tool === 'sample') {
    sampleBackground(imagePoint(screen));
    return;
  } else if (state.panel === 'edit' && state.tool === 'crop') {
    gesture = 'crop';
    draftKind = 'crop';
    draftPoints = [imagePoint(screen)];
  } else if (state.panel === 'edit' && state.tool === 'pen') {
    addPenPoint(imagePoint(screen), event);
    event.preventDefault();
    renderDraft(overlayCanvas.getContext('2d')!, Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
    return;
  } else if (state.panel === 'edit' && state.tool === 'marquee') {
    gesture = 'marquee';
    draftKind = 'marquee';
    draftPoints = [imagePoint(screen)];
    selectionCombine = combineFor(event);
    marqueeHeld = { shift: event.shiftKey, alt: event.altKey };
    trackMarqueeModifiers(event);
  } else if (state.panel === 'edit' && state.tool === 'lasso') {
    gesture = 'lasso';
    draftKind = 'lasso';
    draftPoints = [imagePoint(screen)];
    selectionCombine = combineFor(event);
  } else if (state.panel === 'edit' && BRUSH_TOOLS.includes(state.tool)) {
    gesture = 'draw';
    draftKind = 'brush';
    draftPoints = [imagePoint(screen)];
  } else {
    return;
  }
  gestureStart = screen;
  stage.setPointerCapture(event.pointerId);
  event.preventDefault();
  renderDraft(overlayCanvas.getContext('2d')!, Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
}

function pointerMove(event: PointerEvent): void {
  const screen = localPoint(event);
  if (gesture === 'pan' && gestureViewStart) {
    state.view.panX = gestureViewStart.panX + screen.x - gestureViewStart.x;
    state.view.panY = gestureViewStart.panY + screen.y - gestureViewStart.y;
    renderCanvas();
    return;
  }
  if (gesture === 'candidate' && lastGesturePoint) {
    const deltaX = screen.x - lastGesturePoint.x;
    const deltaY = screen.y - lastGesturePoint.y;
    state.candidateX += deltaX / state.view.zoom;
    state.candidateY += deltaY / state.view.zoom;
    lastGesturePoint = screen;
    state.alignmentAcknowledged = false;
    renderCanvas();
    updateCandidateApplyButton();
    const x = inspector.querySelector<HTMLInputElement>('#alignX');
    const y = inspector.querySelector<HTMLInputElement>('#alignY');
    if (x) x.value = String(Math.round(state.candidateX));
    if (y) y.value = String(Math.round(state.candidateY));
    return;
  }
  if (!gesture && draftKind === 'pen') {
    penHover = imagePoint(screen);
    renderDraft(overlayCanvas.getContext('2d')!, Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
    return;
  }
  if (gesture === 'marquee') trackMarqueeModifiers(event);
  if ((gesture === 'draw' || gesture === 'lasso' || gesture === 'crop' || gesture === 'marquee') && draftPoints.length) {
    const point = imagePoint(screen);
    const previous = draftPoints[draftPoints.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 0.6) draftPoints.push(point);
    if (gesture === 'crop' && gestureStart) {
      const start = imagePoint(gestureStart);
      state.cropRect = {
        x: Math.min(start.x, point.x), y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y),
      };
      $('#applyCropButton').toggleAttribute('disabled', state.cropRect.width < 2 || state.cropRect.height < 2);
    }
    renderDraft(overlayCanvas.getContext('2d')!, Math.min(2, Math.max(1, window.devicePixelRatio || 1)));
  }
}

function pointerUp(event: PointerEvent): void {
  if (!gesture) return;
  const completed = gesture;
  gesture = null;
  gestureViewStart = null;
  lastGesturePoint = null;
  stage.classList.remove('is-panning');
  try { stage.releasePointerCapture(event.pointerId); } catch { /* Pointer capture may already be released. */ }
  if (completed === 'pan' || completed === 'candidate') return;
  if (completed === 'crop') {
    if (state.cropRect) {
      const { x, y, width, height } = state.cropRect;
      state.cropRect = { x: Math.floor(x), y: Math.floor(y), width: Math.ceil(width), height: Math.ceil(height) };
      $('#applyCropButton').toggleAttribute('disabled', width < 2 || height < 2);
    }
    endDraft();
    renderCanvas();
    return;
  }
  if (completed === 'lasso') { finishLasso(); return; }
  if (completed === 'marquee') { finishMarquee(); return; }
  if (completed === 'draw' && state.snapshot) {
    const snapshot = state.snapshot;
    const points = draftPoints;
    const tool = state.tool;
    endDraft();
    if (tool === 'erase') applyNow(current => eraseStroke(current, points, brush(), eraserFill()), '지우개를 적용하지 못했습니다.');
    else void finishStroke(snapshot, points, tool);
  }
}

function syncMaskToggle(): void {
  $('#maskToggleButton').setAttribute('aria-pressed', String(state.showMasks));
}

async function runAutomaticCleanup(): Promise<void> {
  const snapshot = state.snapshot;
  if (!snapshot || !state.project || document.body.classList.contains('is-processing')) return;
  const token = captureEditToken(snapshot);
  const previousMaskVisibility = state.showMasks;
  state.autoCleanStatus = 'running';
  renderInspector();
  const requestId = crypto.randomUUID();
  setProcessing('로컬 모델이 글씨 범위를 살펴보고 있습니다', 0, true);
  announce('로컬 분석을 시작했습니다. 취소해도 사진과 편집 내용은 유지됩니다.');
  try {
    const textMask = await detectTextMask(snapshot, requestId);
    if (!isEditTokenCurrent(token)) {
      clearProcessing();
      return;
    }
    const next = await runPixelJob({ type: 'auto-clean', snapshot, textMask }, '확실한 주변 표시를 정리하고 있습니다') as Snapshot;
    if (!isEditTokenCurrent(token)) return;
    if (next.workVersion === snapshot.workVersion) {
      state.showMasks = false;
      syncMaskToggle();
      state.autoCleanStatus = 'unchanged';
      renderCanvas();
      renderInspector();
      announce('자동으로 지울 범위를 확신하기 어려워 원본을 유지했습니다. 직접 수정할 수 있습니다.');
      return;
    }
    const review = hasPendingSelection(next);
    state.showMasks = review;
    syncMaskToggle();
    state.autoCleanStatus = review ? 'review' : 'complete';
    if (!commitWorkerSnapshot(next, token)) return;
    announce(review
      ? '자동 정리가 끝났습니다. 도해 안의 지울 후보를 빨간색으로 골라 두었습니다. 확인한 뒤 Delete로 지우세요.'
      : '자동 정리가 끝났습니다. 결과를 확인하고 필요한 곳을 직접 수정하세요.');
  } catch (error) {
    if (!isEditTokenCurrent(token)) {
      clearProcessing();
      return;
    }
    clearProcessing();
    state.showMasks = previousMaskVisibility;
    syncMaskToggle();
    if (error instanceof DOMException && error.name === 'AbortError') {
      state.autoCleanStatus = 'cancelled';
      renderCanvas();
      renderInspector();
      announce('자동 정리를 취소했습니다. 사진은 유지되어 직접 수정할 수 있습니다.');
    } else {
      state.autoCleanStatus = 'failed';
      renderCanvas();
      renderInspector();
      showError(safeTextError(error, '자동 정리를 마치지 못했습니다. 사진은 유지되어 직접 수정할 수 있습니다.'));
    }
  }
}

/** True when some selected pixels still hold ink: candidates waiting for the person to confirm. */
function hasPendingSelection(snapshot: Snapshot): boolean {
  const { data } = snapshot.working;
  for (let index = 0; index < snapshot.deleteMask.length; index += 1) {
    if (snapshot.deleteMask[index] !== 255) continue;
    if (Math.min(data[index * 4], data[index * 4 + 1], data[index * 4 + 2]) < 200) return true;
  }
  return false;
}

function detectTextMask(snapshot: Snapshot, requestId: string): Promise<Uint8Array> {
  setProcessing('로컬 모델이 글씨 범위를 살펴보고 있습니다', 0, true);
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = (): void => {
      settled = true;
      if (cancelCurrentWorker === cancel) cancelCurrentWorker = null;
    };
    const cancel = (): void => {
      if (settled) return;
      release();
      void Promise.resolve().then(() => desktop().cancelTextDetection(requestId)).catch(() => undefined);
      clearProcessing();
      reject(new DOMException('로컬 분석을 취소했습니다.', 'AbortError'));
    };
    cancelCurrentWorker = cancel;
    Promise.resolve().then(() => desktop().detectText(snapshot.working, requestId)).then(reply => {
      if (settled) return;
      release();
      try {
        const mask = value(reply, '로컬 글씨 분석을 마치지 못했습니다.');
        if (!(mask instanceof Uint8Array) || mask.length !== snapshot.working.width * snapshot.working.height) {
          throw new Error('로컬 글씨 분석 결과의 크기가 사진과 다릅니다. 다시 시도해 주세요.');
        }
        resolve(mask);
      } catch (error) {
        reject(error);
      }
    }, error => {
      if (settled) return;
      release();
      reject(error instanceof Error ? error : new Error('로컬 글씨 분석을 마치지 못했습니다.'));
    });
  });
}

async function openImported(image: ImportedImage, openingRevision: number): Promise<void> {
  const pixels = image.pixels;
  if (!Number.isInteger(pixels.width) || !Number.isInteger(pixels.height) || pixels.width < 1 || pixels.height < 1 || pixels.width * pixels.height > MAX_PIXELS || pixels.data.length !== pixels.width * pixels.height * 4) {
    throw new Error('사진 크기나 픽셀 정보가 올바르지 않습니다. 2,500만 픽셀 이하의 JPEG 또는 PNG를 선택해 주세요.');
  }
  if (!(await confirmReplace())) return;
  if (openingRevision !== openProjectRevision) return;
  const sourceProjectId = state.project?.id ?? null;
  const sourceRevision = editRevision;
  const sourceEpoch = projectEpoch;
  const sourceSnapshot = state.snapshot;
  const snapshot = createSnapshot(pixels, `base-${crypto.randomUUID()}`);
  const project = value(await desktop().createProject(image.sourceId, snapshot), '작업을 만들지 못했습니다.');
  if (openingRevision !== openProjectRevision) {
    await refreshRecent();
    announce('열기 요청이 바뀌어 완료된 새 작업은 열지 않았습니다. 최근 작업에서 확인할 수 있습니다.');
    return;
  }
  if ((state.project?.id ?? null) !== sourceProjectId || editRevision !== sourceRevision || projectEpoch !== sourceEpoch || state.snapshot !== sourceSnapshot) {
    await refreshRecent();
    showError('새 작업은 만들어졌지만 열기 전에 현재 작업이 바뀌었습니다. 현재 작업을 보존했으며 새 작업은 최근 작업에서 열 수 있습니다.');
    return;
  }
  state.imported = image;
  setProject(project);
  state.showMasks = false;
  syncMaskToggle();
  renderCanvas();
  await refreshRecent();
}

async function chooseImage(): Promise<void> {
  const openingRevision = ++openProjectRevision;
  clearError();
  try {
    const image = value(await desktop().importImage(), '사진을 열지 못했습니다.');
    if (openingRevision !== openProjectRevision) return;
    if (image) await openImported(image, openingRevision);
  } catch (error) {
    showError(safeTextError(error, '사진을 열지 못했습니다. JPG 또는 PNG인지 확인해 주세요.'));
  }
}

async function acceptDroppedFile(file: File): Promise<void> {
  const openingRevision = ++openProjectRevision;
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  if (!['jpg', 'jpeg', 'png'].includes(extension ?? '')) {
    showError('JPEG 또는 PNG 파일만 열 수 있습니다. HEIC와 PDF는 지원하지 않습니다.');
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showError('사진 파일이 50MB를 넘습니다. 더 작은 파일로 저장한 뒤 다시 열어 주세요.');
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const image = value(await desktop().importDropped(bytes, file.name), '사진을 열지 못했습니다.');
    if (openingRevision === openProjectRevision) await openImported(image, openingRevision);
  } catch (error) {
    showError(safeTextError(error, '사진을 읽지 못했습니다. 파일이 손상되지 않았는지 확인해 주세요.'));
  }
}

async function openSavedProject(): Promise<void> {
  const openingRevision = ++openProjectRevision;
  clearError();
  try {
    const project = value(await desktop().openProject(), '프로젝트를 열지 못했습니다.');
    if (openingRevision !== openProjectRevision) return;
    if (project && await confirmReplace() && openingRevision === openProjectRevision) {
      setProject(project);
      await refreshRecent();
    }
  } catch (error) {
    showError(safeTextError(error, '프로젝트를 열지 못했습니다. 저장 위치와 파일 권한을 확인해 주세요.'));
  }
}

async function refreshRecent(): Promise<void> {
  const list = $('#recentProjects');
  try {
    const recent = value(await desktop().listRecent(), '최근 작업을 읽지 못했습니다.');
    if (!recent.length) {
      list.innerHTML = '<p class="muted-copy">저장한 작업이 여기에 표시됩니다.</p>';
      return;
    }
    list.innerHTML = recent.map((item: RecentProject) => `
      <button class="recent-row" type="button" data-recent-id="${escapeHTML(item.id)}">
        <strong>${escapeHTML(item.name)}</strong><span>${escapeHTML(item.folder)}</span>
      </button>`).join('');
  } catch (error) {
    list.innerHTML = '<p class="muted-copy">최근 작업을 불러오지 못했습니다. 저장 폴더에서 프로젝트를 열어 주세요.</p>';
    showError(safeTextError(error, '최근 작업을 불러오지 못했습니다.'));
  }
}

async function openRecentProject(id: string): Promise<void> {
  const openingRevision = ++openProjectRevision;
  try {
    const project = value(await desktop().openRecent(id), '최근 작업을 열지 못했습니다.');
    if (openingRevision !== openProjectRevision || !(await confirmReplace()) || openingRevision !== openProjectRevision) return;
    setProject(project);
    await refreshRecent();
  } catch (error) {
    showError(safeTextError(error, '최근 작업을 열지 못했습니다. 원본 폴더가 이동되었는지 확인해 주세요.'));
  }
}

function masksPresent(snapshot: Snapshot): boolean {
  for (let index = 0; index < snapshot.deleteMask.length; index += 1) {
    if (snapshot.deleteMask[index] || snapshot.protectMask[index]) return true;
  }
  return false;
}

function allowBasisChange(): boolean {
  if (!state.snapshot || !masksPresent(state.snapshot)) return true;
  return window.confirm('자르기와 회전은 기존 삭제·보호 표시를 초기화합니다. 계속할까요?');
}

async function applyBasisChange(job: PixelJob, label: string): Promise<void> {
  if (!state.snapshot || job.snapshot !== state.snapshot || !allowBasisChange()) return;
  const token = captureEditToken(job.snapshot);
  try {
    const next = await runPixelJob(job, label) as Snapshot;
    if (!commitWorkerSnapshot(next, token)) return;
    state.cropRect = null;
    state.fineRotation = 0;
    state.sampledColor = null;
    state.sampledPoint = null;
    ($('#fineRotation') as HTMLInputElement).value = '0';
    $('#fineRotationOutput').textContent = '0°';
    $('#applyCropButton').setAttribute('disabled', '');
    $('#applyFineRotationButton').setAttribute('disabled', '');
    fitView();
    announce(`${label} 작업 기준을 업데이트했습니다.`);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) showError(safeTextError(error, `${label} 작업을 마치지 못했습니다.`));
  }
}

async function applyCrop(): Promise<void> {
  if (!state.snapshot || !state.cropRect) return;
  const rect = state.cropRect;
  if (rect.width < 2 || rect.height < 2) {
    showError('자르기 범위가 너무 작습니다. 사진 안에서 사각형을 다시 그려 주세요.');
    return;
  }
  await applyBasisChange({ type: 'crop', snapshot: state.snapshot, rect }, '사진 자르기');
}

async function rotate(degrees: number): Promise<void> {
  if (!state.snapshot) return;
  await applyBasisChange({ type: 'rotate', snapshot: state.snapshot, degrees }, '사진 회전');
}

function setTool(tool: Tool): void {
  if (tool !== 'pen' && draftKind === 'pen') endDraft();
  state.tool = tool;
  if ([...BRUSH_TOOLS, ...SELECTION_TOOLS].includes(tool)) {
    state.showMasks = true;
    syncMaskToggle();
  }
  document.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach(button => {
    const active = button.dataset.tool === tool;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('#brushControls').toggleAttribute('hidden', !BRUSH_TOOLS.includes(tool));
  $('#lassoControls').toggleAttribute('hidden', tool !== 'lasso');
  const hints: Record<Tool, string> = {
    erase: '드래그하는 곳을 바로 지웁니다. 파랑 보호 영역은 지워지지 않습니다. [ ]로 크기 조절.',
    marquee: '드래그해 사각형으로 선택하고 Delete로 지우세요. Shift를 누르고 시작하면 더하기, Alt는 빼기. 드래그 중 Shift 정사각형, Alt 중심 기준.',
    pen: '점을 찍어 직선으로 두르고 첫 점이나 Enter로 닫으세요. 첫 점을 Shift로 찍으면 더하기, Alt는 빼기. Backspace 한 점 취소, Esc 취소.',
    delete: '바꿔도 되는 영역을 드래그해 표시하세요.',
    protect: '남길 선과 부분을 드래그해 보호하세요.',
    unselect: '사진은 지우지 않고 표시만 지웁니다.',
    restore: '현재 작업 기준 픽셀을 다시 가져옵니다.',
    lasso: '사진 안에서 자유롭게 둘러 선택하고 Delete로 지우세요. Shift를 누르고 시작하면 더하기, Alt는 빼기.',
    pan: '드래그해 화면을 옮기세요. 스페이스바를 누른 채 이동할 수도 있습니다.',
    crop: '사진 안에서 자를 사각형을 드래그하세요.',
    sample: '사진을 눌러 채울 배경색을 찍으세요.',
  };
  $('#toolHint').textContent = hints[tool];
  $('#canvasHint').textContent = hints[tool];
  renderCanvas();
}

function setPanel(panel: Panel): void {
  const leavingSideBySideReview = state.panel === 'review' && Boolean(state.candidate)
    && state.compareMode === 'side' && panel !== 'review';
  state.panel = panel;
  selectPanelTab(panel);
  if (panel === 'review' && state.candidate) {
    state.tool = 'pan';
    if (state.compareMode === 'side') fitView();
  } else if (leavingSideBySideReview) fitView();
  renderInspector();
  renderCanvas();
  if (panel === 'request' && state.requestId && state.requestBundle?.info.id !== state.requestId) void loadRequest(state.requestId, 'request');
}

function selectPanelTab(panel: Panel): void {
  document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(button => {
    const active = button.dataset.panel === panel;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
}

function autoCleanDescription(): string {
  const messages: Record<AutoCleanStatus, { title: string; detail: string }> = {
    idle: { title: '원본 미리보기입니다', detail: '자동 정리는 글씨 범위를 참고해 주변의 분리된 표시를 정리합니다. 선과 겹쳐 판단하기 어려운 곳은 직접 수정하세요.' },
    running: { title: '자동 정리 중입니다', detail: '먼저 로컬 모델이 글씨 범위를 살펴본 뒤 정리합니다. 취소해도 사진은 유지됩니다.' },
    complete: { title: '자동 정리를 적용했습니다', detail: '결과 선을 살펴보고 필요한 곳은 직접 수정하세요.' },
    review: { title: '도해 안의 지울 후보를 빨간색으로 골라 두었습니다', detail: '글씨·화살표·가위표·색 표시 후보입니다. 디자인인 곳은 표시 지우기나 Alt를 누른 선택으로 빼고 Delete로 지우세요.' },
    unchanged: { title: '', detail: '자동으로 지울 범위를 확신하기 어려워 원본을 유지했습니다. 직접 수정할 수 있습니다.' },
    cancelled: { title: '자동 정리를 취소했습니다', detail: '사진은 유지되어 직접 수정할 수 있습니다.' },
    failed: { title: '자동 정리를 마치지 못했습니다', detail: '사진은 유지되어 직접 수정할 수 있습니다.' },
  };
  const { title, detail } = messages[state.autoCleanStatus];
  return title ? `<strong>${title}</strong><span>${detail}</span>` : `<span>${detail}</span>`;
}

function renderInspector(): void {
  const project = state.project;
  const hasImage = Boolean(state.snapshot);
  const request = activeRequest();
  const bundle = state.requestBundle?.info.id === request?.id ? state.requestBundle : null;
  const candidate = state.candidate;
  const noProject = '<div class="empty-inline">사진을 열거나 최근 작업을 선택하면<br>이곳에서 작업을 이어갈 수 있습니다.</div>';

  if (state.panel === 'edit') {
    inspector.innerHTML = hasImage ? `
      <h2 class="panel-heading">사진 정리 결과</h2>
      <p class="panel-intro">원본을 먼저 확인하세요. 글씨 범위를 참고해 주변의 분리된 표시를 정리하고, 선과 겹쳐 판단하기 어려운 곳은 직접 고칩니다.</p>
      <section class="panel-block">
        <h3>자동 정리</h3>
        <div id="autoCleanStatus" class="auto-clean-status" data-state="${state.autoCleanStatus}" role="status" aria-live="polite">${autoCleanDescription()}</div>
        <button class="button button-primary wide-button" type="button" data-action="auto-clean">자동 정리</button>
        <button class="small-button small-button-accent wide-button result-save-action" type="button" data-action="go-export">결과 확인 및 저장</button>
      </section>
      <section class="panel-block">
        <h3>직접 수정</h3>
        <p class="muted-copy">삭제 표시 도구로 지울 곳을 칠한 다음 <strong>칠한 곳 지우기</strong>를 누르세요. 보호 표시와 기준 복원 도구로 도해 선을 지킬 수 있습니다.</p>
        <div class="button-row"><button id="selectAllButton" class="small-button" type="button" data-action="select-all">전체 선택</button><button class="small-button" type="button" data-action="clear-selection">선택 범위 지우기</button></div>
        <button class="button button-quiet wide-button" type="button" data-action="fill-white">칠한 곳 지우기</button>
        <p class="muted-copy">전체를 지우려면 전체 선택을 누른 뒤 실행하세요. 선택 범위 밖과 보호한 픽셀은 유지됩니다.</p>
      </section>
      <details class="advanced-block">
        <summary>배경색 채우기</summary>
        <div class="advanced-content">
          <div class="button-row"><button class="small-button" type="button" data-action="sample-color">배경색 찍기</button><button class="button button-quiet" type="button" data-action="fill-sample" ${state.sampledColor ? '' : 'disabled'}>찍은 색으로 채우기</button></div>
        <div class="control-row"><span>찍은 배경색</span><span><canvas id="sampledColorSwatch" class="color-sample" width="18" height="18" aria-hidden="true"></canvas><span id="sampledColorText">아직 선택하지 않음</span></span></div>
        <p class="muted-copy">선택 범위 밖의 픽셀은 그대로 유지됩니다.</p>
        </div>
      </details>
      <details class="advanced-block">
        <summary>고급 보정 · 밝기와 대비</summary>
        <div class="advanced-content">
        <label class="control-row" for="brightness"><span>밝기</span><input id="brightness" type="range" min="-100" max="100" value="${state.brightness}" /><output id="brightnessOutput">${state.brightness}</output></label>
        <label class="control-row" for="contrast"><span>대비</span><input id="contrast" type="range" min="-100" max="100" value="${state.contrast}" /><output id="contrastOutput">${state.contrast}</output></label>
        <div class="button-row"><button class="small-button small-button-accent" type="button" data-action="preview-adjust">미리보기</button><button class="small-button" type="button" data-action="apply-adjust" ${state.adjustmentPreview ? '' : 'disabled'}>적용</button><button class="small-button" type="button" data-action="cancel-adjust" ${state.adjustmentPreview ? '' : 'disabled'}>취소</button></div>
        <p class="muted-copy">미리보기는 적용을 누를 때까지 작업에 저장되지 않습니다. 전체 적용은 전체를 선택했을 때만 가능합니다.</p>
        </div>
      </details>
      <div class="notice">글씨와 도해 선이 겹친 부분은 자동으로 복원하기 어려울 수 있습니다. 100% 확대에서 결과 선을 확인해 주세요.</div>
      ${state.history?.truncated ? '<div class="notice warning-copy">큰 이미지라 오래된 실행 취소 기록 일부를 정리했습니다. 바로 이전 상태는 계속 취소할 수 있습니다.</div>' : ''}` : noProject;
  } else if (state.panel === 'request') {
    inspector.innerHTML = project ? `
      <h2 class="panel-heading">ChatGPT 요청 파일</h2>
      <p class="panel-intro">앱이 요청용 이미지와 안내문을 로컬 프로젝트에 준비합니다. ChatGPT에 자동으로 업로드하지 않습니다.</p>
      <div class="notice">선택한 이미지를 ChatGPT에 직접 첨부하며 외부에서 처리됩니다.</div>
      <section class="panel-block">
        <h3>보낼 이미지</h3>
        <div class="preview-pair">
          <div class="preview-card"><canvas id="requestInputPreview" aria-label="편집 대상 미리보기"></canvas><span>편집 대상 · 표시 없음</span></div>
          <div class="preview-card"><canvas id="requestGuidePreview" aria-label="삭제와 보호 표시 참고 미리보기"></canvas><span>범위 참고 · 빨강 삭제 · 파랑 보호</span></div>
        </div>
        ${bundle ? `<small class="version-note">요청 ${escapeHTML(bundle.info.id)} · 작업 버전 ${bundle.info.workVersion} · ${bundle.info.width} × ${bundle.info.height} px</small>` : '<small class="version-note">요청 파일을 만들면 요청 번호와 작업 버전이 기록됩니다.</small>'}
      </section>
      <section class="panel-block">
        <h3>요청 문구</h3>
        <textarea class="request-text" id="requestText" aria-label="ChatGPT에 붙여 넣을 요청 문구" readonly>${bundle ? escapeHTML(bundle.text) : '첫 번째 이미지를 편집해 주세요. 두 번째 이미지는 삭제·보호 범위를 표시한 참고이며 결과물이 아닙니다. 빨강은 제거 요청 영역, 파랑은 보존 요청 영역입니다. 지시 대상 글씨·화살표·표·배경만 정리하고 의류의 윤곽·주름·봉제선·점선과 원래 펜의 질감을 유지해 주세요. 구성과 비율을 유지하고 새 선·새 디자인·설명·색 표시를 추가하지 마세요. 가려진 선은 확실하게 복원할 수 있을 때만 최소한으로 보완해 주세요. 원본과 같은 캔버스 크기로 반환해 주세요.'}</textarea>
        <div class="button-row"><button class="button button-primary" type="button" data-action="create-request">요청 파일 만들기</button><button class="small-button" type="button" data-action="copy-request" ${bundle ? '' : 'disabled'}>문구 복사</button></div>
        <div class="button-row"><button class="small-button" type="button" data-action="open-chatgpt" ${bundle ? '' : 'disabled'}>ChatGPT 열기</button><button class="small-button" type="button" data-action="open-request-folder" ${bundle ? '' : 'disabled'}>파일 위치 열기</button></div>
        <p class="muted-copy">웹 로그인과 이미지 편집은 사용자의 ChatGPT Plus 계정에서 직접 진행합니다. 앱은 계정 정보나 결과 생성 상태를 읽지 않습니다.</p>
      </section>
      <section class="panel-block"><h3>요청 기록</h3>${renderRequestHistory()}</section>` : noProject;
  } else if (state.panel === 'review') {
    const readiness = project && request ? candidateReadiness({
      projectId: project.id, baseVersion: state.snapshot?.baseVersion ?? '',
      request, candidate, aligned: Boolean(candidate), acknowledged: state.alignmentAcknowledged,
    }) : 'missing-request';
    const stale = readiness === 'stale-basis';
    inspector.innerHTML = project ? `
      <h2 class="panel-heading">결과를 비교하고 적용</h2>
      <p class="panel-intro">다운로드한 이미지를 후보로 가져옵니다. 같은 크기라도 내용 정렬을 직접 확인해야 합니다.</p>
      <section class="panel-block">
        <h3>요청 번호</h3>
        ${renderRequestHistory()}
        <div class="button-row"><button class="button button-quiet wide-button" type="button" data-action="import-candidate" ${request ? '' : 'disabled'}>이 요청의 결과 이미지 가져오기</button><button class="small-button" type="button" data-action="open-request-folder" ${request ? '' : 'disabled'}>요청 폴더</button></div>
        ${request ? `<small class="version-note">기준 버전 ${escapeHTML(request.baseVersion)} · 요청 작업 ${request.workVersion} · 현재 작업 ${state.snapshot?.workVersion ?? 0}</small>` : '<p class="muted-copy">먼저 요청 파일을 만들거나 기록에서 요청을 선택하세요.</p>'}
        ${request && request.workVersion !== state.snapshot?.workVersion ? '<p class="version-note">요청 후 편집한 내용이 있습니다. 비교 화면은 저장 당시 작업 기준과 후보를 보여줍니다. 현재 편집은 작업 화면에서 따로 확인하세요.</p>' : ''}
      </section>
      ${candidate ? `
        <section class="panel-block">
          <h3>후보 이미지</h3>
          <div class="candidate-stats"><div class="candidate-stat"><small>후보 크기 · 비율</small><strong>${candidate.pixels.width.toLocaleString()} × ${candidate.pixels.height.toLocaleString()} · ${(candidate.pixels.width / candidate.pixels.height).toFixed(3)}</strong></div><div class="candidate-stat"><small>작업 기준 · 비율</small><strong>${state.snapshot!.working.width.toLocaleString()} × ${state.snapshot!.working.height.toLocaleString()} · ${(state.snapshot!.working.width / state.snapshot!.working.height).toFixed(3)}</strong></div></div>
          <div class="comparison-options" role="radiogroup" aria-label="비교 방식"><label><input type="radio" name="comparison" value="side" ${state.compareMode === 'side' ? 'checked' : ''}/> 나란히</label><label><input type="radio" name="comparison" value="overlay" ${state.compareMode === 'overlay' ? 'checked' : ''}/> 겹쳐 보기</label></div>
          <p class="muted-copy">겹쳐 보기에서 후보를 드래그해 위치를 맞춥니다. 확대·회전·이동 값은 후보에만 적용됩니다.</p>
          <label class="control-row" for="alignScale"><span>크기</span><input id="alignScale" type="range" min="50" max="150" value="${Math.round(state.candidateScale * 100)}"/><output>${Math.round(state.candidateScale * 100)}%</output></label>
          <label class="control-row" for="alignRotation"><span>회전</span><input id="alignRotation" type="range" min="-15" max="15" step="0.5" value="${state.candidateRotation}"/><output>${state.candidateRotation}°</output></label>
          <label class="control-row" for="alignX"><span>가로 이동</span><input id="alignX" type="number" step="1" value="${state.candidateX}"/><span>px</span></label>
          <label class="control-row" for="alignY"><span>세로 이동</span><input id="alignY" type="number" step="1" value="${state.candidateY}"/><span>px</span></label>
          ${stale ? '<p class="notice warning-copy">요청 이후 작업 기준 이미지가 달라졌습니다. 이 후보는 비교용으로만 적용할 수 있습니다. 요청 당시 기준으로 새 작업을 만들 수 있습니다.</p>' : ''}
          <label class="acknowledge"><input id="alignmentAck" type="checkbox" ${state.alignmentAcknowledged ? 'checked' : ''} ${stale ? 'disabled' : ''}/><span>정렬과 윤곽을 확인했습니다. 선택 영역 안에 후보를 적용합니다.</span></label>
          <button class="button button-primary wide-button" type="button" data-action="apply-candidate" ${readiness === 'ready' ? '' : 'disabled'}>선택 영역에 적용</button>
          ${stale ? '<button class="small-button wide-button" type="button" data-action="fork-request">요청 당시 기준으로 새 작업 만들기</button>' : ''}
        </section>` : `
        <section class="panel-block"><h3>후보 비교</h3><div class="empty-inline">요청 기록을 선택한 뒤<br>다운로드한 JPEG 또는 PNG를 가져오세요.</div></section>`}
      <div class="notice">후보에서 찾을 수 없는 픽셀은 바뀌지 않습니다. 잘못 재해석된 선은 적용하지 말고 다시 요청하거나 로컬 편집을 사용하세요.</div>` : noProject;
  } else {
    inspector.innerHTML = project ? `
      <h2 class="panel-heading">로컬 파일로 저장</h2>
      <p class="panel-intro">최종 PNG는 작업 기준과 같은 픽셀 크기로 저장합니다. 표시 색은 결과에 포함되지 않습니다.</p>
      <section class="panel-block">
        <h3>결과 미리보기</h3>
        <div class="output-preview"><canvas id="exportPreview" aria-label="최종 이미지 미리보기"></canvas></div>
        <div class="candidate-stats"><div class="candidate-stat"><small>가로 × 세로</small><strong>${state.snapshot!.working.width.toLocaleString()} × ${state.snapshot!.working.height.toLocaleString()} px</strong></div><div class="candidate-stat"><small>저장 형식</small><strong>PNG</strong></div></div>
      </section>
      <section class="panel-block">
        <h3>프로젝트</h3><div class="success-card">${escapeHTML(project.folder)}</div>
        <div class="button-row"><button class="small-button" type="button" data-action="save-project">프로젝트 저장</button><button class="small-button" type="button" data-action="save-as">다른 폴더에 저장</button></div>
      </section>
      <section class="panel-block">
        <h3>최종 PNG</h3><button class="button button-primary wide-button" type="button" data-action="export-png">PNG 저장</button>
        ${state.exportResult ? `<div class="success-card">저장 완료 · ${state.exportResult.width.toLocaleString()} × ${state.exportResult.height.toLocaleString()} px<br>${escapeHTML(state.exportResult.path)}</div><button class="small-button wide-button" type="button" data-action="open-project-folder">프로젝트 폴더 열기</button>` : ''}
      </section>
      <p class="muted-copy">브라우저 다운로드 위치와 운영체제의 백업 설정은 앱이 제어하지 않습니다. 앱의 프로젝트와 결과는 로컬에 저장됩니다.</p>` : noProject;
  }

  if (state.panel === 'request') {
    const bundlePixels = bundle?.snapshot.working ?? state.snapshot?.working ?? null;
    fitPixels($('#requestInputPreview'), bundlePixels);
    fitPixels($('#requestGuidePreview'), state.guide, bundle?.snapshot ?? state.snapshot);
  } else if (state.panel === 'export' && state.snapshot) {
    fitPixels($('#exportPreview'), state.snapshot.working);
  }
  if (state.panel === 'edit' && state.sampledColor) {
    const swatch = inspector.querySelector<HTMLCanvasElement>('#sampledColorSwatch');
    const text = inspector.querySelector<HTMLElement>('#sampledColorText');
    if (swatch) paintColorSwatch(swatch, state.sampledColor);
    if (text) text.textContent = `RGB ${state.sampledColor.join(', ')}`;
  }
  updateCandidateApplyButton();
}

function renderRequestHistory(): string {
  const requests = state.project?.requests ?? [];
  if (!requests.length) return '<p class="muted-copy">아직 만든 요청이 없습니다.</p>';
  return `<div class="request-list">${[...requests].reverse().map(request => `
    <button class="request-row" type="button" data-action="select-request" data-request-id="${escapeHTML(request.id)}" aria-pressed="${request.id === state.requestId}">
      <i class="request-selection-mark" aria-hidden="true"></i>
      <span><strong>요청 ${escapeHTML(request.id)}</strong><small>${new Date(request.createdAt).toLocaleString('ko-KR')} · 작업 ${request.workVersion} · ${request.width} × ${request.height} px</small></span>
    </button>`).join('')}</div>`;
}

function updateCandidateApplyButton(): void {
  const button = inspector.querySelector<HTMLButtonElement>('[data-action="apply-candidate"]');
  if (!button) return;
  const request = activeRequest();
  const result = state.project && state.snapshot ? candidateReadiness({
    projectId: state.project.id, baseVersion: state.snapshot.baseVersion,
    request, candidate: state.candidate, aligned: Boolean(state.candidate),
    acknowledged: state.alignmentAcknowledged,
  }) : 'missing-request';
  button.disabled = result !== 'ready';
}

async function createRequestFiles(): Promise<void> {
  const projectId = state.project?.id;
  if (!state.snapshot || !projectId) return;
  try {
    if (state.dirty || pendingSave || savePump) {
      await requestSave();
      if (state.project?.id !== projectId || state.saveFailed) return;
    }
    const snapshot = state.snapshot;
    const project = state.project;
    if (!snapshot || !project || project.id !== projectId) return;
    const token = captureEditToken(snapshot);
    const guide = await runPixelJob({ type: 'guide', snapshot }, '요청 참고 이미지를 만들고 있습니다') as Pixels;
    if (!isEditTokenCurrent(token)) return;
    const bundle = value(await desktop().createRequest(project.id, snapshot, guide), '요청 파일을 만들지 못했습니다.');
    if (state.project?.id !== project.id) return;
    if (!state.project!.requests.some(item => item.id === bundle.info.id)) {
      state.project = { ...state.project!, requests: [...state.project!.requests, bundle.info] };
    }
    if (!isEditTokenCurrent(token)) {
      renderInspector();
      announce('요청 파일을 만들었습니다. 요청 당시 작업은 기록에 보관했으며 현재 편집은 유지됩니다.');
      return;
    }
    state.requestBundle = bundle;
    state.requestId = bundle.info.id;
    state.guide = guide;
    state.candidate = null;
    state.alignmentAcknowledged = false;
    state.exportResult = null;
    setPanel('request');
    announce(`요청 ${bundle.info.id} 파일을 만들었습니다. 첨부 이미지를 ChatGPT에 직접 추가해 주세요.`);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) showError(safeTextError(error, '요청 파일을 만들지 못했습니다. 저장 공간과 권한을 확인해 주세요.'));
  }
}

async function loadRequest(requestId: string, panel: Panel = 'review'): Promise<void> {
  const project = state.project;
  const snapshot = state.snapshot;
  if (!project || !snapshot) return;
  const revision = ++requestLoadRevision;
  const token = captureEditToken(snapshot);
  try {
    const bundle = value(await desktop().loadRequest(project.id, requestId), '요청 기록을 열지 못했습니다.');
    if (revision !== requestLoadRevision || !isEditTokenCurrent(token)) return;
    const guide = await runPixelJob({ type: 'guide', snapshot: bundle.snapshot }, '요청 미리보기를 준비하고 있습니다') as Pixels;
    if (revision !== requestLoadRevision || !isEditTokenCurrent(token)) return;
    state.requestId = requestId;
    state.requestBundle = bundle;
    state.guide = guide;
    state.candidate = null;
    state.alignmentAcknowledged = false;
    state.panel = panel;
    renderInspector();
    renderCanvas();
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) showError(safeTextError(error, '요청 기록을 열지 못했습니다.'));
  }
}

async function importCandidate(): Promise<void> {
  const project = state.project;
  const request = activeRequest();
  const snapshot = state.snapshot;
  if (!project || !request || !snapshot) return;
  const token = captureEditToken(snapshot);
  try {
    const candidate = value(await desktop().importCandidate(project.id, request.id), '후보 이미지를 가져오지 못했습니다.');
    if (!candidate || !isEditTokenCurrent(token) || activeRequest()?.id !== request.id) return;
    state.candidate = candidate;
    state.candidateScale = 1;
    state.candidateRotation = 0;
    state.candidateX = 0;
    state.candidateY = 0;
    state.alignmentAcknowledged = false;
    state.compareMode = 'side';
    state.panel = 'review';
    fitView();
    renderInspector();
    renderCanvas();
    announce(`후보 ${candidate.name}을 불러왔습니다. 크기와 윤곽을 확인해 주세요.`);
  } catch (error) {
    showError(safeTextError(error, '후보 이미지를 열지 못했습니다. JPEG 또는 PNG인지 확인해 주세요.'));
  }
}

async function applyCandidateToSelection(): Promise<void> {
  const snapshot = state.snapshot;
  const candidate = state.candidate;
  const request = activeRequest();
  if (!snapshot || !candidate || !request || !state.project) return;
  const readiness = candidateReadiness({
    projectId: state.project.id, baseVersion: snapshot.baseVersion,
    request, candidate, aligned: true, acknowledged: state.alignmentAcknowledged,
  });
  if (readiness !== 'ready') {
    showError(readiness === 'stale-basis' ? '작업 기준이 달라져 이 후보를 적용할 수 없습니다. 요청 당시 기준으로 새 작업을 만드세요.' : '요청과 정렬 상태를 확인한 뒤 선택 영역에 적용해 주세요.');
    return;
  }
  const token = captureEditToken(snapshot);
  try {
    const next = await runPixelJob({ type: 'candidate', snapshot, candidate: candidate.pixels, transform: candidateTransform() }, '선택 영역에 후보를 적용하고 있습니다') as Snapshot;
    if (!commitWorkerSnapshot(next, token)) return;
    state.alignmentAcknowledged = false;
    announce('선택한 영역에 후보를 적용했습니다. 필요하면 실행 취소로 되돌릴 수 있습니다.');
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) showError(safeTextError(error, '후보를 적용하지 못했습니다.'));
  }
}

async function forkAtRequest(): Promise<void> {
  const project = state.project;
  const request = activeRequest();
  if (!project || !request) return;
  const candidate = state.candidate;
  try {
    if (worker) return;
    if (state.dirty || pendingSave || savePump) {
      await requestSave();
      if (state.project?.id !== project.id || state.saveFailed || activeRequest()?.id !== request.id) return;
    }
    const sourceSnapshot = state.snapshot;
    if (!sourceSnapshot) return;
    const token = captureEditToken(sourceSnapshot);
    const forked = value(await desktop().forkRequest(project.id, request.id), '요청 당시 기준으로 새 작업을 만들지 못했습니다.');
    if (!isEditTokenCurrent(token) || activeRequest()?.id !== request.id) {
      await refreshRecent();
      showError('요청 당시 작업 사본은 만들었지만 현재 편집이 바뀌어 열지 않았습니다. 최근 작업에서 사본을 열 수 있습니다.');
      return;
    }
    setProject(forked);
    state.candidate = candidate;
    state.requestId = forked.requests.some(item => item.id === request.id) ? request.id : '';
    state.panel = 'review';
    selectPanelTab('review');
    state.alignmentAcknowledged = false;
    state.requestBundle = null;
    renderInspector();
    renderCanvas();
    await refreshRecent();
    announce('요청 당시 작업 기준으로 새 프로젝트를 만들었습니다. 후보를 다시 확인한 뒤 선택 영역에 적용하세요.');
  } catch (error) {
    showError(safeTextError(error, '새 작업을 만들지 못했습니다. 저장 위치를 확인해 주세요.'));
  }
}

async function saveProjectAs(): Promise<void> {
  if (!state.project || !state.snapshot || saveAsInProgress) return;
  const projectId = state.project.id;
  saveAsInProgress = true;
  window.clearTimeout(saveTimer);
  try {
    while (savePump) await savePump;
    if (state.project?.id !== projectId) return;
    window.clearTimeout(saveTimer);
    pendingSave = null;
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const token = captureEditToken(snapshot);
    const previousCandidate = state.candidate;
    const project = value(await desktop().saveProjectAs(projectId, snapshot), '다른 폴더에 저장하지 못했습니다.');
    if (state.project?.id !== projectId) return;
    if (!project) {
      renderHeader();
      return;
    }
    if (!isEditTokenCurrent(token)) {
      showError('저장 위치를 고르는 동안 작업이 바뀌었습니다. 현재 변경사항은 유지했으니 다른 폴더에 다시 저장해 주세요.');
      return;
    }
    setProject(project);
    if (previousCandidate && project.requests.some(request => request.id === previousCandidate.requestId)) state.candidate = previousCandidate;
    state.dirty = false;
    state.saveFailed = false;
    clearError();
    renderHeader();
    renderInspector();
    await refreshRecent();
    announce('새 폴더에 프로젝트 사본을 저장했습니다.');
  } catch (error) {
    if (state.project?.id === projectId) showError(safeTextError(error, '다른 폴더에 저장하지 못했습니다. 쓰기 권한과 남은 공간을 확인해 주세요.'));
  } finally {
    saveAsInProgress = false;
    if (state.project?.id === projectId && state.dirty) scheduleAutosave();
  }
}

async function exportPNG(): Promise<void> {
  const project = state.project;
  const snapshot = state.snapshot;
  if (!project || !snapshot) return;
  const token = captureEditToken(snapshot);
  try {
    const result = value(await desktop().exportPNG(project.id, snapshot.working), 'PNG 파일을 저장하지 못했습니다.');
    if (!result || !isEditTokenCurrent(token)) {
      if (result && state.project?.id === project.id) showError(`PNG는 이전 작업 버전으로 저장했습니다: ${result.path}. 현재 편집 내용은 유지됩니다.`);
      return;
    }
    state.exportResult = result;
    renderInspector();
    announce(`PNG를 ${result.path}에 저장했습니다. 크기 ${result.width} 곱하기 ${result.height} 픽셀입니다.`);
  } catch (error) {
    showError(safeTextError(error, 'PNG를 저장하지 못했습니다. 다른 폴더를 선택하거나 저장 공간을 확인해 주세요.'));
  }
}

async function openProjectFolder(requestId?: string): Promise<void> {
  const project = state.project;
  if (!project) return;
  try {
    value(await desktop().openFolder(project.id, requestId), '저장 폴더를 열지 못했습니다.');
  } catch (error) {
    showError(safeTextError(error, '저장 폴더를 열지 못했습니다. 프로젝트를 다시 열어 주세요.'));
  }
}

async function panelAction(action: string, target: HTMLElement): Promise<void> {
  clearError();
  switch (action) {
    case 'auto-clean': await runAutomaticCleanup(); break;
    case 'go-export': setPanel('export'); break;
    case 'fill-white': await fillCurrentSelection({ kind: 'white' }); break;
    case 'fill-sample': if (state.sampledPoint) await fillCurrentSelection({ kind: 'sample', point: state.sampledPoint }); break;
    case 'select-all': await setWholeImageSelection(true); break;
    case 'clear-selection': await setWholeImageSelection(false); break;
    case 'sample-color': toolBeforeSample = state.tool; setTool('sample'); announce('사진에서 배경색을 찍으세요.'); break;
    case 'preview-adjust': await previewAdjustment(); break;
    case 'apply-adjust': if (state.adjustmentPreview) commitFromEngine(state.adjustmentPreview); state.adjustmentPreview = null; renderInspector(); renderCanvas(); break;
    case 'cancel-adjust': state.adjustmentPreview = null; renderInspector(); renderCanvas(); break;
    case 'create-request': await createRequestFiles(); break;
    case 'copy-request': if (state.project && state.requestId) await withBridge(() => desktop().copyRequest(state.project!.id, state.requestId), '요청 문구를 복사하지 못했습니다.'); break;
    case 'open-chatgpt': await withBridge(() => desktop().openChatGPT(), 'ChatGPT를 열지 못했습니다. 기본 브라우저를 확인해 주세요.'); break;
    case 'open-request-folder': await openProjectFolder(state.requestId || undefined); break;
    case 'select-request': {
      const id = target.dataset.requestId;
      if (id) await loadRequest(id, state.panel);
      break;
    }
    case 'import-candidate': await importCandidate(); break;
    case 'apply-candidate': await applyCandidateToSelection(); break;
    case 'fork-request': await forkAtRequest(); break;
    case 'save-project': await saveProjectNow(); break;
    case 'save-as': await saveProjectAs(); break;
    case 'export-png': await exportPNG(); break;
    case 'open-project-folder': await openProjectFolder(); break;
  }
}

async function withBridge<T>(operation: () => Promise<Reply<T>>, context: string): Promise<void> {
  try { value(await operation(), context); }
  catch (error) { showError(safeTextError(error, context)); }
}

async function fillCurrentSelection(fill: { kind: 'white' } | { kind: 'sample'; point: Point }): Promise<void> {
  if (!state.snapshot) return;
  const snapshot = state.snapshot;
  const token = captureEditToken(snapshot);
  try {
    const next = await runPixelJob({ type: 'fill', snapshot, fill }, fill.kind === 'white' ? '선택한 영역을 흰색으로 채우고 있습니다' : '선택한 영역을 배경색으로 채우고 있습니다') as Snapshot;
    commitWorkerSnapshot(next, token);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) showError(safeTextError(error, '선택 영역을 채우지 못했습니다. 삭제 범위를 표시해 주세요.'));
  }
}

async function setWholeImageSelection(selected: boolean): Promise<void> {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const token = captureEditToken(snapshot);
  const polygon = [
    { x: 0, y: 0 },
    { x: snapshot.working.width, y: 0 },
    { x: snapshot.working.width, y: snapshot.working.height },
    { x: 0, y: snapshot.working.height },
  ];
  try {
    const next = await runPixelJob({ type: 'lasso', snapshot, polygon, mode: selected ? 'inside' : 'outside' }, selected ? '전체 선택 범위를 계산하고 있습니다' : '선택 범위를 지우고 있습니다') as Snapshot;
    commitWorkerSnapshot(next, token);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) showError(safeTextError(error, '선택 범위를 바꾸지 못했습니다.'));
  }
}

async function previewAdjustment(): Promise<void> {
  if (!state.snapshot) return;
  const snapshot = state.snapshot;
  const token = captureEditToken(snapshot);
  try {
    const preview = await runPixelJob({
      type: 'adjust', snapshot,
      adjustment: { brightness: state.brightness, contrast: state.contrast },
    }, '밝기와 대비를 계산하고 있습니다') as Snapshot;
    if (!isEditTokenCurrent(token)) return;
    state.adjustmentPreview = preserveBasisPixels(preview, snapshot);
    renderCanvas();
    renderInspector();
    announce('미리보기를 확인한 뒤 적용 또는 취소를 선택하세요.');
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) showError(safeTextError(error, '미리보기를 만들지 못했습니다.'));
  }
}

let toolBeforeSample: Tool = 'delete';

function setSliderOutput(id: string, valueText: string): void {
  const output = inspector.querySelector<HTMLOutputElement>(`#${id}Output`);
  if (output) output.value = valueText;
  else {
    const input = inspector.querySelector<HTMLInputElement>(`#${id}`);
    if (input?.nextElementSibling) input.nextElementSibling.textContent = valueText;
  }
}

function changeAlignment(target: HTMLInputElement): void {
  if (target.id === 'alignScale') state.candidateScale = Number(target.value) / 100;
  else if (target.id === 'alignRotation') state.candidateRotation = Number(target.value);
  else if (target.id === 'alignX') state.candidateX = Number(target.value) || 0;
  else if (target.id === 'alignY') state.candidateY = Number(target.value) || 0;
  state.alignmentAcknowledged = false;
  renderCanvas();
  updateCandidateApplyButton();
  const output = target.parentElement?.querySelector('output');
  if (output) output.value = target.id === 'alignRotation' ? `${state.candidateRotation}°` : `${Math.round(state.candidateScale * 100)}%`;
}

function bindEvents(): void {
  $('#openButton').addEventListener('click', () => { void chooseImage(); });
  $('#emptyOpenButton').addEventListener('click', () => { void chooseImage(); });
  $('#openProjectButton').addEventListener('click', () => { void openSavedProject(); $('#projectMenu').setAttribute('hidden', ''); });
  $('#saveAsButton').addEventListener('click', () => { void saveProjectAs(); $('#projectMenu').setAttribute('hidden', ''); });
  $('#openProjectFolderButton').addEventListener('click', () => { void openProjectFolder(); $('#projectMenu').setAttribute('hidden', ''); });
  $('#moreMenuButton').addEventListener('click', () => $('#projectMenu').toggleAttribute('hidden'));
  $('#saveProjectButton').addEventListener('click', () => { void saveProjectNow(); });
  $('#undoButton').addEventListener('click', undo);
  $('#redoButton').addEventListener('click', redo);
  $('#refreshRecentButton').addEventListener('click', () => { void refreshRecent(); });
  $('#recentProjects').addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-recent-id]');
    if (target?.dataset.recentId) void openRecentProject(target.dataset.recentId);
  });
  $('#inspectorContent').addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    const action = target?.dataset.action;
    if (target && action) void panelAction(action, target);
  });
  $('#inspectorContent').addEventListener('input', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id === 'brightness') {
      state.brightness = Number(target.value);
      setSliderOutput('brightness', String(state.brightness));
    } else if (target.id === 'contrast') {
      state.contrast = Number(target.value);
      setSliderOutput('contrast', String(state.contrast));
    } else if (target.id.startsWith('align')) changeAlignment(target);
  });
  $('#inspectorContent').addEventListener('change', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id === 'alignmentAck') {
      state.alignmentAcknowledged = target.checked;
      updateCandidateApplyButton();
    } else if (target.name === 'comparison') {
      state.compareMode = target.value as CompareMode;
      fitView();
    }
  });
  document.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach(button => {
    button.addEventListener('click', () => setPanel(button.dataset.panel as Panel));
  });
  document.querySelectorAll<HTMLButtonElement>('button[data-tool]').forEach(button => {
    button.addEventListener('click', () => setTool(button.dataset.tool as Tool));
  });
  document.querySelectorAll<HTMLButtonElement>('[data-lasso]').forEach(button => {
    button.addEventListener('click', () => {
      state.lassoMode = button.dataset.lasso as 'inside' | 'outside';
      document.querySelectorAll<HTMLButtonElement>('[data-lasso]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    });
  });
  $('#cropButton').addEventListener('click', () => {
    state.cropRect = null;
    $('#applyCropButton').setAttribute('disabled', '');
    setTool(state.tool === 'crop' ? 'delete' : 'crop');
    $('#cropButton').textContent = state.tool === 'crop' ? '자르기 취소' : '사각형 자르기';
  });
  $('#applyCropButton').addEventListener('click', () => { void applyCrop(); });
  $('#rotateLeftButton').addEventListener('click', () => { void rotate(-90); });
  $('#rotateRightButton').addEventListener('click', () => { void rotate(90); });
  $('#fineRotation').addEventListener('input', event => {
    const input = event.currentTarget as HTMLInputElement;
    state.fineRotation = Number(input.value);
    $('#fineRotationOutput').textContent = `${state.fineRotation}°`;
    $('#applyFineRotationButton').toggleAttribute('disabled', state.fineRotation === 0);
  });
  $('#applyFineRotationButton').addEventListener('click', () => { void rotate(state.fineRotation); });
  $('#brushSize').addEventListener('input', event => {
    state.brushSize = Number((event.currentTarget as HTMLInputElement).value);
    $('#brushSizeValue').textContent = `${state.brushSize} px`;
    $('#brushSizeOutput').textContent = String(state.brushSize);
  });
  $('#brushStrength').addEventListener('input', event => {
    state.brushStrength = Number((event.currentTarget as HTMLInputElement).value);
    $('#brushStrengthOutput').textContent = `${state.brushStrength}%`;
  });
  $('#brushSoftness').addEventListener('input', event => {
    state.brushSoftness = Number((event.currentTarget as HTMLInputElement).value);
    $('#brushSoftnessOutput').textContent = `${state.brushSoftness}%`;
  });
  $('#zoomInButton').addEventListener('click', () => zoomAt(state.view.zoom * 1.2));
  $('#zoomOutButton').addEventListener('click', () => zoomAt(state.view.zoom / 1.2));
  $('#zoomReadout').addEventListener('click', fitView);
  $('#zoom100Button').addEventListener('click', () => zoomAt(1));
  $('#maskToggleButton').addEventListener('click', () => {
    state.showMasks = !state.showMasks;
    syncMaskToggle();
    renderCanvas();
  });
  $('#cancelJobButton').addEventListener('click', cancelWorker);
  $('#retrySaveButton').addEventListener('click', () => { state.saveFailed = false; void requestSave(); });
  $('#dismissErrorButton').addEventListener('click', clearError);
  stage.addEventListener('pointerdown', pointerDown);
  stage.addEventListener('pointermove', pointerMove);
  stage.addEventListener('pointerup', pointerUp);
  stage.addEventListener('pointercancel', pointerUp);
  stage.addEventListener('wheel', event => {
    if (!state.snapshot) return;
    event.preventDefault();
    const point = localPoint(event as unknown as PointerEvent);
    zoomAt(state.view.zoom * Math.pow(1.12, -event.deltaY / 100), point);
  }, { passive: false });
  stage.addEventListener('dragenter', event => { event.preventDefault(); $('#dropOverlay').removeAttribute('hidden'); });
  stage.addEventListener('dragover', event => { event.preventDefault(); });
  stage.addEventListener('dragleave', event => {
    if (!stage.contains(event.relatedTarget as Node | null)) $('#dropOverlay').setAttribute('hidden', '');
  });
  stage.addEventListener('drop', event => {
    event.preventDefault();
    $('#dropOverlay').setAttribute('hidden', '');
    const file = (event as DragEvent).dataTransfer?.files[0];
    if (file) void acceptDroppedFile(file);
  });
  document.addEventListener('keydown', keyDown);
  document.addEventListener('keyup', event => {
    if (event.code === 'Space') spaceDown = false;
    if (holdsSelectionAlt(event)) event.preventDefault();
  });
  document.addEventListener('click', event => {
    if (!$('#projectMenu').contains(event.target as Node) && event.target !== $('#moreMenuButton')) $('#projectMenu').setAttribute('hidden', '');
  });
  window.addEventListener('beforeunload', event => {
    if (!state.dirty && !pendingSave && !state.saveFailed && !worker) return;
    if (!window.confirm('저장되지 않은 변경사항이 있습니다. 마지막 정상 저장본을 보존하고 앱을 닫을까요?')) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  const observer = new ResizeObserver(() => {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => renderCanvas());
  });
  observer.observe(stage);
}

function undo(): void {
  if (!state.history) return;
  state.history = undoHistory(state.history);
  state.snapshot = historySnapshot(state.history);
  state.adjustmentPreview = null;
  state.dirty = true;
  state.saveFailed = false;
  if (state.project) state.project = { ...state.project, snapshot: state.snapshot };
  editRevision += 1;
  renderCanvas();
  renderInspector();
  scheduleAutosave();
  refreshEditSummary();
}

function redo(): void {
  if (!state.history) return;
  state.history = redoHistory(state.history);
  state.snapshot = historySnapshot(state.history);
  state.adjustmentPreview = null;
  state.dirty = true;
  state.saveFailed = false;
  if (state.project) state.project = { ...state.project, snapshot: state.snapshot };
  editRevision += 1;
  renderCanvas();
  renderInspector();
  scheduleAutosave();
  refreshEditSummary();
}

const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'color', 'file']);

function editingField(target: EventTarget | null): boolean {
  // Sliders keep focus after a drag; only text entry should swallow tool shortcuts.
  return (target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type)) || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

/** Windows hands an unhandled Alt to the menu bar, which would steal the next Alt-drag. */
function holdsSelectionAlt(event: KeyboardEvent): boolean {
  return event.key === 'Alt' && state.panel === 'edit' && SELECTION_TOOLS.includes(state.tool) && !editingField(event.target);
}

function keyDown(event: KeyboardEvent): void {
  if (holdsSelectionAlt(event)) { event.preventDefault(); return; }
  if (event.code === 'Space' && !editingField(event.target)) {
    spaceDown = true;
    event.preventDefault();
    return;
  }
  if (document.body.classList.contains('is-processing') && event.key.toLowerCase() !== 'escape') return;
  if (editingField(event.target) || event.altKey) return;
  const key = event.key.toLowerCase();
  const modifier = event.metaKey || event.ctrlKey;
  if (!cancelCurrentWorker && penKey(key)) { event.preventDefault(); return; }
  if (key === 'delete' || key === 'backspace') { event.preventDefault(); deleteSelection(); }
  else if (modifier && key === 'd') { event.preventDefault(); deselect(); }
  else if (key === '[' || key === ']') { event.preventDefault(); stepBrushSize(key === ']' ? 1 : -1); }
  else if (!modifier && TOOL_KEYS[key] && state.panel === 'edit') { event.preventDefault(); setTool(TOOL_KEYS[key]); }
  else if (key === 'o') { event.preventDefault(); void chooseImage(); }
  else if (key === 's') { event.preventDefault(); void saveProjectNow(); }
  else if (key === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
  else if (key === '+' || key === '=') { event.preventDefault(); zoomAt(state.view.zoom * 1.2); }
  else if (key === '-' || key === '_') { event.preventDefault(); zoomAt(state.view.zoom / 1.2); }
  else if (key === 'escape') {
    if (cancelCurrentWorker) cancelWorker();
    else if (state.tool === 'crop') {
      state.cropRect = null;
      endDraft();
      setTool('delete');
      $('#cropButton').textContent = '사각형 자르기';
      $('#applyCropButton').setAttribute('disabled', '');
    }
  }
}

bindEvents();
renderHeader();
renderCanvas();
renderInspector();
void refreshRecent();

