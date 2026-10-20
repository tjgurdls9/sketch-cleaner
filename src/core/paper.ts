/**
 * The paper colour around any spot of a photo: the sheet, a grey backdrop or a shadow each set
 * their own. Erasing fills with it so an erased mark leaves no white patch on cream paper.
 */
export type RGB = readonly [number, number, number];

// Paper is measured per tile and blended between tile centres so fills show no seams.
const PAPER_TILE = 48;
const SAMPLE_STEP = 2;
// A tile with fewer readable samples (mostly ink being erased) borrows from its neighbours.
const MIN_SAMPLES = 8;
const BORROW_RINGS = 6;
const WHITE: RGB = [255, 255, 255];

/** Median of 0..255 values counted in a histogram. */
function histogramMedian(counts: Uint32Array, total: number): number {
  let seen = 0;
  for (let value = 0; value < 256; value += 1) {
    seen += counts[value];
    if (seen * 2 > total) return value;
  }
  return 255;
}

/**
 * Returns the paper colour at (x, y). Pixels where `exclude` is set (the marks being erased) are
 * left out of the measurement. Tiles are measured on first use.
 */
export function paperColorAt(data: Uint8ClampedArray, width: number, height: number, exclude?: Uint8Array): (x: number, y: number) => RGB {
  const columns = Math.max(1, Math.ceil(width / PAPER_TILE));
  const rows = Math.max(1, Math.ceil(height / PAPER_TILE));
  const measured = new Map<number, RGB | null>();
  const measure = (column: number, row: number): RGB | null => {
    const key = row * columns + column;
    if (measured.has(key)) return measured.get(key)!;
    const counts = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let total = 0;
    for (let y = row * PAPER_TILE; y < Math.min(height, (row + 1) * PAPER_TILE); y += SAMPLE_STEP) {
      for (let x = column * PAPER_TILE; x < Math.min(width, (column + 1) * PAPER_TILE); x += SAMPLE_STEP) {
        const index = y * width + x;
        if (exclude?.[index]) continue;
        for (let channel = 0; channel < 3; channel += 1) counts[channel][data[index * 4 + channel]] += 1;
        total += 1;
      }
    }
    const color: RGB | null = total >= MIN_SAMPLES ? [histogramMedian(counts[0], total), histogramMedian(counts[1], total), histogramMedian(counts[2], total)] : null;
    measured.set(key, color);
    return color;
  };
  const tile = (column: number, row: number): RGB => {
    for (let ring = 0; ring <= BORROW_RINGS; ring += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        for (let dx = -ring; dx <= ring; dx += 1) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const c = column + dx;
          const r = row + dy;
          if (c < 0 || r < 0 || c >= columns || r >= rows) continue;
          const color = measure(c, r);
          if (color) return color;
        }
      }
    }
    return WHITE;
  };
  return (x: number, y: number): RGB => {
    const fx = Math.min(columns - 1, Math.max(0, (x + 0.5) / PAPER_TILE - 0.5));
    const fy = Math.min(rows - 1, Math.max(0, (y + 0.5) / PAPER_TILE - 0.5));
    const c0 = Math.floor(fx);
    const r0 = Math.floor(fy);
    const c1 = Math.min(columns - 1, c0 + 1);
    const r1 = Math.min(rows - 1, r0 + 1);
    const tx = fx - c0;
    const ty = fy - r0;
    const [a, b, c, d] = [tile(c0, r0), tile(c1, r0), tile(c0, r1), tile(c1, r1)];
    const mix = (channel: number): number => Math.round(
      (a[channel] * (1 - tx) + b[channel] * tx) * (1 - ty) + (c[channel] * (1 - tx) + d[channel] * tx) * ty,
    );
    return [mix(0), mix(1), mix(2)];
  };
}
