import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { TextDetectionService } from '../src/main/ai-manager';
import { makeAIFixture } from './ai-fixture';

it('runs the production CJS AI worker and cancels a separate native job without applying a result', async () => {
  const folder = path.resolve('out', `ai-worker-check-${randomUUID()}`);
  const workerPath = path.join(folder, 'ai-worker.js');
  const modelPath = path.resolve('artifacts/models/text-det.onnx');
  await mkdir(folder, { recursive: true });
  const service = new TextDetectionService(modelPath, workerPath);
  const cancelledService = new TextDetectionService(modelPath, workerPath);
  try {
    await build({ entryPoints: ['src/main/ai-worker.ts'], outfile: workerPath, bundle: true,
      platform: 'node', format: 'cjs', target: 'node24', external: ['onnxruntime-node', 'sharp'] });
    const { data, info } = await sharp(await makeAIFixture()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
    const before = pixels.data.slice();
    const mask = await service.detect(pixels, randomUUID());
    expect(mask.length).toBe(info.width * info.height);
    expect(mask.some(value => value === 255)).toBe(true);
    expect(pixels.data).toEqual(before);
    const id = randomUUID();
    const cancelled = cancelledService.detect(pixels, id);
    const rejection = expect(cancelled).rejects.toThrow(/취소/);
    cancelledService.cancel(id);
    await rejection;
    expect(pixels.data).toEqual(before);
  } finally {
    service.dispose(); cancelledService.dispose();
    await rm(folder, { recursive: true, force: true });
  }
}, 60_000); // A functional check, not a timing one: the Windows coverage run took 32.7s once.
