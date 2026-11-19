"""
Clinical ECG Signal Processing, Fiducial Wave Delineation, Caliper Engine,
and Interval / Segment / Axis / Hypertrophy Calculations.
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy import signal as sp_signal
from scipy.ndimage import gaussian_filter1d, median_filter


STANDARD_12_LEADS = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]


def clean_ecg_signal(
    raw_mv: np.ndarray,
    fs: float = 500.0,
    remove_baseline: bool = True,
    lowpass_hz: float = 45.0,
) -> np.ndarray:
    """
    Interpolates NaNs, optionally removes severe baseline wander while preserving ST level,
    and applies a zero-phase lowpass filter to remove pixelation noise.
    """
    sig = np.array(raw_mv, dtype=np.float64).copy()
    n = len(sig)
    if n < 10:
        return np.nan_to_num(sig, nan=0.0)

    valid = np.isfinite(sig)
    if not np.any(valid):
        return np.zeros(n, dtype=np.float64)
    if not np.all(valid):
        x = np.arange(n)
        sig = np.interp(x, x[valid], sig[valid])

    # Remove DC offset using median (approximates isoelectric line better than mean)
    sig = sig - np.median(sig)

    if remove_baseline and n > int(fs * 0.8):
        # Gentle high-pass / median baseline estimation (0.6s window) only if drift is large
        win = int(round(fs * 0.65)) | 1
        baseline = median_filter(sig, size=win, mode="nearest")
        baseline = gaussian_filter1d(baseline, sigma=max(1.0, fs * 0.15))
        # Only subtract low-frequency drift if peak-to-peak drift exceeds 0.35 mV
        if np.ptp(baseline) > 0.35:
            sig = sig - baseline * 0.75
        sig = sig - np.median(sig)

    if lowpass_hz and fs > 2.2 * lowpass_hz and n > 24:
        nyq = 0.5 * fs
        b, a = sp_signal.butter(3, min(0.95, lowpass_hz / nyq), btype="low")
        sig = sp_signal.filtfilt(b, a, sig)

    return sig


def detect_qrs_peaks(
    sig_mv: np.ndarray,
    fs: float = 500.0,
    min_rr_sec: float = 0.28,
) -> Tuple[np.ndarray, int]:
    """
    Detects major QRS extremum peaks (either dominant R peak or dominant S nadir if negative lead like aVR/V1).
    Returns:
        r_indices: 1D array of sample indices of QRS main peaks
        polarity: +1 if positive R-dominant, -1 if negative QS/S-dominant
    """
    sig = np.nan_to_num(np.asarray(sig_mv, dtype=np.float64), nan=0.0)
    n = len(sig)
    if n < int(fs * 0.3):
        return np.array([n // 2], dtype=int), 1

    # Bandpass 5 - 25 Hz for QRS energy
    nyq = 0.5 * fs
    low = max(0.01, min(0.9, 5.0 / nyq))
    high = max(low + 0.05, min(0.95, 25.0 / nyq))
    if n > 30:
        b, a = sp_signal.butter(2, [low, high], btype="band")
        filt = sp_signal.filtfilt(b, a, sig)
    else:
        filt = sig - np.median(sig)

    # Determine dominant polarity in filtered QRS range
    p98 = np.percentile(filt, 98.5)
    p02 = np.percentile(filt, 1.5)
    polarity = 1 if abs(p98) >= 0.85 * abs(p02) else -1

    # Derivative + squaring + moving window integration (Pan-Tompkins style)
    diff = np.gradient(filt)
    energy = diff ** 2 + 0.5 * (filt ** 2)
    win = max(3, int(round(0.08 * fs)))
    mwi = np.convolve(energy, np.ones(win) / win, mode="same")

    min_dist = max(5, int(round(min_rr_sec * fs)))
    p50_mwi = np.percentile(mwi, 50)
    p96_mwi = max(p50_mwi + 1e-6, np.percentile(mwi, 96))
    thresh = np.percentile(mwi, 65) + 0.20 * (p96_mwi - p50_mwi)
    peaks, _ = sp_signal.find_peaks(mwi, distance=min_dist, height=max(1e-6, thresh))

    if len(peaks) == 0:
        peaks, _ = sp_signal.find_peaks(mwi, distance=min_dist)
    if len(peaks) == 0:
        return np.array([int(np.argmax(np.abs(sig)))], dtype=int), polarity

    # Refine each peak to the exact R peak (or S nadir) on the unfiltered signal
    search_rad = max(3, int(round(0.075 * fs)))
    refined: List[int] = []
    for pk in peaks:
        lo = max(0, pk - search_rad)
        hi = min(n, pk + search_rad + 1)
        seg = sig[lo:hi]
        # Find positive R peak and negative S peak in window
        pos_idx = lo + int(np.argmax(seg))
        neg_idx = lo + int(np.argmin(seg))
        pos_amp = sig[pos_idx] - np.median(sig)
        neg_amp = np.median(sig) - sig[neg_idx]
        if pos_amp >= 0.45 * neg_amp and pos_amp > 0.08:
            refined.append(pos_idx)
        elif polarity == 1 and pos_amp >= 0.3 * neg_amp:
            refined.append(pos_idx)
        else:
            refined.append(neg_idx)

    # Deduplicate close indices
    refined_sorted = sorted(set(refined))
    final_peaks: List[int] = []
    for idx in refined_sorted:
        if not final_peaks or (idx - final_peaks[-1]) >= min_dist:
            final_peaks.append(idx)
        else:
            if abs(sig[idx]) > abs(sig[final_peaks[-1]]):
                final_peaks[-1] = idx

    return np.array(final_peaks, dtype=int), polarity


def delineate_beat_fiducials(
    sig_mv: np.ndarray,
    r_idx: int,
    fs: float = 500.0,
    prev_r_idx: Optional[int] = None,
    next_r_idx: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Delineates a single cardiac cycle around `r_idx` and returns exact sample indices & times (ms) for:
    - p_onset, p_peak, p_offset
    - qrs_onset (q_onset), q_peak, r_peak, s_peak, qrs_offset (j_point)
    - st_mid (J + 60 ms), st_80 (J + 80 ms)
    - t_onset, t_peak, t_offset
    """
    sig = np.nan_to_num(np.asarray(sig_mv, dtype=np.float64), nan=0.0)
    n = len(sig)
    r_idx = int(np.clip(r_idx, 2, n - 3))

    # Estimate local RR in samples
    rr_prev = (r_idx - prev_r_idx) if (prev_r_idx is not None and r_idx > prev_r_idx) else int(round(0.8 * fs))
    rr_next = (next_r_idx - r_idx) if (next_r_idx is not None and next_r_idx > r_idx) else rr_prev
    rr_samples = int(np.clip(0.5 * (rr_prev + rr_next), int(0.32 * fs), int(1.6 * fs)))

    # Smooth signal slightly for derivative-based onset/offset search
    smooth = gaussian_filter1d(sig, sigma=max(1.0, 0.004 * fs))
    deriv = np.abs(np.gradient(smooth))

    # 1. Locate R_peak (positive peak) and S_peak / Q_peak around r_idx
    qrs_half = max(4, int(round(0.075 * fs)))
    lo_qrs = max(0, r_idx - qrs_half)
    hi_qrs = min(n, r_idx + qrs_half + 1)

    # Determine if r_idx is positive R or negative S/QS
    iso_est = float(np.median(sig[max(0, r_idx - int(0.25 * fs)) : max(1, r_idx - int(0.08 * fs))])) if r_idx > int(0.1 * fs) else float(np.median(sig))
    local_seg = sig[lo_qrs:hi_qrs] - iso_est

    # Find highest positive peak in QRS neighborhood
    r_cand = lo_qrs + int(np.argmax(local_seg))
    nadir_cand = lo_qrs + int(np.argmin(local_seg))

    if local_seg[r_cand - lo_qrs] >= 0.25 * abs(local_seg[nadir_cand - lo_qrs]):
        r_peak = r_cand
    else:
        # Pure QS complex or deep S with tiny r
        r_peak = r_idx

    # Q peak: minimum before r_peak within 55 ms
    q_win_lo = max(0, r_peak - int(round(0.055 * fs)))
    if r_peak > q_win_lo + 1:
        q_seg = sig[q_win_lo:r_peak]
        q_peak = q_win_lo + int(np.argmin(q_seg))
    else:
        q_peak = max(0, r_peak - int(round(0.015 * fs)))

    # S peak: minimum after r_peak within 65 ms
    s_win_hi = min(n, r_peak + int(round(0.065 * fs)) + 1)
    if s_win_hi > r_peak + 1:
        s_seg = sig[r_peak:s_win_hi]
        s_peak = r_peak + int(np.argmin(s_seg))
    else:
        s_peak = min(n - 1, r_peak + int(round(0.02 * fs)))

    # 2. QRS onset (before q_peak / r_peak)
    anchor_left = min(q_peak, r_peak)
    onset_search_lo = max(0, anchor_left - int(round(0.060 * fs)))
    onset_search_hi = max(onset_search_lo + 1, anchor_left)
    if onset_search_hi > onset_search_lo + 2:
        d_seg = deriv[onset_search_lo:onset_search_hi]
        d_thresh = max(np.max(d_seg) * 0.12, np.percentile(deriv, 30) * 0.8, 1e-4)
        below = np.where(d_seg <= d_thresh)[0]
        if len(below) > 0:
            qrs_onset = onset_search_lo + int(below[-1])
        else:
            qrs_onset = onset_search_lo + int(np.argmin(d_seg))
    else:
        qrs_onset = max(0, r_peak - int(round(0.040 * fs)))

    # Ensure sensible QRS onset distance (20 ms to 70 ms before r_peak)
    min_qrs_on = max(0, r_peak - int(round(0.065 * fs)))
    max_qrs_on = max(0, r_peak - int(round(0.018 * fs)))
    qrs_onset = int(np.clip(qrs_onset, min_qrs_on, max_qrs_on))

    # 3. QRS offset / J-point (after s_peak / r_peak)
    anchor_right = max(s_peak, r_peak)
    j_search_lo = min(n - 2, anchor_right)
    j_search_hi = min(n - 1, anchor_right + int(round(0.065 * fs)))
    if j_search_hi > j_search_lo + 2:
        d_seg = deriv[j_search_lo:j_search_hi]
        d_thresh = max(np.max(d_seg) * 0.14, np.percentile(deriv, 35), 1e-4)
        below = np.where(d_seg <= d_thresh)[0]
        if len(below) > 0:
            qrs_offset = j_search_lo + int(below[0])
        else:
            qrs_offset = j_search_lo + int(np.argmin(d_seg))
    else:
        qrs_offset = min(n - 1, r_peak + int(round(0.045 * fs)))

    min_qrs_off = min(n - 1, r_peak + int(round(0.022 * fs)))
    max_qrs_off = min(n - 1, qrs_onset + int(round(0.145 * fs)))
    qrs_offset = int(np.clip(qrs_offset, min_qrs_off, max(min_qrs_off, max_qrs_off)))

    # Estimate PR isoelectric level just before QRS onset (25 ms window)
    iso_win_lo = max(0, qrs_onset - int(round(0.030 * fs)))
    iso_win_hi = max(iso_win_lo + 1, qrs_onset)
    isoelectric_mv = float(np.median(sig[iso_win_lo:iso_win_hi]))

    # 4. P wave delineation (window before qrs_onset: [qrs_onset - 240ms, qrs_onset - 15ms])
    p_search_hi = max(1, qrs_onset - int(round(0.015 * fs)))
    p_search_lo = max(0, qrs_onset - min(int(round(0.240 * fs)), int(0.42 * rr_samples)))
    if p_search_hi > p_search_lo + 5:
        p_seg = smooth[p_search_lo:p_search_hi] - isoelectric_mv
        # Look for peak in P window (usually positive, except aVR/V1 where it can be negative/biphasic)
        p_rel_idx = int(np.argmax(np.abs(p_seg)))
        p_peak = p_search_lo + p_rel_idx
        p_half_max = max(int(round(0.035 * fs)), min(int(round(0.060 * fs)), (p_search_hi - p_search_lo) // 2))

        # P onset
        po_lo = max(0, p_peak - p_half_max)
        if p_peak > po_lo + 2:
            po_seg = np.abs(smooth[po_lo:p_peak] - isoelectric_mv)
            p_amp = max(1e-4, abs(smooth[p_peak] - isoelectric_mv))
            low_pts = np.where(po_seg <= 0.18 * p_amp)[0]
            p_onset = po_lo + int(low_pts[-1]) if len(low_pts) > 0 else po_lo + int(np.argmin(po_seg))
        else:
            p_onset = max(0, p_peak - int(round(0.045 * fs)))

        # P offset
        pf_hi = min(qrs_onset, p_peak + p_half_max)
        if pf_hi > p_peak + 2:
            pf_seg = np.abs(smooth[p_peak:pf_hi] - isoelectric_mv)
            p_amp = max(1e-4, abs(smooth[p_peak] - isoelectric_mv))
            low_pts = np.where(pf_seg <= 0.20 * p_amp)[0]
            p_offset = p_peak + int(low_pts[0]) if len(low_pts) > 0 else p_peak + int(np.argmin(pf_seg))
        else:
            p_offset = min(qrs_onset, p_peak + int(round(0.045 * fs)))
    else:
        p_peak = max(0, qrs_onset - int(round(0.100 * fs)))
        p_onset = max(0, p_peak - int(round(0.045 * fs)))
        p_offset = min(qrs_onset, p_peak + int(round(0.045 * fs)))

    # Enforce P wave physiological ordering: p_onset < p_peak < p_offset <= qrs_onset
    if p_peak - p_onset < int(round(0.025 * fs)):
        p_onset = max(0, p_peak - int(round(0.042 * fs)))
    if p_offset - p_peak < int(round(0.025 * fs)):
        p_offset = min(qrs_onset, p_peak + int(round(0.042 * fs)))

    # 5. ST segment & T wave delineation (after qrs_offset)
    st_60_idx = min(n - 1, qrs_offset + int(round(0.060 * fs)))
    st_80_idx = min(n - 1, qrs_offset + int(round(0.080 * fs)))

    t_search_lo = min(n - 2, qrs_offset + int(round(0.045 * fs)))
    t_max_span = min(int(round(0.360 * fs)), int(0.50 * rr_samples))
    t_search_hi = min(n - 1, qrs_onset + t_max_span)
    if next_r_idx is not None:
        t_search_hi = min(t_search_hi, max(t_search_lo + 8, next_r_idx - int(round(0.220 * fs))))

    if t_search_hi > t_search_lo + 6:
        t_seg = smooth[t_search_lo:t_search_hi] - isoelectric_mv
        t_rel_idx = int(np.argmax(np.abs(t_seg)))
        t_peak = t_search_lo + t_rel_idx
        t_amp = max(1e-4, abs(smooth[t_peak] - isoelectric_mv))

        # T onset: between qrs_offset + 20ms and t_peak
        to_lo = min(t_peak, qrs_offset + int(round(0.025 * fs)))
        if t_peak > to_lo + 3:
            to_seg = np.abs(smooth[to_lo:t_peak] - smooth[to_lo])
            low_pts = np.where(to_seg <= 0.15 * t_amp)[0]
            t_onset = to_lo + int(low_pts[-1]) if len(low_pts) > 0 else to_lo + int(np.argmin(deriv[to_lo:t_peak]))
        else:
            t_onset = max(qrs_offset, t_peak - int(round(0.075 * fs)))

        # T offset (tangent / threshold method after t_peak)
        tf_hi = min(n - 1, t_peak + int(round(0.180 * fs)))
        if next_r_idx is not None:
            tf_hi = min(tf_hi, max(t_peak + 4, next_r_idx - int(round(0.160 * fs))))
        if tf_hi > t_peak + 4:
            post_t = smooth[t_peak:tf_hi]
            # Find steepest descent slope after T peak (classical Lepeschkin tangent method)
            t_grad = np.gradient(post_t)
            if smooth[t_peak] >= isoelectric_mv:
                slope_idx = int(np.argmin(t_grad))
            else:
                slope_idx = int(np.argmax(t_grad))
            slope_val = t_grad[slope_idx]
            baseline_post = float(np.median(post_t[-max(3, len(post_t) // 5) :]))
            if abs(slope_val) > 1e-5:
                # Tangent intersection with baseline_post
                delta_x = (baseline_post - post_t[slope_idx]) / slope_val
                tang_idx = t_peak + int(round(slope_idx + np.clip(delta_x, 3, tf_hi - t_peak)))
            else:
                tang_idx = t_peak + int(round(0.095 * fs))

            # Also check 12% amplitude decay threshold
            rem_amp = np.abs(post_t - baseline_post)
            low_pts = np.where(rem_amp <= 0.12 * max(1e-4, abs(post_t[0] - baseline_post)))[0]
            thresh_idx = (t_peak + int(low_pts[0])) if len(low_pts) > 0 else tang_idx
            t_offset = int(round(0.5 * (tang_idx + thresh_idx)))
            t_offset = int(np.clip(t_offset, t_peak + int(round(0.045 * fs)), tf_hi))
        else:
            t_offset = min(n - 1, t_peak + int(round(0.090 * fs)))
    else:
        t_onset = min(n - 1, qrs_offset + int(round(0.050 * fs)))
        t_peak = min(n - 1, qrs_offset + int(round(0.140 * fs)))
        t_offset = min(n - 1, qrs_offset + int(round(0.240 * fs)))

    def idx_to_ms(idx: int) -> float:
        return round(float(idx) * 1000.0 / fs, 1)

    return {
        "p_onset": int(p_onset),
        "p_peak": int(p_peak),
        "p_offset": int(p_offset),
        "qrs_onset": int(qrs_onset),
        "q_peak": int(q_peak),
        "r_peak": int(r_peak),
        "s_peak": int(s_peak),
        "qrs_offset": int(qrs_offset),
        "st_60": int(st_60_idx),
        "st_80": int(st_80_idx),
        "t_onset": int(t_onset),
        "t_peak": int(t_peak),
        "t_offset": int(t_offset),
        "isoelectric_mv": round(isoelectric_mv, 4),
        "times_ms": {
            "p_onset": idx_to_ms(p_onset),
            "p_peak": idx_to_ms(p_peak),
            "p_offset": idx_to_ms(p_offset),
            "qrs_onset": idx_to_ms(qrs_onset),
            "q_peak": idx_to_ms(q_peak),
            "r_peak": idx_to_ms(r_peak),
            "s_peak": idx_to_ms(s_peak),
            "qrs_offset": idx_to_ms(qrs_offset),
            "st_60": idx_to_ms(st_60_idx),
            "st_80": idx_to_ms(st_80_idx),
            "t_onset": idx_to_ms(t_onset),
            "t_peak": idx_to_ms(t_peak),
            "t_offset": idx_to_ms(t_offset),
        },
    }


def compute_intervals_from_calipers(
    calipers_ms: Dict[str, float],
    sig_mv: Optional[np.ndarray] = None,
    fs: float = 500.0,
    rr_ms: Optional[float] = None,
) -> Dict[str, Any]:
    """
    Computes all clinical ECG intervals, segments, QTc formulas, and wave amplitudes
    from a dictionary of caliper positions in milliseconds (`p_onset`, `p_peak`, `p_offset`,
    `qrs_onset`, `r_peak`, `qrs_offset`, `t_onset`, `t_peak`, `t_offset`, and optional `next_r_peak`).
    Used both for automatic delineation and when the user drags interactive calipers in the UI.
    """
    p_on = float(calipers_ms.get("p_onset", 0.0))
    p_pk = float(calipers_ms.get("p_peak", p_on + 45.0))
    p_off = float(calipers_ms.get("p_offset", p_on + 90.0))
    qrs_on = float(calipers_ms.get("qrs_onset", p_off + 50.0))
    r_pk = float(calipers_ms.get("r_peak", qrs_on + 40.0))
    qrs_off = float(calipers_ms.get("qrs_offset", qrs_on + 88.0))
    t_on = float(calipers_ms.get("t_onset", qrs_off + 65.0))
    t_pk = float(calipers_ms.get("t_peak", t_on + 85.0))
    t_off = float(calipers_ms.get("t_offset", t_pk + 90.0))
    next_r = calipers_ms.get("next_r_peak")

    if rr_ms is None or rr_ms <= 0:
        if next_r is not None and float(next_r) > r_pk + 200.0:
            rr_ms = float(next_r) - r_pk
        else:
            rr_ms = 800.0
    rr_sec = max(0.25, rr_ms / 1000.0)
    hr_bpm = 60000.0 / max(250.0, rr_ms)

    # Durations (ms)
    p_dur_ms = max(0.0, p_off - p_on)
    pq_interval_ms = max(0.0, qrs_on - p_on)
    pq_segment_ms = max(0.0, qrs_on - p_off)
    qrs_dur_ms = max(0.0, qrs_off - qrs_on)
    vat_ms = max(0.0, r_pk - qrs_on)  # Intrinsicoid deflection (VAT)
    st_segment_ms = max(0.0, t_on - qrs_off)
    t_dur_ms = max(0.0, t_off - t_on)
    qt_interval_ms = max(0.0, t_off - qrs_on)
    jt_interval_ms = max(0.0, qt_interval_ms - qrs_dur_ms)
    tpte_ms = max(0.0, t_off - t_pk)
    tpte_qt_ratio = (tpte_ms / qt_interval_ms) if qt_interval_ms > 0 else 0.0
    macruz_index = (p_dur_ms / pq_segment_ms) if pq_segment_ms > 5.0 else None

    # QTc formulas (ms)
    qtc_bazett = qt_interval_ms / math.sqrt(rr_sec)
    qtc_fridericia = qt_interval_ms / (rr_sec ** (1.0 / 3.0))
    qtc_framingham = qt_interval_ms + 154.0 * (1.0 - rr_sec)
    qtc_hodges = qt_interval_ms + 1.75 * (hr_bpm - 60.0)
    jtc_bazett = max(0.0, qtc_bazett - qrs_dur_ms)

    # Amplitudes & ST levels if signal is provided
    amplitudes: Dict[str, float] = {}
    if sig_mv is not None and len(sig_mv) > 10:
        sig = np.nan_to_num(np.asarray(sig_mv, dtype=np.float64), nan=0.0)
        n = len(sig)

        def ms_to_idx(ms_val: float) -> int:
            return int(np.clip(round(ms_val * fs / 1000.0), 0, n - 1))

        idx_p_on = ms_to_idx(p_on)
        idx_p_pk = ms_to_idx(p_pk)
        idx_qrs_on = ms_to_idx(qrs_on)
        idx_r_pk = ms_to_idx(r_pk)
        idx_qrs_off = ms_to_idx(qrs_off)
        idx_t_pk = ms_to_idx(t_pk)
        idx_st60 = ms_to_idx(qrs_off + 60.0)
        idx_st80 = ms_to_idx(qrs_off + 80.0)

        # Isoelectric reference: PR segment just before QRS onset
        iso_lo = max(0, idx_qrs_on - max(2, int(round(0.025 * fs))))
        iso_hi = max(iso_lo + 1, idx_qrs_on + 1)
        iso_mv = float(np.median(sig[iso_lo:iso_hi]))

        qrs_slice = sig[min(idx_qrs_on, idx_qrs_off) : max(idx_qrs_on + 1, idx_qrs_off + 1)] - iso_mv
        r_amp_mv = float(np.max(qrs_slice)) if len(qrs_slice) > 0 else float(sig[idx_r_pk] - iso_mv)
        s_amp_mv = float(np.min(qrs_slice)) if len(qrs_slice) > 0 else 0.0
        qrs_p2p_mv = r_amp_mv - s_amp_mv

        # Separate Q (before R) and S (after R)
        q_slice = sig[min(idx_qrs_on, idx_r_pk) : max(idx_qrs_on + 1, idx_r_pk + 1)] - iso_mv
        s_slice = sig[min(idx_r_pk, idx_qrs_off) : max(idx_r_pk + 1, idx_qrs_off + 1)] - iso_mv
        q_amp_mv = float(min(0.0, np.min(q_slice))) if len(q_slice) > 0 else 0.0
        s_wave_mv = float(min(0.0, np.min(s_slice))) if len(s_slice) > 0 else 0.0

        p_amp_mv = float(sig[idx_p_pk] - iso_mv)
        j_point_mv = float(sig[idx_qrs_off] - iso_mv)
        st60_mv = float(sig[idx_st60] - iso_mv)
        st80_mv = float(sig[idx_st80] - iso_mv)
        t_amp_mv = float(sig[idx_t_pk] - iso_mv)
        st_slope_mv_per_s = (st80_mv - j_point_mv) / 0.080

        amplitudes = {
            "isoelectric_mv": round(iso_mv, 4),
            "p_amp_mv": round(p_amp_mv, 3),
            "q_amp_mv": round(q_amp_mv, 3),
            "r_amp_mv": round(r_amp_mv, 3),
            "s_amp_mv": round(s_wave_mv, 3),
            "qrs_net_mv": round(r_amp_mv + s_amp_mv, 3),
            "qrs_p2p_mv": round(qrs_p2p_mv, 3),
            "j_point_mv": round(j_point_mv, 3),
            "st_60_mv": round(st60_mv, 3),
            "st_80_mv": round(st80_mv, 3),
            "st_slope_mv_s": round(st_slope_mv_per_s, 3),
            "t_amp_mv": round(t_amp_mv, 3),
        }

    # Clinical status flags
    flags: List[Dict[str, str]] = []
    if hr_bpm < 60:
        flags.append({"param": "ЧСС", "level": "warn", "text": f"Синусовая брадикардия / ЧСС < 60 ({hr_bpm:.0f} уд/мин)"})
    elif hr_bpm > 100:
        flags.append({"param": "ЧСС", "level": "warn", "text": f"Тахикардия / ЧСС > 100 ({hr_bpm:.0f} уд/мин)"})
    else:
        flags.append({"param": "ЧСС", "level": "normal", "text": f"Нормокардия ({hr_bpm:.0f} уд/мин)"})

    if pq_interval_ms > 200:
        flags.append({"param": "Интервал PQ", "level": "alert", "text": f"Удлинение PQ > 200 мс ({pq_interval_ms:.0f} мс) — АВ-блокада I ст."})
    elif pq_interval_ms < 120 and pq_interval_ms > 40:
        flags.append({"param": "Интервал PQ", "level": "warn", "text": f"Укорочение PQ < 120 мс ({pq_interval_ms:.0f} мс) — синдром предвозбуждения / ускоренное АВ-проведение"})
    else:
        flags.append({"param": "Интервал PQ", "level": "normal", "text": f"Интервал PQ в норме ({pq_interval_ms:.0f} мс, норма 120–200 мс)"})

    if qrs_dur_ms >= 120:
        flags.append({"param": "Комплекс QRS", "level": "alert", "text": f"Расширение QRS ≥ 120 мс ({qrs_dur_ms:.0f} мс) — полная блокада ножки пучка Гиса / внутрижелудочковая блокада"})
    elif qrs_dur_ms > 105:
        flags.append({"param": "Комплекс QRS", "level": "warn", "text": f"Умеренное уширение QRS ({qrs_dur_ms:.0f} мс, норма 60–100 мс)"})
    else:
        flags.append({"param": "Комплекс QRS", "level": "normal", "text": f"Длительность QRS в норме ({qrs_dur_ms:.0f} мс)"})

    if qtc_fridericia > 460 or qtc_bazett > 470:
        flags.append({"param": "Интервал QTc", "level": "alert", "text": f"Удлинение QTc (Bazett {qtc_bazett:.0f} мс, Fridericia {qtc_fridericia:.0f} мс)"})
    elif qtc_fridericia < 340:
        flags.append({"param": "Интервал QTc", "level": "warn", "text": f"Укорочение QTc ({qtc_fridericia:.0f} мс)"})
    else:
        flags.append({"param": "Интервал QTc", "level": "normal", "text": f"Интервал QTc в норме (Bazett {qtc_bazett:.0f} мс, Fridericia {qtc_fridericia:.0f} мс)"})

    st80 = amplitudes.get("st_80_mv", 0.0)
    if st80 >= 0.10:
        flags.append({"param": "Сегмент ST", "level": "alert", "text": f"Элевация сегмента ST +{st80:.2f} мВ (+{st80*10:.1f} мм)"})
    elif st80 <= -0.10:
        flags.append({"param": "Сегмент ST", "level": "alert", "text": f"Депрессия сегмента ST {st80:.2f} мВ ({st80*10:.1f} мм)"})

    return {
        "hr_bpm": round(hr_bpm, 1),
        "rr_ms": round(rr_ms, 1),
        "durations_ms": {
            "p_wave": round(p_dur_ms, 1),
            "qrs_complex": round(qrs_dur_ms, 1),
            "t_wave": round(t_dur_ms, 1),
            "intrinsicoid_vat": round(vat_ms, 1),
        },
        "intervals_ms": {
            "pq_pr": round(pq_interval_ms, 1),
            "qt": round(qt_interval_ms, 1),
            "qtc_bazett": round(qtc_bazett, 1),
            "qtc_fridericia": round(qtc_fridericia, 1),
            "qtc_framingham": round(qtc_framingham, 1),
            "qtc_hodges": round(qtc_hodges, 1),
            "jt": round(jt_interval_ms, 1),
            "jtc_bazett": round(jtc_bazett, 1),
            "tp_te": round(tpte_ms, 1),
            "rr": round(rr_ms, 1),
        },
        "segments_ms": {
            "pq_pr_segment": round(pq_segment_ms, 1),
            "st_segment": round(st_segment_ms, 1),
            "tp_segment": round(max(0.0, rr_ms - (t_off - p_on)), 1),
        },
        "ratios": {
            "tpte_qt_ratio": round(tpte_qt_ratio, 3),
            "macruz_index": round(macruz_index, 2) if macruz_index is not None else None,
        },
        "amplitudes_mv": amplitudes,
        "clinical_flags": flags,
    }


def analyze_all_leads(
    leads_mv: Dict[str, List[float]],
    fs: float = 500.0,
    preferred_lead: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Performs full clinical analysis across all digitized leads:
    - Finds R peaks and per-beat fiducial points on every lead
    - Selects best reference lead (typically II, V5, V2, or I) for default caliper display
    - Calculates electrical axes (P, QRS, T) when limb leads (I, II, III, aVF, aVL) are present
    - Calculates hypertrophy indices (Sokolow-Lyon, Cornell) when precordial/limb leads are present
    """
    per_lead_results: Dict[str, Any] = {}
    cleaned_signals: Dict[str, np.ndarray] = {}

    for lead_name, raw_arr in leads_mv.items():
        if raw_arr is None or len(raw_arr) < 10:
            continue
        arr = np.asarray(raw_arr, dtype=np.float64)
        if np.all(np.isnan(arr)):
            continue
        clean = clean_ecg_signal(arr, fs=fs, remove_baseline=False, lowpass_hz=45.0)
        cleaned_signals[lead_name] = clean

        r_peaks, polarity = detect_qrs_peaks(clean, fs=fs)
        beats: List[Dict[str, Any]] = []
        for idx_i, r_idx in enumerate(r_peaks):
            prev_r = int(r_peaks[idx_i - 1]) if idx_i > 0 else None
            next_r = int(r_peaks[idx_i + 1]) if idx_i + 1 < len(r_peaks) else None
            fid = delineate_beat_fiducials(clean, int(r_idx), fs=fs, prev_r_idx=prev_r, next_r_idx=next_r)
            if next_r is not None:
                fid["times_ms"]["next_r_peak"] = round(float(next_r) * 1000.0 / fs, 1)
            beats.append(fid)

        # Pick a representative middle beat (avoiding truncated edge beats)
        if len(beats) >= 3:
            rep_idx = len(beats) // 2
        elif len(beats) == 2:
            rep_idx = 0 if beats[0]["r_peak"] > int(0.18 * fs) else 1
        elif len(beats) == 1:
            rep_idx = 0
        else:
            rep_idx = 0

        rr_diffs_ms = np.diff(r_peaks) * 1000.0 / fs if len(r_peaks) >= 2 else np.array([])
        valid_rr = rr_diffs_ms[(rr_diffs_ms >= 280.0) & (rr_diffs_ms <= 2200.0)]
        median_rr_ms = float(np.median(valid_rr)) if len(valid_rr) > 0 else 800.0
        sdnn_ms = float(np.std(valid_rr)) if len(valid_rr) >= 2 else 0.0
        rmssd_ms = float(np.sqrt(np.mean(np.diff(valid_rr) ** 2))) if len(valid_rr) >= 3 else 0.0

        rep_beat = beats[rep_idx] if beats else delineate_beat_fiducials(clean, len(clean) // 2, fs=fs)
        metrics = compute_intervals_from_calipers(
            rep_beat["times_ms"],
            sig_mv=clean,
            fs=fs,
            rr_ms=median_rr_ms,
        )

        per_lead_results[lead_name] = {
            "r_peaks": [int(x) for x in r_peaks],
            "r_peaks_ms": [round(float(x) * 1000.0 / fs, 1) for x in r_peaks],
            "polarity": polarity,
            "representative_beat_index": rep_idx,
            "beats": beats,
            "calipers_ms": rep_beat["times_ms"],
            "calipers_samples": {k: v for k, v in rep_beat.items() if isinstance(v, int)},
            "metrics": metrics,
            "rr_intervals_ms": [round(float(x), 1) for x in valid_rr],
            "hrv": {
                "median_rr_ms": round(median_rr_ms, 1),
                "sdnn_ms": round(sdnn_ms, 1),
                "rmssd_ms": round(rmssd_ms, 1),
            },
        }

    # Choose primary reference lead for global summary
    priority_order = ["II", "V5", "V4", "I", "V2", "V3", "V6", "aVF", "III", "V1", "aVL", "aVR"]
    primary_lead = preferred_lead if (preferred_lead and preferred_lead in per_lead_results) else None
    if not primary_lead:
        for cand in priority_order:
            if cand in per_lead_results:
                primary_lead = cand
                break
    if not primary_lead and per_lead_results:
        primary_lead = next(iter(per_lead_results.keys()))

    # Compute electrical axes (Einthoven / Hexaxial) if limb leads exist
    axes_deg: Dict[str, Optional[float]] = {"qrs_axis_deg": None, "p_axis_deg": None, "t_axis_deg": None, "qrs_t_angle_deg": None}
    axis_classification = "Не определяется (нет отведений от конечностей)"

    def calc_hexaxial_angle(val_i: float, val_avf: Optional[float], val_ii: Optional[float]) -> Optional[float]:
        if val_avf is not None and abs(val_i) + abs(val_avf) > 1e-4:
            # Standard hexaxial formula using Lead I and aVF: tan(alpha) = (2/sqrt(3)) * aVF / I
            angle = math.degrees(math.atan2(val_avf, val_i))
            return round(angle, 1)
        if val_ii is not None and abs(val_i) + abs(val_ii) > 1e-4:
            # From I and II: aVF = II - 0.5*I -> y = (2*II - I) / sqrt(3)
            y = (2.0 * val_ii - val_i) / math.sqrt(3.0)
            angle = math.degrees(math.atan2(y, val_i))
            return round(angle, 1)
        return None

    if "I" in per_lead_results and ("aVF" in per_lead_results or "II" in per_lead_results):
        amp_i = per_lead_results["I"]["metrics"]["amplitudes_mv"]
        amp_avf = per_lead_results["aVF"]["metrics"]["amplitudes_mv"] if "aVF" in per_lead_results else None
        amp_ii = per_lead_results["II"]["metrics"]["amplitudes_mv"] if "II" in per_lead_results else None

        qrs_axis = calc_hexaxial_angle(
            amp_i.get("qrs_net_mv", 0.0),
            amp_avf.get("qrs_net_mv", 0.0) if amp_avf else None,
            amp_ii.get("qrs_net_mv", 0.0) if amp_ii else None,
        )
        p_axis = calc_hexaxial_angle(
            amp_i.get("p_amp_mv", 0.0),
            amp_avf.get("p_amp_mv", 0.0) if amp_avf else None,
            amp_ii.get("p_amp_mv", 0.0) if amp_ii else None,
        )
        t_axis = calc_hexaxial_angle(
            amp_i.get("t_amp_mv", 0.0),
            amp_avf.get("t_amp_mv", 0.0) if amp_avf else None,
            amp_ii.get("t_amp_mv", 0.0) if amp_ii else None,
        )
        axes_deg["qrs_axis_deg"] = qrs_axis
        axes_deg["p_axis_deg"] = p_axis
        axes_deg["t_axis_deg"] = t_axis
        if qrs_axis is not None and t_axis is not None:
            diff = abs(qrs_axis - t_axis) % 360.0
            axes_deg["qrs_t_angle_deg"] = round(360.0 - diff if diff > 180.0 else diff, 1)

        if qrs_axis is not None:
            if -30.0 <= qrs_axis <= 90.0:
                if 0.0 <= qrs_axis <= 70.0:
                    axis_classification = f"Нормальное положение ЭОС ({qrs_axis:+.0f}°)"
                elif -30.0 <= qrs_axis < 0.0:
                    axis_classification = f"Горизонтальное положение ЭОС ({qrs_axis:+.0f}°)"
                else:
                    axis_classification = f"Вертикальное положение ЭОС ({qrs_axis:+.0f}°)"
            elif -90.0 <= qrs_axis < -30.0:
                axis_classification = f"Отклонение ЭОС влево ({qrs_axis:+.0f}°)"
            elif 90.0 < qrs_axis <= 180.0:
                axis_classification = f"Отклонение ЭОС вправо ({qrs_axis:+.0f}°)"
            else:
                axis_classification = f"Резкое отклонение ЭОС (северо-западная ось, {qrs_axis:+.0f}°)"

    # Compute hypertrophy indices (Sokolow-Lyon & Cornell)
    hypertrophy: Dict[str, Any] = {}
    if "V1" in per_lead_results and ("V5" in per_lead_results or "V6" in per_lead_results):
        s_v1 = abs(per_lead_results["V1"]["metrics"]["amplitudes_mv"].get("s_amp_mv", 0.0))
        r_v5 = per_lead_results["V5"]["metrics"]["amplitudes_mv"].get("r_amp_mv", 0.0) if "V5" in per_lead_results else 0.0
        r_v6 = per_lead_results["V6"]["metrics"]["amplitudes_mv"].get("r_amp_mv", 0.0) if "V6" in per_lead_results else 0.0
        sokolow_mv = s_v1 + max(r_v5, r_v6)
        hypertrophy["sokolow_lyon_mv"] = round(sokolow_mv, 2)
        hypertrophy["sokolow_lyon_mm"] = round(sokolow_mv * 10.0, 1)
        hypertrophy["sokolow_lyon_lvh"] = bool(sokolow_mv >= 3.5)

    if "aVL" in per_lead_results and "V3" in per_lead_results:
        r_avl = per_lead_results["aVL"]["metrics"]["amplitudes_mv"].get("r_amp_mv", 0.0)
        s_v3 = abs(per_lead_results["V3"]["metrics"]["amplitudes_mv"].get("s_amp_mv", 0.0))
        cornell_mv = r_avl + s_v3
        hypertrophy["cornell_mv"] = round(cornell_mv, 2)
        hypertrophy["cornell_mm"] = round(cornell_mv * 10.0, 1)
        hypertrophy["cornell_lvh"] = bool(cornell_mv >= 2.8)

    # Global consensus metrics (median across reliable leads)
    all_rrs = [v["hrv"]["median_rr_ms"] for v in per_lead_results.values() if 300 <= v["hrv"]["median_rr_ms"] <= 2000]
    global_rr_ms = float(np.median(all_rrs)) if all_rrs else 800.0
    global_hr_bpm = round(60000.0 / max(250.0, global_rr_ms), 1)

    primary_summary = per_lead_results[primary_lead]["metrics"] if primary_lead else {}

    return {
        "primary_lead": primary_lead,
        "global_hr_bpm": global_hr_bpm,
        "global_rr_ms": round(global_rr_ms, 1),
        "axes": {
            **axes_deg,
            "classification": axis_classification,
        },
        "hypertrophy": hypertrophy,
        "primary_metrics": primary_summary,
        "leads": per_lead_results,
    }
