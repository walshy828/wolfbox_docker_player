"""
WolfBox Player service.

Two jobs, both of which exist because of one constraint: the camera records 4K
HEVC, and Chromium on Linux and ChromeOS will only decode HEVC when the machine
has a hardware decoder. Google ships no software fallback for patent reasons and
Firefox on Linux generally cannot decode it at all, so on exactly the platforms
this project exists to serve, the browser cannot play the files as recorded.

  1. /api/transcode  converts a clip the browser cannot decode into H.264.
  2. /api/card       lists clips from a mounted path, for browsers with no
                     File System Access API (Firefox) and for headless installs.
  3. /api/speedlimits proxies OpenStreetMap road data so the drive summary can
                     compare speed driven against the limit for the road.
  4. /api/geocode    proxies Nominatim so the trip list can show a place name
                     for where a drive started and ended, rather than raw
                     coordinates.

The speed-limit and geocoding proxies are here rather than in the browser for
three reasons: they can cache to disk across sessions and across users, they
can rate-limit themselves against a volunteer-run service that would otherwise
be hit once per trip viewed, and it keeps the browser from talking to a third
party directly.

The browser reads the card itself whenever it can, so the container normally
needs no volume mounts at all.
"""
from __future__ import annotations

import asyncio
import gzip
import hashlib
import json
import logging
import math
import os
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

log = logging.getLogger("wolfbox")

