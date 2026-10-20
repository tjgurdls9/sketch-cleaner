/**
 * The centre-line graph of pen strokes: thinning, tracing into pieces between junctions, and the
 * questions both the note analysis and the line pick ask of it (which piece runs straight on,
 * which free end lies just past a gap).
 */

export interface Segment {
  points: number[];
  nodes: [number, number];
  length: number;
}

export interface LineRules {
  /** Pieces shorter than this many pen widths are merged into their junction. */
  tinyPiece: number;
  /** Free ends are bucketed this many pen widths apart. */
  dashGap: number;
  /** Lines continue straight on within this many degrees. */
  crossAngle: number;
  /** A piece this short (in pen widths) between two junctions can be the crossed line of an X. */
  bridgeMax: number;
}

const MAX_THINNING_ROUNDS = 25;
const WIDTH_SAMPLES = 2000;
const MAX_STROKE_RUN = 60;
const NEIGHBORS = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]] as const;

export function thin(ink: Uint8Array, width: number, height: number): Uint8Array {
  const skeleton = ink.slice();
  const at = (x: number, y: number): number => (x < 0 || y < 0 || x >= width || y >= height ? 0 : skeleton[y * width + x]);
  // ring[0..7] = N, NE, E, SE, S, SW, W, NW (Zhang-Suen p2..p9), reused to avoid per-pixel allocation.
  const ring = new Uint8Array(8);
  const readRing = (x: number, y: number): number => {
    ring[0] = at(x, y - 1); ring[1] = at(x + 1, y - 1); ring[2] = at(x + 1, y); ring[3] = at(x + 1, y + 1);
    ring[4] = at(x, y + 1); ring[5] = at(x - 1, y + 1); ring[6] = at(x - 1, y); ring[7] = at(x - 1, y - 1);
    return ring[0] + ring[1] + ring[2] + ring[3] + ring[4] + ring[5] + ring[6] + ring[7];
  };
  let candidates: number[] = [];
  for (let index = 0; index < skeleton.length; index += 1) if (skeleton[index]) candidates.push(index);
  // Pen strokes thin out in a few passes; solid dark areas would take hundreds, so stop early.
  for (let changed = true, round = 0; changed && round < MAX_THINNING_ROUNDS; round += 1) {
    changed = false;
    for (const pass of [0, 1]) {
      const remove: number[] = [];
      for (const index of candidates) {
        if (!skeleton[index]) continue;
        const count = readRing(index % width, (index / width) | 0);
        if (count < 2 || count > 6) continue;
        let transitions = 0;
        for (let i = 0; i < 8; i += 1) if (!ring[i] && ring[(i + 1) & 7]) transitions += 1;
        if (transitions !== 1) continue;
        const [n, , e, , south, , w] = ring;
        if (pass === 0 ? (n && e && south) || (e && south && w) : (n && e && w) || (n && south && w)) continue;
        remove.push(index);
      }
      for (const index of remove) skeleton[index] = 0;
      if (remove.length) changed = true;
    }
    candidates = candidates.filter(index => skeleton[index]);
  }
  // Drop staircase pixels: a pixel whose 8-connectivity number is 1 and that is not a line end
  // can go without splitting anything, leaving a line pixel with exactly two neighbours.
  for (let changed = true; changed;) {
    changed = false;
    for (const index of candidates) {
      if (!skeleton[index]) continue;
      if (readRing(index % width, (index / width) | 0) < 2) continue;
      // Yokoi 8-connectivity number over the four edge neighbours (N, E, S, W) and their corners.
      let connectivity = 0;
      for (const k of [2, 0, 6, 4]) {
        const edge = 1 - ring[k];
        connectivity += edge - edge * (1 - ring[(k + 7) & 7]) * (1 - ring[(k + 6) & 7]);
      }
      if (connectivity !== 1) continue;
      skeleton[index] = 0;
      changed = true;
    }
    candidates = candidates.filter(index => skeleton[index]);
  }
  return skeleton;
}

/**
 * Median pen width measured across the strokes at centre-line pixels. A median, unlike total
 * ink over centre-line length, is not thrown off by a solid dark area (a scan border).
 */
