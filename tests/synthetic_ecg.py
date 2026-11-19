"""
Synthetic 12-lead ECG with EXACTLY known wave boundaries (piecewise waves with finite support), for testing
the automatic analysis and interpretation.

Per beat, times relative to the R apex:
    P   Hann pulse            [-200, -100] ms  (P = 100 ms, PR = 155 ms)
    QRS Q/R/S triangles       [ -45,  +45] ms  (QRS = 90 ms)
    T   asymmetric pulse      [+120, +360] ms  (QT = 405 ms)
"""

from __future__ import annotations

import math
from typing import Dict, Optional

import numpy as np

TRUE_P_MS = 100.0
TRUE_PR_MS = 155.0
TRUE_QRS_MS = 90.0
TRUE_QT_MS = 405.0

LEADS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]


def _hann(t: np.ndarray, a: float, b: float) -> np.ndarray:
    x = (t - a) / (b - a)
    return np.where((x >= 0) & (x <= 1), 0.5 - 0.5 * np.cos(2 * math.pi * x), 0.0)


def _t_wave(t: np.ndarray) -> np.ndarray:
    """Asymmetric T: slow rise 120-290 ms, steeper fall 290-360 ms (support ends exactly at +360 ms)."""
    rise = np.where((t >= 120) & (t < 290), 0.5 - 0.5 * np.cos(math.pi * (t - 120) / 170.0), 0.0)
    fall = np.where((t >= 290) & (t <= 360), 0.5 + 0.5 * np.cos(math.pi * (t - 290) / 70.0), 0.0)
    return rise + fall


def _tri(t: np.ndarray, a: float, peak: float, b: float) -> np.ndarray:
    up = np.where((t >= a) & (t <= peak), (t - a) / (peak - a), 0.0)
    down = np.where((t > peak) & (t <= b), (b - t) / (b - peak), 0.0)
    return up + down


def limb_projection(axis_deg: float) -> Dict[str, float]:
    a = math.radians(axis_deg)
    i, ii, iii = math.cos(a), math.cos(a - math.radians(60)), math.cos(a - math.radians(120))
    return {"I": i, "II": ii, "III": iii, "aVR": -(i + ii) / 2, "aVL": (i - iii) / 2, "aVF": (ii + iii) / 2}


def synthetic_12lead(
    hr_bpm: float = 75.0,
    duration_s: float = 10.0,
    fs: float = 500.0,
    qrs_axis_deg: float = 60.0,
    qrs_ms: float = TRUE_QRS_MS,
    st_elevation_mv: Optional[Dict[str, float]] = None,
    t_scale: Optional[Dict[str, float]] = None,
    p_wave: bool = True,
    rr_jitter: float = 0.0,
    r_scale: Optional[Dict[str, float]] = None,
    seed: int = 0,
) -> Dict[str, list]:
    """Returns {lead: mV samples}. `qrs_ms` widens the QRS symmetrically; `rr_jitter` makes RR irregular (AF-like)."""
    rng = np.random.default_rng(seed)
    n = int(duration_s * fs)
    t_ms = np.arange(n) * 1000.0 / fs
    rr = 60000.0 / hr_bpm
    beats = []
    t = 400.0
    while t < duration_s * 1000.0 - 450:
        beats.append(t)
        t += rr * (1.0 + (rng.uniform(-rr_jitter, rr_jitter) if rr_jitter else 0.0))
    limb = limb_projection(qrs_axis_deg)
    prec_r = {"V1": 0.25, "V2": 0.5, "V3": 0.8, "V4": 1.2, "V5": 1.3, "V6": 1.0}
    prec_s = {"V1": -1.0, "V2": -1.4, "V3": -0.9, "V4": -0.5, "V5": -0.2, "V6": -0.1}
    half = qrs_ms / 2.0
    out: Dict[str, list] = {}
    for ln in LEADS:
        if ln in limb:
            g = limb[ln]
            r_amp, q_amp, s_amp = 1.2 * g, -0.12 * abs(g), -0.15 * abs(g)
            p_amp, t_amp = 0.15 * g, 0.3 * g
        else:
            r_amp, q_amp, s_amp = prec_r[ln], (-0.08 if ln in ("V5", "V6") else 0.0), prec_s[ln]
            p_amp, t_amp = (0.08 if ln != "V1" else 0.05), (0.15 if ln == "V1" else 0.4)
        if r_scale and ln in r_scale:
            r_amp *= r_scale[ln]
        if t_scale and ln in t_scale:
            t_amp *= t_scale[ln]
        x = np.zeros(n)
        for b in beats:
            tt = t_ms - b
            if p_wave:
                x += p_amp * _hann(tt, -200, -100)
            x += q_amp * _tri(tt, -half, -half + 0.22 * qrs_ms, -half + 0.22 * qrs_ms + 0.001)
            x += r_amp * _tri(tt, -half + 0.22 * qrs_ms, 0.0, half - 0.33 * qrs_ms)
            x += s_amp * _tri(tt, half - 0.33 * qrs_ms, half - 0.16 * qrs_ms, half)
            st = (st_elevation_mv or {}).get(ln, 0.0)
            if st:
                x += st * _tri(tt, half - 0.001, half, 120.0) + st * np.where((tt > half) & (tt < 120.0), 0.0, 0.0)
                x += st * np.where((tt >= half) & (tt <= 200.0), 1.0 - np.clip((tt - 120.0) / 80.0, 0, 1), 0.0)
            x += t_amp * _t_wave(tt)
        x += rng.normal(0, 0.008, n)
        out[ln] = x.round(4).tolist()
    return out
