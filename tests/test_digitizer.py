"""Unit tests for grid calibration and row-count selection in app/core/digitizer.py (synthetic images)."""

from __future__ import annotations

import numpy as np
import pytest

from app.core.digitizer import (
    _viterbi_forward_numba,
    estimate_pixel_spacing_mm,
    fast_pixel_size_finder,
    joint_isotropic_grid_search,
    select_row_count,
)


def synthetic_grid_map(px_per_mm: float, h: int, w: int, minor: float = 0.35, major: float = 1.0) -> np.ndarray:
    """Probability-like grid map: thin 1-mm lines plus stronger 5-mm lines, with mild noise."""
    rng = np.random.default_rng(0)
    g = 0.03 * rng.random((h, w)).astype(np.float32)
    for k in range(int(max(h, w) / px_per_mm) + 2):
        pos = k * px_per_mm
        val = major if k % 5 == 0 else minor
        yi, xi = int(round(pos)), int(round(pos))
        if yi < h:
            g[yi, :] = np.maximum(g[yi, :], val)
        if xi < w:
            g[:, xi] = np.maximum(g[:, xi], val)
    return g


@pytest.mark.parametrize("px_per_mm,size", [(2.9, (420, 860)), (4.3, (700, 900)), (7.9, (650, 820)), (9.6, (900, 950))])
def test_joint_grid_search_recovers_scale_including_close_ups(px_per_mm: float, size: tuple) -> None:
    h, w = size
    g = synthetic_grid_map(px_per_mm, h, w)
    res = joint_isotropic_grid_search(g[int(0.1 * h):int(0.9 * h), int(0.1 * w):int(0.9 * w)], full_width_px=float(w))
    assert res is not None
    px_x, px_y = res
    assert px_x == pytest.approx(px_per_mm, rel=0.03)
    assert px_y == pytest.approx(px_per_mm, rel=0.03)


def test_close_up_is_out_of_range_for_original_pixel_size_finder_but_not_for_estimator() -> None:
    # ~95 mm of paper at 9.6 px/mm: fewer than 18 major squares in view -> outside the original search range
    g = synthetic_grid_map(9.6, 900, 950)
    sub = g[90:810, 95:855]
    mm_x, _ = fast_pixel_size_finder(sub)
    assert abs(1.0 / mm_x - 9.6) / 9.6 > 0.10  # the legacy range locks onto a wrong period
    sp = estimate_pixel_spacing_mm(g, np.zeros((900, 950, 3), np.uint8))
    assert sp["method"] == "joint_grid_search"
    assert sp["px_per_mm"] == pytest.approx(9.6, rel=0.03)


