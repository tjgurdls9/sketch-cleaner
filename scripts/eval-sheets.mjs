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
const WHITE = [255, 255, 255, 255];

const inputDir = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'workspace', 'sketch-cleaner-samples'));
const outputDir = path.resolve(process.argv[3] ?? '.scratch/eval');
const modelPath = path.resolve('artifacts/models/text-det.onnx');
await mkdir(outputDir, { recursive: true });

const bundle = path.join(outputDir, 'cleanup.bundle.mjs');
await build({
  stdin: {
    contents: [
      "export { autoCleanDraft } from './src/core/automatic';",
      "export { createSnapshot } from './src/core/engine';",
      "export { detectTextMask } from './src/main/ai';",
    ].join('\n'),
    resolveDir: process.cwd(), loader: 'ts',
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm',
  external: ['onnxruntime-node', 'sharp'], logLevel: 'error',
});
const { autoCleanDraft, createSnapshot, detectTextMask } = await import(pathToFileURL(bundle).href);

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
  const deleted = new Uint8ClampedArray(next.working.data);
  let candidates = 0;
  for (let i = 0; i < next.deleteMask.length; i++) {
    if (next.deleteMask[i] !== 255 || next.protectMask[i] === 255) continue;
    const o = i * 4;
    // Only ink still on the page: what automatic cleanup already erased is plain paper here.
    if (Math.min(marked[o], marked[o + 1], marked[o + 2]) < PAPER_MIN) { marked.set(CANDIDATE_INK, o); candidates++; }
    deleted.set(WHITE, o);
  }
  const stem = path.parse(name).name;
  await preview(marked, info, `${stem}-marked.png`);
  await preview(deleted, info, `${stem}-deleted.png`);
  console.log(`${stem}\t${info.width}x${info.height}\ttext ${(detected - began).toFixed(0)}ms\tclean ${(cleaned - detected).toFixed(0)}ms\tcandidate ink ${candidates}px`);
}
console.log(`미리보기: ${outputDir}`);
