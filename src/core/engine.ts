import { MAX_PIXELS, type Pixels, type Snapshot } from '../shared/types';

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Brush { radius: number; strength: number; hardness: number }
export type MaskTool = 'delete' | 'protect' | 'unselect';
export type LassoMode = 'inside' | 'outside';
export interface Affine { a: number; b: number; c: number; d: number; e: number; f: number }
export interface ViewTransform { zoom: number; panX: number; panY: number }
export type Fill = { kind: 'white' } | { kind: 'sample'; point: Point };
export interface Tone { brightness: number; contrast: number }
export type PixelProgress = (completed: number, total: number) => void;

export type PixelJob =
  | { type: 'guide'; snapshot: Snapshot }
  | { type: 'candidate'; snapshot: Snapshot; candidate: Pixels; transform: Affine }
  | { type: 'stroke'; snapshot: Snapshot; points: Point[]; brush: Brush; tool: MaskTool }
  | { type: 'restore'; snapshot: Snapshot; points: Point[]; brush: Brush }
  | { type: 'lasso'; snapshot: Snapshot; polygon: Point[]; mode: LassoMode }
  | { type: 'rotate'; snapshot: Snapshot; degrees: number }
  | { type: 'crop'; snapshot: Snapshot; rect: Rect }
  | { type: 'fill'; snapshot: Snapshot; fill: Fill }
  | { type: 'adjust'; snapshot: Snapshot; adjustment: Tone };

export interface History {
  past: Snapshot[];
  present: Snapshot;
  future: Snapshot[];
  nextWorkVersion: number;
  truncated: boolean;
}

export const HISTORY_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;

const pixelCount = (width: number, height: number): number => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw new RangeError('Invalid pixel dimensions');
  const count = width * height;
  if (!Number.isSafeInteger(count) || count > MAX_PIXELS) throw new RangeError('Pixel dimensions exceed the supported limit');
  return count;
};

function validatePixels(value: Pixels, label = 'pixels'): void {
  if (!value || typeof value !== 'object') throw new TypeError(`Invalid ${label}`);
  const count = pixelCount(value.width, value.height);
  if (!(value.data instanceof Uint8ClampedArray) || value.data.length !== count * 4) throw new RangeError(`Invalid ${label} buffer`);
}

function validateSnapshot(value: Snapshot): void {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid snapshot');
  validatePixels(value.base, 'base pixels');
  validatePixels(value.working, 'working pixels');
  if (value.base.width !== value.working.width || value.base.height !== value.working.height) throw new RangeError('Snapshot dimensions do not match');
  const count = pixelCount(value.base.width, value.base.height);
  if (!(value.deleteMask instanceof Uint8Array) || value.deleteMask.length !== count) throw new RangeError('Invalid delete mask');
  if (!(value.protectMask instanceof Uint8Array) || value.protectMask.length !== count) throw new RangeError('Invalid protect mask');
  if (typeof value.baseVersion !== 'string' || !Number.isSafeInteger(value.workVersion) || value.workVersion < 0) throw new TypeError('Invalid snapshot version');
}

const nextWorkVersion = (snapshot: Snapshot): number => snapshot.workVersion + 1;
const copyPixels = (value: Pixels): Pixels => ({ width: value.width, height: value.height, data: value.data.slice() });
const blankMask = (width: number, height: number): Uint8Array => new Uint8Array(pixelCount(width, height));
const withVersion = (snapshot: Snapshot, patch: Partial<Snapshot> = {}): Snapshot => ({ ...snapshot, ...patch, workVersion: nextWorkVersion(snapshot) });
const progressRows = (progress: PixelProgress | undefined, y: number, height: number): void => progress?.(y + 1, height);

export function createSnapshot(base: Pixels, baseVersion: string): Snapshot {
  validatePixels(base, 'base pixels');
  if (typeof baseVersion !== 'string' || baseVersion.length === 0) throw new TypeError('Invalid base version');
  return {
    base: copyPixels(base),
    working: copyPixels(base),
    deleteMask: blankMask(base.width, base.height),
    protectMask: blankMask(base.width, base.height),
    baseVersion,
    workVersion: 0,
  };
}

