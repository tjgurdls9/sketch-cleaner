import type { Snapshot } from '../shared/types';
import { findAnnotationInk } from './marks';
import { findRuledLines, splitRuledComponent, type RuledLine } from './ruled';

export const MAX_AUTO_ANALYSIS_PIXELS = 1_000_000;
/** Figure crops larger than this are analysed at a reduced scale for note candidates. */
export const MAX_FIGURE_ANALYSIS_PIXELS = 6_000_000;

type Progress = (completed: number, total: number) => void;
interface Bounds { left: number; top: number; right: number; bottom: number; count: number }

function analysisSize(width: number, height: number): { width: number; height: number } {
  const aspect = width / height;
  if (aspect >= MAX_AUTO_ANALYSIS_PIXELS) return { width: MAX_AUTO_ANALYSIS_PIXELS, height: 1 };
  if (1 / aspect >= MAX_AUTO_ANALYSIS_PIXELS) return { width: 1, height: MAX_AUTO_ANALYSIS_PIXELS };
  const analysisWidth = Math.min(width, Math.max(1, Math.floor(Math.sqrt(MAX_AUTO_ANALYSIS_PIXELS * aspect))));
  let analysisHeight = Math.min(height, Math.max(1, Math.floor(MAX_AUTO_ANALYSIS_PIXELS / analysisWidth)));
  let finalWidth = analysisWidth;
  while (finalWidth * analysisHeight > MAX_AUTO_ANALYSIS_PIXELS) finalWidth -= 1;
  if (finalWidth !== analysisWidth) analysisHeight = Math.min(height, Math.floor(MAX_AUTO_ANALYSIS_PIXELS / finalWidth));
  return { width: finalWidth, height: analysisHeight };
}

function pixelKind(data: Uint8ClampedArray, offset: number): 'red' | 'ink' | 'shadow' | '' {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  if (red >= 120 && red - green >= 45 && red - blue >= 35 && red > green * 1.3 && red > blue * 1.25) return 'red';
  if (maximum <= 170 && maximum - minimum <= 60) return 'ink';
  const light = (red + green + blue) / 3;
  if (light >= 210 && light < 246 && maximum - minimum <= 18) return 'shadow';
  return '';
}

function isAntialiasedInk(data: Uint8ClampedArray, offset: number): boolean {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return Math.max(red, green, blue) <= 220 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 45;
}

function componentIsGrid(id: number, labels: Int32Array, gridWidth: number, region: Bounds): boolean {
  const width = region.right - region.left + 1;
  const height = region.bottom - region.top + 1;
  if (width < 4 || height < 4) return false;
  const area = width * height;
  if (area > 262_144) return false;
  const rows = new Uint32Array(height);
  const columns = new Uint32Array(width);
  for (let y = 0; y < height; y += 1) {
    const row = (region.top + y) * gridWidth + region.left;
    for (let x = 0; x < width; x += 1) {
      if (labels[row + x] !== id) continue;
      rows[y] += 1;
      columns[x] += 1;
    }
  }
  let wideRows = 0;
  let tallColumns = 0;
  for (const value of rows) if (value >= Math.ceil(width * 0.55)) wideRows += 1;
  for (const value of columns) if (value >= Math.ceil(height * 0.55)) tallColumns += 1;
  return wideRows >= 2 && tallColumns >= 2;
}

function labelInk(ink: Uint8Array, width: number, height: number, progress?: Progress, progressOffset = 0, progressTotal = height): { labels: Int32Array; components: Bounds[] } {
  const labels = new Int32Array(ink.length);
  const queue = new Int32Array(ink.length);
  const components: Bounds[] = [];
  let nextId = 0;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width;
    for (let x = 0; x < width; x += 1) {
      const start = rowStart + x;
      if (!ink[start] || labels[start]) continue;
      const id = ++nextId;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      labels[start] = id;
      const bounds: Bounds = { left: x, top: y, right: x, bottom: y, count: 0 };
      while (head < tail) {
        const current = queue[head++];
        const cx = current % width;
        const cy = (current / width) | 0;
        bounds.count += 1;
        if (cx < bounds.left) bounds.left = cx;
        if (cx > bounds.right) bounds.right = cx;
        if (cy < bounds.top) bounds.top = cy;
        if (cy > bounds.bottom) bounds.bottom = cy;
        const y0 = Math.max(0, cy - 1);
        const y1 = Math.min(height - 1, cy + 1);
        const x0 = Math.max(0, cx - 1);
        const x1 = Math.min(width - 1, cx + 1);
        for (let ny = y0; ny <= y1; ny += 1) {
          const neighborRow = ny * width;
          for (let nx = x0; nx <= x1; nx += 1) {
            const neighbor = neighborRow + nx;
            if (!ink[neighbor] || labels[neighbor]) continue;
            labels[neighbor] = id;
            queue[tail++] = neighbor;
          }
        }
      }
      components.push(bounds);
    }
    progress?.(progressOffset + y + 1, progressTotal);
  }
  return { labels, components };
}

