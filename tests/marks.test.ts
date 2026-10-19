import { describe, expect, it } from 'vitest';
import { findAnnotationInk } from '../src/core/marks';
import { splitRuledComponent } from '../src/core/ruled';
import { autoCleanDraft } from '../src/core/automatic';
import { createSnapshot } from '../src/core/engine';
import type { Pixels } from '../src/shared/types';

type Canvas = { width: number; height: number; ink: Uint8Array; colored: Uint8Array; text: Uint8Array };

const canvas = (width: number, height: number): Canvas => ({
  width, height, ink: new Uint8Array(width * height), colored: new Uint8Array(width * height), text: new Uint8Array(width * height),
});

/** Draws a stroke of the given thickness from (x0, y0) to (x1, y1). */
function stroke(target: Canvas, x0: number, y0: number, x1: number, y1: number, options: { thickness?: number; colored?: boolean } = {}): void {
  const thickness = options.thickness ?? 4;
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
  for (let step = 0; step <= steps; step += 1) {
    const cx = x0 + (x1 - x0) * step / steps;
    const cy = y0 + (y1 - y0) * step / steps;
    for (let y = Math.floor(cy - thickness / 2); y <= Math.ceil(cy + thickness / 2); y += 1) {
      for (let x = Math.floor(cx - thickness / 2); x <= Math.ceil(cx + thickness / 2); x += 1) {
        if (x < 0 || y < 0 || x >= target.width || y >= target.height || Math.hypot(x - cx, y - cy) > thickness / 2) continue;
        target.ink[y * target.width + x] = 1;
        if (options.colored) target.colored[y * target.width + x] = 1;
      }
    }
  }
}

function dashes(target: Canvas, x0: number, y0: number, x1: number, y1: number, options: { colored?: boolean } = {}): void {
  const length = Math.hypot(x1 - x0, y1 - y0);
  for (let at = 0; at + 10 <= length; at += 18) {
    const a = at / length;
    const b = (at + 10) / length;
    stroke(target, x0 + (x1 - x0) * a, y0 + (y1 - y0) * a, x0 + (x1 - x0) * b, y0 + (y1 - y0) * b, { thickness: 3, ...options });
  }
}

function writing(target: Canvas, left: number, top: number, right: number, bottom: number): void {
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) target.text[y * target.width + x] = 255;
}

const run = (target: Canvas): Uint8Array => findAnnotationInk(target, target.width, target.height);
const selected = (mask: Uint8Array, target: Canvas, x: number, y: number, radius = 2): boolean => {
  for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) if (mask[(y + dy) * target.width + x + dx]) return true;
  return false;
};

describe('note candidates inside a figure', () => {
  it('keeps drawing lines, dashed stitch lines, a stitch-end slash and a zipper wavy line', () => {
    const target = canvas(260, 260);
    stroke(target, 40, 10, 40, 250);
    dashes(target, 60, 10, 60, 250);
    stroke(target, 25, 120, 75, 90); // slash across the seam and its stitch line
    for (let y = 20; y < 230; y += 1) target.ink[y * 260 + Math.round(150 + 6 * Math.sin(y / 5))] = 1;
    for (let y = 20; y < 230; y += 1) for (const dx of [-1, 0, 1]) target.ink[y * 260 + Math.round(150 + 6 * Math.sin(y / 5)) + dx] = 1;
    stroke(target, 200, 10, 200, 250);
    const mask = run(target);
    expect(mask.some(Boolean)).toBe(false);
  });

  it('selects writing over the figure but not the drawing line that runs through it', () => {
    const target = canvas(200, 200);
    stroke(target, 100, 5, 100, 195);
    stroke(target, 80, 90, 90, 80); stroke(target, 90, 80, 88, 100); stroke(target, 106, 84, 118, 96); stroke(target, 118, 96, 108, 104);
    writing(target, 74, 74, 124, 108);
    const mask = run(target);
    expect(selected(mask, target, 85, 85)).toBe(true);
    expect(selected(mask, target, 112, 90)).toBe(true);
    expect(selected(mask, target, 100, 30)).toBe(false);
    expect(selected(mask, target, 100, 160)).toBe(false);
  });

  it('selects a leader from a note to the drawing and its arrowhead, not the line it points at', () => {
    const target = canvas(240, 200);
    stroke(target, 120, 5, 120, 195);
    stroke(target, 220, 20, 124, 100); // leader from the note down to the seam
    stroke(target, 124, 100, 136, 88, { thickness: 3 }); stroke(target, 124, 100, 140, 99, { thickness: 3 });
    stroke(target, 200, 10, 238, 14); writing(target, 196, 2, 239, 26);
    const mask = run(target);
    expect(selected(mask, target, 172, 60)).toBe(true);
    expect(selected(mask, target, 120, 40)).toBe(false);
    expect(selected(mask, target, 120, 160)).toBe(false);
  });

  it('selects a small detached scribble but leaves a lone straight tick', () => {
    const target = canvas(200, 200);
    stroke(target, 20, 5, 20, 195);
    for (let angle = 0; angle < Math.PI * 2; angle += 0.05) stroke(target, 100 + 9 * Math.cos(angle), 100 + 9 * Math.sin(angle), 100 + 9 * Math.cos(angle + 0.05), 100 + 9 * Math.sin(angle + 0.05), { thickness: 3 });
    stroke(target, 109, 100, 118, 82, { thickness: 3 });
    stroke(target, 150, 150, 160, 170, { thickness: 3 });
    const mask = run(target);
    expect(selected(mask, target, 91, 100)).toBe(true);
    expect(selected(mask, target, 155, 160)).toBe(false);
    expect(selected(mask, target, 20, 100)).toBe(false);
  });

  it('selects a coloured solid line and keeps coloured dashes', () => {
    const target = canvas(240, 120);
    stroke(target, 10, 30, 230, 34, { colored: true });
    dashes(target, 10, 80, 230, 80, { colored: true });
    const mask = run(target);
    expect(selected(mask, target, 120, 32)).toBe(true);
    expect(selected(mask, target, 15, 80, 1)).toBe(false);
  });

  it('returns an empty mask for blank paper', () => {
    const target = canvas(40, 40);
    expect(run(target).some(Boolean)).toBe(false);
  });
});

