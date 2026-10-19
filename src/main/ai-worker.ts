import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import manifest from '../../models/model.json';
import { detectTextMask } from './ai';
import type { Pixels } from '../shared/types';

async function run(): Promise<void> {
  const { pixels, modelPath } = workerData as { pixels: Pixels; modelPath: string };
  const bytes = await readFile(modelPath);
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('Invalid bundled model');
  const mask = await detectTextMask(pixels, modelPath);
  parentPort?.postMessage(mask, [mask.buffer as ArrayBuffer]);
}

void run().catch(() => { throw new Error('Local image processing failed'); });
