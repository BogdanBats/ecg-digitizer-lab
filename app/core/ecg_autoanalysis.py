"""
Automatic multi-lead ECG analysis for the caliper workbench.

Pipeline (per group of simultaneously recorded leads, e.g. all 12 leads of a 12x1 sheet, one column of a 3x4 sheet,
or a rhythm strip):

1. QRS detection by CONSENSUS of several published detectors (NeuroKit2: neurokit, Kalidas 2017 stationary wavelet,
   Elgendi 2010, Pan-Tompkins 1985, Engelse-Zeelenberg) plus this project's own detector; a beat is kept when the
   majority of detectors agree within 60 ms.
2. Multi-lead fusion: detections of all leads of the group are merged (a beat must be seen by the majority of the
   good leads) and every beat is re-referenced to the peak of the group's spatial velocity (sum of |dV/dt| over leads),
   a common fiducial shared by all leads.
3. A median beat (template) per lead, aligned on that common reference and built from non-premature beats outside
   artifact zones — the approach of commercial 12-lead analysis programs (measurements on median complexes).
4. (see 5)
5. Global wave boundaries per group from all its median beats at once: QRS onset/offset from the spatial
   velocity, T end by tangent + threshold on the spatial magnitude, P from the pre-QRS magnitude (see
   `delineate_group`). NeuroKit2's DWT delineator was evaluated and rejected: on these signals (native 10 s
   simulations and 2-5 s digitized strips alike) it placed QRS onsets inside the P wave and missed P / QRS onsets.
6. Global intervals, per-lead morphology (Q/R/S/R', notching, ST at J/J+60/J+80, T, P terminal force), axes,
   rhythm statistics, premature-beat classification and P-wave presence for the rhythm analysis.

Without NeuroKit2 the same pipeline runs with the project's own detector / delineator only.
"""

from __future__ import annotations

import math
import warnings
from typing import Any, Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy.ndimage import gaussian_filter1d

from app.core.ecg_analysis import (
    clean_ecg_signal,
    compute_intervals_from_calipers,
    delineate_beat_fiducials,
    detect_qrs_peaks,
)

try:  # optional, but recommended: published detectors + wavelet delineator
    import neurokit2 as nk

    NEUROKIT_VERSION: Optional[str] = str(nk.__version__)
except Exception:  # pragma: no cover - depends on installation
    nk = None  # type: ignore[assignment]
    NEUROKIT_VERSION = None

# Spatial-velocity thresholds for the QRS boundaries (fraction of the QRS peak velocity above the PR / ST-T level)
QRS_ONSET_FRACTION = 0.05
QRS_OFFSET_FRACTION = 0.08
R_DETECTORS = ("neurokit", "kalidas2017", "elgendi2010", "pantompkins1985", "engzee2012")
FIDUCIAL_KEYS = (
    "p_onset", "p_peak", "p_offset", "qrs_onset", "q_peak", "r_peak", "s_peak", "qrs_offset", "t_onset", "t_peak", "t_offset",
)



# ----------------------------------------------------------------------------------------------- QRS detection
def _vote(detections: Dict[str, np.ndarray], tol: int, min_votes: int) -> np.ndarray:
    """Clusters detections of different methods within `tol` samples; keeps clusters with >= `min_votes` methods."""
    events = sorted((int(p), m) for m, arr in detections.items() for p in np.asarray(arr).ravel())
    out: List[int] = []
    i = 0
    while i < len(events):
        start = events[i][0]
        cluster = [events[i]]
        j = i + 1
        while j < len(events) and events[j][0] - start <= tol:
            cluster.append(events[j])
            j += 1
        methods = {m for _, m in cluster}
        if len(methods) >= min_votes:
            out.append(int(np.median([p for p, _ in cluster])))
        i = j
    return np.asarray(out, dtype=int)


def detect_r_peaks_consensus(sig: np.ndarray, fs: float) -> Tuple[np.ndarray, List[str]]:
    """Majority vote of NeuroKit2 detectors + the project's own detector (sample indices, methods used)."""
    sig = np.nan_to_num(np.asarray(sig, dtype=np.float64))
    detections: Dict[str, np.ndarray] = {}
    if nk is not None and len(sig) >= int(1.2 * fs):
        try:
            cleaned = nk.ecg_clean(sig, sampling_rate=int(fs), method="neurokit")
        except Exception:
            cleaned = sig
        for method in R_DETECTORS:
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    _, info = nk.ecg_peaks(cleaned, sampling_rate=int(fs), method=method)
                peaks = np.asarray(info.get("ECG_R_Peaks", []), dtype=int)
                if peaks.size:
                    detections[method] = peaks
            except Exception:
                continue
    own, _ = detect_qrs_peaks(clean_ecg_signal(sig, fs=fs, remove_baseline=False), fs=fs)
    if own.size:
        detections["ecg_analysis"] = own
    if not detections:
        return np.array([], dtype=int), []
    min_votes = max(1, int(math.ceil(len(detections) / 2.0)))
    return _vote(detections, tol=int(0.06 * fs), min_votes=min_votes), sorted(detections)


# ------------------------------------------------------------------------------------------- multi-lead fusion
def _spatial_velocity(signals: Sequence[np.ndarray], fs: float) -> np.ndarray:
    acc = None
    for s in signals:
        d = np.abs(np.gradient(gaussian_filter1d(np.asarray(s, dtype=np.float64), sigma=max(1.0, 0.004 * fs))))
        scale = float(np.median(d)) + 1e-6
        d = d / (scale * 20.0)
        acc = d if acc is None else acc + d
    return acc if acc is not None else np.zeros(1)


