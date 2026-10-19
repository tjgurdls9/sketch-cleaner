import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { resolve } from 'node:path';
import { InferenceSession } from 'onnxruntime-node';
import type { Pixels } from '../src/shared/types';
import { MAX_PIXELS } from '../src/shared/types';
import { detectTextMask } from '../src/main/ai';

const MODEL_PATH = resolve(process.cwd(), 'artifacts/models/text-det.onnx');

async function printedTextAndGarment(): Promise<Pixels> {
  const width = 640;
  const height = 480;
  const diagram = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#faf9f6"/>
    <text x="18" y="54" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="#252422">SIZE 42</text>
    <path d="M410 120 L448 88 L478 105 L508 88 L546 120 L526 170 L512 156 L512 350 L444 350 L444 156 L430 170 Z"
      fill="#eee8dc" stroke="#252422" stroke-width="5" stroke-linejoin="round"/>
    <path d="M478 105 L482 145 L490 160 L490 348" fill="none" stroke="#37342f" stroke-width="4"/>
  </svg>`);
  const { data } = await sharp({
    create: { width, height, channels: 4, background: { r: 250, g: 249, b: 246, alpha: 1 } },
  }).composite([{ input: diagram }]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixels: Pixels = { width, height, data: Uint8ClampedArray.from(data) };
  // RGB values under zero alpha must not become visible text during inference.
  for (let y = 8; y < 96; y += 1) {
    for (let x = 540; x < 630; x += 1) {
      pixels.data.set([0, 0, 0, 0], (y * width + x) * 4);
    }
  }
  return pixels;
}

function count(mask: Uint8Array, width: number, region: { x: number; y: number; width: number; height: number }): number {
  let result = 0;
  for (let y = region.y; y < region.y + region.height; y += 1) {
    for (let x = region.x; x < region.x + region.width; x += 1) result += mask[y * width + x] === 255 ? 1 : 0;
  }
  return result;
}

describe('local text detector', () => {
  it('rejects invalid dimensions and non-exact RGBA buffers before opening the model', async () => {
    await expect(detectTextMask({ width: 0, height: 1, data: new Uint8ClampedArray(0) }, MODEL_PATH))
      .rejects.toThrow(/dimension|width|height/i);

    const oversized = { width: 5_001, height: 5_000, data: new Uint8ClampedArray(0) };
    expect(oversized.width * oversized.height).toBeGreaterThan(MAX_PIXELS);
    await expect(detectTextMask(oversized, MODEL_PATH)).rejects.toThrow(/dimension|pixel|limit/i);

    await expect(detectTextMask({ width: 2, height: 2, data: new Uint8ClampedArray(15) }, MODEL_PATH))
      .rejects.toThrow(/RGBA|buffer|pixel/i);
  });

  it('rejects malformed probability tensor shapes and non-finite model values', async () => {
    const pixels: Pixels = { width: 32, height: 24, data: new Uint8ClampedArray(32 * 24 * 4).fill(255) };
    const session = {
      inputNames: ['image'],
      outputNames: ['maps'],
      run: vi.fn(),
      release: vi.fn(async () => undefined),
    };
    const createSession = vi.spyOn(InferenceSession, 'create')
      .mockResolvedValue(session as unknown as Awaited<ReturnType<typeof InferenceSession.create>>);

    session.run.mockResolvedValueOnce({ maps: { type: 'float32', dims: [1, 2, 1, 1], data: new Float32Array([0, 0]) } });
    await expect(detectTextMask(pixels, 'mocked-model')).rejects.toThrow(/output|dimensions/i);
    expect(session.release).toHaveBeenCalledOnce();

    session.run.mockResolvedValueOnce({ maps: { type: 'float32', dims: [1, 1, 1, 1], data: new Float32Array([Number.NaN]) } });
    await expect(detectTextMask(pixels, 'mocked-model')).rejects.toThrow(/probability/i);
    expect(session.release).toHaveBeenCalledTimes(2);
    createSession.mockRestore();
  });

  it('detects printed text outside a garment, ignores transparent RGB, and leaves input bytes untouched', async () => {
    const pixels = await printedTextAndGarment();
    const before = pixels.data.slice();

    const mask = await detectTextMask(pixels, MODEL_PATH);

    expect(mask).toBeInstanceOf(Uint8Array);
    expect(mask).toHaveLength(pixels.width * pixels.height);
    expect([...new Set(mask)]).toEqual(expect.arrayContaining([0, 255]));
    expect(count(mask, pixels.width, { x: 12, y: 20, width: 260, height: 54 })).toBeGreaterThan(20);
    expect(count(mask, pixels.width, { x: 540, y: 8, width: 90, height: 88 })).toBe(0);
    expect(pixels.data).toEqual(before);
  }, 30_000);
});