CACHE_DIR = Path(os.environ.get("WOLFBOX_CACHE", tempfile.gettempdir() + "/wolfbox-cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
# Roughly 200 proxies at 720p. Old entries are evicted least-recently-used.
CACHE_MAX_BYTES = int(os.environ.get("WOLFBOX_CACHE_BYTES", 4 * 1024**3))
STATIC_DIR = Path(__file__).parent / "static"

# Road data lives beside the video proxies but is budgeted separately: it is
# tiny by comparison and far more expensive to re-fetch, so it must not be
# evicted by a burst of transcoding.
OSM_CACHE_DIR = CACHE_DIR / "osm"
OSM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
OSM_CACHE_MAX_BYTES = int(os.environ.get("WOLFBOX_OSM_CACHE_BYTES", 256 * 1024**2))
# Speed limits change on a scale of years. A month-old answer is a far smaller
# problem than another request to a service that is donated, not sold.
OSM_TTL_SEC = int(os.environ.get("WOLFBOX_OSM_TTL_DAYS", 30)) * 86_400
OVERPASS_URLS = [
    url.strip() for url in os.environ.get(
        "WOLFBOX_OVERPASS_URLS",
        "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter",
    ).split(",") if url.strip()
]
# Zoom 13 tiles are roughly 5 km across at mid latitudes: coarse enough that a
# repeated commute reuses the same entries, small enough that one trip pulls
# only a handful.
OSM_TILE_ZOOM = 13
OSM_MAX_TILES_PER_REQUEST = 40

# Ways a car cannot legally drive on are the bulk of the way count in towns and
# parks, and matching would never choose them. Excluding them here is what
# keeps a tile's road data small enough to be worth caching.
OSM_HIGHWAY_TYPES = (
    "motorway|trunk|primary|secondary|tertiary|unclassified|residential|"
    "living_street|service|road|motorway_link|trunk_link|primary_link|"
    "secondary_link|tertiary_link"
)
# The only tags the adherence code reads. Everything else is dropped before the
# tile is written, which is most of the payload.
OSM_KEEP_TAGS = (
    "highway", "maxspeed", "maxspeed:forward", "maxspeed:backward",
    "maxspeed:type", "maxspeed:advisory", "zone:maxspeed", "oneway", "name", "ref",
)

# Folders the camera writes. Kept in step with packages/telemetry/src/catalog.ts.
CLIP_FOLDERS = (
    "front_norm", "rear_norm", "front_emer", "rear_emer", "front_photo", "rear_photo",
)
# Where removable media shows up. /mnt/chromeos/removable is Crostini's mount
# point for a card shared into Linux from the ChromeOS Files app.
MEDIA_ROOTS = ("/media", "/run/media", "/mnt/chromeos/removable", "/Volumes", "/mnt")

app = FastAPI(title="WolfBox Player")


def has_vaapi() -> bool:
    """True when the host exposed a render node we can decode/encode on."""
    return Path("/dev/dri/renderD128").exists()


def ffmpeg_command(source: Path, target: Path, width: int) -> list[str]:
    """
    Builds the transcode command.

    Decoding 4K HEVC is the expensive half, so the proxy is scaled down: two 4K
    panes side by side help nobody, and 720p keeps a clip well inside real time
    even on software decode.
    """
    if has_vaapi():
        return [
            "ffmpeg", "-nostdin", "-y",
            "-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi",
            "-hwaccel_device", "/dev/dri/renderD128",
            "-i", str(source),
            "-vf", f"scale_vaapi=w={width}:h=-2:format=nv12",
            "-c:v", "h264_vaapi", "-b:v", "4M",
            "-c:a", "aac", "-b:a", "96k",
            "-movflags", "+faststart",
            str(target),
        ]
    return [
        "ffmpeg", "-nostdin", "-y",
        "-i", str(source),
        "-vf", f"scale={width}:-2",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "24",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        str(target),
    ]


def prune_cache() -> None:
    """Evicts least-recently-used proxies once the cache exceeds its budget."""
    files = sorted(CACHE_DIR.glob("*.mp4"), key=lambda p: p.stat().st_atime)
    total = sum(f.stat().st_size for f in files)
    while total > CACHE_MAX_BYTES and files:
        victim = files.pop(0)
        total -= victim.stat().st_size
        victim.unlink(missing_ok=True)


# One transcode at a time per worker. Running several 4K HEVC decodes in
# parallel makes every one of them slower than doing them in turn.
_transcode_lock = asyncio.Semaphore(int(os.environ.get("WOLFBOX_CONCURRENCY", 1)))


@app.post("/api/transcode")
async def transcode(request: Request, width: int = Query(1280, ge=320, le=3840)) -> FileResponse:
    """
    Accepts a clip's bytes and returns an H.264 proxy the browser can play.

    The upload is hashed as it streams to disk so a clip watched twice, or
    prefetched and then played, is only ever converted once.
    """
    if shutil.which("ffmpeg") is None:
        raise HTTPException(
            status_code=503,
            detail="ffmpeg is not installed, so clips cannot be converted for this browser.",
        )

    digest = hashlib.blake2b(digest_size=16)
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as handle:
        source = Path(handle.name)
        async for chunk in request.stream():
            digest.update(chunk)
            handle.write(chunk)

    if source.stat().st_size == 0:
        source.unlink(missing_ok=True)
        raise HTTPException(status_code=400, detail="Empty upload.")

    target = CACHE_DIR / f"{digest.hexdigest()}-{width}.mp4"
    try:
        if not target.exists():
            async with _transcode_lock:
                # Re-check: another request may have produced it while we waited.
                if not target.exists():
                    await run_ffmpeg(source, target, width)
            prune_cache()
    finally:
        source.unlink(missing_ok=True)

    return FileResponse(target, media_type="video/mp4")


async def run_ffmpeg(source: Path, target: Path, width: int) -> None:
    # Transcode to a scratch name so a failed or cancelled run cannot leave a
    # truncated file behind that later looks like a valid cache hit.
    scratch = target.with_suffix(".partial.mp4")
    process = await asyncio.create_subprocess_exec(
        *ffmpeg_command(source, scratch, width),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    _, stderr = await process.communicate()
    if process.returncode != 0:
        scratch.unlink(missing_ok=True)
        message = stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        log.error("ffmpeg failed: %s", " / ".join(message))
        raise HTTPException(status_code=500, detail="Could not convert this clip.")
    scratch.replace(target)


@app.get("/api/health")
def health() -> dict[str, object]:
    return {
        "ok": True,
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "hardwareAcceleration": has_vaapi(),
        "cacheBytes": sum(f.stat().st_size for f in CACHE_DIR.glob("*.mp4")),
        "osmCacheBytes": sum(f.stat().st_size for f in OSM_CACHE_DIR.glob("*.json")),
        "speedLimits": "ok" if OVERPASS_URLS else "cached-only",
        "geocodeCacheBytes": sum(f.stat().st_size for f in GEOCODE_CACHE_DIR.glob("*.json")),
    }


# One upstream call at a time, and never two in the same second. Overpass is
# run on donated hardware; a user browsing thirty trips must not arrive as
# thirty simultaneous queries.
_overpass_lock = asyncio.Semaphore(1)
_last_overpass_at = 0.0
OVERPASS_MIN_INTERVAL_SEC = 1.0


def tile_bounds(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """The (south, west, north, east) of a slippy-map tile, in degrees."""
    n = 2 ** z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return south, west, north, east


def parse_tile(token: str) -> tuple[int, int, int]:
    """Reads a `z/x/y` token, refusing anything that is not a tile we serve."""
    parts = token.split("/")
    if len(parts) != 3:
        raise HTTPException(status_code=400, detail=f"Malformed tile: {token}")
    try:
        z, x, y = (int(part) for part in parts)
    except ValueError:
        raise HTTPException(status_code=400, detail=f"Malformed tile: {token}") from None
    # Pinning the zoom keeps the cache keyed one way, so the same ground is
    # never fetched twice under two different tilings.
    if z != OSM_TILE_ZOOM:
        raise HTTPException(status_code=400, detail=f"Only zoom {OSM_TILE_ZOOM} is served.")
    if not (0 <= x < 2 ** z and 0 <= y < 2 ** z):
        raise HTTPException(status_code=400, detail=f"Tile out of range: {token}")
    return z, x, y


def osm_cache_path(z: int, x: int, y: int) -> Path:
    return OSM_CACHE_DIR / f"{z}_{x}_{y}.json"


def prune_osm_cache() -> None:
    """Evicts least-recently-used road tiles once they exceed their own budget."""
    files = sorted(OSM_CACHE_DIR.glob("*.json"), key=lambda p: p.stat().st_atime)
    total = sum(f.stat().st_size for f in files)
    while total > OSM_CACHE_MAX_BYTES and files:
        victim = files.pop(0)
        total -= victim.stat().st_size
        victim.unlink(missing_ok=True)


def overpass_query(tiles: list[tuple[int, int, int]]) -> str:
    """One query covering every missing tile, rather than one query per tile."""
    clauses = []
    for z, x, y in tiles:
        south, west, north, east = tile_bounds(z, x, y)
        clauses.append(
            f'way["highway"~"^({OSM_HIGHWAY_TYPES})$"]["area"!="yes"]'
            f"({south:.6f},{west:.6f},{north:.6f},{east:.6f});"
        )
    # `out tags geom` inlines each way's coordinates, which avoids a second
    # round of node resolution and is several times smaller than `out body`.
    return "[out:json][timeout:60];(" + "".join(clauses) + ");out tags geom;"


def fetch_overpass(query: str) -> dict:
    """Runs one Overpass query, trying each configured endpoint in turn."""
    last_error: Exception | None = None
    for url in OVERPASS_URLS:
        request = urllib.request.Request(
            url,
            data=urllib.parse.urlencode({"data": query}).encode(),
            headers={
                # Overpass etiquette requires an identifying agent, and
                # anonymous traffic is the first thing to be blocked.
                "User-Agent": "wolfbox-player/0.1 (dash cam review tool)",
                "Accept-Encoding": "gzip",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                raw = response.read()
                if response.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw)
        except Exception as cause:  # noqa: BLE001 - any failure means try the next
            log.warning("overpass %s failed: %s", url, cause)
            last_error = cause
    raise last_error or RuntimeError("no Overpass endpoint configured")


def assign_ways_to_tiles(
    elements: list[dict], tiles: list[tuple[int, int, int]]
) -> dict[tuple[int, int, int], list[dict]]:
    """
    Files each way under every tile its extent touches.

    A way is stored whole rather than clipped at the tile edge: clipping would
    split a road into fragments and break the continuity the matcher relies on
    to stop flicking between neighbouring roads. The client dedupes by way id.
    """
    bounds = {tile: tile_bounds(*tile) for tile in tiles}
    filed: dict[tuple[int, int, int], list[dict]] = {tile: [] for tile in tiles}

    for element in elements:
        geometry = element.get("geometry") or []
        if len(geometry) < 2:
            continue
        tags = element.get("tags") or {}
        trimmed = {k: v for k, v in tags.items() if k in OSM_KEEP_TAGS}
        if "highway" not in trimmed:
            continue

        lats = [node["lat"] for node in geometry]
        lons = [node["lon"] for node in geometry]
        way = {
            "id": element["id"],
            "tags": trimmed,
            # Six decimals is about 11 cm, far finer than the GPS it is matched
            # against, and it roughly halves the stored size.
            "geometry": [[round(node["lat"], 6), round(node["lon"], 6)] for node in geometry],
        }
        for tile, (south, west, north, east) in bounds.items():
            if max(lats) >= south and min(lats) <= north and max(lons) >= west and min(lons) <= east:
                filed[tile].append(way)

    return filed


async def load_tile(z: int, x: int, y: int, allow_fetch: bool) -> dict:
    """Reads one tile from disk, reporting how fresh what it found was."""
    path = osm_cache_path(z, x, y)
    if path.is_file():
        age = time.time() - path.stat().st_mtime
        try:
            payload = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            payload = None
        if payload is not None:
            return {
                "z": z, "x": x, "y": y,
                "status": "ok" if age <= OSM_TTL_SEC else "stale",
                "ways": payload.get("ways", []),
            }
    return {"z": z, "x": x, "y": y, "status": "miss" if allow_fetch else "offline", "ways": []}


@app.get("/api/speedlimits")
async def speedlimits(tiles: str = Query(..., description="Comma-separated z/x/y")) -> JSONResponse:
    """
    Road geometry and speed limits for a set of map tiles.

    Answers per tile and always with HTTP 200 when anything at all resolved:
    partial coverage is the honest result for a route that crosses into
    territory the lookup could not reach, and the UI is built to say so. A
    failure here must never take out the drive summary around it.
    """
    tokens = [token for token in tiles.split(",") if token]
    if not tokens:
        raise HTTPException(status_code=400, detail="No tiles requested.")
    if len(tokens) > OSM_MAX_TILES_PER_REQUEST:
        raise HTTPException(
            status_code=400,
            detail=f"At most {OSM_MAX_TILES_PER_REQUEST} tiles per request.",
        )

    wanted = list(dict.fromkeys(parse_tile(token) for token in tokens))
    results = {tile: await load_tile(*tile, bool(OVERPASS_URLS)) for tile in wanted}
    missing = [tile for tile, result in results.items() if result["status"] == "miss"]

    if missing:
        async with _overpass_lock:
            global _last_overpass_at
            wait = OVERPASS_MIN_INTERVAL_SEC - (time.monotonic() - _last_overpass_at)
            if wait > 0:
                await asyncio.sleep(wait)
            # Another request may have filled these while we waited for the lock.
            missing = [
                tile for tile in missing
                if (await load_tile(*tile, True))["status"] == "miss"
            ]
            if missing:
                try:
                    payload = await asyncio.to_thread(
                        fetch_overpass, overpass_query(missing))
                    filed = assign_ways_to_tiles(payload.get("elements", []), missing)
                    for tile, ways in filed.items():
                        osm_cache_path(*tile).write_text(
                            json.dumps({"ways": ways}, separators=(",", ":")))
                        results[tile] = {
                            "z": tile[0], "x": tile[1], "y": tile[2],
                            "status": "ok", "ways": ways,
                        }
                    prune_osm_cache()
                except Exception as cause:  # noqa: BLE001
                    log.warning("speed limit lookup failed: %s", cause)
                    for tile in missing:
                        results[tile] = {
                            "z": tile[0], "x": tile[1], "y": tile[2],
                            "status": "offline", "ways": [],
                        }
            _last_overpass_at = time.monotonic()

    return JSONResponse({
        "source": "openstreetmap",
        "attribution": "\u00a9 OpenStreetMap contributors (ODbL)",
        "tiles": [results[tile] for tile in wanted],
    })


GEOCODE_CACHE_DIR = CACHE_DIR / "geocode"
GEOCODE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
GEOCODE_CACHE_MAX_BYTES = int(os.environ.get("WOLFBOX_GEOCODE_CACHE_BYTES", 64 * 1024**2))
# Place names change far more slowly than speed limits, so this can be generous.
GEOCODE_TTL_SEC = int(os.environ.get("WOLFBOX_GEOCODE_TTL_DAYS", 180)) * 86_400
NOMINATIM_URL = os.environ.get("WOLFBOX_NOMINATIM_URL", "https://nominatim.openstreetmap.org/reverse")
# ~11 m: finer than this buys nothing for a "street, town" label, and rounding
# is what lets a driveway visited on ten different trips cost one lookup.
GEOCODE_PRECISION = 4

# Nominatim's usage policy caps an automated caller at one request per second.
_geocode_lock = asyncio.Semaphore(1)
_last_geocode_at = 0.0
GEOCODE_MIN_INTERVAL_SEC = 1.0


def geocode_cache_path(lat: float, lon: float) -> Path:
    rlat, rlon = round(lat, GEOCODE_PRECISION), round(lon, GEOCODE_PRECISION)
    return GEOCODE_CACHE_DIR / f"{rlat}_{rlon}.json"


def prune_geocode_cache() -> None:
    """Evicts least-recently-used place lookups once they exceed their budget."""
    files = sorted(GEOCODE_CACHE_DIR.glob("*.json"), key=lambda p: p.stat().st_atime)
    total = sum(f.stat().st_size for f in files)
    while total > GEOCODE_CACHE_MAX_BYTES and files:
        victim = files.pop(0)
        total -= victim.stat().st_size
        victim.unlink(missing_ok=True)


def label_from_address(address: dict, display_name: str) -> str | None:
    """A short "road, town" label, not Nominatim's full multi-line address."""
    road = address.get("road") or address.get("pedestrian") or address.get("footway")
    place = (
        address.get("city") or address.get("town") or address.get("village")
        or address.get("hamlet") or address.get("suburb") or address.get("county")
    )
    if road and place:
        return f"{road}, {place}"
    if road or place:
        return road or place
    # A fix with no tagged road at all (open country, a private lot) still gets
    # something from Nominatim's own summary rather than nothing.
    return display_name.split(",")[0].strip() if display_name else None


def fetch_nominatim(lat: float, lon: float) -> str | None:
    """One reverse-geocode call. Raises on any failure; the caller decides what that means."""
    params = urllib.parse.urlencode({
        "lat": f"{lat:.6f}", "lon": f"{lon:.6f}", "format": "jsonv2", "zoom": 16,
    })
    request = urllib.request.Request(
        f"{NOMINATIM_URL}?{params}",
        headers={
            # Anonymous traffic is against Nominatim's usage policy for anything
            # beyond a one-off manual lookup.
            "User-Agent": "wolfbox-player/0.1 (dash cam review tool)",
            "Accept-Encoding": "gzip",
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        raw = response.read()
        if response.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        payload = json.loads(raw)
    return label_from_address(payload.get("address") or {}, payload.get("display_name", ""))


def read_geocode_cache(path: Path) -> dict | None:
    if not path.is_file():
        return None
    if time.time() - path.stat().st_mtime > GEOCODE_TTL_SEC:
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


@app.get("/api/geocode")
async def geocode(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
) -> JSONResponse:
    """
    A short place name for one GPS fix, for the trip list's start/end column.

    Answers with HTTP 200 and a null label on any failure -- an unreachable
    geocoder must not take out the trip list around it, just leave that one
    trip showing coordinates instead of a name.
    """
    path = geocode_cache_path(lat, lon)
    cached = read_geocode_cache(path)
    if cached is not None:
        return JSONResponse(cached)

    async with _geocode_lock:
        global _last_geocode_at
        # Another request may have filled this while we waited for the lock.
        cached = read_geocode_cache(path)
        if cached is not None:
            return JSONResponse(cached)

        wait = GEOCODE_MIN_INTERVAL_SEC - (time.monotonic() - _last_geocode_at)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            label = await asyncio.to_thread(fetch_nominatim, lat, lon)
            payload = {"label": label, "source": "nominatim"}
            path.write_text(json.dumps(payload))
            prune_geocode_cache()
        except Exception as cause:  # noqa: BLE001
            log.warning("geocode lookup failed: %s", cause)
            payload = {"label": None, "source": "unavailable"}
        finally:
            _last_geocode_at = time.monotonic()

    return JSONResponse(payload)


@app.get("/api/media")
def media() -> dict[str, list[str]]:
    """Removable volumes that look like a dash cam card, for the mounted-path fallback."""
    found: list[str] = []
    for root in MEDIA_ROOTS:
        base = Path(root)
        if not base.is_dir():
            continue
        candidates = [base, *(p for p in base.iterdir() if p.is_dir())]
        for candidate in candidates:
            try:
                if any((candidate / folder).is_dir() for folder in CLIP_FOLDERS):
                    found.append(str(candidate))
            except PermissionError:
                continue
    return {"cards": sorted(set(found))}


@app.get("/api/card")
def card(path: str = Query(...)) -> JSONResponse:
    """Lists a mounted card's clips. Filenames only -- GPS is read on demand."""
    root = Path(path).resolve()
    if not root.is_dir():
        raise HTTPException(status_code=404, detail=f"No such directory: {path}")
    if not any((root / folder).is_dir() for folder in CLIP_FOLDERS):
        raise HTTPException(status_code=400, detail="That folder does not look like a dash cam card.")

    clips = []
    for folder in CLIP_FOLDERS:
        directory = root / folder
        if not directory.is_dir():
            continue
        for entry in sorted(directory.iterdir()):
            if entry.is_file() and entry.suffix.upper() == ".MP4" and not entry.name.startswith("."):
                clips.append({
                    "folder": folder,
                    "name": entry.name,
                    "size": entry.stat().st_size,
                    "lastModified": int(entry.stat().st_mtime * 1000),
                })
    return JSONResponse({"name": root.name, "clips": clips})


@app.get("/api/clip")
def clip(path: str = Query(...), folder: str = Query(...), name: str = Query(...)) -> FileResponse:
    """Serves one clip's original bytes from a mounted card."""
    if folder not in CLIP_FOLDERS or "/" in name or name.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid clip reference.")
    root = Path(path).resolve()
    target = (root / folder / name).resolve()
    # Refuse anything that escaped the card root via a crafted name.
    if not target.is_file() or root not in target.parents:
        raise HTTPException(status_code=404, detail="No such clip.")
    return FileResponse(target, media_type="video/mp4")


if STATIC_DIR.is_dir():
    # Mounted last so it cannot shadow the API routes.
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="ui")