def fuse_group_beats(
    per_lead: Dict[str, np.ndarray],
    signals: Dict[str, np.ndarray],
    fs: float,
) -> np.ndarray:
    """Merges per-lead detections of one simultaneous group and re-references beats to the spatial-velocity peak."""
    if not per_lead:
        return np.array([], dtype=int)
    n_leads = len(per_lead)
    # a beat must be seen by the majority of the group's leads (>= 2 of 3 in a 3x4 column), otherwise a T wave
    # detected in one lead becomes an extra "beat"
    min_leads = 1 if n_leads == 1 else max(2, int(math.ceil(0.5 * n_leads)))
    fused = _vote({ln: pk for ln, pk in per_lead.items()}, tol=int(0.08 * fs), min_votes=min_leads)
    if fused.size == 0:
        return fused
    sv = _spatial_velocity(list(signals.values()), fs)
    rad = int(0.06 * fs)
    refined = []
    for f in fused:
        lo, hi = max(0, f - rad), min(len(sv), f + rad + 1)
        refined.append(lo + int(np.argmax(sv[lo:hi])) if hi > lo else int(f))
    refined = np.unique(np.asarray(refined, dtype=int))
    # drop near-duplicates (< 200 ms apart)
    keep: List[int] = []
    for r in refined:
        if not keep or r - keep[-1] >= int(0.2 * fs):
            keep.append(int(r))
    return np.asarray(keep, dtype=int)


# --------------------------------------------------------------------------------------------- median template
def _rr_stats(refs: np.ndarray, fs: float) -> Tuple[np.ndarray, float]:
    rr = np.diff(refs) * 1000.0 / fs if len(refs) >= 2 else np.array([])
    valid = rr[(rr >= 250) & (rr <= 2500)]
    return rr, float(np.median(valid)) if valid.size else 1000.0


def _premature_mask(refs: np.ndarray, fs: float) -> np.ndarray:
    """Premature beats: RR >= 20 % shorter than the median AND followed by a longer-than-median pause (a sinus
    arrhythmia shortens RR gradually, without the post-extrasystolic pause)."""
    rr, med = _rr_stats(refs, fs)
    mask = np.zeros(len(refs), dtype=bool)
    for i in range(1, len(refs)):
        short = rr[i - 1] < 0.80 * med
        pause = i >= len(rr) or rr[i] > 1.05 * med  # the last beat cannot show its pause: accept prematurity alone
        if short and pause:
            mask[i] = True
    return mask


def build_template(
    sig: np.ndarray,
    refs: np.ndarray,
    fs: float,
    rr_ms: float,
    exclude: Optional[np.ndarray] = None,
) -> Tuple[np.ndarray, int, int]:
    """Median beat aligned on `refs`. Window = one RR (pre 45 %), so replication gives a seamless periodic signal."""
    sig = np.asarray(sig, dtype=np.float64)
    n = len(sig)
    rr_s = int(round(rr_ms * fs / 1000.0))
    pre = int(np.clip(0.45 * rr_s, 0.20 * fs, 0.50 * fs))
    post = max(int(0.32 * fs), rr_s - pre)
    rows = []
    for i, r in enumerate(refs):
        if exclude is not None and exclude[i]:
            continue
        a, b = r - pre, r + post
        seg = np.full(pre + post, np.nan)
        lo, hi = max(0, a), min(n, b)
        if hi - lo < 0.6 * (pre + post):
            continue
        seg[lo - a:hi - a] = sig[lo:hi]
        rows.append(seg)
    if not rows:  # every beat excluded / truncated: use whatever is available
        for r in refs:
            a, b = r - pre, r + post
            seg = np.full(pre + post, np.nan)
            lo, hi = max(0, a), min(n, b)
            if hi > lo:
                seg[lo - a:hi - a] = sig[lo:hi]
                rows.append(seg)
    if not rows:
        return np.zeros(pre + post), pre, 0
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        tmpl = np.nanmedian(np.vstack(rows), axis=0)
    idx = np.arange(len(tmpl))
    ok = np.isfinite(tmpl)
    tmpl = np.interp(idx, idx[ok], tmpl[ok]) if ok.any() else np.zeros(len(tmpl))
    # remove the linear drift between the window ends (keeps the replicated signal seamless)
    k = max(3, int(0.01 * fs))
    a0, a1 = float(np.mean(tmpl[:k])), float(np.mean(tmpl[-k:]))
    tmpl = tmpl - (a0 + (a1 - a0) * idx / max(1, len(tmpl) - 1))
    return tmpl, pre, len(rows)


