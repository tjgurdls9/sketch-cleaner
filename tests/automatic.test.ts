import { describe, expect, it } from 'vitest';
import type { Pixels, Snapshot } from '../src/shared/types';
import { createSnapshot, runPixelJob } from '../src/core/engine';
import { autoCleanDraft, isSheetFrame, withoutSheetFrames } from '../src/core/automatic';

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const BLACK: [number, number, number, number] = [24, 24, 24, 255];
const RED: [number, number, number, number] = [245, 24, 22, 255];

function canvas(width: number, height: number, color = WHITE): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(color, offset);
  return { width, height, data };
}

function put(pixels: Pixels, x: number, y: number, color: readonly number[]): void {
  pixels.data.set(color, (y * pixels.width + x) * 4);
}

function line(pixels: Pixels, x0: number, y0: number, x1: number, y1: number, color: readonly number[]): void {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let step = 0; step <= steps; step += 1) {
    const t = steps ? step / steps : 0;
    put(pixels, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), color);
  }
}

function shirt(pixels: Pixels, left: number): void {
  const points: [number, number][] = [
    [left, 29], [left + 8, 21], [left + 15, 25], [left + 22, 21], [left + 30, 29],
    [left + 26, 43], [left + 23, 40], [left + 23, 76], [left + 7, 76],
    [left + 7, 40], [left + 4, 43], [left, 29],
  ];
  for (let index = 0; index + 1 < points.length; index += 1) {
    line(pixels, ...points[index], ...points[index + 1], BLACK);
  }
}

function garmentPage(): Pixels {
  const page = canvas(120, 100);
  shirt(page, 27);
  shirt(page, 68);
  // Detached stitch and button marks are details inside the two keep regions.
  put(page, 39, 51, BLACK);
  put(page, 79, 55, BLACK);
  put(page, 36, 60, RED);
  // Small exterior text, a ruled table, a red annotation arrow, and a gray paper shadow.
  line(page, 7, 8, 11, 16, BLACK);
  put(page, 6, 8, [190, 190, 190, 255]);
  line(page, 11, 16, 15, 8, BLACK);
  line(page, 9, 12, 13, 12, BLACK);
  for (const y of [83, 89, 95]) line(page, 2, y, 19, y, BLACK);
  for (const x of [2, 10, 19]) line(page, x, 83, x, 95, BLACK);
  line(page, 7, 25, 20, 25, RED);
  line(page, 7, 25, 12, 21, RED);
  line(page, 7, 25, 12, 29, RED);
  for (let y = 2; y < 6; y += 1) for (let x = 2; x < 22; x += 1) put(page, x, y, [232, 232, 232, 255]);
  return page;
}

function draft(snapshot: Snapshot, progress?: (completed: number, total: number) => void): Snapshot {
  return runPixelJob({ type: 'auto-clean', snapshot }, progress) as Snapshot;
}

function rgba(pixels: Pixels, x: number, y: number): number[] {
  return [...pixels.data.subarray((y * pixels.width + x) * 4, (y * pixels.width + x) * 4 + 4)];
}

function mask(width: number, height: number, points: readonly [number, number][]): Uint8Array {
  const result = new Uint8Array(width * height);
  for (const [x, y] of points) result[y * width + x] = 255;
  return result;
}

