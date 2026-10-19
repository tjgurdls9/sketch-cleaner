// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runPixelJob } from '../src/core/engine';
import type { PixelJobRequest, PixelJobResponse } from '../src/core/worker-protocol';
import type { DesktopAPI, Pixels, Project, Reply, Snapshot } from '../src/shared/types';

function browserClone<T>(value: T): T {
  if (ArrayBuffer.isView(value)) return (Object.prototype.toString.call(value) === '[object Uint8ClampedArray]' ? new Uint8ClampedArray(value as unknown as Uint8Array) : new Uint8Array(value as unknown as Uint8Array)) as T;
  if (Array.isArray(value)) return value.map(browserClone) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, browserClone(entry)])) as T;
  return value;
}

it('selects note candidates inside the figure after auto cleanup and shows them in red', async () => {
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
    const width = 400;
    const data = new Uint8ClampedArray(width * 400 * 4).fill(255);
    const paint = (x0: number, y0: number, x1: number, y1: number, color: number[], thickness = 4): void => {
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
      for (let step = 0; step <= steps; step += 1) {
        const cx = x0 + (x1 - x0) * step / steps;
        const cy = y0 + (y1 - y0) * step / steps;
        for (let y = Math.floor(cy - thickness / 2); y <= Math.ceil(cy + thickness / 2); y += 1) {
          for (let x = Math.floor(cx - thickness / 2); x <= Math.ceil(cx + thickness / 2); x += 1) data.set(color, (y * width + x) * 4);
        }
      }
    };
    const ink = [30, 30, 30, 255];
    paint(140, 60, 260, 72, ink); paint(140, 60, 110, 330, ink); paint(260, 72, 290, 330, ink);
    paint(110, 330, 200, 348, ink); paint(200, 348, 290, 330, ink); paint(200, 66, 222, 345, ink);
    paint(235, 180, 262, 180, [230, 20, 20, 255], 3);
    return { width, height: 400, data };
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
    detectText: async (pixels: Pixels) => ok(new Uint8Array(pixels.width * pixels.height)),
  } as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (async () => ok(undefined)) }) as unknown as DesktopAPI;
  window.desktop = api;
  await import('../src/renderer/main');



  document.querySelector<HTMLButtonElement>('#emptyOpenButton')!.click();
  await vi.waitFor(() => expect(document.querySelector('#imageDimensions')?.textContent).toContain('400'));
  document.querySelector<HTMLButtonElement>('[data-action="auto-clean"]')!.click();
  await vi.waitFor(() => expect(document.querySelector('#autoCleanStatus')?.getAttribute('data-state')).toBe('review'), { timeout: 6000 });
  expect(document.querySelector('#autoCleanStatus')?.textContent).toContain('Delete');
  expect(document.querySelector('#maskToggleButton')?.getAttribute('aria-pressed')).toBe('true');
  await vi.waitFor(() => expect(project!.snapshot.deleteMask[180 * 400 + 248]).toBe(255), { timeout: 6000 });
  // Candidates are only selected: the red mark is still on the page until Delete.
  const offset = (180 * 400 + 248) * 4;
  expect([...project!.snapshot.working.data.slice(offset, offset + 4)]).toEqual([230, 20, 20, 255]);
}, 30_000);

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
