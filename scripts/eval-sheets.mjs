// Runs automatic cleanup on real worksheet photos and writes before/after previews.
// Usage: node scripts/eval-sheets.mjs [photo folder] [output folder]
// Photos are the user's own material: keep them outside the repository.
import { build } from 'esbuild';
import { mkdir, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';

const PHOTO_TYPES = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const PREVIEW_WIDTH = 1400;
const PAPER_MIN = 200;
// Magenta stays distinct from the red and blue inks on the sheets.
const CANDIDATE_INK = [255, 0, 255, 255];
// Ink left within this many pixels of an erased mark counts as residue.
const RESIDUE_RING = 3;
const RESIDUE_DARKER = 30;
const RESIDUE_TINT = 40;

/** Median colour of the light pixels: the paper. */
function paperColor(data) {
  const channels = [[], [], []];
  for (let o = 0; o < data.length; o += 4 * 7) {
    if (Math.min(data[o], data[o + 1], data[o + 2]) < 170) continue;
    for (let c = 0; c < 3; c += 1) channels[c].push(data[o + c]);
  }
  return channels.map(values => values.sort((a, b) => a - b)[values.length >> 1] ?? 255);
}

/** Pixels just outside the selection that still differ from the paper after Delete. */
function residue(data, mask, width, height) {
  const paper = paperColor(data);
  const paperLight = (paper[0] + paper[1] + paper[2]) / 3;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (mask[index] === 255) continue;
      let near = false;
      for (let dy = -RESIDUE_RING; dy <= RESIDUE_RING && !near; dy += 1) {
        for (let dx = -RESIDUE_RING; dx <= RESIDUE_RING && !near; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          near = nx >= 0 && ny >= 0 && nx < width && ny < height && mask[ny * width + nx] === 255;
        }
      }
      if (!near) continue;
      const o = index * 4;
      const light = (data[o] + data[o + 1] + data[o + 2]) / 3;
      const tint = Math.max(Math.abs(data[o] - paper[0]), Math.abs(data[o + 1] - paper[1]), Math.abs(data[o + 2] - paper[2]));
      if (paperLight - light > RESIDUE_DARKER || tint > RESIDUE_TINT) count += 1;
    }
  }
  return count;
}

const inputDir = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'workspace', 'sketch-cleaner-samples'));
const outputDir = path.resolve(process.argv[3] ?? '.scratch/eval');
const modelPath = path.resolve('artifacts/models/text-det.onnx');
await mkdir(outputDir, { recursive: true });

const bundle = path.join(outputDir, 'cleanup.bundle.mjs');
await build({
  stdin: {
    contents: [
      "export { autoCleanDraft } from './src/core/automatic';",
      "export { createSnapshot, fillSelection } from './src/core/engine';",
      "export { detectTextMask } from './src/main/ai';",
    ].join('\n'),
    resolveDir: process.cwd(), loader: 'ts',
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm',
  external: ['onnxruntime-node', 'sharp'], logLevel: 'error',
});
const { autoCleanDraft, createSnapshot, fillSelection, detectTextMask } = await import(pathToFileURL(bundle).href);

const preview = (data, info, file) => sharp(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { raw: { width: info.width, height: info.height, channels: 4 } })
  .resize({ width: Math.min(PREVIEW_WIDTH, info.width) }).png().toFile(path.join(outputDir, file));

const photos = (await readdir(inputDir)).filter(name => PHOTO_TYPES.has(path.extname(name).toLowerCase())).sort();
if (!photos.length) throw new Error(`사진이 없습니다: ${inputDir}`);
for (const name of photos) {
  const { data, info } = await sharp(path.join(inputDir, name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
  const began = performance.now();
  const textMask = await detectTextMask(pixels, modelPath);
  const detected = performance.now();
  const next = autoCleanDraft(createSnapshot(pixels, 'eval'), undefined, textMask);
  const cleaned = performance.now();

  const marked = new Uint8ClampedArray(next.working.data);
  let candidates = 0;
  for (let i = 0; i < next.deleteMask.length; i++) {
    if (next.deleteMask[i] !== 255 || next.protectMask[i] === 255) continue;
    const o = i * 4;
    // Only ink still on the page: what automatic cleanup already erased is plain paper here.
    if (Math.min(marked[o], marked[o + 1], marked[o + 2]) < PAPER_MIN) { marked.set(CANDIDATE_INK, o); candidates++; }
  }
  // Delete exactly as the app does it.
  const deleted = fillSelection(next, { kind: 'paper' }).working.data;
  const left = residue(deleted, next.deleteMask, info.width, info.height);
  const stem = path.parse(name).name;
  await preview(marked, info, `${stem}-marked.png`);
  await preview(deleted, info, `${stem}-deleted.png`);
  console.log(`${stem}\t${info.width}x${info.height}\ttext ${(detected - began).toFixed(0)}ms\tclean ${(cleaned - detected).toFixed(0)}ms\tcandidate ink ${candidates}px\tresidue ${left}px`);
}
console.log(`미리보기: ${outputDir}`);