function makeKeepRegions(labels: Int32Array, gridWidth: number, gridHeight: number, anchors: readonly { id: number; bounds: Bounds }[]): Uint8Array {
  const keep = new Uint8Array(labels.length);
  for (const anchor of anchors) {
    const { bounds, id } = anchor;
    const componentWidth = bounds.right - bounds.left + 1;
    const componentHeight = bounds.bottom - bounds.top + 1;
    const marginX = Math.max(2, Math.round(componentWidth * 0.12));
    const marginY = Math.max(1, Math.round(componentHeight * 0.025));
    const firstRow = Math.max(0, bounds.top - marginY);
    const lastRow = Math.min(gridHeight - 1, bounds.bottom + marginY);
    const rowMin = new Int32Array(componentHeight);
    const rowMax = new Int32Array(componentHeight);
    rowMin.fill(bounds.right + 1);
    rowMax.fill(-1);
    for (let y = bounds.top; y <= bounds.bottom; y += 1) {
      const row = y * gridWidth;
      for (let x = bounds.left; x <= bounds.right; x += 1) {
        if (labels[row + x] !== id) continue;
        const rowIndex = y - bounds.top;
        rowMin[rowIndex] = Math.min(rowMin[rowIndex], x);
        rowMax[rowIndex] = Math.max(rowMax[rowIndex], x);
      }
    }
    for (let y = firstRow; y <= lastRow; y += 1) {
      let left = bounds.left;
      let right = bounds.right;
      if (y >= bounds.top && y <= bounds.bottom) {
        const index = y - bounds.top;
        if (rowMax[index] >= rowMin[index]) {
          left = rowMin[index];
          right = rowMax[index];
        }
      }
      left = Math.max(0, left - marginX);
      right = Math.min(gridWidth - 1, right + marginX);
      keep.fill(1, y * gridWidth + left, y * gridWidth + right + 1);
    }
  }
  return keep;
}

function componentIsGarment(bounds: Bounds, analysisWidth: number, analysisHeight: number, gridPixels: number): boolean {
  const width = bounds.right - bounds.left + 1;
  const height = bounds.bottom - bounds.top + 1;
  const aspect = width / height;
  const density = bounds.count / (width * height);
  return bounds.count >= Math.max(20, Math.floor(gridPixels * 0.00002))
    && height >= Math.max(10, Math.ceil(analysisHeight * 0.12))
    && width >= Math.max(6, Math.ceil(analysisWidth * 0.035))
    && aspect >= 0.18 && aspect <= 1.7
    && density >= 0.012 && density <= 0.5;
}

function labelComponentFlags(components: readonly Bounds[], gridPixels: number, minimum: number, maximumRatio: number): Uint8Array {
  const flags = new Uint8Array(components.length + 1);
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    const width = component.right - component.left + 1;
    const height = component.bottom - component.top + 1;
    if (component.count >= minimum && component.count <= Math.floor(gridPixels * maximumRatio)
      && width <= Math.floor(gridPixels ** 0.5 * 0.35) && height <= Math.floor(gridPixels ** 0.5 * 0.35)) {
      flags[index + 1] = 1;
    }
  }
  return flags;
}

/** A printed table rule is at most this share of the pen width of the drawing beside it. */
export const PRINTED_RULE_SHARE = 0.8;
const WIDTH_SAMPLES = 81;

function boundsOf(cells: readonly number[], gridWidth: number): Bounds {
  const bounds: Bounds = { left: Infinity, top: Infinity, right: -1, bottom: -1, count: cells.length };
  for (const cell of cells) {
    const x = cell % gridWidth;
    const y = (cell / gridWidth) | 0;
    bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x);
    bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y);
  }
  return bounds;
}

