"""Unit tests for the clinical ECG math (app/core/ecg_analysis.py) on synthetic signals with known answers."""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.core.ecg_analysis import analyze_all_leads, compute_intervals_from_calipers

FS = 500.0


def _gauss(t: np.ndarray, center_s: float, width_s: float, amp_mv: float) -> np.ndarray:
    return amp_mv * np.exp(-0.5 * ((t - center_s) / width_s) ** 2)


def synthetic_beat_train(qrs_scale: float = 1.0, t_scale: float = 1.0, p_scale: float = 1.0,
                         rr_s: float = 1.0, n_beats: int = 8) -> np.ndarray:
    """Sum of Gaussian P / Q / R / S / T waves; amplitudes scaled per lead (dipole projection)."""
    dur = rr_s * n_beats
    t = np.arange(int(round(dur * FS))) / FS
    sig = np.zeros_like(t)
    for k in range(n_beats):
        r = 0.5 * rr_s + k * rr_s
        sig += p_scale * _gauss(t, r - 0.16, 0.022, 0.15)
        sig += qrs_scale * (_gauss(t, r - 0.025, 0.007, -0.10) + _gauss(t, r, 0.010, 1.20) + _gauss(t, r + 0.028, 0.008, -0.25))
        sig += t_scale * _gauss(t, r + 0.26, 0.045, 0.30)
    return sig


def limb_leads_for_axis(alpha_deg: float) -> dict:
    """Projects a frontal-plane dipole at `alpha_deg` onto Einthoven / Goldberger leads."""
    a = math.radians(alpha_deg)
    proj = {
        "I": math.cos(a),
        "II": math.cos(a - math.radians(60)),
        "III": math.cos(a - math.radians(120)),
    }
    proj["aVR"] = -(proj["I"] + proj["II"]) / 2.0
    proj["aVL"] = (proj["I"] - proj["III"]) / 2.0
    proj["aVF"] = (proj["II"] + proj["III"]) / 2.0
    return {ln: synthetic_beat_train(qrs_scale=s, t_scale=s, p_scale=s).tolist() for ln, s in proj.items()}


@pytest.mark.parametrize("alpha", [-45.0, 0.0, 30.0, 60.0, 75.0, 120.0])
def test_qrs_axis_matches_dipole_direction(alpha: float) -> None:
    res = analyze_all_leads(limb_leads_for_axis(alpha), fs=FS)
    axis = res["axes"]["qrs_axis_deg"]
    assert axis is not None
    # Same dipole for P, QRS and T in the synthetic model → all three axes coincide with alpha
    assert axis == pytest.approx(alpha, abs=6.0)
    assert res["axes"]["t_axis_deg"] == pytest.approx(alpha, abs=6.0)


def test_heart_rate_and_rr_from_regular_rhythm() -> None:
    leads = {"II": synthetic_beat_train(rr_s=0.8).tolist()}
    res = analyze_all_leads(leads, fs=FS)
    assert res["global_rr_ms"] == pytest.approx(800.0, abs=10.0)
    assert res["global_hr_bpm"] == pytest.approx(75.0, abs=1.5)
    assert res["primary_lead"] == "II"


def test_qtc_formulas_at_rr_one_second_equal_qt() -> None:
    cal = {"p_onset": 100, "p_peak": 150, "p_offset": 200, "qrs_onset": 260, "r_peak": 300,
           "qrs_offset": 350, "t_onset": 420, "t_peak": 520, "t_offset": 660}
    m = compute_intervals_from_calipers(cal, rr_ms=1000.0)
    qt = 660 - 260
    iv = m["intervals_ms"]
    assert iv["qt"] == qt
    # At RR = 1 s (HR 60) every correction formula must return QT itself
    for key in ("qtc_bazett", "qtc_fridericia", "qtc_framingham", "qtc_hodges"):
        assert iv[key] == pytest.approx(qt, abs=0.1), key
    assert m["durations_ms"]["qrs_complex"] == 90
    assert iv["pq_pr"] == 160
    assert m["segments_ms"]["pq_pr_segment"] == 60


def test_qtc_bazett_tachycardia() -> None:
    cal = {"qrs_onset": 0, "qrs_offset": 90, "t_offset": 360, "p_onset": -150, "p_offset": -60}
    m = compute_intervals_from_calipers(cal, rr_ms=640.0)
    assert m["intervals_ms"]["qtc_bazett"] == pytest.approx(360 / math.sqrt(0.64), abs=0.2)
    assert m["intervals_ms"]["qtc_fridericia"] == pytest.approx(360 / 0.64 ** (1 / 3), abs=0.2)


def test_pq_not_reported_as_normal_when_missing() -> None:
    cal = {"p_onset": 250, "p_peak": 255, "p_offset": 258, "qrs_onset": 260, "r_peak": 300,
           "qrs_offset": 350, "t_onset": 420, "t_peak": 520, "t_offset": 660}
    m = compute_intervals_from_calipers(cal, rr_ms=1000.0)
    pq_flag = next(f for f in m["clinical_flags"] if f["param"] == "Интервал PQ")
    assert pq_flag["level"] != "normal"


def test_sokolow_lyon_index() -> None:
    v1 = synthetic_beat_train(qrs_scale=-1.6).tolist()  # deep S in V1 (≈ 1.9 mV)
    v5 = synthetic_beat_train(qrs_scale=1.8).tolist()   # tall R in V5 (≈ 2.2 mV)
    res = analyze_all_leads({"V1": v1, "V5": v5}, fs=FS)
    hyp = res["hypertrophy"]
    assert "sokolow_lyon_mv" in hyp
    assert hyp["sokolow_lyon_mv"] > 3.5
    assert hyp["sokolow_lyon_lvh"] is True


def test_sokolow_never_negative_with_qs_complexes() -> None:
    # QS-type complexes in V5/V6 (no R above the isoelectric line) must contribute 0 mm, not a negative R
    v1 = synthetic_beat_train(qrs_scale=0.3).tolist()
    v5 = synthetic_beat_train(qrs_scale=-1.0).tolist()
    res = analyze_all_leads({"V1": v1, "V5": v5}, fs=FS)
    assert res["hypertrophy"]["sokolow_lyon_mv"] >= 0.0
