// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runPixelJob } from '../src/core/engine';
import type { PixelJob } from '../src/core/engine';
import type { PixelJobRequest, PixelJobResponse } from '../src/core/worker-protocol';
import type { DesktopAPI, Pixels, Project, Reply, RequestBundle } from '../src/shared/types';

function browserClone<T>(value: T): T {
  // Emulate Chromium structured cloning into the target realm for typed arrays.
  if (ArrayBuffer.isView(value)) return (Object.prototype.toString.call(value) === '[object Uint8ClampedArray]' ? new Uint8ClampedArray(value as unknown as Uint8Array) : new Uint8Array(value as unknown as Uint8Array)) as T;
  if (Array.isArray(value)) return value.map(browserClone) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, browserClone(entry)])) as T;
  return value;
}

it('connects real renderer controls to worker edits, manual request review and PNG export', async () => {
  document.open();
  document.write(await readFile(`${process.cwd()}/index.html`, 'utf8'));
  document.close();
  let sceneFrame: { width: number; height: number; data: Uint8ClampedArray } | null = null;
  const context = {
    createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData() {}, clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fill() {}, setTransform() {}, setLineDash() {}, save() {}, restore() {},
  };
  const canvasContext = (canvas: HTMLCanvasElement) => ({
    ...context,
    putImageData(image: { width: number; height: number; data: Uint8ClampedArray }) {
      if (canvas.id === 'sceneCanvas') sceneFrame = { width: image.width, height: image.height, data: image.data.slice() };
    },
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: function (this: HTMLCanvasElement) { return canvasContext(this); } });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 240, width: 320, height: 240, toJSON() {} }) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const workerJobs: string[] = [];
  const pixelJobs: PixelJobRequest[] = [];
  let holdNextAutoClean = false;
  let delayedWorker: { onmessage: ((event: MessageEvent<PixelJobResponse>) => void) | null; terminate: () => void; ended: boolean } | null = null;
  let delayedWorkerRequest: PixelJobRequest | null = null;
  vi.stubGlobal('Worker', class {
    onmessage: ((event: { data: PixelJobResponse }) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    ended = false;
    postMessage(message: PixelJobRequest) {
      if (typeof message.id !== 'string') return;
      workerJobs.push(message.job.type);
      pixelJobs.push(message);
      if (message.job.type === 'auto-clean' && holdNextAutoClean) {
        holdNextAutoClean = false;
        delayedWorker = this;
        delayedWorkerRequest = message;
        return;
      }
      setTimeout(() => {
        if (this.ended) return;
        try { this.onmessage?.({ data: { id: message.id, type: 'result', value: runPixelJob(browserClone(message.job)) } }); }
        catch (error) { this.onerror?.({ message: String(error) } as ErrorEvent); }
      }, 0);
    }
    terminate() { this.ended = true; }
  });
  let confirmAnswer = true;
  vi.stubGlobal('confirm', () => confirmAnswer);
  const makePixels = (color: number[], width = 24, height = 16): Pixels => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) data.set(color, i);
    return { width, height, data };
  };
  let importedPhoto: Pixels | null = null;
  const detectedTextMask = new Uint8Array(24 * 16);
  let holdTextDetection = false;
  let failTextDetection = false;
  let releaseTextDetection: (() => void) | null = null;
  const textDetectionCalls: Array<{ requestId: string; pixels: Pixels }> = [];
  const textDetectionCancels: string[] = [];
  const makePhoto = (): Pixels => {
    const pixels = makePixels([190, 180, 170, 255]);
    pixels.data[pixels.data.length - 1] = 0;
    importedPhoto = pixels;
    return pixels;
  };
  const id = '11111111-1111-4111-8111-111111111111';
  let project: Project | null = null;
  let request: RequestBundle | null = null;
  let exported: Pixels | null = null;
  let failWrites = false;
  let cloneCalls = 0;
  let delayedOpen = false;
  let releaseOpen: (() => void) | null = null;
  let openProjectCalls = 0;
  const ok = <T>(value: T): Reply<T> => ({ ok: true, value });
  const api: DesktopAPI = {
    importImage: async () => ok({ sourceId: id, name: '업무사진.png', pixels: makePhoto() }),
    importDropped: async () => ok({ sourceId: id, name: '업무사진.png', pixels: makePhoto() }),
    createProject: async (_sourceId, snapshot) => {
      project = { id, name: '업무사진', folder: 'C:\\LocalTest', snapshot: browserClone(snapshot), requests: [], recovered: false };
      return ok(browserClone(project));
    },
    listRecent: async () => ok([]), openProject: async () => {
      openProjectCalls += 1;
      if (!delayedOpen) return ok(project);
      const next = { ...browserClone(project!), id: '44444444-4444-4444-8444-444444444444', name: '다른 작업' };
      return new Promise(resolve => { releaseOpen = () => resolve(ok(next)); });
    },
    openRecent: async () => project ? ok(browserClone(project)) : { ok: false, error: '프로젝트 없음' },
    saveProject: async (_id, snapshot) => {
      if (!project) throw new Error('Missing project');
      if (failWrites) return { ok: false, error: '디스크가 가득 찼습니다. 다른 폴더에 저장해 주세요.' };
      project.snapshot = browserClone(snapshot); return ok({ folder: project.folder });
    },
    saveProjectAs: async (_id, snapshot) => {
      cloneCalls += 1;
      project = { ...browserClone(project!), id: '55555555-5555-4555-8555-555555555555', snapshot: browserClone(snapshot), requests: [] };
      return ok(browserClone(project));
    },
    createRequest: async (_id, snapshot) => {
      if (!project) throw new Error('Missing project');
      const info = { id: '22222222-2222-4222-8222-222222222222', projectId: id, baseVersion: snapshot.baseVersion, workVersion: snapshot.workVersion, width: 24, height: 16, createdAt: new Date().toISOString(), folder: 'C:\\LocalTest\\request' };
      project.requests.push(info);
      request = { info, snapshot: browserClone(snapshot), text: '첫 번째 이미지 편집 · 빨강 삭제 · 파랑 보호' };
      return ok(browserClone(request));
    },
    loadRequest: async () => request ? ok(browserClone(request)) : { ok: false, error: '요청 없음' },
    importCandidate: async (_id, requestId) => ok({ id: '33333333-3333-4333-8333-333333333333', requestId, name: 'result.png', pixels: makePixels([80, 110, 140, 255], 240, 160) }),
    forkRequest: async () => { if (!project) throw new Error('Missing project'); return ok(browserClone(project)); },
    exportPNG: async (_id, pixels) => { exported = browserClone(pixels); return ok({ path: 'C:\\LocalTest\\result.png', width: pixels.width, height: pixels.height }); },
    openFolder: async () => ok(undefined), openChatGPT: async () => ok(undefined), copyRequest: async () => ok(undefined),
  };
  Object.assign(api, {
    detectText: async (pixels: Pixels, requestId: string): Promise<Reply<Uint8Array>> => {
      textDetectionCalls.push({ requestId, pixels: browserClone(pixels) });
      if (holdTextDetection) {
        holdTextDetection = false;
        return new Promise(resolve => { releaseTextDetection = () => resolve(ok(detectedTextMask.slice())); });
      }
      if (failTextDetection) {
        failTextDetection = false;
        return { ok: false, error: '로컬 글씨 분석을 마치지 못했습니다.' };
      }
      return ok(detectedTextMask.slice());
    },
    cancelTextDetection: async (requestId: string): Promise<Reply<void>> => {
      textDetectionCancels.push(requestId);
      return ok(undefined);
    },
  });
  window.desktop = api;
  await import('../src/renderer/main');
  const click = (selector: string) => {
    const element = document.querySelector<HTMLButtonElement>(selector);
    expect(element, selector).not.toBeNull(); expect(element?.disabled, selector).toBe(false); element!.click();
  };
  const savedColor = () => [...project!.snapshot.working.data.slice(0, 4)];
  const savedColorAt = (index: number) => [...project!.snapshot.working.data.slice(index * 4, index * 4 + 4)];
  const waitForSaved = async (color: number[]) => { await vi.waitFor(() => expect(savedColor()).toEqual(color), { timeout: 6000 }); };
  const waitForSavedAt = async (index: number, color: number[]) => { await vi.waitFor(() => expect(savedColorAt(index)).toEqual(color), { timeout: 6000 }); };
  click('#emptyOpenButton');
  await vi.waitFor(() => { expect(document.querySelector('#errorText')?.textContent).toBe(''); expect(document.querySelector('#imageDimensions')?.textContent).toContain('24'); });
  expect(workerJobs.filter(type => type === 'auto-clean')).toHaveLength(0);
  expect(textDetectionCalls).toHaveLength(0);
  expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('idle');
  expect(document.querySelector<HTMLButtonElement>('[data-action="auto-clean"]')?.textContent?.trim()).toBe('자동 정리');
  expect(document.querySelector('#maskToggleButton')?.getAttribute('aria-pressed')).toBe('false');
  const sceneColorAt = (x: number, y: number): number[] => {
    if (!sceneFrame) throw new Error('캔버스 프레임이 렌더링되지 않았습니다.');
    const offset = (y * sceneFrame.width + x) * 4;
    return [...sceneFrame.data.subarray(offset, offset + 4)];
  };
  expect(sceneColorAt(171, 127)).toEqual([255, 255, 255, 255]);
  const originalWorkVersion = project!.snapshot.workVersion;
  holdTextDetection = true;
  click('[data-action="auto-clean"]');
  await vi.waitFor(() => expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('running'));
  const cancelledDetectionId = textDetectionCalls.at(-1)!.requestId;
  expect(cancelledDetectionId).toMatch(/^[0-9a-f-]{36}$/i);
  expect((document.querySelector('#progressBar') as HTMLProgressElement).hasAttribute('value')).toBe(false);
  expect(document.querySelector('#progressText')?.textContent).not.toMatch(/%/);
  expect(document.querySelector<HTMLButtonElement>('#tabExport')?.disabled).toBe(true);
  expect(document.querySelector<HTMLButtonElement>('button[data-tool="delete"]')?.disabled).toBe(true);
  expect(workerJobs.filter(type => type === 'auto-clean')).toHaveLength(0);
  click('#cancelJobButton');
  await vi.waitFor(() => expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('cancelled'));
  await vi.waitFor(() => expect(textDetectionCancels).toContain(cancelledDetectionId));
  expect(project!.snapshot.workVersion).toBe(originalWorkVersion);
  expect(savedColor()).toEqual([190, 180, 170, 255]);
  expect(document.querySelector<HTMLButtonElement>('[data-action="select-all"]')?.disabled).toBe(false);
  releaseTextDetection!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(workerJobs.filter(type => type === 'auto-clean')).toHaveLength(0);
  expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('cancelled');

  failTextDetection = true;
  click('[data-action="auto-clean"]');
  await vi.waitFor(() => expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('failed'));
  expect(document.querySelector('#errorText')?.textContent).toContain('로컬 글씨 분석');
  expect(project!.snapshot.workVersion).toBe(originalWorkVersion);
  expect(savedColor()).toEqual([190, 180, 170, 255]);
  expect(workerJobs.filter(type => type === 'auto-clean')).toHaveLength(0);

  detectedTextMask[0] = 255;
  click('[data-action="auto-clean"]');
  await vi.waitFor(() => expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('complete'));
  await waitForSaved([255, 255, 255, 255]);
  expect(textDetectionCalls).toHaveLength(3);
  expect(new Set(textDetectionCalls.map(call => call.requestId)).size).toBe(3);
  expect(textDetectionCalls.every(call => /^[0-9a-f-]{36}$/i.test(call.requestId))).toBe(true);
  expect(textDetectionCalls[2].pixels.data.slice(0, 4)).toEqual(new Uint8ClampedArray([190, 180, 170, 255]));
  const successfulAutoJob = pixelJobs.filter(request => request.job.type === 'auto-clean').at(-1)!.job as PixelJob & { textMask?: Uint8Array };
  expect(successfulAutoJob.textMask).toEqual(detectedTextMask);
  expect(textDetectionCancels).toEqual([cancelledDetectionId]);
  click('#undoButton'); await waitForSaved([190, 180, 170, 255]);
  click('#redoButton'); await waitForSaved([255, 255, 255, 255]);

  const beforePixelCancelVersion = project!.snapshot.workVersion;
  const beforePixelCancelColor = savedColor();
  holdNextAutoClean = true;
  click('[data-action="auto-clean"]');
  await vi.waitFor(() => expect(workerJobs.filter(type => type === 'auto-clean')).toHaveLength(2));
  expect(document.querySelector<HTMLButtonElement>('#tabExport')?.disabled).toBe(true);
  click('#cancelJobButton');
  await vi.waitFor(() => expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('cancelled'));
  expect(project!.snapshot.workVersion).toBe(beforePixelCancelVersion);
  expect(savedColor()).toEqual(beforePixelCancelColor);
  const staleWorkerResult = runPixelJob(browserClone(delayedWorkerRequest!.job));
  delayedWorker!.onmessage?.({ data: { id: delayedWorkerRequest!.id, type: 'result', value: staleWorkerResult } } as MessageEvent<PixelJobResponse>);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('cancelled');
  expect(project!.snapshot.workVersion).toBe(beforePixelCancelVersion);
  expect(savedColor()).toEqual(beforePixelCancelColor);

  detectedTextMask.fill(0);
  click('[data-action="auto-clean"]');
  await vi.waitFor(() => expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('unchanged'));
  expect(document.querySelector('#autoCleanStatus')?.textContent?.trim()).toBe('자동으로 지울 범위를 확신하기 어려워 원본을 유지했습니다. 직접 수정할 수 있습니다.');
  expect(project!.snapshot.workVersion).toBe(beforePixelCancelVersion);
  click('#undoButton'); await waitForSaved([190, 180, 170, 255]);
  click('#redoButton'); await waitForSaved([255, 255, 255, 255]);

  click('button[data-tool="delete"]');
  expect(document.querySelector('#stage')?.hasAttribute('aria-pressed')).toBe(false);
  expect(document.querySelector('#stage')?.classList.contains('active')).toBe(false);
  click('[data-action="select-all"]');
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="fill-white"]')?.disabled).toBe(false));
  expect(sceneColorAt(149, 112)).toEqual([194, 145, 134, 255]);
  click('[data-action="fill-white"]');
  await waitForSavedAt(1, [255, 255, 255, 255]);
  expect([...importedPhoto!.data.slice(0, 4)]).toEqual([190, 180, 170, 255]);
  expect(importedPhoto!.data[importedPhoto!.data.length - 1]).toBe(0);
  click('#undoButton'); await waitForSavedAt(1, [190, 180, 170, 255]);
  click('#redoButton'); await waitForSavedAt(1, [255, 255, 255, 255]);
  click('#tabRequest'); click('[data-action="create-request"]');
  await vi.waitFor(() => expect(request).not.toBeNull());
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="copy-request"]')?.disabled).toBe(false));
  click('#tabReview'); click('[data-action="import-candidate"]');
  await vi.waitFor(() => expect(document.querySelector('#alignmentAck')).not.toBeNull());
  expect(document.querySelector('#zoomReadout')?.textContent).toBe('30%');
  expect(document.querySelector<HTMLButtonElement>('[data-action="apply-candidate"]')?.disabled).toBe(true);
  const overlayRadio = document.querySelector<HTMLInputElement>('input[name="comparison"][value="overlay"]')!;
  overlayRadio.checked = true; overlayRadio.dispatchEvent(new Event('change', { bubbles: true }));
  if (document.querySelector('#maskToggleButton')?.getAttribute('aria-pressed') === 'true') click('#maskToggleButton');
  expect(sceneColorAt(160, 120)).toEqual([135, 145, 155, 255]);
  const sideRadio = document.querySelector<HTMLInputElement>('input[name="comparison"][value="side"]')!;
  sideRadio.checked = true; sideRadio.dispatchEvent(new Event('change', { bubbles: true }));
  const ack = document.querySelector<HTMLInputElement>('#alignmentAck')!;
  ack.checked = true; ack.dispatchEvent(new Event('change', { bubbles: true }));
  click('[data-action="apply-candidate"]');
  await waitForSaved([80, 110, 140, 255]);
  click('#tabExport');
  await vi.waitFor(() => expect(sceneFrame?.width).toBe(320));
  expect(document.querySelector('#zoomReadout')?.textContent).toBe('100%');
  expect(sceneColorAt(160, 120)).not.toEqual([234, 238, 236, 255]);
  expect(sceneColorAt(1, 1)).toEqual([234, 238, 236, 255]);
  click('[data-action="export-png"]');
  await vi.waitFor(() => expect(exported).not.toBeNull());
  expect([...exported!.data.slice(0, 4)]).toEqual([80, 110, 140, 255]);
  expect(document.querySelector('#errorBanner')?.hasAttribute('hidden')).toBe(true);

  // A failed default destination must still allow saving the current pixels elsewhere.
  failWrites = true;
  click('#tabEdit'); click('[data-action="fill-white"]');
  await vi.waitFor(() => expect(document.querySelector('#errorText')?.textContent).toContain('디스크가 가득'), { timeout: 6000 });
  click('#moreMenuButton'); click('#saveAsButton');
  await vi.waitFor(() => expect(cloneCalls).toBe(1));
  await vi.waitFor(() => expect(document.querySelector('#saveState')?.textContent).toContain('저장됨'));
  expect(savedColor()).toEqual([255, 255, 255, 255]);
  expect(document.querySelector('#errorBanner')?.hasAttribute('hidden')).toBe(true);
  failWrites = false;

  // An IPC reply must not silently discard edits made while a project is opening.
  delayedOpen = true;
  click('#moreMenuButton'); click('#openProjectButton');
  await vi.waitFor(() => expect(releaseOpen).not.toBeNull());
  const brightness = document.querySelector<HTMLInputElement>('#brightness')!;
  document.querySelectorAll<HTMLDetailsElement>('.advanced-block')[1].open = true;
  brightness.value = '-25'; brightness.dispatchEvent(new Event('input', { bubbles: true }));
  click('[data-action="preview-adjust"]');
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="apply-adjust"]')?.disabled).toBe(false));
  click('[data-action="apply-adjust"]');
  confirmAnswer = false;
  releaseOpen!();
  await vi.waitFor(() => expect(document.querySelector('#projectName')?.textContent).toBe('업무사진'));
  await waitForSaved([230, 230, 230, 255]);
  const autoCleanCount = workerJobs.filter(type => type === 'auto-clean').length;
  delayedOpen = false;
  confirmAnswer = true;
  click('#moreMenuButton'); click('#openProjectButton');
  await vi.waitFor(() => expect(openProjectCalls).toBe(2));
  await vi.waitFor(() => expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('idle'));
  expect(workerJobs.filter(type => type === 'auto-clean')).toHaveLength(autoCleanCount);
}, 30_000);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
