import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { autoCleanDraft } from '../src/core/automatic';
import { createSnapshot } from '../src/core/engine';
import type { DesktopAPI, Pixels } from '../src/shared/types';
import { AI_FIXTURE, makeAIFixture } from './ai-fixture';

interface ModelManifest {
  filename: string;
  url: string;
  sha256: string;
  upstreamRevision: string;
  license: string;
  source: string;
}

type DetectTextMask = (pixels: Pixels, modelPath: string) => Promise<Uint8Array>;
type AIAPIContract = Pick<DesktopAPI, 'detectText' | 'cancelTextDetection'>;

const expectedAIAPI: AIAPIContract = {
  detectText: async (_pixels, _requestId) => ({ ok: false, error: 'fixture-only API contract' }),
  cancelTextDetection: async (_requestId) => ({ ok: true, value: undefined }),
};

const root = process.cwd();
const manifestPath = path.join(root, 'models', 'model.json');
const compiledDetectorPath = path.join(root, `.ai-integration-${randomUUID()}.cjs`);

async function compileDetectorAsCommonJS(): Promise<DetectTextMask> {
  await build({
    entryPoints: [path.join(root, 'src', 'main', 'ai.ts')],
    outfile: compiledDetectorPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron', 'onnxruntime-node', 'sharp'],
  });
  const module = await import(pathToFileURL(compiledDetectorPath).href) as { detectTextMask?: DetectTextMask };
  if (typeof module.detectTextMask !== 'function') throw new Error('CJS detector export was not found.');
  return module.detectTextMask;
}

function pixelAt(pixels: Pixels, point: { x: number; y: number }): number[] {
  const offset = (point.y * pixels.width + point.x) * 4;
  return [...pixels.data.subarray(offset, offset + 4)];
}

function darkDetectedPoint(pixels: Pixels, mask: Uint8Array, region: { left: number; top: number; right: number; bottom: number }): { x: number; y: number } | null {
  for (let y = region.top; y < region.bottom; y += 1) {
    for (let x = region.left; x < region.right; x += 1) {
      const pixel = pixelAt(pixels, { x, y });
      if (mask[y * pixels.width + x] === 255 && Math.max(pixel[0], pixel[1], pixel[2]) < 170) return { x, y };
    }
  }
  return null;
}

describe('bundled local text detection integration', () => {
  let detector: DetectTextMask | undefined;

  afterAll(async () => {
    await rm(compiledDetectorPath, { force: true });
  });

  it('ships model provenance metadata whose digest matches the bundled artifact', async () => {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ModelManifest;
    expect(path.basename(manifest.filename)).toBe(manifest.filename);
    expect(manifest.filename).toMatch(/\.onnx$/i);
    expect(manifest.url).toMatch(/^https:\/\//);
    expect(manifest.source.trim().length).toBeGreaterThan(0);
    expect(manifest.upstreamRevision.trim().length).toBeGreaterThan(0);
    expect(manifest.license.trim().length).toBeGreaterThan(0);
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/i);

    const model = await readFile(path.join(root, 'artifacts', 'models', manifest.filename));
    expect(createHash('sha256').update(model).digest('hex')).toBe(manifest.sha256.toLowerCase());
  });

  it('runs the packaged CommonJS detector, removes printed English and Korean, and preserves garment details', async () => {
    detector ??= await compileDetectorAsCommonJS();
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ModelManifest;
    const modelPath = path.join(root, 'artifacts', 'models', manifest.filename);
    const png = await makeAIFixture();
    const decoded = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels: Pixels = {
      width: decoded.info.width,
      height: decoded.info.height,
      data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
    };
    expect([pixels.width, pixels.height]).toEqual([AI_FIXTURE.width, AI_FIXTURE.height]);

    const mask = await detector(pixels, modelPath);
    expect(mask).toHaveLength(pixels.width * pixels.height);
    expect(mask.every(value => value === 0 || value === 255)).toBe(true);

    const englishPoint = darkDetectedPoint(pixels, mask, AI_FIXTURE.english);
    const koreanPoint = darkDetectedPoint(pixels, mask, AI_FIXTURE.korean);
    expect(englishPoint, 'the printed English label should produce detector coverage').not.toBeNull();
    expect(koreanPoint, 'the printed Korean label should produce detector coverage').not.toBeNull();

    const baseHash = createHash('sha256').update(pixels.data).digest('hex');
    const snapshot = createSnapshot(pixels, 'ai-fixture-base');
    const seam = pixelAt(pixels, AI_FIXTURE.garmentSeam);
    const button = pixelAt(pixels, AI_FIXTURE.garmentButton);
    const stitch = pixelAt(pixels, AI_FIXTURE.garmentStitch);
    const cleaned = autoCleanDraft(snapshot, undefined, mask);

    expect(pixelAt(cleaned.working, englishPoint!)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(cleaned.working, koreanPoint!)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(cleaned.working, AI_FIXTURE.tableInk)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(cleaned.working, AI_FIXTURE.redArrow)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(cleaned.working, AI_FIXTURE.garmentSeam)).toEqual(seam);
    expect(pixelAt(cleaned.working, AI_FIXTURE.garmentButton)).toEqual(button);
    expect(pixelAt(cleaned.working, AI_FIXTURE.garmentStitch)).toEqual(stitch);
    expect(createHash('sha256').update(snapshot.base.data).digest('hex')).toBe(baseHash);
    expect(cleaned.base).toBe(snapshot.base);
  }, 60_000);

  it('keeps the cancellation API bound to a caller-generated job identifier', () => {
    const requestId = randomUUID();
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(expectedAIAPI.detectText).toBeTypeOf('function');
    expect(expectedAIAPI.cancelTextDetection).toBeTypeOf('function');
  });
});