export function typicalStrokeWidth(ink: Uint8Array, skeleton: Uint8Array, width: number, height: number): number {
  const centre: number[] = [];
  for (let index = 0; index < skeleton.length; index += 1) if (skeleton[index]) centre.push(index);
  if (!centre.length) return 0;
  const step = Math.max(1, Math.floor(centre.length / WIDTH_SAMPLES));
  const run = (x: number, y: number, dx: number, dy: number): number => {
    let length = 0;
    for (let at = 1; at < MAX_STROKE_RUN; at += 1) {
      const px = x + dx * at;
      const py = y + dy * at;
      if (px < 0 || py < 0 || px >= width || py >= height || !ink[py * width + px]) break;
      length += 1;
    }
    return length;
  };
  const widths: number[] = [];
  for (let order = 0; order < centre.length; order += step) {
    const x = centre[order] % width;
    const y = (centre[order] / width) | 0;
    // The narrowest of four directions is close to the true width at any stroke angle.
    widths.push(Math.min(
      run(x, y, 1, 0) + run(x, y, -1, 0) + 1,
      run(x, y, 0, 1) + run(x, y, 0, -1) + 1,
      (run(x, y, 1, 1) + run(x, y, -1, -1) + 1) * Math.SQRT2,
      (run(x, y, 1, -1) + run(x, y, -1, 1) + 1) * Math.SQRT2,
    ));
  }
  widths.sort((a, b) => a - b);
  return Math.max(1, widths[widths.length >> 1]);
}

function neighbours(skeleton: Uint8Array, width: number, height: number, index: number): number[] {
  const x = index % width;
  const y = (index / width) | 0;
  const result: number[] = [];
  for (const [dx, dy] of NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < width && ny < height && skeleton[ny * width + nx]) result.push(ny * width + nx);
  }
  return result;
}

export function trace(skeleton: Uint8Array, width: number, height: number): { segments: Segment[]; nodeOf: Int32Array } {
  const degree = new Uint8Array(skeleton.length);
  const nodeOf = new Int32Array(skeleton.length).fill(-1);
  const pixels: number[] = [];
  for (let index = 0; index < skeleton.length; index += 1) {
    if (!skeleton[index]) continue;
    pixels.push(index);
    degree[index] = neighbours(skeleton, width, height, index).length;
  }
  let nodes = 0;
  for (const start of pixels) {
    if (degree[start] === 2 || nodeOf[start] >= 0) continue;
    const id = nodes++;
    const stack = [start];
    nodeOf[start] = id;
    while (stack.length) {
      const current = stack.pop()!;
      for (const next of neighbours(skeleton, width, height, current)) {
        if (degree[next] === 2 || nodeOf[next] >= 0) continue;
        nodeOf[next] = id;
        stack.push(next);
      }
    }
  }
  const visited = new Uint8Array(skeleton.length);
  const segments: Segment[] = [];
  const walk = (from: number, first: number): void => {
    const points = [from, first];
    visited[first] = 1;
    let previous = from;
    let current = first;
    while (nodeOf[current] < 0) {
      const next = neighbours(skeleton, width, height, current).find(candidate => candidate !== previous && !visited[candidate]
        && !(nodeOf[candidate] >= 0 && nodeOf[candidate] === nodeOf[from] && points.length < 3));
      if (next === undefined) break;
      if (nodeOf[next] < 0) visited[next] = 1;
      points.push(next);
      previous = current;
      current = next;
    }
    segments.push({ points, nodes: [nodeOf[from], nodeOf[current]], length: pathLength(points, width) });
  };
  for (const start of pixels) {
    if (nodeOf[start] < 0) continue;
    for (const next of neighbours(skeleton, width, height, start)) {
      if (nodeOf[next] >= 0 || visited[next]) continue;
      walk(start, next);
    }
  }
  return { segments, nodeOf };
}

/** Merges nodes joined by pieces shorter than `tiny`: one crossing or tip often thins into a few nodes. */
export function contractTinyPieces(traced: readonly Segment[], tiny: number): Segment[] {
  const parent = new Map<number, number>();
  const root = (node: number): number => {
    let current = node;
    while (parent.has(current) && parent.get(current) !== current) current = parent.get(current)!;
    return current;
  };
  const kept: Segment[] = [];
  for (const segment of traced) {
    const [a, b] = segment.nodes;
    if (a !== b && segment.length < tiny) parent.set(root(a), root(b));
    else kept.push(segment);
  }
  return kept.map(segment => ({ ...segment, nodes: [root(segment.nodes[0]), root(segment.nodes[1])] }));
}

/** Joins pieces that meet at a node shared by exactly two pieces: that node is a pass-through, not a junction. */
export function joinThroughNodes(traced: readonly Segment[]): { segments: Segment[]; atNode: Map<number, Segment[]> } {
  const atNode = new Map<number, Segment[]>();
  const link = (segment: Segment): void => {
    for (const node of new Set(segment.nodes)) atNode.set(node, [...(atNode.get(node) ?? []), segment]);
  };
  const unlink = (segment: Segment): void => {
    for (const node of new Set(segment.nodes)) atNode.set(node, (atNode.get(node) ?? []).filter(other => other !== segment));
  };
  traced.forEach(link);
  const live = new Set(traced);
  for (const node of [...atNode.keys()]) {
    const pair = atNode.get(node) ?? [];
    if (pair.length !== 2 || pair[0].nodes[0] === pair[0].nodes[1] || pair[1].nodes[0] === pair[1].nodes[1]) continue;
    const [first, second] = pair;
    const head = first.nodes[1] === node ? first.points : [...first.points].reverse();
    const tail = second.nodes[0] === node ? second.points : [...second.points].reverse();
    const merged: Segment = {
      points: [...head, ...tail.slice(1)],
      nodes: [first.nodes[1] === node ? first.nodes[0] : first.nodes[1], second.nodes[0] === node ? second.nodes[1] : second.nodes[0]],
      length: first.length + second.length,
    };
    unlink(first); unlink(second); live.delete(first); live.delete(second);
    link(merged); live.add(merged);
  }
  return { segments: [...live], atNode };
}

