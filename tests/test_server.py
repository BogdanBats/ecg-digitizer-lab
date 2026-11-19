"""API smoke tests for app/server.py (classical CV method, so they run without PyTorch / U-Net weights)."""

from __future__ import annotations

import io

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.server import EXAMPLE_PRESETS, EXAMPLES_DIR, app

client = TestClient(app)


def test_config_lists_methods_layouts_and_dl_status() -> None:
    r = client.get("/api/config")
    assert r.status_code == 200
    cfg = r.json()
    ids = {m["id"] for m in cfg["methods"]}
    assert {"hybrid_ensemble", "krones_hough_cv"} <= ids
    assert any(ly["id"] == "auto" for ly in cfg["layouts"])
    assert "available" in cfg["deep_learning"]


def test_digitize_rejects_unknown_method() -> None:
    r = client.post("/api/digitize", data={"example_name": next(iter(EXAMPLE_PRESETS)), "method": "nope"})
    assert r.status_code == 400


def test_digitize_rejects_bad_rotation_and_missing_input() -> None:
    assert client.post("/api/digitize", data={"method": "krones_hough_cv"}).status_code == 400
    r = client.post("/api/digitize", data={"example_name": next(iter(EXAMPLE_PRESETS)), "rotate_deg": "45"})
    assert r.status_code == 400


def test_digitize_rejects_garbage_upload() -> None:
    files = {"file": ("ecg.jpg", io.BytesIO(b"not an image"), "image/jpeg")}
    r = client.post("/api/digitize", files=files, data={"method": "krones_hough_cv"})
    assert r.status_code == 400


def test_example_path_traversal_is_blocked() -> None:
    r = client.post("/api/digitize", data={"example_name": "../app/server.py", "method": "krones_hough_cv"})
    assert r.status_code == 404


@pytest.mark.skipif(not EXAMPLE_PRESETS, reason="no examples")
def test_digitize_example_with_layout_hint_end_to_end() -> None:
    fname = "photo_2026-11-19_00-37-21.jpg"  # 3×4 + 2 rhythm strips, fast with the classical method
    preset = EXAMPLE_PRESETS[fname]
    r = client.post("/api/digitize", data={
        "example_name": fname,
        "method": "krones_hough_cv",
        "layout": preset["layout_hint"],
        "paper_speed_mm_s": preset["speed_mm_s"],
        "gain_mm_mv": preset["gain_mm_mv"],
    })
    assert r.status_code == 200, r.text
    j = r.json()
    dig, ana = j["digitization"], j["analysis"]
    assert dig["layout"] == "3x4_r2"
    assert isinstance(dig["warnings"], list)
    assert dig["calibration_pulse"]["status"] in ("ok", "mismatch", "not_found")
    assert set(dig["lead_quality"]) == set(dig["leads_mv"])
    assert all(q["level"] in ("ok", "warn", "bad") for q in dig["lead_quality"].values())
    assert {"I", "II", "V6", "II (ритм)", "I (ритм)"} <= set(dig["leads_mv"])
    assert 40 <= ana["global_hr_bpm"] <= 120
    assert dig["visualizations"]["aligned_image"].startswith("data:image/jpeg;base64,")


def test_large_upload_is_downscaled_not_rejected() -> None:
    img = cv2.imread(f"{EXAMPLES_DIR}/photo_2026-11-19_00-37-21.jpg")
    big = cv2.resize(img, None, fx=5.0, fy=5.0, interpolation=cv2.INTER_LINEAR)
    ok, buf = cv2.imencode(".jpg", big, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
    assert ok and max(big.shape[:2]) > 4000
    files = {"file": ("big.jpg", io.BytesIO(buf.tobytes()), "image/jpeg")}
    r = client.post("/api/digitize", files=files, data={"method": "krones_hough_cv", "layout": "3x4_r2"})
    assert r.status_code == 200, r.text
    dig = r.json()["digitization"]
    assert max(dig["alignment"]["original_size"]) <= 4000
    assert any("уменьшено" in w for w in dig["warnings"])


def test_reanalyze_single_lead() -> None:
    t = np.arange(4000) / 500.0
    sig = (1.2 * np.exp(-0.5 * ((t % 0.8 - 0.4) / 0.01) ** 2)).tolist()
    r = client.post("/api/reanalyze_leads", json={"leads_mv": {"II": sig}, "fs": 500.0, "preferred_lead": "II"})
    assert r.status_code == 200
    j = r.json()
    assert j["primary_lead"] == "II"
    assert j["global_hr_bpm"] == pytest.approx(75.0, abs=2.0)


def test_recalculate_calipers_validates_fs() -> None:
    r = client.post("/api/recalculate_calipers", json={"calipers_ms": {"qrs_onset": 0, "t_offset": 400}, "fs": 0})
    assert r.status_code == 400