function validateBrush(brush: Brush): void {
  if (!brush || !Number.isFinite(brush.radius) || brush.radius <= 0) throw new RangeError('Brush radius must be positive');
  if (!Number.isFinite(brush.strength) || brush.strength < 0 || brush.strength > 1) throw new RangeError('Brush strength must be between 0 and 1');
  if (!Number.isFinite(brush.hardness) || brush.hardness < 0 || brush.hardness > 1) throw new RangeError('Brush hardness must be between 0 and 1');
}

function validatePoints(points: readonly Point[], minLength = 1): void {
  if (!Array.isArray(points) || points.length < minLength || points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new TypeError('Invalid image points');
}

function brushCoverage(distance: number, brush: Brush): number {
  if (distance >= brush.radius || brush.strength === 0) return 0;
  const inner = brush.radius * brush.hardness;
  if (distance <= inner || inner === brush.radius) return 1;
  const t = (brush.radius - distance) / (brush.radius - inner);
  return t * t * (3 - 2 * t);
}

function segmentBounds(a: Point, b: Point, radius: number, width: number, height: number): Rect {
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x) - radius));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y) - radius));
  const maxX = Math.min(width, Math.ceil(Math.max(a.x, b.x) + radius));
  const maxY = Math.min(height, Math.ceil(Math.max(a.y, b.y) + radius));
  return { x: minX, y: minY, width: Math.max(0, maxX - minX), height: Math.max(0, maxY - minY) };
}

function segmentDistance(x: number, y: number, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

interface RasterizedStroke { bounds: Rect; coverage: Uint8Array; total: number }

function rasterizeStroke(points: readonly Point[], brush: Brush, width: number, height: number, progress?: PixelProgress): RasterizedStroke {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x); minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x); maxY = Math.max(maxY, point.y);
  }
  const bounds = {
    x: Math.max(0, Math.floor(minX - brush.radius)),
    y: Math.max(0, Math.floor(minY - brush.radius)),
    width: 0,
    height: 0,
  };
  const right = Math.min(width, Math.ceil(maxX + brush.radius));
  const bottom = Math.min(height, Math.ceil(maxY + brush.radius));
  bounds.width = Math.max(0, right - bounds.x);
  bounds.height = Math.max(0, bottom - bounds.y);
  const coverage = new Uint8Array(bounds.width * bounds.height);
  const segmentCount = Math.max(1, points.length - 1);
  const total = segmentCount + bounds.height;
  for (let segment = 0; segment < segmentCount; segment++) {
    const a = points[points.length === 1 ? 0 : segment];
    const b = points[points.length === 1 ? 0 : segment + 1];
    const rect = segmentBounds(a, b, brush.radius, width, height);
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++) {
        const amount = brushCoverage(segmentDistance(x + 0.5, y + 0.5, a, b), brush);
        if (!amount) continue;
        const index = (y - bounds.y) * bounds.width + x - bounds.x;
        coverage[index] = Math.max(coverage[index], Math.round(amount * 255));
      }
    }
    progress?.(segment + 1, total);
  }
  return { bounds, coverage, total };
}