describe('automatic cleanup draft', () => {
  it('uses the supplied text mask independently of existing delete coverage and preserves unrelated dark edits', () => {
    const imported = canvas(120, 100);
    shirt(imported, 42);
    put(imported, 8, 12, [24, 74, 168, 255]); // colored text pixel outside the figure
    line(imported, 4, 82, 22, 82, BLACK); // unknown dark line that the text model did not select
    const snapshot = createSnapshot(imported, 'base-model-mask');
    const textIndex = 12 * 120 + 8;
    const unknownIndex = 82 * 120 + 12;
    snapshot.deleteMask[textIndex] = 255;
    snapshot.deleteMask[unknownIndex] = 255;
    snapshot.working.data.set([70, 80, 90, 255], unknownIndex * 4);
    const textMask = mask(120, 100, [[8, 12]]);
    const beforeUnknown = rgba(snapshot.working, 12, 82);

    const result = autoCleanDraft(snapshot, undefined, textMask);

    expect(result.workVersion).toBe(snapshot.workVersion + 1);
    expect(rgba(result.working, 8, 12)).toEqual(WHITE);
    expect(result.deleteMask[textIndex]).toBe(255);
    expect(rgba(result.working, 12, 82)).toEqual(beforeUnknown);
    expect(rgba(result.working, 55, 35)).toEqual(rgba(imported, 55, 35));
    expect(snapshot.working.data[textIndex * 4]).toBe(24);
  });

  it('applies text cleanup as A times one-minus-P and restores fully protected bytes from B', () => {
    const imported = canvas(120, 100);
    shirt(imported, 42);
    put(imported, 8, 12, [24, 74, 168, 255]);
    put(imported, 9, 12, [140, 90, 40, 255]);
    const snapshot = createSnapshot(imported, 'base-model-protection');
    const softIndex = 12 * 120 + 8;
    const fullIndex = 12 * 120 + 9;
    snapshot.protectMask[softIndex] = 128;
    snapshot.protectMask[fullIndex] = 255;
    snapshot.working.data.set([20, 30, 40, 77], fullIndex * 4);
    const textMask = mask(120, 100, [[8, 12], [9, 12]]);

    const result = autoCleanDraft(snapshot, undefined, textMask);

    const amount = 1 - 128 / 255;
    const source = [24, 74, 168, 255];
    const soft = rgba(result.working, 8, 12);
    expect(soft).toEqual(source.map((channel) => Math.round(channel * (1 - amount) + 255 * amount)));
    expect(rgba(result.working, 9, 12)).toEqual(rgba(snapshot.base, 9, 12));
    expect(result.deleteMask[softIndex]).toBe(255);
    expect(result.deleteMask[fullIndex]).toBe(255);
  });

  it('rejects malformed AI masks before changing the snapshot', () => {
    const snapshot = createSnapshot(canvas(120, 100), 'base-invalid-model-mask');
    expect(() => autoCleanDraft(snapshot, undefined, new Uint8Array(2))).toThrow(/mask/i);
    const nonBinary = new Uint8Array(120 * 100);
    nonBinary[5] = 1;
    expect(() => autoCleanDraft(snapshot, undefined, nonBinary)).toThrow(/mask/i);
    expect(snapshot.workVersion).toBe(0);
  });

  it('preserves working pixels when the model mask and confident supplemental regions are empty', () => {
    const imported = canvas(120, 100);
    shirt(imported, 42);
    put(imported, 8, 12, [24, 74, 168, 255]);
    const snapshot = createSnapshot(imported, 'base-empty-model-mask');
    snapshot.deleteMask[12 * 120 + 8] = 255;
    snapshot.working.data.set([40, 50, 60, 255], (12 * 120 + 8) * 4);
    const before = snapshot.working.data.slice();

    const result = autoCleanDraft(snapshot, undefined, new Uint8Array(120 * 100));

    expect(result).toBe(snapshot);
    expect(snapshot.working.data).toEqual(before);
  });

  it('keeps two garment figures and disconnected interior details while removing exterior text, table, red ink, and paper shadow', () => {
    const imported = garmentPage();
    const snapshot = createSnapshot(imported, 'base-auto');
    const originalBase = snapshot.base.data.slice();
    const before = snapshot.working.data.slice();

    const result = draft(snapshot);

    expect(result.base).toBe(snapshot.base);
    expect(result.base.data).toEqual(originalBase);
    expect(result.workVersion).toBe(snapshot.workVersion + 1);
    expect(rgba(result.working, 27, 29)).toEqual(rgba(imported, 27, 29));
    expect(rgba(result.working, 39, 51)).toEqual(rgba(imported, 39, 51));
    expect(rgba(result.working, 79, 55)).toEqual(rgba(imported, 79, 55));
    expect(rgba(result.working, 36, 60)).toEqual(rgba(imported, 36, 60));
    expect(rgba(result.working, 10, 12)).toEqual(WHITE);
    expect(result.deleteMask[12 * 120 + 10]).toBeGreaterThan(0);
    expect(rgba(result.working, 6, 8)).toEqual(WHITE);
    expect(rgba(result.working, 10, 89)).toEqual(WHITE);
    expect(result.deleteMask[89 * 120 + 10]).toBeGreaterThan(0);
    expect(rgba(result.working, 10, 25)).toEqual(WHITE);
    expect(result.deleteMask[25 * 120 + 10]).toBeGreaterThan(0);
    expect(rgba(result.working, 10, 3)).toEqual(WHITE);
    expect(rgba(result.base, 10, 12)).toEqual(rgba(imported, 10, 12));
    expect(rgba(result.base, 10, 25)).toEqual(rgba(imported, 10, 25));
    expect(snapshot.working.data).toEqual(before);
  });

  it('uses protect as D times one-minus-P and restores full protection byte-exactly from B', () => {
    const base = canvas(120, 100, [251, 250, 249, 255]);
    const working = canvas(120, 100);
    shirt(working, 42);
    for (let x = 8; x <= 28; x += 1) put(working, x, 14, RED);
    const snapshot = createSnapshot(base, 'base-protect');
    snapshot.working = working;
    snapshot.protectMask[14 * 120 + 18] = 128;
    snapshot.protectMask[14 * 120 + 19] = 255;

    const result = draft(snapshot);

    const softIndex = 14 * 120 + 18;
    const softOffset = softIndex * 4;
    const amount = (result.deleteMask[softIndex] / 255) * (1 - 128 / 255);
    expect(result.working.data[softOffset]).toBe(Math.round(245 * (1 - amount) + 255 * amount));
    expect(result.working.data[softOffset + 1]).toBe(Math.round(24 * (1 - amount) + 255 * amount));
    expect(rgba(result.working, 19, 14)).toEqual(rgba(base, 19, 14));
    expect(draft(result)).toBe(result);
  });

  it('does not reapply old delete coverage to retained figure pixels or soft-protected details', () => {
    const imported = garmentPage();
    const snapshot = createSnapshot(imported, 'base-manual-mask');
    const opaqueOffset = (35 * 120 + 45) * 4;
    const softOffset = (51 * 120 + 39) * 4;
    snapshot.working.data.set([130, 131, 132, 255], opaqueOffset);
    snapshot.working.data.set([175, 176, 177, 255], softOffset);
    snapshot.deleteMask[35 * 120 + 45] = 255;
    snapshot.deleteMask[51 * 120 + 39] = 180;
    snapshot.protectMask[51 * 120 + 39] = 128;
    const retainedOpaque = rgba(snapshot.working, 45, 35);
    const retainedSoft = rgba(snapshot.working, 39, 51);

    const result = draft(snapshot);

    expect(rgba(result.working, 45, 35)).toEqual(retainedOpaque);
    expect(rgba(result.working, 39, 51)).toEqual(retainedSoft);
    expect(result.deleteMask[35 * 120 + 45]).toBe(255);
    expect(result.deleteMask[51 * 120 + 39]).toBe(180);
  });

  it('returns the identical snapshot when no confident figure or editable ink exists', () => {
    const blank = createSnapshot(canvas(80, 60), 'base-blank');
    expect(draft(blank)).toBe(blank);

    const tableOnly = canvas(120, 90);
    for (const y of [16, 28, 40, 52, 64, 76]) line(tableOnly, 8, y, 112, y, BLACK);
    for (const x of [8, 34, 60, 86, 112]) line(tableOnly, x, 16, x, 76, BLACK);
    const adversarial = createSnapshot(tableOnly, 'base-grid');
    expect(draft(adversarial)).toBe(adversarial);
  });

  it('is deterministic, preserves existing protection masks, and does not mutate inputs', () => {
    const source = createSnapshot(canvas(120, 100), 'base-repeat');
    const imported = garmentPage();
    source.base.data.set(imported.data);
    source.working.data.set(imported.data);
    source.deleteMask[50 * 120 + 39] = 96;
    source.protectMask[51 * 120 + 39] = 192;
    const baseBefore = source.base.data.slice();
    const workingBefore = source.working.data.slice();
    const deleteBefore = source.deleteMask.slice();
    const protectBefore = source.protectMask.slice();

    const first = draft(source);
    const second = draft(source);

    expect(first.working.data).toEqual(second.working.data);
    expect(first.deleteMask).toEqual(second.deleteMask);
    expect(first.protectMask).toEqual(protectBefore);
    expect(source.base.data).toEqual(baseBefore);
    expect(source.working.data).toEqual(workingBefore);
    expect(source.deleteMask).toEqual(deleteBefore);
    expect(source.protectMask).toEqual(protectBefore);
  });

  it('analyzes a 20MP blank without building a full-resolution analysis map', () => {
    const width = 5_000;
    const height = 4_000;
    const base = canvas(width, height);
    const snapshot: Snapshot = {
      base, working: base, deleteMask: new Uint8Array(width * height), protectMask: new Uint8Array(width * height),
      baseVersion: 'base-20mp', workVersion: 0,
    };
    const began = performance.now();
    expect(draft(snapshot)).toBe(snapshot);
    expect(performance.now() - began).toBeLessThan(20_000);
  }, 30_000); // The budget above is the check; slow CI runners need more than the 5s default.
});

