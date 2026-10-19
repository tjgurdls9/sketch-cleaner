// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runPixelJob } from '../src/core/engine';
import type { PixelJobRequest, PixelJobResponse } from '../src/core/worker-protocol';
import type { DesktopAPI, Pixels, Project, Reply, Snapshot } from '../src/shared/types';

const GRAY = [120, 120, 120, 255];
const WHITE = [255, 255, 255, 255];
// index.html stage is mocked to 320x240; a 24x16 image fits at zoom 1 with this offset.
const OFFSET = { x: 148, y: 112 };

function browserClone<T>(value: T): T {
  if (ArrayBuffer.isView(value)) return (Object.prototype.toString.call(value) === '[object Uint8ClampedArray]' ? new Uint8ClampedArray(value as unknown as Uint8Array) : new Uint8Array(value as unknown as Uint8Array)) as T;
  if (Array.isArray(value)) return value.map(browserClone) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, browserClone(entry)])) as T;
  return value;
}

it('edits instantly with eraser, marquee and pen tools and their shortcuts', async () => {
  document.open();
  document.write(await readFile(`${process.cwd()}/index.html`, 'utf8'));
  document.close();
  const noop = () => {};
  const context = {
    createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    putImageData: noop, clearRect: noop, fillRect: noop, strokeRect: noop, beginPath: noop, closePath: noop,
    moveTo: noop, lineTo: noop, arc: noop, stroke: noop, fill: noop, setTransform: noop, setLineDash: noop, save: noop, restore: noop, rect: noop,
  };
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => context });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 240, width: 320, height: 240, toJSON() {} }) });
  Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: noop });
  Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: noop });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const workerJobs: string[] = [];
  vi.stubGlobal('Worker', class {
    onmessage: ((event: { data: PixelJobResponse }) => void) | null = null;
    onerror: ((event: ErrorEvent) => void) | null = null;
    postMessage(message: PixelJobRequest) {
      workerJobs.push(message.job.type);
      setTimeout(() => this.onmessage?.({ data: { id: message.id, type: 'result', value: runPixelJob(browserClone(message.job)) } }), 0);
    }
    terminate() {}
  });
  vi.stubGlobal('confirm', () => true);

  const photo = (): Pixels => {
    const data = new Uint8ClampedArray(24 * 16 * 4);
    for (let i = 0; i < data.length; i += 4) data.set(GRAY, i);
    return { width: 24, height: 16, data };
  };
  const id = '11111111-1111-4111-8111-111111111111';
  let project: Project | null = null;
  const ok = <T>(value: T): Reply<T> => ({ ok: true, value });
  const api = new Proxy({
    importImage: async () => ok({ sourceId: id, name: '작업지.png', pixels: photo() }),
    createProject: async (_sourceId: string, snapshot: Snapshot) => {
      project = { id, name: '작업지', folder: 'C:\\LocalTest', snapshot: browserClone(snapshot), requests: [], recovered: false };
      return ok(browserClone(project));
    },
    saveProject: async (_id: string, snapshot: Snapshot) => { project!.snapshot = browserClone(snapshot); return ok({ folder: project!.folder }); },
    listRecent: async () => ok([]),
  } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (async () => ok(undefined)) }) as unknown as DesktopAPI;
  window.desktop = api;
  await import('../src/renderer/main');

  const stage = document.querySelector<HTMLElement>('#stage')!;
  const pointer = (type: string, x: number, y: number) => {
    const event = new MouseEvent(type, { clientX: OFFSET.x + x, clientY: OFFSET.y + y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    stage.dispatchEvent(event);
  };
  const drag = (from: [number, number], to: [number, number]) => {
    pointer('pointerdown', ...from);
    pointer('pointermove', (from[0] + to[0]) / 2, (from[1] + to[1]) / 2);
    pointer('pointermove', ...to);
    pointer('pointerup', ...to);
  };
  const key = (value: string, init: KeyboardEventInit = {}) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init }));
  const savedAt = (x: number, y: number) => [...project!.snapshot.working.data.slice((y * 24 + x) * 4, (y * 24 + x) * 4 + 4)];
  const waitSaved = (x: number, y: number, color: number[]) => vi.waitFor(() => expect(savedAt(x, y)).toEqual(color), { timeout: 6000 });
  const overlay = document.querySelector('#processingOverlay')!;

  document.querySelector<HTMLButtonElement>('#emptyOpenButton')!.click();
  await vi.waitFor(() => expect(project).not.toBeNull());
  await vi.waitFor(() => expect(document.querySelector('#imageDimensions')?.textContent).toContain('24'));
  const jobsBefore = workerJobs.length;

  // E: the eraser paints white immediately, without the processing overlay or a worker round trip.
  key('e');
  expect(document.querySelector('button[data-tool="erase"]')?.getAttribute('aria-pressed')).toBe('true');
  const size = document.querySelector<HTMLInputElement>('#brushSize')!;
  key('[');
  expect(Number(size.value)).toBeLessThan(32);
  key(']');
  expect(Number(size.value)).toBe(32);
  size.value = '2'; size.dispatchEvent(new Event('input', { bubbles: true }));
  const versionBefore = project!.snapshot.workVersion;
  drag([0.5, 8.5], [23.5, 8.5]);
  expect(overlay.hasAttribute('hidden')).toBe(true);
  await waitSaved(12, 8, WHITE);
  expect(savedAt(12, 0)).toEqual(GRAY);
  expect(project!.snapshot.workVersion).toBe(versionBefore + 1);
  key('z', { metaKey: true });
  await waitSaved(12, 8, GRAY);
  key('z', { metaKey: true, shiftKey: true });
  await waitSaved(12, 8, WHITE);

  // M: drag a rectangle, Delete fills it white; ⌘D clears the selection so Delete does nothing.
  key('m');
  drag([2, 2], [6, 6]);
  key('Delete');
  expect(overlay.hasAttribute('hidden')).toBe(true);
  await waitSaved(3, 3, WHITE);
  expect(savedAt(10, 3)).toEqual(GRAY);
  drag([10, 2], [14, 6]);
  key('d', { ctrlKey: true });
  key('Delete');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(savedAt(11, 3)).toEqual(GRAY);

  // P: straight-segment polygon; Backspace drops the last point, clicking the first point closes it.
  key('p');
  for (const [x, y] of [[16, 1], [22, 1], [9, 15], [22, 6]] as const) { pointer('pointerdown', x, y); pointer('pointerup', x, y); }
  key('Backspace');
  pointer('pointerdown', 16, 1); pointer('pointerup', 16, 1);
  key('Backspace');
  await waitSaved(20, 2, WHITE);
  expect(savedAt(22, 5)).toEqual(GRAY);

  // P with Enter, then Esc cancels an unfinished path without touching pixels.
  for (const [x, y] of [[1, 10], [6, 10], [6, 14]] as const) { pointer('pointerdown', x, y); pointer('pointerup', x, y); }
  key('Enter');
  key('Backspace');
  await waitSaved(5, 11, WHITE);
  for (const [x, y] of [[18, 10], [22, 10], [22, 14]] as const) { pointer('pointerdown', x, y); pointer('pointerup', x, y); }
  key('Escape');
  key('Enter');
  key('Delete');
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(savedAt(21, 11)).toEqual(GRAY);

  expect(workerJobs.slice(jobsBefore)).toEqual([]);
}, 30_000);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
