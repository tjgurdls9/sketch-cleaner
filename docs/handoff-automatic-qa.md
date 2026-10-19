# Automatic cleanup desktop QA handoff

The deterministic Sharp fixture is a 480 × 400 synthetic garment sheet with two curved shirt outlines, construction seams, stitch detail, button dots, subtle paper shadows, an exterior red arrow, an exterior glyph, and a ruled table. It contains no user photo or remote asset. The fixture exposes fixed sample points so tests can distinguish removed annotations from garment details.

The desktop flow imports this fixture into the packaged Electron app, waits for a completed cleanup, and reads the saved working PNG and masks. It checks that the arrow, glyph, and table become white while an interior seam and detached button detail remain dark. It then undoes and redoes the single automatic edit and checks the original and cleaned arrow pixels on disk. A small delete brush stroke and the visible “칠한 곳 지우기” action exercise direct correction; undo and redo each verify the working pixel persisted after an explicit project save. A separate protect stroke checks that a seam survives correction. The flow exports a PNG, verifies output pixels and original-file SHA-256, restarts the installed app, opens the project from Recent, and confirms that persisted edits remain and automatic cleanup stays idle.

The existing no-anchor test still imports a solid image and expects an unchanged result. The narrow-window test checks the visible edit/fill/export actions and reveals advanced color fill only after expanding that section.

## Checks completed here

- `npm run test:e2e -- --list` — both desktop tests discovered successfully.
- Direct `autoCleanDraft` probe with the fixture — arrow, glyph, and table samples became `[255,255,255,255]` with delete coverage; seam and button-detail samples remained dark with no delete coverage; the result advanced to work version 1.
- The 20 MP project-store profile recorded during the storage sprint: create 573 ms wall time / 748 ms CPU; mask-only save 1,122 ms wall time / 1,467 ms CPU; peak RSS about 1.8 GB on the development Mac. This direct store measurement excludes Electron startup, renderer IPC serialization, Windows hardware, and UI rendering. Safety validation and full revision readback remain enabled.

The E2E code was not run in a GUI on the development Mac because Electron fails before app code loads in that environment. The packaged Windows E2E run remains the release check for the full automatic → manual correction → undo/redo → export → restart/reopen path. Real garment-photo cleanup quality, Windows 11 device performance, and DPI behavior remain unverified by this synthetic fixture.
