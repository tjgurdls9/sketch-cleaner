import { describe, expect, it } from 'vitest';
import { findAnnotationInk } from '../src/core/marks';
import { findRuledLines, splitRuledComponent } from '../src/core/ruled';
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

  it('selects a small detached scribble and, erring on the side of selecting, a lone straight tick', () => {
    const target = canvas(200, 200);
    stroke(target, 20, 5, 20, 195);
    for (let angle = 0; angle < Math.PI * 2; angle += 0.05) stroke(target, 100 + 9 * Math.cos(angle), 100 + 9 * Math.sin(angle), 100 + 9 * Math.cos(angle + 0.05), 100 + 9 * Math.sin(angle + 0.05), { thickness: 3 });
    stroke(target, 109, 100, 118, 82, { thickness: 3 });
    stroke(target, 150, 150, 160, 170, { thickness: 3 });
    const mask = run(target);
    expect(selected(mask, target, 91, 100)).toBe(true);
    expect(selected(mask, target, 155, 160)).toBe(true);
    expect(selected(mask, target, 20, 100)).toBe(false);
  });

  it('selects short marks hanging off a drawing line but keeps short pieces that join two drawing lines', () => {
    const target = canvas(240, 240);
    stroke(target, 60, 10, 60, 230);
    stroke(target, 180, 10, 180, 230);
    stroke(target, 60, 120, 180, 120); // a short-ish crossbar joining both lines (a waistband end)
    stroke(target, 60, 60, 80, 50); stroke(target, 80, 50, 90, 62); // a hook drawn on the seam
    stroke(target, 180, 180, 196, 172, { thickness: 3 }); stroke(target, 196, 172, 200, 190, { thickness: 3 }); // a bent mark on the seam
    const mask = run(target);
    expect(selected(mask, target, 80, 52)).toBe(true);
    expect(selected(mask, target, 194, 175)).toBe(true);
    expect(selected(mask, target, 120, 120)).toBe(false);
    expect(selected(mask, target, 60, 30)).toBe(false);
    expect(selected(mask, target, 180, 30)).toBe(false);
  });

  it('selects an arrow with no note: its shaft and both arrowhead strokes', () => {
    const target = canvas(260, 220);
    stroke(target, 40, 10, 40, 210);
    // A bent arrow drawn in blank paper: from the right, left, then sharply up-right to a tip.
    stroke(target, 240, 150, 120, 150); stroke(target, 120, 150, 170, 80);
    stroke(target, 170, 80, 152, 84, { thickness: 3 }); stroke(target, 170, 80, 166, 98, { thickness: 3 });
    const mask = run(target);
    expect(selected(mask, target, 200, 150)).toBe(true);
    expect(selected(mask, target, 145, 115)).toBe(true);
    expect(selected(mask, target, 158, 84)).toBe(true);
    expect(selected(mask, target, 40, 100)).toBe(false);
  });

  it('selects a coloured solid line and keeps coloured dashes', () => {
    const target = canvas(240, 120);
    stroke(target, 10, 30, 230, 34, { colored: true });
    dashes(target, 10, 80, 230, 80, { colored: true });
    const mask = run(target);
    expect(selected(mask, target, 120, 32)).toBe(true);
    expect(selected(mask, target, 15, 80, 1)).toBe(false);
  });

  it('does not take a drawing line for a leader because a coloured note line touches its end', () => {
    const target = canvas(200, 240);
    stroke(target, 100, 10, 100, 200);
    stroke(target, 20, 202, 180, 205, { colored: true });
    stroke(target, 30, 60, 60, 60); writing(target, 26, 52, 66, 68);
    const mask = run(target);
    expect(selected(mask, target, 100, 100)).toBe(false);
    expect(selected(mask, target, 140, 204)).toBe(true);
  });

  it('selects a scissor mark (slash with a curl) but keeps a clean stitch-end slash', () => {
    const target = canvas(260, 240);
    stroke(target, 60, 10, 60, 230);
    stroke(target, 180, 10, 180, 230);
    stroke(target, 45, 110, 75, 80); // a clean stitch-end slash
    stroke(target, 165, 110, 195, 80); // scissor slash ...
    for (let x = 0; x < 26; x += 1) stroke(target, 183 + x, 98 + 4 * Math.sin(x / 3), 184 + x, 98 + 4 * Math.sin((x + 1) / 3), { thickness: 3 }); // ... with a curl
    const mask = run(target);
    expect(selected(mask, target, 200, 98)).toBe(true);
    expect(selected(mask, target, 190, 85)).toBe(true);
    expect(selected(mask, target, 70, 85)).toBe(false);
    expect(selected(mask, target, 180, 200)).toBe(false);
  });

  it('keeps a small closed detail on the drawing, such as a belt loop, and a lone straight stitch segment', () => {
    const target = canvas(260, 200);
    stroke(target, 10, 40, 250, 40);
    stroke(target, 10, 80, 250, 80);
    stroke(target, 100, 40, 100, 95); stroke(target, 112, 40, 112, 95); stroke(target, 100, 95, 112, 95); // belt loop
    stroke(target, 40, 150, 100, 150); // a lone straight stitch segment
    const mask = run(target);
    expect(selected(mask, target, 100, 88)).toBe(false);
    expect(selected(mask, target, 106, 95)).toBe(false);
    expect(selected(mask, target, 70, 150)).toBe(false);
  });

  it('keeps coloured stitching that runs beside a black seam, selects a coloured line away from seams', () => {
    const target = canvas(260, 200);
    stroke(target, 10, 40, 250, 40);
    stroke(target, 10, 52, 250, 52, { colored: true, thickness: 3 });
    stroke(target, 10, 150, 250, 150, { colored: true, thickness: 3 });
    const mask = run(target);
    expect(selected(mask, target, 130, 52)).toBe(false);
    expect(selected(mask, target, 130, 150)).toBe(true);
  });

  it('selects wiggly handwriting inside a text area instead of keeping it as a zipper line', () => {
    const target = canvas(260, 200);
    stroke(target, 20, 10, 20, 190);
    for (let x = 60; x < 200; x += 1) stroke(target, x, 100 + 6 * Math.sin(x / 5), x + 1, 100 + 6 * Math.sin((x + 1) / 5), { thickness: 3 });
    writing(target, 50, 85, 210, 115);
    const mask = run(target);
    expect(selected(mask, target, 130, 100, 7)).toBe(true);
    expect(selected(mask, target, 20, 100)).toBe(false);
  });

  it('returns an empty mask for blank paper', () => {
    const target = canvas(40, 40);
    expect(run(target).some(Boolean)).toBe(false);
  });
});

