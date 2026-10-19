import { Worker } from 'node:worker_threads';
import { validatePixels } from '../core/engine';
import type { Pixels } from '../shared/types';
import { requireId } from './security';
import { UserError } from './errors';

interface ActiveJob {
  id: string;
  worker: Worker;
  fail(error: Error): void;
}

export class TextDetectionService {
  private active: ActiveJob | null = null;
  constructor(private readonly modelPath: string, private readonly workerPath: string) {}

  async detect(pixels: Pixels, id: string): Promise<Uint8Array> {
    requireId(id, '자동 정리 요청이 올바르지 않습니다.');
    try { validatePixels(pixels); }
    catch { throw new UserError('사진은 2,500만 픽셀 이하의 올바른 이미지여야 합니다.'); }
    if (this.active) throw new UserError('이전 자동 정리를 마치는 중입니다. 잠시 후 다시 눌러 주세요.');
    const count = pixels.width * pixels.height;
    const worker = new Worker(this.workerPath, {
      workerData: { pixels, modelPath: this.modelPath }, execArgv: [],
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, mask?: Uint8Array): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate().finally(() => { if (this.active === job) this.active = null; });
        if (error) reject(error); else resolve(mask!);
      };
      const job: ActiveJob = { id, worker, fail: error => finish(error) };
      const timer = setTimeout(() => finish(new UserError('자동 정리 시간이 초과되었습니다. 직접 수정하거나 다시 시도해 주세요.')), 60_000);
      this.active = job;
      worker.on('message', (mask: unknown) => {
        if (!(mask instanceof Uint8Array) || mask.length !== count || mask.some(value => value !== 0 && value !== 255)) {
          finish(new UserError('자동 정리 결과를 확인하지 못했습니다. 사진은 유지됩니다.'));
          return;
        }
        finish(undefined, mask);
      });
      worker.on('error', () => finish(new UserError('자동 정리를 실행하지 못했습니다. 사진은 유지되며 직접 수정할 수 있습니다.')));
      worker.on('exit', () => { if (!settled) finish(new UserError('자동 정리가 중단되었습니다. 다시 시도하거나 직접 수정해 주세요.')); });
    });
  }

  cancel(id: string): void {
    requireId(id, '자동 정리 요청이 올바르지 않습니다.');
    if (this.active?.id === id) this.active.fail(new UserError('자동 정리를 취소했습니다.'));
  }

  dispose(): void { this.active?.fail(new UserError('자동 정리를 취소했습니다.')); }
}
