import { describe, expect, it } from 'vitest';
import { pickLineAt } from '../src/core/line-pick';

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