export function paintStroke(snapshot: Snapshot, points: readonly Point[], brush: Brush, tool: MaskTool, progress?: PixelProgress): Snapshot {
  validateSnapshot(snapshot);
  validateBrush(brush);
  validatePoints(points);
  if (tool !== 'delete' && tool !== 'protect' && tool !== 'unselect') throw new TypeError('Invalid mask tool');
  if (brush.strength === 0) return snapshot;
  const { width } = snapshot.base;
  const { bounds, coverage, total } = rasterizeStroke(points, brush, width, snapshot.base.height, progress);
  if (!bounds.width || !bounds.height) return snapshot;
  let deleteMask = snapshot.deleteMask;
  let protectMask = snapshot.protectMask;
  let working = snapshot.working.data;
  let changed = false;
  for (let row = 0; row < bounds.height; row++) {
    const y = bounds.y + row;
    for (let column = 0; column < bounds.width; column++) {
      const x = bounds.x + column;
      const amount = coverage[row * bounds.width + column] / 255;
      if (!amount) continue;
      const index = y * width + x;
      if (tool === 'delete') {
        const value = Math.round(snapshot.deleteMask[index] + amount * brush.strength * (255 - snapshot.deleteMask[index]));
        if (value !== snapshot.deleteMask[index]) {
          if (deleteMask === snapshot.deleteMask) deleteMask = snapshot.deleteMask.slice();
          deleteMask[index] = value;
          changed = true;
        }
      } else if (tool === 'protect') {
        if (snapshot.protectMask[index] !== 255) {
          if (protectMask === snapshot.protectMask) protectMask = snapshot.protectMask.slice();
          protectMask[index] = 255;
          changed = true;
        }
        const byte = index * 4;
        for (let channel = 0; channel < 4; channel++) {
          if (working[byte + channel] !== snapshot.base.data[byte + channel]) {
            if (working === snapshot.working.data) working = snapshot.working.data.slice();
            changed = true;
          }
          working[byte + channel] = snapshot.base.data[byte + channel];
        }
      } else {
        const strength = amount * brush.strength;
        const deleteValue = Math.round(snapshot.deleteMask[index] * (1 - strength));
        const protectValue = Math.round(snapshot.protectMask[index] * (1 - strength));
        if (deleteValue !== snapshot.deleteMask[index]) {
          if (deleteMask === snapshot.deleteMask) deleteMask = snapshot.deleteMask.slice();
          changed = true;
        }
        if (protectValue !== snapshot.protectMask[index]) {
          if (protectMask === snapshot.protectMask) protectMask = snapshot.protectMask.slice();
          changed = true;
        }
        deleteMask[index] = deleteValue;
        protectMask[index] = protectValue;
      }
    }
    progress?.(total - bounds.height + row + 1, total);
  }
  if (!changed) return snapshot;
  return withVersion(snapshot, {
    deleteMask,
    protectMask,
    working: working === snapshot.working.data ? snapshot.working : { ...snapshot.working, data: working },
  });
}

function mixedPixel(source: Uint8ClampedArray, offset: number, candidate: readonly number[], amount: number, output: number[]): boolean {
  let changed = false;
  for (let channel = 0; channel < 4; channel++) {
    const value = amount >= 1 ? candidate[channel] : Math.round(source[offset + channel] * (1 - amount) + candidate[channel] * amount);
    output[channel] = value;
    if (value !== source[offset + channel]) changed = true;
  }
  return changed;
}

export function restoreStroke(snapshot: Snapshot, points: readonly Point[], brush: Brush, progress?: PixelProgress): Snapshot {
  validateSnapshot(snapshot);
  validateBrush(brush);
  validatePoints(points);
  if (brush.strength === 0) return snapshot;
  const { width } = snapshot.base;
  const { bounds, coverage, total } = rasterizeStroke(points, brush, width, snapshot.base.height, progress);
  if (!bounds.width || !bounds.height) return snapshot;
  let working = snapshot.working.data;
  let changed = false;
  for (let row = 0; row < bounds.height; row++) {
    const y = bounds.y + row;
    for (let column = 0; column < bounds.width; column++) {
      const x = bounds.x + column;
      const amount = (coverage[row * bounds.width + column] / 255) * brush.strength;
      if (!amount) continue;
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const next = amount >= 1 ? snapshot.base.data[offset + channel] : Math.round(snapshot.working.data[offset + channel] * (1 - amount) + snapshot.base.data[offset + channel] * amount);
        if (next !== snapshot.working.data[offset + channel]) {
          if (working === snapshot.working.data) working = snapshot.working.data.slice();
          changed = true;
        }
        working[offset + channel] = next;
      }
    }
    progress?.(total - bounds.height + row + 1, total);
  }
  return changed ? withVersion(snapshot, { working: { ...snapshot.working, data: working } }) : snapshot;
}

