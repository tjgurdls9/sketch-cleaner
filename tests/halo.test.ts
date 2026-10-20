import { describe, expect, it } from 'vitest';
import { growIntoHalo } from '../src/core/halo';

const PAPER = [250, 248, 236];

function sheet(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([...PAPER, 255], offset);
  return data;
}

const paint = (data: Uint8ClampedArray, width: number, x: number, y: number, rgb: number[]): void => { data.set([...rgb, 255], (y * width + x) * 4); };

describe('taking in the soft edge of selected marks', () => {
  it('takes the pink fringe of a selected red stroke but not the paper beyond it', () => {
    const [width, height] = [40, 20];
    const data = sheet(width, height);
    const mask = new Uint8Array(width * height);
    for (let x = 5; x < 35; x += 1) {
      paint(data, width, x, 10, [230, 40, 40]); mask[10 * width + x] = 255;
      paint(data, width, x, 9, [240, 150, 140]); paint(data, width, x, 11, [240, 150, 140]);
      paint(data, width, x, 8, [246, 210, 200]); paint(data, width, x, 12, [246, 210, 200]);
    }
    const grown = growIntoHalo(data, width, height, mask, new Uint8Array(width * height), { left: 0, top: 0, right: width, bottom: height }, 3);
    expect(grown[9 * width + 20]).toBe(255);
    expect(grown[8 * width + 20]).toBe(255);
    expect(grown[12 * width + 20]).toBe(255);
    expect(grown[5 * width + 20]).toBe(0);
    expect(grown[15 * width + 20]).toBe(0);
    expect(mask[9 * width + 20]).toBe(0);
  });

  it("never takes a kept drawing line next to the mark, nor the line's own soft edge", () => {
    const [width, height] = [40, 20];
    const data = sheet(width, height);
    const mask = new Uint8Array(width * height);
    const kept = new Uint8Array(width * height);
    for (let x = 5; x < 35; x += 1) {
      paint(data, width, x, 6, [140, 140, 140]); mask[6 * width + x] = 255; // selected grey leader
      paint(data, width, x, 7, [200, 200, 195]); // shared soft edge
      paint(data, width, x, 8, [40, 40, 40]); kept[8 * width + x] = 1; // kept drawing line
      paint(data, width, x, 9, [200, 200, 195]);
    }
    const grown = growIntoHalo(data, width, height, mask, kept, { left: 0, top: 0, right: width, bottom: height }, 3);
    expect(grown[8 * width + 20]).toBe(0);
    expect(grown[7 * width + 20]).toBe(0);
    expect(grown[9 * width + 20]).toBe(0);
    expect(grown[6 * width + 20]).toBe(255);
  });

  it('leaves tinted paper alone: only ink that stands out from the paper is taken', () => {
    const [width, height] = [30, 10];
    const data = sheet(width, height);
    for (let x = 0; x < width; x += 1) paint(data, width, x, 2, [247, 245, 230]); // paper grain
    const mask = new Uint8Array(width * height);
    for (let x = 0; x < width; x += 1) { paint(data, width, x, 3, [60, 60, 60]); mask[3 * width + x] = 255; }
    const grown = growIntoHalo(data, width, height, mask, new Uint8Array(width * height), { left: 0, top: 0, right: width, bottom: height }, 3);
    expect(grown[2 * width + 10]).toBe(0);
  });

  it('takes dark bits of the mark the selection missed, which no kept line owns', () => {
    const [width, height] = [30, 12];
    const data = sheet(width, height);
    const mask = new Uint8Array(width * height);
    for (let x = 5; x < 25; x += 1) { paint(data, width, x, 6, [50, 50, 50]); mask[6 * width + x] = 255; }
    paint(data, width, 15, 7, [45, 45, 45]); // a blot at the stroke the selection did not reach
    const grown = growIntoHalo(data, width, height, mask, new Uint8Array(width * height), { left: 0, top: 0, right: width, bottom: height }, 3);
    expect(grown[7 * width + 15]).toBe(255);
  });
});
