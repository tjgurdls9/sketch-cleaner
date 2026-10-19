/**
 * Sorts the ink inside a garment figure into drawing and annotation. Drawing: long lines,
 * dashed stitch lines, stitch-end slashes and zipper wavy lines. Annotation: handwriting,
 * leaders and arrows from notes, small scribbles such as scissor marks, and coloured solid
 * lines. The annotation mask is only a selection candidate; callers never erase it
 * automatically because the same shapes can be real design details.
 */

interface Segment {
  points: number[];
  nodes: [number, number];
  length: number;
}

export interface MarkStats {
  strokeWidth: number;
  kept: number;
  candidates: number;
}

export interface FigureInk {
  /** 1 where the pixel is ink of any colour. */
  ink: Uint8Array;
  /** 1 where the ink is coloured (blue and similar), not black. */
  colored?: Uint8Array;
  /** 255 where the text detector found writing. */
  text?: Uint8Array;
}

const MAX_THINNING_ROUNDS = 25;
const WIDTH_SAMPLES = 2000;
const MAX_STROKE_RUN = 60;
const NEIGHBORS = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]] as const;

function thin(ink: Uint8Array, width: number, height: number): Uint8Array {
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
function typicalStrokeWidth(ink: Uint8Array, skeleton: Uint8Array, width: number, height: number): number {
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

function trace(skeleton: Uint8Array, width: number, height: number): { segments: Segment[]; nodeOf: Int32Array } {
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
function contractTinyPieces(traced: readonly Segment[], tiny: number): Segment[] {
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
function joinThroughNodes(traced: readonly Segment[]): { segments: Segment[]; atNode: Map<number, Segment[]> } {
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

const xy = (index: number, width: number): [number, number] => [index % width, (index / width) | 0];

/** Unit direction leaving `node` along the segment, measured over `reach` pixels. */
function direction(segment: Segment, node: number, reach: number, width: number): [number, number] {
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

function straightness(segment: Segment, width: number): number {
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

export const MARK_RULES = {
  slashMin: 1.5,
  scribbleShare: 0.5,
  arrowHeadMax: 9,
  arrowSpread: [15, 160],
  slashMax: 18,
  slashStraight: 0.85,
  hostMin: 8,
  lineRun: 24,
  sweepLine: 16,
  scribbleMax: 35,
  loneStroke: 10,
  scissorExtra: 3,
  scissorReach: 7,
  scissorCurl: 0.85,
  scissorCurlMin: 5,
  bridgeMax: 5,
  tinyPiece: 1.5,
  dashGap: 5,
  stitchGap: 5,
  stitchShare: 0.6,
  crossAngle: 25,
  outlineAngle: 40,
  wavyMin: 12,
  wavyWiggle: 0.5,
  wavySwing: 0.25,
};

function lineAngle(a: readonly [number, number], b: readonly [number, number]): number {
  const cos = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1]));
  return Math.acos(cos) * 180 / Math.PI;
}

/**
 * Returns a 0/255 mask of annotation ink inside a figure crop. Pixels that also belong to a
 * kept drawing line are left out, so filling the mask never breaks the drawing.
 */
/**
 * Pieces that lie on a closed loop of the line graph (not bridges). Belt loops, pockets and
 * waistband ends close up with the drawing; notes hang off it at one end.
 */
function piecesOnLoops(segments: readonly Segment[]): Set<Segment> {
  const adjacency = new Map<number, Array<{ to: number; edge: number }>>();
  segments.forEach((segment, edge) => {
    const [a, b] = segment.nodes;
    adjacency.set(a, [...(adjacency.get(a) ?? []), { to: b, edge }]);
    if (a !== b) adjacency.set(b, [...(adjacency.get(b) ?? []), { to: a, edge }]);
  });
  const order = new Map<number, number>();
  const low = new Map<number, number>();
  const bridges = new Set<number>();
  let counter = 0;
  for (const root of adjacency.keys()) {
    if (order.has(root)) continue;
    // Iterative depth-first search (Tarjan) so large drawings do not overflow the stack.
    const stack: Array<{ node: number; via: number; next: number }> = [{ node: root, via: -1, next: 0 }];
    order.set(root, counter); low.set(root, counter); counter += 1;
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const links = adjacency.get(frame.node) ?? [];
      if (frame.next < links.length) {
        const { to, edge } = links[frame.next++];
        if (edge === frame.via) continue;
        if (!order.has(to)) {
          order.set(to, counter); low.set(to, counter); counter += 1;
          stack.push({ node: to, via: edge, next: 0 });
        } else {
          low.set(frame.node, Math.min(low.get(frame.node)!, order.get(to)!));
        }
        continue;
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      if (!parent) continue;
      low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node)! > order.get(parent.node)!) bridges.add(frame.via);
    }
  }
  return new Set(segments.filter((_, edge) => !bridges.has(edge)));
}

export function findAnnotationInk(figure: FigureInk, width: number, height: number, stats?: MarkStats): Uint8Array {
  const { ink, colored, text } = figure;
  const result = new Uint8Array(ink.length);
  const skeleton = thin(ink, width, height);
  const strokeWidth = typicalStrokeWidth(ink, skeleton, width, height);
  if (!strokeWidth) return result;
  const { segments, atNode } = joinThroughNodes(contractTinyPieces(trace(skeleton, width, height).segments, strokeWidth * MARK_RULES.tinyPiece));
  const isEnd = (node: number): boolean => (atNode.get(node)?.length ?? 0) === 1;
  const reach = strokeWidth * 4;
  const units = (segment: Segment): number => segment.length / strokeWidth;

  // Free line ends bucketed by position, to recognise dashed stitch lines: a dash has another
  // dash lined up just past its end, a slash ends in blank paper.
  const bucket = Math.max(4, Math.round(strokeWidth * MARK_RULES.dashGap));
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
  const isDash = (segment: Segment): boolean => {
    for (const [node, point] of freeEnds(segment)) {
      const [x, y] = xy(point, width);
      const outward = direction(segment, node, reach, width).map(value => -value) as [number, number];
      for (let by = -1; by <= 1; by += 1) {
        for (let bx = -1; bx <= 1; bx += 1) {
          for (const end of ends.get(bucketKey(x + bx * bucket, y + by * bucket)) ?? []) {
            if (end.segment === segment) continue;
            const gap = Math.hypot(end.x - x, end.y - y);
            if (gap < 1 || gap > bucket) continue;
            const along = ((end.x - x) * outward[0] + (end.y - y) * outward[1]) / gap;
            if (along < Math.cos(MARK_RULES.crossAngle * Math.PI / 180)) continue;
            const [ex, ey] = xy(end.segment.points[0], width);
            const [fx, fy] = xy(end.segment.points[end.segment.points.length - 1], width);
            const span = Math.hypot(fx - ex, fy - ey) || 1;
            if (lineAngle(outward, [(fx - ex) / span, (fy - ey) / span]) <= MARK_RULES.crossAngle) return true;
          }
        }
      }
    }
    return false;
  };
  const otherNode = (segment: Segment, node: number): number => (segment.nodes[0] === node ? segment.nodes[1] : segment.nodes[0]);
  const alignment = (a: Segment, b: Segment, node: number): number => {
    const da = direction(a, node, reach, width);
    const db = direction(b, node, reach, width);
    return -(da[0] * db[0] + da[1] * db[1]);
  };
  // The piece at `node` that continues `from` in a straight line. A piece that lines up even
  // better with some other piece belongs to that line (e.g. a seam the slash crosses).
  const straightOnAt = (from: Segment, node: number, own: readonly [number, number], angle = MARK_RULES.crossAngle): Segment | undefined => {
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
      if (bridge === from || units(bridge) > MARK_RULES.bridgeMax) continue;
      const far = otherNode(bridge, node);
      const across = straightOnAt(bridge, far, own);
      // Skip the crossed line itself: it runs on straight from the bridge.
      if (across && across !== from && alignment(bridge, across, far) < Math.cos(MARK_RULES.crossAngle * Math.PI / 180)) return across;
    }
    return undefined;
  };
  // Total length (in stroke widths) of the straight line a piece is part of.
  const lineRunOf = (segment: Segment, angle = MARK_RULES.crossAngle): number => {
    let total = segment.length;
    for (const start of segment.nodes) {
      let current = segment;
      let at = start;
      for (let hops = 0; hops < 8 && !isEnd(at); hops += 1) {
        const next = straightOnAt(current, at, direction(current, at, reach, width), angle);
        if (!next || next === segment) break;
        total += next.length;
        at = otherNode(next, at);
        current = next;
      }
    }
    return total / strokeWidth;
  };
  const continuesAsLine = (from: Segment, node: number): boolean => {
    let current = from;
    let at = node;
    let travelled = 0;
    for (let hops = 0; hops < 6; hops += 1) {
      const next = straightOn(current, at);
      if (!next) return false;
      travelled += next.length;
      if (travelled / strokeWidth > MARK_RULES.lineRun) return true;
      at = otherNode(next, at);
      if (isEnd(at)) return false;
      current = next;
    }
    return true;
  };
  const isWavy = (segment: Segment): boolean => wiggle(segment, width, strokeWidth) >= MARK_RULES.wavyWiggle
    && swing(segment, width, strokeWidth) >= MARK_RULES.wavySwing;
  const share = (segment: Segment, mask: Uint8Array | undefined): number => {
    if (!mask) return 0;
    let hits = 0;
    for (const index of segment.points) if (mask[index]) hits += 1;
    return hits / segment.points.length;
  };

  // Leaders start at a note and run to the drawing: follow a line from a free end in the
  // writing until it meets the drawing, then take the arrowhead strokes there.
  const nearText = (point: number): boolean => {
    if (!text) return false;
    const [cx, cy] = xy(point, width);
    const radius = Math.ceil(strokeWidth * 3);
    for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
      for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) if (text[y * width + x]) return true;
    }
    return false;
  };
  // --- Drawing details that must stay -----------------------------------------------------
  const keep = new Set<Segment>();
  const isSlash = (segment: Segment): boolean => {
    const [a, b] = segment.nodes;
    const free = isEnd(a) ? a : isEnd(b) ? b : -1;
    const junction = free === a ? b : a;
    if (free < 0 || isEnd(junction) || units(segment) < MARK_RULES.slashMin || units(segment) > MARK_RULES.slashMax) return false;
    // A short line whose free end touches writing is a leader to that note, not a stitch end.
    if (nearText(freeEnds(segment)[0][1])) return false;
    if (straightness(segment, width) < MARK_RULES.slashStraight) return false;
    const own = direction(segment, junction, reach, width);
    // Stitch-end slashes cross a real drawing line, not a loop or a scribble.
    const hosts = (atNode.get(junction) ?? []).filter(other => other !== segment && units(other) >= MARK_RULES.hostMin
      && other.nodes[0] !== other.nodes[1] && lineRunOf(other) >= MARK_RULES.lineRun);
    if (!hosts.some(host => lineAngle(own, direction(host, junction, reach, width)) >= MARK_RULES.crossAngle)) return false;
    // A slash crosses a line that runs on through the crossing; an arrowhead sits where its
    // shaft ends, with only the other head stroke beside it.
    const through = (atNode.get(junction) ?? []).filter(other => other !== segment
      && !(freeEnds(other).length && units(other) <= MARK_RULES.arrowHeadMax));
    if (through.length < 2) return false;
    // A drawing line that just overshoots another line keeps going; a slash ends soon.
    return !continuesAsLine(segment, junction) && !isDash(segment);
  };
  for (const segment of segments) {
    if (share(segment, colored) >= 0.5) continue;
    if ((units(segment) >= MARK_RULES.wavyMin && isWavy(segment)) || isSlash(segment)) keep.add(segment);
  }
  // A slash or zipper line runs on through the lines it crosses; follow it.
  const queue = [...keep];
  while (queue.length) {
    const segment = queue.pop()!;
    const wavy = isWavy(segment);
    for (const node of segment.nodes) {
      if (isEnd(node)) continue;
      const next = straightOn(segment, node);
      if (!next || keep.has(next)) continue;
      if (freeEnds(next).some(([, point]) => nearText(point))) continue;
      const nextWavy = isWavy(next);
      if (!nextWavy && units(next) > MARK_RULES.slashMax) continue;
      if (!wavy && !nextWavy && straightness(next, width) < MARK_RULES.slashStraight) continue;
      keep.add(next);
      queue.push(next);
    }
  }
  // A scissor mark is a slash over a seam with a curl or loop drawn right beside it; a
  // stitch-end slash is a single clean stroke. Take scissor marks out of the kept set.
  const scissors = new Set<Segment>();
  const curly = (piece: Segment): boolean => !keep.has(piece) && !isDash(piece) && units(piece) < MARK_RULES.lineRun
    && (straightness(piece, width) < MARK_RULES.scissorCurl || lineRunOf(piece, MARK_RULES.outlineAngle) < MARK_RULES.sweepLine);
  const near = (piece: Segment, x: number, y: number, radius: number): boolean => piece.points.some(index => {
    const [px, py] = xy(index, width);
    return (px - x) ** 2 + (py - y) ** 2 <= radius * radius;
  });
  for (const piece of keep) {
    if (isWavy(piece)) continue;
    const radius = strokeWidth * MARK_RULES.scissorReach;
    const crossings = [piece.points[0], piece.points[piece.points.length - 1]].map(index => xy(index, width));
    // Only pieces fastened to the slash or to the seam count; writing beside a slash floats free.
    const fastened = (other: Segment): boolean => other.nodes.some(node => (atNode.get(node) ?? [])
      .some(peer => peer === piece || lineRunOf(peer, MARK_RULES.outlineAngle) >= MARK_RULES.lineRun));
    const extras = segments.filter(other => other !== piece && curly(other) && fastened(other)
      && crossings.some(([x, y]) => near(other, x, y, radius)));
    if (extras.reduce((sum, other) => sum + units(other), 0) < MARK_RULES.scissorExtra) continue;
    // Scissors carry a real curl or loop; short straight bits beside a slash (the corner of a
    // stitch line) do not make it a scissor mark.
    if (!extras.some(other => straightness(other, width) < MARK_RULES.scissorCurl && units(other) >= MARK_RULES.scissorCurlMin)) continue;
    scissors.add(piece);
    for (const other of extras) scissors.add(other);
  }
  for (let grown = true; grown;) {
    grown = false;
    for (const piece of keep) {
      if (scissors.has(piece) || isWavy(piece)) continue;
      if (piece.nodes.some(node => (atNode.get(node) ?? []).some(other => scissors.has(other) && keep.has(other)))) { scissors.add(piece); grown = true; }
    }
  }
  for (const piece of scissors) keep.delete(piece);
  const isDrawing = (segment: Segment): boolean => keep.has(segment) || isDash(segment)
    || lineRunOf(segment, MARK_RULES.outlineAngle) >= MARK_RULES.lineRun;

  // Black drawing-line centre points by grid cell, for the stitching test below.
  const seamCell = Math.max(4, Math.round(strokeWidth * MARK_RULES.stitchGap));
  const seams = new Map<number, Array<{ x: number; y: number; dir: [number, number] }>>();
  for (const segment of segments) {
    if (share(segment, colored) >= 0.5 || lineRunOf(segment, MARK_RULES.outlineAngle) < MARK_RULES.lineRun) continue;
    const step = Math.max(1, Math.round(strokeWidth));
    for (let i = step; i < segment.points.length - step; i += step) {
      const [x, y] = xy(segment.points[i], width);
      const [ax, ay] = xy(segment.points[i - step], width);
      const [bx, by] = xy(segment.points[i + step], width);
      const length = Math.hypot(bx - ax, by - ay) || 1;
      const key = Math.floor(y / seamCell) * 1_000_003 + Math.floor(x / seamCell);
      seams.set(key, [...(seams.get(key) ?? []), { x, y, dir: [(bx - ax) / length, (by - ay) / length] }]);
    }
  }
  const alongSeam = (segment: Segment): boolean => {
    const step = Math.max(1, Math.round(strokeWidth));
    let samples = 0;
    let beside = 0;
    for (let i = step; i < segment.points.length - step; i += step) {
      const [x, y] = xy(segment.points[i], width);
      const [ax, ay] = xy(segment.points[i - step], width);
      const [bx, by] = xy(segment.points[i + step], width);
      const length = Math.hypot(bx - ax, by - ay) || 1;
      const dir: [number, number] = [(bx - ax) / length, (by - ay) / length];
      samples += 1;
      const cx = Math.floor(x / seamCell);
      const cy = Math.floor(y / seamCell);
      let found = false;
      for (let gy = cy - 1; gy <= cy + 1 && !found; gy += 1) {
        for (let gx = cx - 1; gx <= cx + 1 && !found; gx += 1) {
          found = (seams.get(gy * 1_000_003 + gx) ?? []).some(point => Math.hypot(point.x - x, point.y - y) <= seamCell
            && lineAngle(point.dir, dir) <= MARK_RULES.crossAngle);
        }
      }
      if (found) beside += 1;
    }
    return samples > 0 && beside / samples >= MARK_RULES.stitchShare;
  };

  // --- Annotation ---------------------------------------------------------------------------
  const marked = new Set<Segment>(scissors);
  const writing = new Set<Segment>();
  for (const segment of segments) {
    if (keep.has(segment)) continue;
    // Coloured solid lines (e.g. a blue belt position) are notes; coloured dashes, and coloured
    // stitching running close beside a black seam, are stitches.
    if (share(segment, colored) >= 0.5 && !isDash(segment) && !alongSeam(segment)) { marked.add(segment); continue; }
    if (share(segment, text) >= 0.5 && !isDrawing(segment)) { marked.add(segment); writing.add(segment); }
  }
  // A leader is a line from the writing that is not continued straight on at the writing and
  // ends where it meets the drawing (a T) or in blank paper. A drawing line that merely
  // touches a note runs on straight through that point and is left alone.
  const traceLeader = (start: Segment, from: number): Segment[] | undefined => {
    const chain: Segment[] = [];
    let current = start;
    let at = from;
    for (let hops = 0; hops < 4; hops += 1) {
      if (keep.has(current) || isDash(current)) return undefined;
      chain.push(current);
      const far = otherNode(current, at);
      if (isEnd(far)) return chain;
      const next = straightOn(current, far);
      const runsOn = next !== undefined && lineRunOf(next, MARK_RULES.outlineAngle) >= MARK_RULES.lineRun;
      // A drawing line that merely touches a note runs straight on past it: not a leader.
      if (hops === 0 && runsOn && !isEnd(far)) return undefined;
      // A leader ends where it meets the drawing; it never runs on into a long drawing line.
      if (!next || marked.has(next) || keep.has(next) || isDash(next) || runsOn) return chain;
      current = next;
      at = far;
    }
    return undefined;
  };
  const leaderStarts: Array<[Segment, number]> = [];
  for (const segment of segments) {
    if (keep.has(segment) || marked.has(segment)) continue;
    for (const node of segment.nodes) {
      const touchesNote = isEnd(node) ? nearText(freeEnds(segment).find(([end]) => end === node)?.[1] ?? segment.points[0])
        : (atNode.get(node) ?? []).some(other => other !== segment && writing.has(other));
      if (!touchesNote) continue;
      const onward = isEnd(node) ? undefined : straightOn(segment, node);
      if (onward && !marked.has(onward)) continue;
      leaderStarts.push([segment, node]);
    }
  }
  for (const [segment, node] of leaderStarts) {
    const chain = traceLeader(segment, node);
    if (!chain) continue;
    for (const piece of chain) marked.add(piece);
    const tip = chain.length ? otherNode(chain[chain.length - 1], chain.length > 1 ? chain[chain.length - 2].nodes.find(n => chain[chain.length - 1].nodes.includes(n)) ?? node : node) : node;
    for (const head of atNode.get(tip) ?? []) {
      if (!chain.includes(head) && !keep.has(head) && units(head) <= MARK_RULES.arrowHeadMax && freeEnds(head).length) marked.add(head);
    }
  }
  // Arrows with no note: two short straight strokes meeting at a tip with a shaft behind them.
  // Take the head, the shaft and whatever runs on straight from the shaft's far end.
  for (const [node, pieces] of atNode) {
    const heads = pieces.filter(piece => !keep.has(piece) && freeEnds(piece).length && units(piece) <= MARK_RULES.arrowHeadMax);
    if (heads.length < 2) continue;
    const [first, second] = heads.map(piece => direction(piece, node, reach, width));
    const spread = Math.acos(Math.max(-1, Math.min(1, first[0] * second[0] + first[1] * second[1]))) * 180 / Math.PI;
    if (spread < MARK_RULES.arrowSpread[0] || spread > MARK_RULES.arrowSpread[1]) continue;
    const back = [first[0] + second[0], first[1] + second[1]];
    const shaft = pieces.filter(piece => !heads.includes(piece) && !keep.has(piece) && !isDash(piece))
      .map(piece => ({ piece, along: direction(piece, node, reach, width) }))
      .filter(({ along }) => along[0] * back[0] + along[1] * back[1] > 0)
      .sort((a, b) => (b.along[0] * back[0] + b.along[1] * back[1]) - (a.along[0] * back[0] + a.along[1] * back[1]))[0]?.piece;
    if (!shaft) continue;
    // An arrow's shaft ends at the tip; a seam that runs on past the "tip" is crossed by a mark.
    const along = direction(shaft, node, reach, width);
    const runsPast = pieces.some(piece => piece !== shaft && !heads.includes(piece) && (() => {
      const other = direction(piece, node, reach, width);
      return along[0] * other[0] + along[1] * other[1] < -Math.cos(MARK_RULES.crossAngle * Math.PI / 180);
    })());
    if (runsPast) continue;
    for (const piece of [...heads, ...(traceLeader(shaft, node) ?? [shaft])]) marked.add(piece);
  }
  // Err on the side of selecting: anything that is not a drawing line, a dash, a stitch-end
  // slash or a zipper line is a candidate, unless it joins two drawing lines (a waistband end).
  // Hand-drawn outlines bend a little wherever a detail joins them, so follow them loosely here.
  const isLine = (segment: Segment): boolean => lineRunOf(segment, MARK_RULES.outlineAngle) >= MARK_RULES.sweepLine || units(segment) >= MARK_RULES.sweepLine
    // In a small crop a piece that big is the figure itself, not a note.
    || segment.length > Math.max(width, height) * MARK_RULES.scribbleShare;
  const holdsLine = (node: number, except: Segment): boolean => (atNode.get(node) ?? [])
    .some(other => other !== except && (keep.has(other) || isLine(other)));
  // Small groups that touch no drawing line at all: handwriting, an isolated scribble.
  const grouped = new Set<Segment>();
  for (const start of segments) {
    if (grouped.has(start)) continue;
    const group: Segment[] = [start];
    grouped.add(start);
    for (let head = 0; head < group.length; head += 1) {
      for (const node of group[head].nodes) {
        for (const next of atNode.get(node) ?? []) if (!grouped.has(next)) { grouped.add(next); group.push(next); }
      }
    }
    const total = group.reduce((sum, segment) => sum + units(segment), 0);
    if (total > MARK_RULES.scribbleMax || total * strokeWidth > Math.max(width, height) * MARK_RULES.scribbleShare) continue;
    if (group.some(segment => keep.has(segment) || isDash(segment))) continue;
    if (group.every(segment => share(segment, colored) >= 0.5 && alongSeam(segment))) continue;
    // A long single straight stroke on its own is a stitch or seam segment, not writing.
    if (group.length === 1 && straightness(group[0], width) >= MARK_RULES.slashStraight && units(group[0]) >= MARK_RULES.loneStroke) continue;
    for (const segment of group) marked.add(segment);
  }
  // A piece cut by the edge of the area cannot be judged whole; leave it alone.
  const edge = Math.max(2, Math.round(strokeWidth));
  const atBorder = (segment: Segment): boolean => segment.points.some(index => {
    const [x, y] = xy(index, width);
    return x < edge || y < edge || x >= width - edge || y >= height - edge;
  });
  for (const segment of [...marked]) if (atBorder(segment) && !scissors.has(segment) && share(segment, colored) < 0.5) marked.delete(segment);
  // Short straight strokes standing off a long line at an angle look like stitch-end slashes
  // (or the half of one beyond the crossing): leave them to the person rather than erase.
  const slashLike = (segment: Segment): boolean => freeEnds(segment).length === 1 && straightness(segment, width) >= MARK_RULES.slashStraight
    && units(segment) >= MARK_RULES.slashMin && units(segment) <= MARK_RULES.slashMax && segment.nodes.some(node => !isEnd(node)
      && (atNode.get(node) ?? []).some(other => other !== segment && lineRunOf(other, MARK_RULES.outlineAngle) >= MARK_RULES.lineRun
        && lineAngle(direction(segment, node, reach, width), direction(other, node, reach, width)) >= MARK_RULES.crossAngle));
  const looped = piecesOnLoops(segments);
  for (const segment of segments) {
    if (marked.has(segment) || keep.has(segment) || isDash(segment) || isLine(segment) || atBorder(segment) || slashLike(segment) || looped.has(segment)
      || (share(segment, colored) >= 0.5 && alongSeam(segment))) continue;
    const joins = segment.nodes.every(node => !isEnd(node) && holdsLine(node, segment));
    if (!joins) marked.add(segment);
  }

  const radius = Math.ceil(strokeWidth / 2) + 1;
  const paint = (segment: Segment, value: number): void => {
    for (const index of segment.points) {
      const [cx, cy] = xy(index, width);
      for (let y = Math.max(0, cy - radius); y <= Math.min(height - 1, cy + radius); y += 1) {
        for (let x = Math.max(0, cx - radius); x <= Math.min(width - 1, cx + radius); x += 1) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > radius * radius || !ink[y * width + x]) continue;
          if (value === 255 && result[y * width + x] === 1) continue;
          result[y * width + x] = value;
        }
      }
    }
  };
  for (const segment of segments) if (!marked.has(segment)) paint(segment, 1);
  for (const segment of marked) paint(segment, 255);
  for (let index = 0; index < result.length; index += 1) if (result[index] !== 255) result[index] = 0;
  if (stats) { stats.strokeWidth = strokeWidth; stats.kept = keep.size; stats.candidates = marked.size; }
  return result;
}