# ----------------------------------------------------------------------------------------- global delineation
def delineate_group(
    templates: Dict[str, Tuple[np.ndarray, int]],
    leads: Sequence[str],
    fs: float,
) -> Tuple[Dict[str, int], Dict[str, Dict[str, int]]]:
    """
    Global wave boundaries of one group of simultaneous leads from their median beats (offsets in samples relative
    to the common beat reference), as in 12-lead analysis programs:
    - QRS onset / offset: edges of the active region where the spatial velocity sqrt(sum_l (dV_l/dt)^2) exceeds
      the PR (resp. ST-T) velocity level by 5 % (onset) / 8 % (offset) of the QRS peak, bursts merged across quiet
      gaps < 20 ms (apex / nadir dips inside the QRS);
    - T peak / offset: spatial magnitude sqrt(sum_l (V_l - iso_l)^2) after the QRS; T end by the tangent method
      (steepest descent of the magnitude intersecting its post-T level);
    - P wave: per-lead humps in the 250 ms before the QRS, accepted when time-consistent in >= 1/4 of the leads.
    Also returns per-lead extremum positions (R, Q, S, P and T peaks) for the caliper display.
    """
    leads = [ln for ln in leads if ln in templates]
    L = len(templates[leads[0]][0])
    ref = templates[leads[0]][1]
    X = np.vstack([gaussian_filter1d(templates[ln][0], sigma=max(1.0, 0.003 * fs)) for ln in leads])
    Xv = np.vstack([gaussian_filter1d(templates[ln][0], sigma=max(0.8, 0.0016 * fs)) for ln in leads])
    D = np.gradient(Xv, axis=1) * fs
    sv = np.sqrt(np.sum(D ** 2, axis=0))
    w60 = int(0.06 * fs)
    lo_pk, hi_pk = max(1, ref - w60), min(L - 1, ref + w60 + 1)
    pk = lo_pk + int(np.argmax(sv[lo_pk:hi_pk]))
    peak_sv = float(sv[pk])
    # Thresholds relative to the velocity level of the neighbouring segments (PR before, ST-T after), not to a
    # global floor: on digitized traces the QRS edges are smoothed and P / T slopes reach a few % of the QRS peak
    # velocity, which dragged a global-floor threshold 50-100 ms into the P wave / ST segment.
    pr_zone = sv[max(0, pk - int(0.25 * fs)):max(1, pk - int(0.08 * fs))]
    st_zone = sv[min(L - 1, pk + int(0.10 * fs)):min(L, pk + int(0.30 * fs))]
    lvl_on = float(np.median(pr_zone)) if pr_zone.size else float(np.percentile(sv, 20))
    lvl_off = float(np.median(st_zone)) if st_zone.size else float(np.percentile(sv, 20))
    # Active QRS region: bursts of velocity above threshold merged across short quiet gaps (< 20 ms). Inside a QRS
    # the velocity dips briefly at every wave apex / nadir — for a group whose leads share the same S nadir (V1-V3 of
    # a 3x4 column) that dip used to be taken as a QRS boundary.
    max_gap = max(3, int(0.020 * fs))

    # Main deflection of the dominant leads (vs their median level) within +-70 ms of the reference: the QRS region must
    # contain them all. A broad, rounded deep-S nadir shared by all leads keeps the velocity low for > 20 ms and
    # used to split the QRS there, measuring the "baseline" at the bottom of the S wave.
    w100 = int(0.07 * fs)  # +-70 ms: QRS extrema only, never a P or T wave of a low-voltage lead
    ext_idx = []
    amps = []
    for li in range(X.shape[0]):
        seg = X[li, max(0, ref - w100):min(L, ref + w100 + 1)] - np.median(X[li])
        if seg.size:
            k = int(np.argmax(np.abs(seg)))
            ext_idx.append(max(0, ref - w100) + k)
            amps.append(abs(float(seg[k])))
    big = [e for e, a in zip(ext_idx, amps) if amps and a >= 0.5 * max(amps)]
    start_left = min([pk] + big) if big else pk
    start_right = max([pk] + big) if big else pk

    def expand(step: int, thr: float, limit: int) -> Optional[int]:
        start = start_left if step < 0 else start_right
        i, last_active, quiet = start, start, 0
        while (step < 0 and i > limit) or (step > 0 and i < limit):
            i += step
            if sv[i] > thr:
                last_active, quiet = i, 0
            else:
                quiet += 1
                if quiet >= max_gap:
                    return last_active
        # No clear pause (a P-wave tail / digitization ripple keeps the velocity above threshold right up to the
        # QRS): take the deepest velocity valley between the QRS core (>= 20 ms from the peak) and the search limit
        lo, hi = sorted((limit, start + step * max_gap))
        lo, hi = max(0, lo), min(L - 1, hi)
        if hi - lo < 3:
            return None
        return lo + int(np.argmin(sv[lo:hi + 1]))

    qon = expand(-1, lvl_on + QRS_ONSET_FRACTION * (peak_sv - lvl_on), max(0, start_left - int(0.12 * fs)))
    qoff = expand(1, lvl_off + QRS_OFFSET_FRACTION * (peak_sv - lvl_off), min(L - 1, start_right + int(0.16 * fs)))
    vector_qrs_ok = qon is not None and qoff is not None and int(0.05 * fs) <= qoff - qon <= int(0.20 * fs)
    qon = qon if qon is not None else pk - int(0.05 * fs)
    qoff = qoff if qoff is not None else pk + int(0.06 * fs)

    iso = np.median(X[:, max(0, qon - int(0.02 * fs)):max(1, qon - int(0.002 * fs))], axis=1)[:, None]
    M = np.sqrt(np.sum((X - iso) ** 2, axis=0))
    g: Dict[str, int] = {"qrs_onset": qon - ref, "qrs_offset": qoff - ref}

    # T wave
    t_lo = min(L - 2, qoff + int(0.06 * fs))
    t_hi = L - 1
    if t_hi - t_lo > int(0.06 * fs):
        t_pk = t_lo + int(np.argmax(M[t_lo:t_hi]))
        post = M[t_pk:]
        base_t = float(np.percentile(post, 10)) if post.size else 0.0
        dM = np.gradient(gaussian_filter1d(M, sigma=max(1.0, 0.006 * fs)))
        seg_end = min(L - 1, t_pk + int(0.25 * fs))
        if seg_end > t_pk + 3:
            k = t_pk + int(np.argmin(dM[t_pk:seg_end]))
            slope = float(dM[k])
            t_end = int(round(k + (base_t - M[k]) / slope)) if slope < -1e-9 else seg_end
        else:
            t_end = seg_end
        t_end = int(np.clip(t_end, t_pk + int(0.04 * fs), L - 1))
        thr_lvl = base_t + 0.10 * max(0.0, float(M[t_pk]) - base_t)
        below = np.nonzero(M[t_pk:] <= thr_lvl)[0]
        if below.size:
            t_end = int(round(0.5 * (t_end + t_pk + int(below[0]))))
        on_lvl = M[t_lo] + 0.3 * max(0.0, M[t_pk] - M[t_lo])
        rise = np.nonzero(M[t_lo:t_pk + 1] >= on_lvl)[0]
        t_on = t_lo + int(rise[0]) if rise.size else t_lo
        g.update({"t_onset": t_on - ref, "t_peak": t_pk - ref, "t_offset": t_end - ref})

    # P wave: per-lead search (a vector magnitude over 12 noisy digitized leads buries a 0.1 mV P wave). In each lead
    # look for a hump in the 250 ms before the QRS (linear detrend between the window ends) that is >= 0.05 mV and
    # >= 3x the lead's high-frequency noise, 40-160 ms wide; P is accepted when found, time-consistent (+-40 ms),
    # in at least a quarter of the leads (1 lead for single-lead groups).
    p_lo = max(0, qon - int(0.25 * fs))
    if "t_offset" in g:  # at fast rates the previous beat's T tail reaches into the P window (template = one RR)
        p_lo = max(p_lo, ref + g["t_offset"] - L + int(0.02 * fs))
    p_hi = qon - int(0.02 * fs)
    if p_hi - p_lo > int(0.06 * fs):
        hits = []
        k_edge = max(2, int(0.006 * fs))
        for li in range(len(leads)):
            seg = X[li, p_lo:p_hi].astype(np.float64)
            ramp = np.linspace(seg[:k_edge].mean(), seg[-k_edge:].mean(), seg.size)
            seg = seg - ramp
            noise = float(np.std(np.diff(templates[leads[li]][0][p_lo:p_hi]))) * 2.0
            a_i = int(np.argmax(np.abs(seg)))
            amp = float(seg[a_i])
            if abs(amp) < max(0.05, 3.0 * noise):
                continue
            lvl = 0.2 * abs(amp)
            j = a_i
            while j > 0 and seg[j] * np.sign(amp) > lvl:
                j -= 1
            k = a_i
            while k < seg.size - 1 and seg[k] * np.sign(amp) > lvl:
                k += 1
            if int(0.04 * fs) <= k - j <= int(0.16 * fs):
                hits.append((p_lo + j, p_lo + a_i, p_lo + k))
        need = 1 if len(leads) <= 2 else max(2, int(math.ceil(0.25 * len(leads))))
        if len(hits) >= need:
            med_pk = float(np.median([h[1] for h in hits]))
            hits = [h for h in hits if abs(h[1] - med_pk) <= 0.04 * fs]
            if len(hits) >= need:
                g.update({
                    "p_onset": int(np.percentile([h[0] for h in hits], 20)) - ref,
                    "p_peak": int(np.median([h[1] for h in hits])) - ref,
                    "p_offset": int(np.percentile([h[2] for h in hits], 80)) - ref,
                })

    # Ensemble with the constrained single-lead delineator (run on each lead's median beat, median over leads):
    # the vector method is more accurate on clean multi-lead data, the constrained one is robust to the slow wiggles
    # of digitized traces (which can drag spatial-velocity boundaries 50-100 ms into the P wave / ST segment).
    h_vals: Dict[str, List[int]] = {}
    for ln in leads:
        tmpl = templates[ln][0]
        tiled = np.tile(tmpl, 3)
        seg = tmpl[max(0, ref - w60):ref + w60 + 1]
        r_rel = int(np.argmax(np.abs(seg - np.median(tmpl)))) + max(0, ref - w60) - ref if seg.size else 0
        mid = L + ref + r_rel
        try:
            hf = delineate_beat_fiducials(tiled, mid, fs=fs, prev_r_idx=mid - L, next_r_idx=mid + L)
        except Exception:
            continue
        for key in ("p_onset", "p_peak", "p_offset", "qrs_onset", "qrs_offset", "t_onset", "t_peak", "t_offset"):
            h_vals.setdefault(key, []).append(int(hf[key]) - (L + ref))
    h = {k: int(np.median(v)) for k, v in h_vals.items() if v}
    # Fallbacks only (the constrained delineator is biased narrow on wide QRS, so it never overrides a valid
    # vector estimate): missing / implausible QRS, implausible T end, over-long P
    if not vector_qrs_ok and "qrs_onset" in h and "qrs_offset" in h:
        g["qrs_onset"], g["qrs_offset"] = h["qrs_onset"], h["qrs_offset"]
    if "t_offset" not in g or not (int(0.10 * fs) <= g["t_offset"] - g["qrs_offset"] <= int(0.55 * fs)):
        for key in ("t_onset", "t_peak", "t_offset"):
            if key in h:
                g[key] = h[key]
    p_found = "p_onset" in g and int(0.03 * fs) <= g["p_offset"] - g["p_onset"] <= int(0.16 * fs)
    if not p_found or not (g["p_onset"] < g["p_offset"] < g["qrs_onset"]):
        for key in ("p_onset", "p_peak", "p_offset"):
            g.pop(key, None)
    qon, qoff = ref + g["qrs_onset"], ref + g["qrs_offset"]

    # per-lead extrema for the caliper display
    lead_peaks: Dict[str, Dict[str, int]] = {}
    for li, ln in enumerate(leads):
        x = X[li] - iso[li, 0]
        own: Dict[str, int] = {}
        q = x[qon:qoff + 1]
        if q.size:
            r = int(np.argmax(np.abs(q)))
            own["r_peak"] = qon + r - ref
            own["q_peak"] = qon + int(np.argmin(q[:r + 1])) - ref if r > 0 else qon - ref
            own["s_peak"] = qon + r + int(np.argmin(q[r:])) - ref
        if "t_onset" in g:
            tseg = x[ref + g["t_onset"]:ref + g["t_offset"] + 1]
            if tseg.size:
                own["t_peak"] = g["t_onset"] + int(np.argmax(np.abs(tseg)))
        if "p_onset" in g:
            pseg = x[ref + g["p_onset"]:ref + g["p_offset"] + 1]
            if pseg.size:
                own["p_peak"] = g["p_onset"] + int(np.argmax(np.abs(pseg)))
        lead_peaks[ln] = own
    return g, lead_peaks


