# GestMedia 1.1 — gesture-controlled media for the whole browser

A Chrome (MV3) extension that watches your webcam with **MediaPipe Hands
(HandLandmarker)** and turns hand gestures into media controls for **YouTube,
JioCinema / JioHotstar, Hotstar** — and, thanks to a universal fallback layer,
basically **any page with a `<video>` or `<audio>` element** (Netflix, Prime
Video, Spotify Web, SoundCloud, Apple Music, JioSaavn, Coursera, a random blog
with an embedded player, …).

Everything runs **on-device**. No frames, no landmarks, no telemetry ever leave
your machine.

| Gesture | Action |
| --- | --- |
| 👊 Fist | Play |
| ✋ Open palm | Pause |
| 👉 Point right | Next track / episode (seek +10 s if the site has no playlist) |
| 👈 Point left | Previous track / episode (seek −10 s fallback) |
| 👍 Thumbs up | Volume up (repeats while held) |
| 👎 Thumbs down | Volume down (repeats while held) |

Every mapping is remappable, and individual gestures can be switched off in the
options page.

---

## Install (developer mode)

```bash
npm install          # also vendors the MediaPipe runtime into ./vendor
npm run setup        # + downloads hand_landmarker.task (~7 MB) for offline use
npm test             # unit tests for the classifier + manifest sanity checks
```

Then:

```bash
npm run doctor   # sanity-checks the folder and prints the exact path to load
```

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select **the repository folder itself**
   (`gest-media-1.1/`) — `manifest.json` lives right inside it, so there is no
   sub-folder to hunt for.
4. The options page opens on first install → click **Grant camera access**
5. Open the toolbar popup (or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>)
   and flip the switch on

> `vendor/` is git-ignored because it is ~30 MB of WebAssembly.
> `npm run setup` recreates it at any time. If the model download is blocked,
> the extension downloads it once at first use and caches it in IndexedDB —
> MV3-safe, because only *data* is fetched, never code.

Package for the Web Store with `npm run package` → `dist/gestmedia-1.1.0.zip`.

---

## How it works

```
┌────────────────────┐   gesture   ┌───────────────────┐   command   ┌──────────────────────┐
│ offscreen document │────────────▶│  service worker   │────────────▶│  content script      │
│ webcam + MediaPipe │             │ media-frame router│             │ per-frame controller │
│ + gesture debounce │◀────────────│ suspend / resume  │◀────────────│ media state reports  │
└────────────────────┘             └───────────────────┘             └──────────────────────┘
```

* **One camera, one model, for the whole browser.** Detection lives in a single
  [offscreen document](offscreen/detector.js) instead of one detector
  per tab, so ten open YouTube tabs still cost one inference loop.
* **The service worker** ([`background/service-worker.js`](background/service-worker.js))
  keeps a registry of every frame that reports playable media, scores them
  (playing > audible > active tab > biggest video) and sends the command to
  exactly one frame — so a gesture never double-fires across tabs or iframes.
* **The content script** ([`content/controller.js`](content/controller.js))
  runs in *all frames of all sites*. It finds media (including inside open
  shadow roots), applies a site adapter when there is one, and falls back to
  `HTMLMediaElement` APIs, then to accessible-name button matching, then to
  seeking. It also draws the confirmation toast.
* **Gesture logic** ([`lib/gestures.js`](lib/gestures.js)) is pure,
  browser-free JavaScript: scale-invariant finger-extension scoring, joint
  angles, and a `GestureStabilizer` that de-bounces the stream (N consecutive
  frames, per-gesture cooldown, "one-shot vs. repeatable" handling). It is
  covered by unit tests with synthetic landmark fixtures.
  👊/👍/👎 are decided by one shared rule rather than competing scores: all
  three are "four fingers curled", so the thumb must both point vertically and
  clear the knuckle line by ≥30 % of the hand size before it reads as a thumbs
  signal — otherwise it is a fist. Any two gestures scoring within 0.08 of each
  other are reported as "no gesture" instead of a coin flip.

### Site adapters

YouTube · Hotstar / JioHotstar · JioCinema (Voot) · Netflix · Prime Video ·
Spotify · SoundCloud · Apple Music · JioSaavn / Gaana / Wynk · Vimeo ·
Dailymotion — plus the generic fallback chain that covers everything else.

Adding one is ~6 lines in the `ADAPTERS` array in `content/controller.js`.

---

## Built for low-end devices

The default preset is **Battery saver**, and every knob is exposed in options:

