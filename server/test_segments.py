"""Saved clips: cutting a short stretch out of a drive's video. Needs ffmpeg (skipped without it)."""
from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from test_archive import TRIP_ID, client, payload  # noqa: F401 -- also points the archive at scratch space
import segments

FFMPEG = shutil.which("ffmpeg") and shutil.which("ffprobe")
FRONT = ["2026_10_11_114532_00.MP4", "2026_10_11_114632_00.MP4"]
REAR = ["2026_10_11_114532_01_b.MP4", "2026_10_11_114632_01_b.MP4"]
T0 = 1_791_000_000_000           # front file 0 starts here (ms); the rear camera's clock runs 700 ms behind
REAR_LAG = 700


@pytest.fixture(scope="module")
def videos() -> dict[str, bytes]:
    """Four 60 s files, tiny HEVC with a keyframe every second, like the camera's."""
    if not FFMPEG:
        pytest.skip("ffmpeg not installed")
    out = {}
    folder = Path(tempfile.mkdtemp(prefix="wolfbox-seg-"))
    for name in FRONT + REAR:
        path = folder / name
        subprocess.run(["ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-f", "lavfi", "-i",
                        "testsrc=size=64x36:rate=10", "-t", "60", "-c:v", "libx265", "-x265-params", "log-level=none",
                        "-g", "10", "-tag:v", "hvc1", str(path)], check=True)
        out[name] = path.read_bytes()
    return out


def clips(videos):
    return [{"name": n, "camera": "front" if n in FRONT else "rear", "kind": "normal", "startLocalMs": 1_000 + i,
             "startMs": T0 + (60_000 * (FRONT + REAR).index(n) % 120_000) + (REAR_LAG if n in REAR else 0),
             "size": len(videos[n])} for i, n in enumerate(FRONT + REAR)]


def sources(videos):
    return [{"name": c["name"], "camera": c["camera"], "startMs": c["startMs"]} for c in clips(videos)]


def duration(path: Path) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
                         capture_output=True, check=True)
    return float(json.loads(out.stdout)["format"]["duration"])


def test_plan_picks_the_files_that_cover_the_window():
    src = [{"name": "a", "camera": "front", "startMs": 0}, {"name": "b", "camera": "front", "startMs": 60_000},
           {"name": "c", "camera": "rear", "startMs": 500}]
    assert [s["name"] for s in segments.plan(src, 45_000, 75_000)["front"]] == ["a", "b"]
    assert [s["name"] for s in segments.plan(src, 61_000, 70_000)["front"]] == ["b"]
    assert "rear" not in segments.plan(src, 61_000, 70_000)


def test_upload_cut_list_serve_and_delete(videos):
    client.post("/api/archive/trips", json=payload(clips=clips(videos)))
    # 30 s spanning the boundary between the two files: 45 s .. 75 s.
    start = T0 + 45_000
    made = client.post(f"/api/archive/trips/{TRIP_ID}/segments",
                       json={"startMs": start, "endMs": start + 30_000, "label": "Hard stop", "sources": sources(videos)})
    assert made.status_code == 200, made.text
    seg = made.json()
    assert sorted(seg["needed"]) == sorted(FRONT + REAR) and seg["cameras"] == ["front", "rear"]

    # Cutting before the sources arrive says what is missing.
    assert client.post(f"/api/archive/trips/{TRIP_ID}/segments/{seg['id']}/cut").status_code == 409
    for name in seg["needed"]:
        r = client.put(f"/api/archive/trips/{TRIP_ID}/segments/{seg['id']}/sources/{name}", content=videos[name])
        assert r.status_code == 200, r.text
    cut = client.post(f"/api/archive/trips/{TRIP_ID}/segments/{seg['id']}/cut")
    assert cut.status_code == 200, cut.text
    assert cut.json()["ready"] and {f["camera"] for f in cut.json()["files"]} == {"front", "rear"}

    # Only the cut is kept: the uploaded 60 s sources are gone.
    assert not segments.scratch_dir(TRIP_ID, seg["id"]).exists()
    for camera in ("front", "rear"):
        assert 29 <= duration(segments.segment_path(TRIP_ID, seg["id"], camera)) <= 31.5

    listed = client.get("/api/archive/trips").json()[0]["segments"]
    assert [(s["id"], s["label"], s["startMs"]) for s in listed] == [(seg["id"], "Hard stop", start)]
    assert client.get(f"/api/archive/trips/{TRIP_ID}").json()["segments"][0]["id"] == seg["id"]
    assert client.get("/api/archive/status").json()["savedClips"] == 1

    ranged = client.get(f"/api/archive/trips/{TRIP_ID}/segments/{seg['id']}/front", headers={"Range": "bytes=0-9"})
    assert ranged.status_code == 206 and len(ranged.content) == 10

    renamed = client.patch(f"/api/archive/trips/{TRIP_ID}/segments/{seg['id']}", json={"label": "Talk about this"})
    assert renamed.json()["label"] == "Talk about this"

    path = segments.segment_path(TRIP_ID, seg["id"], "front")
    assert client.delete(f"/api/archive/trips/{TRIP_ID}/segments/{seg['id']}").status_code == 200
    assert not path.exists()
    assert client.get("/api/archive/trips").json()[0]["segments"] == []


