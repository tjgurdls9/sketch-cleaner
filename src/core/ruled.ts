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
// A printed form has a few dozen rules per direction; more peaks means solid dark areas.
const MAX_LINES = 60;
// Cells this far on both sides of a line still inked means the line sits in a solid area.
const SOLID_DEPTH = 4;

/** Minimum length of a ruled line, as a share of the analysis grid side it runs along. */
export const RULED_MIN_SHARE = 0.3;
/** Pieces of a candidate line shorter than this (in cells) are crossings, not the line itself. */
export const RULED_MIN_RUN = 15;

function findLines(cells: readonly number[], removed: Uint8Array, gridWidth: number, along: number, horizontal: boolean, lines: number[][]): void {
  const angles: number[] = [];
  for (let angle = -MAX_TILT; angle <= MAX_TILT + 1e-9; angle += TILT_STEP) angles.push(angle);
  const across = horizontal ? (cell: number): number => (cell / gridWidth) | 0 : (cell: number): number => cell % gridWidth;
  const position = horizontal ? (cell: number): number => cell % gridWidth : (cell: number): number => (cell / gridWidth) | 0;
  const offset = Math.ceil(along * Math.sin(MAX_TILT)) + 2;
  const bins = along + offset * 2 + 2;
  const votes = angles.map(() => new Int32Array(bins));
  const binOf = (cell: number, angle: number): number => Math.round(across(cell) * Math.cos(angle) - position(cell) * Math.sin(angle)) + offset;
  const member = new Uint8Array(removed.length);
  for (const cell of cells) member[cell] = 1;
  // Cells deep inside a solid dark area (a scan border, a black bar) cannot be on a thin rule.
  const deep = (cell: number): boolean => member[cell - SOLID_DEPTH] === 1 && member[cell + SOLID_DEPTH] === 1
    && member[cell - SOLID_DEPTH * gridWidth] === 1 && member[cell + SOLID_DEPTH * gridWidth] === 1;
  const live = cells.filter(cell => !removed[cell] && !deep(cell));
  // Precomputed bins per angle, and the cells of each angle sorted by bin for quick band lookups.
  const binTable = new Int32Array(live.length * angles.length);
  live.forEach((cell, order) => angles.forEach((angle, index) => {
    const bin = binOf(cell, angle);
    binTable[order * angles.length + index] = bin;
    votes[index][bin] += 1;
  }));
  const sorted = new Map<number, Int32Array>();
  const byBin = (index: number): Int32Array => {
    let order = sorted.get(index);
    if (!order) {
      // Counting sort: bins are small integers.
      const starts = new Int32Array(bins + 1);
      for (let item = 0; item < live.length; item += 1) starts[binTable[item * angles.length + index] + 1] += 1;
      for (let bin = 1; bin <= bins; bin += 1) starts[bin] += starts[bin - 1];
      const filled = order = new Int32Array(live.length);
      for (let item = 0; item < live.length; item += 1) filled[starts[binTable[item * angles.length + index]]++] = item;
      sorted.set(index, filled);
    }
    return order;
  };
  const minimum = Math.max(RULED_MIN_RUN, Math.floor(along * RULED_MIN_SHARE));
  for (let guard = 0; guard < MAX_LINES; guard += 1) {
    let best = 0;
    let bestAngle = 0;
    let bestBin = 0;
    votes.forEach((row, index) => {
      for (let bin = 0; bin < row.length; bin += 1) if (row[bin] > best) { best = row[bin]; bestAngle = index; bestBin = bin; }
    });
    if (best < minimum) return;
    const angle = angles[bestAngle];
    const order = byBin(bestAngle);
    let low = 0;
    let high = order.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (binTable[order[middle] * angles.length + bestAngle] < bestBin - 2) low = middle + 1; else high = middle;
    }
    const nearby: number[] = [];
    for (let at = low; at < order.length && binTable[order[at] * angles.length + bestAngle] <= bestBin + 2; at += 1) nearby.push(order[at]);
    const onLineOrders = nearby.filter(item => !removed[live[item]]
      && Math.abs(across(live[item]) * Math.cos(angle) - position(live[item]) * Math.sin(angle) + offset - bestBin) <= LINE_BAND)
      .sort((a, b) => position(live[a]) - position(live[b]));
    const onLine = onLineOrders.map(item => live[item]);
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
    // Rows of a solid dark area (a scan border, a black bar) are not rules either.
    const inside = (cell: number, step: number): boolean => {
      const target = horizontal ? cell + step * gridWidth : cell + step;
      return target >= 0 && target < removed.length && member[target] === 1;
    };
    const solid = marked.filter(cell => inside(cell, SOLID_DEPTH) && inside(cell, -SOLID_DEPTH)).length;
    if (solid > marked.length / 2) marked.length = 0;
    // Retire this peak even when nothing qualified, so the search moves on.
    const orderOf = new Map(onLineOrders.map(item => [live[item], item]));
    const retire = marked.length ? marked : onLine;
    for (const cell of retire) {
      const item = orderOf.get(cell)!;
      for (let index = 0; index < angles.length; index += 1) votes[index][binTable[item * angles.length + index]] -= 1;
    }
    for (const cell of marked) removed[cell] = 1;
    if (marked.length) lines.push([...marked]);
    if (!marked.length) for (const cell of onLine) removed[cell] = 2;
  }
}

function labelParts(cells: readonly number[], labels: Int32Array, id: number, isRuled: Uint8Array, gridWidth: number, gridHeight: number): number[][] {
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
  return parts;
}

export interface RuledLine { cells: number[]; horizontal: boolean }

/** Long, nearly axis-aligned straight lines in component `id` (candidates for printed table rules). */
export function findRuledLines(labels: Int32Array, id: number, bounds: { left: number; top: number; right: number; bottom: number },
  gridWidth: number, gridHeight: number): { cells: number[]; lines: RuledLine[] } {
  const cells: number[] = [];
  for (let y = bounds.top; y <= bounds.bottom; y += 1) {
    for (let x = bounds.left; x <= bounds.right; x += 1) if (labels[y * gridWidth + x] === id) cells.push(y * gridWidth + x);
  }
  // 1 = ruled line, 2 = examined but kept (temporarily hidden from the vote while searching).
  const removed = new Uint8Array(labels.length);
  const horizontal: number[][] = [];
  const vertical: number[][] = [];
  findLines(cells, removed, gridWidth, gridWidth, true, horizontal);
  for (const cell of cells) if (removed[cell] === 2) removed[cell] = 0;
  findLines(cells, removed, gridWidth, gridHeight, false, vertical);
  return {
    cells,
    lines: [...horizontal.map(line => ({ cells: line, horizontal: true })), ...vertical.map(line => ({ cells: line, horizontal: false }))],
  };
}

/** The component split into ruled-line cells and the 8-connected parts left without them. */
export function splitRuledComponent(labels: Int32Array, id: number, cells: readonly number[], lines: readonly RuledLine[],
  gridWidth: number, gridHeight: number): RuledSplit {
  const isRuled = new Uint8Array(labels.length);
  for (const line of lines) for (const cell of line.cells) isRuled[cell] = 1;
  return { ruled: cells.filter(cell => isRuled[cell]), parts: labelParts(cells, labels, id, isRuled, gridWidth, gridHeight) };
}
