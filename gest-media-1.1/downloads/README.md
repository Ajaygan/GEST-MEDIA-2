# Prebuilt download

`gestmedia-1.1.3.zip` is the packaged extension (manifest + all code + the
MediaPipe WebAssembly runtime). Nothing to build.

1. Download and **unzip** it.
2. `chrome://extensions` → **Developer mode** → **Load unpacked**
3. Select the unzipped folder (the one containing `manifest.json`).

The 7 MB `hand_landmarker.task` model is not included; the extension downloads
it once on first use and caches it. For a fully offline bundle, clone the repo
and run `npm install && npm run setup && npm run package`.

Rebuild this file with `npm run package` and copy `dist/gestmedia-<v>.zip` here.
