# UI handoff

## 0.2 automatic draft

New-photo creation alone starts auto-clean through the existing Worker. Saved-project opening stays idle. Changed results use one history commit; no-op/cancel leaves the saved version unchanged. The edit panel foregrounds direct correction and result saving; background fill/tone and manual ChatGPT remain optional. DOM checks cover these states, alpha compositing, masks, affine candidate overlay, existing editing and export.

The scalar canvas loop avoids per-pixel objects/arrays. A warmed 12-frame jsdom/Canvas-mock comparison at 1200×800 with a 5000×4000 image measured median DPR1 16.2→7.9ms and DPR2 59→30.2ms. This excludes actual GPU/Windows interaction and is not a user-PC performance guarantee. The temporary benchmark was removed; pixel-output regression checks remain.

Below is the earlier manual-editor handoff.

The renderer is a vanilla TypeScript and Canvas2D Korean clothing-drafting workbench. It uses the `window.desktop` bridge from shared types, a separate stylesheet, and the engine worker for full-image operations. The interface includes file open/drop and recent projects, crop/rotation, delete/protect/unselect/restore/lasso tools, local fill/tone previews, autosave and retry, request preparation and manual ChatGPT handoff, candidate comparison/alignment/application, stale-basis fork, project save-as, and full-resolution PNG export. Candidate readiness displays request/current work-version differences while gating application only on basis-version mismatch. Transparency previews composite over white; side-by-side review shares zoom and pan.

Save As writes the current in-memory snapshot to a newly chosen project destination even when the original destination has failed. Autosave is paused while the picker is active and resumes against the original project if the picker is cancelled or the copy fails. Successful Save As switches to the clean copy and clears the old destination error. Project opens fetch recent projects before asking to replace the current one; edit revision, project identity, and a project epoch guard delayed bridge and worker results so edits made during an open, fork, or save operation are not discarded. Worker results reuse the existing immutable base buffer when the basis is unchanged, and unchanged work versions do not create empty undo/save entries.

Review compares the immutable saved working basis (`snapshot.base`) against the candidate; the current working image remains the destination for an acknowledged, selected-area apply. The canvas labels both sources. Recovered projects show a visible “복구 확인 필요” badge and a generic notice to inspect the last normal work and project files.

At narrower logical window sizes, only the header’s project-save shortcut is hidden; inspector actions and the 100% zoom control stay available. The canvas toolbar wraps below 930 px, and the 460 px minimum height leaves the tool rail and inspector scrollable in a compact work area.

The TDD RED checkpoint exposed the work-version gating bug: a matching project/request/base with request work version 4 and current work version 5 returned `stale-basis` instead of `ready`. After removing that gate and preserving the versions for display, `npm test -- tests/ui-state.test.ts` passed all five state-helper tests.

Validation completed:

- `npm test -- tests/ui-state.test.ts` — 5 tests passed.
- `npm test -- tests/renderer.test.ts` — passed; covers open, selection/fill, undo/redo, request creation, candidate apply, PNG export, Save As after an original-destination write failure, and a delayed open while a tone edit is committed.
- Renderer-only TypeScript check and ESLint — passed.
- `npm run typecheck` — passed.
- `npx eslint src/renderer/main.ts src/renderer/state.ts tests/ui-state.test.ts` — passed.
- 초기 브라우저 하네스 실행 — unable to start its Vite preview server in this sandbox (`listen EPERM 127.0.0.1:4173`); browser E2E still needs a runnable desktop test environment.

The renderer has not been visually reviewed in a running Electron window here. Windows DPI behavior and 20 MP responsiveness/autosave timing remain for the real-device acceptance pass.