function pathLength(points: readonly number[], width: number): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) {
    const dx = (points[i] % width) - (points[i - 1] % width);
    const dy = ((points[i] / width) | 0) - ((points[i - 1] / width) | 0);
    length += Math.hypot(dx, dy);
  }
  return length;
}

export const xy = (index: number, width: number): [number, number] => [index % width, (index / width) | 0];

/** Unit direction leaving `node` along the segment, measured over `reach` pixels. */
export function direction(segment: Segment, node: number, reach: number, width: number): [number, number] {
  const points = segment.nodes[0] === node ? segment.points : [...segment.points].reverse();
  const [x0, y0] = xy(points[0], width);
  let far = points[points.length - 1];
  for (let i = 1, walked = 0; i < points.length; i += 1) {
    const [ax, ay] = xy(points[i - 1], width);
    const [bx, by] = xy(points[i], width);
    walked += Math.hypot(bx - ax, by - ay);
    if (walked >= reach) { far = points[i]; break; }
  }
  const [x1, y1] = xy(far, width);
  const length = Math.hypot(x1 - x0, y1 - y0) || 1;
  return [(x1 - x0) / length, (y1 - y0) / length];
}

export function straightness(segment: Segment, width: number): number {
  const [x0, y0] = xy(segment.points[0], width);
  const [x1, y1] = xy(segment.points[segment.points.length - 1], width);
  return segment.length ? Math.hypot(x1 - x0, y1 - y0) / segment.length : 1;
}

/**
 * Direction flips per ten stroke widths of path: a hand-drawn wavy line keeps bending left
 * and right, while hems and curved seams bend one way for long stretches.
 */
export function wiggle(segment: Segment, width: number, strokeWidth: number): number {
  const step = Math.max(2, Math.round(strokeWidth * 1.5));
  const samples: Array<[number, number]> = [];
  for (let i = 0; i < segment.points.length; i += step) samples.push(xy(segment.points[i], width));
  let flips = 0;
  let lastSign = 0;
  for (let i = 1; i < samples.length - 1; i += 1) {
    const [ax, ay] = samples[i - 1];
    const [bx, by] = samples[i];
    const [cx, cy] = samples[i + 1];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    const turn = Math.asin(Math.max(-1, Math.min(1, cross / ((Math.hypot(bx - ax, by - ay) * Math.hypot(cx - bx, cy - by)) || 1))));
    if (Math.abs(turn) < 0.25) continue;
    const sign = Math.sign(turn);
    if (lastSign && sign !== lastSign) flips += 1;
    lastSign = sign;
  }
  return flips / Math.max(1, segment.length / strokeWidth / 10);
}

/** Mean sideways swing (in stroke widths) from a short moving average of the path. */
export function swing(segment: Segment, width: number, strokeWidth: number): number {
  const step = Math.max(2, Math.round(strokeWidth * 1.5));
  const samples: Array<[number, number]> = [];
  for (let i = 0; i < segment.points.length; i += step) samples.push(xy(segment.points[i], width));
  const half = 3;
  let total = 0;
  let count = 0;
  for (let i = half; i < samples.length - half; i += 1) {
    let sx = 0;
    let sy = 0;
    for (let j = i - half; j <= i + half; j += 1) { sx += samples[j][0]; sy += samples[j][1]; }
    total += Math.hypot(samples[i][0] - sx / (half * 2 + 1), samples[i][1] - sy / (half * 2 + 1));
    count += 1;
  }
  return count ? total / count / strokeWidth : 0;
}

export function lineAngle(a: readonly [number, number], b: readonly [number, number]): number {
  const cos = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1]));
  return Math.acos(cos) * 180 / Math.PI;
}


export type LineGraph = NonNullable<ReturnType<typeof buildLineGraph>>;