/** Longest run of dark ink through the full-size image along one axis, within `reach` of (x, y). */
function inkRun(snapshot: Snapshot, x: number, y: number, vertical: boolean, reach: number): number {
  const { width, height, data } = snapshot.working;
  let best = 0;
  let run = 0;
  for (let step = -reach; step <= reach; step += 1) {
    const px = vertical ? x : x + step;
    const py = vertical ? y + step : y;
    const on = px >= 0 && py >= 0 && px < width && py < height && pixelKind(data, (py * width + px) * 4) === 'ink';
    run = on ? run + 1 : 0;
    best = Math.max(best, run);
  }
  // Ink filling the whole window is a solid dark area, not a line: no width to report.
  return best > reach * 2 ? 0 : best;
}

function quantile(values: number[], share: number): number {
  const sorted = values.filter(value => value > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] : 0;
}

function sampleCells(cells: readonly number[]): number[] {
  const step = Math.max(1, Math.floor(cells.length / WIDTH_SAMPLES));
  return cells.filter((_, index) => index % step === 0);
}

function cellCentre(snapshot: Snapshot, cell: number, gridWidth: number, gridHeight: number): { x: number; y: number; reach: number } {
  const { width, height } = snapshot.working;
  const cellSize = Math.max(width / gridWidth, height / gridHeight);
  return {
    x: Math.floor(((cell % gridWidth) + 0.5) * width / gridWidth),
    y: Math.floor((((cell / gridWidth) | 0) + 0.5) * height / gridHeight),
    reach: Math.ceil(cellSize * 2) + 2,
  };
}

/** Typical pen width of a drawing: the shorter of the two axis-aligned runs through its ink. */
function strokeWidthOf(snapshot: Snapshot, cells: readonly number[], gridWidth: number, gridHeight: number): number {
  // Upper quartile: thin stitch lines and details inside a drawing should not pull it down.
  return quantile(sampleCells(cells).map(cell => {
    const { x, y, reach } = cellCentre(snapshot, cell, gridWidth, gridHeight);
    const across = [inkRun(snapshot, x, y, true, reach), inkRun(snapshot, x, y, false, reach)].filter(Boolean);
    return across.length ? Math.min(...across) : 0;
  }), 0.75);
}

/** Typical thickness of a straight rule, measured across it. */
function ruleWidthOf(snapshot: Snapshot, line: RuledLine, gridWidth: number, gridHeight: number): number {
  return quantile(sampleCells(line.cells).map(cell => {
    const { x, y, reach } = cellCentre(snapshot, cell, gridWidth, gridHeight);
    return inkRun(snapshot, x, y, line.horizontal, reach);
  }), 0.5);
}

function isBlueInk(data: Uint8ClampedArray, offset: number): boolean {
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return blue >= 90 && blue - red >= 40 && blue - green >= 20 && Math.max(red, green, blue) <= 235;
}

/**
 * Notes drawn over the kept figures (writing, leaders, scissor marks, red marks, coloured solid
 * lines) as a full-size 0/255 mask. These are selection candidates only: the figure may hold
 * real design details of the same shape, so the person confirms them before anything is erased.
 */
