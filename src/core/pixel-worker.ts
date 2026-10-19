import { runPixelJob } from './engine';
import type { Pixels, Snapshot } from '../shared/types';
import type { PixelJobRequest, PixelJobResponse } from './worker-protocol';

const worker = self as unknown as {
  onmessage: ((event: MessageEvent<PixelJobRequest>) => void) | null;
  postMessage(value: PixelJobResponse, transfer?: Transferable[]): void;
};

function resultTransferables(value: Pixels | Snapshot): ArrayBuffer[] {
  const views = 'base' in value
    ? [value.base.data, value.working.data, value.deleteMask, value.protectMask]
    : [value.data];
  const seen = new Set<ArrayBuffer>();
  for (const view of views) {
    const buffer = view.buffer;
    if (buffer instanceof ArrayBuffer) seen.add(buffer);
  }
  return [...seen];
}

worker.onmessage = ({ data }: MessageEvent<PixelJobRequest>) => {
  if (!data || typeof data.id !== 'string' || !data.id) return;
  try {
    const value = runPixelJob(data.job, (completed, total) => {
      const interval = Math.max(1, Math.ceil(total / 100));
      if (completed === total || completed % interval === 0) worker.postMessage({ id: data.id, type: 'progress', completed, total });
    });
    worker.postMessage({ id: data.id, type: 'result', value }, resultTransferables(value));
  } catch {
    worker.postMessage({ id: data.id, type: 'error', error: '이미지를 처리하지 못했습니다. 선택 범위와 입력값을 확인한 뒤 다시 시도해 주세요.' });
  }
};
