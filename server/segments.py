"""
Saved clips: a short stretch of a drive's video (say 30 s around a hard stop)
kept without keeping the whole drive.

A drive's video is a run of 60 s files per camera, ~140 MB each for the front.
Saving a clip cuts just the wanted window out of them with ffmpeg, stream copy
(no re-encode, so it is quick and loses nothing), and keeps only the cut:

  1. POST   /trips/{trip}/segments                 the window, and each source file's absolute start
     -> {"id", "needed": [clip names the server does not hold]}
  2. PUT    /trips/{trip}/segments/{id}/sources/{clip}   each needed file, streamed from the card
  3. POST   /trips/{trip}/segments/{id}/cut         cut each camera; the uploaded sources are deleted

A source already archived (the whole drive was saved with video) is cut from
in place, so a clip of an archived drive needs no upload at all.

Times are absolute epoch ms from the GPS clock, the same clock as the drive's
points. The two cameras run on independent clocks, so each camera is cut from
its own files' starts and both clips begin at the same instant. Stream copy can
only start on a keyframe, so a clip may begin up to a second early.
"""
from __future__ import annotations

import asyncio
import json
import secrets
import shutil
import subprocess
import logging
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import archive
from archive import check_clip_name, check_trip_id, connect, now_ms, trip_media_dir

log = logging.getLogger("wolfbox.segments")

MIN_SEC = 2
MAX_SEC = 600
CLIP_SEC = 60                    # the camera's file length
SEGMENT_ID_LEN = 12              # hex characters

SCHEMA = """
CREATE TABLE IF NOT EXISTS segments (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  label TEXT,
  sources TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  ready_ms INTEGER
);
CREATE INDEX IF NOT EXISTS segments_by_trip ON segments(trip_id, start_ms);
CREATE TABLE IF NOT EXISTS segment_files (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  camera TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (segment_id, camera)
);
"""


def init() -> None:
    with connect() as db:
        db.executescript(SCHEMA)


class SourceIn(BaseModel):
    name: str
    camera: str = Field(pattern=r"^(front|rear)$")
    startMs: int


class SegmentIn(BaseModel):
    startMs: int
    endMs: int
    label: Optional[str] = Field(default=None, max_length=120)
    sources: list[SourceIn] = Field(min_length=1, max_length=40)


def check_segment_id(segment_id: str) -> None:
    if len(segment_id) != SEGMENT_ID_LEN or any(c not in "0123456789abcdef" for c in segment_id):
        raise HTTPException(status_code=400, detail="Invalid clip id.")


def segment_dir(trip_id: str) -> Path:
    return trip_media_dir(trip_id) / "segments"


def scratch_dir(trip_id: str, segment_id: str) -> Path:
    return segment_dir(trip_id) / f".{segment_id}.sources"


def segment_json(row, files) -> dict[str, Any]:
    return {
        "id": row["id"], "startMs": row["start_ms"], "endMs": row["end_ms"], "label": row["label"],
        "createdMs": row["created_ms"], "ready": row["ready_ms"] is not None,
        "files": [{"camera": f["camera"], "size": f["size"]} for f in files],
    }


def list_for(db, trip_ids: Optional[list[str]] = None) -> dict[str, list[dict[str, Any]]]:
    """Ready clips per drive, oldest first."""
    where = "WHERE ready_ms IS NOT NULL"
    args: tuple = ()
    if trip_ids is not None:
        if not trip_ids:
            return {}
        where += f" AND trip_id IN ({','.join('?' * len(trip_ids))})"
        args = tuple(trip_ids)
    rows = db.execute(f"SELECT * FROM segments {where} ORDER BY start_ms", args).fetchall()
    files = db.execute("SELECT * FROM segment_files ORDER BY camera").fetchall()
    by_seg: dict[str, list] = {}
    for f in files:
        by_seg.setdefault(f["segment_id"], []).append(f)
    out: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        out.setdefault(r["trip_id"], []).append(segment_json(r, by_seg.get(r["id"], [])))
    return out