describe('sheet frame left after splitting off the form', () => {
  // Bounds measured on a real photo: an 840 x 1190 analysis grid.
  const grid = { width: 840, height: 1190 };
  const bounds = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom, count: 1 });

  it('is the scanner bed or board around the sheet when it reaches three or four edges', () => {
    expect(isSheetFrame(bounds(5, 5, 834, 1184), grid.width, grid.height)).toBe(true);
    expect(isSheetFrame(bounds(3, 2, 836, 700), grid.width, grid.height)).toBe(true);
  });

  it('drops a frame from the figures only when figures of their own are left', () => {
    const frame = { id: 950, bounds: bounds(5, 5, 834, 1184) };
    const skirt = { id: 1022, bounds: bounds(87, 387, 316, 745) };
    const frames = new Set([950]);
    expect(withoutSheetFrames([frame, skirt], frames)).toEqual({ anchors: [skirt], dropped: [950] });
    // A cut-out garment pasted on a backdrop: the backdrop part holds the garment itself.
    expect(withoutSheetFrames([frame], frames)).toEqual({ anchors: [frame], dropped: [] });
  });

  it('is a figure when it stays inside the sheet or is cut by one or two edges of the photo', () => {
    expect(isSheetFrame(bounds(87, 387, 316, 745), grid.width, grid.height)).toBe(false);
    expect(isSheetFrame(bounds(0, 500, 400, 1189), grid.width, grid.height)).toBe(false);
  });
});
