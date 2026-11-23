"""Automatic analysis (detection, delineation, measurements) and interpretation on ECGs with known answers."""

from __future__ import annotations

import warnings

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.core.ecg_autoanalysis import NEUROKIT_VERSION, analyze_ecg
from app.core.ecg_interpretation import compose_conclusion, interpret
from app.server import app
from tests.synthetic_ecg import TRUE_PR_MS, TRUE_QRS_MS, TRUE_QT_MS, synthetic_12lead

warnings.filterwarnings("ignore")
FS = 500.0


def codes(interp):
    return {f["code"] for f in interp["findings"]}


# ----------------------------------------------------------------------------- measurements
@pytest.mark.parametrize("hr", [55, 75, 90])
def test_rate_and_global_intervals_on_synthetic_12_lead(hr: int) -> None:
    res = analyze_ecg(synthetic_12lead(hr_bpm=hr, seed=hr), fs=FS)
    assert res["ok"]
    assert res["rhythm"]["hr_bpm"] == pytest.approx(hr, abs=1.0)
    iv = res["intervals"]
    assert iv["qrs_ms"] == pytest.approx(TRUE_QRS_MS, abs=12)
    assert iv["pr_ms"] == pytest.approx(TRUE_PR_MS, abs=20)
    assert iv["qt_ms"] == pytest.approx(TRUE_QT_MS, abs=25)  # tangent method ends slightly before the wave support
    assert res["rhythm"]["p_present_fraction"] >= 0.8


@pytest.mark.parametrize("width", [120, 140])
def test_wide_qrs_is_not_underestimated(width: int) -> None:
    res = analyze_ecg(synthetic_12lead(hr_bpm=70, qrs_ms=width, seed=width), fs=FS)
    assert res["intervals"]["qrs_ms"] == pytest.approx(width, abs=10)


@pytest.mark.parametrize("axis", [-45.0, 0.0, 60.0, 110.0])
def test_axis_from_median_beats(axis: float) -> None:
    res = analyze_ecg(synthetic_12lead(hr_bpm=70, qrs_axis_deg=axis, seed=3), fs=FS)
    assert res["axes"]["qrs_axis_deg"] == pytest.approx(axis, abs=6)


def test_missing_p_waves_are_not_invented() -> None:
    res = analyze_ecg(synthetic_12lead(hr_bpm=75, p_wave=False, seed=4), fs=FS)
    assert res["intervals"]["pr_ms"] is None
    assert res["rhythm"]["p_present_fraction"] == 0.0


def test_neurokit_detectors_take_part_in_the_vote() -> None:
    res = analyze_ecg(synthetic_12lead(hr_bpm=70, seed=5), fs=FS)
    if NEUROKIT_VERSION:
        assert {"neurokit", "kalidas2017"} <= set(res["methods"]["qrs_detectors"])
    assert "ecg_analysis" in res["methods"]["qrs_detectors"]


def test_workbench_calipers_override_global_intervals() -> None:
    leads = synthetic_12lead(hr_bpm=70, seed=6)
    auto = analyze_ecg(leads, fs=FS)
    rep = auto["leads"]["II"]["calipers_ms"]
    edited = dict(rep, qrs_onset=rep["qrs_onset"] - 20.0, t_offset=rep["t_offset"] + 30.0)
    res = analyze_ecg(leads, fs=FS, calipers_override={"II": edited}, reference_lead="II")
    assert res["intervals"]["qrs_ms"] == pytest.approx(auto["intervals"]["qrs_ms"] + 20, abs=4)
    assert res["intervals"]["qt_ms"] == pytest.approx(auto["intervals"]["qt_ms"] + 50, abs=4)


# ----------------------------------------------------------------------------- interpretation
def test_normal_synthetic_ecg_reads_sinus_normal_axis_no_pathology() -> None:
    interp = interpret(analyze_ecg(synthetic_12lead(hr_bpm=72, seed=7), fs=FS), patient={"sex": "male", "age": 50})
    c = codes(interp)
    assert "sinus" in c and "axis" in c and "no_abnormal" in c
    assert not {"af", "ste", "lbbb", "rbbb", "av1", "long_qt"} & c
    assert interp["conclusion_text"].startswith("Синусовый ритм")
    assert "требует проверки" in interp["conclusion_text"]


def test_irregular_rhythm_without_p_is_atrial_fibrillation() -> None:
    interp = interpret(analyze_ecg(synthetic_12lead(hr_bpm=95, p_wave=False, rr_jitter=0.3, seed=8), fs=FS))
    assert "af" in codes(interp)


def test_inferior_st_elevation_is_flagged_critical() -> None:
    leads = synthetic_12lead(hr_bpm=70, st_elevation_mv={"II": 0.25, "III": 0.3, "aVF": 0.28}, seed=9)
    interp = interpret(analyze_ecg(leads, fs=FS), patient={"sex": "male", "age": 60})
    ste = next(f for f in interp["findings"] if f["code"] == "ste")
    assert ste["severity"] == "critical"
    assert {"II", "III", "aVF"} <= set(ste["leads"])
    assert "нижней стенки" in ste["text"]


