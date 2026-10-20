/** A pixel area: right and bottom are exclusive. */
export interface Region { left: number; top: number; right: number; bottom: number }

// A pixel belongs to a mark's soft edge when it stands out from the paper by this much.
const HALO_DARKER = 10;
const HALO_TINT = 18;
// The paper is measured per tile: a sheet, a grey backdrop or a shadow each set their own.
const PAPER_TILE = 48;
const PAPER_SAMPLE_STEP = 2;

type RGB = readonly [number, number, number];

const lightness = (data: Uint8ClampedArray, offset: number): number => (data[offset] + data[offset + 1] + data[offset + 2]) / 3;

/** Median colour of each tile: the paper (or backdrop) the marks in it sit on. */
function paperTiles(data: Uint8ClampedArray, width: number, region: Region): { at: (x: number, y: number) => RGB } {
  const columns = Math.max(1, Math.ceil((region.right - region.left) / PAPER_TILE));
  const rows = Math.max(1, Math.ceil((region.bottom - region.top) / PAPER_TILE));
  const tiles: RGB[] = [];
  const median = (values: number[]): number => (values.length ? values.sort((a, b) => a - b)[values.length >> 1] : 255);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const channels: number[][] = [[], [], []];
      const top = region.top + row * PAPER_TILE;
      const left = region.left + column * PAPER_TILE;
      for (let y = top; y < Math.min(region.bottom, top + PAPER_TILE); y += PAPER_SAMPLE_STEP) {
        for (let x = left; x < Math.min(region.right, left + PAPER_TILE); x += PAPER_SAMPLE_STEP) {
          const offset = (y * width + x) * 4;
          for (let channel = 0; channel < 3; channel += 1) channels[channel].push(data[offset + channel]);
        }
      }
      tiles.push([median(channels[0]), median(channels[1]), median(channels[2])]);
    }
  }
  return {
    at: (x: number, y: number): RGB => tiles[Math.floor((y - region.top) / PAPER_TILE) * columns + Math.floor((x - region.left) / PAPER_TILE)],
  };
}

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
  const papers = paperTiles(data, width, { left, top, right, bottom });
  const standsOut = (index: number): boolean => {
    const offset = index * 4;
    const x = index % width;
    const paper = papers.at(x, (index - x) / width);
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