def plan(sources: list[dict[str, Any]], start_ms: int, end_ms: int) -> dict[str, list[dict[str, Any]]]:
    """Per camera, the files that cover [start, end] in time order. Pure; exported for tests."""
    out: dict[str, list[dict[str, Any]]] = {}
    for camera in ("front", "rear"):
        mine = sorted((s for s in sources if s["camera"] == camera), key=lambda s: s["startMs"])
        cover = [s for s in mine if s["startMs"] < end_ms and s["startMs"] + CLIP_SEC * 1000 > start_ms]
        if cover:
            out[camera] = cover
    return out


def cut_command(list_file: Path, target: Path, offset_sec: float, duration_sec: float) -> list[str]:
    """
    Stream-copies [offset, offset + duration] out of the concatenated sources.

    `-ss` before the input seeks on keyframes, which stream copy needs. Only the
    video and any audio are kept: the camera's telemetry track would carry no
    meaning once cut, and the drive's points already hold it.
    """
    return [
        "ffmpeg", "-nostdin", "-y", "-loglevel", "error",
        "-ss", f"{max(0.0, offset_sec):.3f}",
        "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-t", f"{duration_sec:.3f}",
        "-map", "0:v:0", "-map", "0:a?",
        "-c", "copy", "-movflags", "+faststart",
        str(target),
    ]


