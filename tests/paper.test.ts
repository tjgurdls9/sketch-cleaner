import { describe, expect, it } from 'vitest';
import { paperColorAt } from '../src/core/paper';
import { createSnapshot, eraseStroke, fillSelection } from '../src/core/engine';

const CREAM = [246, 243, 230];

function sheet(width: number, height: number, color = CREAM): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set([...color, 255], offset);
  return data;
}
const paint = (data: Uint8ClampedArray, width: number, x: number, y: number, rgb: number[]): void => { data.set([...rgb, 255], (y * width + x) * 4); };

describe('paper colour around a spot', () => {
  it('is the sheet colour, leaving out the ink being erased', () => {
    const [width, height] = [60, 40];
    const data = sheet(width, height);
    const exclude = new Uint8Array(width * height);
    for (let y = 10; y < 30; y += 1) for (let x = 10; x < 50; x += 1) { paint(data, width, x, y, [30, 30, 30]); exclude[y * width + x] = 255; }
    expect(paperColorAt(data, width, height, exclude)(30, 20)).toEqual(CREAM);
  });

  it('is measured locally: a grey backdrop beside a white sheet keeps its own colour', () => {
    const [width, height] = [200, 60];
    const data = sheet(width, height, [255, 255, 255]);
    for (let y = 0; y < height; y += 1) for (let x = 100; x < width; x += 1) paint(data, width, x, y, [110, 110, 112]);
    const at = paperColorAt(data, width, height);
    expect(at(20, 30)).toEqual([255, 255, 255]);
    expect(at(180, 30)).toEqual([110, 110, 112]);
  });
});

describe('erasing to the paper colour', () => {
  it('fills the selection with the surrounding paper, not white, and blends partial selection', () => {
    const [width, height] = [60, 40];
    const data = sheet(width, height);
    const snapshot = createSnapshot({ width, height, data }, 'paper');
    for (let x = 10; x < 50; x += 1) { snapshot.working.data.set([30, 30, 30, 255], (20 * width + x) * 4); snapshot.deleteMask[20 * width + x] = 255; }
    snapshot.working.data.set([30, 30, 30, 255], (25 * width + 30) * 4);
    snapshot.deleteMask[25 * width + 30] = 128;
    const filled = fillSelection(snapshot, { kind: 'paper' });
    const at = (x: number, y: number) => [...filled.working.data.slice((y * width + x) * 4, (y * width + x) * 4 + 3)];
    expect(at(30, 20)).toEqual(CREAM);
    const half = at(30, 25)[0];
    expect(half).toBeGreaterThan(120);
    expect(half).toBeLessThan(150);
  });

  it('erases a brush stroke to the paper colour', () => {
    const [width, height] = [60, 40];
    const data = sheet(width, height);
    for (let x = 0; x < width; x += 1) data.set([30, 30, 30, 255], (20 * width + x) * 4);
    const snapshot = createSnapshot({ width, height, data }, 'paper-erase');
    const erased = eraseStroke(snapshot, [{ x: 5, y: 20.5 }, { x: 55, y: 20.5 }], { radius: 2, strength: 1, hardness: 1 }, { kind: 'paper' });
    expect([...erased.working.data.slice((20 * width + 30) * 4, (20 * width + 30) * 4 + 3)]).toEqual(CREAM);
  });
});