def _features(**over):
    base = {"quality": "ok", "r_amp_mv": 0.8, "s_amp_mv": -0.3, "q_amp_mv": 0.0, "q_dur_ms": 0.0, "s_dur_ms": 20.0,
            "qrs_morphology": "Rs", "st_j_mv": 0.0, "st_60_mv": 0.0, "st_80_mv": 0.0, "st_slope_mv_s": 0.0, "t_amp_mv": 0.3,
            "p_amp_mv": 0.1, "p_terminal_force_mm_s": 0.0, "qrs_p2p_mv": 1.1}
    base.update(over)
    return base


def _analysis(features, qrs=96.0, pr=160.0, axis=60.0, qtcf=410.0, hr=70.0):
    return {
        "intervals": {"pr_ms": pr, "qrs_ms": qrs, "qt_ms": 380.0, "qtc_fridericia_ms": qtcf, "qtc_bazett_ms": qtcf + 5, "p_ms": 100.0},
        "rhythm": {"hr_bpm": hr, "n_beats": 10, "p_present_fraction": 1.0, "rr_cv": 0.02, "premature_beats": [], "duration_s": 10},
        "axes": {"qrs_axis_deg": axis, "p_axis_deg": 50.0, "t_axis_deg": 40.0, "qrs_t_angle_deg": 20.0},
        "features": features,
        "simultaneous_leads": True,
    }


LEADS12 = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]


def test_rbbb_rule() -> None:
    f = {ln: _features() for ln in LEADS12}
    f["V1"] = _features(r_amp_mv=0.3, s_amp_mv=-0.4, qrs_morphology="rSR'", r2_amp_mv=0.6)
    f["I"] = _features(s_dur_ms=50.0)
    f["V6"] = _features(s_dur_ms=48.0)
    assert "rbbb" in codes(interpret(_analysis(f, qrs=136)))


def test_lbbb_rule_suppresses_st_criteria() -> None:
    f = {ln: _features(q_amp_mv=0.0) for ln in LEADS12}
    f["V1"] = _features(r_amp_mv=0.0, s_amp_mv=-1.5, qrs_morphology="QS", st_j_mv=0.3)
    f["V2"] = _features(r_amp_mv=0.1, s_amp_mv=-2.0, qrs_morphology="rS", st_j_mv=0.35)
    f["I"] = _features(r_amp_mv=1.2, s_amp_mv=0.0, qrs_morphology="R")
    f["V6"] = _features(r_amp_mv=1.4, s_amp_mv=0.0, qrs_morphology="R")
    c = codes(interpret(_analysis(f, qrs=150)))
    assert "lbbb" in c and "ste" not in c


def test_av_block_and_long_qt_and_sex_specific_thresholds() -> None:
    f = {ln: _features() for ln in LEADS12}
    c = codes(interpret(_analysis(f, pr=240, qtcf=455), patient={"sex": "female"}))
    assert "av1" in c and "long_qt" not in c  # 455 ms is within the female limit (460)
    c = codes(interpret(_analysis(f, pr=240, qtcf=455), patient={"sex": "male"}))
    assert "long_qt" in c


def test_lvh_by_sokolow() -> None:
    f = {ln: _features() for ln in LEADS12}
    f["V1"] = _features(r_amp_mv=0.2, s_amp_mv=-1.8, qrs_morphology="rS")
    f["V5"] = _features(r_amp_mv=2.2, s_amp_mv=-0.1)
    lvh = next(x for x in interpret(_analysis(f))["findings"] if x["code"] == "lvh")
    assert "Соколов" in lvh["evidence"]


def test_axis_convention_switch() -> None:
    f = {ln: _features() for ln in LEADS12}
    ru = next(x for x in interpret(_analysis(f, axis=-20))["findings"] if x["code"] == "axis")
    aha = next(x for x in interpret(_analysis(f, axis=-20), options={"axis_convention": "aha"})["findings"] if x["code"] == "axis")
    assert "влево" in ru["text"] and "Нормальное" in aha["text"]


def test_compose_respects_selection() -> None:
    f = {ln: _features() for ln in LEADS12}
    interp = interpret(_analysis(f, pr=240))
    text = compose_conclusion(interp["findings"], include=["sinus", "axis"])
    assert "АВ-блокада" not in text and "Синусовый ритм" in text


# ----------------------------------------------------------------------------- API
def test_autoanalysis_endpoint() -> None:
    client = TestClient(app)
    leads = synthetic_12lead(hr_bpm=68, seed=11)
    r = client.post("/api/autoanalysis", json={"leads_mv": leads, "fs": FS, "groups": [list(leads)],
                                               "patient": {"sex": "male", "age": 55}, "options": {"axis_convention": "ru"}})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["analysis"]["leads"]["II"]["beats"]
    assert j["interpretation"]["findings"]
    assert j["autoanalysis"]["rhythm"]["hr_bpm"] == pytest.approx(68, abs=1.0)
    assert client.post("/api/autoanalysis", json={"leads_mv": {}, "fs": FS}).status_code == 400


