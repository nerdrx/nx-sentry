<div align="center">
  <img src="assets/icon.svg" width="96" alt="" />
  <h1>NX Sentry</h1>
  <p><b>Draw a rectangle on your screen. Get an alarm when something moves inside it.</b></p>
</div>

---

Some things are worth watching but not worth staring at: a door in a camera
feed, a render that finally finishes, a queue that starts moving, a chat window
in a game you alt-tabbed away from. NX Sentry watches the rectangle for you and
makes a noise when the pixels in it change.

![NX Sentry watching a region](docs/screenshots/sentry.png)

*Shown running against the built-in mock desktop, the synthetic source the test
harness uses.*

## What it does

- **Watch any part of any screen or window.** Pick a source, drag a rectangle
  over the preview, done. The rest of the screen is ignored entirely.
- **Sound an alarm when it moves.** Four synthesised alarms — siren, beep,
  pulse, chime — with a volume you control, plus an optional desktop
  notification and a taskbar flash.
- **Not scream at every flicker.** A grace period after arming, a
  frames-in-a-row requirement before it fires, and a quiet time after each
  alarm, so a compression artefact or your own mouse leaving the room does not
  set it off.
- **Stay out of the way.** Close the window and it keeps watching from the
  tray. The tray icon and menu carry the state.
- **Show its work.** A live meter of how much of the area is moving against the
  threshold that would trip it, a marker on the preview showing what moved, and
  a timestamped log of every trigger.

## Install

Grab the AppImage from [Releases](https://github.com/nerdrx/nx-sentry/releases),
or let [NX Hub](https://github.com/nerdrx/nx-hub) install and update it with the
rest of the NX family.

From source:

```bash
git clone https://github.com/nerdrx/nx-sentry && cd nx-sentry && npm install && npm start
```

## Using it

1. **Choose what to watch** — a screen or a single window. On Wayland your
   desktop asks again, in its own dialog; that second dialog is the one that
   actually grants the capture.
2. **Drag a rectangle** on the preview. Drag inside it to move it, grab a corner
   to resize, or use *Whole screen* / *Centre third*.
3. **Start watching.** You get a grace period (3 seconds by default) to get your
   hands off the mouse, then the sentry is live.

`Space` arms and disarms, `Esc` silences a sounding alarm, and the tray menu can
do both without opening the window.

### Tuning it

| Setting | What it changes |
| --- | --- |
| **Sensitivity** | Both thresholds at once: how much a pixel's brightness must change, and how much of the area must change with it. At 0 it wants a person walking past; at 100 a cursor twitch will do it. |
| **Frames before it fires** | How many consecutive samples must be over the threshold. Two is enough to reject codec noise; raise it if a video is playing next to the area you care about. |
| **Grace period** | Motion during this window after arming is ignored — it is you leaving. |
| **Quiet time** | How long the sentry stays silent after an alarm before it can fire again. |
| **Samples per second** | 8/s is plenty and costs almost nothing. Raise it for fast motion, lower it on a laptop battery. |

If your own mouse pointer keeps tripping it, the capture includes the cursor:
either lower the sensitivity, or draw the area somewhere the pointer does not go.

## How the detection works

Each sample draws **only the watched rectangle** into a small offscreen canvas
(192px on the long edge), converts it to grayscale, and compares it with the
previous sample. A pixel counts as moving when its brightness changed by more
than the sensitivity's threshold; the fraction of moving pixels is the one
number the whole UI is a view of. When that fraction stays over the area
threshold for N consecutive samples, the alarm fires.

That is the entire algorithm, and it lives in
[`src/renderer/detector.js`](src/renderer/detector.js) as pure functions over
typed arrays — no DOM, no canvas — so `npm test` exercises exactly the code that
runs in the app.

Nothing leaves the machine. There is no recording, no upload, no network code in
this app at all; frames are compared and thrown away.

## Platform notes

- **Linux / Wayland** — capture goes through `xdg-desktop-portal` and PipeWire,
  so the compositor decides what NX Sentry may see and can revoke it at any
  time. If the share ends, the sentry disarms itself and says so rather than
  pretending to watch a dead stream.
- **Linux / X11 and Windows** — the same code path via Chromium's desktop
  capturer; no portal dialog on X11.
- Global hotkeys are deliberately not used: they do not work on Wayland, and a
  shortcut that silently fails is worse than none. The tray menu covers it.

## Settings

Everything is stored in `~/.config/nx-sentry/settings.json` (override the
directory with `NX_SENTRY_CONFIG_DIR`, which is what the tests do so they can
never touch a real install's settings).

## Development

```bash
npm install      # electron 40
npm test         # detector + settings, headless
npm start        # run it
npm run headless # run inside a nested headless compositor and screenshot it
```

Two environment switches make the app testable without a real screen:

- `NX_SENTRY_MOCK=1` — replace the capture with a synthetic desktop that has
  something moving in it on a 7-second cycle.
- `NX_SENTRY_AUTOARM=1` — arm as soon as that mock source starts, so a headless
  screenshot can catch the live states.

```bash
NX_SENTRY_MOCK=1 NX_SENTRY_AUTOARM=1 npm run headless
```

## Design

NX Sentry follows the [NX design language](https://github.com/nerdrx/nx-hub/blob/main/docs/DESIGN.md)
— liquid glass on deep space. Tokens are copied verbatim into
[`src/renderer/tokens.css`](src/renderer/tokens.css); structural surfaces are
opaque elevation steps, real blur is spent only on the header, the source sheet
and the alarm banner, and the card sheen tracks the pointer rather than sweeping
on hover. Violet leads, cyan is the live motion value inside the meter, amber
means "something moved", and red is kept for genuine failures.

## License

MIT — see [LICENSE](LICENSE).
