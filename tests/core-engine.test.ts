import { describe, expect, it, vi } from 'vitest';
import type { Pixels, Snapshot } from '../src/shared/types';
import {
  adjustSelection,
  applyCandidate,
  createGuide,
  createHistory,
  createSnapshot,
  commitHistory,
  cropBasis,
  eraseStroke,
  fillSelection,
  historySnapshot,
  imageToView,
  marqueeRect,
  paintStroke,
  redoHistory,
  restoreStroke,
  runPixelJob,
  rectPolygon,
  rotateBasis,
  selectLasso,
  undoHistory,
  viewToImage,
} from '../src/core/engine';
import type { PixelJob, PixelJobRequest, PixelJobResponse } from '../src/core/worker-protocol';

const pixels = (width: number, height: number, color: [number, number, number, number] = [0, 0, 0, 255]): Pixels => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set(color, i);
  return { width, height, data };
};

const clone = (value: Pixels): Pixels => ({ ...value, data: value.data.slice() });
const at = (value: Pixels, x: number, y: number): number[] => [...value.data.slice((y * value.width + x) * 4, (y * value.width + x) * 4 + 4)];
const snapshot = (width = 5, height = 5): Snapshot => createSnapshot(pixels(width, height), 'base-1');
const brush = { radius: 2, strength: 1, hardness: 1 };

describe('pixel snapshot invariants', () => {
  it('creates independent RGBA buffers and byte masks for a valid base', () => {
    const base = pixels(2, 1, [12, 34, 56, 78]);
    const state = createSnapshot(base, 'v1');
    state.working.data[0] = 255;
    state.deleteMask[0] = 255;
    expect(base.data[0]).toBe(12);
    expect(state.base.data[0]).toBe(12);
    expect(state.protectMask).toEqual(new Uint8Array(2));
  });

  it('rejects empty dimensions and buffers that do not match the pixel dimensions', () => {
    expect(() => createSnapshot(pixels(0, 2), 'v1')).toThrow();
    expect(() => createSnapshot({ width: 2, height: 2, data: new Uint8ClampedArray(4) }, 'v1')).toThrow();
  });

  it('keeps soft brush edges bounded and scales full coverage by strength', () => {
    const state = paintStroke(snapshot(), [{ x: 2.5, y: 2.5 }], { radius: 2.5, strength: 0.25, hardness: 0.5 }, 'delete');
    const center = state.deleteMask[2 * 5 + 2];
    const edge = state.deleteMask[2 * 5 + 4];
    expect(center).toBeGreaterThan(0);
    expect(center).toBeLessThanOrEqual(64);
    expect(edge).toBeGreaterThanOrEqual(0);
    expect(edge).toBeLessThan(center);
    expect(state.deleteMask[0]).toBe(0);
  });

  it('rasterizes a 500-point diagonal locally and applies opacity once per stroke', () => {
    const start = snapshot(1024, 1024);
    const points = Array.from({ length: 500 }, (_, index) => ({ x: 5 + index * 2.03, y: 5 + index * 2.03 }));
    const began = Date.now();
    const result = paintStroke(start, points, { radius: 4, strength: 0.4, hardness: 0.8 }, 'delete');
    const elapsed = Date.now() - began;
    const center = result.deleteMask[512 * 1024 + 512];
    expect(center).toBeGreaterThan(0);
    expect(center).toBeLessThanOrEqual(102);
    expect(elapsed).toBeLessThan(2000);
  });

  it('protecting restores base bytes and unselecting clears both masks without touching working pixels', () => {
    const start = snapshot(3, 1);
    start.working.data.fill(91);
    start.deleteMask.fill(255);
    const protectedState = paintStroke(start, [{ x: 1.5, y: 0.5 }], { radius: 1, strength: 0.5, hardness: 1 }, 'protect');
    expect(protectedState.protectMask[1]).toBe(255);
    expect(at(protectedState.working, 1, 0)).toEqual(at(protectedState.base, 1, 0));
    const cleared = paintStroke(protectedState, [{ x: 1.5, y: 0.5 }], { radius: 1, strength: 1, hardness: 1 }, 'unselect');
    expect(cleared.deleteMask[1]).toBe(0);
    expect(cleared.protectMask[1]).toBe(0);
    expect(at(cleared.working, 1, 0)).toEqual(at(protectedState.working, 1, 0));
  });

  it('restores brush pixels from B while leaving the masks intact', () => {
    const state = snapshot(3, 1);
    state.base.data.fill(17);
    state.working.data.fill(200);
    state.deleteMask.fill(255);
    state.protectMask[2] = 128;
    const restored = restoreStroke(state, [{ x: 1.5, y: 0.5 }], { radius: 0.6, strength: 1, hardness: 1 });
    expect(at(restored.working, 1, 0)).toEqual(at(restored.base, 1, 0));
    expect(restored.deleteMask).toEqual(state.deleteMask);
    expect(restored.protectMask).toEqual(state.protectMask);
  });

  it('selects lasso interior or exterior without overriding protection', () => {
    const start = snapshot(4, 4);
    start.protectMask[5] = 255;
    const polygon = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }];
    const inside = selectLasso(start, polygon, 'inside');
    expect(inside.deleteMask[0]).toBe(255);
    expect(inside.deleteMask[5]).toBe(255);
    expect(inside.protectMask[5]).toBe(255);
    const outside = selectLasso(start, polygon, 'outside');
    expect(outside.deleteMask[15]).toBe(255);
    expect(outside.deleteMask[0]).toBe(0);
  });

  it('applies white and sampled fill only through the effective mask', () => {
    const state = snapshot(3, 1);
    state.working.data.set([40, 40, 40, 255, 70, 70, 70, 255, 11, 22, 33, 44]);
    state.deleteMask.set([255, 255, 0]);
    state.protectMask[1] = 255;
    const white = fillSelection(state, { kind: 'white' });
    expect(at(white.working, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(at(white.working, 1, 0)).toEqual(at(state.base, 1, 0));
    expect(at(white.working, 2, 0)).toEqual(at(state.working, 2, 0));
    const sampled = fillSelection(state, { kind: 'sample', point: { x: 2.5, y: 0.5 } });
    expect(at(sampled.working, 0, 0)).toEqual([11, 22, 33, 44]);
  });

  it('applies brightness and contrast through D while protecting B exactly', () => {
    const state = snapshot(2, 1);
    state.base.data.set([23, 51, 92, 113, 23, 51, 92, 113]);
    state.working.data.set([23, 51, 92, 113, 23, 51, 92, 113]);
    state.deleteMask.set([255, 255]);
    state.protectMask[1] = 255;
    const adjusted = adjustSelection(state, { brightness: 40, contrast: 0 });
    expect(at(adjusted.working, 0, 0)).not.toEqual(at(state.working, 0, 0));
    expect(at(adjusted.working, 1, 0)).toEqual(at(state.base, 1, 0));
  });
});