export function selectLasso(snapshot: Snapshot, polygon: readonly Point[], mode: LassoMode, progress?: PixelProgress): Snapshot {
  validateSnapshot(snapshot);
  validatePoints(polygon, 3);
  if (mode !== 'inside' && mode !== 'outside') throw new TypeError('Invalid lasso mode');
  const { width, height } = snapshot.base;
  const deleteMask = new Uint8Array(width * height);
  const intersections: number[] = [];
  let changed = false;
  for (let y = 0; y < height; y++) {
    const scanY = y + 0.5;
    intersections.length = 0;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const a = polygon[i];
      const b = polygon[j];
      if ((a.y > scanY) !== (b.y > scanY)) intersections.push(((b.x - a.x) * (scanY - a.y)) / (b.y - a.y) + a.x);
    }
    intersections.sort((a, b) => a - b);
    const rowStart = y * width;
    if (mode === 'outside') deleteMask.fill(255, rowStart, rowStart + width);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const left = Math.max(0, Math.ceil(intersections[i] - 0.5));
      const right = Math.min(width, Math.ceil(intersections[i + 1] - 0.5));
      if (right > left) deleteMask.fill(mode === 'inside' ? 255 : 0, rowStart + left, rowStart + right);
    }
    for (let x = 0; x < width; x++) {
      const index = rowStart + x;
      const value = deleteMask[index];
      if (value !== snapshot.deleteMask[index]) changed = true;
    }
    progressRows(progress, y, height);
  }
  return changed ? withVersion(snapshot, { deleteMask }) : snapshot;
}

function effectiveMask(snapshot: Snapshot, index: number): number {
  return (snapshot.deleteMask[index] / 255) * (1 - snapshot.protectMask[index] / 255);
}

function samplePixel(value: Pixels, x: number, y: number, output: number[]): boolean {
  if (x < 0 || y < 0 || x >= value.width || y >= value.height) return false;
  const fx = Math.max(0, Math.min(value.width - 1, x - 0.5));
  const fy = Math.max(0, Math.min(value.height - 1, y - 0.5));
  const x0 = Math.max(0, Math.floor(fx));
  const y0 = Math.max(0, Math.floor(fy));
  const x1 = Math.min(value.width - 1, x0 + 1);
  const y1 = Math.min(value.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - Math.floor(fx)));
  const ty = Math.max(0, Math.min(1, fy - Math.floor(fy)));
  const topLeft = (y0 * value.width + x0) * 4;
  const topRight = (y0 * value.width + x1) * 4;
  const bottomLeft = (y1 * value.width + x0) * 4;
  const bottomRight = (y1 * value.width + x1) * 4;
  for (let channel = 0; channel < 4; channel++) {
    const top = value.data[topLeft + channel] * (1 - tx) + value.data[topRight + channel] * tx;
    const bottom = value.data[bottomLeft + channel] * (1 - tx) + value.data[bottomRight + channel] * tx;
    output[channel] = Math.round(top * (1 - ty) + bottom * ty);
  }
  return true;
}

function validateAffine(transform: Affine): void {
  if (!transform || Object.values(transform).some((value) => !Number.isFinite(value))) throw new TypeError('Invalid candidate transform');
  if (Math.abs(transform.a * transform.d - transform.b * transform.c) < Number.EPSILON) throw new RangeError('Candidate transform is singular');
}

export function applyCandidate(snapshot: Snapshot, candidate: Pixels, transform: Affine, progress?: PixelProgress): Snapshot {
  validateSnapshot(snapshot);
  validatePixels(candidate, 'candidate pixels');
  validateAffine(transform);
  const { width, height } = snapshot.base;
  let working = snapshot.working.data;
  const sample = [0, 0, 0, 0];
  const blended = [0, 0, 0, 0];
  const determinant = transform.a * transform.d - transform.b * transform.c;
  let changed = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const maskIndex = y * width + x;
      const offset = maskIndex * 4;
      if (snapshot.protectMask[maskIndex] === 255) {
        let differs = false;
        for (let channel = 0; channel < 4; channel++) {
          if (snapshot.working.data[offset + channel] !== snapshot.base.data[offset + channel]) differs = true;
        }
        if (differs) {
          if (working === snapshot.working.data) working = snapshot.working.data.slice();
          for (let channel = 0; channel < 4; channel++) working[offset + channel] = snapshot.base.data[offset + channel];
          changed = true;
        }
        continue;
      }
      const amount = effectiveMask(snapshot, maskIndex);
      if (amount === 0) continue;
      const targetX = x + 0.5 - transform.e;
      const targetY = y + 0.5 - transform.f;
      const sourceX = (transform.d * targetX - transform.c * targetY) / determinant;
      const sourceY = (-transform.b * targetX + transform.a * targetY) / determinant;
      if (!samplePixel(candidate, sourceX, sourceY, sample)) continue;
      if (mixedPixel(snapshot.working.data, offset, sample, amount, blended)) {
        if (working === snapshot.working.data) working = snapshot.working.data.slice();
        for (let channel = 0; channel < 4; channel++) working[offset + channel] = blended[channel];
        changed = true;
      }
    }
    progressRows(progress, y, height);
  }
  return changed ? withVersion(snapshot, { working: { ...snapshot.working, data: working } }) : snapshot;
}