# --------------------------------------------------------------------------------------------- lead measurements
def _ms(samples: float, fs: float) -> float:
    return float(samples) * 1000.0 / fs


def measure_template(tmpl: np.ndarray, ref_idx: int, fid: Dict[str, int], fs: float) -> Dict[str, Any]:
    """Morphology of one lead's median beat at the (global) fiducials `fid` (offsets relative to `ref_idx`)."""
    L = len(tmpl)

    def at(key: str, default_ms: float) -> int:
        return int(np.clip(ref_idx + fid.get(key, int(default_ms * fs / 1000.0)), 0, L - 1))

    qon, qoff = at("qrs_onset", -40), at("qrs_offset", 50)
    if qoff <= qon + 2:
        qoff = min(L - 1, qon + int(0.08 * fs))
    iso_lo, iso_hi = max(0, qon - int(0.02 * fs)), max(1, qon - int(0.004 * fs))
    iso = float(np.median(tmpl[iso_lo:iso_hi])) if iso_hi > iso_lo else float(np.median(tmpl))
    x = tmpl - iso
    thr = 0.05  # mV: smallest deflection counted as a wave

    # QRS waves
    qrs = x[qon:qoff + 1]
    r_rel = int(np.argmax(qrs)) if qrs.size else 0
    r_amp = float(max(0.0, qrs[r_rel])) if qrs.size else 0.0
    pre_r = qrs[:r_rel + 1] if qrs.size else np.array([0.0])
    q_amp = float(min(0.0, np.min(pre_r)))
    q_dur_ms = 0.0
    if q_amp < -thr and r_amp > thr:
        neg = np.where(pre_r < 0)[0]
        if neg.size:
            q_end = neg[-1]
            q_dur_ms = _ms(q_end + 1, fs)
    post_r = qrs[r_rel:] if qrs.size else np.array([0.0])
    s_amp = float(min(0.0, np.min(post_r)))
    s_rel = r_rel + int(np.argmin(post_r)) if post_r.size else r_rel
    s_dur_ms = _ms(int(np.sum(post_r < -0.02)), fs)
    after_s = qrs[s_rel:] if qrs.size else np.array([0.0])
    r2_amp = float(max(0.0, np.max(after_s))) if after_s.size else 0.0
    has_r2 = r2_amp > max(thr, 0.15 * r_amp) and s_amp < -thr
    # QS: no positive deflection at all
    is_qs = r_amp < thr and float(np.min(qrs) if qrs.size else 0.0) < -0.3
    # notching: >= 2 positive local maxima of the R wave above 30 % of R
    notched = False
    if r_amp > 0.3 and qrs.size > 5:
        sm = gaussian_filter1d(qrs, sigma=max(1.0, 0.002 * fs))
        peaks = [i for i in range(1, len(sm) - 1) if sm[i] > sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] > 0.3 * r_amp]
        notched = len(peaks) >= 2 and (peaks[-1] - peaks[0]) > 0.012 * fs
    morph = _morphology_code(q_amp, r_amp, s_amp, has_r2, is_qs, thr)

    # ST & T
    j = qoff
    st = {f"st_{lbl}_mv": float(x[min(L - 1, j + int(off * fs / 1000.0))]) for lbl, off in (("j", 0), ("60", 60), ("80", 80))}
    t_lo = min(L - 1, j + int(0.08 * fs))
    t_hi = at("t_offset", 380)
    t_seg = x[t_lo:max(t_lo + 1, t_hi + 1)]
    t_amp = float(t_seg[int(np.argmax(np.abs(t_seg)))]) if t_seg.size else 0.0
    t_pos = float(max(0.0, np.max(t_seg))) if t_seg.size else 0.0
    t_neg = float(min(0.0, np.min(t_seg))) if t_seg.size else 0.0

    # P wave
    p_on, p_off = at("p_onset", -200), at("p_offset", -100)
    p_seg = x[p_on:max(p_on + 1, p_off + 1)] if p_off > p_on else np.array([0.0])
    p_amp = float(p_seg[int(np.argmax(np.abs(p_seg)))]) if p_seg.size else 0.0
    p_pos = float(max(0.0, np.max(p_seg)))
    p_neg = float(min(0.0, np.min(p_seg)))
    # P terminal force (V1): depth (mm) x duration (s) of the terminal negative phase
    ptf = 0.0
    if p_seg.size > 3 and p_neg < -0.02:
        pk = int(np.argmax(p_seg))
        term = p_seg[pk:]
        neg_dur_s = float(np.sum(term < -0.01)) / fs
        ptf = float(np.min(term)) * 10.0 * neg_dur_s if term.size else 0.0

    qrs_area = float(np.sum(qrs)) / fs * 1000.0  # mV*ms
    # TP segment (end of the one-RR template, before the next P): with a correct PR baseline it sits near 0
    t_end_i = at("t_offset", 380)
    tp = x[min(L - 1, t_end_i + int(0.04 * fs)):max(min(L - 1, t_end_i + int(0.04 * fs)) + 1, L - int(0.02 * fs))]
    baseline_mismatch = float(np.median(tp)) if tp.size >= int(0.03 * fs) else 0.0
    return {
        "isoelectric_mv": round(iso, 4),
        "p_amp_mv": round(p_amp, 3), "p_pos_mv": round(p_pos, 3), "p_neg_mv": round(p_neg, 3),
        "p_terminal_force_mm_s": round(ptf, 4),
        "q_amp_mv": round(q_amp, 3), "q_dur_ms": round(q_dur_ms, 1),
        "r_amp_mv": round(r_amp, 3), "s_amp_mv": round(s_amp, 3), "s_dur_ms": round(s_dur_ms, 1),
        "r2_amp_mv": round(r2_amp if has_r2 else 0.0, 3),
        "qrs_net_mv": round(r_amp + min(q_amp, s_amp), 3),
        "qrs_p2p_mv": round(r_amp - min(q_amp, s_amp), 3),
        "qrs_area_mv_ms": round(qrs_area, 2),
        "baseline_mismatch_mv": round(baseline_mismatch, 3),
        "qrs_morphology": morph,
        "qrs_notched": bool(notched),
        "vat_ms": round(_ms(r_rel, fs), 1),
        "st_j_mv": round(st["st_j_mv"], 3), "st_60_mv": round(st["st_60_mv"], 3), "st_80_mv": round(st["st_80_mv"], 3),
        "st_slope_mv_s": round((st["st_80_mv"] - st["st_j_mv"]) / 0.08, 3),
        "t_amp_mv": round(t_amp, 3), "t_pos_mv": round(t_pos, 3), "t_neg_mv": round(t_neg, 3),
    }


