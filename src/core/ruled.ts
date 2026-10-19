/**
 * Splits a form-table component into its ruled lines and the drawings that merely touch it.
 * A scanned worksheet often has a garment drawing touching the printed table frame; the two
 * then form one connected component that used to be deleted as a whole.
 */

export interface RuledSplit {
  /** Cells on long, nearly axis-aligned straight lines (the printed table). */
  ruled: number[];
  /** Remaining cells of the component, grouped into 8-connected parts. */
  parts: number[][];
}

const MAX_TILT = 0.035; // about 2 degrees: scans are rarely rotated more than this
const TILT_STEP = 0.0035;
const LINE_BAND = 1.5;
const RUN_GAP = 3;

/** Minimum length of a ruled line, as a share of the analysis grid side it runs along. */
export const RULED_MIN_SHARE = 0.3;
/** Pieces of a candidate line shorter than this (in cells) are crossings, not the line itself. */
export const RULED_MIN_RUN = 15;

function findLines(cells: readonly number[], removed: Uint8Array, gridWidth: number, along: number, horizontal: boolean): void {
  const angles: number[] = [];
  for (let angle = -MAX_TILT; angle <= MAX_TILT + 1e-9; angle += TILT_STEP) angles.push(angle);
  const across = horizontal ? (cell: number): number => (cell / gridWidth) | 0 : (cell: number): number => cell % gridWidth;
  const position = horizontal ? (cell: number): number => cell % gridWidth : (cell: number): number => (cell / gridWidth) | 0;
  const offset = Math.ceil(along * Math.sin(MAX_TILT)) + 2;
  const bins = along + offset * 2 + 2;
  const votes = angles.map(() => new Int32Array(bins));
  const binOf = (cell: number, angle: number): number => Math.round(across(cell) * Math.cos(angle) - position(cell) * Math.sin(angle)) + offset;
  const live = cells.filter(cell => !removed[cell]);
  for (const cell of live) angles.forEach((angle, index) => { votes[index][binOf(cell, angle)] += 1; });
  const minimum = Math.max(RULED_MIN_RUN, Math.floor(along * RULED_MIN_SHARE));
  for (let guard = 0; guard < 400; guard += 1) {
    let best = 0;
    let bestAngle = 0;
    let bestBin = 0;
    votes.forEach((row, index) => {
      for (let bin = 0; bin < row.length; bin += 1) if (row[bin] > best) { best = row[bin]; bestAngle = index; bestBin = bin; }
    });
    if (best < minimum) return;
    const angle = angles[bestAngle];
    const onLine = live.filter(cell => !removed[cell] && Math.abs(across(cell) * Math.cos(angle) - position(cell) * Math.sin(angle) + offset - bestBin) <= LINE_BAND)
      .sort((a, b) => position(a) - position(b));
    // Keep only long continuous stretches: a drawing that crosses the line adds short runs.
    const marked: number[] = [];
    let run: number[] = [];
    const flush = (): void => {
      const span = run.length ? position(run[run.length - 1]) - position(run[0]) + 1 : 0;
      if (span >= RULED_MIN_RUN) marked.push(...run);
      run = [];
    };
    for (const cell of onLine) {
      if (run.length && position(cell) - position(run[run.length - 1]) > RUN_GAP) flush();
      run.push(cell);
    }
    flush();
    // Short pieces that happen to line up (a cuff, a hem) do not add up to a ruled line.
    if (marked.length < minimum) marked.length = 0;
    // Retire this peak even when nothing qualified, so the search moves on.
    const retire = marked.length ? marked : onLine;
    for (const cell of retire) {
      angles.forEach((other, index) => { votes[index][binOf(cell, other)] -= 1; });
    }
    for (const cell of marked) removed[cell] = 1;
    if (!marked.length) for (const cell of onLine) removed[cell] = 2;
  }
}

/** Finds ruled table lines in component `id` and the parts left once they are taken out. */
export function splitRuledComponent(labels: Int32Array, id: number, bounds: { left: number; top: number; right: number; bottom: number },
  gridWidth: number, gridHeight: number): RuledSplit {
  const cells: number[] = [];
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) if (labels[y * gridWidth + x] === id) cells.push(y * gridWidth + x);
  }
  // 1 = ruled line, 2 = examined but kept (temporarily hidden from the vote while searching).
  const removed = new Uint8Array(labels.length);
  findLines(cells, removed, gridWidth, gridWidth, true);
  for (const cell of cells) if (removed[cell] === 2) removed[cell] = 0;
  findLines(cells, removed, gridWidth, gridHeight, false);
  const ruled = cells.filter(cell => removed[cell] === 1);
  const isRuled = new Uint8Array(labels.length);
  for (const cell of ruled) isRuled[cell] = 1;
  const seen = new Uint8Array(labels.length);
  const parts: number[][] = [];
  for (const start of cells) {
    if (isRuled[start] || seen[start]) continue;
    const part = [start];
    seen[start] = 1;
    for (let head = 0; head < part.length; head += 1) {
      const x = part[head] % gridWidth;
      const y = (part[head] / gridWidth) | 0;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(gridHeight - 1, y + 1); ny += 1) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(gridWidth - 1, x + 1); nx += 1) {
          const next = ny * gridWidth + nx;
          if (labels[next] !== id || isRuled[next] || seen[next]) continue;
          seen[next] = 1;
          part.push(next);
        }
      }
    }
    parts.push(part);
  }
  return { ruled, parts };
}