function selectedEdit(snapshot: Snapshot, candidateAt: (x: number, y: number, output: number[]) => boolean, progress?: PixelProgress): Snapshot {
  const { width, height } = snapshot.base;
  let working = snapshot.working.data;
  const sample = [0, 0, 0, 0];
  const blended = [0, 0, 0, 0];
  let changed = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const offset = index * 4;
      if (snapshot.protectMask[index] === 255) {
        let differs = false;
        for (let channel = 0; channel < 4; channel++) {
          if (snapshot.working.data[offset + channel] !== snapshot.base.data[offset + channel]) differs = true;
        }
        if (differs) {
          if (working === snapshot.working.data) working = snapshot.working.data.slice();
          for (let channel = 0; channel < 4; channel++) working[offset + channel] = snapshot.base.data[offset + channel];
          changed = true;
        }
        continue;
      }
      const amount = effectiveMask(snapshot, index);
      if (amount === 0 || !candidateAt(x, y, sample)) continue;
      if (mixedPixel(snapshot.working.data, offset, sample, amount, blended)) {
        if (working === snapshot.working.data) working = snapshot.working.data.slice();
        for (let channel = 0; channel < 4; channel++) working[offset + channel] = blended[channel];
        changed = true;
      }
    }
    progressRows(progress, y, height);
  }
  return changed ? withVersion(snapshot, { working: { ...snapshot.working, data: working } }) : snapshot;
}

export function fillSelection(snapshot: Snapshot, fill: Fill, progress?: PixelProgress): Snapshot {
  validateSnapshot(snapshot);
  let color: number[];
  if (fill?.kind === 'white') color = [255, 255, 255, 255];
  else if (fill?.kind === 'sample') {
    const { x, y } = fill.point;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= snapshot.working.width || y >= snapshot.working.height) throw new RangeError('Sample point is outside the image');
    const offset = (Math.floor(y) * snapshot.working.width + Math.floor(x)) * 4;
    color = [...snapshot.working.data.slice(offset, offset + 4)];
  } else throw new TypeError('Invalid fill');
  return selectedEdit(snapshot, (_x, _y, output) => {
    output[0] = color[0]; output[1] = color[1]; output[2] = color[2]; output[3] = color[3];
    return true;
  }, progress);
}

export function adjustSelection(snapshot: Snapshot, adjustment: Tone, progress?: PixelProgress): Snapshot {
  validateSnapshot(snapshot);
  if (!adjustment || !Number.isFinite(adjustment.brightness) || adjustment.brightness < -255 || adjustment.brightness > 255) throw new RangeError('Brightness must be between -255 and 255');
  if (!Number.isFinite(adjustment.contrast) || adjustment.contrast < -100 || adjustment.contrast > 100) throw new RangeError('Contrast must be between -100 and 100');
  const gain = 1 + adjustment.contrast / 100;
  return selectedEdit(snapshot, (_x, _y, output) => {
    const offset = _y * snapshot.working.width + _x;
    for (let channel = 0; channel < 3; channel++) output[channel] = Math.max(0, Math.min(255, Math.round((snapshot.working.data[offset * 4 + channel] - 128) * gain + 128 + adjustment.brightness)));
    output[3] = snapshot.working.data[offset * 4 + 3];
    return true;
  }, progress);
}

function transformedPixels(source: Pixels, width: number, height: number, map: (x: number, y: number, output: number[]) => void, progress?: PixelProgress): Pixels {
  pixelCount(width, height);
  const result: Pixels = { width, height, data: new Uint8ClampedArray(width * height * 4) };
  const sample = [0, 0, 0, 0];
  const sourcePoint = [0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      map(x + 0.5, y + 0.5, sourcePoint);
      if (samplePixel(source, sourcePoint[0], sourcePoint[1], sample)) {
        for (let channel = 0; channel < 4; channel++) result.data[offset + channel] = sample[channel];
      } else {
        result.data[offset] = 255;
        result.data[offset + 1] = 255;
        result.data[offset + 2] = 255;
        result.data[offset + 3] = 255;
      }
    }
    progressRows(progress, y, height);
  }
  return result;
}

