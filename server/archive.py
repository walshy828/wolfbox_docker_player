"""
The drive archive: a home for drives once they leave the SD card.

A dash cam card is a rolling loop, so every drive on it is days or weeks from
being overwritten. Importing a drive copies what the app learned about it --
the 1 Hz GPS track with speed, heading, accelerometer and the speed limit at
each sample, its events, its score and its summary -- into SQLite, and, only if
asked, its video files onto disk. The drive data is small (about 4,000 rows per
hour of driving) and is always kept; the video is large (about 9 GB per hour,
front and rear) and is optional, so a family can keep years of history and
mileage without keeping years of footage.

Everything lives under one directory, `WOLFBOX_DATA` (default `/data`), so the
whole archive is one Docker volume or one bind mount of a NAS share:

    /data/wolfbox.sqlite                     drives, points, events, clips, drivers
    /data/media/YYYY/MM/DD/<trip>/<clip>     video, when imported

Trips are keyed by the app's own trip id, which comes from the first clip's
timestamp, so importing a drive twice updates it rather than duplicating it,
and a clip already on disk at the right size is never uploaded again.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

DATA_DIR = Path(os.environ.get("WOLFBOX_DATA", "/data"))
DB_PATH = DATA_DIR / "wolfbox.sqlite"
MEDIA_DIR = DATA_DIR / "media"

# Trip ids look like 2026-10-11T11-45-32; clip names like 2026_10_11_114532_00.MP4.
TRIP_ID_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$")
CLIP_NAME_RE = re.compile(r"^\d{4}_\d{2}_\d{2}_\d{6}_\d{2}(_b)?\.MP4$", re.IGNORECASE)
# Unlimited roads (an Autobahn) have an infinite limit, which JSON cannot carry.
UNLIMITED_KPH = 9999.0

SCHEMA = """
CREATE TABLE IF NOT EXISTS drivers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  start_local_ms INTEGER NOT NULL,
  end_local_ms INTEGER NOT NULL,
  start_ms INTEGER,
  end_ms INTEGER,
  camera_offset_ms INTEGER,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  has_event INTEGER NOT NULL DEFAULT 0,
  distance_m REAL NOT NULL,
  duration_sec REAL,
  moving_sec REAL,
  max_kph REAL,
  avg_moving_kph REAL,
  score INTEGER,
  band TEXT,
  includes_speeding INTEGER NOT NULL DEFAULT 0,
  over_limit_sec REAL NOT NULL DEFAULT 0,
  hard_events INTEGER NOT NULL DEFAULT 0,
  severe_events INTEGER NOT NULL DEFAULT 0,
  start_label TEXT,
  end_label TEXT,
  start_lat REAL, start_lon REAL, end_lat REAL, end_lon REAL,
  summary TEXT,
  risk TEXT,
  route TEXT,
  imported_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS trips_by_start ON trips(start_local_ms);
