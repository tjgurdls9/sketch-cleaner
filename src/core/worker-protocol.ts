import type { Pixels, Snapshot } from '../shared/types';
import type { PixelJob } from './engine';

export type { PixelJob } from './engine';

export interface PixelJobRequest { id: string; job: PixelJob }
export type PixelJobResponse =
  | { id: string; type: 'progress'; completed: number; total: number }
  | { id: string; type: 'result'; value: Pixels | Snapshot }
  | { id: string; type: 'error'; error: string };
