import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { AUTOMATIC_FIXTURE, makeAutomaticFixture } from '../tests/automatic-fixture';
import { AI_FIXTURE, makeAIFixture } from '../tests/ai-fixture';

/** Erasing fills with the surrounding paper; photos and anti-aliasing allow a little drift. */
function expectNear(actual: readonly number[], expected: readonly number[], tolerance = 8): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, channel) => expect(Math.abs(value - expected[channel])).toBeLessThanOrEqual(tolerance));
}

// Erased marks on the garment's beige fill (#eee6d9) take that colour back, not white.
const GARMENT_FILL = [238, 230, 217, 255];
// The automatic fixture's sheet (#f5f5f2), where a later erase repaints an auto-cleaned arrow.
const SHEET_PAPER = [245, 245, 242, 255];
// Plain fabric inside the AI fixture's left garment, away from seams and stitching.
const AI_FABRIC = { x: 440, y: 400 };

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
    await expect(page.locator('#autoCleanStatus')).toHaveAttribute('data-state', 'idle');
    await page.locator('[data-action="auto-clean"]').click();
    await expect(page.locator('#autoCleanStatus')).toHaveAttribute('data-state', 'unchanged');
    const unchanged = await page.evaluate(async () => {
      const recent = await window.desktop.listRecent();
      if (!recent.ok || !recent.value[0]) throw new Error('가져온 프로젝트가 없습니다.');
      const reopened = await window.desktop.openRecent(recent.value[0].id);
      if (!reopened.ok) throw new Error(reopened.error);
      return { workVersion: reopened.value.snapshot.workVersion, pixel: [...reopened.value.snapshot.working.data.slice(0, 4)] };
    });
    expect(unchanged).toEqual({ workVersion: 0, pixel: [190, 180, 170, 255] });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(960, 540));
    await expect(page.locator('#tabEdit')).toBeVisible();
    await expect(page.getByRole('button', { name: '칠한 곳 지우기', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '결과 확인 및 저장', exact: true })).toBeVisible();
    const colorFill = page.locator('details.advanced-block').first();
    await colorFill.locator('summary').click();
    await expect(page.getByRole('button', { name: '찍은 색으로 채우기', exact: true })).toBeVisible();
    await expect(page.locator('#zoom100Button')).toBeVisible();
    await page.getByRole('button', { name: '전체 선택', exact: true }).click();
    await page.getByRole('button', { name: '칠한 곳 지우기', exact: true }).click();
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
    await page.locator('button[data-tool="lasso"]').click();
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
    await page.locator('button[data-tool="protect"]').click();
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
    // "저장됨" above can still show the state from before the candidate was applied; let the
    // autosave of that change finish so closing finds nothing unsaved.
    await expect(page.locator('#saveState')).toContainText('저장됨');
    await page.screenshot({ path: path.join('test-results', 'workbench.png') });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('imported garment cleanup, manual fill, undo/redo, PNG export, and reopen persist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sketch-automatic-desktop-'));
  const sourcePath = path.join(root, 'synthetic-garment.png');
  const sourceBytes = await makeAutomaticFixture();
  await writeFile(sourcePath, sourceBytes);
  const sourceHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  const env = { ...process.env, NODE_ENV: 'test', LOCALAPPDATA: root };
  const executablePath = process.env.SKETCH_TEST_EXECUTABLE;
  const launch = () => electron.launch({
    executablePath,
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${path.join(root, 'profile')}`], env,
  });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
    await expect(page.locator('#saveProjectButton')).toBeVisible();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await expect(page.getByRole('heading', { name: '정리할 작업 사진을 여세요' })).toBeVisible();
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [filePath] }) });
    }, sourcePath);
    await page.locator('#emptyOpenButton').click();
    await expect(page.locator('#imageDimensions')).toContainText(String(AUTOMATIC_FIXTURE.width));
    const automaticStatus = page.locator('#autoCleanStatus');
    await expect(automaticStatus).toHaveAttribute('data-state', 'idle');
    await page.locator('[data-action="auto-clean"]').click();
    await expect(automaticStatus).toHaveAttribute('data-state', 'complete');
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await expect(page.locator('#saveState')).toContainText('저장됨');

    const reopen = async () => page.evaluate(async () => {
      const recent = await window.desktop.listRecent();
      if (!recent.ok || !recent.value[0]) throw new Error('자동 정리 프로젝트가 저장되지 않았습니다.');
      const opened = await window.desktop.openRecent(recent.value[0].id);
      if (!opened.ok) throw new Error(opened.error);
      return { id: opened.value.id, folder: opened.value.folder, workVersion: opened.value.snapshot.workVersion };
    });
    const readPersisted = async () => {
      const project = await reopen();
      const manifest = JSON.parse(await readFile(path.join(project.folder, 'project.json'), 'utf8')) as { currentRevision: string };
      const revision = path.join(project.folder, 'revisions', manifest.currentRevision);
      const image = await sharp(await readFile(path.join(revision, 'working.png'))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const deleteMasks = await sharp(await readFile(path.join(revision, 'delete-mask.png'))).greyscale().raw().toBuffer({ resolveWithObject: true });
      const protectMasks = await sharp(await readFile(path.join(revision, 'protect-mask.png'))).greyscale().raw().toBuffer({ resolveWithObject: true });
      const pixelAt = (x: number, y: number): number[] => [...image.data.subarray((y * image.info.width + x) * 4, (y * image.info.width + x) * 4 + 4)];
      return {
        ...project,
        pixelAt,
        deleteAt: (x: number, y: number) => deleteMasks.data[y * deleteMasks.info.width + x],
        protectAt: (x: number, y: number) => protectMasks.data[y * protectMasks.info.width + x],
      };
    };

    let cleaned = await readPersisted();
    expect(cleaned.pixelAt(AUTOMATIC_FIXTURE.arrow.x, AUTOMATIC_FIXTURE.arrow.y)).toEqual([255, 255, 255, 255]);
    expect(cleaned.pixelAt(AUTOMATIC_FIXTURE.exteriorTable.x, AUTOMATIC_FIXTURE.exteriorTable.y)).toEqual([255, 255, 255, 255]);
    const seamBefore = cleaned.pixelAt(AUTOMATIC_FIXTURE.seam.x, AUTOMATIC_FIXTURE.seam.y);
    expect(seamBefore[0]).toBeLessThan(100);
    expect(seamBefore[1]).toBeLessThan(100);
    const detailBefore = cleaned.pixelAt(AUTOMATIC_FIXTURE.garmentDetail.x, AUTOMATIC_FIXTURE.garmentDetail.y);
    expect(detailBefore[0]).toBeLessThan(100);
    expect(cleaned.protectAt(AUTOMATIC_FIXTURE.seam.x, AUTOMATIC_FIXTURE.seam.y)).toBe(0);

    await page.locator('#undoButton').click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    const autoUndo = await readPersisted();
    expect(autoUndo.pixelAt(AUTOMATIC_FIXTURE.arrow.x, AUTOMATIC_FIXTURE.arrow.y)).toEqual([245, 24, 22, 255]);
    await page.locator('#redoButton').click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    cleaned = await readPersisted();
    expect(cleaned.pixelAt(AUTOMATIC_FIXTURE.arrow.x, AUTOMATIC_FIXTURE.arrow.y)).toEqual([255, 255, 255, 255]);

    await page.locator('#zoomReadout').click();
    await page.locator('#zoom100Button').click();
    await expect(page.locator('#zoomReadout')).toHaveText('100%');
    await page.locator('#tabEdit').click();
    await page.locator('button[data-tool="delete"]').click();
    await page.locator('#brushSize').evaluate(element => {
      (element as HTMLInputElement).value = '3';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const manualFillPoint = await imageScreenPoint(page, AUTOMATIC_FIXTURE.manualFill.x, AUTOMATIC_FIXTURE.manualFill.y, AUTOMATIC_FIXTURE.width, AUTOMATIC_FIXTURE.height);
    await page.mouse.move(manualFillPoint.x, manualFillPoint.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    const selected = await readPersisted();
    const manualBefore = selected.pixelAt(AUTOMATIC_FIXTURE.manualFill.x, AUTOMATIC_FIXTURE.manualFill.y);
    expect(manualBefore).not.toEqual([255, 255, 255, 255]);
    expect(selected.deleteAt(AUTOMATIC_FIXTURE.manualFill.x, AUTOMATIC_FIXTURE.manualFill.y)).toBeGreaterThan(0);

    await page.getByRole('button', { name: '칠한 곳 지우기', exact: true }).click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    let manuallyCleaned = await readPersisted();
    expectNear(manuallyCleaned.pixelAt(AUTOMATIC_FIXTURE.manualFill.x, AUTOMATIC_FIXTURE.manualFill.y), GARMENT_FILL);

    await page.locator('#undoButton').click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    const undoneFill = await readPersisted();
    expect(undoneFill.pixelAt(AUTOMATIC_FIXTURE.manualFill.x, AUTOMATIC_FIXTURE.manualFill.y)).toEqual(manualBefore);
    await page.locator('#redoButton').click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    manuallyCleaned = await readPersisted();
    expectNear(manuallyCleaned.pixelAt(AUTOMATIC_FIXTURE.manualFill.x, AUTOMATIC_FIXTURE.manualFill.y), GARMENT_FILL);

    await page.locator('button[data-tool="protect"]').click();
    await page.locator('#brushSize').evaluate(element => {
      (element as HTMLInputElement).value = '4';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const seamPoint = await imageScreenPoint(page, AUTOMATIC_FIXTURE.seam.x, AUTOMATIC_FIXTURE.seam.y, AUTOMATIC_FIXTURE.width, AUTOMATIC_FIXTURE.height);
    await page.mouse.move(seamPoint.x, seamPoint.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    expect((await readPersisted()).protectAt(AUTOMATIC_FIXTURE.seam.x, AUTOMATIC_FIXTURE.seam.y)).toBe(255);

    await page.locator('#undoButton').click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    expect((await readPersisted()).protectAt(AUTOMATIC_FIXTURE.seam.x, AUTOMATIC_FIXTURE.seam.y)).toBe(0);
    await page.locator('#redoButton').click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    const reopened = await readPersisted();
    expect(reopened.protectAt(AUTOMATIC_FIXTURE.seam.x, AUTOMATIC_FIXTURE.seam.y)).toBe(255);
    expect(reopened.pixelAt(AUTOMATIC_FIXTURE.seam.x, AUTOMATIC_FIXTURE.seam.y)).toEqual(seamBefore);
    expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(sourceHash);

    const exportedPath = path.join(root, 'automatic-cleaned.png');
    await page.locator('#tabExport').click();
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showSaveDialog', { configurable: true, value: async () => ({ canceled: false, filePath }) });
    }, exportedPath);
    await page.getByRole('button', { name: 'PNG 저장', exact: true }).click();
    await expect(page.locator('#inspectorContent')).toContainText('저장 완료');
    const exported = await sharp(await readFile(exportedPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const outputPixel = (x: number, y: number): number[] => [...exported.data.subarray((y * exported.info.width + x) * 4, (y * exported.info.width + x) * 4 + 4)];
    expect([exported.info.width, exported.info.height]).toEqual([AUTOMATIC_FIXTURE.width, AUTOMATIC_FIXTURE.height]);
    expectNear(outputPixel(AUTOMATIC_FIXTURE.arrow.x, AUTOMATIC_FIXTURE.arrow.y), SHEET_PAPER);
    expect(outputPixel(AUTOMATIC_FIXTURE.seam.x, AUTOMATIC_FIXTURE.seam.y)).toEqual(seamBefore);
    expectNear(outputPixel(AUTOMATIC_FIXTURE.manualFill.x, AUTOMATIC_FIXTURE.manualFill.y), GARMENT_FILL);

    const savedVersion = reopened.workVersion;
    const savedProjectId = reopened.id;
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await expect(page.locator(`[data-recent-id="${savedProjectId}"]`)).toBeVisible();
    await page.locator(`[data-recent-id="${savedProjectId}"]`).click();
    await expect(page.locator('#autoCleanStatus')).toHaveAttribute('data-state', 'idle');
    await expect(page.locator('#imageDimensions')).toContainText(String(AUTOMATIC_FIXTURE.width));
    const reopenedInUi = await page.evaluate(async projectId => {
      const result = await window.desktop.openRecent(projectId);
      if (!result.ok) throw new Error(result.error);
      const pixels = result.value.snapshot.working.data;
      const offset = (x: number, y: number) => (y * result.value.snapshot.working.width + x) * 4;
      return {
        workVersion: result.value.snapshot.workVersion,
        manualPixel: [...pixels.slice(offset(160, 260), offset(160, 260) + 4)],
        arrowPixel: [...pixels.slice(offset(40, 100), offset(40, 100) + 4)],
      };
    }, savedProjectId);
    expect(reopenedInUi.workVersion).toBe(savedVersion);
    expectNear(reopenedInUi.manualPixel, GARMENT_FILL);
    expectNear(reopenedInUi.arrowPixel, SHEET_PAPER);
    await page.screenshot({ path: path.join('test-results', 'automatic-workbench.png') });
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('local AI auto cleanup, manual correction, export, and reopen preserve original and garment details', async () => {
  test.setTimeout(180_000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'sketch-local-ai-'));
  const sourcePath = path.join(root, 'synthetic-ai-garment.png');
  const exportPath = path.join(root, 'synthetic-ai-cleaned.png');
  await writeFile(sourcePath, await makeAIFixture());
  const sourceHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  const env = { ...process.env, NODE_ENV: 'test', LOCALAPPDATA: root };
  const executablePath = process.env.SKETCH_TEST_EXECUTABLE;
  const profilePath = path.join(root, 'profile');
  const launch = () => electron.launch({
    executablePath,
    args: [...(executablePath ? [] : ['.']), `--user-data-dir=${profilePath}`],
    env,
  });
  let app = await launch();
  const pageErrors: string[] = [];

  try {
    let page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
    page.on('pageerror', error => pageErrors.push(error.message));
    await expect(page.getByRole('heading', { name: '정리할 작업 사진을 여세요' })).toBeVisible();
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [filePath] }) });
    }, sourcePath);

    await page.locator('#emptyOpenButton').click();
    await expect(page.locator('#imageDimensions')).toContainText(String(AI_FIXTURE.width));
    const status = page.locator('#autoCleanStatus');
    await expect(status).toHaveAttribute('data-state', 'idle');
    const bridge = await page.evaluate(() => ({
      detectText: typeof window.desktop.detectText,
      cancelTextDetection: typeof window.desktop.cancelTextDetection,
    }));
    expect(bridge).toEqual({ detectText: 'function', cancelTextDetection: 'function' });

    const projectHeader = async () => {
      const recent = await page.evaluate(async () => {
      const recent = await window.desktop.listRecent();
      if (!recent.ok || !recent.value[0]) throw new Error('가져온 AI 작업이 없습니다.');
        return recent.value[0];
      });
      const manifest = JSON.parse(await readFile(path.join(recent.folder, 'project.json'), 'utf8')) as {
        id: string;
        currentRevision: string;
        revisions: { id: string; workVersion: number }[];
      };
      const revision = manifest.revisions.find(item => item.id === manifest.currentRevision);
      if (!revision) throw new Error('현재 저장 버전을 찾을 수 없습니다.');
      return { id: manifest.id, folder: recent.folder, workVersion: revision.workVersion };
    };
    const sourceImage = await sharp(await readFile(sourcePath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sourcePixels = {
      width: sourceImage.info.width,
      height: sourceImage.info.height,
      data: sourceImage.data,
    };
    const readPersisted = async () => {
      const project = await projectHeader();
      const manifest = JSON.parse(await readFile(path.join(project.folder, 'project.json'), 'utf8')) as { currentRevision: string };
      const revisionFolder = path.join(project.folder, 'revisions', manifest.currentRevision);
      const image = await sharp(await readFile(path.join(revisionFolder, 'working.png'))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const pixelAt = (point: { x: number; y: number }): number[] => {
        const offset = (point.y * image.info.width + point.x) * 4;
        return [...image.data.subarray(offset, offset + 4)];
      };
      const darkCount = (region: { left: number; top: number; right: number; bottom: number }): number => {
        let count = 0;
        for (let y = region.top; y < region.bottom; y += 1) {
          for (let x = region.left; x < region.right; x += 1) {
            const offset = (y * image.info.width + x) * 4;
            if (Math.max(image.data[offset], image.data[offset + 1], image.data[offset + 2]) < 170) count += 1;
          }
        }
        return count;
      };
      return { ...project, pixelAt, darkCount };
    };

    const originalEnglishInk = (() => {
      let count = 0;
      for (let y = AI_FIXTURE.english.top; y < AI_FIXTURE.english.bottom; y += 1) {
        for (let x = AI_FIXTURE.english.left; x < AI_FIXTURE.english.right; x += 1) {
          const offset = (y * sourcePixels.width + x) * 4;
          if (Math.max(sourcePixels.data[offset], sourcePixels.data[offset + 1], sourcePixels.data[offset + 2]) < 170) count += 1;
        }
      }
      return count;
    })();
    const originalKoreanInk = (() => {
      let count = 0;
      for (let y = AI_FIXTURE.korean.top; y < AI_FIXTURE.korean.bottom; y += 1) {
        for (let x = AI_FIXTURE.korean.left; x < AI_FIXTURE.korean.right; x += 1) {
          const offset = (y * sourcePixels.width + x) * 4;
          if (Math.max(sourcePixels.data[offset], sourcePixels.data[offset + 1], sourcePixels.data[offset + 2]) < 170) count += 1;
        }
      }
      return count;
    })();
    expect(originalEnglishInk).toBeGreaterThan(30);
    expect(originalKoreanInk).toBeGreaterThan(30);

    await page.locator('[data-action="auto-clean"]').click();
    // The red mark inside the shirt is a note: it is selected for review, not erased.
    await expect(status).toHaveAttribute('data-state', 'review', { timeout: 120_000 });
    await expect(page.locator('#maskToggleButton')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#processingOverlay')).toBeHidden({ timeout: 120_000 });
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');

    const cleaned = await readPersisted();
    expect(cleaned.darkCount(AI_FIXTURE.english)).toBeLessThan(originalEnglishInk * 0.35);
    expect(cleaned.darkCount(AI_FIXTURE.korean)).toBeLessThan(originalKoreanInk * 0.35);
    expect(cleaned.pixelAt(AI_FIXTURE.tableInk)).toEqual([255, 255, 255, 255]);
    expect(cleaned.pixelAt(AI_FIXTURE.redArrow)).toEqual([255, 255, 255, 255]);
    const seam = cleaned.pixelAt(AI_FIXTURE.garmentSeam);
    const button = cleaned.pixelAt(AI_FIXTURE.garmentButton);
    const stitch = cleaned.pixelAt(AI_FIXTURE.garmentStitch);
    expect(seam[0]).toBeLessThan(120);
    expect(button[0]).toBeLessThan(120);
    expect(stitch[0]).toBeLessThan(160);
    const manualBefore = cleaned.pixelAt(AI_FIXTURE.manualFix);
    expect(manualBefore[0]).toBeGreaterThan(manualBefore[1] * 1.35);

    await page.locator('#zoomReadout').click();
    await page.locator('#zoom100Button').click();
    await expect(page.locator('#zoomReadout')).toHaveText('100%');
    await page.locator('button[data-tool="delete"]').click();
    await page.locator('#brushSize').evaluate(element => {
      (element as HTMLInputElement).value = '9';
      element.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const markPoint = await imageScreenPoint(page, AI_FIXTURE.manualFix.x, AI_FIXTURE.manualFix.y, AI_FIXTURE.width, AI_FIXTURE.height);
    await page.mouse.move(markPoint.x, markPoint.y);
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.getByRole('button', { name: '칠한 곳 지우기', exact: true }).click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    let corrected = await readPersisted();
    expectNear(corrected.pixelAt(AI_FIXTURE.manualFix), corrected.pixelAt(AI_FABRIC), 14);
    expect(corrected.pixelAt(AI_FIXTURE.garmentSeam)).toEqual(seam);
    expect(corrected.pixelAt(AI_FIXTURE.garmentButton)).toEqual(button);
    expect(corrected.pixelAt(AI_FIXTURE.garmentStitch)).toEqual(stitch);

    await page.locator('#undoButton').click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    expect((await readPersisted()).pixelAt(AI_FIXTURE.manualFix)).toEqual(manualBefore);
    await page.locator('#redoButton').click();
    await expect(page.locator('#processingOverlay')).toBeHidden();
    await page.locator('#saveProjectButton').click();
    await expect(page.locator('#saveState')).toContainText('저장됨');
    corrected = await readPersisted();
    expectNear(corrected.pixelAt(AI_FIXTURE.manualFix), corrected.pixelAt(AI_FABRIC), 14);

    await page.locator('#tabExport').click();
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showSaveDialog', { configurable: true, value: async () => ({ canceled: false, filePath }) });
    }, exportPath);
    await page.getByRole('button', { name: 'PNG 저장', exact: true }).click();
    await expect(page.locator('#inspectorContent')).toContainText('저장 완료');
    const exported = await sharp(await readFile(exportPath)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const exportedPixel = (point: { x: number; y: number }): number[] => {
      const offset = (point.y * exported.info.width + point.x) * 4;
      return [...exported.data.subarray(offset, offset + 4)];
    };
    expect([exported.info.width, exported.info.height]).toEqual([AI_FIXTURE.width, AI_FIXTURE.height]);
    expectNear(exportedPixel(AI_FIXTURE.manualFix), exportedPixel(AI_FABRIC), 14);
    expect(exportedPixel(AI_FIXTURE.garmentSeam)).toEqual(seam);
    expect(exportedPixel(AI_FIXTURE.garmentButton)).toEqual(button);
    expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(sourceHash);

    const savedProjectId = corrected.id;
    const savedVersion = corrected.workVersion;
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.on('pageerror', error => pageErrors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 900));
    await expect(page.locator(`[data-recent-id="${savedProjectId}"]`)).toBeVisible();
    await page.locator(`[data-recent-id="${savedProjectId}"]`).click();
    await expect(page.locator('#autoCleanStatus')).toHaveAttribute('data-state', 'idle');
    await expect(page.locator('#imageDimensions')).toContainText(String(AI_FIXTURE.width));
    const reopened = await projectHeader();
    expect(reopened.workVersion).toBe(savedVersion);
    const afterReopen = await readPersisted();
    expect(afterReopen.darkCount(AI_FIXTURE.english)).toBeLessThan(originalEnglishInk * 0.35);
    expect(afterReopen.darkCount(AI_FIXTURE.korean)).toBeLessThan(originalKoreanInk * 0.35);
    expectNear(afterReopen.pixelAt(AI_FIXTURE.manualFix), afterReopen.pixelAt(AI_FABRIC), 14);
    expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(sourceHash);
    await page.screenshot({ path: path.join('test-results', 'local-ai-workbench.png') });
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('photoshop-style tools edit a 12MP sheet instantly with real mouse and keys', async () => {
  // Paper points away from every edit: a stray stroke or selection would change one of them.
  const PAPER_GRID: Array<[number, number]> = [[100, 100], [1000, 400], [3800, 200], [1500, 1700], [3000, 1700], [2000, 2000], [2500, 2150], [600, 2500], [3500, 2800], [3900, 2950]];
  const root = await mkdtemp(path.join(os.tmpdir(), 'sketch-tools-'));
  const sourcePath = path.join(root, 'large-sheet.png');
  const [width, height] = [4000, 3000];
  const sheet = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < sheet.length; offset += 4) sheet.set([246, 243, 236, 255], offset);
  // A thick pen line across the sheet (12px, as a marker at 12MP).
  for (let y = 1414; y < 1426; y += 1) for (let x = 0; x < width; x += 1) sheet.set([40, 40, 40, 255], (y * width + x) * 4);
  await sharp(sheet, { raw: { width, height, channels: 4 } }).png().toFile(sourcePath);
  const env = { ...process.env, NODE_ENV: 'test', LOCALAPPDATA: root };
  const executablePath = process.env.SKETCH_TEST_EXECUTABLE;
  const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), `--user-data-dir=${path.join(root, 'profile')}`], env });
  try {
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [filePath] }) });
    }, sourcePath);
    await page.locator('#emptyOpenButton').click();
    await expect(page.locator('#imageDimensions')).toContainText('4,000');
    const point = (x: number, y: number) => imageScreenPoint(page, x, y, width, height);
    const settle = () => page.evaluate(() => new Promise<number>(resolve => requestAnimationFrame(() => resolve(performance.now()))));
    const overlayShown = () => page.locator('#processingOverlay').isVisible();

    // E: one eraser stroke across the dark band.
    await page.keyboard.press('e');
    await expect(page.locator('button[data-tool="erase"]')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#brushSize').fill('60');
    const stroke = async (from: number, to: number): Promise<number> => {
      const start = await point(from, 1420);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (let x = from; x <= to; x += 100) { const next = await point(x, 1420); await page.mouse.move(next.x, next.y); }
      const began = await page.evaluate(() => performance.now());
      await page.mouse.up();
      return await settle() - began;
    };
    const eraseTimes = [await stroke(400, 1000), await stroke(1000, 1600), await stroke(200, 300)];
    expect(await overlayShown()).toBe(false);

    // M: drag a rectangle on the band and Delete it.
    await page.keyboard.press('m');
    const [a, b] = [await point(2000, 1300), await point(2600, 1500)];
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
    const deleteBegan = await page.evaluate(() => performance.now());
    await page.keyboard.press('Delete');
    const deleteMs = await settle() - deleteBegan;
    expect(await overlayShown()).toBe(false);

    // P: three straight segments closed with Enter, then Backspace deletes.
    await page.keyboard.press('p');
    for (const [x, y] of [[3000, 1300], [3600, 1300], [3600, 1550]]) { const next = await point(x, y); await page.mouse.click(next.x, next.y); }
    await page.keyboard.press('Enter');
    await page.keyboard.press('Backspace');
    expect(await overlayShown()).toBe(false);

    // M with real modifier keys: Shift-drag adds, Alt-drag subtracts the middle.
    await page.keyboard.press('m');
    const box = async (from: [number, number], to: [number, number], key?: 'Shift' | 'Alt') => {
      const [start, end] = [await point(...from), await point(...to)];
      if (key) await page.keyboard.down(key);
      await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 5 }); await page.mouse.up();
      if (key) await page.keyboard.up(key);
    };
    await box([1700, 1350], [1800, 1480]);
    await box([1880, 1350], [1960, 1480], 'Shift');
    await box([1750, 1350], [1900, 1480], 'Alt');
    await page.keyboard.press('Delete');
    expect(await overlayShown()).toBe(false);
    await page.screenshot({ path: path.join(process.env.SKETCH_SHOT_DIR ?? root, 'photoshop-tools.png') });

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+S' : 'Control+S');
    await expect(page.locator('#saveState')).toContainText('저장됨');
    const saved = await page.evaluate(async ([w, PAPER_GRID]) => {
      const recent = await window.desktop.listRecent();
      if (!recent.ok || !recent.value[0]) throw new Error('저장된 프로젝트가 없습니다.');
      const reopened = await window.desktop.openRecent(recent.value[0].id);
      if (!reopened.ok) throw new Error(reopened.error);
      const at = (x: number, y: number) => [...reopened.value.snapshot.working.data.slice((y * w + x) * 4, (y * w + x) * 4 + 3)];
      return { erased: at(1000, 1420), marquee: at(2300, 1420), pen: at(3500, 1420), untouched: at(3800, 1420), combined: [at(1720, 1420), at(1820, 1420), at(1930, 1420)], paperGrid: PAPER_GRID.filter(([x, y]) => at(x, y).join() !== '246,243,236') };
    }, [width, PAPER_GRID] as const);
    // Erasing fills with the sheet's own paper colour.
    const PAPER = [246, 243, 236];
    expect(saved).toEqual({ erased: PAPER, marquee: PAPER, pen: PAPER, untouched: [40, 40, 40], combined: [PAPER, [40, 40, 40], PAPER], paperGrid: [] });
    expect(pageErrors).toEqual([]);
    console.log(`12MP eraser strokes ${eraseTimes.map(ms => ms.toFixed(0)).join('/')}ms, marquee Delete ${deleteMs.toFixed(0)}ms`);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function launchWithPhotos(sizes: Array<{ width: number; height: number; color: [number, number, number] }>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sketch-switch-'));
  const photos: string[] = [];
  for (const [index, { width, height, color }] of sizes.entries()) {
    const file = path.join(root, `sheet-${index + 1}.png`);
    // Paper of the given colour with a dark pen line across the middle to erase.
    const data = Buffer.alloc(width * height * 4);
    for (let offset = 0; offset < data.length; offset += 4) data.set([...color, 255], offset);
    for (let y = Math.floor(height / 2) - 3; y < Math.floor(height / 2) + 3; y += 1) for (let x = 0; x < width; x += 1) data.set([35, 35, 35, 255], (y * width + x) * 4);
    await sharp(data, { raw: { width, height, channels: 4 } }).png().toFile(file);
    photos.push(file);
  }
  const env = { ...process.env, NODE_ENV: 'test', LOCALAPPDATA: root };
  const executablePath = process.env.SKETCH_TEST_EXECUTABLE;
  const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  const chooseNext = (file: string) => app.evaluate(({ dialog }, filePath) => {
    Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [filePath] }) });
  }, file);
  const eraseAcross = async (width: number, height: number) => {
    await page.keyboard.press('e');
    await page.locator('#brushSize').fill('20');
    const [a, b] = [await imageScreenPoint(page, 20, height / 2, width, height), await imageScreenPoint(page, width - 20, height / 2, width, height)];
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  };
  return { root, photos, app, page, chooseNext, eraseAcross };
}

test('closing with unsaved changes asks in a native dialog: 취소 keeps the window, 닫기 closes it', async () => {
  const { root, photos, app, page, chooseNext, eraseAcross } = await launchWithPhotos([{ width: 300, height: 200, color: [244, 242, 234] }]);
  try {
    await chooseNext(photos[0]);
    await page.locator('#emptyOpenButton').click();
    await expect(page.locator('#imageDimensions')).toContainText('300');
    await app.evaluate(({ dialog }) => {
      const calls: string[] = [];
      Object.assign(globalThis, { closeAsked: calls, closeAnswer: 1 });
      Object.defineProperty(dialog, 'showMessageBoxSync', { configurable: true, value: (_window: unknown, options: { message: string }) => {
        calls.push(options.message);
        return (globalThis as unknown as { closeAnswer: number }).closeAnswer;
      } });
    });
    await eraseAcross(300, 200);
    // Close right away, before the autosave a moment later.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { closeAsked: string[] }).closeAsked.length)).toBe(1);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(await app.evaluate(() => (globalThis as unknown as { closeAsked: string[] }).closeAsked[0])).toContain('저장되지 않은 변경사항');
    await app.evaluate(() => Object.assign(globalThis, { closeAnswer: 0 }));
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('opening the next photo after saving one leaves only the new photo and keeps the first in recent work', async () => {
  const { root, photos, app, page, chooseNext, eraseAcross } = await launchWithPhotos([
    { width: 300, height: 200, color: [244, 242, 234] },
    { width: 260, height: 180, color: [236, 240, 246] },
  ]);
  const dialogs: string[] = [];
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss().catch(() => undefined); });
  try {
    // Photo 1: edit, wait for the project save, then save the PNG.
    await chooseNext(photos[0]);
    await page.locator('#emptyOpenButton').click();
    await expect(page.locator('#imageDimensions')).toContainText('300');
    await eraseAcross(300, 200);
    await expect(page.locator('#saveState')).toContainText('저장됨');
    const firstName = await page.locator('#projectName').innerText();
    await page.locator('#tabExport').click();
    const exportPath = path.join(root, 'sheet-1-clean.png');
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showSaveDialog', { configurable: true, value: async () => ({ canceled: false, filePath }) });
    }, exportPath);
    await page.getByRole('button', { name: 'PNG 저장', exact: true }).click();
    await expect(page.locator('#inspectorContent')).toContainText('저장 완료');

    // Photo 2: opens without a prompt and replaces photo 1 on screen.
    await chooseNext(photos[1]);
    await page.locator('#openButton').click();
    await expect(page.locator('#imageDimensions')).toContainText('260');
    await expect(page.locator('#projectName')).not.toHaveText(firstName);
    expect(dialogs).toEqual([]);
    await expect(page.locator('#tabEdit')).toHaveAttribute('aria-selected', 'true');
    // Photo 1's undo history is gone with it: undo cannot bring photo 1 back.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Z' : 'Control+Z');
    await expect(page.locator('#imageDimensions')).toContainText('260');
    // Nothing to undo on the new photo: it must not turn into an unsaved change, even for the
    // moment before the next autosave.
    expect(await page.locator('#saveState').innerText()).toContain('저장됨');

    const saved = await page.evaluate(async () => {
      const recent = await window.desktop.listRecent();
      if (!recent.ok) throw new Error(recent.error);
      const first = recent.value.find(item => item.name.includes('sheet-1'));
      if (!first) throw new Error('1번 작업이 최근 작업에 없습니다.');
      const reopened = await window.desktop.openRecent(first.id);
      if (!reopened.ok) throw new Error(reopened.error);
      const { width, data } = reopened.value.snapshot.working;
      return { count: recent.value.length, erased: [...data.slice((100 * width + 150) * 4, (100 * width + 150) * 4 + 3)] };
    });
    expect(saved).toEqual({ count: 2, erased: [244, 242, 234] });
    const exported = await sharp(await readFile(exportPath)).raw().toBuffer({ resolveWithObject: true });
    expect([exported.info.width, exported.info.height]).toEqual([300, 200]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('line select (W) picks one line with a click; Shift adds, Alt takes away, Delete erases only it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sketch-line-'));
  const sourcePath = path.join(root, 'sheet.png');
  const [width, height] = [600, 400];
  const paper = [248, 246, 238];
  const sheet = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < sheet.length; offset += 4) sheet.set([...paper, 255], offset);
  const line = (x0: number, y0: number, x1: number, y1: number, thickness: number, value: number) => {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let step = 0; step <= steps; step += 1) {
      const cx = x0 + (x1 - x0) * step / steps;
      const cy = y0 + (y1 - y0) * step / steps;
      for (let y = Math.floor(cy - thickness); y <= Math.ceil(cy + thickness); y += 1) {
        for (let x = Math.floor(cx - thickness); x <= Math.ceil(cx + thickness); x += 1) {
          if (x < 0 || y < 0 || x >= width || y >= height || Math.hypot(x - cx, y - cy) > thickness / 2) continue;
          sheet.set([value, value, value, 255], (y * width + x) * 4);
        }
      }
    }
  };
  line(300, 10, 300, 390, 5, 30); // outline
  line(40, 60, 297, 200, 3, 90); // leader ending on the outline
  line(40, 340, 297, 300, 3, 90); // a second leader
  await sharp(sheet, { raw: { width, height, channels: 4 } }).png().toFile(sourcePath);
  const env = { ...process.env, NODE_ENV: 'test', LOCALAPPDATA: root };
  const executablePath = process.env.SKETCH_TEST_EXECUTABLE;
  const app = await electron.launch({ executablePath, args: [...(executablePath ? [] : ['.']), `--user-data-dir=${path.join(root, 'profile')}`], env });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ dialog }, filePath) => {
      Object.defineProperty(dialog, 'showOpenDialog', { configurable: true, value: async () => ({ canceled: false, filePaths: [filePath] }) });
    }, sourcePath);
    await page.locator('#emptyOpenButton').click();
    await expect(page.locator('#imageDimensions')).toContainText('600');
    const point = (x: number, y: number) => imageScreenPoint(page, x, y, width, height);
    const click = async (x: number, y: number, key?: 'Shift' | 'Alt') => {
      const target = await point(x, y);
      if (key) await page.keyboard.down(key);
      await page.mouse.click(target.x, target.y);
      if (key) await page.keyboard.up(key);
    };

    await page.keyboard.press('w');
    await expect(page.locator('button[data-tool="line"]')).toHaveAttribute('aria-pressed', 'true');
    await click(150, 120); // first leader
    await click(150, 323, 'Shift'); // add the second
    await click(150, 120, 'Alt'); // take the first back out
    await page.keyboard.press('Delete');
    await click(450, 200); // blank paper: nothing to pick, nothing changes
    await expect(page.locator('#saveState')).toContainText('저장됨');

    const saved = await page.evaluate(async (w) => {
      const recent = await window.desktop.listRecent();
      if (!recent.ok || !recent.value[0]) throw new Error('저장된 프로젝트가 없습니다.');
      const reopened = await window.desktop.openRecent(recent.value[0].id);
      if (!reopened.ok) throw new Error(reopened.error);
      const at = (x: number, y: number) => [...reopened.value.snapshot.working.data.slice((y * w + x) * 4, (y * w + x) * 4 + 3)];
      return { first: at(150, 120), second: at(150, 323), outline: at(300, 320), outlineAtJoin: at(300, 200) };
    }, width);
    expect(saved.first).toEqual([90, 90, 90]);
    expect(saved.second[0]).toBeGreaterThan(200);
    expect(saved.outline).toEqual([30, 30, 30]);
    expect(saved.outlineAtJoin).toEqual([30, 30, 30]);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
