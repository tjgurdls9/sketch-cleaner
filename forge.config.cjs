const { readdir, rm } = require('node:fs/promises');
const path = require('node:path');

module.exports = {
  packagerConfig: {
    asar: { unpack: '{**/node_modules/@img/**,**/node_modules/onnxruntime-node/**}' },
    extraResource: ['dist/models'],
    afterPrune: [async ({ buildPath, platform, arch }) => {
      const binaries = path.join(buildPath, 'node_modules/onnxruntime-node/bin/napi-v6');
      for (const entry of await readdir(binaries, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== platform) await rm(path.join(binaries, entry.name), { recursive: true });
      }
      const target = path.join(binaries, platform);
      for (const entry of await readdir(target, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== arch) await rm(path.join(target, entry.name), { recursive: true });
      }
    }],
    name: 'Sketch Cleaner',
    executableName: 'SketchCleaner',
    appBundleId: 'com.sketchcleaner.desktop',
    appCopyright: 'Sketch Cleaner',
    ignore: [/^\/(src|tests|e2e|plans|docs|scripts|models|artifacts|projects|\.scratch|\.github|coverage|test-results|playwright-report)(\/|$)/, /^\/\.env(?:\.|$)/, /^\/dist\/models(\/|$)/, /^\/:memory:\.ses$/, /\.map$/],
  },
  makers: [{ name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: {
    name: 'SketchCleanerDesktop', setupExe: `SketchCleaner-${require('./package.json').version}-Setup.exe`,
    description: '의류 도해 정리', authors: 'Sketch Cleaner',
  } }],
  plugins: [{ name: '@electron-forge/plugin-auto-unpack-natives', config: {} }],
};
