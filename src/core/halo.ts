import { paperColorAt } from './paper';

/** A pixel area: right and bottom are exclusive. */
export interface Region { left: number; top: number; right: number; bottom: number }

// A pixel belongs to a mark's soft edge when it stands out from the paper by this much.
const HALO_DARKER = 10;
const HALO_TINT = 18;

const lightness = (data: Uint8ClampedArray, offset: number): number => (data[offset] + data[offset + 1] + data[offset + 2]) / 3;

/**
 * Grows a 0/255 selection over the soft edge of the marks it holds (anti-aliasing, marker bleed,
 * photo blur) so filling it leaves no grey or pink outline. Only pixels that stand out from the
 * paper are taken, at most `radius` pixels out, and never a kept line (`kept` is 1 there) or the
 * pixels touching it. Dark bits of the mark the selection missed are taken with the edge.
 */
export function growIntoHalo(data: Uint8ClampedArray, width: number, height: number, mask: Uint8Array, kept: Uint8Array, region: Region, radius: number): Uint8Array {
  const result = mask.slice();
  const left = Math.max(0, region.left);
  const top = Math.max(0, region.top);
  const right = Math.min(width, region.right);
  const bottom = Math.min(height, region.bottom);
  const inside = (x: number, y: number): boolean => x >= left && y >= top && x < right && y < bottom;
  const paperAt = paperColorAt(data, width, height, mask);
  const standsOut = (index: number): boolean => {
    const offset = index * 4;
    const x = index % width;
    const paper = paperAt(x, (index - x) / width);
    const paperLight = (paper[0] + paper[1] + paper[2]) / 3;
    const tint = Math.max(Math.abs(data[offset] - paper[0]), Math.abs(data[offset + 1] - paper[1]), Math.abs(data[offset + 2] - paper[2]));
    return paperLight - lightness(data, offset) > HALO_DARKER || tint > HALO_TINT;
  };
  const keptInk = (index: number): boolean => kept[index] === 1 && !mask[index];
  const touchesKeptInk = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) if (inside(x + dx, y + dy) && keptInk((y + dy) * width + x + dx)) return true;
    }
    return false;
  };
  let frontier: number[] = [];
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) if (mask[y * width + x] === 255) frontier.push(y * width + x);
  for (let step = 0; step < radius && frontier.length; step += 1) {
    const next: number[] = [];
    for (const index of frontier) {
      const x = index % width;
      const y = (index - x) / width;
      for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
        if (!inside(nx, ny)) continue;
        const neighbour = ny * width + nx;
        if (result[neighbour] || !standsOut(neighbour) || keptInk(neighbour) || touchesKeptInk(nx, ny)) continue;
        result[neighbour] = 255;
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return result;
}