| Technique | Effect |
| --- | --- |
| Single offscreen detector | 1 camera + 1 model for the entire browser, not per tab |
| `numHands: 1`, float16 lite model | smallest useful MediaPipe graph |
| 320×240 capture, **160 px inference frames** | ~4× less pixel work than a 640×480 pipeline |
| 6 fps active loop (12 / 24 in higher presets) | inference is throttled, not free-running |
| Adaptive idle throttle | drops to 2 fps when no hand has been seen for 4 s |
| Self-tuning cadence | if inference takes longer than the budget, the loop slows instead of queueing |
| Media-aware suspension | camera is *released* (light off) whenever no tab has media |
| Worker-driven clock | hidden-page timer throttling can't stall the loop |
| CPU delegate by default, GPU opt-in | avoids GPU-driver stalls on cheap integrated chips; falls back automatically if the chosen delegate fails |
| No-SIMD wasm shipped alongside SIMD | still runs on old CPUs |

Typical cost on a low-end laptop: ~10–18 ms per inference at 6 fps ≈ a few
percent of one core, and 0 % while nothing is playing.

---

## Options & popup

* **Popup** — on/off switch, live gesture readout with fps + inference time,
  performance preset, "camera only while media is on screen", mirror toggle,
  per-site disable.
* **Options** — camera permission helper, **camera picker** (auto-select prefers
  the built-in webcam and skips phone/virtual cameras such as Windows "Link to
  Windows", OBS, DroidCam, Iriun), a **live preview with the hand
  skeleton drawn** and the gesture it would fire (great for checking lighting),
  full gesture→action mapping table, cooldown / repeat-rate / volume-step /
  seek-fallback sliders, and the disabled-sites list.

Keyboard shortcut: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> toggles
everything off and on.

---

## Privacy

* Camera frames are drawn into an offscreen canvas, run through the model and
  discarded — never stored, never sent anywhere.
* The only network request the extension can make is the one-time model
  download from Google's model host, and only when the model was not bundled by
  `npm run setup`.
* `<all_urls>` is required because "any media app in the browser" is the point;
  use the per-site disable list to opt sites out.

---

## Repository layout

The repository root **is** the unpacked extension, so Chrome can load it
directly:

```
manifest.json                    ← Chrome looks for this in the folder you pick
background/service-worker.js     routing, settings, offscreen lifecycle
offscreen/                       webcam + MediaPipe + gesture debounce + ticker worker
content/controller.js            universal media controller + site adapters + HUD
popup/                           toolbar UI
options/                         settings + live gesture preview
lib/                             constants, gesture classifier, camera picker, model loader
vendor/                          generated by `npm run setup` (git-ignored)

scripts/setup.mjs                vendors MediaPipe + fetches the model
scripts/doctor.mjs               pre-flight check for "Load unpacked"
scripts/package.mjs              builds dist/gestmedia-<version>.zip (extension files only)
test/                            classifier unit tests + manifest/asset checks
```

Chrome ignores the development files (`node_modules/`, `scripts/`, `test/`,
`package.json`) when the folder is loaded unpacked; `npm run package` strips
them for a Web Store upload.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| *"Manifest file is missing or unreadable"* | Load the repository folder itself — run `npm run doctor` and pick the exact path it prints |
| Chrome opens your **phone** as the webcam (Windows "Link to Windows" / Phone Link, a device named like `V2545`) | Options → **Use this PC's built-in camera** (one click). GestMedia never requests the browser default device, so the phone is only used if it is your only camera. To stop it browser-wide: `chrome://settings/content/camera` → default camera = integrated webcam; Windows Settings → Bluetooth & devices → Mobile devices → turn off "Use your phone as a connected camera" |
| Popup says *Camera access needed* | Options → **Grant camera access**; if blocked, `chrome://settings/content/camera` |
| Nothing happens on a site | Check the popup shows "N media frames detected"; some DRM players hide media in closed shadow DOM |
| 👉/👈 seeks instead of skipping | That site exposes no next/previous control — expected fallback |
| Gestures fire too eagerly | Raise **Cooldown between actions**, or switch preset to Balanced for steadier tracking |
| 👊 read as 👍/👎 (or the reverse) | Fixed in 1.1.3 — the thumb must clear the knuckle line by 30 % of the hand's size before it counts as a thumbs signal. Use the Options preview: the badge shows the live `thumb` value (≈0 = fist, > 0.3 = up, < −0.3 = down) |
| High CPU | Keep the **Battery saver** preset and leave "camera only while media is on screen" enabled |

MIT licensed.