@pytest.mark.skipif(not __import__("app.core.digitizer", fromlist=["x"]).deep_learning_status()["available"],
                    reason="U-Net weights not installed")
def test_real_megacart_example_has_no_false_stemi_or_q_waves() -> None:
    """00-35-31: routine sinus bradycardia (HR 59 on the sheet), isoelectric ST, small r in V1-V3."""
    client = TestClient(app)
    d = client.post("/api/digitize", data={"example_name": "photo_2026-11-19_00-35-31.jpg", "method": "hybrid_ensemble",
                                           "layout": "3x4_r1", "paper_speed_mm_s": 25, "gain_mm_mv": 10}).json()["digitization"]
    groups = {}
    for t in d["overlay_traces"]:
        groups.setdefault(tuple(t["x_range_px"]), []).append(t["lead"])
    r = client.post("/api/autoanalysis", json={"leads_mv": d["leads_mv"], "fs": 500.0, "groups": list(groups.values()),
                                               "patient": {"sex": "male", "age": 60}}).json()
    c = codes(r["interpretation"])
    assert "sinus" in c
    assert r["autoanalysis"]["rhythm"]["hr_bpm"] == pytest.approx(59, abs=3)
    assert not {"ste", "pathq", "af"} & c


def test_three_lead_groups_do_not_count_t_waves_as_beats() -> None:
    leads = synthetic_12lead(hr_bpm=72, seed=15)
    groups = [["I", "II", "III"], ["aVR", "aVL", "aVF"], ["V1", "V2", "V3"], ["V4", "V5", "V6"]]
    res = analyze_ecg(leads, fs=FS, groups=groups)
    assert res["rhythm"]["hr_bpm"] == pytest.approx(72, abs=2)


def test_workbench_refresh_keeps_p_absence_and_uses_reference_group() -> None:
    # no P waves: default P calipers coming back from the workbench must not create a PR interval
    leads = synthetic_12lead(hr_bpm=72, p_wave=False, seed=12)
    auto = analyze_ecg(leads, fs=FS)
    cal = {ln: auto["leads"][ln]["calipers_ms"] | {"p_onset": auto["leads"][ln]["calipers_ms"]["r_peak"] - 180,
                                                  "p_offset": auto["leads"][ln]["calipers_ms"]["r_peak"] - 90}
           for ln in auto["leads"]}
    res = analyze_ecg(leads, fs=FS, calipers_override=cal)
    assert res["intervals"]["pr_ms"] is None
    # 3x4-like non-simultaneous groups: a QT correction on the reference lead must fully reach the report
    leads = synthetic_12lead(hr_bpm=72, seed=13)
    groups = [["I", "II", "III"], ["aVR", "aVL", "aVF"], ["V1", "V2", "V3"], ["V4", "V5", "V6"]]
    auto = analyze_ecg(leads, fs=FS, groups=groups)
    cal = {ln: dict(auto["leads"][ln]["calipers_ms"]) for ln in auto["leads"]}
    cal["II"]["t_offset"] += 40.0
    res = analyze_ecg(leads, fs=FS, groups=groups, calipers_override=cal, reference_lead="II")
    group_ii_qt = res["intervals"]["qt_ms"]
    assert group_ii_qt == pytest.approx(cal["II"]["t_offset"] - cal["II"]["qrs_onset"], abs=4)


def test_only_moved_fiducials_override_the_automatic_intervals() -> None:
    leads = synthetic_12lead(hr_bpm=72, seed=14)
    groups = [["I", "II", "III"], ["aVR", "aVL", "aVF"], ["V1", "V2", "V3"], ["V4", "V5", "V6"]]
    auto = analyze_ecg(leads, fs=FS, groups=groups)
    cal = {ln: dict(auto["leads"][ln]["calipers_ms"]) for ln in auto["leads"]}
    cal["II"]["t_offset"] += 40.0
    cal["II"]["p_onset"] -= 60.0  # stale default position, NOT moved by the physician
    res = analyze_ecg(leads, fs=FS, groups=groups, calipers_override=cal, reference_lead="II", reference_edited=["t_offset"])
    assert res["intervals"]["pr_ms"] == pytest.approx(auto["intervals"]["pr_ms"], abs=4)
    # QT now comes from the reference lead's group: its automatic QT + the 40 ms the physician added
    no_edit = analyze_ecg(leads, fs=FS, groups=groups, calipers_override=cal, reference_lead="II", reference_edited=["qrs_onset"])
    assert res["intervals"]["qt_ms"] == pytest.approx(no_edit["intervals"]["qt_ms"] + 40, abs=6)
    assert res["rhythm"]["hr_bpm"] == pytest.approx(72, abs=2)


def test_group_with_unequal_lengths_is_trimmed():
    """A hand-corrected lead may come back a few samples shorter than its column neighbours."""
    leads = synthetic_12lead(hr_bpm=72, duration_s=10.0, fs=500.0, seed=11)
    leads["V2"] = leads["V2"][:-5]
    res = analyze_ecg(leads, fs=500.0, groups=[list(leads)])
    assert res["ok"]
    assert abs(res["rhythm"]["hr_bpm"] - 72) <= 2