def _morphology_code(q: float, r: float, s: float, has_r2: bool, is_qs: bool, thr: float) -> str:
    if is_qs:
        return "QS"
    big = lambda v: abs(v) >= 0.5  # noqa: E731 - capital letter for large waves (>= 5 mm)
    code = ""
    if q < -thr:
        code += "Q" if big(q) else "q"
    if r >= thr:
        code += "R" if big(r) else "r"
    if s < -thr:
        code += "S" if big(s) else "s"
    if has_r2:
        code += "R'"
    return code or "—"


def hexaxial_axis(i_val: Optional[float], avf_val: Optional[float], ii_val: Optional[float]) -> Optional[float]:
    if i_val is None:
        return None
    if avf_val is not None:
        y = (2.0 / math.sqrt(3.0)) * avf_val
    elif ii_val is not None:
        y = (2.0 * ii_val - i_val) / math.sqrt(3.0)
    else:
        return None
    if abs(i_val) + abs(y) < 1e-4:
        return None
    return round(math.degrees(math.atan2(y, i_val)), 1)


# ----------------------------------------------------------------------------------------------- rhythm analysis
def _p_presence(sig: np.ndarray, refs: np.ndarray, tmpl: np.ndarray, ref_idx: int, fid: Dict[str, int], fs: float) -> float:
    """Fraction of beats whose pre-QRS segment matches the template P wave (shape + amplitude)."""
    if "p_onset" not in fid or "p_offset" not in fid or "qrs_onset" not in fid:
        return 0.0
    a, b, qon = fid["p_onset"], fid["p_offset"], fid["qrs_onset"]
    t_iso = float(np.median(tmpl[max(0, ref_idx + qon - int(0.02 * fs)):max(1, ref_idx + qon)]))
    t_p = tmpl[ref_idx + a:ref_idx + b + 1] - t_iso
    if t_p.size < 5 or float(np.max(np.abs(t_p))) < 0.04:
        return 0.0
    hits, total = 0, 0
    for r in refs:
        lo, hi = r + a, r + b + 1
        if lo < 0 or hi > len(sig):
            continue
        total += 1
        iso = float(np.median(sig[max(0, r + qon - int(0.02 * fs)):max(1, r + qon)]))
        seg = sig[lo:hi] - iso
        if float(np.max(np.abs(seg))) < 0.4 * float(np.max(np.abs(t_p))):
            continue
        c = np.corrcoef(seg, t_p)[0, 1] if np.std(seg) > 1e-6 else 0.0
        hits += int(c > 0.5)
    return hits / total if total else 0.0


