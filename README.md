# Grandfather Clock

A self-contained, vanilla HTML/CSS/JS recreation of a Howard Miller triple-chime
grandfather clock (circa 2004). The whole clock — case, dial, moon-phase arch,
swinging pendulum, and hanging weights — is drawn in CSS; chimes are synthesized
live with the Web Audio API. No frameworks, no build step, no image or audio files.

Designed for a **portrait 1080 × 1920** monitor, but it scales to fit any window.

## Run it

```bash
./start.sh
```

Then open <http://localhost:8473>. (Port **8473** is fixed in `start.sh`.)

If `start.sh` isn't executable yet:

```bash
chmod +x start.sh && ./start.sh
```

It uses only Python 3's built-in `http.server` — no dependencies.

## Controls

Click the **⚙ gear** (top-right) to open the settings drawer:

| Setting | Notes |
| --- | --- |
| **Background** | `Light` (white), `Dark`, or `Auto` — Auto simulates day/night sky + ambient light from the (simulated) time. |
| **Chime melody** | `Westminster`, `Whittington`, `St. Michael`, or `Silent` — the triple-chime selector. |
| **Mute / Volume** | Master sound controls. |
| **Auto night silence** | Suppresses chimes 10:15 PM – 7:15 AM, like the real movement. |
| **Ticking sound** | Per-second escapement tick/tock (ticks 24/7; night silence only affects chimes). |
| **Show seconds hand** | Toggle the seconds hand. |
| **Time speed** | `1× / 60× / 300× / 3600×` for testing, plus "jump to time" and "reset to now". |
| **Test chime & strike** | Plays the current melody followed by a 3-count strike. |

Settings persist via `localStorage`.

### Chime behavior

- The clock chimes on every quarter hour and strikes the hour count at the top of the hour.
- **Westminster** plays a **real public-domain recording** of a Kieninger clockwork
  (`assets/audio/westminster.mp3`, from Wikimedia Commons — see
  [`assets/audio/CREDITS.md`](assets/audio/CREDITS.md)). The recording is the full hour
  chime + strike; it's decoded once and played back sliced into the right number of phrases
  per quarter, with the strike segment repeated for the hour count. (The recording only
  contains the hour sequence, so the shorter quarters are sliced from it rather than being
  each quarter's distinct canonical permutation.)
- **Whittington** and **St. Michael** remain **synthesized** — no freely-licensed
  recordings of these chimes were available — so they're labeled *(synth)* in the UI.
- The per-second **tick** is also synthesized, so it stays in sync with the visible tick
  and the fast-forward speed.
- Above **4× speed**, chime *audio* is suppressed to avoid overlap — the dial still flashes
  so you can see the chime fire while fast-forwarding.

> Browsers require a user gesture before audio can play. The first click anywhere in the
> settings drawer (or the Test button) unlocks sound.

## Files

```
index.html      markup: cabinet, dial, moon arch, pendulum, weights, settings drawer
styles.css      all visuals + theme variables + animations
js/clock.js     dial build, render loop, hands, moon phase, auto day/night sky, viewport scaling
js/audio.js     real Westminster playback + Web Audio synthesis (other chimes, strike, tick)
js/main.js      settings, chime scheduling, night silence, persistence, UI wiring
assets/audio/   westminster.mp3 (public-domain recording) + CREDITS.md
start.sh        Python static server on port 8473
```