CREATE TABLE IF NOT EXISTS points (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  ts_ms INTEGER NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  kph REAL NOT NULL,
  smoothed_kph REAL NOT NULL,
  heading REAL NOT NULL,
  ax INTEGER, ay INTEGER, az INTEGER,
  limit_kph REAL,
  limit_source TEXT,
  PRIMARY KEY (trip_id, idx)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS events (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  peak_at_ms INTEGER,
  lat REAL, lon REAL,
  value REAL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS events_by_trip ON events(trip_id);
CREATE TABLE IF NOT EXISTS clips (
  trip_id TEXT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  camera TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_local_ms INTEGER NOT NULL,
  start_ms INTEGER,
  size INTEGER NOT NULL,
  stored_path TEXT,
  stored_ms INTEGER,
  PRIMARY KEY (trip_id, name)
);
"""


def init() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    with connect() as db:
        db.executescript(SCHEMA)


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    """One connection per request: SQLite in WAL mode handles that well, and it
    sidesteps sharing a connection across FastAPI's worker threads."""
    db = sqlite3.connect(DB_PATH, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def now_ms() -> int:
    return int(time.time() * 1000)


# --- payloads -----------------------------------------------------------------

class PointColumns(BaseModel):
    """The track, column by column -- a third the size of an array of objects."""
    t: list[int]
    lat: list[float]
    lon: list[float]
    kph: list[float]
    skph: list[float]
    hdg: list[float]
    ax: list[int]
    ay: list[int]
    az: list[int]
    limit: list[Optional[float]]
    src: list[Optional[str]]


class EventIn(BaseModel):
    kind: str
    severity: str
    startMs: int
    endMs: int
    peakAtMs: Optional[int] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    value: Optional[float] = None
    detail: Optional[dict[str, Any]] = None


class ClipIn(BaseModel):
    name: str
    camera: str
    kind: str
    startLocalMs: int
    startMs: Optional[int] = None
    size: int


class TripIn(BaseModel):
    id: str
    startLocalMs: int
    endLocalMs: int
    cameraOffsetMs: Optional[int] = None
    hasEvent: bool = False
    driverId: Optional[int] = None
    summary: dict[str, Any]
    risk: Optional[dict[str, Any]] = None
    route: list[list[float]] = Field(default_factory=list)
    startLabel: Optional[str] = None
    endLabel: Optional[str] = None
    points: PointColumns
    events: list[EventIn] = Field(default_factory=list)
    clips: list[ClipIn] = Field(default_factory=list)


class TripPatch(BaseModel):
    driverId: Optional[int] = None


class DriverIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)


# --- helpers ------------------------------------------------------------------

def check_trip_id(trip_id: str) -> None:
    if not TRIP_ID_RE.match(trip_id):
        raise HTTPException(status_code=400, detail="Invalid trip id.")


def check_clip_name(name: str) -> None:
    if not CLIP_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="Invalid clip name.")


def trip_media_dir(trip_id: str) -> Path:
    """`media/2026/10/11/2026-10-11T11-45-32/` -- browsable by date on the NAS."""
    return MEDIA_DIR / trip_id[0:4] / trip_id[5:7] / trip_id[8:10] / trip_id


def harsh_counts(events: list[EventIn]) -> tuple[int, int]:
    harsh = [e for e in events if e.kind in ("braking", "acceleration", "cornering")]
    return len(harsh), sum(1 for e in harsh if e.severity == "severe")


def trip_row_to_json(row: sqlite3.Row, clips: list[sqlite3.Row]) -> dict[str, Any]:
    summary = json.loads(row["summary"] or "{}")
    return {
        "id": row["id"],
        "startLocalMs": row["start_local_ms"],
        "endLocalMs": row["end_local_ms"],
        "startMs": row["start_ms"],
        "endMs": row["end_ms"],
        "cameraOffsetMs": row["camera_offset_ms"],
        "driverId": row["driver_id"],
        "driverName": row["driver_name"],
        "hasEvent": bool(row["has_event"]),
        "distanceMeters": row["distance_m"],
        "durationSec": row["duration_sec"],
        "movingSec": row["moving_sec"],
        "maxSpeedKph": row["max_kph"],
        "averageMovingSpeedKph": row["avg_moving_kph"],
        "hardEvents": row["hard_events"],
        "severeEvents": row["severe_events"],
        "overLimitSec": row["over_limit_sec"],
        "startLabel": row["start_label"],
        "endLabel": row["end_label"],
        "summary": summary,
        "risk": json.loads(row["risk"]) if row["risk"] else None,
        "route": json.loads(row["route"] or "[]"),
        "importedMs": row["imported_ms"],
        "clips": [
            {
                "name": c["name"],
                "camera": c["camera"],
                "kind": c["kind"],
                "startLocalMs": c["start_local_ms"],
                "startMs": c["start_ms"],
                "size": c["size"],
                "stored": c["stored_path"] is not None,
            }
            for c in clips
        ],
    }


TRIP_SELECT = """
SELECT trips.*, drivers.name AS driver_name
FROM trips LEFT JOIN drivers ON drivers.id = trips.driver_id
"""


def load_trip(db: sqlite3.Connection, trip_id: str) -> dict[str, Any]:
    row = db.execute(TRIP_SELECT + " WHERE trips.id = ?", (trip_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="No such drive in the archive.")
    clips = db.execute(
        "SELECT * FROM clips WHERE trip_id = ? ORDER BY start_local_ms, camera", (trip_id,)
    ).fetchall()
    return trip_row_to_json(row, clips)


def stored_clip_path(trip_id: str, name: str) -> Path:
    """Where an imported clip's video lives, or a 404 when it was never stored."""
    check_trip_id(trip_id)
    check_clip_name(name)
    with connect() as db:
        row = db.execute(
            "SELECT stored_path FROM clips WHERE trip_id = ? AND name = ?", (trip_id, name)
        ).fetchone()
    if row is None or row["stored_path"] is None:
        raise HTTPException(status_code=404, detail="That clip's video was not archived.")
    path = Path(row["stored_path"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="That clip's video is missing from the archive.")
    return path


# --- routes -------------------------------------------------------------------

router = APIRouter(prefix="/api/archive")


@router.get("/status")
def status() -> dict[str, Any]:
    with connect() as db:
        trips = db.execute("SELECT COUNT(*) FROM trips").fetchone()[0]
        clips = db.execute(
            "SELECT COUNT(*), COALESCE(SUM(size), 0) FROM clips WHERE stored_path IS NOT NULL"
        ).fetchone()
    usage = shutil.disk_usage(DATA_DIR)
    return {
        "enabled": True,
        "trips": trips,
        "storedClips": clips[0],
        "videoBytes": clips[1],
        "freeBytes": usage.free,
    }


@router.get("/drivers")
def list_drivers() -> list[dict[str, Any]]:
    with connect() as db:
        rows = db.execute("SELECT id, name FROM drivers ORDER BY name").fetchall()
    return [{"id": r["id"], "name": r["name"]} for r in rows]


@router.post("/drivers")
def add_driver(driver: DriverIn) -> dict[str, Any]:
    name = driver.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="A driver needs a name.")
    with connect() as db:
        db.execute(
            "INSERT INTO drivers (name, created_ms) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
            (name, now_ms()),
        )
        row = db.execute("SELECT id, name FROM drivers WHERE name = ?", (name,)).fetchone()
    return {"id": row["id"], "name": row["name"]}


@router.get("/trips")
def list_trips() -> list[dict[str, Any]]:
    """Every archived drive with its summary -- not its track, which is fetched per drive."""
    with connect() as db:
        rows = db.execute(TRIP_SELECT + " ORDER BY trips.start_local_ms DESC").fetchall()
        clips = db.execute("SELECT * FROM clips ORDER BY start_local_ms, camera").fetchall()
    by_trip: dict[str, list[sqlite3.Row]] = {}
    for clip in clips:
        by_trip.setdefault(clip["trip_id"], []).append(clip)
    return [trip_row_to_json(row, by_trip.get(row["id"], [])) for row in rows]


@router.post("/trips")
def import_trip(trip: TripIn) -> dict[str, Any]:
    """
    Stores a drive's data, replacing whatever an earlier import stored for it.

    Clip rows are upserted rather than replaced so video already on disk stays
    attached; the response names those clips so the client uploads only the rest.
    """
    check_trip_id(trip.id)
    for clip in trip.clips:
        check_clip_name(clip.name)
    p = trip.points
    n = len(p.t)
    if any(len(column) != n for column in (p.lat, p.lon, p.kph, p.skph, p.hdg, p.ax, p.ay, p.az, p.limit, p.src)):
        raise HTTPException(status_code=400, detail="Point columns have different lengths.")

    s = trip.summary
    risk = trip.risk or {}
    speeding = risk.get("speeding") or {}
    hard, severe = harsh_counts(trip.events)
    start = s.get("start") or {}
    end = s.get("end") or {}
    stamp = now_ms()

    with connect() as db:
        existing = db.execute("SELECT imported_ms, driver_id FROM trips WHERE id = ?", (trip.id,)).fetchone()
        driver_id = trip.driverId if trip.driverId is not None else (existing["driver_id"] if existing else None)
        values = (
            trip.startLocalMs, trip.endLocalMs, s.get("startMs"), s.get("endMs"), trip.cameraOffsetMs,
            driver_id, int(trip.hasEvent), float(s.get("distanceMeters", 0)), s.get("durationSec"),
            s.get("movingSec"), s.get("maxSpeedKph"), s.get("averageMovingSpeedKph"),
            risk.get("score"), risk.get("band"), int(bool(risk.get("includesSpeeding"))),
            float(speeding.get("stretchSec", 0)), hard, severe, trip.startLabel, trip.endLabel,
            start.get("latitude"), start.get("longitude"), end.get("latitude"), end.get("longitude"),
            json.dumps(s), json.dumps(trip.risk) if trip.risk else None, json.dumps(trip.route), stamp,
        )
        if existing:
            db.execute(
                """UPDATE trips SET start_local_ms=?, end_local_ms=?, start_ms=?, end_ms=?, camera_offset_ms=?,
                   driver_id=?, has_event=?, distance_m=?, duration_sec=?, moving_sec=?, max_kph=?,
                   avg_moving_kph=?, score=?, band=?, includes_speeding=?, over_limit_sec=?, hard_events=?,
                   severe_events=?, start_label=?, end_label=?, start_lat=?, start_lon=?, end_lat=?, end_lon=?,
                   summary=?, risk=?, route=?, updated_ms=? WHERE id=?""",
                (*values, trip.id),
            )
        else:
            db.execute(
                """INSERT INTO trips (start_local_ms, end_local_ms, start_ms, end_ms, camera_offset_ms,
                   driver_id, has_event, distance_m, duration_sec, moving_sec, max_kph, avg_moving_kph,
                   score, band, includes_speeding, over_limit_sec, hard_events, severe_events, start_label,
                   end_label, start_lat, start_lon, end_lat, end_lon, summary, risk, route, updated_ms,
                   id, imported_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (*values, trip.id, stamp),
            )

        db.execute("DELETE FROM points WHERE trip_id = ?", (trip.id,))
        db.executemany(
            """INSERT INTO points (trip_id, idx, ts_ms, lat, lon, kph, smoothed_kph, heading, ax, ay, az,
               limit_kph, limit_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                (trip.id, i, p.t[i], p.lat[i], p.lon[i], p.kph[i], p.skph[i], p.hdg[i],
                 p.ax[i], p.ay[i], p.az[i], p.limit[i], p.src[i])
                for i in range(n)
            ),
        )

        db.execute("DELETE FROM events WHERE trip_id = ?", (trip.id,))
        db.executemany(
            """INSERT INTO events (trip_id, kind, severity, start_ms, end_ms, peak_at_ms, lat, lon, value, detail)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (
                (trip.id, e.kind, e.severity, e.startMs, e.endMs, e.peakAtMs, e.lat, e.lon, e.value,
                 json.dumps(e.detail) if e.detail else None)
                for e in trip.events
            ),
        )

        names = [c.name for c in trip.clips]
        if names:
            db.execute(
                f"DELETE FROM clips WHERE trip_id = ? AND name NOT IN ({','.join('?' * len(names))})",
                (trip.id, *names),
            )
        for c in trip.clips:
            db.execute(
                """INSERT INTO clips (trip_id, name, camera, kind, start_local_ms, start_ms, size)
                   VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(trip_id, name) DO UPDATE SET camera=excluded.camera, kind=excluded.kind,
                   start_local_ms=excluded.start_local_ms, start_ms=excluded.start_ms,
                   stored_path=CASE WHEN clips.size = excluded.size THEN clips.stored_path END,
                   size=excluded.size""",
                (trip.id, c.name, c.camera, c.kind, c.startLocalMs, c.startMs, c.size),
            )
        stored = [
            r["name"] for r in db.execute(
                "SELECT name FROM clips WHERE trip_id = ? AND stored_path IS NOT NULL", (trip.id,)
            )
        ]
    return {"id": trip.id, "created": existing is None, "storedClips": stored}


@router.get("/trips/{trip_id}")
def get_trip(trip_id: str) -> dict[str, Any]:
    check_trip_id(trip_id)
    with connect() as db:
        return load_trip(db, trip_id)


@router.get("/trips/{trip_id}/points")
def get_points(trip_id: str) -> dict[str, Any]:
    check_trip_id(trip_id)
    with connect() as db:
        rows = db.execute(
            "SELECT * FROM points WHERE trip_id = ? ORDER BY idx", (trip_id,)
        ).fetchall()
        if not rows and db.execute("SELECT 1 FROM trips WHERE id = ?", (trip_id,)).fetchone() is None:
            raise HTTPException(status_code=404, detail="No such drive in the archive.")
    return {
        "t": [r["ts_ms"] for r in rows],
        "lat": [r["lat"] for r in rows],
        "lon": [r["lon"] for r in rows],
        "kph": [r["kph"] for r in rows],
        "skph": [r["smoothed_kph"] for r in rows],
        "hdg": [r["heading"] for r in rows],
        "ax": [r["ax"] for r in rows],
        "ay": [r["ay"] for r in rows],
        "az": [r["az"] for r in rows],
        "limit": [r["limit_kph"] for r in rows],
        "src": [r["limit_source"] for r in rows],
    }


@router.patch("/trips/{trip_id}")
def patch_trip(trip_id: str, patch: TripPatch) -> dict[str, Any]:
    check_trip_id(trip_id)
    with connect() as db:
        if patch.driverId is not None and db.execute(
            "SELECT 1 FROM drivers WHERE id = ?", (patch.driverId,)
        ).fetchone() is None:
            raise HTTPException(status_code=400, detail="No such driver.")
        updated = db.execute(
            "UPDATE trips SET driver_id = ?, updated_ms = ? WHERE id = ?",
            (patch.driverId, now_ms(), trip_id),
        ).rowcount
        if not updated:
            raise HTTPException(status_code=404, detail="No such drive in the archive.")
        return load_trip(db, trip_id)


@router.delete("/trips/{trip_id}")
def delete_trip(trip_id: str) -> dict[str, Any]:
    """Removes a drive, its data and any video stored for it."""
    check_trip_id(trip_id)
    with connect() as db:
        deleted = db.execute("DELETE FROM trips WHERE id = ?", (trip_id,)).rowcount
    if not deleted:
        raise HTTPException(status_code=404, detail="No such drive in the archive.")
    shutil.rmtree(trip_media_dir(trip_id), ignore_errors=True)
    return {"deleted": trip_id}


@router.put("/trips/{trip_id}/clips/{name}")
async def upload_clip(trip_id: str, name: str, request: Request) -> dict[str, Any]:
    """
    Stores one clip's video. The drive must be imported first, so the clip row
    -- and the size it should have -- already exists.

    Streamed to a scratch file and renamed into place only once complete and the
    right size, so an interrupted upload never leaves a truncated video that
    later passes for a stored one.
    """
    check_trip_id(trip_id)
    check_clip_name(name)
    with connect() as db:
        row = db.execute(
            "SELECT size, stored_path FROM clips WHERE trip_id = ? AND name = ?", (trip_id, name)
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Import the drive before its clips.")
    if row["stored_path"] and Path(row["stored_path"]).is_file() \
            and Path(row["stored_path"]).stat().st_size == row["size"]:
        return {"name": name, "stored": True, "skipped": True}

    folder = trip_media_dir(trip_id)
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / name
    scratch = folder / f".{name}.partial"
    written = 0
    try:
        with open(scratch, "wb") as handle:
            async for chunk in request.stream():
                handle.write(chunk)
                written += len(chunk)
        if written != row["size"]:
            raise HTTPException(
                status_code=400,
                detail=f"Upload was {written} bytes; the clip is {row['size']}.",
            )
        scratch.replace(target)
    finally:
        scratch.unlink(missing_ok=True)

    with connect() as db:
        db.execute(
            "UPDATE clips SET stored_path = ?, stored_ms = ? WHERE trip_id = ? AND name = ?",
            (str(target), now_ms(), trip_id, name),
        )
    return {"name": name, "stored": True, "skipped": False}


@router.get("/trips/{trip_id}/clips/{name}")
def get_clip(trip_id: str, name: str) -> FileResponse:
    """The original video. Range requests are honoured, so the player can seek."""
    return FileResponse(stored_clip_path(trip_id, name), media_type="video/mp4")
