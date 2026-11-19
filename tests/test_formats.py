"""Digital ECG / Holter readers: every format round-trips a synthetic 12-lead ECG with known amplitudes."""

from __future__ import annotations

import io
import zipfile

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.core.ecg_formats import (
    FormatError,
    detect_and_read,
    extract_segment,
    hr_trend,
    load_recording,
    normalize_lead_name,
    prepare_recording,
)
from app.server import app
from tests.ecg_format_writers import (
    write_csv,
    write_dicom_ecg,
    write_edf,
    write_hl7_aecg,
    write_ishne,
    write_muse_xml,
    write_wfdb,
)
from tests.synthetic_ecg import LEADS, synthetic_12lead

FS = 500.0


@pytest.fixture(scope="module")
def ecg():
    return {k: np.asarray(v) for k, v in synthetic_12lead(hr_bpm=72, duration_s=10.0, fs=FS, seed=3).items()}


def _check(out, ecg, tol_mv=0.02, leads=LEADS):
    assert set(leads) <= set(out["leads_mv"]), sorted(out["leads_mv"])
    for k in leads:
        got = np.asarray(out["leads_mv"][k])
        ref = ecg[k][: len(got)] - np.median(ecg[k][: len(got)])
        n = min(len(got), len(ref))
        assert n > 0.95 * len(ecg[k])
        err = np.max(np.abs(got[:n] - ref[:n]))
        assert err < tol_mv, (k, err)


def _einthoven(ecg):
    """8-lead devices store I, II, V1-V6; the reader derives III / aVR / aVL / aVF exactly like this."""
    i, ii = ecg["I"], ecg["II"]
    return {**ecg, "III": ii - i, "aVR": -(i + ii) / 2, "aVL": i - ii / 2, "aVF": ii - i / 2}


def test_lead_name_normalisation():
    cases = {"MLII": "II", "ECG I": "I", "Lead aVL": "aVL", "AVF": "aVF", "MDC_ECG_LEAD_V3": "V3", "V5 ": "V5",
             "Lead II (Einthoven)": "II", "EKG V1": "V1", "Resp": "Resp"}
    for raw, want in cases.items():
        assert normalize_lead_name(raw) == want, raw


def test_edf_with_annotation_channel(ecg):
    data = write_edf(ecg, FS, with_annotations=True)
    out = load_recording({"rec.edf": data})
    assert out["format"] == "EDF+"
    assert "EDF Annotations" not in out["leads_mv"]
    _check(out, ecg, tol_mv=0.005)
    assert out["info"]["sex"] == "male"


def test_bdf_24bit(ecg):
    out = load_recording({"rec.bdf": write_edf(ecg, FS, bdf=True)})
    assert out["format"] == "BDF"
    _check(out, ecg, tol_mv=0.001)


def test_edf_resampled_from_250hz(ecg):
    low = {k: v[::2] for k, v in ecg.items()}
    out = load_recording({"rec.edf": write_edf(low, 250.0)})
    assert out["native_fs"] == 250.0
    got = np.asarray(out["leads_mv"]["II"])
    ref = ecg["II"][: len(got)] - np.median(ecg["II"][: len(got)])
    assert abs(len(got) - len(ecg["II"])) <= 2
    assert np.corrcoef(got[50:-50], ref[50:len(got) - 50])[0, 1] > 0.99


def test_ishne(ecg):
    rec = detect_and_read({"holter.ecg": write_ishne(ecg, FS)})
    assert rec.format == "ISHNE" and rec.info["sex"] == "male" and "Petrov" in rec.info["patient"]
    _check(load_recording({"holter.ecg": write_ishne(ecg, FS)}), ecg, tol_mv=0.003)


@pytest.mark.parametrize("fmt", [16, 212])
def test_wfdb_formats(ecg, fmt):
    files = write_wfdb(ecg, FS, fmt=fmt, gain=200.0, baseline=0 if fmt == 16 else 0)
    _check(load_recording(files), ecg, tol_mv=0.006)


def test_wfdb_zip_and_missing_dat(ecg):
    files = write_wfdb({k: ecg[k] for k in ("II", "V1")}, FS, fmt=16, baseline=12)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, data in files.items():
            zf.writestr(f"mitdb/{name}", data)
    out = load_recording({"record.zip": buf.getvalue()})
    _check(out, ecg, tol_mv=0.006, leads=["II", "V1"])
    with pytest.raises(FormatError):
        load_recording({"rec.hea": files["rec.hea"]})


def test_muse_xml_derives_limb_leads(ecg):
    out = load_recording({"muse.xml": write_muse_xml(ecg, FS)})
    assert out["format"] == "GE MUSE XML"
    assert any("вычислены из I и II" in w for w in out["warnings"])
    _check(out, _einthoven(ecg), tol_mv=0.01)  # III / aVR / aVL / aVF by Einthoven / Goldberger
    assert out["info"]["sex"] == "female"


def test_hl7_aecg_ignores_median_beats(ecg):
    out = load_recording({"aecg.xml": write_hl7_aecg(ecg, FS)})
    assert out["format"] == "HL7 aECG"
    _check(out, _einthoven(ecg), tol_mv=0.01)


