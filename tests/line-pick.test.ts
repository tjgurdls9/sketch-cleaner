import { describe, expect, it } from 'vitest';
import { pickLineAt, selectLineAt } from '../src/core/line-pick';
import { createSnapshot } from '../src/core/engine';

type Canvas = { width: number; height: number; ink: Uint8Array };
const canvas = (width: number, height: number): Canvas => ({ width, height, ink: new Uint8Array(width * height) });

function stroke(target: Canvas, x0: number, y0: number, x1: number, y1: number, thickness = 4): void {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
  for (let step = 0; step <= steps; step += 1) {
    const cx = x0 + (x1 - x0) * step / steps;
    const cy = y0 + (y1 - y0) * step / steps;
    for (let y = Math.floor(cy - thickness / 2); y <= Math.ceil(cy + thickness / 2); y += 1) {
      for (let x = Math.floor(cx - thickness / 2); x <= Math.ceil(cx + thickness / 2); x += 1) {
        if (x >= 0 && y >= 0 && x < target.width && y < target.height && Math.hypot(x - cx, y - cy) <= thickness / 2) target.ink[y * target.width + x] = 1;
      }
    }
  }
}

const near = (mask: Uint8Array, target: Canvas, x: number, y: number, radius = 2): boolean => {
  for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) if (mask[(y + dy) * target.width + x + dx] === 255) return true;
  return false;
};

describe('picking one line at a click', () => {
  it('takes a whole leader that ends on the outline in a T, and none of the outline', () => {
    const target = canvas(240, 240);
    stroke(target, 120, 5, 120, 235);
    stroke(target, 10, 30, 118, 120, 3);
    const { mask } = pickLineAt(target.ink, 240, 240, 64, 75);
    expect(near(mask, target, 20, 38)).toBe(true);
    expect(near(mask, target, 110, 113)).toBe(true);
    expect(near(mask, target, 120, 40)).toBe(false);
    expect(near(mask, target, 120, 200)).toBe(false);
  });

  it('takes both pieces of a line the pen skipped on for a moment', () => {
    const target = canvas(240, 200);
    stroke(target, 20, 150, 110, 96, 3);
    stroke(target, 114, 94, 220, 30, 3);
    const { mask } = pickLineAt(target.ink, 240, 200, 60, 126);
    expect(near(mask, target, 180, 54)).toBe(true);
  });

  it('runs on through a crossing line without taking it', () => {
    const target = canvas(240, 240);
    stroke(target, 20, 120, 220, 120);
    stroke(target, 120, 10, 120, 230);
    const { mask } = pickLineAt(target.ink, 240, 240, 60, 120);
    expect(near(mask, target, 200, 120)).toBe(true);
    expect(near(mask, target, 120, 30)).toBe(false);
    expect(near(mask, target, 120, 210)).toBe(false);
  });

  it('takes nothing for a click on blank paper', () => {
    const target = canvas(200, 200);
    stroke(target, 20, 100, 180, 100);
    const { mask } = pickLineAt(target.ink, 200, 200, 100, 40);
    expect(mask.some(Boolean)).toBe(false);
  });
});

describe('selecting a line on the photo', () => {
  const PAPER = [250, 248, 240, 255];
  const photo = (width: number, height: number) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let offset = 0; offset < data.length; offset += 4) data.set(PAPER, offset);
    const line = (x0: number, y0: number, x1: number, y1: number, thickness: number, color: number[]) => {
      const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
      for (let step = 0; step <= steps; step += 1) {
        const cx = x0 + (x1 - x0) * step / steps;
        const cy = y0 + (y1 - y0) * step / steps;
        for (let y = Math.floor(cy - thickness); y <= Math.ceil(cy + thickness); y += 1) {
          for (let x = Math.floor(cx - thickness); x <= Math.ceil(cx + thickness); x += 1) {
            if (x < 0 || y < 0 || x >= width || y >= height) continue;
            const distance = Math.hypot(x - cx, y - cy);
            // A soft pen edge: full ink inside half the width, fading out to the paper beyond.
            const amount = distance <= thickness / 2 ? 1 : distance <= thickness ? 0.35 : 0;
            if (!amount) continue;
            const offset = (y * width + x) * 4;
            for (let c = 0; c < 3; c += 1) data[offset + c] = Math.min(data[offset + c], Math.round(PAPER[c] - (PAPER[c] - color[c]) * amount));
          }
        }
      }
    };
    return { data, line };
  };

  it('selects the clicked leader and its soft edge, not the outline it points at', () => {
    const [width, height] = [300, 260];
    const { data, line } = photo(width, height);
    line(150, 5, 150, 255, 5, [30, 30, 30]);
    line(15, 40, 146, 150, 3, [90, 90, 90]);
    const snapshot = createSnapshot({ width, height, data }, 'pick');
    const picked = selectLineAt(snapshot, { x: 80, y: 95 }, 'replace');
    const at = (x: number, y: number) => picked.deleteMask[y * width + x];
    expect(at(80, 95)).toBe(255);
    expect(at(81, 97)).toBe(255); // soft edge just off the centre line
    expect(at(150, 40)).toBe(0);
    expect(at(150, 220)).toBe(0);
    expect(at(80, 60)).toBe(0);
  });

  it('adds with Shift and takes away with Alt, as the other selection tools do', () => {
    const [width, height] = [300, 260];
    const { data, line } = photo(width, height);
    line(150, 5, 150, 255, 5, [30, 30, 30]);
    line(15, 40, 146, 150, 3, [90, 90, 90]);
    const snapshot = createSnapshot({ width, height, data }, 'pick');
    const marked = { ...snapshot, deleteMask: snapshot.deleteMask.slice() };
    marked.deleteMask[10 * width + 10] = 255;
    const added = selectLineAt(marked, { x: 80, y: 95 }, 'add');
    expect(added.deleteMask[10 * width + 10]).toBe(255);
    expect(added.deleteMask[95 * width + 80]).toBe(255);
    const everything = { ...snapshot, deleteMask: new Uint8Array(width * height).fill(255) };
    const without = selectLineAt(everything, { x: 80, y: 95 }, 'subtract');
    expect(without.deleteMask[95 * width + 80]).toBe(0);
    expect(without.deleteMask[200 * width + 150]).toBe(255);
    expect(selectLineAt(snapshot, { x: 260, y: 30 }, 'replace')).toBe(snapshot);
  });

  it('follows a line longer than the first look around the click', () => {
    const [width, height] = [1600, 300];
    const { data, line } = photo(width, height);
    line(10, 150, 1590, 150, 3, [60, 60, 60]);
    const snapshot = createSnapshot({ width, height, data }, 'long');
    const picked = selectLineAt(snapshot, { x: 800, y: 150 }, 'replace');
    expect(picked.deleteMask[150 * width + 30]).toBe(255);
    expect(picked.deleteMask[150 * width + 1570]).toBe(255);
  });
});