def _classify_premature(sig_by_lead: Dict[str, np.ndarray], refs: np.ndarray, templates: Dict[str, Tuple[np.ndarray, int]],
                        premature: np.ndarray, fs: float) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    w0, w1 = int(0.06 * fs), int(0.10 * fs)
    for i in np.nonzero(premature)[0]:
        r = int(refs[i])
        corrs = []
        for ln, sig in sig_by_lead.items():
            tmpl, ref_idx = templates[ln]
            if r - w0 < 0 or r + w1 > len(sig) or ref_idx - w0 < 0 or ref_idx + w1 > len(tmpl):
                continue
            a = sig[r - w0:r + w1] - np.median(sig[r - w0:r + w1])
            b = tmpl[ref_idx - w0:ref_idx + w1] - np.median(tmpl[ref_idx - w0:ref_idx + w1])
            if np.std(a) > 1e-6 and np.std(b) > 1e-6:
                corrs.append(float(np.corrcoef(a, b)[0, 1]))
        corr = float(np.median(corrs)) if corrs else 1.0
        out.append({
            "beat_index": int(i),
            "time_ms": round(_ms(r, fs), 1),
            "qrs_correlation": round(corr, 2),
            "type": "ventricular" if corr < 0.70 else "supraventricular",
        })
    return out


# ------------------------------------------------------------------------------------------------- full pipeline
def _groups_from_lengths(leads: Dict[str, np.ndarray]) -> List[List[str]]:
    groups: Dict[int, List[str]] = {}
    for ln, s in leads.items():
        groups.setdefault(len(s), []).append(ln)
    return list(groups.values())