def test_dicom_waveform(ecg):
    out = load_recording({"ecg.dcm": write_dicom_ecg(ecg, FS)})
    assert out["format"] == "DICOM ECG"
    _check(out, ecg, tol_mv=0.003)
    assert out["info"]["age"] == 71


def test_csv_own_export(ecg):
    out = load_recording({"export.csv": write_csv(ecg, FS)})
    assert out["native_fs"] == pytest.approx(500.0, rel=1e-3)
    _check(out, ecg, tol_mv=0.001)


def test_unknown_file_rejected():
    with pytest.raises(FormatError):
        load_recording({"x.bin": b"\x00\x01garbage" * 100})


def _holter(minutes=6.0, fs=200.0):
    """3-channel Holter: 60 bpm for the first half, 100 bpm after, one 2.6-s pause at 100 s."""
    rng = np.random.default_rng(1)
    n = int(minutes * 60 * fs)
    t = np.arange(n) / fs
    beats, tb = [], 0.5
    while tb < minutes * 60 - 1:
        beats.append(tb)
        tb += (1.0 if tb < minutes * 30 else 0.6)
        if abs(tb - 100.0) < 0.6:
            tb += 1.6
    x = np.zeros(n)
    for b in beats:
        i = int(b * fs)
        w = np.arange(-int(0.05 * fs), int(0.05 * fs))
        idx = i + w
        ok = (idx >= 0) & (idx < n)
        x[idx[ok]] += 1.2 * np.exp(-0.5 * (w[ok] / (0.012 * fs)) ** 2)
        tw = i + np.arange(int(0.2 * fs), int(0.4 * fs))
        tw = tw[tw < n]
        x[tw] += 0.25 * np.sin(np.linspace(0, np.pi, tw.size))
    x += 0.15 * np.sin(2 * np.pi * 0.25 * t) + rng.normal(0, 0.02, n)
    return {"V5": x, "V1": -0.6 * x, "III": 0.5 * x}, fs


def test_holter_segment_and_trend():
    leads, fs = _holter()
    data = write_edf(leads, fs)
    rec = prepare_recording({"holter.edf": data})
    assert rec.info["duration_s"] == pytest.approx(360.0, abs=1.0)
    seg = extract_segment(rec, 200.0, 20.0)
    assert seg["segment_start_s"] == 200.0 and seg["segment_duration_s"] == 20.0
    assert len(seg["leads_mv"]["V5"]) == int(20 * 500)
    assert any("Длинная запись" in w for w in seg["warnings"])
    seg_end = extract_segment(rec, 10_000.0, 30.0)  # clipped to the record end
    assert seg_end["segment_start_s"] == pytest.approx(330.0, abs=0.01)

    tr = hr_trend(rec)
    assert tr is not None and tr["lead"] == "V5"
    med = [v for v in tr["hr_median"] if v is not None]
    first = med[: len(med) // 2 - 2]
    last = med[len(med) // 2 + 2:]
    assert np.median(first) == pytest.approx(60.0, abs=3.0)
    assert np.median(last) == pytest.approx(100.0, abs=4.0)
    assert any(abs(p["t_s"] - 99.5) < 2.0 and p["rr_s"] > 2.0 for p in tr["pauses"]), tr["pauses"]


def test_api_load_signal_and_segment(ecg):
    client = TestClient(app)
    leads, fs = _holter(minutes=3.0)
    r = client.post("/api/load_signal", files=[("files", ("holter.edf", write_edf(leads, fs), "application/octet-stream"))],
                    data={"segment_duration_s": "10"})
    assert r.status_code == 200, r.text
    body = r.json()
    dig = body["digitization"]
    assert dig["source_type"] == "signal" and dig["sampling_rate_hz"] == 500.0
    assert set(dig["leads_mv"]) == {"III", "V1", "V5"}
    sig = dig["signal"]
    assert sig["record_duration_s"] == pytest.approx(180.0, abs=1.0) and sig["trend"] is not None
    assert body["analysis"]["primary_lead"] in dig["leads_mv"]

    r2 = client.post("/api/signal_segment", json={"recording_id": sig["recording_id"], "segment_start_s": 120.0,
                                                  "segment_duration_s": 10.0})
    assert r2.status_code == 200, r2.text
    seg = r2.json()["digitization"]["signal"]
    assert seg["segment_start_s"] == 120.0
    hr = r2.json()["analysis"]["global_hr_bpm"]
    assert hr == pytest.approx(100.0, abs=5.0)

    r3 = client.post("/api/signal_segment", json={"recording_id": "nope", "segment_start_s": 0})
    assert r3.status_code == 404

    # 12-lead resting ECG in DICOM: whole record, no trend
    r4 = client.post("/api/load_signal", files=[("files", ("ecg.dcm", write_dicom_ecg(ecg, FS), "application/dicom"))])
    assert r4.status_code == 200, r4.text
    d4 = r4.json()["digitization"]
    assert len(d4["leads_mv"]) == 12 and d4["signal"]["trend"] is None

    bad = client.post("/api/load_signal", files=[("files", ("x.edf", b"0       garbage", "application/octet-stream"))])
    assert bad.status_code == 400
