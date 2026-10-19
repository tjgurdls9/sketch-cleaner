import { describe, expect, it } from 'vitest';
import type { Pixels, Snapshot } from '../src/shared/types';
import {
  adjustSelection,
  applyCandidate,
  createGuide,
  createHistory,
  createSnapshot,
  commitHistory,
  cropBasis,
  fillSelection,
  historySnapshot,
  imageToView,
  paintStroke,
  redoHistory,
  restoreStroke,
  runPixelJob,
  rotateBasis,
  selectLasso,
  undoHistory,
  viewToImage,
} from '../src/core/engine';
import type { PixelJobRequest, PixelJobResponse } from '../src/core/worker-protocol';

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
    const state = paintStroke(snapshot(), [{ x: 2.5, y: 2.5 }], { radius: 3, strength: 0.25, hardness: 0.5 }, 'delete');
    const center = state.deleteMask[2 * 5 + 2];
    const edge = state.deleteMask[2 * 5 + 4];
    expect(center).toBeGreaterThan(0);
    expect(center).toBeLessThanOrEqual(64);
    expect(edge).toBeGreaterThanOrEqual(0);
    expect(edge).toBeLessThan(center);
    expect(state.deleteMask[0]).toBe(0);
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
        state.working.set(state.base.subarray(i * 4, i * 4 + 4), i * 4);
      }
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
    const edited = paintStroke(initial, [{ x: 1.5, y: 0.5 }], brush, 'delete');
    const afterEdit = commitHistory(history, edited);
    const undo = undoHistory(afterEdit);
    expect(historySnapshot(undo).deleteMask).toEqual(initial.deleteMask);
    expect(historySnapshot(undo).workVersion).toBeGreaterThan(edited.workVersion);
    const redo = redoHistory(undo);
    expect(historySnapshot(redo).deleteMask).toEqual(edited.deleteMask);
    expect(historySnapshot(redo).workVersion).toBeGreaterThan(historySnapshot(undo).workVersion);
  });
});

describe('pixel worker jobs', () => {
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
});