describe('form table split', () => {
  it('takes long ruled lines out of a table component and leaves the drawing that touched it', () => {
    const width = 300;
    const height = 300;
    const labels = new Int32Array(width * height);
    for (let x = 0; x < width; x += 1) labels[10 * width + x] = 1;
    for (let y = 0; y < height; y += 1) labels[y * width + 5] = 1;
    // A drawn sleeve touching the frame: two slanted strokes and a cuff.
    for (let y = 40; y < 100; y += 1) { labels[y * width + 6 + Math.round((y - 40) / 3)] = 1; labels[y * width + 30 + Math.round((y - 40) / 2)] = 1; }
    for (let x = 26; x <= 60; x += 1) labels[99 * width + x] = 1;
    const split = splitRuledComponent(labels, 1, { left: 0, top: 0, right: width - 1, bottom: height - 1 }, width, height);
    const ruled = new Set(split.ruled);
    expect(ruled.has(10 * width + 150)).toBe(true);
    expect(ruled.has(200 * width + 5)).toBe(true);
    const drawing = split.parts.find(part => part.includes(70 * width + 45));
    expect(drawing?.length).toBeGreaterThan(80);
    expect(ruled.has(70 * width + 45)).toBe(false);
  });
});

describe('automatic cleanup with note candidates', () => {
  const sheet = (draw: (data: Uint8ClampedArray, width: number) => void): Pixels => {
    const width = 400;
    const height = 400;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    draw(data, width);
    return { width, height, data };
  };
  const paint = (data: Uint8ClampedArray, width: number, x0: number, y0: number, x1: number, y1: number, color: number[], thickness = 4): void => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
    for (let step = 0; step <= steps; step += 1) {
      const cx = x0 + (x1 - x0) * step / steps;
      const cy = y0 + (y1 - y0) * step / steps;
      for (let y = Math.floor(cy - thickness / 2); y <= Math.ceil(cy + thickness / 2); y += 1) {
        for (let x = Math.floor(cx - thickness / 2); x <= Math.ceil(cx + thickness / 2); x += 1) data.set(color, (y * width + x) * 4);
      }
    }
  };
  const garment = (data: Uint8ClampedArray, width: number): void => {
    const ink = [30, 30, 30, 255];
    // A skirt: sloped waist, flared sides, curved hem and a slanted pleat line.
    paint(data, width, 140, 60, 260, 72, ink); paint(data, width, 140, 60, 110, 330, ink); paint(data, width, 260, 72, 290, 330, ink);
    paint(data, width, 110, 330, 200, 348, ink); paint(data, width, 200, 348, 290, 330, ink); paint(data, width, 200, 66, 222, 345, ink);
  };

  it('selects a red mark inside the figure without erasing it and leaves the drawing unselected', () => {
    const pixels = sheet((data, width) => { garment(data, width); paint(data, width, 235, 180, 262, 180, [230, 20, 20, 255], 3); });
    const result = autoCleanDraft(createSnapshot(pixels, 'base'));
    const at = (x: number, y: number): number => y * 400 + x;
    expect(result.deleteMask[at(248, 180)]).toBe(255);
    expect([...result.working.data.slice(at(248, 180) * 4, at(248, 180) * 4 + 4)]).toEqual([230, 20, 20, 255]);
    expect(result.deleteMask[at(211, 200)]).toBe(0);
    expect(result.deleteMask[at(125, 200)]).toBe(0);
  });

  it('keeps a garment that touches the printed form frame', () => {
    const pixels = sheet((data, width) => {
      const ink = [30, 30, 30, 255];
      for (let y = 20; y < 380; y += 60) paint(data, width, 20, y, 380, y, ink, 2);
      for (let x = 20; x < 400; x += 120) paint(data, width, x, 20, x, 380, ink, 2);
      garment(data, width);
      paint(data, width, 110, 330, 20, 330, ink);
    });
    const result = autoCleanDraft(createSnapshot(pixels, 'base'));
    const offset = (200 * 400 + 211) * 4;
    expect([...result.working.data.slice(offset, offset + 4)]).toEqual([30, 30, 30, 255]);
  });
});
