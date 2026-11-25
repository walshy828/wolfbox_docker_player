# WolfBox Player

A cross-platform player for the [WolfBox Player 1](https://wolfbox.com/pages/wolfbox-player-1)
dash cam. Runs on a Chromebook, Linux, Mac or Windows machine: plug in the SD card,
point the app at it, and get trips, synced front/rear playback, and a map of the
route coloured by speed. Drives, parking events and individual clips can be
deleted from the card too -- the app asks for write access the first time, and
confirms every delete, because there is no undo.

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
WOLFBOX_API=http://localhost:8088 npm run dev -w @wolfbox/web   # ...or to the compose container
(cd server && WOLFBOX_DATA=./data uvicorn app:app --port 8080)  # service + archive
(cd server && pip install -r requirements-dev.txt && pytest)        # service tests
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
- **Nothing snaps to roads** for the route line. Not every drive is on one.
  Speed-limit matching does snap, but reports what it could not match rather
  than forcing a road onto every sample.
- **The reported speed is accurate**, despite an earlier note in this repo to
  the contrary. Measured over twelve clips of the reference card, the camera's
  speed field tracks GPS-derived speed to within 0.6%, and the camera's own
  burnt-in overlay agrees to about 1%. It is sound to compare against a limit.

## Using it

Opening a card lands on **Drives**: the whole card at a glance. The header
gives the average score, how many drives were high risk, and the card's
totals -- distance, driving time, time over the limit, hard events and top
speed. Below it every drive is a card with its route drawn in speed colours,
its score ring, where it went, its figures and the reasons it lost points.
They sort riskiest first by default and filter by risk band; parking events
are folded away at the bottom. While the card is still being read the header
says how far it has got, and scores made before speed limits arrive are drawn
with a dashed ring.

Opening a drive goes to **Review**, three columns that scroll independently, so
a long trip list can never push the player or the map out of view:

- **Left** — trips, filterable by drives / parking events and sortable by
  newest (the default), riskiest, oldest or longest, for switching drives
  without going back to the overview.
- **Centre** — front and rear video (side by side, picture-in-picture, or one
  camera), pinned in place, with the drive timeline under it; the trip
  summary scrolls beneath that.
- **Right** — the route map, speed readout and colour legend.

The interface is frosted glass over a tinted backdrop and follows the system's
light or dark setting. The map's OpenStreetMap tiles are muted in light mode
and inverted to a dark basemap in dark mode, so the speed-coloured route is
the loudest thing on it.

The video and the map each have an expand control that fills the window, and
Escape or the collapse control returns them. Expanding applies fixed
positioning to the existing element rather than moving it in the tree, so the
video keeps playing from where it was and the map keeps its tiles and view.

The side panels are pinned open by default. The pin control on each one hands
its column back to the video and leaves a narrow labelled rail at the edge of
the window; hovering that rail -- or tabbing into the panel -- floats the panel
back over the workspace, and clicking the rail pins it open again. The choice
is remembered per browser, and both panels stay mounted while collapsed, so the
trip list keeps its scroll position and the map keeps its tiles.

### Drive timeline

The strip under the video is the whole drive on one axis: speed as a filled
trace, the limit as a dashed line, every sustained speeding stretch as a red
band, and a marker for each hard stop, hard launch and sharp turn. Click
anywhere to seek there. **Prev** / **Next** -- or `[` and `]` from anywhere on
the page -- step through the flagged moments, landing a few seconds early so
the moment is seen happening rather than its aftermath.

### Risk score

Every drive gets a 0-100 score, higher being safer, built by deduction so it
always comes with its reasons:

| factor | what costs points | most it can cost |
|---|---|---|
| Speeding | share of moving time over limit + 5 mph, plus each sustained stretch by severity | 45 |
| Hard stops | events per 10 miles, severe counting 2.5x | 30 |
| Hard launches | events per 10 miles | 25 |
| Sharp turns | events per 10 miles | 25 |
| Top speed | any time at 80+ mph | 15 |

Rates are judged over at least 5 miles and speeding time over at least 10
minutes of driving, so a short errand is not punished as a large fraction of
nothing. The worst moment then caps the score, because averages forgive: 20+
over a signed limit caps it at 64 (high risk), 90+ mph at 60, and any severe
hard event at 84. Bands are **low risk** (85+), **some risk** (65-84) and
**high risk** (under 65).

Limits guessed from the road class count for half. A score made before the
speed-limit lookup has finished is drawn with a dashed ring, and the drive
summary says when speeding was not counted.

**Cornering** is measured from GPS: lateral force is speed times the rate the
heading turns. That needed one decoding fix -- the camera writes the heading's
scale factor beside it, usually 100 but occasionally 1000, and reading it as a
constant 100 turned the odd sample into a 900-degree heading and several g of
phantom cornering. With the scale honoured, ordinary driving on the reference
card peaks around 0.25 g, so **0.30 g** is flagged and **0.40 g** is severe.
Speed changes beyond 1.3 g in a second (no road car manages that) are treated
as a receiver artefact -- typically a new fix reading 0 then 104 km/h -- and
ignored.

### The archive

A card is a rolling loop, so every drive on it is days from being overwritten.
**Save to archive** (on the Drives screen, or under the video for one drive)
copies drives into the service's archive, and the **SD card / Archive** switch
in the header browses either. The archive works without a card in the reader.

What is saved:

- **Always**: the drive's data -- every 1 Hz GPS sample with speed, heading,
  the raw accelerometer and the speed limit at that point, every hard stop,
  launch, sharp turn and speeding stretch, the score with its reasons, the
  summary and the place names. About 4,000 rows per hour of driving.
- **Optionally**: the video, front and rear. About 9 GB per hour, which is why
  it is a switch, with the size shown before you commit.

A drive can be tagged with who was driving, at import or afterwards, and the
archive filters by driver. Importing a drive again updates it rather than
duplicating it, and video already saved at the right size is not sent again.
Archived video plays straight from the service with seeking; browsers that
cannot decode the camera's HEVC get an H.264 proxy made on the server.
Deleting from the archive removes the drive's data and video together, and is
the only delete an archived drive offers -- the card's own delete controls
apply only to the card.

Everything lives under `/data` in the container:

```
/data/wolfbox.sqlite                       drives, points, events, clips, drivers
/data/media/YYYY/MM/DD/<drive>/<clip>.MP4  video, when saved
```

`docker-compose.yml` keeps it in a named volume; to keep it on a NAS, mount the
share there instead (`- /mnt/nas/wolfbox:/data`). The SQLite file can be read
with any SQLite tool -- `trips` has one row per drive with its distance, score,
time over the limit and event counts; `points` and `events` have the detail.

### Saved clips

Most of the time only a moment of a drive is worth keeping: the hard stop, the
near miss, the bit to talk through with whoever was driving. **Saved clips**
(under the drive timeline) keeps 15 s, 30 s, 1 min or 2 min of front and rear
video, centred on the playhead or starting at it, with an optional name. Seek
to the moment (the timeline's markers and Prev / Next land just before it),
then **Save clip**.

Only the two or three 60 s files that cover the window are read from the card;
the service cuts the window out of them with ffmpeg by stream copy (no
re-encode, so it is quick and nothing is lost) and keeps only the cut: a 30 s
clip is tens of MB instead of the drive's gigabytes. The drive's data is saved
to history first if it is not there yet. A drive already saved with its video
is cut from the archive copy, without the card. Stream copy starts on a
keyframe, so a clip may begin up to a second early.

Saved clips are listed under the drive, play in place (through the H.264 proxy
on browsers that need it), and can be renamed or deleted. Saving the whole
drive's video is unchanged (**Save video to history…**). Clips live in
`/data/media/YYYY/MM/DD/<drive>/segments/`; the API is in `server/segments.py`.
Waypoint (a separate app) reads both whole-drive video and saved clips through
this archive's API.

### History

**History** (in the header once there is an archive) looks across every saved
drive rather than one card:

- **Totals** for the last 30 days, 90 days, 12 months or all time: distance,
  driving time, drives, average score, time over the limit (and its share of
  driving) and high-risk drives -- for everyone or one driver.
- **Miles per day / week / month**, stacked by driver, and **average score**
  per period, a line per driver, with the 85 and 65 band edges marked. Periods
  follow the time zone chosen in the header. Quiet periods show as gaps, not
  zeros. Each chart has a table view.
- **By driver**: drives, miles, hours, average score and its 30-day trend,
  high-risk drives, minutes over the limit per hour and hard events per 100
  miles -- rates, so the driver who drives most is not penalised for it.
- **Where**: every route on one map coloured by driver, or the **speeding** and
  **hard event** hotspots, red where severe. Clicking a route or a dot opens
  that drive.
- **Mileage check**: enter odometer readings as you take them; between each
  pair the archive's recorded miles are compared with the odometer's. Some
  shortfall is normal (GPS takes a minute to lock on, and drives the card
  looped over before they were saved are missing), but a large one means
  driving the archive never saw.

Drivers are told apart by colour in a fixed order (blue, orange, aqua) assigned
by driver, so a driver keeps their colour whatever is filtered; a fourth and
later driver share a neutral colour, and every chart also has a legend and a
table, so colour is never the only cue.

### Time zones

Dash cams are routinely set to the wrong zone -- the reference card was
recorded in Massachusetts by a camera still on UTC-8. **Times in** in the header
switches between the clock the camera stamped and any real zone. Filenames carry
only a naive local reading, so converting them needs the camera's offset, which
is measured once per card from the first clip that has a GPS fix. Where that
offset cannot be measured the raw camera clock is shown rather than a
plausible-looking wrong time.

### Speed limits

The app compares the speed driven against the speed limit for the road, for
every drive on the card, so the list can be sorted by risk.

**Limits come from OpenStreetMap**, which means a lookup leaves the machine.
This is the one part of the app that talks to a third party about where you
drove (the map tiles and place names aside). Requests are made to the local
service, not from the browser, and are keyed to zoom-13 tiles roughly 5 km
across, so no request names a street. Drives are looked up one at a time,
newest first, after every drive's GPS has been read; the service caches every
tile for a month, so a card's second visit costs nothing upstream. Set
`WOLFBOX_OVERPASS_URLS` empty to keep everything local.

**What counts as speeding.** Being briefly over a limit is ordinary driving, so
a stretch is only reported when the car was more than **5 mph** over for at
least **10 continuous seconds**. Arming is a leaky counter rather than an
unbroken run — at 1 Hz a single noisy sample would otherwise erase a genuine
forty-second stretch. Once open, a stretch stays open until the car is back at
or under the limit for five seconds: closing at the tolerance instead would
record a driver easing off from +9 to +4 mph as two offences rather than one.
Crossing into a new limit closes the stretch, so motorway speeding is never
carried into town.

**Matching a sample to a road** uses distance, the direction of travel and
which road the car was on a second ago. Direction is what separates a divided
highway's two carriageways, which are close enough together that distance alone
picks the wrong one. The case that stays genuinely hard is a frontage road
running the same way as the arterial beside it, separated only by a distance
comparable to the GPS error — which is why every reported stretch names the
road it was matched to.

**Coverage is reported, always.** OpenStreetMap's `maxspeed` tagging is uneven:
around the reference card, motorways and trunk roads are 100% tagged by length,
secondary and tertiary roads 22–29%, and residential and service roads not at
all. Where nothing is tagged, a limit is assumed from the road class and
**marked as assumed**; assumed limits are kept out of the headline figure
entirely, and where too little of a route had a known limit no score is shown
rather than a flattering one. The panel always states how much of the drive it
actually knew about.

The map's colour legend gains a **vs limit** view once limits have loaded,
painting how far over the limit each stretch was instead of the speed driven.
Stretches with no known limit are drawn dashed and neutral, so "we don't know"
can never be mistaken for "nothing wrong here".

This is a review tool over crowd-sourced data and consumer GPS. It is a guide
to footage worth watching, not a record of what happened.

#### Configuring the lookup

| Variable | Default | What it does |
| --- | --- | --- |
| `WOLFBOX_OVERPASS_URLS` | two public endpoints | Comma-separated Overpass endpoints, tried in turn. Set empty to disable lookups and serve only what is already cached. |
| `WOLFBOX_OSM_TTL_DAYS` | `30` | How long a cached tile is fresh. Expired tiles are still served if the lookup fails. |
| `WOLFBOX_OSM_CACHE_BYTES` | `256 MB` | Budget for cached road data, evicted least-recently-used. Separate from the video proxy cache so a burst of transcoding cannot evict it. |

Overpass is run on donated hardware. The service caches every tile to disk for
a month, serialises its upstream calls, waits at least a second between them
and identifies itself — please leave those in place.

## Speed colours

The route line is a continuous ramp rather than blocks of colour, so an
acceleration or a braking event reads as a gradient along the road. It tops out
at **80 mph**, where the colour is a deep red-purple, and stays pinned above
that so the deepest colour means something definite.

| mph | band |
|---|---|
| stopped | parked or waiting (neutral grey, deliberately outside the ramp) |
| 1-15 | crawl, parking |
| 15-35 | residential |
| 35-60 | route |
| 60-80 | highway |
| 80+ | very fast |

The bands label the ramp; they do not divide it. The legend is a gradient bar
with the boundaries ticked along it, and the trip histogram uses the same
colours, so a stretch that looks orange on the map is the orange bar in the
summary.

The obvious green-to-red traffic ramp fails for colour-blind viewers: Tailwind's
green/yellow pair sits at deltaE 4.2 under protanopia, i.e. indistinguishable.
The stops here are defined in OKLCH and interpolated there, with
**monotonically decreasing lightness** from the slow end to the fast end. That
is the property that matters, and tests assert it across every whole mph in both
themes: speed survives as a grayscale ramp under any colour vision deficiency,
and hue is a redundant second channel rather than the only one. Every dark-theme
step also clears 3:1 against the dark surface.

Checked with the palette validator, adjacent band keys separate well under
protanopia, deuteranopia and tritanopia. The top two keys sit at deltaE 13 for
normal vision, slightly under the usual floor of 15 -- unavoidable when both
"highway" and "very fast" have to be deep colours -- so the legend is always
present, every histogram bar is directly labelled, and a table view is offered.

## Layout

```
packages/telemetry/   MP4 box parser, gpmd decoder, cleaning, trips, summaries
packages/web/         React + Leaflet UI
server/               FastAPI service: transcoding, speed limits, place names, the
                      drive archive (archive.py); also serves the built UI
```