function figureCandidates(snapshot: Snapshot, anchors: readonly { bounds: Bounds }[], gridWidth: number, gridHeight: number, textMask?: Uint8Array): Uint8Array | null {
  const { width, height, data } = snapshot.working;
  let result: Uint8Array | null = null;
  // Full-size areas around each figure; overlapping areas are merged so no figure line is cut
  // at the edge of an area (a cut line looks short and would read as a note).
  let areas = anchors.map(({ bounds }) => {
    const marginX = Math.max(2, Math.round((bounds.right - bounds.left + 1) * 0.12));
    const marginY = Math.max(1, Math.round((bounds.bottom - bounds.top + 1) * 0.025));
    return {
      left: Math.max(0, Math.floor((bounds.left - marginX) * width / gridWidth)),
      right: Math.min(width, Math.ceil((bounds.right + marginX + 1) * width / gridWidth)),
      top: Math.max(0, Math.floor((bounds.top - marginY) * height / gridHeight)),
      bottom: Math.min(height, Math.ceil((bounds.bottom + marginY + 1) * height / gridHeight)),
    };
  });
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < areas.length && !merged; i += 1) {
      for (let j = i + 1; j < areas.length && !merged; j += 1) {
        const [a, b] = [areas[i], areas[j]];
        if (a.left >= b.right || b.left >= a.right || a.top >= b.bottom || b.top >= a.bottom) continue;
        const union = { left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) };
        areas = [...areas.filter((_, index) => index !== i && index !== j), union];
        merged = true;
      }
    }
  }
  for (const { left, right, top, bottom } of areas) {
    const scale = Math.max(1, Math.ceil(Math.sqrt((right - left) * (bottom - top) / MAX_FIGURE_ANALYSIS_PIXELS)));
    const cropWidth = Math.ceil((right - left) / scale);
    const cropHeight = Math.ceil((bottom - top) / scale);
    const ink = new Uint8Array(cropWidth * cropHeight);
    const colored = new Uint8Array(cropWidth * cropHeight);
    const text = textMask ? new Uint8Array(cropWidth * cropHeight) : undefined;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const index = y * width + x;
        const cell = ((y - top) / scale | 0) * cropWidth + ((x - left) / scale | 0);
        // Coloured ink takes part in the line graph so a red mark over a seam does not cut it.
        const kind = pixelKind(data, index * 4);
        const tinted = kind === 'red' || isBlueInk(data, index * 4);
        if (tinted || kind === 'ink') ink[cell] = 1;
        if (tinted) colored[cell] = 1;
        if (text && textMask?.[index] === 255) text[cell] = 255;
      }
    }
    const notes = findAnnotationInk({ ink, colored, text }, cropWidth, cropHeight);
    const mask: Uint8Array = result ?? new Uint8Array(width * height);
    result = mask;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const index = y * width + x;
        const kind = pixelKind(data, index * 4);
        const cell = ((y - top) / scale | 0) * cropWidth + ((x - left) / scale | 0);
        if (kind === 'red' || (notes[cell] && (kind === 'ink' || isBlueInk(data, index * 4) || isAntialiasedInk(data, index * 4)))) mask[index] = 255;
      }
    }
    // Take in the soft edge of each note so filling it leaves no grey or pink halo.
    const edge: number[] = [];
    for (let y = Math.max(1, top); y < Math.min(height - 1, bottom); y += 1) {
      for (let x = Math.max(1, left); x < Math.min(width - 1, right); x += 1) {
        const index = y * width + x;
        if (mask[index] || pixelKind(data, index * 4) === 'ink') continue;
        if (Math.min(data[index * 4], data[index * 4 + 1], data[index * 4 + 2]) >= 230) continue;
        if (mask[index - 1] || mask[index + 1] || mask[index - width] || mask[index + width]) edge.push(index);
      }
    }
    for (const index of edge) mask[index] = 255;
  }
  return result;
}

/** Adds note candidates to the delete selection without touching the pixels. */
function selectCandidates(source: Snapshot, next: Snapshot, candidates: Uint8Array | null): Snapshot {
  if (!candidates) return next;
  let deleteMask = next.deleteMask;
  let copied = false;
  for (let index = 0; index < candidates.length; index += 1) {
    if (!candidates[index] || deleteMask[index] === 255 || next.protectMask[index] === 255) continue;
    if (!copied) { deleteMask = next.deleteMask.slice(); copied = true; }
    deleteMask[index] = 255;
  }
  if (!copied) return next;
  return { ...next, deleteMask, workVersion: next === source ? source.workVersion + 1 : next.workVersion };
}