def synthetic_rows_sig_map(n_rows: int, h: int = 800, w: int = 1000) -> np.ndarray:
    """Ink map with `n_rows` horizontal ECG-like traces (baseline + periodic spikes)."""
    sig = np.zeros((h, w), np.float32)
    top, bottom = int(0.1 * h), int(0.9 * h)
    ys = np.linspace(top, bottom, n_rows).astype(int) if n_rows > 1 else np.array([h // 2])
    xs = np.arange(w)
    for y in ys:
        trace = y - (np.abs(((xs % 160) - 80)) < 4) * 25
        for x, ty in zip(xs, trace):
            sig[max(0, ty - 1):ty + 2, x] = 1.0
    return sig


@pytest.mark.parametrize("n_rows", [3, 4, 5, 6, 12])
def test_select_row_count(n_rows: int) -> None:
    best, baselines, scores = select_row_count(synthetic_rows_sig_map(n_rows))
    assert best == n_rows, scores
    assert len(baselines) == n_rows


def test_select_row_count_rejects_physically_too_dense_rows() -> None:
    # 12 rows in 800 px at 10 px/mm would be ~6 mm apart: implausible at 10 mm/mV -> must not pick 12
    sig = synthetic_rows_sig_map(6)
    best, _, scores = select_row_count(sig, px_per_mm_y=10.0, gain_mm_mv=10.0)
    assert best == 6
    assert scores[12] < scores[6]


@pytest.mark.skipif(_viterbi_forward_numba is None, reason="numba not installed")
def test_numba_viterbi_matches_numpy_reference() -> None:
    rng = np.random.default_rng(1)
    H, W = 60, 80
    reward = rng.normal(size=(H, W))
    blank = np.cumsum(rng.random((H, W)) < 0.5, axis=0).astype(np.float64)
    mask = rng.random(W) < 0.3
    offsets = np.concatenate([np.arange(-48, -14, 2), np.arange(-14, 15), np.arange(16, 49, 2)]).astype(np.int32)
    idx = np.clip(np.arange(H)[:, None] - offsets[None, :], 0, H - 1).astype(np.int32)
    pq = 0.025 * (np.abs(offsets) / 8.0) ** 1.35
    pn = 0.085 * (np.abs(offsets) / 6.0) ** 1.6

    dp_ref = np.zeros((H, W))
    bp_ref = np.zeros((H, W), np.int32)
    dp_ref[:, 0] = reward[:, 0]
    rows = np.arange(H)
    for x in range(1, W):
        pen = pq if mask[x] else pn
        cs = blank[:, x]
        cands = dp_ref[idx, x - 1] - pen[None, :] - 0.42 * np.abs(cs[:, None] - cs[idx])
        m = np.argmax(cands, axis=1)
        dp_ref[:, x] = reward[:, x] + cands[rows, m]
        bp_ref[:, x] = idx[rows, m]

    dp = np.zeros((H, W))
    bp = np.zeros((H, W), np.int32)
    dp[:, 0] = reward[:, 0]
    _viterbi_forward_numba(dp, bp, reward, blank, mask, idx, pq.astype(np.float64), pn.astype(np.float64))
    assert np.array_equal(bp, bp_ref)
    assert np.allclose(dp, dp_ref)


# ----------------------------------------------------------------------------- calibration pulse & lead quality
from app.core.digitizer import (  # noqa: E402
    assess_lead_quality,
    classical_grid_and_signal_maps,
    detect_calibration_pulses,
    remove_pulses_from_leads,
    summarize_calibration_pulses,
)


def synthetic_sheet_with_pulses(px_per_mm: float, pulse_mm: float, n_rows: int = 4, w: int = 1000, h: int = 700) -> np.ndarray:
    """White paper, pink 1/5-mm grid, black traces with a 1-mV pulse (height `pulse_mm`, 5 mm wide) at row starts."""
    import cv2

    img = np.full((h, w, 3), 252, np.uint8)
    for k in range(int(max(h, w) / px_per_mm) + 1):
        pos = int(round(k * px_per_mm))
        col = (240, 150, 160) if k % 5 == 0 else (250, 215, 220)
        if pos < w:
            img[:, pos] = col
        if pos < h:
            img[pos, :] = col
    ys = np.linspace(0.18 * h, 0.85 * h, n_rows).astype(int)
    ph, pw = int(round(pulse_mm * px_per_mm)), int(round(5 * px_per_mm))
    for y in ys:
        x0 = int(0.04 * w)
        pts = [(x0, y), (x0 + 8, y), (x0 + 8, y - ph), (x0 + 8 + pw, y - ph), (x0 + 8 + pw, y), (w - 10, y)]
        cv2.polylines(img, [np.array(pts, np.int32)], False, (20, 20, 20), 2, cv2.LINE_8)
    return img


@pytest.mark.parametrize("pulse_mm", [10.0, 5.0])
def test_calibration_pulses_are_found_and_measured(pulse_mm: float) -> None:
    img = synthetic_sheet_with_pulses(4.0, pulse_mm)
    ink, _ = classical_grid_and_signal_maps(img)
    pulses = detect_calibration_pulses(ink, 4.0, 4.0)
    assert len(pulses) == 4
    for pl in pulses:
        assert pl["height_mm"] == pytest.approx(pulse_mm, rel=0.08)
    summary = summarize_calibration_pulses(pulses, gain_mm_mv=10.0)
    if pulse_mm == 10.0:
        assert summary["status"] == "ok"
    else:
        assert summary["status"] == "mismatch"
        assert summary["suggested_gain_mm_mv"] == 5.0


def test_no_pulses_on_plain_grid_and_traces() -> None:
    img = synthetic_sheet_with_pulses(4.0, 10.0)
    img[:, : int(0.2 * img.shape[1])] = 252  # wipe the pulses (left margin), keep grid squares elsewhere
    ink, _ = classical_grid_and_signal_maps(img)
    assert detect_calibration_pulses(ink, 4.0, 4.0) == []
    assert summarize_calibration_pulses([], 10.0)["status"] == "not_found"


def test_shorter_broken_pulse_does_not_win_a_tie() -> None:
    pulses = [{"height_mm": 9.6}, {"height_mm": 4.5}]
    assert summarize_calibration_pulses(pulses, 10.0)["height_mm"] == pytest.approx(9.6)


def test_pulse_inside_a_traced_strip_is_bridged_out_of_the_signal() -> None:
    sig = [0.0] * 100 + [1.0] * 20 + [0.0] * 380  # 1-mV square near the start of a 500-sample lead
    leads = {"V5": list(sig)}
    traces = [{"lead": "V5", "x_range_px": [0, 500], "baseline_y_px": 200.0}]
    pulse = {"x_px": [100, 120], "top_px": 160, "bottom_px": 200}
    assert remove_pulses_from_leads([pulse], traces, leads) == ["V5"]
    assert max(abs(v) for v in leads["V5"]) < 0.05


def test_lead_quality_levels() -> None:
    good = assess_lead_quality({"ink_support": 0.98, "edge_hits": 0.0, "neighbor_overlap": 0.0, "displaced": 0.0}, [0, 1.2, -0.3, 0])
    jumped = assess_lead_quality({"ink_support": 0.4, "edge_hits": 0.0, "neighbor_overlap": 0.35, "displaced": 0.4}, [0, 2.0, 0])
    flat = assess_lead_quality({"ink_support": 0.99, "edge_hits": 0.0, "neighbor_overlap": 0.0, "displaced": 0.0}, [0.0, 0.02, 0.0])
    assert good["level"] == "ok" and not good["issues"]
    assert jumped["level"] == "bad" and len(jumped["issues"]) >= 2
    assert flat["level"] in ("warn", "bad")
