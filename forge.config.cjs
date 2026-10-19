module.exports = {
  packagerConfig: {
    asar: true,
    name: 'Sketch Cleaner',
    executableName: 'SketchCleaner',
    appBundleId: 'com.sketchcleaner.desktop',
    appCopyright: 'Sketch Cleaner',
    ignore: [/^\/(src|tests|plans|docs|scripts|\.github|coverage|test-results)(\/|$)/, /\.map$/],
  },
  makers: [{ name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: {
    name: 'SketchCleaner', setupExe: 'SketchCleaner-0.1.0-Setup.exe',
    description: '의류 도해 정리', authors: 'Sketch Cleaner',
  } }],
  plugins: [{ name: '@electron-forge/plugin-auto-unpack-natives', config: {} }],
};
