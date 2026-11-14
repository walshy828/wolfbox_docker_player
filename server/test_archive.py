"""Tests for the drive archive. Run with `pytest` from server/ (see requirements-dev.txt)."""
from __future__ import annotations

import os
import tempfile

# Point the archive and caches at scratch space before the app is imported.
_scratch = tempfile.mkdtemp(prefix="wolfbox-test-")
os.environ["WOLFBOX_DATA"] = os.path.join(_scratch, "data")
os.environ["WOLFBOX_CACHE"] = os.path.join(_scratch, "cache")
os.environ["WOLFBOX_OVERPASS_URLS"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import archive  # noqa: E402
from app import app  # noqa: E402

client = TestClient(app)

TRIP_ID = "2026-10-11T11-45-32"
FRONT = "2026_10_11_114532_00.MP4"
REAR = "2026_10_11_114532_01_b.MP4"


def payload(**over):
    n = 3
    body = {
        "id": TRIP_ID,
        "startLocalMs": 1_000,
        "endLocalMs": 61_000,
        "cameraOffsetMs": -28_800_000,
        "hasEvent": False,
        "summary": {
            "startMs": 2_000, "endMs": 4_000, "durationSec": 2, "movingSec": 2,
            "distanceMeters": 3218.7, "averageMovingSpeedKph": 60, "maxSpeedKph": 104,
            "histogramMph": [0, 0, 1, 1, 0],
            "start": {"latitude": 42.3, "longitude": -71.5}, "end": {"latitude": 42.31, "longitude": -71.49},
        },
        "risk": {
            "score": 84, "band": "moderate", "includesSpeeding": True, "factors": [],
            "speeding": {"stretchSec": 48, "stretchCount": 2},
        },
        "route": [[42.3, -71.5, 0], [42.31, -71.49, 64]],
        "startLabel": "Turnpike Road", "endLabel": "Cordaville Road",
        "points": {
            "t": [2_000, 3_000, 4_000], "lat": [42.3, 42.305, 42.31], "lon": [-71.5, -71.495, -71.49],
            "kph": [0, 104, 103], "skph": [0, 103.9, 103], "hdg": [255.8, 256, 255.5],
            "ax": [-180] * n, "ay": [5] * n, "az": [165] * n,
            "limit": [None, 80.5, archive.UNLIMITED_KPH], "src": [None, "tagged", "tagged"],
        },
        "events": [
            {"kind": "braking", "severity": "severe", "startMs": 3_000, "endMs": 4_000, "value": -0.6},
            {"kind": "speeding", "severity": "moderate", "startMs": 2_000, "endMs": 4_000, "value": 15},
        ],
        "clips": [
            {"name": FRONT, "camera": "front", "kind": "normal", "startLocalMs": 1_000, "startMs": 2_000, "size": 5},
            {"name": REAR, "camera": "rear", "kind": "normal", "startLocalMs": 1_000, "startMs": 1_500, "size": 3},
        ],
    }
    body.update(over)
    return body


@pytest.fixture(autouse=True)
def clean_archive():
    client.delete(f"/api/archive/trips/{TRIP_ID}")
    yield


def test_import_then_list_and_read_back():
    response = client.post("/api/archive/trips", json=payload())
    assert response.status_code == 200
    assert response.json() == {"id": TRIP_ID, "created": True, "storedClips": []}

    trips = client.get("/api/archive/trips").json()
    assert [t["id"] for t in trips] == [TRIP_ID]
    trip = trips[0]
    assert trip["risk"]["score"] == 84
    assert trip["overLimitSec"] == 48
    assert trip["hardEvents"] == 1 and trip["severeEvents"] == 1
    assert trip["startLabel"] == "Turnpike Road"
    assert [c["stored"] for c in trip["clips"]] == [False, False]

    points = client.get(f"/api/archive/trips/{TRIP_ID}/points").json()
    assert points["t"] == [2_000, 3_000, 4_000]
    assert points["limit"] == [None, 80.5, archive.UNLIMITED_KPH]
    assert points["ay"] == [5, 5, 5]


def test_reimport_updates_rather_than_duplicates():
    client.post("/api/archive/trips", json=payload())
    again = client.post("/api/archive/trips", json=payload(startLabel="Elsewhere"))
    assert again.json()["created"] is False
    trips = client.get("/api/archive/trips").json()
    assert len(trips) == 1 and trips[0]["startLabel"] == "Elsewhere"


def test_mismatched_point_columns_are_refused():
    body = payload()
    body["points"]["lat"] = body["points"]["lat"][:2]
    assert client.post("/api/archive/trips", json=body).status_code == 400


def test_hostile_ids_and_names_are_refused():
    assert client.post("/api/archive/trips", json=payload(id="../../etc")).status_code == 400
    assert client.put(f"/api/archive/trips/{TRIP_ID}/clips/..%2Fx.MP4", content=b"x").status_code in (400, 404)
    assert client.get("/api/archive/trips/nope/points").status_code == 400


def test_clip_upload_store_skip_and_serve_with_ranges():
    client.post("/api/archive/trips", json=payload())

    # Before the drive has the clip, or at the wrong size, nothing is stored.
    short = client.put(f"/api/archive/trips/{TRIP_ID}/clips/{FRONT}", content=b"abc")
    assert short.status_code == 400
    assert client.get(f"/api/archive/trips/{TRIP_ID}/clips/{FRONT}").status_code == 404

    stored = client.put(f"/api/archive/trips/{TRIP_ID}/clips/{FRONT}", content=b"hello")
    assert stored.json() == {"name": FRONT, "stored": True, "skipped": False}
    assert client.put(f"/api/archive/trips/{TRIP_ID}/clips/{FRONT}", content=b"hello").json()["skipped"] is True

    path = archive.trip_media_dir(TRIP_ID) / FRONT
    assert path.read_bytes() == b"hello"
    assert "2026/10/11" in str(path)

    whole = client.get(f"/api/archive/trips/{TRIP_ID}/clips/{FRONT}")
    assert whole.content == b"hello"
    part = client.get(f"/api/archive/trips/{TRIP_ID}/clips/{FRONT}", headers={"Range": "bytes=1-3"})
    assert part.status_code == 206 and part.content == b"ell"

    # Re-importing keeps the stored video attached and says so.
    assert client.post("/api/archive/trips", json=payload()).json()["storedClips"] == [FRONT]


def test_upload_before_import_is_refused():
    assert client.put(f"/api/archive/trips/{TRIP_ID}/clips/{FRONT}", content=b"hello").status_code == 404


def test_drivers_and_tagging():
    client.post("/api/archive/trips", json=payload())
    alex = client.post("/api/archive/drivers", json={"name": "Alex"}).json()
    again = client.post("/api/archive/drivers", json={"name": "alex"}).json()
    assert again["id"] == alex["id"], "names are unique regardless of case"

    tagged = client.patch(f"/api/archive/trips/{TRIP_ID}", json={"driverId": alex["id"]}).json()
    assert tagged["driverName"] == "Alex"
    assert client.patch(f"/api/archive/trips/{TRIP_ID}", json={"driverId": 9999}).status_code == 400

    # An import that does not name a driver keeps the one already set.
    client.post("/api/archive/trips", json=payload())
    assert client.get(f"/api/archive/trips/{TRIP_ID}").json()["driverName"] == "Alex"


def test_delete_removes_data_and_video():
    client.post("/api/archive/trips", json=payload())
    client.put(f"/api/archive/trips/{TRIP_ID}/clips/{FRONT}", content=b"hello")
    assert client.delete(f"/api/archive/trips/{TRIP_ID}").status_code == 200
    assert client.get(f"/api/archive/trips/{TRIP_ID}").status_code == 404
    assert not archive.trip_media_dir(TRIP_ID).exists()
    assert client.get(f"/api/archive/trips/{TRIP_ID}/points").status_code == 404


def test_status_counts():
    client.post("/api/archive/trips", json=payload())
    client.put(f"/api/archive/trips/{TRIP_ID}/clips/{REAR}", content=b"abc")
    status = client.get("/api/archive/status").json()
    assert status["trips"] == 1 and status["storedClips"] == 1 and status["videoBytes"] == 3
