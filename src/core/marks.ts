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
  scribbleMax: 35,
  scribbleShare: 0.15,
  arrowHeadMax: 6,
  symbolSpan: 10,
  symbolMin: 4,
  slashMax: 18,
  slashStraight: 0.85,
  hostMin: 8,
  lineRun: 24,
  bridgeMax: 5,
  dashGap: 5,
  crossAngle: 25,
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
export function findAnnotationInk(figure: FigureInk, width: number, height: number, stats?: MarkStats): Uint8Array {
  const { ink, colored, text } = figure;
  const result = new Uint8Array(ink.length);
  const skeleton = thin(ink, width, height);
  let inkCount = 0;
  let skeletonCount = 0;
  for (let index = 0; index < ink.length; index += 1) { inkCount += ink[index]; skeletonCount += skeleton[index]; }
  if (!skeletonCount) return result;
  const strokeWidth = Math.max(1, inkCount / skeletonCount);
  const { segments, atNode } = joinThroughNodes(trace(skeleton, width, height).segments);
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
  const straightOnAt = (from: Segment, node: number, own: readonly [number, number]): Segment | undefined => {
    let best: Segment | undefined;
    let bestDot = -Math.cos(MARK_RULES.crossAngle * Math.PI / 180);
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
  const lineRunOf = (segment: Segment): number => {
    let total = segment.length;
    for (const start of segment.nodes) {
      let current = segment;
      let at = start;
      for (let hops = 0; hops < 8 && !isEnd(at); hops += 1) {
        const next = straightOnAt(current, at, direction(current, at, reach, width));
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
  const isDrawing = (segment: Segment): boolean => keep.has(segment) || isDash(segment) || lineRunOf(segment) >= MARK_RULES.lineRun;

  // --- Annotation ---------------------------------------------------------------------------
  const marked = new Set<Segment>();
  const writing = new Set<Segment>();
  for (const segment of segments) {
    if (keep.has(segment)) continue;
    // Coloured solid lines (e.g. a blue belt position) are notes; coloured dashes are stitches.
    if (share(segment, colored) >= 0.5 && !isDash(segment)) { marked.add(segment); continue; }
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
      // A leader ends where it meets the drawing; it never runs on into a long drawing line.
      if (!next || marked.has(next) || keep.has(next) || isDash(next) || lineRunOf(next) >= MARK_RULES.lineRun) return chain;
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
  // Compact clusters of short pieces hanging off the drawing with a closed loop: scissor marks
  // and similar symbols drawn over a seam.
  const minor = (segment: Segment): boolean => !keep.has(segment) && !isDash(segment)
    && units(segment) <= MARK_RULES.scribbleMax && lineRunOf(segment) < MARK_RULES.lineRun;
  const clustered = new Set<Segment>();
  for (const start of segments) {
    if (clustered.has(start) || !minor(start)) continue;
    const group: Segment[] = [start];
    clustered.add(start);
    for (let head = 0; head < group.length; head += 1) {
      for (const node of group[head].nodes) {
        for (const next of atNode.get(node) ?? []) if (!clustered.has(next) && minor(next)) { clustered.add(next); group.push(next); }
      }
    }
    const total = group.reduce((sum, segment) => sum + units(segment), 0);
    const nodes = new Set(group.flatMap(segment => segment.nodes));
    const looped = group.length >= nodes.size || group.some(segment => segment.nodes[0] === segment.nodes[1]);
    let [minX, minY, maxX, maxY] = [width, height, 0, 0];
    for (const segment of group) for (const index of segment.points) {
      const [x, y] = xy(index, width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    // A broken drawing line also splits into many small pieces, but it stretches out long.
    const compact = Math.max(maxX - minX, maxY - minY) / strokeWidth <= MARK_RULES.symbolSpan;
    if (group.length >= 2 && looped && compact && total >= MARK_RULES.symbolMin && total <= MARK_RULES.scribbleMax * 1.5) {
      for (const segment of group) marked.add(segment);
    }
  }
  // Small scribbles that touch nothing long (handwriting the detector missed, scissor marks).
  const seen = new Set<Segment>();
  for (const start of segments) {
    if (seen.has(start)) continue;
    const group: Segment[] = [start];
    seen.add(start);
    for (let head = 0; head < group.length; head += 1) {
      for (const node of group[head].nodes) {
        for (const next of atNode.get(node) ?? []) if (!seen.has(next)) { seen.add(next); group.push(next); }
      }
    }
    const total = group.reduce((sum, segment) => sum + units(segment), 0);
    if (total > MARK_RULES.scribbleMax || group.some(segment => keep.has(segment) || isDash(segment))) continue;
    // Never the figure itself: a scribble is small next to the area being looked at.
    if (total * strokeWidth > Math.max(width, height) * MARK_RULES.scribbleShare) continue;
    const straightSingle = group.length === 1 && straightness(group[0], width) >= MARK_RULES.slashStraight;
    if (!straightSingle) for (const segment of group) marked.add(segment);
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