def test_clip_of_a_drive_saved_with_video_needs_no_upload(videos):
    client.post("/api/archive/trips", json=payload(clips=clips(videos)))
    for name in FRONT:
        assert client.put(f"/api/archive/trips/{TRIP_ID}/clips/{name}", content=videos[name]).status_code == 200
    made = client.post(f"/api/archive/trips/{TRIP_ID}/segments", json={
        "startMs": T0 + 10_000, "endMs": T0 + 70_000,
        "sources": [s for s in sources(videos) if s["camera"] == "front"]}).json()
    assert made["needed"] == [] and made["cameras"] == ["front"]
    cut = client.post(f"/api/archive/trips/{TRIP_ID}/segments/{made['id']}/cut").json()
    assert [f["camera"] for f in cut["files"]] == ["front"]
    assert 59 <= duration(segments.segment_path(TRIP_ID, made["id"], "front")) <= 61.5


def test_deleting_the_drive_removes_its_clips(videos):
    client.post("/api/archive/trips", json=payload(clips=clips(videos)))
    made = client.post(f"/api/archive/trips/{TRIP_ID}/segments", json={
        "startMs": T0 + 5_000, "endMs": T0 + 15_000,
        "sources": [s for s in sources(videos) if s["name"] == FRONT[0]]}).json()
    client.put(f"/api/archive/trips/{TRIP_ID}/segments/{made['id']}/sources/{FRONT[0]}", content=videos[FRONT[0]])
    client.post(f"/api/archive/trips/{TRIP_ID}/segments/{made['id']}/cut")
    path = segments.segment_path(TRIP_ID, made["id"], "front")
    client.delete(f"/api/archive/trips/{TRIP_ID}")
    assert not path.exists()


def test_bad_requests_are_refused(videos):
    client.post("/api/archive/trips", json=payload(clips=clips(videos)))
    base = f"/api/archive/trips/{TRIP_ID}/segments"
    too_long = {"startMs": T0, "endMs": T0 + 3_600_000, "sources": sources(videos)}
    assert client.post(base, json=too_long).status_code == 400
    elsewhere = {"startMs": T0 + 500_000, "endMs": T0 + 530_000, "sources": sources(videos)}
    assert client.post(base, json=elsewhere).status_code == 400
    foreign = {"startMs": T0, "endMs": T0 + 10_000,
               "sources": [{"name": "2020_01_01_000000_00.MP4", "camera": "front", "startMs": T0}]}
    assert client.post(base, json=foreign).status_code == 400
    assert client.get(f"{base}/../../x/front").status_code in (400, 404)
    made = client.post(base, json={"startMs": T0, "endMs": T0 + 10_000,
                                   "sources": [s for s in sources(videos) if s["name"] == FRONT[0]]}).json()
    other = client.put(f"{base}/{made['id']}/sources/{REAR[0]}", content=videos[REAR[0]])
    assert other.status_code == 400
