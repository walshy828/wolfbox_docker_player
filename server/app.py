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

The browser reads the card itself whenever it can, so the container normally
needs no volume mounts at all.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import shutil
import subprocess
import tempfile
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
    }


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
