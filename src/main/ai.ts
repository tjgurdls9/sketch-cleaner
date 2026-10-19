import { InferenceSession, Tensor } from 'onnxruntime-node';
import type { Pixels } from '../shared/types';
import { validatePixels } from '../core/engine';

const MAX_MODEL_SIDE = 960;
const MODEL_MEAN = 0.5;
const MODEL_STD = 0.5;
const DETECTION_THRESHOLD = 0.5;
const MULTIPLE = 32;

interface PreparedInput {
  width: number;
  height: number;
  data: Float32Array;
}

function roundToModelMultiple(value: number): number {
  return Math.max(MULTIPLE, Math.min(MAX_MODEL_SIDE, Math.round(value / MULTIPLE) * MULTIPLE));
}

function compositeWhite(data: Uint8ClampedArray, offset: number, channel: number): number {
  const alpha = data[offset + 3] / 255;
  return data[offset + channel] * alpha + 255 * (1 - alpha);
}

function prepareInput(pixels: Pixels): PreparedInput {
  const scale = MAX_MODEL_SIDE / Math.max(pixels.width, pixels.height);
  const width = roundToModelMultiple(pixels.width * scale);
  const height = roundToModelMultiple(pixels.height * scale);
  const planeSize = width * height;
  const data = new Float32Array(planeSize * 3);

  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.max(0, Math.min(pixels.height - 1, (y + 0.5) * pixels.height / height - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(pixels.height - 1, y0 + 1);
    const fy = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.max(0, Math.min(pixels.width - 1, (x + 0.5) * pixels.width / width - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(pixels.width - 1, x0 + 1);
      const fx = sourceX - x0;
      const topLeft = (y0 * pixels.width + x0) * 4;
      const topRight = (y0 * pixels.width + x1) * 4;
      const bottomLeft = (y1 * pixels.width + x0) * 4;
      const bottomRight = (y1 * pixels.width + x1) * 4;
      const target = y * width + x;
      for (let channel = 0; channel < 3; channel += 1) {
        // RapidOCR's detector receives OpenCV-decoded BGR pixels before CHW conversion.
        const sourceChannel = 2 - channel;
        const top = compositeWhite(pixels.data, topLeft, sourceChannel) * (1 - fx)
          + compositeWhite(pixels.data, topRight, sourceChannel) * fx;
        const bottom = compositeWhite(pixels.data, bottomLeft, sourceChannel) * (1 - fx)
          + compositeWhite(pixels.data, bottomRight, sourceChannel) * fx;
        const byte = top * (1 - fy) + bottom * fy;
        data[channel * planeSize + target] = ((byte / 255) - MODEL_MEAN) / MODEL_STD;
      }
    }
  }
  return { width, height, data };
}

function probabilityMap(value: unknown): { width: number; height: number; data: Float32Array } {
  if (!value || typeof value !== 'object') throw new TypeError('Text model returned no probability map');
  const tensor = value as { type?: unknown; dims?: unknown; data?: unknown };
  if (tensor.type !== 'float32' || !Array.isArray(tensor.dims) || tensor.dims.length !== 4) {
    throw new TypeError('Text model returned an unsupported output tensor');
  }
  const [batch, channels, height, width] = tensor.dims;
  if (batch !== 1 || channels !== 1 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width > MAX_MODEL_SIDE || height > MAX_MODEL_SIDE
    || !(tensor.data instanceof Float32Array) || tensor.data.length !== width * height) {
    throw new RangeError('Text model output dimensions are invalid');
  }
  for (const probability of tensor.data) {
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new RangeError('Text model returned an invalid probability');
    }
  }
  return { width, height, data: tensor.data };
}

function expandMask(pixels: Pixels, map: { width: number; height: number; data: Float32Array }): Uint8Array {
  const mask = new Uint8Array(pixels.width * pixels.height);
  for (let y = 0; y < pixels.height; y += 1) {
    const mapY = Math.min(map.height - 1, Math.floor((y + 0.5) * map.height / pixels.height));
    const sourceRow = mapY * map.width;
    const targetRow = y * pixels.width;
    for (let x = 0; x < pixels.width; x += 1) {
      const mapX = Math.min(map.width - 1, Math.floor((x + 0.5) * map.width / pixels.width));
      if (map.data[sourceRow + mapX] >= DETECTION_THRESHOLD) mask[targetRow + x] = 255;
    }
  }
  return mask;
}

/** Detect likely printed or handwritten text. The returned pixel mask uses only 0 and 255. */
export async function detectTextMask(pixels: Pixels, modelPath: string): Promise<Uint8Array> {
  validatePixels(pixels, 'AI input pixels');
  if (typeof modelPath !== 'string' || modelPath.trim().length === 0) throw new TypeError('A local text model path is required');

  const prepared = prepareInput(pixels);
  let session: Awaited<ReturnType<typeof InferenceSession.create>> | undefined;
  try {
    session = await InferenceSession.create(modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (!inputName || !outputName) throw new TypeError('Text model is missing its input or output tensor');
    const input = new Tensor('float32', prepared.data, [1, 3, prepared.height, prepared.width]);
    const outputs = await session.run({ [inputName]: input });
    return expandMask(pixels, probabilityMap(outputs[outputName]));
  } finally {
    await session?.release();
  }
}