describe('candidate and geometry operations', () => {
  it('preserves every zero-mask W byte and every fully protected B byte across randomized RGBA data', () => {
    let seed = 0x13579bdf;
    const byte = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed >>> 24; };
    const base = pixels(31, 17);
    const candidate = pixels(31, 17);
    const state = createSnapshot(base, 'random');
    for (let i = 0; i < base.data.length; i++) {
      state.base.data[i] = byte();
      state.working.data[i] = byte();
      candidate.data[i] = byte();
    }
    for (let i = 0; i < state.deleteMask.length; i++) {
      state.deleteMask[i] = byte();
      state.protectMask[i] = byte();
      if (i % 7 === 0) state.deleteMask[i] = 0;
      if (i % 11 === 0) {
        state.protectMask[i] = 255;
      }
      if (state.protectMask[i] === 255) state.working.data.set(state.base.data.subarray(i * 4, i * 4 + 4), i * 4);
    }
    const result = applyCandidate(state, candidate, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    for (let i = 0; i < state.deleteMask.length; i++) {
      const pixel = i * 4;
      if (state.deleteMask[i] === 0) expect([...result.working.data.slice(pixel, pixel + 4)]).toEqual([...state.working.data.slice(pixel, pixel + 4)]);
      if (state.protectMask[i] === 255) expect([...result.working.data.slice(pixel, pixel + 4)]).toEqual([...state.base.data.slice(pixel, pixel + 4)]);
    }
  });

  it('does not apply candidate pixels sampled outside the candidate bounds', () => {
    const state = snapshot(2, 1);
    state.working.data.fill(31);
    state.deleteMask.fill(255);
    const candidate = pixels(1, 1, [220, 180, 140, 100]);
    const result = applyCandidate(state, candidate, { a: 1, b: 0, c: 0, d: 1, e: 1, f: 0 });
    expect(at(result.working, 0, 0)).toEqual(at(state.working, 0, 0));
    expect(at(result.working, 1, 0)).toEqual([220, 180, 140, 100]);
  });

  it('uses D × (1 - P) for partial mask blending across all RGBA bytes', () => {
    const state = snapshot(1, 1);
    state.working.data.set([10, 20, 30, 40]);
    state.deleteMask[0] = 128;
    state.protectMask[0] = 64;
    const candidate = pixels(1, 1, [210, 220, 230, 240]);
    const result = applyCandidate(state, candidate, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    const amount = (128 / 255) * (1 - 64 / 255);
    expect(at(result.working, 0, 0)).toEqual([10, 20, 30, 40].map((value, channel) => Math.round(value * (1 - amount) + [210, 220, 230, 240][channel] * amount)));
  });

  it('round-trips image/view coordinates under zoom and pan', () => {
    const transform = { zoom: 2.5, panX: -31, panY: 18 };
    const point = { x: 21.25, y: 7.5 };
    expect(viewToImage(imageToView(point, transform), transform)).toEqual(point);
  });

  it('changes basis dimensions, transforms B and W separately, and resets masks', () => {
    const state = snapshot(3, 2);
    state.base.data.fill(30);
    state.working.data.fill(90);
    state.deleteMask.fill(255);
    state.protectMask.fill(255);
    const rotated = rotateBasis(state, 90);
    expect([rotated.base.width, rotated.base.height]).toEqual([2, 3]);
    expect(rotated.base.data[0]).toBe(30);
    expect(rotated.working.data[0]).toBe(90);
    expect(rotated.deleteMask).toEqual(new Uint8Array(6));
    expect(rotated.protectMask).toEqual(new Uint8Array(6));
    const cropped = cropBasis(rotated, { x: 0, y: 1, width: 1, height: 2 });
    expect([cropped.base.width, cropped.base.height]).toEqual([1, 2]);
    expect(cropped.working.data.every((v) => v === 90)).toBe(true);
  });

  it('builds guide pixels without changing the working image', () => {
    const state = snapshot(2, 1);
    state.deleteMask[0] = 255;
    state.protectMask[1] = 255;
    const before = clone(state.working);
    const guide = createGuide(state);
    expect(guide.width).toBe(2);
    expect(guide.data).not.toEqual(state.working.data);
    expect(state.working.data).toEqual(before.data);
  });
});

describe('undo and redo', () => {
  it('restores complete snapshots and gives every history transition a fresh workVersion', () => {
    const initial = snapshot(3, 2);
    const history = createHistory(initial);
    const historyBrush = { radius: 0.4, strength: 1, hardness: 1 };
    const edited = paintStroke(initial, [{ x: 1.5, y: 0.5 }], historyBrush, 'delete');
    const afterEdit = commitHistory(history, edited);
    const undo = undoHistory(afterEdit);
    expect(historySnapshot(undo).deleteMask).toEqual(initial.deleteMask);
    expect(historySnapshot(undo).workVersion).toBeGreaterThan(edited.workVersion);
    const redo = redoHistory(undo);
    expect(historySnapshot(redo).deleteMask).toEqual(edited.deleteMask);
    expect(historySnapshot(redo).workVersion).toBeGreaterThan(historySnapshot(undo).workVersion);
    const secondEdit = paintStroke(historySnapshot(redo), [{ x: 2.5, y: 1.5 }], historyBrush, 'delete');
    const twoEdits = commitHistory(redo, secondEdit);
    expect(twoEdits.past).toHaveLength(2);
    expect(historySnapshot(undoHistory(twoEdits)).deleteMask).toEqual(historySnapshot(redo).deleteMask);
    expect(commitHistory(twoEdits, historySnapshot(twoEdits))).toBe(twoEdits);
    const emptyHistory = createHistory(initial);
    expect(undoHistory(emptyHistory)).toBe(emptyHistory);
    expect(redoHistory(emptyHistory)).toBe(emptyHistory);
  });
});

describe('pixel worker jobs', () => {
  it('dispatches each supported job type', () => {
    const state = snapshot(3, 2);
    const jobs: PixelJob[] = [
      { type: 'guide', snapshot: state },
      { type: 'candidate', snapshot: state, candidate: pixels(3, 2), transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } },
      { type: 'stroke', snapshot: state, points: [{ x: 1.5, y: 0.5 }], brush, tool: 'delete' },
      { type: 'restore', snapshot: state, points: [{ x: 1.5, y: 0.5 }], brush },
      { type: 'erase', snapshot: state, points: [{ x: 1.5, y: 0.5 }], brush, fill: { kind: 'white' } },
      { type: 'lasso', snapshot: state, polygon: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }], mode: 'inside' },
      { type: 'rotate', snapshot: state, degrees: 90 },
      { type: 'crop', snapshot: state, rect: { x: 0, y: 0, width: 2, height: 2 } },
      { type: 'fill', snapshot: state, fill: { kind: 'white' } },
      { type: 'adjust', snapshot: state, adjustment: { brightness: 1, contrast: 0 } },
    ];
    for (const job of jobs) expect(runPixelJob(job)).toBeTruthy();
    expect(() => runPixelJob({ type: 'invalid' } as unknown as PixelJob)).toThrow();
  });

  it('runs a typed lasso job and reports incremental row progress', () => {
    const request: PixelJobRequest = {
      id: 'lasso-1',
      job: { type: 'lasso', snapshot: snapshot(3, 2), polygon: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], mode: 'inside' },
    };
    const progress: Array<[number, number]> = [];
    const value = runPixelJob(request.job, (completed, total) => progress.push([completed, total]));
    const response: PixelJobResponse = { id: request.id, type: 'result', value };
    expect(response.type).toBe('result');
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toEqual([2, 2]);
  });

  it('transfers each unique result buffer out of the worker', async () => {
    type WorkerHandler = (event: MessageEvent<PixelJobRequest>) => void;
    const messages: Array<{ response: PixelJobResponse; transfer?: Transferable[] }> = [];
    const fakeWorker = {
      onmessage: null as WorkerHandler | null,
      postMessage(response: PixelJobResponse, transfer?: Transferable[]) { messages.push({ response, transfer }); },
    };
    const previousSelf = Object.getOwnPropertyDescriptor(globalThis, 'self');
    Object.defineProperty(globalThis, 'self', { configurable: true, value: fakeWorker });
    try {
      vi.resetModules();
      await import('../src/core/pixel-worker');
      const state = snapshot(2, 2);
      fakeWorker.onmessage?.({
        data: { id: 'transfer-1', job: { type: 'lasso', snapshot: state, polygon: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }], mode: 'inside' } },
      } as MessageEvent<PixelJobRequest>);
      const result = [...messages].reverse().find(item => item.response.type === 'result');
      expect(result?.response.type).toBe('result');
      if (!result || result.response.type !== 'result' || !('base' in result.response.value)) throw new Error('Expected a snapshot result');
      const expected = new Set([
        result.response.value.base.data.buffer,
        result.response.value.working.data.buffer,
        result.response.value.deleteMask.buffer,
        result.response.value.protectMask.buffer,
      ]);
      expect(new Set(result.transfer)).toEqual(expected);
      expect(result.transfer).toHaveLength(expected.size);
    } finally {
      if (previousSelf) Object.defineProperty(globalThis, 'self', previousSelf);
      else Reflect.deleteProperty(globalThis, 'self');
    }
  });
});