async def run(cmd: list[str]) -> None:
    process = await asyncio.create_subprocess_exec(*cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    _, stderr = await process.communicate()
    if process.returncode != 0:
        message = stderr.decode("utf-8", "replace").strip().splitlines()[-3:]
        log.error("ffmpeg cut failed: %s", " / ".join(message))
        raise HTTPException(status_code=500, detail="Could not cut this clip from the video.")


# --- routes -------------------------------------------------------------------

router = APIRouter(prefix="/api/archive")


def load_segment(db, trip_id: str, segment_id: str):
    row = db.execute("SELECT * FROM segments WHERE id = ? AND trip_id = ?", (segment_id, trip_id)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such clip.")
    return row


def available(db, trip_id: str, name: str) -> Optional[Path]:
    """The archived copy of a whole-drive clip, when the drive was saved with video."""
    row = db.execute("SELECT stored_path, size FROM clips WHERE trip_id = ? AND name = ?", (trip_id, name)).fetchone()
    if row and row["stored_path"]:
        path = Path(row["stored_path"])
        if path.is_file() and path.stat().st_size == row["size"]:
            return path
    return None


@router.post("/trips/{trip_id}/segments")
def create_segment(trip_id: str, body: SegmentIn) -> dict[str, Any]:
    """Starts a clip. The drive's data must be archived first (so its clip list is known)."""
    check_trip_id(trip_id)
    seconds = (body.endMs - body.startMs) / 1000
    if not MIN_SEC <= seconds <= MAX_SEC:
        raise HTTPException(status_code=400, detail=f"A clip must be {MIN_SEC}-{MAX_SEC} seconds long.")
    for s in body.sources:
        check_clip_name(s.name)
    sources = [s.model_dump() for s in body.sources]
    by_camera = plan(sources, body.startMs, body.endMs)
    if not by_camera:
        raise HTTPException(status_code=400, detail="No video covers that stretch of the drive.")
    with connect() as db:
        if db.execute("SELECT 1 FROM trips WHERE id = ?", (trip_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="Save the drive before a clip of it.")
        known = {r["name"] for r in db.execute("SELECT name FROM clips WHERE trip_id = ?", (trip_id,))}
        used = [s for cam in by_camera.values() for s in cam]
        unknown = [s["name"] for s in used if s["name"] not in known]
        if unknown:
            raise HTTPException(status_code=400, detail=f"Not clips of this drive: {', '.join(unknown)}")
        segment_id = secrets.token_hex(SEGMENT_ID_LEN // 2)
        db.execute(
            "INSERT INTO segments (id, trip_id, start_ms, end_ms, label, sources, created_ms) VALUES (?,?,?,?,?,?,?)",
            (segment_id, trip_id, body.startMs, body.endMs, (body.label or "").strip() or None, json.dumps(used), now_ms()),
        )
        needed = [s["name"] for s in used if available(db, trip_id, s["name"]) is None]
    return {"id": segment_id, "needed": needed, "cameras": sorted(by_camera)}


@router.put("/trips/{trip_id}/segments/{segment_id}/sources/{name}")
async def upload_source(trip_id: str, segment_id: str, name: str, request: Request) -> dict[str, Any]:
    """One source file for a clip, streamed from the card. Deleted once the clip is cut."""
    check_trip_id(trip_id)
    check_segment_id(segment_id)
    check_clip_name(name)
    with connect() as db:
        row = load_segment(db, trip_id, segment_id)
        size = db.execute("SELECT size FROM clips WHERE trip_id = ? AND name = ?", (trip_id, name)).fetchone()
    if name not in {s["name"] for s in json.loads(row["sources"])}:
        raise HTTPException(status_code=400, detail="That file is not part of this clip.")
    folder = scratch_dir(trip_id, segment_id)
    folder.mkdir(parents=True, exist_ok=True)
    target, partial = folder / name, folder / f".{name}.partial"
    written = 0
    try:
        with open(partial, "wb") as handle:
            async for chunk in request.stream():
                handle.write(chunk)
                written += len(chunk)
        if size and size["size"] and written != size["size"]:
            raise HTTPException(status_code=400, detail=f"Upload was {written} bytes; the file is {size['size']}.")
        partial.replace(target)
    finally:
        partial.unlink(missing_ok=True)
    return {"name": name, "received": written}


@router.post("/trips/{trip_id}/segments/{segment_id}/cut")
async def cut_segment(trip_id: str, segment_id: str) -> dict[str, Any]:
    check_trip_id(trip_id)
    check_segment_id(segment_id)
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=503, detail="ffmpeg is not installed, so clips cannot be cut.")
    with connect() as db:
        row = load_segment(db, trip_id, segment_id)
        sources = json.loads(row["sources"])
        paths = {s["name"]: available(db, trip_id, s["name"]) for s in sources}
    scratch = scratch_dir(trip_id, segment_id)
    for name, path in list(paths.items()):
        if path is None and (scratch / name).is_file():
            paths[name] = scratch / name
    missing = [n for n, p in paths.items() if p is None]
    if missing:
        raise HTTPException(status_code=409, detail=f"Still waiting for: {', '.join(missing)}")

    out_dir = segment_dir(trip_id)
    out_dir.mkdir(parents=True, exist_ok=True)
    files = []
    duration = (row["end_ms"] - row["start_ms"]) / 1000
    for camera, cover in plan(sources, row["start_ms"], row["end_ms"]).items():
        list_file = out_dir / f".{segment_id}-{camera}.txt"
        list_file.write_text("".join(f"file '{paths[s['name']].resolve()}'\n" for s in cover))
        target = out_dir / f"{segment_id}-{camera}.mp4"
        scratch_target = out_dir / f".{segment_id}-{camera}.partial.mp4"
        try:
            await run(cut_command(list_file, scratch_target, (row["start_ms"] - cover[0]["startMs"]) / 1000, duration))
            scratch_target.replace(target)
        finally:
            list_file.unlink(missing_ok=True)
            scratch_target.unlink(missing_ok=True)
        files.append((camera, target, target.stat().st_size))
    shutil.rmtree(scratch, ignore_errors=True)
    with connect() as db:
        db.execute("DELETE FROM segment_files WHERE segment_id = ?", (segment_id,))
        db.executemany("INSERT INTO segment_files (segment_id, camera, stored_path, size) VALUES (?,?,?,?)",
                       [(segment_id, c, str(p), n) for c, p, n in files])
        db.execute("UPDATE segments SET ready_ms = ? WHERE id = ?", (now_ms(), segment_id))
        row = load_segment(db, trip_id, segment_id)
        stored = db.execute("SELECT * FROM segment_files WHERE segment_id = ?", (segment_id,)).fetchall()
    return segment_json(row, stored)


@router.get("/trips/{trip_id}/segments")
def trip_segments(trip_id: str) -> list[dict[str, Any]]:
    check_trip_id(trip_id)
    with connect() as db:
        return list_for(db, [trip_id]).get(trip_id, [])


def segment_path(trip_id: str, segment_id: str, camera: str) -> Path:
    check_trip_id(trip_id)
    check_segment_id(segment_id)
    if camera not in ("front", "rear"):
        raise HTTPException(status_code=400, detail="Invalid camera.")
    with connect() as db:
        row = db.execute(
            "SELECT f.stored_path FROM segment_files f JOIN segments s ON s.id = f.segment_id "
            "WHERE s.trip_id = ? AND f.segment_id = ? AND f.camera = ?", (trip_id, segment_id, camera)).fetchone()
    if row is None or not Path(row["stored_path"]).is_file():
        raise HTTPException(status_code=404, detail="No such clip.")
    return Path(row["stored_path"])


@router.get("/trips/{trip_id}/segments/{segment_id}/{camera}")
def get_segment(trip_id: str, segment_id: str, camera: str) -> FileResponse:
    """The clip's video for one camera. Range requests are honoured, so the player can seek."""
    return FileResponse(segment_path(trip_id, segment_id, camera), media_type="video/mp4")


class SegmentPatch(BaseModel):
    label: Optional[str] = Field(default=None, max_length=120)


@router.patch("/trips/{trip_id}/segments/{segment_id}")
def rename_segment(trip_id: str, segment_id: str, body: SegmentPatch) -> dict[str, Any]:
    check_trip_id(trip_id)
    check_segment_id(segment_id)
    with connect() as db:
        load_segment(db, trip_id, segment_id)
        db.execute("UPDATE segments SET label = ? WHERE id = ?", ((body.label or "").strip() or None, segment_id))
        row = load_segment(db, trip_id, segment_id)
        files = db.execute("SELECT * FROM segment_files WHERE segment_id = ?", (segment_id,)).fetchall()
    return segment_json(row, files)


@router.delete("/trips/{trip_id}/segments/{segment_id}")
def delete_segment(trip_id: str, segment_id: str) -> dict[str, Any]:
    """Removes a saved clip's video. The drive and any whole-drive video stay."""
    check_trip_id(trip_id)
    check_segment_id(segment_id)
    with connect() as db:
        load_segment(db, trip_id, segment_id)
        paths = [Path(r["stored_path"]) for r in db.execute(
            "SELECT stored_path FROM segment_files WHERE segment_id = ?", (segment_id,))]
        db.execute("DELETE FROM segments WHERE id = ?", (segment_id,))
    for p in paths:
        p.unlink(missing_ok=True)
    shutil.rmtree(scratch_dir(trip_id, segment_id), ignore_errors=True)
    return {"deleted": segment_id}


def prune_abandoned(max_age_ms: int = 24 * 3600 * 1000) -> int:
    """Clips started but never cut (a closed tab mid-upload): drop them and their uploads."""
    cutoff = now_ms() - max_age_ms
    with connect() as db:
        rows = db.execute("SELECT id, trip_id FROM segments WHERE ready_ms IS NULL AND created_ms < ?", (cutoff,)).fetchall()
        for r in rows:
            db.execute("DELETE FROM segments WHERE id = ?", (r["id"],))
    for r in rows:
        shutil.rmtree(scratch_dir(r["trip_id"], r["id"]), ignore_errors=True)
    return len(rows)


def video_bytes() -> int:
    with connect() as db:
        return db.execute("SELECT coalesce(sum(size), 0) AS n FROM segment_files").fetchone()["n"]


__all__ = ["router", "init", "list_for", "plan", "cut_command", "segment_path", "prune_abandoned", "video_bytes", "archive"]
