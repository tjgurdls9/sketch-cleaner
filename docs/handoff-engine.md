# Pixel engine handoff

The pure pixel operations live in `src/core/engine.ts`; the browser worker entry and request/response types are in `src/core/pixel-worker.ts` and `src/core/worker-protocol.ts`.

`createSnapshot` validates the dimensions and RGBA buffer, clones the starting image into B and W, and creates zeroed byte masks. `paintStroke`, `restoreStroke`, `selectLasso`, `fillSelection`, `adjustSelection`, and `applyCandidate` return new snapshots. UI code should treat input snapshots as immutable and replace its current snapshot with the returned value. Mask drawing uses strength and edge coverage in D; fully protected brush pixels set P to 255 and restore W from B. Restore strokes blend W toward B without modifying either mask. Unselect reduces both D and P. Lasso edits D while retaining P.

For local edits and candidate application, the effective amount is `D / 255 × (1 − P / 255)`. Zero-amount pixels keep their W RGBA bytes exactly. Fully protected pixels are restored from B. Candidate transforms map candidate coordinates into the base image; sampling uses the inverse affine transform and bilinear interpolation. Samples outside the candidate are left alone. Fill and brightness/contrast affect selected pixels only; adjustment leaves alpha unchanged.

`rotateBasis` and `cropBasis` transform B and W separately, then clear both masks. Fine rotation expands the canvas and fills uncovered pixels with opaque white; positive rotation is clockwise in image coordinates. `imageToView` and `viewToImage` convert coordinates using zoom and pan. `createGuide` returns a separate red-delete/blue-protect overlay and does not mutate W.

The history helpers are `createHistory`, `commitHistory`, `undoHistory`, `redoHistory`, and `historySnapshot`. Image buffers are shared between states where safe, and the history budget counts unique backing buffers with a 512 MiB limit. When older states are discarded, `History.truncated` remains true so the UI can tell the user that the oldest undo steps are no longer available. Undo and redo assign fresh `workVersion` values.

`PixelJob` supports `guide`, `candidate`, `stroke`, `restore`, `lasso`, `rotate`, `crop`, `fill`, `adjust`, and `auto-clean`. `PixelJobRequest` uses a string ID; responses are `progress`, `result`, or a safe Korean `error`. Long jobs report progress by rows or stroke work units. Result buffers are transferred back to the renderer so the worker does not create another full copy. Input snapshots still use structured cloning, so the renderer's buffers remain intact and large inputs still have a measurable peak-memory cost. Cancellation is by terminating the worker; the renderer owns worker lifecycle and cancellation.

## 0.2 automatic cleanup draft

`auto-clean` in `src/core/automatic.ts` is a deterministic offline heuristic, not a learned clothing detector. It analyzes at most 1 MP of coarse ink/shadow cells, anchors on confident garment-like connected components (up to four), and removes small exterior neutral marks, ruled grids, exterior red marks, and neutral paper shadows. It keeps disconnected details and colored/red pixels inside the padded figure regions. If it finds no confident figure, it returns the identical snapshot. A changed draft leaves B untouched, merges new cleanup coverage into D, and increments `workVersion` once. Full protection restores exact B bytes; soft protection scales only newly added auto coverage by `1 − P / 255`.

Pre-existing D is deliberately not re-applied to W during cleanup. The output blend uses only newly added auto-mask coverage, so old manual deletion selections on retained pixels are not whitened again, D=255 pixels are idempotent across repeated drafts, and manual corrections remain visible. This also means the automatic pass does not reprocess pixels that were already selected in D before the pass. Red ink inside a kept figure remains for manual review, including an annotation that overlaps the garment.

## Verification

- The initial engine tests were run red by the main agent before implementation; the missing engine module failed as expected at checkpoint `f193f72`.
- `npm run test:coverage -- tests/core-engine.test.ts`: 19 tests passed. Core coverage is 90.13% statements, 81.26% branches, 96% functions, and 97% lines.
- `npm run typecheck`: passed.
- Targeted ESLint for `src/core/engine.ts`, `src/core/worker-protocol.ts`, `src/core/pixel-worker.ts`, and `tests/core-engine.test.ts`: passed.
- A synthetic 1024×1024 image with a 500-point diagonal stroke is asserted under 2 seconds. The test also verifies stroke strength is applied once despite overlapping segments.
- Deterministic randomized RGBA tests verify exact W-byte preservation where D is zero and exact B-byte restoration where P is 255. Other tests cover soft brush bounds, partial RGBA blending, invalid dimensions, crop/rotation, coordinate round-trips, history versions, worker dispatch, and lasso progress.
- `npm test`: 57 tests across six files passed, including six automatic-cleanup cases for two figures, retained interior detail, exterior text/table/red/shadow cleanup, antialiasing, protection, old D, idempotence, no-anchor safety, immutability, and a 20 MP blank scan. `npm run typecheck` and `npm run lint` passed.
- A local Node run on 5000×4000 synthetic inputs took 67.6 ms with an unchanged blank page (+8.5 MiB RSS), and 235.6 ms with a confident synthetic figure and exterior mark (+144.1 MiB RSS, changed output). These measurements are local synthetic observations only.

## Limits

The timing and RSS observations are local synthetic measurements, not a Windows performance claim. The heuristic has not been evaluated on real garment pages; it can miss faint/broken outlines and deliberately leaves ambiguous dark linework and in-figure red annotations for manual review. No 20–25 MP Windows machine, DPI matrix, real-image sample set, or long-session memory profile was available for this handoff. A full basis transform allocates new B/W buffers plus masks while the old snapshot remains available for undo. The history budget limits retained history buffers, but worker input/output transfer cost and peak memory during large transforms still need measurement on target PCs. Fine rotation resamples pixels and therefore does not promise exact source bytes except for the no-op angle; uncovered canvas is opaque white by design.
