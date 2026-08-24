# WolfBox Player

A cross-platform player for the [WolfBox Player 1](https://wolfbox.com/pages/wolfbox-player-1)
dash cam. Runs on a Chromebook, Linux, Mac or Windows machine: plug in the SD card,
point the app at it, and get trips, synced front/rear playback, and a map of the
route coloured by speed.

The official player is Windows-only in practice (there is a Mac build; there is no
Linux or ChromeOS one).

## Quick start

```sh
docker run -p 8080:8080 wolfbox-player
```

Open <http://localhost:8080>, click **Open SD card**, pick the card. That is the
whole setup — the container needs no volume mounts, because the browser reads the
card itself.

### Development

```sh
npm install
npm test                                    # telemetry parser
npm run dev -w @wolfbox/web                 # UI on :5173, proxies /api to :8080
(cd server && uvicorn app:app --port 8080)  # transcoder
```

Inspect a card from the command line:

```sh
cd packages/telemetry
node --experimental-strip-types tools/scan.ts "/Volumes/NO NAME"
node --experimental-strip-types tools/scan.ts "/Volumes/NO NAME" --trip 160
```

## How it works

```
┌─ Browser (Chrome/Edge) ───────────────────────────┐
│ showDirectoryPicker() ──▶ SD card                 │
│   ├ filename scan  ──▶ trips (instant)            │
│   ├ MP4/gpmd parse ──▶ GPS + speed (lazy, cached) │
│   ├ Leaflet map, speed-coloured route             │
│   └ 2× <video> front|rear, one virtual clock      │
│        ├ HEVC ok? ──▶ URL.createObjectURL(file)   │  ← no server involved
│        └ else ─────▶ POST clip ──┐                │
└──────────────────────────────────┼────────────────┘
                                   ▼
                  ┌─ Docker: stateless transcoder ─┐
                  │ ffmpeg hevc → h264, LRU cache  │
                  │ (also serves the static UI)    │
                  └────────────────────────────────┘
```

On a machine whose browser decodes HEVC the app is a pure offline PWA and the
server is never touched. On a typical Linux desktop the same UI routes video
through the transcoder.

### Why it is shaped this way

**HEVC is the whole problem.** The front camera records 3840×2160 HEVC and the
rear 2560×1440. Chromium on Linux and ChromeOS decodes HEVC *only* with a
hardware decoder — Google ships no software fallback for patent reasons — and
Firefox on Linux generally cannot at all. So on exactly the platforms this
project exists for, the browser may not be able to play the files as recorded.
The app probes with `MediaCapabilities.decodingInfo()` and transcodes when
needed. (The official player sidesteps this by being Electron and bundling its
own ffmpeg.)

**The directory picker, not a Docker mount.** Docker on ChromeOS cannot see an SD
card unless the user first enables Crostini, runs "Share with Linux", and installs
Docker inside the VM. `showDirectoryPicker()` is one click and behaves the same on
ChromeOS, Linux, Mac and Windows.

Its two constraints:

- **Chromium only.** Firefox has no File System Access API. Run the server with
  the card mounted (`-v /media:/media:ro`) and use the mounted-path fallback.
- **Secure context required.** The picker needs `localhost` or HTTPS. Reaching the
  UI at `http://192.168.x.x:8080` disables it; run the container on the same
  machine as the card, or use the mounted-path fallback.

**Indexing is lazy because it has to be.** The telemetry samples are interleaved
through `mdat`, so reading one clip's GPS costs ~60 scattered seeks across a
140 MB file — about 700 ms on a USB SD reader, or nine minutes for a full card.
Trips come from filenames alone (instant); GPS is read per trip and cached in
IndexedDB, so the cost is paid once, incrementally, and never blocks the UI.

## The telemetry format

Each clip has a third MP4 track (`hdlr` = `meta`, name `Hisilicon MetaData`,
`stsd` format `gpmd`). Despite the fourcc this is **not** GoPro GPMF: it is a flat
little-endian struct, one 1000-byte sample per second of video, present in both
front and rear files.

| offset | type | meaning |
|---|---|---|
| `0x00` | u64 | record magic `0x65` |
| `0x08` | 3×i16 | accelerometer X, Y, Z (raw counts) |
| `0x10`/`0x14`/`0x18` | u32 | local hour, minute, second |
| `0x20` | u64 | GPS fix valid (1 = fix) |
| `0x48` | i64 | speed over ground, ÷1000 → knots |
| `0x58` | i64 | heading, ÷100 → degrees true |
| `0x68`/`0x6c`/`0x70` | u32,u32,u64 | day, month, year |
| `0xa0`/`0xa4`/`0xa8` | u32 | UTC hour, minute, second |
| `0xb0` | i64 | latitude, ÷1e5 → `ddmm.mmmmm` |
| `0xc0` | i64 | longitude, ÷1e5 → `ddmm.mmmmm` |
| `0x1f8` | i64 | speed, ÷1000 → km/h |
| `0x98` | — | ASCII `YSKJ`, start of the GNSS diagnostic block |

The record is a decoded NMEA RMC sentence and keeps NMEA's units: coordinates
are **`ddmm.mmmmm`** — degrees and decimal *minutes*, not decimal degrees — and
speed over ground is in knots, with a converted km/h value at `0x1f8`. The u64
following each value is its scale factor (100000 for coordinates, 1000 for
speed) and the firmware really does apply it. The i64 fields at `0x28`/`0x38`
also look like coordinates but are noise.

Reading the coordinates as decimal degrees is the trap. The raw latitude
`421781133` is `4217.81133` ddmm, i.e. 42 degrees 17.81133 minutes, i.e.
**42.29686**. Divide by 1e7 instead and you get a perfectly plausible-looking
**42.17811** — same state, same general area, roughly 13 km south of where the
car actually was. Every derived distance then comes out a factor of ~1.67 too
small, which is small enough to look believable.

The table is anchored to ground truth the camera provides itself: it burns its
position and speed into the picture. For `front_norm/2026_08_04_133634_00.MP4`
at 13:37:07 the overlay reads `W71.4938 N42.2969 64.1MPH`, and this table
decodes that sample to 42.29686, −71.49383, 103.6 km/h (64.4 mph) — which
reverse-geocodes to Turnpike Road (Route 9) in Southborough, the divided highway
visible in the frame. GPS-derived speed across the surrounding samples is
103–105 km/h, agreeing with the reported figure to about 1%.
`packages/telemetry` asserts all of this, including the overlay sample, as
golden values.

### Card layout

```
/front_norm/  2026_08_01_112328_00.MP4     front, rolling loop
/rear_norm/   2026_08_01_112328_01_b.MP4   rear
/front_emer/, /rear_emer/                  locked event clips
/front_photo/, /rear_photo/                stills
```

Clips are 60 s, named `YYYY_MM_DD_HHMMSS_<cam>[_b].MP4`.

### Quirks that matter

- **The cameras run on independent clocks.** Matching on the filename timestamp
  pairs only 714 of 728 clips on the reference card. Pairing tolerates drift, and
  playback aligns the two videos by their embedded GPS timestamps.
- **No-fix rows are written as latitude/longitude `0,0`**, which would otherwise
  drag the route line to Null Island.
- **Speed spikes** occur during fix loss. Speed statistics use a
  median-smoothed series, because isolated spikes well under any sane outlier
  clamp would otherwise be reported as a trip's top speed.
- **Parking events are isolated one-minute clips** — 130 of them against 54 real
  drives on the reference card — so they get their own list.
- **The local date and the UTC time-of-day disagree near midnight.** An evening
  drive in the US is already tomorrow in UTC, and the camera never records its
  offset, so a naive pairing puts the clip 24 hours in the past.
- **Nothing snaps to roads.** Not every drive is on one.

## Using it

The window is three columns that scroll independently, so a long trip list can
never push the player or the map out of view:

- **Left** — trips, filterable by drives / parking events and sortable by
  newest (the default), oldest or longest. A card is a rolling loop, so the
  drive worth reviewing is nearly always the most recent one.
- **Centre** — front and rear video, pinned in place; the trip summary scrolls
  beneath it.
- **Right** — the route map, speed readout and colour legend.

The video and the map each have an expand control that fills the window, and
Escape or the collapse control returns them. Expanding applies fixed
positioning to the existing element rather than moving it in the tree, so the
video keeps playing from where it was and the map keeps its tiles and view.

### Time zones

Dash cams are routinely set to the wrong zone -- the reference card was
recorded in Massachusetts by a camera still on UTC-8. **Times in** in the header
switches between the clock the camera stamped and any real zone. Filenames carry
only a naive local reading, so converting them needs the camera's offset, which
is measured once per card from the first clip that has a GPS fix. Where that
offset cannot be measured the raw camera clock is shown rather than a
plausible-looking wrong time.

## Speed colours

Absolute bins, so a colour means the same speed on every trip:

| mph | meaning |
|---|---|
| stopped | parked or waiting |
| 1–15 | crawl, parking |
| 15–30 | residential |
| 30–45 | arterial |
| 45–60 | highway |
| 60+ | fast |

The obvious green→red traffic ramp fails for colour-blind readers — Tailwind's
green/yellow pair sits at ΔE 4.2 under protanopia. These steps were generated in
OKLCH with monotonically decreasing lightness, so speed is carried by lightness as
well as hue and the ramp stays readable under any colour vision deficiency. The
legend is always present and a table view exists, which is what the remaining
ΔE 6–8 adjacent separation requires.

## Layout

```
packages/telemetry/   MP4 box parser, gpmd decoder, cleaning, trips, summaries
packages/web/         React + Leaflet UI
server/               FastAPI + ffmpeg transcoder; also serves the built UI
```