describe('instant photoshop-style edits', () => {
  it('erases one stroke to white inside its bounds with a single version bump', () => {
    const start = snapshot(9, 9);
    const next = eraseStroke(start, [{ x: 4.5, y: 4.5 }], { radius: 1.5, strength: 1, hardness: 1 }, { kind: 'white' });
    expect(at(next.working, 4, 4)).toEqual([255, 255, 255, 255]);
    expect(at(next.working, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(at(next.working, 8, 8)).toEqual([0, 0, 0, 255]);
    expect(next.workVersion).toBe(start.workVersion + 1);
    expect(at(start.working, 4, 4)).toEqual([0, 0, 0, 255]);
    expect(next.deleteMask).toBe(start.deleteMask);
  });

  it('never erases fully protected pixels and scales partly protected ones', () => {
    const start = snapshot(3, 1);
    start.protectMask[0] = 255;
    start.protectMask[1] = 128;
    const next = eraseStroke(start, [{ x: 0.5, y: 0.5 }, { x: 2.5, y: 0.5 }], { radius: 2, strength: 1, hardness: 1 }, { kind: 'white' });
    expect(at(next.working, 0, 0)).toEqual([0, 0, 0, 255]);
    const partial = at(next.working, 1, 0)[0];
    expect(partial).toBeGreaterThan(100);
    expect(partial).toBeLessThan(155);
    expect(at(next.working, 2, 0)).toEqual([255, 255, 255, 255]);
  });

  it('erases with the sampled paper color and returns the same snapshot when nothing changes', () => {
    const start = snapshot(4, 1);
    start.working.data.set([200, 190, 180, 255], 3 * 4);
    const next = eraseStroke(start, [{ x: 0.5, y: 0.5 }], { radius: 1, strength: 1, hardness: 1 }, { kind: 'sample', point: { x: 3.5, y: 0.5 } });
    expect(at(next.working, 0, 0)).toEqual([200, 190, 180, 255]);
    expect(eraseStroke(start, [{ x: 0.5, y: 0.5 }], { radius: 1, strength: 0, hardness: 1 }, { kind: 'white' })).toBe(start);
    const white = createSnapshot(pixels(2, 1, [255, 255, 255, 255]), 'base-white');
    expect(eraseStroke(white, [{ x: 0.5, y: 0.5 }], brush, { kind: 'white' })).toBe(white);
    expect(() => eraseStroke(start, [{ x: 0.5, y: 0.5 }], brush, { kind: 'sample', point: { x: 9, y: 0 } })).toThrow(RangeError);
    expect(() => eraseStroke(start, [{ x: 0.5, y: 0.5 }], brush, { kind: 'paint' } as never)).toThrow(TypeError);
  });

  it('builds marquee rectangles from any drag direction with square and from-center modifiers', () => {
    expect(marqueeRect({ x: 8, y: 6 }, { x: 2, y: 1 })).toEqual({ x: 2, y: 1, width: 6, height: 5 });
    expect(marqueeRect({ x: 2, y: 2 }, { x: 8, y: 4 }, { square: true })).toEqual({ x: 2, y: 2, width: 6, height: 6 });
    expect(marqueeRect({ x: 2, y: 2 }, { x: 0, y: 6 }, { square: true })).toEqual({ x: -2, y: 2, width: 4, height: 4 });
    expect(marqueeRect({ x: 5, y: 5 }, { x: 7, y: 6 }, { fromCenter: true })).toEqual({ x: 3, y: 4, width: 4, height: 2 });
    expect(marqueeRect({ x: 5, y: 5 }, { x: 7, y: 6 }, { square: true, fromCenter: true })).toEqual({ x: 3, y: 3, width: 4, height: 4 });
  });

  it('selects a marquee rectangle and fills only that rectangle white', () => {
    const start = snapshot(6, 4);
    const selected = selectLasso(start, rectPolygon({ x: 1, y: 1, width: 3, height: 2 }), 'inside');
    const filled = fillSelection(selected, { kind: 'white' });
    expect(at(filled.working, 1, 1)).toEqual([255, 255, 255, 255]);
    expect(at(filled.working, 3, 2)).toEqual([255, 255, 255, 255]);
    expect(at(filled.working, 4, 1)).toEqual([0, 0, 0, 255]);
    expect(at(filled.working, 1, 3)).toEqual([0, 0, 0, 255]);
  });

  it('runs an erase job through the worker dispatcher', () => {
    const value = runPixelJob({ type: 'erase', snapshot: snapshot(3, 1), points: [{ x: 1.5, y: 0.5 }], brush: { radius: 0.5, strength: 1, hardness: 1 }, fill: { kind: 'white' } });
    if (!('working' in value)) throw new Error('Expected a snapshot');
    expect(at(value.working, 1, 0)).toEqual([255, 255, 255, 255]);
    expect(at(value.working, 0, 0)).toEqual([0, 0, 0, 255]);
  });
});