/** Builds the line graph of the ink, or nothing when there is no pen stroke to measure. */
export function buildLineGraph(ink: Uint8Array, width: number, height: number, rules: LineRules) {
  const skeleton = thin(ink, width, height);
  const strokeWidth = typicalStrokeWidth(ink, skeleton, width, height);
  if (!strokeWidth) return undefined;
  const { segments, atNode } = joinThroughNodes(contractTinyPieces(trace(skeleton, width, height).segments, strokeWidth * rules.tinyPiece));
  const isEnd = (node: number): boolean => (atNode.get(node)?.length ?? 0) === 1;
  const reach = strokeWidth * 4;
  const units = (segment: Segment): number => segment.length / strokeWidth;

  // Free line ends bucketed by position, to recognise dashed stitch lines: a dash has another
  // dash lined up just past its end, a slash ends in blank paper.
  const bucket = Math.max(4, Math.round(strokeWidth * rules.dashGap));
  const ends = new Map<number, Array<{ segment: Segment; x: number; y: number }>>();
  const bucketKey = (x: number, y: number): number => Math.floor(y / bucket) * 1_000_003 + Math.floor(x / bucket);
  const freeEnds = (segment: Segment): Array<readonly [number, number]> => (
    [[segment.nodes[0], segment.points[0]], [segment.nodes[1], segment.points[segment.points.length - 1]]] as const
  ).filter(([node]) => isEnd(node));
  for (const segment of segments) {
    for (const [, point] of freeEnds(segment)) {
      const [x, y] = xy(point, width);
      const key = bucketKey(x, y);
      ends.set(key, [...(ends.get(key) ?? []), { segment, x, y }]);
    }
  }
  // The lined-up free end just past one end of a piece, if any.
  const linedUpEnd = (segment: Segment, node: number, point: number, maxGap: number): { segment: Segment; gap: number; x: number; y: number } | undefined => {
    const [x, y] = xy(point, width);
    const outward = direction(segment, node, reach, width).map(value => -value) as [number, number];
    for (let by = -1; by <= 1; by += 1) {
      for (let bx = -1; bx <= 1; bx += 1) {
        for (const end of ends.get(bucketKey(x + bx * bucket, y + by * bucket)) ?? []) {
          if (end.segment === segment) continue;
          const gap = Math.hypot(end.x - x, end.y - y);
          if (gap < 1 || gap > maxGap) continue;
          const along = ((end.x - x) * outward[0] + (end.y - y) * outward[1]) / gap;
          if (along < Math.cos(rules.crossAngle * Math.PI / 180)) continue;
          const [ex, ey] = xy(end.segment.points[0], width);
          const [fx, fy] = xy(end.segment.points[end.segment.points.length - 1], width);
          const span = Math.hypot(fx - ex, fy - ey) || 1;
          if (lineAngle(outward, [(fx - ex) / span, (fy - ey) / span]) <= rules.crossAngle) return { segment: end.segment, gap, x: end.x, y: end.y };
        }
      }
    }
    return undefined;
  };
  const otherNode = (segment: Segment, node: number): number => (segment.nodes[0] === node ? segment.nodes[1] : segment.nodes[0]);
  const alignment = (a: Segment, b: Segment, node: number): number => {
    const da = direction(a, node, reach, width);
    const db = direction(b, node, reach, width);
    return -(da[0] * db[0] + da[1] * db[1]);
  };
  // The piece at `node` that continues `from` in a straight line. A piece that lines up even
  // better with some other piece belongs to that line (e.g. a seam the slash crosses).
  const straightOnAt = (from: Segment, node: number, own: readonly [number, number], angle = rules.crossAngle): Segment | undefined => {
    let best: Segment | undefined;
    let bestDot = -Math.cos(angle * Math.PI / 180);
    for (const other of atNode.get(node) ?? []) {
      if (other === from) continue;
      const next = direction(other, node, reach, width);
      const dot = own[0] * next[0] + own[1] * next[1];
      if (dot >= bestDot) continue;
      const ownsLine = (atNode.get(node) ?? []).some(rival => rival !== other && rival !== from && alignment(other, rival, node) > -dot);
      if (ownsLine) continue;
      best = other;
      bestDot = dot;
    }
    return best;
  };
  const straightOn = (from: Segment, node: number): Segment | undefined => {
    const own = direction(from, node, reach, width);
    const direct = straightOnAt(from, node, own);
    if (direct) return direct;
    // An X crossing is often traced as two junctions joined by a short piece of the crossed line.
    for (const bridge of atNode.get(node) ?? []) {
      if (bridge === from || units(bridge) > rules.bridgeMax) continue;
      const far = otherNode(bridge, node);
      const across = straightOnAt(bridge, far, own);
      // Skip the crossed line itself: it runs on straight from the bridge.
      if (across && across !== from && alignment(bridge, across, far) < Math.cos(rules.crossAngle * Math.PI / 180)) return across;
    }
    return undefined;
  };
  return {
    strokeWidth, segments, atNode, reach, isEnd, units, freeEnds, linedUpEnd, bucket, otherNode, alignment, straightOnAt, straightOn,
  };
}
