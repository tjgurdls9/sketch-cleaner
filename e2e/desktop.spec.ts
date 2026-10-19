import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

async function imageScreenPoint(page: import('@playwright/test').Page, x: number, y: number, width: number, height: number): Promise<{ x: number; y: number }> {
  const bounds = await page.locator('#stage').boundingBox();
  if (!bounds) throw new Error('작업 캔버스 위치를 찾을 수 없습니다.');
  const zoomText = await page.locator('#zoomReadout').innerText();
  const zoom = Number(zoomText.replace('%', '')) / 100;
  if (!Number.isFinite(zoom) || zoom <= 0) throw new Error(`화면 확대율을 읽을 수 없습니다: ${zoomText}`);
  return {
    x: bounds.x + bounds.width / 2 + (x - width / 2) * zoom,
    y: bounds.y + bounds.height / 2 + (y - height / 2) * zoom,
  };
}

test('desktop local editing, manual request round-trip and durable recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sketch-desktop-'));
  const sourcePath = path.join(root, 'work-sheet.png');
  const candidatePath = path.join(root, 'downloaded-candidate.png');
  const exportPath = path.join(root, 'finished.png');
  await sharp({ create: { width: 480, height: 320, channels: 4, background: { r: 190, g: 180, b: 170, alpha: 1 } } }).png().toFile(sourcePath);
  const candidateData = Buffer.alloc(480 * 320 * 4);
  for (let y = 0; y < 320; y += 1) {
    for (let x = 0; x < 480; x += 1) {
      const offset = (y * 480 + x) * 4;
      candidateData.set(x < 240 ? [80, 110, 140, 255] : [220, 150, 70, 255], offset);
    }
  }
  await sharp(candidateData, { raw: { width: 480, height: 320, channels: 4 } }).png().toFile(candidatePath);
  const sourceHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  const env = { ...process.env, NODE_ENV: 'test', LOCALAPPDATA: root };
  const executablePath = process.env.SKETCH_TEST_EXECUTABLE;
  const app = await electron.launch({
    executablePath,
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${path.join(root, 'profile')}`], env,
  });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await expect(page.getByRole('heading', { name: '정리할 작업 사진을 여세요' })).toBeVisible();
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [filePath] }) });
    }, sourcePath);
    await page.locator('#emptyOpenButton').click();
    await expect(page.locator('#imageDimensions')).toContainText('480');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 540));
    await expect(page.getByRole('button', { name: '찍은 색으로 채우기', exact: true })).toBeVisible();
    await expect(page.locator('#zoom100Button')).toBeVisible();
    await page.getByRole('button', { name: '전체 선택', exact: true }).click();
    await page.getByRole('button', { name: '흰색으로 채우기', exact: true }).click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    const local = await page.evaluate(async () => {
      const recent = await window.desktop.listRecent();
      if (!recent.ok || !recent.value[0]) throw new Error('저장된 프로젝트 없음');
      const result = await window.desktop.openRecent(recent.value[0].id);
      if (!result.ok) throw new Error(result.error);
      return { id: result.value.id, folder: result.value.folder, color: [...result.value.snapshot.working.data.slice(0, 4)] };
    });
    expect(local.color).toEqual([255, 255, 255, 255]);
    await page.locator('#undoButton').click();
    await page.locator('#redoButton').click();
    await page.locator('#tabRequest').click();
    await page.getByRole('button', { name: '요청 파일 만들기', exact: true }).click();
    await expect(page.getByRole('button', { name: '문구 복사', exact: true })).toBeEnabled();
    const request = await page.evaluate(async id => {
      const p = await window.desktop.openRecent(id);
      if (!p.ok) throw new Error(p.error);
      const info = p.value.requests.at(-1);
      if (!info) throw new Error('요청 기록 없음');
      const bundle = await window.desktop.loadRequest(id, info.id);
      if (!bundle.ok) throw new Error(bundle.error);
      return { folder: info.folder, width: info.width, text: bundle.value.text };
    }, local.id);
    expect(request.width).toBe(480);
    expect(request.text).toContain('파랑');
    for (const file of ['input.png', 'guide.png', 'request.txt']) expect((await readFile(path.join(request.folder, file))).length).toBeGreaterThan(0);

    // Make a small selection through the visible canvas, then protect one point inside it.
    // The fit and 100% controls center the image; coordinates come from the rendered stage bounds.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
    await page.locator('#zoomReadout').click();
    await page.locator('#zoom100Button').click();
    await expect(page.locator('#zoomReadout')).toHaveText('100%');
    await page.locator('#tabEdit').click();
    await page.locator('[data-action="clear-selection"]').click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('[data-tool="lasso"]').click();
    const lasso = await Promise.all([
      imageScreenPoint(page, 70, 60, 480, 320),
      imageScreenPoint(page, 220, 60, 480, 320),
      imageScreenPoint(page, 220, 260, 480, 320),
      imageScreenPoint(page, 70, 260, 480, 320),
    ]);
    await page.mouse.move(lasso[0].x, lasso[0].y);
    await page.mouse.down();
    for (const point of [...lasso.slice(1), lasso[0]]) await page.mouse.move(point.x, point.y, { steps: 4 });
    await page.mouse.up();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('[data-tool="protect"]').click();
    await page.locator('#brushSize').evaluate(element => {
      (element as HTMLInputElement).value = '8';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const protectedPoint = await imageScreenPoint(page, 160, 160, 480, 320);
    await page.mouse.move(protectedPoint.x, protectedPoint.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await expect(page.locator('#saveState')).toContainText('저장됨');

    await page.locator('#tabReview').click();
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [filePath] }) });
    }, candidatePath);
    await page.getByRole('button', { name: '이 요청의 결과 이미지 가져오기', exact: true }).click();
    const apply = page.getByRole('button', { name: '선택 영역에 적용', exact: true });
    await expect(apply).toBeDisabled();
    await page.locator('input[name="comparison"][value="overlay"]').check();
    await page.locator('#alignX').fill('-140');
    await page.locator('#alignmentAck').check();
    await expect(apply).toBeEnabled();
    await apply.click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    await page.locator('#tabExport').click();
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showSaveDialog', { configurable: true, value: async () => ({ canceled: false, filePath }) });
    }, exportPath);
    await page.getByRole('button', { name: 'PNG 저장', exact: true }).click();
    await expect(page.locator('#inspectorContent')).toContainText('저장 완료');
    const output = await sharp(await readFile(exportPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([output.info.width, output.info.height]).toEqual([480, 320]);
    const pixelAt = (x: number, y: number): number[] => [...output.data.subarray((y * output.info.width + x) * 4, (y * output.info.width + x) * 4 + 4)];
    expect(pixelAt(120, 150)).toEqual([220, 150, 70, 255]);
    expect(pixelAt(300, 150)).toEqual([255, 255, 255, 255]);
    expect(pixelAt(160, 160)).toEqual([190, 180, 170, 255]);
    expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(sourceHash);
    const security = await app.evaluate(({ BrowserWindow }) => {
      const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
    });
    expect(security).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(pageErrors).toEqual([]);
    await page.screenshot({ path: path.join('test-results', 'workbench.png') });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
