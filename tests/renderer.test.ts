// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runPixelJob } from '../src/core/engine';
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
  const context = {
    createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData() {}, clearRect() {}, fillRect() {}, strokeRect() {}, beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, stroke() {}, fill() {}, setTransform() {}, setLineDash() {}, save() {}, restore() {},
  };
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => context });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 240, width: 320, height: 240, toJSON() {} }) });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('Worker', class {
    onmessage: ((event: { data: PixelJobResponse }) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    ended = false;
    postMessage(message: PixelJobRequest) {
      if (typeof message.id !== 'string') return;
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
  const makePixels = (color: number[]): Pixels => {
    const data = new Uint8ClampedArray(24 * 16 * 4);
    for (let i = 0; i < data.length; i += 4) data.set(color, i);
    return { width: 24, height: 16, data };
  };
  const id = '11111111-1111-4111-8111-111111111111';
  let project: Project | null = null;
  let request: RequestBundle | null = null;
  let exported: Pixels | null = null;
  let failWrites = false;
  let cloneCalls = 0;
  let delayedOpen = false;
  let releaseOpen: (() => void) | null = null;
  const ok = <T>(value: T): Reply<T> => ({ ok: true, value });
  const api: DesktopAPI = {
    importImage: async () => ok({ sourceId: id, name: '업무사진.png', pixels: makePixels([190, 180, 170, 255]) }),
    importDropped: async () => ok({ sourceId: id, name: '업무사진.png', pixels: makePixels([190, 180, 170, 255]) }),
    createProject: async (_sourceId, snapshot) => {
      project = { id, name: '업무사진', folder: 'C:\\LocalTest', snapshot: browserClone(snapshot), requests: [], recovered: false };
      return ok(browserClone(project));
    },
    listRecent: async () => ok([]), openProject: async () => {
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
    importCandidate: async (_id, requestId) => ok({ id: '33333333-3333-4333-8333-333333333333', requestId, name: 'result.png', pixels: makePixels([80, 110, 140, 255]) }),
    forkRequest: async () => { if (!project) throw new Error('Missing project'); return ok(browserClone(project)); },
    exportPNG: async (_id, pixels) => { exported = browserClone(pixels); return ok({ path: 'C:\\LocalTest\\result.png', width: pixels.width, height: pixels.height }); },
    openFolder: async () => ok(undefined), openChatGPT: async () => ok(undefined), copyRequest: async () => ok(undefined),
  };
  window.desktop = api;
  await import('../src/renderer/main');
  const click = (selector: string) => {
    const element = document.querySelector<HTMLButtonElement>(selector);
    expect(element, selector).not.toBeNull(); expect(element?.disabled, selector).toBe(false); element!.click();
  };
  const savedColor = () => [...project!.snapshot.working.data.slice(0, 4)];
  const waitForSaved = async (color: number[]) => { await vi.waitFor(() => expect(savedColor()).toEqual(color), { timeout: 6000 }); };
  click('#emptyOpenButton');
  await vi.waitFor(() => { expect(document.querySelector('#errorText')?.textContent).toBe(''); expect(document.querySelector('#imageDimensions')?.textContent).toContain('24'); });
  click('[data-action="select-all"]');
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="fill-white"]')?.disabled).toBe(false));
  click('[data-action="fill-white"]');
  await waitForSaved([255, 255, 255, 255]);
  click('#undoButton'); await waitForSaved([190, 180, 170, 255]);
  click('#redoButton'); await waitForSaved([255, 255, 255, 255]);
  click('#tabRequest'); click('[data-action="create-request"]');
  await vi.waitFor(() => expect(request).not.toBeNull());
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="copy-request"]')?.disabled).toBe(false));
  click('#tabReview'); click('[data-action="import-candidate"]');
  await vi.waitFor(() => expect(document.querySelector('#alignmentAck')).not.toBeNull());
  expect(document.querySelector<HTMLButtonElement>('[data-action="apply-candidate"]')?.disabled).toBe(true);
  const ack = document.querySelector<HTMLInputElement>('#alignmentAck')!;
  ack.checked = true; ack.dispatchEvent(new Event('change', { bubbles: true }));
  click('[data-action="apply-candidate"]');
  await waitForSaved([80, 110, 140, 255]);
  click('#tabExport'); click('[data-action="export-png"]');
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
  brightness.value = '-25'; brightness.dispatchEvent(new Event('input', { bubbles: true }));
  click('[data-action="preview-adjust"]');
  await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-action="apply-adjust"]')?.disabled).toBe(false));
  click('[data-action="apply-adjust"]');
  confirmAnswer = false;
  releaseOpen!();
  await vi.waitFor(() => expect(document.querySelector('#projectName')?.textContent).toBe('업무사진'));
  await waitForSaved([230, 230, 230, 255]);
}, 30_000);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
