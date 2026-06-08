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

### From other computers on your network

`start.sh` binds to all interfaces, so any device on the same Wi-Fi/LAN can
reach the clock. On startup it prints the address to use, e.g.:

```
  Other computers: http://192.168.0.82:8473   (same Wi-Fi/LAN)
```

Open that URL on the other machine. If it doesn't connect, allow inbound TCP
on port **8473** through this computer's firewall (e.g. `sudo ufw allow 8473/tcp`),
and make sure both devices are on the same network.

If `start.sh` isn't executable yet:

```bash
chmod +x start.sh && ./start.sh
```

It uses only Python 3's built-in `http.server` — no dependencies.

## Controls

Click the **⚙ gear** (top-right) to open the settings drawer:

| Setting | Notes |
| --- | --- |
| **Background** | `Light` (white), `Dark`, or `Auto` — Auto simulates day/night sky + ambient light from the (simulated) time, with drifting clouds, a snow-capped mountain range, and stars that come out at night. |
| **Cloud density** | Slider (0–100%) for how many clouds drift across the Auto sky (20% = the default four). |
| **Chime melody** | `Westminster`, `Whittington`, `St. Michael`, or `Silent` — the triple-chime selector. |
| **Chime tempo** | Slider (50–150%) for how fast the notes play within a phrase. |
| **Pause between phrases** | Slider (0–3 s, default **1.0 s**) for the silence before each next phrase. Absolute — not affected by tempo. |
| **Pause between hour strikes** | Slider (0.5–3 s, default **1.5 s**) for the spacing of the hour-count gong. |
| **Mute / Volume** | Master sound controls. |
| **Auto night silence** | Suppresses chimes 10:15 PM – 7:15 AM, like the real movement. |
| **Ticking sound** | Per-second escapement tick/tock (ticks 24/7; night silence only affects chimes). |
| **Show seconds hand** | Toggle the seconds hand. |
| **Time speed** | `1× / 60× / 300× / 3600×` for testing, plus "jump to time" and "reset to now". |
| **Test chime & strike** | Plays the current melody followed by a 3-count strike. |

Settings persist via `localStorage`.

### Chime behavior

- The clock chimes on every quarter hour and strikes the hour count at the top of the hour.
- All three tunes — **Westminster, Whittington, St. Michael** — are played **note-by-note from
  real CC0 tubular-bell samples** (`assets/audio/bells/`, FreePats / Versilian — see
  [`assets/audio/bells/CREDITS.md`](assets/audio/bells/CREDITS.md)). Each note is a one-shot that
  rings its **full natural decay** and overlaps the next, so chimes fade out naturally instead of
  being cut off. Notes are pitched by detuning the nearest sampled pitch (always ≤1 semitone).
- The **hour strike** is the public-domain Kieninger gong from `assets/audio/westminster.mp3`
  (Wikimedia Commons), which rings out naturally — authentically a different timbre from the
  chime bells.
- The per-second **tick** is synthesized, so it stays in sync with the visible tick and the
  fast-forward speed.
- Above **4× speed**, chime *audio* is suppressed to avoid overlap — the dial still flashes
  so you can see the chime fire while fast-forwarding.

> Browsers require a user gesture before audio can play. The first click anywhere in the
> settings drawer (or the Test button) unlocks sound.

### Weights & winding (8-day movement)

Three weights hang on pulleys in the trunk, one per train:

- **Centre = time** (going train) — descends continuously; a full wind lasts **8 days**.
- **Left = strike** (hour gong) — descends each hour, proportional to the strike count.
- **Right = chime** — descends each quarter, proportional to the chime length.

The dial has three **winding arbors** at the 9, 6 and 3 o'clock positions, each
directly above its weight (9 = strike, 6 = time, 3 = chime). **Press and hold an
arbor** to wind that weight up — it rises while held and stops the moment you let go
(like cranking a real winding key), until it reaches the top. While winding,
the tick plays 4×/second as a ratchet sound. To watch the weights run down quickly, bump the
**Time speed** in settings — the strike/chime weights drop on each chime/strike even
while fast-forwarding (and even when the sound is muted or night-silenced, since the
mechanism still trips).

### Moon dial

Like a real lunar dial, a moon transits the night-sky arch between **two earth globes**.
Position alone encodes the phase: the moon rises behind the right globe (waxing crescent),
is fully clear at the top of the arch (full moon), then sets behind the left globe (waning
crescent). The phase tracks the real synodic month for the simulated date.

### Deep-link / testing URL params

Append to the URL to preset state (handy for testing):

- `?theme=light|dark|auto`
- `?clouds=0..100` — cloud density percent (20 = the default four clouds)
- `?chime=westminster|whittington|stmichael|silent`
- `?speed=1|60|300|3600`
- `?tempo=50..150` — chime tempo percent (note speed within a phrase)
- `?gap=0..3` — seconds of silence between chime phrases (default `1.0`)
- `?strikegap=0.5..3` — seconds between hour strikes (default `1.5`)
- `?time=HH:MM` — jump the clock to a time
- `?moon=0..1` — pin the moon phase (`0`/`1` = new, `0.5` = full)

Example: `http://localhost:8473/?theme=auto&speed=3600&moon=0.5`

## Files

```
index.html      markup: cabinet, dial, moon arch, pendulum, weights, settings drawer
styles.css      all visuals + theme variables + animations
js/clock.js     dial build, render loop, hands, moon phase, auto day/night sky, viewport scaling
js/audio.js     sample-based bell chimes + recorded strike + synth tick (Web Audio)
js/main.js      settings, chime scheduling, night silence, persistence, UI wiring
assets/audio/   bells/*.mp3 (CC0 tubular bells) + westminster.mp3 (strike) + CREDITS
start.sh        Python static server on port 8473
```