function basisChanged(snapshot: Snapshot, base: Pixels, working: Pixels): Snapshot {
  const nextVersion = nextWorkVersion(snapshot);
  return {
    base,
    working,
    deleteMask: blankMask(base.width, base.height),
    protectMask: blankMask(base.width, base.height),
    baseVersion: `${snapshot.baseVersion}:${nextVersion}`,
    workVersion: nextVersion,
  };
}

export function rotateBasis(snapshot: Snapshot, degrees: number, progress?: PixelProgress): Snapshot {
  validateSnapshot(snapshot);
  if (!Number.isFinite(degrees)) throw new TypeError('Invalid rotation angle');
  let angle = degrees % 360;
  if (angle > 180) angle -= 360;
  if (angle < -180) angle += 360;
  if (Math.abs(angle) < 1e-10) return snapshot;
  const radians = angle * Math.PI / 180;
  let cosine = Math.cos(radians);
  let sine = Math.sin(radians);
  if (Math.abs(cosine) < 1e-10) cosine = 0;
  if (Math.abs(sine) < 1e-10) sine = 0;
  const { width, height } = snapshot.base;
  const resultWidth = Math.ceil(Math.abs(cosine) * width + Math.abs(sine) * height - 1e-10);
  const resultHeight = Math.ceil(Math.abs(sine) * width + Math.abs(cosine) * height - 1e-10);
  const totalRows = resultHeight * 2;
  const map = (x: number, y: number, output: number[]): void => {
    const dx = x - resultWidth / 2;
    const dy = y - resultHeight / 2;
    output[0] = cosine * dx + sine * dy + width / 2;
    output[1] = -sine * dx + cosine * dy + height / 2;
  };
  return basisChanged(snapshot,
    transformedPixels(snapshot.base, resultWidth, resultHeight, map, progress ? (done) => progress(done, totalRows) : undefined),
    transformedPixels(snapshot.working, resultWidth, resultHeight, map, progress ? (done) => progress(resultHeight + done, totalRows) : undefined));
}

export function cropBasis(snapshot: Snapshot, rect: Rect, progress?: PixelProgress): Snapshot {
  validateSnapshot(snapshot);
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) throw new TypeError('Invalid crop rectangle');
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  const right = Math.ceil(rect.x + rect.width);
  const bottom = Math.ceil(rect.y + rect.height);
  const width = right - x;
  const height = bottom - y;
  pixelCount(width, height);
  if (x < 0 || y < 0 || right > snapshot.base.width || bottom > snapshot.base.height) throw new RangeError('Crop rectangle is outside the image');
  if (x === 0 && y === 0 && width === snapshot.base.width && height === snapshot.base.height) return snapshot;
  const crop = (source: Pixels, offsetRows: number): Pixels => {
    const result: Pixels = { width, height, data: new Uint8ClampedArray(width * height * 4) };
    for (let row = 0; row < height; row++) {
      const from = ((y + row) * source.width + x) * 4;
      result.data.set(source.data.subarray(from, from + width * 4), row * width * 4);
      progress?.(offsetRows + row + 1, height * 2);
    }
    return result;
  };
  const base = crop(snapshot.base, 0);
  const working = crop(snapshot.working, height);
  return basisChanged(snapshot, base, working);
}

export function imageToView(point: Point, view: ViewTransform): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(view.zoom) || view.zoom <= 0 || !Number.isFinite(view.panX) || !Number.isFinite(view.panY)) throw new RangeError('Invalid view transform');
  return { x: point.x * view.zoom + view.panX, y: point.y * view.zoom + view.panY };
}

export function viewToImage(point: Point, view: ViewTransform): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(view.zoom) || view.zoom <= 0 || !Number.isFinite(view.panX) || !Number.isFinite(view.panY)) throw new RangeError('Invalid view transform');
  return { x: (point.x - view.panX) / view.zoom, y: (point.y - view.panY) / view.zoom };
}