def analyze_ecg(
    leads_mv: Dict[str, List[float]],
    fs: float = 500.0,
    groups: Optional[List[List[str]]] = None,
    lead_quality: Optional[Dict[str, str]] = None,
    artifacts_ms: Optional[Dict[str, List[Tuple[float, float]]]] = None,
    calipers_override: Optional[Dict[str, Dict[str, float]]] = None,
    r_peaks_override_ms: Optional[Dict[str, List[float]]] = None,
    reference_lead: Optional[str] = None,
    reference_edited: Optional[Sequence[str]] = None,
) -> Dict[str, Any]:
    """
    Runs the automatic analysis. `calipers_override` / `r_peaks_override_ms` (from the caliper workbench) replace the
    automatic R peaks and fiducials per lead, so the report can be refreshed after manual corrections; when
    `reference_lead` is given, its calipers define the global intervals whose boundaries the physician moved
    (`reference_edited`: fiducial names; None = all), the others stay automatic.
    """
    edited = set(reference_edited) if reference_edited is not None else set(FIDUCIAL_KEYS)
    lead_quality = lead_quality or {}
    artifacts_ms = artifacts_ms or {}
    calipers_override = calipers_override or {}
    r_peaks_override_ms = r_peaks_override_ms or {}
    signals = {ln: np.nan_to_num(np.asarray(v, dtype=np.float64)) for ln, v in leads_mv.items() if v is not None and len(v) >= int(0.4 * fs)}
    if not groups:
        groups = _groups_from_lengths(signals)
    groups = [[ln for ln in g if ln in signals] for g in groups]
    groups = [g for g in groups if g]
    # Leads of one simultaneous group must share a time base: a hand-corrected line can come back a few samples
    # longer or shorter than its neighbours -> trim the group to its shortest lead (a few ms at the end)
    for g in groups:
        n_min = min(len(signals[ln]) for ln in g)
        for ln in g:
            signals[ln] = signals[ln][:n_min]
    used_methods: set = set()
    good = lambda ln: lead_quality.get(ln, "ok") != "bad"  # noqa: E731

    per_lead: Dict[str, Any] = {}
    group_results: List[Dict[str, Any]] = []
    for g in groups:
        g_sigs = {ln: clean_ecg_signal(signals[ln], fs=fs, remove_baseline=True, lowpass_hz=40.0) for ln in g}
        # 1-2. R peaks: workbench overrides or consensus detection, then multi-lead fusion
        dets: Dict[str, np.ndarray] = {}
        for ln in g:
            if ln in r_peaks_override_ms and r_peaks_override_ms[ln]:
                dets[ln] = np.asarray([int(round(t * fs / 1000.0)) for t in r_peaks_override_ms[ln]], dtype=int)
                used_methods.add("manual")
            elif good(ln):
                pk, methods = detect_r_peaks_consensus(g_sigs[ln], fs)
                dets[ln] = pk
                used_methods.update(methods)
        if not any(len(v) for v in dets.values()):
            for ln in g:
                pk, methods = detect_r_peaks_consensus(g_sigs[ln], fs)
                dets[ln] = pk
        refs = fuse_group_beats({k: v for k, v in dets.items() if len(v)}, {ln: g_sigs[ln] for ln in g if good(ln)} or g_sigs, fs)
        if refs.size == 0:
            continue
        # exclude beats inside artifact zones of ANY lead of the group (simultaneous recording)
        art = np.zeros(len(refs), dtype=bool)
        for ln in g:
            for z in artifacts_ms.get(ln, []):
                zs, ze = sorted((float(z[0]), float(z[1])))
                art |= (refs * 1000.0 / fs >= zs - 2) & (refs * 1000.0 / fs <= ze + 2)
        premature = _premature_mask(refs, fs)
        rr_all, rr_med = _rr_stats(refs[~art] if (~art).sum() >= 2 else refs, fs)

        # 3-4. templates + global multi-lead delineation (or the workbench calipers relative to the beat reference)
        templates: Dict[str, Tuple[np.ndarray, int]] = {}
        for ln in g:
            tmpl, ref_idx, _ = build_template(g_sigs[ln], refs, fs, rr_med, exclude=premature | art)
            templates[ln] = (tmpl, ref_idx)
        good_leads = [ln for ln in g if good(ln)] or list(g)
        auto_g, lead_peaks = delineate_group(templates, good_leads, fs)
        fids: Dict[str, Dict[str, int]] = {}
        sources: Dict[str, Dict[str, str]] = {}
        for ln in g:
            if ln in calipers_override and calipers_override[ln]:
                cal = calipers_override[ln]
                r_ms = float(cal.get("r_peak", 0.0))
                ref_ms = float(refs[int(np.argmin(np.abs(refs * 1000.0 / fs - r_ms)))]) * 1000.0 / fs
                fids[ln] = {k: int(round((float(cal[k]) - ref_ms) * fs / 1000.0)) for k in FIDUCIAL_KEYS if k in cal}
                sources[ln] = {k: "manual" for k in fids[ln]}
            else:
                fids[ln] = {**auto_g, **lead_peaks.get(ln, {})}
                sources[ln] = {k: "auto" for k in fids[ln]}

        # Group boundaries: the automatic multi-lead delineation, with only the fiducials the physician actually
        # moved on the reference lead replacing it (untouched default calipers never override the analysis)
        gfid = dict(auto_g)
        ref_in_group = bool(reference_lead and reference_lead in g and reference_lead in calipers_override)
        if ref_in_group:
            gfid.update({k: v for k, v in fids[reference_lead].items()
                         if k in ("p_onset", "p_offset", "qrs_onset", "qrs_offset", "t_offset") and k in edited})
        p_moved = ref_in_group and bool({"p_onset", "p_offset"} & edited)
        p_present_template = ("p_onset" in auto_g or p_moved) and "p_onset" in gfid and "p_offset" in gfid

        for ln in g:
            tmpl, ref_idx = templates[ln]
            feats = measure_template(tmpl, ref_idx, gfid, fs)
            feats["quality"] = lead_quality.get(ln, "ok")
            per_lead[ln] = {"features": feats, "fiducials": fids[ln], "sources": sources[ln], "group": len(group_results)}

        def d(a: str, b: str) -> Optional[float]:
            return _ms(gfid[b] - gfid[a], fs) if a in gfid and b in gfid else None

        group_results.append({
            "leads": g,
            "refs": refs,
            "rr_ms": rr_all,
            "rr_median_ms": rr_med,
            "premature": premature,
            "artifact": art,
            "fiducials": gfid,
            "p_present_template": p_present_template,
            "templates": templates,
            "fids": fids,
            "signals": g_sigs,
            "has_reference": bool(reference_lead and reference_lead in g and reference_lead in calipers_override),
            "intervals": {
                "p_ms": d("p_onset", "p_offset") if p_present_template else None,
                "pr_ms": d("p_onset", "qrs_onset") if p_present_template else None,
                "qrs_ms": d("qrs_onset", "qrs_offset"),
                "qt_ms": d("qrs_onset", "t_offset"),
            },
        })

    if not group_results:
        return {"ok": False, "error": "Не удалось обнаружить комплексы QRS ни в одном отведении"}

    # global intervals across groups (12x1: one group; 3x4: median over the column groups — robust to one noisy group)
    # After manual correction the physician's reference lead defines the global intervals (its group only);
    # otherwise combine the groups
    ref_groups = [gr for gr in group_results if gr.get("has_reference")]
    moved_for = {"p_ms": {"p_onset", "p_offset"}, "pr_ms": {"p_onset", "qrs_onset"},
                 "qrs_ms": {"qrs_onset", "qrs_offset"}, "qt_ms": {"qrs_onset", "t_offset"}}

    def agg(key: str, how: str) -> Optional[float]:
        use_ref = bool(ref_groups) and ref_groups[0]["intervals"][key] is not None and bool(moved_for[key] & edited)
        pool = ref_groups if use_ref else group_results
        vals = [gr["intervals"][key] for gr in pool if gr["intervals"][key] is not None]
        if not vals:
            return None
        return float(np.max(vals) if how == "max" else np.median(vals))

    # rhythm from the LONGEST recording (rhythm strip when present), not from the group with the most detections
    rhythm_group = max(group_results, key=lambda gr: (len(next(iter(gr["signals"].values()))), len(gr["leads"])))
    rr_med = rhythm_group["rr_median_ms"]
    intervals = {
        "rr_ms": round(rr_med, 1),
        "p_ms": agg("p_ms", "median"),
        "pr_ms": agg("pr_ms", "median"),
        "qrs_ms": agg("qrs_ms", "median"),
        "qt_ms": agg("qt_ms", "median"),
    }
    rr_known = len(rhythm_group["refs"]) >= 2
    if not rr_known:
        intervals["rr_ms"] = None
    if intervals["qt_ms"] is not None and rr_known:
        rr_s = max(0.25, rr_med / 1000.0)
        hr = 60000.0 / max(250.0, rr_med)
        qt = intervals["qt_ms"]
        intervals.update({
            "qtc_bazett_ms": qt / math.sqrt(rr_s),
            "qtc_fridericia_ms": qt / rr_s ** (1.0 / 3.0),
            "qtc_framingham_ms": qt + 154.0 * (1.0 - rr_s),
            "qtc_hodges_ms": qt + 1.75 * (hr - 60.0),
        })
    intervals = {k: (round(v, 1) if isinstance(v, float) else v) for k, v in intervals.items()}

    # rhythm statistics on the group with most beats (rhythm strip when present)
    refs = rhythm_group["refs"]
    clean_rr = np.diff(refs)[~(rhythm_group["premature"][1:] | rhythm_group["premature"][:-1])] * 1000.0 / fs if len(refs) > 2 else np.diff(refs) * 1000.0 / fs
    rr_cv = float(np.std(clean_rr) / np.mean(clean_rr)) if clean_rr.size >= 2 else 0.0
    rmssd = float(np.sqrt(np.mean(np.diff(clean_rr) ** 2))) if clean_rr.size >= 3 else 0.0
    def p_size(ln: str) -> float:
        f = per_lead.get(ln, {}).get("features", {})
        return abs(float(f.get("p_amp_mv", 0.0))) if f.get("quality") != "bad" else -1.0

    p_lead = max(rhythm_group["leads"], key=p_size)
    tmpl, ref_idx = rhythm_group["templates"][p_lead]
    p_fraction = _p_presence(rhythm_group["signals"][p_lead], refs, tmpl, ref_idx, rhythm_group["fiducials"], fs) if rhythm_group["p_present_template"] else 0.0
    premature_beats = _classify_premature(
        {ln: rhythm_group["signals"][ln] for ln in rhythm_group["leads"]}, refs, rhythm_group["templates"], rhythm_group["premature"], fs
    )
    rhythm = {
        "hr_bpm": round(60000.0 / max(250.0, rr_med), 1) if rr_known else None,
        "n_beats": int(len(refs)),
        "duration_s": round(len(rhythm_group["signals"][p_lead]) / fs, 2),
        "rr_cv": round(rr_cv, 3),
        "rmssd_ms": round(rmssd, 1),
        "p_present_fraction": round(p_fraction, 2),
        "p_lead": p_lead,
        "premature_beats": premature_beats,
        "rhythm_leads": rhythm_group["leads"],
    }

    # axes from the median-beat net amplitudes (same definition as the workbench tables)
    def feat(ln: str, key: str) -> Optional[float]:
        f = per_lead.get(ln, {}).get("features")
        return float(f[key]) if f and f.get("quality") != "bad" else None

    axes = {
        "qrs_axis_deg": hexaxial_axis(feat("I", "qrs_net_mv"), feat("aVF", "qrs_net_mv"), feat("II", "qrs_net_mv")),
        "p_axis_deg": hexaxial_axis(feat("I", "p_amp_mv"), feat("aVF", "p_amp_mv"), feat("II", "p_amp_mv")) if rhythm_group["p_present_template"] else None,
        "t_axis_deg": hexaxial_axis(feat("I", "t_amp_mv"), feat("aVF", "t_amp_mv"), feat("II", "t_amp_mv")),
    }
    if axes["qrs_axis_deg"] is not None and axes["t_axis_deg"] is not None:
        dd = abs(axes["qrs_axis_deg"] - axes["t_axis_deg"]) % 360.0
        axes["qrs_t_angle_deg"] = round(360.0 - dd if dd > 180 else dd, 1)
    else:
        axes["qrs_t_angle_deg"] = None

    # workbench-compatible per-lead analysis (beats with fiducials, representative beat, metrics)
    leads_out: Dict[str, Any] = {}
    for gi, gr in enumerate(group_results):
        refs_g = gr["refs"]
        rr_g = gr["rr_ms"]
        for ln in gr["leads"]:
            off = dict(gr["fids"][ln])
            sig = gr["signals"][ln]
            beats = []
            for bi, r in enumerate(refs_g):
                rad = int(0.05 * fs)
                lo, hi = max(0, r - rad), min(len(sig), r + rad + 1)
                local_r = lo + int(np.argmax(np.abs(sig[lo:hi] - np.median(sig)))) if hi > lo else int(r)
                tms = {k: round(_ms(r + v, fs), 1) for k, v in off.items() if k != "r_peak"}
                tms["r_peak"] = round(_ms(local_r, fs), 1)
                if bi + 1 < len(refs_g):
                    tms["next_r_peak"] = round(_ms(refs_g[bi + 1], fs), 1)
                else:
                    tms["next_r_peak"] = round(tms["r_peak"] + gr["rr_median_ms"], 1)
                beats.append({"r_peak": int(local_r), "times_ms": tms, "premature": bool(gr["premature"][bi])})
            normal = [i for i in range(len(beats)) if not gr["premature"][i] and not gr["artifact"][i]]
            rep = normal[len(normal) // 2] if normal else len(beats) // 2
            rep_times = beats[rep]["times_ms"]
            metrics = compute_intervals_from_calipers(rep_times, sig_mv=signals[ln], fs=fs, rr_ms=gr["rr_median_ms"])
            # replace single-beat amplitudes by the median-beat morphology (robust, used by the report)
            metrics["amplitudes_mv"].update({k: v for k, v in per_lead[ln]["features"].items() if k.endswith("_mv")})
            valid_rr = [float(v) for v in rr_g if 250 <= v <= 2500]
            leads_out[ln] = {
                "r_peaks": [b["r_peak"] for b in beats],
                "r_peaks_ms": [b["times_ms"]["r_peak"] for b in beats],
                "beats": beats,
                "representative_beat_index": int(rep),
                "calipers_ms": rep_times,
                "metrics": metrics,
                "rr_intervals_ms": valid_rr,
                "hrv": {"median_rr_ms": round(gr["rr_median_ms"], 1), "sdnn_ms": round(float(np.std(valid_rr)) if len(valid_rr) >= 2 else 0.0, 1),
                        "rmssd_ms": round(float(np.sqrt(np.mean(np.diff(valid_rr) ** 2))) if len(valid_rr) >= 3 else 0.0, 1)},
                "autoanalysis": {"features": per_lead[ln]["features"], "fiducial_sources": per_lead[ln]["sources"], "group": gi},
            }

    simultaneous = len([gr for gr in group_results if len(gr["leads"]) > 1]) <= 1
    return {
        "ok": True,
        "methods": {
            "neurokit2": NEUROKIT_VERSION,
            "qrs_detectors": sorted(used_methods),
            "delineation": "global multi-lead: spatial velocity (QRS), spatial magnitude + tangent (T, P) on median beats",
        },
        "intervals": intervals,
        "rhythm": rhythm,
        "axes": axes,
        "features": {ln: v["features"] for ln, v in per_lead.items()},
        "groups": [gr["leads"] for gr in group_results],
        "simultaneous_leads": simultaneous,
        "leads": leads_out,
        "primary_lead": next((ln for ln in ("II", "V5", "I", "V2") if ln in leads_out), next(iter(leads_out))),
    }