function cleanWithTextMask(
  snapshot: Snapshot,
  textMask: Uint8Array,
  keep: Uint8Array,
  inkLabels: Int32Array,
  gridFlags: Uint8Array,
  redLabels: Int32Array,
  redFlags: Uint8Array,
  shadowLabels: Int32Array,
  shadowFlags: Uint8Array,
  gridWidth: number,
  gridHeight: number,
  progress?: Progress,
  progressOffset = 0,
  progressTotal = snapshot.working.height,
): Snapshot {
  const { width, height } = snapshot.working;
  let deleteMask = snapshot.deleteMask;
  let working = snapshot.working.data;
  let changed = false;

  for (let y = 0; y < height; y += 1) {
    const gridY = Math.min(gridHeight - 1, Math.floor(y * gridHeight / height));
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const index = row + x;
      const gridX = Math.min(gridWidth - 1, Math.floor(x * gridWidth / width));
      const cell = gridY * gridWidth + gridX;
      const insideFigure = keep[cell] !== 0;
      const autoDelete = !insideFigure && (textMask[index] === 255
        || gridFlags[inkLabels[cell]] === 1
        || redFlags[redLabels[cell]] === 1
        || shadowFlags[shadowLabels[cell]] === 1);
      const previousMask = snapshot.deleteMask[index];
      if (autoDelete && previousMask !== 255) {
        if (deleteMask === snapshot.deleteMask) deleteMask = snapshot.deleteMask.slice();
        deleteMask[index] = 255;
        changed = true;
      }

      const offset = index * 4;
      const protectedPixel = snapshot.protectMask[index] === 255;
      if (!autoDelete && !protectedPixel) continue;
      let differs = false;
      for (let channel = 0; channel < 4; channel += 1) {
        const target = protectedPixel
          ? snapshot.base.data[offset + channel]
          : Math.round(snapshot.working.data[offset + channel] * (snapshot.protectMask[index] / 255) + 255 * (1 - snapshot.protectMask[index] / 255));
        if (target !== snapshot.working.data[offset + channel]) differs = true;
      }
      if (!differs) continue;
      if (working === snapshot.working.data) working = snapshot.working.data.slice();
      for (let channel = 0; channel < 4; channel += 1) {
        working[offset + channel] = protectedPixel
          ? snapshot.base.data[offset + channel]
          : Math.round(snapshot.working.data[offset + channel] * (snapshot.protectMask[index] / 255) + 255 * (1 - snapshot.protectMask[index] / 255));
      }
      changed = true;
    }
    progress?.(progressOffset + y + 1, progressTotal);
  }

  if (!changed) {
    progress?.(progressTotal, progressTotal);
    return snapshot;
  }
  return {
    ...snapshot,
    working: working === snapshot.working.data ? snapshot.working : { ...snapshot.working, data: working },
    deleteMask,
    workVersion: snapshot.workVersion + 1,
  };
}

