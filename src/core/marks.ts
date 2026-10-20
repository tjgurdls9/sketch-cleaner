/**
 * Sorts the ink inside a garment figure into drawing and annotation. Drawing: long lines,
 * dashed stitch lines, stitch-end slashes and zipper wavy lines. Annotation: handwriting,
 * leaders and arrows from notes, small scribbles such as scissor marks, and coloured solid
 * lines. The annotation mask is only a selection candidate; callers never erase it
 * automatically because the same shapes can be real design details.
 */

import {
  buildLineGraph, direction, lineAngle, straightness, swing, wiggle, xy, type Segment,
} from './line-graph';

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
  textShare: 0.35,
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
  leaderMax: 120,
  hairlineGap: 2,
};

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

/**
 * `kept`, when given, is set to 1 on the ink of the drawing lines that stay, so erasing a note can
 * take in its soft edge without eating into them.
 */
export function findAnnotationInk(figure: FigureInk, width: number, height: number, stats?: MarkStats, kept?: Uint8Array): Uint8Array {
  const { ink, colored, text } = figure;
  const result = new Uint8Array(ink.length);
  const graph = buildLineGraph(ink, width, height, MARK_RULES);
  if (!graph) return result;
  const {
    strokeWidth, segments, atNode, reach, isEnd, units, freeEnds, linedUpEnd, bucket, otherNode, alignment, straightOnAt, straightOn,
  } = graph;
  // A long piece whose pen skipped for a hairline is one broken line. Hem stitching can look
  // the same, so this only counts along a leader that starts at a note.
  const hairline = strokeWidth * MARK_RULES.hairlineGap;
  const brokenLine = (segment: Segment): boolean => units(segment) >= MARK_RULES.loneStroke
    && freeEnds(segment).some(([node, point]) => linedUpEnd(segment, node, point, hairline) !== undefined);
  const isDash = (segment: Segment): boolean => freeEnds(segment).some(([node, point]) => linedUpEnd(segment, node, point, bucket) !== undefined);
  // Total length (in stroke widths) of the straight line a piece is part of. The line graph does
  // not change while judging, so each answer is kept: busy areas ask about the same pieces often.
  const lineRuns = new Map<number, Map<Segment, number>>();
  const lineRunOf = (segment: Segment, angle = MARK_RULES.crossAngle): number => {
    const known = lineRuns.get(angle)?.get(segment);
    if (known !== undefined) return known;
    const run = measureLineRun(segment, angle);
    if (!lineRuns.has(angle)) lineRuns.set(angle, new Map());
    lineRuns.get(angle)!.set(segment, run);
    return run;
  };
  const measureLineRun = (segment: Segment, angle: number): number => {
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
  // A piece cut by the edge of the area cannot be judged whole.
  const edge = Math.max(2, Math.round(strokeWidth));
  const nearBorder = (index: number): boolean => {
    const [x, y] = xy(index, width);
    return x < edge || y < edge || x >= width - edge || y >= height - edge;
  };
  const atBorder = (segment: Segment): boolean => segment.points.some(nearBorder);
  // --- Drawing details that must stay -----------------------------------------------------
  const keep = new Set<Segment>();
  const isSlash = (segment: Segment): boolean => {
    const [a, b] = segment.nodes;
    const free = isEnd(a) ? a : isEnd(b) ? b : -1;
    const junction = free === a ? b : a;
    if (free < 0 || isEnd(junction) || units(segment) < MARK_RULES.slashMin || units(segment) > MARK_RULES.slashMax) return false;
    // A short line whose free end touches writing, or runs out to the edge of the area where
    // the notes are, is a leader to that note, not a stitch end.
    if (nearText(freeEnds(segment)[0][1]) || nearBorder(freeEnds(segment)[0][1])) return false;
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
    // Handwriting wiggles and has straight strokes too; inside writing these are not drawing.
    if (share(segment, text) >= 0.5) continue;
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
      if (freeEnds(next).some(([, point]) => nearText(point) || nearBorder(point))) continue;
      if (share(next, text) >= 0.5) continue;
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
    // Cheapest and most selective test first: only pieces near the slash can belong to it.
    const extras = segments.filter(other => other !== piece && crossings.some(([x, y]) => near(other, x, y, radius))
      && curly(other) && fastened(other));
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

  const looped = piecesOnLoops(segments);
  // --- Annotation ---------------------------------------------------------------------------
  const marked = new Set<Segment>(scissors);
  const writing = new Set<Segment>();
  for (const segment of segments) {
    if (keep.has(segment)) continue;
    // Coloured solid lines (e.g. a blue belt position) are notes; coloured dashes, and coloured
    // stitching running close beside a black seam, are stitches.
    if (share(segment, colored) >= 0.5 && !isDash(segment) && !alongSeam(segment)) { marked.add(segment); continue; }
    // Joined-up handwriting also runs on for a while; inside writing only a really long line
    // (an outline crossing the note) is drawing.
    // A closed detail fastened to the drawing (a belt loop under a label) is drawing too.
    const fastenedLoop = looped.has(segment) && segment.nodes.some(node => (atNode.get(node) ?? [])
      .some(other => other !== segment && lineRunOf(other, MARK_RULES.outlineAngle) >= MARK_RULES.lineRun));
    const throughWriting = keep.has(segment) || isDash(segment) || fastenedLoop
      || lineRunOf(segment, MARK_RULES.outlineAngle) >= MARK_RULES.lineRun * 2;
    if (share(segment, text) >= MARK_RULES.textShare && !throughWriting) { marked.add(segment); writing.add(segment); }
  }
  // The detector rarely covers a whole glyph: carry the selection along the strokes joined to
  // the writing, stopping at the drawing.
  const glyphQueue = [...writing];
  while (glyphQueue.length) {
    const piece = glyphQueue.pop()!;
    for (const node of piece.nodes) {
      for (const next of atNode.get(node) ?? []) {
        if (writing.has(next) || keep.has(next) || isDash(next) || isDrawing(next) || units(next) > MARK_RULES.sweepLine) continue;
        // Only strokes that still touch the writing area: never walk off into the drawing.
        if (share(next, text) === 0) continue;
        writing.add(next);
        marked.add(next);
        glyphQueue.push(next);
      }
    }
  }
  // A leader is a line from the writing that is not continued straight on at the writing and
  // ends where it meets the drawing (a T) or in blank paper. A drawing line that merely
  // touches a note runs on straight through that point and is left alone.
  // A long straight line out of a note can end in line with a stroke of the writing; it is
  // still a leader, not one dash of a stitch line.
  const noteLeader = (segment: Segment): boolean => {
    const free = freeEnds(segment);
    return free.length === 1 && nearText(free[0][1]) && units(segment) >= MARK_RULES.loneStroke
      && straightness(segment, width) >= MARK_RULES.slashStraight;
  };
  const traceLeader = (start: Segment, from: number): Segment[] | undefined => {
    const chain: Segment[] = [];
    let current = start;
    let at = from;
    for (let hops = 0; hops < 4; hops += 1) {
      if (keep.has(current) || (isDash(current) && !noteLeader(current) && !brokenLine(current))) return undefined;
      chain.push(current);
      const far = otherNode(current, at);
      if (isEnd(far)) {
        // Step over a hairline gap where the pen skipped.
        const farPoint = current.nodes[0] === far ? current.points[0] : current.points[current.points.length - 1];
        const across = linedUpEnd(current, far, farPoint, hairline);
        const landing = across && freeEnds(across.segment).find(([, point]) => {
          const [x, y] = xy(point, width);
          return x === across.x && y === across.y;
        });
        if (!across || !landing || chain.includes(across.segment)) return chain;
        current = across.segment;
        at = landing[0];
        continue;
      }
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
  // A line cut by the edge of the area comes from a note outside it. Follow it straight on:
  // if it meets a drawing line (in a T, or crossing it to point at the stitching just inside)
  // and stops soon after, it is a leader. A line that turns a corner, or runs on far past a
  // crossing, is the drawing itself.
  const leaders = new Set<Segment>();
  const lineThrough = (from: Segment, node: number): boolean => {
    const own = direction(from, node, reach, width);
    const others = (atNode.get(node) ?? []).filter(other => other !== from);
    return others.some((a, i) => others.slice(i + 1).some(b => alignment(a, b, node) > Math.cos(MARK_RULES.crossAngle * Math.PI / 180)
      && lineAngle(own, direction(a, node, reach, width)) >= MARK_RULES.crossAngle));
  };
  const borderLeader = (start: Segment, from: number): Segment[] | undefined => {
    const chain: Segment[] = [];
    let current = start;
    let at = from;
    let met = false;
    let past = 0;
    for (let hops = 0; hops < 8; hops += 1) {
      // Past the drawing line only a short tail may follow, pointing at the stitching there;
      // that tail can look like a stitch-end slash.
      if (keep.has(current) && !met) return undefined;
      if (met) {
        past += units(current);
        if (past > MARK_RULES.slashMax) return undefined;
      } else if (isDash(current) || straightness(current, width) < MARK_RULES.slashStraight) return undefined;
      chain.push(current);
      const far = otherNode(current, at);
      if (isEnd(far)) break;
      if (lineThrough(current, far)) met = true;
      const next = straightOnAt(current, far, direction(current, far, reach, width));
      if (!next || chain.includes(next)) break;
      current = next;
      at = far;
    }
    const total = chain.reduce((sum, piece) => sum + units(piece), 0);
    return met && total <= MARK_RULES.leaderMax ? chain : undefined;
  };
  for (const segment of segments) {
    if (keep.has(segment) || marked.has(segment)) continue;
    for (const [node, point] of freeEnds(segment)) {
      if (!nearBorder(point)) continue;
      for (const piece of borderLeader(segment, node) ?? []) { marked.add(piece); leaders.add(piece); keep.delete(piece); }
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
  // Other pieces cut by the edge of the area cannot be judged whole; leave them alone.
  for (const segment of [...marked]) {
    if (atBorder(segment) && !scissors.has(segment) && !writing.has(segment) && !leaders.has(segment) && share(segment, colored) < 0.5) marked.delete(segment);
  }
  // Short straight strokes standing off a long line at an angle look like stitch-end slashes
  // (or the half of one beyond the crossing): leave them to the person rather than erase.
  const slashLike = (segment: Segment): boolean => freeEnds(segment).length === 1 && straightness(segment, width) >= MARK_RULES.slashStraight
    && units(segment) >= MARK_RULES.slashMin && units(segment) <= MARK_RULES.slashMax && segment.nodes.some(node => !isEnd(node)
      && (atNode.get(node) ?? []).some(other => other !== segment && lineRunOf(other, MARK_RULES.outlineAngle) >= MARK_RULES.lineRun
        && lineAngle(direction(segment, node, reach, width), direction(other, node, reach, width)) >= MARK_RULES.crossAngle));
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
  for (let index = 0; index < result.length; index += 1) {
    if (kept) kept[index] = result[index] === 1 ? 1 : 0;
    if (result[index] !== 255) result[index] = 0;
  }
  if (stats) { stats.strokeWidth = strokeWidth; stats.kept = keep.size; stats.candidates = marked.size; }
  return result;
}
