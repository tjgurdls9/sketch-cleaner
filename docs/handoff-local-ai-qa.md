# Local AI cleanup QA handoff

The detector is exercised with a deterministic 960×720 SVG-rendered apparel sheet. It contains printed English and Korean labels outside two garment silhouettes, a ruled measurement table, a red exterior arrow, garment seams/buttons/stitches, and one small in-figure red mark reserved for manual correction. Tests use no user photographs, network inference, API keys, or uploaded data.

`tests/ai-integration.test.ts` checks the model manifest fields and SHA-256 against the cached ONNX file. It compiles `src/main/ai.ts` as the same Node CommonJS format used by the desktop build, invokes the real CPU inference, requires positive detector coverage over both printed labels, and runs the resulting mask through `autoCleanDraft`. It verifies text/table/arrow removal, preservation of garment linework and details, preservation of the in-figure mark for a manual edit, and an unchanged original basis. `tests/ai-manager.test.ts` covers dimensions and buffer validation, UUID scoping, bounded single-job behavior, hard cancellation, timeout, worker failure, and invalid output masks.

The installed-app E2E in `e2e/desktop.spec.ts` follows the requested order: import and view the raw image, start automatic cleanup explicitly, then make and undo/redo a manual correction. It checks the saved working PNG for both language regions, the table and arrow, and the garment details; exports a PNG; verifies the imported source hash remains unchanged; then relaunches and opens the recent project, asserting the saved revision remains and automatic cleanup stays idle. This exercises the real preload bridge and native worker without mocking detection.

Checks completed in the local development environment:

- `npm run build` — passed; model preparation verified the pinned SHA-256 and copied the artifact into the app build.
- `npm run typecheck` — passed.
- Scoped ESLint for the owned fixture, integration test, and E2E — passed.
- `npm exec vitest run tests/ai.test.ts tests/ai-manager.test.ts tests/ai-integration.test.ts tests/automatic.test.ts` — 20/20 passed.
- `npm exec playwright test -- --list` — discovered all three desktop E2E tests.
- Targeted local Electron E2E launch — blocked before the first window: Electron exited with `SIGABRT` in this macOS sandbox. No assertions ran, so this is not recorded as an app pass or an app failure.

The Windows installed-app CI run remains the release evidence for native worker loading, model packaging, the full manual edit/export/reopen path, and Windows behavior. The fixture proves this detector pipeline on synthetic printed text and vector garments only; it does not establish accuracy on real user photographs or all garment styles.