export function autoCleanDraft(snapshot: Snapshot, progress?: Progress, textMask?: Uint8Array): Snapshot {
  const { width, height, data } = snapshot.working;
  if (textMask !== undefined) {
    if (!(textMask instanceof Uint8Array) || textMask.length !== width * height) throw new RangeError('Invalid text mask buffer');
    for (const value of textMask) if (value !== 0 && value !== 255) throw new RangeError('Text mask values must be 0 or 255');
  }
  const size = analysisSize(width, height);
  const gridWidth = size.width;
  const gridHeight = size.height;
  const gridPixels = gridWidth * gridHeight;
  const ink = new Uint8Array(gridPixels);
  const shadow = new Uint8Array(gridPixels);
  const red = textMask ? new Uint8Array(gridPixels) : undefined;
  const total = gridHeight * 2 + height;

  for (let gy = 0; gy < gridHeight; gy += 1) {
    const top = Math.floor(gy * height / gridHeight);
    const bottom = Math.floor((gy + 1) * height / gridHeight);
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const left = Math.floor(gx * width / gridWidth);
      const right = Math.floor((gx + 1) * width / gridWidth);
      const cell = gy * gridWidth + gx;
      let hasInk = false;
      let hasShadow = false;
      let hasRed = false;
      for (let y = top; y < bottom && !(hasInk && hasShadow && (!red || hasRed)); y += 1) {
        let offset = (y * width + left) * 4;
        for (let x = left; x < right && !(hasInk && hasShadow && (!red || hasRed)); x += 1, offset += 4) {
          const kind = pixelKind(data, offset);
          if (kind === 'ink') hasInk = true;
          else if (kind === 'shadow') hasShadow = true;
          else if (kind === 'red') hasRed = true;
          else if (isAntialiasedInk(data, offset)) hasInk = true;
        }
      }
      ink[cell] = hasInk ? 1 : 0;
      shadow[cell] = hasShadow ? 1 : 0;
      if (red) red[cell] = hasRed ? 1 : 0;
    }
    progress?.(gy + 1, total);
  }

  const { labels, components } = labelInk(ink, gridWidth, gridHeight, progress, gridHeight, total);
  const hasGlobalGrid = (() => {
    let broadRows = 0;
    let tallColumns = 0;
    for (let y = 0; y < gridHeight; y += 1) {
      let count = 0;
      const row = y * gridWidth;
      for (let x = 0; x < gridWidth; x += 1) count += ink[row + x];
      if (count >= Math.ceil(gridWidth * 0.55)) broadRows += 1;
    }
    for (let x = 0; x < gridWidth; x += 1) {
      let count = 0;
      for (let y = 0; y < gridHeight; y += 1) count += ink[y * gridWidth + x];
      if (count >= Math.ceil(gridHeight * 0.55)) tallColumns += 1;
    }
    return broadRows >= 2 && tallColumns >= 2;
  })();

  // A drawing touching the printed form frame joins it into one giant component. Printed rules
  // are thinner than pen lines: take out the long straight lines that are thinner than the
  // drawing found next to them and give each remaining part its own label.
  const originalCount = components.length;
  for (let index = 0; index < originalCount; index += 1) {
    const bounds = components[index];
    const giantGrid = hasGlobalGrid
      && bounds.right - bounds.left + 1 >= gridWidth * 0.5
      && bounds.bottom - bounds.top + 1 >= gridHeight * 0.5;
    if (!giantGrid) continue;
    const { cells, lines } = findRuledLines(labels, index + 1, bounds, gridWidth, gridHeight);
    if (!lines.length) continue;
    const trial = splitRuledComponent(labels, index + 1, cells, lines, gridWidth, gridHeight);
    const drawing = trial.parts
      .filter(part => componentIsGarment(boundsOf(part, gridWidth), gridWidth, gridHeight, gridPixels))
      .sort((a, b) => b.length - a.length)[0];
    if (!drawing) continue;
    const penWidth = strokeWidthOf(snapshot, drawing, gridWidth, gridHeight);
    const printed = lines.filter(line => ruleWidthOf(snapshot, line, gridWidth, gridHeight) < penWidth * PRINTED_RULE_SHARE);
    if (!printed.length) continue;
    let movedCells = 0;
    for (const part of splitRuledComponent(labels, index + 1, cells, printed, gridWidth, gridHeight).parts) {
      const id = components.length + 1;
      for (const cell of part) labels[cell] = id;
      components.push(boundsOf(part, gridWidth));
      movedCells += part.length;
    }
    components[index] = { ...bounds, count: bounds.count - movedCells };
  }

  const anchors: { id: number; bounds: Bounds }[] = [];
  const gridFlags = new Uint8Array(components.length + 1);
  const componentSmall = new Uint8Array(components.length + 1);
  let largestAnchor = 0;

  for (let index = 0; index < components.length; index += 1) {
    const bounds = components[index];
    const id = index + 1;
    const componentWidth = bounds.right - bounds.left + 1;
    const componentHeight = bounds.bottom - bounds.top + 1;
    const giantGrid = index < originalCount && hasGlobalGrid
      && componentWidth >= gridWidth * 0.5
      && componentHeight >= gridHeight * 0.5;
    const isGrid = giantGrid || componentIsGrid(id, labels, gridWidth, bounds);
    if (isGrid) {
      gridFlags[id] = 1;
      continue;
    }
    if (componentIsGarment(bounds, gridWidth, gridHeight, gridPixels)) {
      anchors.push({ id, bounds });
      largestAnchor = Math.max(largestAnchor, bounds.count);
    }
  }

  if (!anchors.length) {
    progress?.(total, total);
    return snapshot;
  }

  anchors.sort((a, b) => b.bounds.count - a.bounds.count);
  const selectedAnchors = anchors.filter((anchor, index) => index < 4 && anchor.bounds.count >= Math.max(20, largestAnchor * 0.12));
  const keep = makeKeepRegions(labels, gridWidth, gridHeight, selectedAnchors);
  const candidates = figureCandidates(snapshot, selectedAnchors, gridWidth, gridHeight, textMask);
  if (textMask && red) {
    const redRegions = labelInk(red, gridWidth, gridHeight);
    const shadowRegions = labelInk(shadow, gridWidth, gridHeight);
    const redFlags = labelComponentFlags(redRegions.components, gridPixels, 2, 0.02);
    const shadowFlags = labelComponentFlags(shadowRegions.components, gridPixels, Math.max(5, Math.floor(gridPixels * 0.00002)), 0.2);
    return selectCandidates(snapshot, cleanWithTextMask(
      snapshot,
      textMask,
      keep,
      labels,
      gridFlags,
      redRegions.labels,
      redFlags,
      shadowRegions.labels,
      shadowFlags,
      gridWidth,
      gridHeight,
      progress,
      gridHeight * 2,
      total,
    ), candidates);
  }
  const anchorIds = new Uint8Array(components.length + 1);
  for (const anchor of selectedAnchors) anchorIds[anchor.id] = 1;
  for (let index = 0; index < components.length; index += 1) {
    const bounds = components[index];
    const id = index + 1;
    if (anchorIds[id]) continue;
    const componentWidth = bounds.right - bounds.left + 1;
    const componentHeight = bounds.bottom - bounds.top + 1;
    const small = componentHeight <= Math.max(8, Math.ceil(gridHeight * 0.12))
      && componentWidth <= Math.max(24, Math.ceil(gridWidth * 0.2))
      && bounds.count <= Math.max(220, Math.floor(largestAnchor * 0.18));
    componentSmall[id] = small || gridFlags[id] ? 1 : 0;
  }

  let deleteMask = snapshot.deleteMask;
  let working = snapshot.working.data;
  let changed = false;
  for (let y = 0; y < height; y += 1) {
    const gridY = Math.min(gridHeight - 1, Math.floor(y * gridHeight / height));
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const gridX = Math.min(gridWidth - 1, Math.floor(x * gridWidth / width));
      const cell = gridY * gridWidth + gridX;
      const keepPixel = keep[cell] !== 0;
      const offset = (row + x) * 4;
      const kind = pixelKind(data, offset);
      const componentId = labels[cell];
      const removeInk = !keepPixel && componentSmall[componentId] === 1 && kind === 'ink';
      const removeAntialias = !keepPixel && componentSmall[componentId] === 1 && isAntialiasedInk(data, offset);
      // Preserve colored construction details inside anchored figures; review these manually.
      const removeRed = !keepPixel && kind === 'red';
      const removeShadow = !keepPixel && shadow[cell] === 1 && kind === 'shadow';
      const autoDelete = removeInk || removeAntialias || removeRed || removeShadow;
      const maskIndex = row + x;
      const previousMask = snapshot.deleteMask[maskIndex];
      let nextMask = previousMask;
      if (autoDelete && nextMask !== 255) nextMask = 255;
      if (nextMask !== snapshot.deleteMask[maskIndex]) {
        if (deleteMask === snapshot.deleteMask) deleteMask = snapshot.deleteMask.slice();
        deleteMask[maskIndex] = nextMask;
        changed = true;
      }

      if (snapshot.protectMask[maskIndex] === 255) {
        let differs = false;
        for (let channel = 0; channel < 4; channel += 1) {
          if (working[offset + channel] !== snapshot.base.data[offset + channel]) differs = true;
        }
        if (differs) {
          if (working === snapshot.working.data) working = snapshot.working.data.slice();
          for (let channel = 0; channel < 4; channel += 1) working[offset + channel] = snapshot.base.data[offset + channel];
          changed = true;
        }
        continue;
      }

      const newCoverage = (nextMask - previousMask) / 255;
      const amount = newCoverage * (1 - snapshot.protectMask[maskIndex] / 255);
      if (amount <= 0) continue;
      let differs = false;
      for (let channel = 0; channel < 4; channel += 1) {
        const next = Math.round(snapshot.working.data[offset + channel] * (1 - amount) + 255 * amount);
        if (next !== snapshot.working.data[offset + channel]) differs = true;
      }
      if (differs) {
        if (working === snapshot.working.data) working = snapshot.working.data.slice();
        for (let channel = 0; channel < 4; channel += 1) {
          working[offset + channel] = Math.round(snapshot.working.data[offset + channel] * (1 - amount) + 255 * amount);
        }
        changed = true;
      }
    }
    progress?.(gridHeight * 2 + y + 1, total);
  }

  if (!changed) {
    progress?.(total, total);
    return selectCandidates(snapshot, snapshot, candidates);
  }
  return selectCandidates(snapshot, {
    ...snapshot,
    working: working === snapshot.working.data ? snapshot.working : { ...snapshot.working, data: working },
    deleteMask,
    workVersion: snapshot.workVersion + 1,
  }, candidates);
}