describe('wider leader candidates', () => {
  it('selects a leader cut by the edge of the area where it meets a drawing line in a T', () => {
    const target = canvas(240, 240);
    stroke(target, 120, 5, 120, 235);
    stroke(target, 0, 40, 117, 110, { thickness: 3 });
    const mask = run(target);
    expect(selected(mask, target, 60, 76)).toBe(true);
    expect(selected(mask, target, 120, 30)).toBe(false);
    expect(selected(mask, target, 120, 200)).toBe(false);
  });

  it('selects a leader from the edge that crosses the outline and stops at the stitching inside', () => {
    const target = canvas(240, 240);
    stroke(target, 100, 5, 100, 235);
    dashes(target, 120, 5, 120, 235);
    stroke(target, 0, 60, 118, 110, { thickness: 3 });
    const mask = run(target);
    expect(selected(mask, target, 50, 81)).toBe(true);
    expect(selected(mask, target, 100, 30)).toBe(false);
    expect(selected(mask, target, 100, 200)).toBe(false);
  });

  it('keeps a straight drawing line that crosses another line and runs on far past it', () => {
    const target = canvas(240, 240);
    stroke(target, 100, 5, 100, 235);
    stroke(target, 0, 120, 239, 120);
    stroke(target, 200, 5, 200, 235);
    const mask = run(target);
    expect(selected(mask, target, 50, 120)).toBe(false);
    expect(selected(mask, target, 150, 120)).toBe(false);
  });

  it('keeps a drawing line that runs from the edge of the area to a corner', () => {
    const target = canvas(240, 240);
    stroke(target, 0, 100, 150, 100);
    stroke(target, 150, 100, 150, 235);
    stroke(target, 40, 160, 220, 160);
    const mask = run(target);
    expect(selected(mask, target, 75, 100)).toBe(false);
    expect(selected(mask, target, 150, 200)).toBe(false);
  });

  it('selects a short leader from the edge that crosses the outline like a stitch-end slash', () => {
    const target = canvas(240, 240);
    stroke(target, 200, 5, 200, 235);
    dashes(target, 185, 5, 185, 235);
    stroke(target, 239, 100, 178, 110, { thickness: 3 });
    const mask = run(target);
    expect(selected(mask, target, 222, 103)).toBe(true);
    expect(selected(mask, target, 200, 40)).toBe(false);
    expect(selected(mask, target, 200, 200)).toBe(false);
  });

  it('selects a leader whose free end lines up with a stroke of the note like the next dash', () => {
    const target = canvas(240, 200);
    stroke(target, 60, 5, 60, 195);
    stroke(target, 200, 40, 63, 120, { thickness: 3 });
    stroke(target, 210, 34, 226, 25, { thickness: 3 }); // first stroke of the note, in line with the leader
    stroke(target, 214, 14, 232, 14, { thickness: 3 });
    writing(target, 204, 6, 239, 40);
    const mask = run(target);
    expect(selected(mask, target, 130, 80)).toBe(true);
    expect(selected(mask, target, 60, 40)).toBe(false);
    expect(selected(mask, target, 60, 170)).toBe(false);
  });
  it('selects a leader broken by a hairline gap, both pieces, though they line up like dashes', () => {
    const target = canvas(240, 200);
    stroke(target, 60, 5, 60, 195);
    stroke(target, 63, 120, 120, 86, { thickness: 3 });
    stroke(target, 124, 84, 180, 50, { thickness: 3 }); // the pen skipped for a moment
    stroke(target, 196, 30, 230, 30, { thickness: 3 });
    writing(target, 184, 6, 239, 48);
    const mask = run(target);
    expect(selected(mask, target, 150, 68)).toBe(true);
    expect(selected(mask, target, 90, 104)).toBe(true);
    expect(selected(mask, target, 60, 40)).toBe(false);
    expect(selected(mask, target, 60, 170)).toBe(false);
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
    const { cells, lines } = findRuledLines(labels, 1, { left: 0, top: 0, right: width - 1, bottom: height - 1 }, width, height);
    const split = splitRuledComponent(labels, 1, cells, lines, width, height);
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

  it('keeps a thick straight-lined drawing sitting in a thinly ruled form', () => {
    const pixels = sheet((data, width) => {
      const ink = [30, 30, 30, 255];
      for (let y = 20; y < 380; y += 60) paint(data, width, 20, y, 380, y, ink, 1);
      for (let x = 20; x < 400; x += 120) paint(data, width, x, 20, x, 380, ink, 1);
      // Trousers drawn with a ruler: long straight thick sides, waistband and hems.
      paint(data, width, 150, 50, 250, 50, ink, 6); paint(data, width, 150, 50, 150, 340, ink, 6); paint(data, width, 250, 50, 250, 340, ink, 6);
      paint(data, width, 150, 340, 190, 340, ink, 6); paint(data, width, 210, 340, 250, 340, ink, 6);
      paint(data, width, 190, 120, 190, 340, ink, 6); paint(data, width, 210, 120, 210, 340, ink, 6); paint(data, width, 190, 120, 210, 120, ink, 6);
      paint(data, width, 160, 80, 180, 100, ink, 3); paint(data, width, 240, 80, 220, 100, ink, 3);
    });
    const result = autoCleanDraft(createSnapshot(pixels, 'base'));
    for (const [x, y] of [[150, 200], [250, 200], [190, 250], [200, 50]]) {
      const offset = (y * 400 + x) * 4;
      expect([...result.working.data.slice(offset, offset + 4)], `${x},${y}`).toEqual([30, 30, 30, 255]);
    }
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