export function createGuide(snapshot: Snapshot, progress?: PixelProgress): Pixels {
  validateSnapshot(snapshot);
  const { width, height, data } = snapshot.working;
  const result = copyPixels(snapshot.working);
  const protectColor = [0, 90, 255];
  const deleteColor = [255, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const mask = snapshot.protectMask[index] || snapshot.deleteMask[index];
      if (!mask) continue;
      const offset = index * 4;
      const color = snapshot.protectMask[index] ? protectColor : deleteColor;
      const opacity = (mask / 255) * 0.52;
      for (let channel = 0; channel < 3; channel++) result.data[offset + channel] = Math.round(data[offset + channel] * (1 - opacity) + color[channel] * opacity);
    }
    progressRows(progress, y, height);
  }
  return result;
}

function historyMemoryBytes(snapshots: readonly Snapshot[]): number {
  const buffers = new Set<ArrayBufferLike>();
  let bytes = 0;
  for (const snapshot of snapshots) {
    for (const data of [snapshot.base.data, snapshot.working.data, snapshot.deleteMask, snapshot.protectMask]) {
      if (!buffers.has(data.buffer)) {
        buffers.add(data.buffer);
        bytes += data.buffer.byteLength;
      }
    }
  }
  return bytes;
}

function trimHistory(past: Snapshot[], present: Snapshot, future: Snapshot[]): boolean {
  let truncated = false;
  // shortcut: full snapshots use one buffer per changed image state, keep only 512 MiB and upgrade to pixel deltas if that still strains target PCs.
  while (past.length > 1 && historyMemoryBytes([...past, present, ...future]) > HISTORY_MEMORY_LIMIT_BYTES) {
    past.shift();
    truncated = true;
  }
  return truncated;
}

export function createHistory(snapshot: Snapshot): History {
  validateSnapshot(snapshot);
  return { past: [], present: snapshot, future: [], nextWorkVersion: snapshot.workVersion + 1, truncated: false };
}

export function commitHistory(history: History, snapshot: Snapshot): History {
  validateSnapshot(history.present);
  validateSnapshot(snapshot);
  if (snapshot === history.present) return history;
  const present = { ...snapshot, workVersion: history.nextWorkVersion };
  const past = [...history.past, history.present];
  const truncated = trimHistory(past, present, []);
  return { past, present, future: [], nextWorkVersion: history.nextWorkVersion + 1, truncated: history.truncated || truncated };
}

export function undoHistory(history: History): History {
  if (!history.past.length) return history;
  const present = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: { ...present, workVersion: history.nextWorkVersion },
    future: [history.present, ...history.future],
    nextWorkVersion: history.nextWorkVersion + 1,
    truncated: history.truncated,
  };
}

export function redoHistory(history: History): History {
  if (!history.future.length) return history;
  const present = history.future[0];
  return {
    past: [...history.past, history.present],
    present: { ...present, workVersion: history.nextWorkVersion },
    future: history.future.slice(1),
    nextWorkVersion: history.nextWorkVersion + 1,
    truncated: history.truncated,
  };
}

export function historySnapshot(history: History): Snapshot {
  validateSnapshot(history.present);
  return history.present;
}

export function runPixelJob(job: PixelJob, progress?: PixelProgress): Pixels | Snapshot {
  if (!job || typeof job !== 'object') throw new TypeError('Invalid pixel job');
  switch (job.type) {
    case 'guide': return createGuide(job.snapshot, progress);
    case 'candidate': return applyCandidate(job.snapshot, job.candidate, job.transform, progress);
    case 'stroke': return paintStroke(job.snapshot, job.points, job.brush, job.tool, progress);
    case 'restore': return restoreStroke(job.snapshot, job.points, job.brush, progress);
    case 'lasso': return selectLasso(job.snapshot, job.polygon, job.mode, progress);
    case 'rotate': return rotateBasis(job.snapshot, job.degrees, progress);
    case 'crop': return cropBasis(job.snapshot, job.rect, progress);
    case 'fill': return fillSelection(job.snapshot, job.fill, progress);
    case 'adjust': return adjustSelection(job.snapshot, job.adjustment, progress);
    default: throw new TypeError('Unsupported pixel job');
  }
}
