"""
Multi-Method ECG Photo Digitization Engine.

Integrates three state-of-the-art ECG digitization paradigms plus a Hybrid Ensemble:
1. `open_ecg_unet` — Open-ECG-Digitizer (Ahus-AIM): Pretrained 4-class U-Net segmentation
   (grid, text, signal, background) + 13-class Lead-Name U-Net + Hough PerspectiveDetector +
   PixelSizeFinder zoomed autocorrelation grid calibration + Hungarian component SignalExtractor.
2. `krones_hough_cv` — ECG-Digitiser (Felix Krones et al., PhysioNet 2024 1st place approach):
   Paper ROI isolation + Hough transform grid rectification + LAB/HSV grid color suppression +
   morphological dark-trace extraction & sub-pixel centroid tracking.
3. `dangnh_heatmap_dp` — Kaggle 5th place (dangnh0611) inspired multi-stage heatmap +
   baseline row peak detection + regularized Viterbi Dynamic Programming & Hungarian multi-lead
   trace tracking with overlap resolution.
4. `hybrid_ensemble` (Default) — Fuses Open-ECG-Digitizer's pretrained U-Net probability maps
   with adaptive high-resolution ink blackness, automatic paper ROI & perspective rectification,
   PixelSizeFinder autocorrelation mm/px calibration, LeadNameUNet layout recognition, and
   collision-aware Viterbi path extraction.
"""

from __future__ import annotations

import base64
import math
import os
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np
from scipy import ndimage, signal as sp_signal

VENDOR_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "vendor", "Open-ECG-Digitizer"))
if VENDOR_DIR not in sys.path:
    sys.path.insert(0, VENDOR_DIR)

# Deep-learning stack (PyTorch + vendored Open-ECG-Digitizer) is optional: without it the server still starts
# and every request transparently falls back to the classical `krones_hough_cv` pipeline.
try:
    import torch
    import torch.nn.functional as F
    from src.model.unet import UNet
    from src.model.pixel_size_finder import PixelSizeFinder

    _DL_IMPORT_ERROR: Optional[str] = None
except Exception as _exc:  # pragma: no cover - depends on local installation
    torch = None  # type: ignore[assignment]
    F = None  # type: ignore[assignment]
    UNet = None  # type: ignore[assignment,misc]
    PixelSizeFinder = None  # type: ignore[assignment,misc]
    _DL_IMPORT_ERROR = f"{type(_exc).__name__}: {_exc}"


WEIGHTS_DIR = os.path.join(VENDOR_DIR, "weights")
UNET_WEIGHTS_PATH = os.path.join(WEIGHTS_DIR, "unet_weights_07072025.pt")
LEAD_UNET_WEIGHTS_PATH = os.path.join(WEIGHTS_DIR, "lead_name_unet_weights_07072025.pt")

DL_METHODS = ("hybrid_ensemble", "open_ecg_unet", "dangnh_heatmap_dp")
SUPPORTED_METHODS = DL_METHODS + ("krones_hough_cv",)


try:  # Optional JIT for the Viterbi DP inner loop (pure-NumPy fallback below gives identical results)
    import numba as _numba

    @_numba.njit(cache=True, nogil=True)
    def _viterbi_forward_numba(dp, backptr, reward, blank_cumsum, qrs_col_mask, idx_mat, pen_qrs, pen_non_qrs):  # pragma: no cover
        H_b, W_b = reward.shape
        M = idx_mat.shape[1]
        for x in range(1, W_b):
            pen = pen_qrs if qrs_col_mask[x] else pen_non_qrs
            for y in range(H_b):
                cs_y = blank_cumsum[y, x]
                best_val = -np.inf
                best_src = 0
                for m in range(M):
                    src = idx_mat[y, m]
                    val = (dp[src, x - 1] - pen[m]) - 0.42 * abs(cs_y - blank_cumsum[src, x])
                    if val > best_val:
                        best_val = val
                        best_src = src
                dp[y, x] = reward[y, x] + best_val
                backptr[y, x] = best_src

except Exception:  # pragma: no cover - numba not installed
    _viterbi_forward_numba = None


def deep_learning_status() -> Dict[str, Any]:
    """Reports whether the U-Net based methods can run (PyTorch + vendor code + weight files present)."""
    if _DL_IMPORT_ERROR is not None:
        return {"available": False, "reason": f"Не удалось импортировать PyTorch / Open-ECG-Digitizer ({_DL_IMPORT_ERROR})"}
    missing = [os.path.basename(p) for p in (UNET_WEIGHTS_PATH, LEAD_UNET_WEIGHTS_PATH) if not os.path.isfile(p)]
    if missing:
        return {"available": False, "reason": f"Не найдены веса U-Net в {WEIGHTS_DIR}: {', '.join(missing)}"}
    return {"available": True, "reason": ""}

LEAD_CHANNEL_ORDER = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]

LAYOUT_DEFINITIONS: Dict[str, Dict[str, Any]] = {
    "12x1": {
        "label": "12×1 Стандарт (12 отведений вертикально)",
        "rows": 12,
        "cols": 1,
        "grid": [["I"], ["II"], ["III"], ["aVR"], ["aVL"], ["aVF"], ["V1"], ["V2"], ["V3"], ["V4"], ["V5"], ["V6"]],
        "rhythm": [],
    },
    "3x4_r1": {
        "label": "3×4 + 1 полоса ритма (II)",
        "rows": 3,
        "cols": 4,
        "grid": [
            ["I", "aVR", "V1", "V4"],
            ["II", "aVL", "V2", "V5"],
            ["III", "aVF", "V3", "V6"],
        ],
        "rhythm": ["II (ритм)"],
    },
    "3x4_r2": {
        "label": "3×4 + 2 полосы ритма (I, II)",
        "rows": 3,
        "cols": 4,
        "grid": [
            ["I", "aVR", "V1", "V4"],
            ["II", "aVL", "V2", "V5"],
            ["III", "aVF", "V3", "V6"],
        ],
        "rhythm": ["I (ритм)", "II (ритм)"],
    },
    "3x4": {
        "label": "3×4 Стандарт (4 колонки по 3 отведения)",
        "rows": 3,
        "cols": 4,
        "grid": [
            ["I", "aVR", "V1", "V4"],
            ["II", "aVL", "V2", "V5"],
            ["III", "aVF", "V3", "V6"],
        ],
        "rhythm": [],
    },
    "6x2_r1": {
        "label": "6×2 + 1 полоса ритма (II)",
        "rows": 6,
        "cols": 2,
        "grid": [
            ["I", "V1"],
            ["II", "V2"],
            ["III", "V3"],
            ["aVR", "V4"],
            ["aVL", "V5"],
            ["aVF", "V6"],
        ],
        "rhythm": ["II (ритм)"],
    },
    "6x2": {
        "label": "6×2 Стандарт (I–aVF слева, V1–V6 справа)",
        "rows": 6,
        "cols": 2,
        "grid": [
            ["I", "V1"],
            ["II", "V2"],
            ["III", "V3"],
            ["aVR", "V4"],
            ["aVL", "V5"],
            ["aVF", "V6"],
        ],
        "rhythm": [],
    },
    "6x1_precordial": {
        "label": "6×1 Грудные отведения (V1–V6)",
        "rows": 6,
        "cols": 1,
        "grid": [["V1"], ["V2"], ["V3"], ["V4"], ["V5"], ["V6"]],
        "rhythm": [],
    },
    "6x1_limb": {
        "label": "6×1 Отведения от конечностей (I, II, III, aVR, aVL, aVF)",
        "rows": 6,
        "cols": 1,
        "grid": [["I"], ["II"], ["III"], ["aVR"], ["aVL"], ["aVF"]],
        "rhythm": [],
    },
    "cabrera_12x1": {
        "label": "12×1 Кабрера (aVL, I, -aVR, II, aVF, III, V1–V6)",
        "rows": 12,
        "cols": 1,
        "grid": [["aVL"], ["I"], ["-aVR"], ["II"], ["aVF"], ["III"], ["V1"], ["V2"], ["V3"], ["V4"], ["V5"], ["V6"]],
        "rhythm": [],
    },
    "single_strip": {
        "label": "1×1 Одиночная полоса ритма (II)",
        "rows": 1,
        "cols": 1,
        "grid": [["II"]],
        "rhythm": [],
    },
}


class ModelRegistry:
    """Lazy, thread-safe singleton loader for Open-ECG-Digitizer pretrained U-Net models."""

    _unet: Optional[Any] = None
    _lead_unet: Optional[Any] = None
    _device: str = "cuda" if (torch is not None and torch.cuda.is_available()) else "cpu"
    _lock = threading.Lock()

    @classmethod
    def get_segmentation_unet(cls) -> Any:
        with cls._lock:
            return cls._load_segmentation_unet()

    @classmethod
    def get_lead_name_unet(cls) -> Any:
        with cls._lock:
            return cls._load_lead_name_unet()

    @classmethod
    def _load_segmentation_unet(cls) -> Any:
        if cls._unet is None:
            model = UNet(
                num_in_channels=3,
                num_out_channels=4,
                depth=2,
                dims=[32, 64, 128, 256, 320, 320, 320, 320],
            )
            ckpt = torch.load(UNET_WEIGHTS_PATH, map_location=cls._device, weights_only=True)
            if isinstance(ckpt, tuple):
                ckpt = ckpt[0]
            ckpt = {k.replace("_orig_mod.", ""): v for k, v in ckpt.items()}
            model.load_state_dict(ckpt)
            model.to(cls._device).eval()
            cls._unet = model
        return cls._unet

    @classmethod
    def _load_lead_name_unet(cls) -> Any:
        if cls._lead_unet is None:
            model = UNet(
                num_in_channels=1,
                num_out_channels=13,
                depth=2,
                dims=[32, 64, 128, 256, 256],
            )
            ckpt = torch.load(LEAD_UNET_WEIGHTS_PATH, map_location=cls._device, weights_only=True)
            if isinstance(ckpt, tuple):
                ckpt = ckpt[0]
            ckpt = {k.replace("_orig_mod.", ""): v for k, v in ckpt.items()}
            model.load_state_dict(ckpt)
            model.to(cls._device).eval()
            cls._lead_unet = model
        return cls._lead_unet


def encode_image_base64(img_rgb: np.ndarray, quality: int = 86) -> str:
    """Encodes an RGB uint8 numpy image as a data:image/jpeg;base64 URI."""
    img_bgr = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode(".jpg", img_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        return ""
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def classical_grid_and_signal_maps(img_rgb: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """
    Felix Krones (ECG-Digitiser) & classical color-space decoupling:
    Separates millimeter ECG grid (pink/red/orange/blue) from dark ink ECG trace.
    Returns:
        sig_map: float32 (H, W) in [0, 1] representing waveform trace probability
        grid_map: float32 (H, W) in [0, 1] representing millimeter grid line probability
    """
    H, W, _ = img_rgb.shape
    # Normalize illumination using morphological background estimation
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    ksize = max(21, (min(H, W) // 20) | 1)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (ksize, ksize))
    bg = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, kernel)
    norm_dark = np.clip((bg - gray) / (bg + 15.0), 0.0, 1.0)

    # In pink/red/orange grid paper, the grid absorbs green/blue but reflects red.
    # Therefore, the red channel (or max(R, B) for blue grid) suppresses colored grids while keeping black/dark-blue ink!
    r_ch = img_rgb[:, :, 0].astype(np.float32)
    g_ch = img_rgb[:, :, 1].astype(np.float32)
    b_ch = img_rgb[:, :, 2].astype(np.float32)

    # Check if grid is predominantly warm (pink/red/orange) or cool (blue/green)
    color_warmth = np.mean(r_ch - 0.5 * (g_ch + b_ch))
    if color_warmth >= 2.0:
        # Warm grid: black ink is dark in RED channel; pink grid is bright in RED channel
        bg_r = cv2.morphologyEx(r_ch, cv2.MORPH_CLOSE, kernel)
        ink_raw = np.clip((bg_r - r_ch) / (bg_r + 15.0), 0.0, 1.0)
        grid_chroma = np.clip((r_ch - g_ch) / 255.0, 0.0, 1.0)
    else:
        # Neutral or blue grid: use minimum darkness across R and max channel
        max_ch = np.maximum(r_ch, b_ch)
        bg_m = cv2.morphologyEx(max_ch, cv2.MORPH_CLOSE, kernel)
        ink_raw = np.clip((bg_m - max_ch) / (bg_m + 15.0), 0.0, 1.0)
        grid_chroma = np.clip(norm_dark - ink_raw, 0.0, 1.0)

    # Enhance thin dark trace lines: ECG ink occupies only ~2-4% of paper area, so threshold at 93rd percentile
    p93 = np.percentile(ink_raw, 93)
    p998 = max(p93 + 0.05, np.percentile(ink_raw, 99.8))
    sig_map = np.clip((ink_raw - p93) / (p998 - p93), 0.0, 1.0)

    # Grid map from high-pass horizontal & vertical line response
    grid_base = np.maximum(grid_chroma, np.clip(norm_dark - 0.7 * sig_map, 0.0, 1.0))
    g_p60 = np.percentile(grid_base, 60)
    g_p99 = max(g_p60 + 0.05, np.percentile(grid_base, 99.0))
    grid_map = np.clip((grid_base - g_p60) / (g_p99 - g_p60), 0.0, 1.0)

    return sig_map.astype(np.float32), grid_map.astype(np.float32)


def run_open_ecg_unet_segmentation(
    img_rgb: np.ndarray,
    max_dim: int = 1400,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Runs Open-ECG-Digitizer's pretrained 4-class U-Net model (`unet_weights_07072025.pt`)
    and returns full-resolution aligned probability maps `(signal_prob, grid_prob, text_prob)`
    as float32 numpy arrays of shape `(H, W)` in `[0, 1]`.
    """
    H, W, _ = img_rgb.shape
    device = ModelRegistry._device
    unet = ModelRegistry.get_segmentation_unet()

    t = torch.from_numpy(img_rgb).permute(2, 0, 1).unsqueeze(0).float().to(device)
    t = (t - t.min()) / (t.max() - t.min() + 1e-8)

    cur_max = max(H, W)
    if cur_max > max_dim:
        scale = max_dim / float(cur_max)
        nh, nw = int(round(H * scale)), int(round(W * scale))
        t_in = F.interpolate(t, size=(nh, nw), mode="bilinear", align_corners=False, antialias=True)
    else:
        t_in = t

    with torch.no_grad():
        logits = unet(t_in)
        prob = torch.softmax(logits, dim=1)

        def sparse_norm(ch: torch.Tensor) -> torch.Tensor:
            ch = ch - ch.mean()
            ch = torch.clamp(ch, min=0.0)
            return ch / (ch.max() + 1e-9)

        grid_p = sparse_norm(prob[:, 0:1])
        text_p = sparse_norm(prob[:, 1:2])
        sig_p = sparse_norm(prob[:, 2:3])

        if (grid_p.shape[2], grid_p.shape[3]) != (H, W):
            grid_p = F.interpolate(grid_p, size=(H, W), mode="bilinear", align_corners=False)
            text_p = F.interpolate(text_p, size=(H, W), mode="bilinear", align_corners=False)
            sig_p = F.interpolate(sig_p, size=(H, W), mode="bilinear", align_corners=False)

    return (
        sig_p.squeeze().cpu().numpy().astype(np.float32),
        grid_p.squeeze().cpu().numpy().astype(np.float32),
        text_p.squeeze().cpu().numpy().astype(np.float32),
    )


def crop_and_deskew_ecg_region(
    img_rgb: np.ndarray,
    sig_prob: np.ndarray,
    grid_prob: np.ndarray,
    text_prob: np.ndarray,
    custom_roi: Optional[Dict[str, float]] = None,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, Dict[str, Any]]:
    """
    Isolates the ECG paper / grid region (removing wooden tables, hands, or viewer UI borders)
    and corrects rotation / skew angle using Hough transform on the grid probability map.
    """
    H, W, _ = img_rgb.shape
    meta: Dict[str, Any] = {"original_size": [W, H], "skew_angle_deg": 0.0}

    # 1. If user provided custom ROI (normalized 0..1: x, y, w, h), apply it first
    if custom_roi and all(k in custom_roi for k in ("x", "y", "w", "h")):
        x0 = int(np.clip(custom_roi["x"] * W, 0, W - 10))
        y0 = int(np.clip(custom_roi["y"] * H, 0, H - 10))
        x1 = int(np.clip((custom_roi["x"] + custom_roi["w"]) * W, x0 + 10, W))
        y1 = int(np.clip((custom_roi["y"] + custom_roi["h"]) * H, y0 + 10, H))
        meta["crop_box"] = [x0, y0, x1, y1]
    else:
        # Automatic paper & signal ROI detection using grid_prob and sig_prob
        combined = 0.65 * grid_prob + 0.85 * sig_prob
        row_profile = np.mean(combined, axis=1)
        col_profile = np.mean(combined, axis=0)

        row_thresh = max(0.015, np.percentile(row_profile, 20) + 0.14 * (np.max(row_profile) - np.min(row_profile)))
        col_thresh = max(0.015, np.percentile(col_profile, 15) + 0.12 * (np.max(col_profile) - np.min(col_profile)))

        active_rows = np.where(row_profile >= row_thresh)[0]
        active_cols = np.where(col_profile >= col_thresh)[0]

        if len(active_rows) > 10 and len(active_cols) > 10:
            # Find largest contiguous active vertical block (isolates thermal strip on desk or grid inside screenshot)
            gaps = np.where(np.diff(active_rows) > max(15, int(0.06 * H)))[0]
            blocks = np.split(active_rows, gaps + 1)
            best_i = max(range(len(blocks)), key=lambda i: float(np.sum(row_profile[blocks[i]])))
            # Grow the block over neighbours printed on the SAME grid paper: a 12x1 A4 sheet has an empty band
            # between limb and chest leads, which must not cut the sheet in half. A desk / hand next to a thermal
            # strip has (almost) no grid response, so it is still excluded.
            grid_rows = np.mean(grid_prob, axis=1)
            best_grid = float(np.mean(grid_rows[blocks[best_i]])) + 1e-6
            lo_i = hi_i = best_i
            while lo_i - 1 >= 0 and float(np.mean(grid_rows[blocks[lo_i - 1][0] : blocks[lo_i][0]])) >= 0.5 * best_grid:
                lo_i -= 1
            while hi_i + 1 < len(blocks) and float(np.mean(grid_rows[blocks[hi_i][-1] : blocks[hi_i + 1][-1] + 1])) >= 0.5 * best_grid:
                hi_i += 1
            pad_y = int(round(0.025 * H))
            pad_x = int(round(0.015 * W))
            y0 = max(0, int(blocks[lo_i][0]) - pad_y)
            y1 = min(H, int(blocks[hi_i][-1]) + pad_y)
            x0 = max(0, int(active_cols[0]) - pad_x)
            x1 = min(W, int(active_cols[-1]) + pad_x)
            # Only crop if box is meaningful
            if (y1 - y0) >= 0.25 * H and (x1 - x0) >= 0.35 * W:
                meta["crop_box"] = [x0, y0, x1, y1]
            else:
                x0, y0, x1, y1 = 0, 0, W, H
                meta["crop_box"] = [0, 0, W, H]
        else:
            x0, y0, x1, y1 = 0, 0, W, H
            meta["crop_box"] = [0, 0, W, H]

    img_c = img_rgb[y0:y1, x0:x1]
    sig_c = sig_prob[y0:y1, x0:x1]
    grid_c = grid_prob[y0:y1, x0:x1]
    text_c = text_prob[y0:y1, x0:x1]

    # 2. Estimate skew angle using Open-ECG-Digitizer's PerspectiveDetector / Hough lines on grid_c
    skew_deg = 0.0
    try:
        edges = (grid_c > max(0.15, float(np.percentile(grid_c, 92)))).astype(np.uint8) * 255
        lines = cv2.HoughLinesP(
            edges,
            rho=1.0,
            theta=np.pi / 720.0,
            threshold=max(30, min(edges.shape) // 8),
            minLineLength=max(35, min(edges.shape) // 6),
            maxLineGap=10,
        )
        if lines is not None and len(lines) >= 5:
            angles: List[float] = []
            for ln in lines[:, 0, :]:
                dx = float(ln[2] - ln[0])
                dy = float(ln[3] - ln[1])
                ang = math.degrees(math.atan2(dy, dx))
                # Fold horizontal and vertical grid lines into [-15, +15] deg
                if -15.0 <= ang <= 15.0:
                    angles.append(ang)
                elif 75.0 <= abs(ang) <= 105.0:
                    dev = (ang - 90.0) if ang > 0 else (ang + 90.0)
                    if -15.0 <= dev <= 15.0:
                        angles.append(dev)
            if len(angles) >= 5:
                skew_deg = float(np.median(angles))
    except Exception:
        skew_deg = 0.0

    meta["skew_angle_deg"] = round(skew_deg, 2)
    if abs(skew_deg) >= 0.35 and abs(skew_deg) <= 15.0:
        ch, cw = img_c.shape[:2]
        M = cv2.getRotationMatrix2D((cw / 2.0, ch / 2.0), skew_deg, 1.0)
        img_c = cv2.warpAffine(img_c, M, (cw, ch), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        sig_c = cv2.warpAffine(sig_c, M, (cw, ch), flags=cv2.INTER_LINEAR, borderValue=0.0)
        grid_c = cv2.warpAffine(grid_c, M, (cw, ch), flags=cv2.INTER_LINEAR, borderValue=0.0)
        text_c = cv2.warpAffine(text_c, M, (cw, ch), flags=cv2.INTER_LINEAR, borderValue=0.0)

    return img_c, sig_c, grid_c, text_c, meta


def _weighted_autocorr(profile: np.ndarray, highpass_frac: float = 0.0) -> Tuple[np.ndarray, int]:
    """Mean-removed one-sided autocorrelation of a 1D grid projection, multiplied by a linear 1->0 lag weight
    (Open-ECG-Digitizer convention: index j <-> lag j+1). Optional moving-average high-pass removes lighting /
    paper-colour trends that otherwise bias the comb search towards the smallest periods."""
    prof = profile.astype(np.float64)
    if highpass_frac > 0.0:
        win = max(9, int(len(prof) * highpass_frac)) | 1
        prof = prof - ndimage.uniform_filter1d(prof, size=win, mode="reflect")
    prof = prof - prof.mean()
    ac = np.correlate(prof, prof, mode="full")
    ac = ac[: ac.shape[0] // 2][::-1].astype(np.float32)
    ac = ac - ac.mean()
    n = ac.shape[0]
    return ac * np.linspace(1.0, 0.0, n, dtype=np.float32), n


def _comb_scores(acw: np.ndarray, n: int, cands_5mm_px: np.ndarray, lower_factor: float = 0.35) -> np.ndarray:
    """Vectorized PixelSizeFinder comb score for every candidate 5-mm period: teeth every 1 mm, weight 1 on
    every 5th (major) line and `lower_factor` on minor lines, summed over the weighted autocorrelation."""
    steps = cands_5mm_px.astype(np.float32) / 5.0  # pixels between 1-mm lines
    k_max = int(np.ceil(n / max(1e-3, float(steps.min())))) + 1
    k = np.arange(k_max, dtype=np.float32)
    idx = np.round(k[None, :] * steps[:, None]).astype(np.int64)  # (S, K)
    valid = idx < n
    weights = np.where((np.arange(k_max) % 5) == 0, 1.0, lower_factor).astype(np.float32)
    return np.sum(np.where(valid, acw[np.minimum(idx, n - 1)] * weights[None, :], 0.0), axis=1)


def _comb_search_pxls_between_lines(
    profile: np.ndarray,
    aspect: float,
    samples: int,
    min_lines: float,
    max_lines: float,
    lower_factor: float,
    max_zoom: int = 10,
    zoom_factor: float = 10.0,
) -> float:
    """
    Vectorized NumPy port of Open-ECG-Digitizer `PixelSizeFinder._find_pxls_between_horizontal_grid_lines`
    (same autocorrelation, comb template, linear lag weighting and 10-level zoomed grid search), ~50× faster
    than the per-candidate Python loop and without a PyTorch dependency.
    """
    acw, n = _weighted_autocorr(profile)
    if n < 8:
        return 0.0

    def grid_search(lo: float, hi: float) -> float:
        cands = np.linspace(lo, hi, samples, dtype=np.float32)  # pixels between 5-mm lines
        return float(cands[int(np.argmax(_comb_scores(acw, n, cands, lower_factor)))])

    min_d = n / (max_lines / aspect)
    max_d = n / (min_lines / aspect)
    best = grid_search(min_d, max_d)
    for _ in range(max_zoom):
        w = (max_d - min_d) / zoom_factor
        min_d = max(best - w, min_d)
        max_d = min(best + w, max_d)
        best = grid_search(min_d, max_d)
    return best


def fast_pixel_size_finder(
    grid_map: np.ndarray,
    mm_between_grid_lines: float = 5.0,
    samples: int = 800,
    min_number_of_grid_lines: int = 18,
    max_number_of_grid_lines: int = 95,
    lower_grid_line_factor: float = 0.35,
) -> Tuple[float, float]:
    """Returns `(mm_per_px_x, mm_per_px_y)` exactly like `PixelSizeFinder.forward` (x uses aspect 1, y uses W/H)."""
    H, W = grid_map.shape
    pxl_x = _comb_search_pxls_between_lines(
        grid_map.sum(axis=0), 1.0, samples, min_number_of_grid_lines, max_number_of_grid_lines, lower_grid_line_factor
    )
    pxl_y = _comb_search_pxls_between_lines(
        grid_map.sum(axis=1), W / float(H), samples, min_number_of_grid_lines, max_number_of_grid_lines, lower_grid_line_factor
    )
    mm_x = mm_between_grid_lines / pxl_x if pxl_x > 1e-6 else 0.0
    mm_y = mm_between_grid_lines / pxl_y if pxl_y > 1e-6 else 0.0
    return mm_x, mm_y


def _per_axis_pixel_size_finder(grid_sub: np.ndarray) -> Tuple[float, float]:
    """Original Open-ECG-Digitizer settings (18-95 major lines in view); (0, 0) unless X and Y agree within 25 %."""
    try:
        mm_x, mm_y = fast_pixel_size_finder(
            grid_sub,
            mm_between_grid_lines=5,
            samples=800,
            min_number_of_grid_lines=18,
            max_number_of_grid_lines=95,
            lower_grid_line_factor=0.35,
        )
    except Exception:
        return 0.0, 0.0
    px_x = 1.0 / float(mm_x) if float(mm_x) > 1e-4 else 0.0
    px_y = 1.0 / float(mm_y) if float(mm_y) > 1e-4 else 0.0
    if px_x > 1.2 and px_y > 1.2 and 0.75 <= (px_x / px_y) <= 1.33:
        return px_x, px_y
    return 0.0, 0.0


def joint_isotropic_grid_search(
    grid_sub: np.ndarray,
    full_width_px: float,
    min_visible_mm: float = 70.0,
    max_visible_mm: float = 420.0,
    samples: int = 1500,
    per_axis_tolerance: float = 0.08,
) -> Optional[Tuple[float, float]]:
    """
    Robust px/mm estimate that fixes the two failure modes of the per-axis PixelSizeFinder search:
    1. its fixed "18-95 major squares in view" range excludes close-up photos (true period out of range, so it
       locks onto the 2.5-mm half period or onto the 1-mm dots);
    2. X and Y are searched independently, so one faint axis (e.g. pale vertical lines) breaks the isotropy check.
    The ECG grid is square, so both axes' comb scores are summed over one log-spaced candidate range bounded by
    physically plausible paper sizes (70-420 mm visible), then each axis is refined within +/-8 % (perspective).
    Returns `(px_per_mm_x, px_per_mm_y)`, or None when the optimum sits on the search boundary (not trustworthy).
    """
    acw_x, n_x = _weighted_autocorr(grid_sub.sum(axis=0), highpass_frac=0.12)
    acw_y, n_y = _weighted_autocorr(grid_sub.sum(axis=1), highpass_frac=0.12)
    if min(n_x, n_y) < 40:
        return None
    lo = 5.0 * max(1.2, full_width_px / max_visible_mm)
    hi = min(5.0 * full_width_px / min_visible_mm, min(n_x, n_y) / 4.0)  # >= 4 major squares inside the crop
    if hi <= lo * 1.05:
        return None
    cands = np.geomspace(lo, hi, samples)
    sx = _comb_scores(acw_x, n_x, cands)
    sy = _comb_scores(acw_y, n_y, cands)
    total = sx / (np.max(np.abs(sx)) + 1e-12) + sy / (np.max(np.abs(sy)) + 1e-12)
    best_i = int(np.argmax(total))
    if best_i < 0.01 * samples or best_i > 0.99 * samples:
        return None
    p0 = float(cands[best_i])
    refined = []
    for acw, n in ((acw_x, n_x), (acw_y, n_y)):
        cc = np.linspace((1.0 - per_axis_tolerance) * p0, (1.0 + per_axis_tolerance) * p0, 600)
        refined.append(float(cc[int(np.argmax(_comb_scores(acw, n, cc)))]) / 5.0)
    return refined[0], refined[1]


def estimate_pixel_spacing_mm(
    grid_prob: np.ndarray,
    img_rgb: np.ndarray,
    expected_rows: int = 6,
) -> Dict[str, float]:
    """
    Grid calibration in three tiers: joint isotropic comb search (`joint_isotropic_grid_search`), then the
    original per-axis Open-ECG-Digitizer `PixelSizeFinder` range, then a paper-size prior. Returns
    `px_per_mm_x`, `px_per_mm_y`, `mm_per_px_*` and the tier used in `method`.
    """
    H, W = grid_prob.shape
    px_per_mm_x = 0.0
    px_per_mm_y = 0.0
    calib_method = "joint_grid_search"
    cy0, cy1 = int(0.1 * H), int(0.9 * H)
    cx0, cx1 = int(0.1 * W), int(0.9 * W)
    grid_sub = grid_prob[cy0:cy1, cx0:cx1].astype(np.float32)

    # 1. Joint isotropic comb search over both axes with physically plausible bounds
    try:
        joint = joint_isotropic_grid_search(grid_sub, full_width_px=float(W))
        if joint is not None:
            px_per_mm_x, px_per_mm_y = joint
    except Exception:
        px_per_mm_x = px_per_mm_y = 0.0

    # 2. Fallback: original Open-ECG-Digitizer PixelSizeFinder range (vectorized NumPy port), per axis
    if px_per_mm_x <= 0 or px_per_mm_y <= 0:
        calib_method = "pixel_size_finder"
        px_per_mm_x, px_per_mm_y = _per_axis_pixel_size_finder(grid_sub)

    # 3. Last resort: typical paper size of the detected layout
    if px_per_mm_x <= 0 or px_per_mm_y <= 0:
        # Standard ECG paper width is ~210-280 mm (or ~110-150 mm for thermal strip)
        # Standard height is ~80-110 mm for 6-lead strip, ~180-210 mm for A4
        est_paper_width_mm = 250.0 if W >= H else 190.0
        if expected_rows == 6 and H < W * 0.75:
            # Could be a 6-channel thermal strip (~110 mm high, ~160-220 mm visible width)
            est_paper_height_mm = 95.0
        elif expected_rows == 12:
            est_paper_height_mm = 240.0
        else:
            est_paper_height_mm = 150.0

        fallback_px_mm = 0.5 * (W / est_paper_width_mm + H / est_paper_height_mm)
        px_per_mm_x = fallback_px_mm
        px_per_mm_y = fallback_px_mm
        calib_method = "paper_size_fallback"

    avg_px_per_mm = 0.5 * (px_per_mm_x + px_per_mm_y)
    return {
        "px_per_mm_x": round(float(px_per_mm_x), 4),
        "px_per_mm_y": round(float(px_per_mm_y), 4),
        "px_per_mm": round(float(avg_px_per_mm), 4),
        "mm_per_px_x": round(1.0 / float(px_per_mm_x), 5),
        "mm_per_px_y": round(1.0 / float(px_per_mm_y), 5),
        "method": calib_method,
    }


def detect_lead_labels_with_unet(
    text_prob: np.ndarray,
    threshold: float = 0.55,
) -> List[Dict[str, Any]]:
    """
    Runs Open-ECG-Digitizer's 13-class `LeadNameUNet` (`lead_name_unet_weights_07072025.pt`)
    on `text_prob` to locate printed lead labels (`I..V6`) and their normalized `(x_norm, y_norm)` centroids.
    """
    H, W = text_prob.shape
    device = ModelRegistry._device
    lead_unet = ModelRegistry.get_lead_name_unet()

    t = torch.from_numpy(text_prob).unsqueeze(0).unsqueeze(0).float().to(device)
    max_dim = max(H, W)
    if max_dim > 1024:
        scale = 1024.0 / max_dim
        t_in = F.interpolate(t, size=(int(H * scale), int(W * scale)), mode="bilinear", align_corners=False)
    else:
        t_in = t

    detected: List[Dict[str, Any]] = []
    with torch.no_grad():
        logits = lead_unet(t_in)
        probs = torch.softmax(logits, dim=1)[0, :12].cpu().numpy()  # (12, h, w)

    _, h_p, w_p = probs.shape
    xs_grid = np.arange(w_p, dtype=np.float64).reshape(1, w_p)
    ys_grid = np.arange(h_p, dtype=np.float64).reshape(h_p, 1)

    for idx, name in enumerate(LEAD_CHANNEL_ORDER):
        ch = probs[idx]
        mask = ch >= threshold
        if np.sum(mask) < 3:
            continue
        weights = ch * mask
        total_w = float(np.sum(weights))
        if total_w <= 1e-6:
            continue
        x_com = float(np.sum(xs_grid * weights) / total_w) / max(1.0, float(w_p))
        y_com = float(np.sum(ys_grid * weights) / total_w) / max(1.0, float(h_p))
        conf = float(np.max(ch))
        detected.append({
            "lead": name,
            "x_norm": round(x_com, 3),
            "y_norm": round(y_com, 3),
            "confidence": round(conf, 3),
        })

    return detected


def detect_row_baselines(
    sig_map: np.ndarray,
    target_num_rows: Optional[int] = None,
) -> np.ndarray:
    """
    Finds the vertical Y coordinates of each horizontal ECG baseline row.
    Because ECG baselines spend >70% of time near the isoelectric line, the horizontal
    projection of `sig_map` has sharp peaks at each lead row's baseline!
    """
    H, W = sig_map.shape
    # Ignore leftmost 7% (calibration pulses / labels) and rightmost 3%
    x_lo = int(0.07 * W)
    x_hi = int(0.97 * W)
    sub = sig_map[:, x_lo:x_hi] if x_hi > x_lo + 10 else sig_map

    # Row projection weighted by horizontal continuity
    row_proj = np.mean(sub > 0.10, axis=1).astype(np.float64) + 0.6 * np.mean(sub, axis=1).astype(np.float64)
    # Zero out extreme 3.5% top/bottom border where header/footer text resides
    border_y = max(3, int(round(0.035 * H)))
    row_proj[:border_y] *= 0.1
    row_proj[-border_y:] *= 0.1
    sigma = max(1.2, H * 0.0042)
    smooth_proj = ndimage.gaussian_filter1d(row_proj, sigma=sigma)

    if target_num_rows is not None and target_num_rows >= 1:
        if target_num_rows == 1:
            return np.array([int(np.argmax(smooth_proj))], dtype=int)

        # Restrict vertical search to active signal span [y_act0, y_act1]
        act_mask = np.where(smooth_proj >= 0.14 * np.max(smooth_proj))[0]
        y_act0 = int(act_mask[0]) if len(act_mask) > 2 else int(0.04 * H)
        y_act1 = int(act_mask[-1]) if len(act_mask) > 2 else int(0.96 * H)
        active_span = max(40, y_act1 - y_act0)

        expected_step = active_span / max(1.0, float(target_num_rows - 1))
        min_dist = max(8, int(round(expected_step * 0.58)))
        peaks, _ = sp_signal.find_peaks(
            smooth_proj,
            distance=min_dist,
            prominence=0.008 * np.max(smooth_proj),
            height=0.08 * np.max(smooth_proj),
        )
        if len(peaks) >= target_num_rows:
            if len(peaks) == target_num_rows:
                return np.sort(peaks).astype(int)
            # Dynamic programming / lattice matching to select the subset of `target_num_rows` peaks
            # that maximizes peak height while maintaining uniform vertical spacing
            peaks = np.sort(peaks)
            M = len(peaks)
            K = target_num_rows
            p_scores = smooth_proj[peaks] / (np.max(smooth_proj[peaks]) + 1e-8)
            dp = np.full((K, M), -1e9, dtype=np.float64)
            parent = np.zeros((K, M), dtype=np.int32)
            for j in range(M):
                dp[0, j] = p_scores[j]
            for k in range(1, K):
                for j in range(k, M):
                    for i in range(k - 1, j):
                        dy = float(peaks[j] - peaks[i])
                        # Allow up to 2.2x step for layout group gap (e.g. between V2 and V3 on 12x1 sheets)
                        if dy < expected_step * 0.52 or dy > expected_step * 2.35:
                            continue
                        step_pen = 0.35 * ((dy - expected_step) / expected_step) ** 2
                        val = dp[k - 1, i] + p_scores[j] - step_pen
                        if val > dp[k, j]:
                            dp[k, j] = val
                            parent[k, j] = i
            best_last = int(np.argmax(dp[K - 1]))
            if dp[K - 1, best_last] > -1e5:
                chosen_idxs = [0] * K
                curr = best_last
                for k in range(K - 1, -1, -1):
                    chosen_idxs[k] = int(peaks[curr])
                    curr = int(parent[k, curr])
                return np.array(chosen_idxs, dtype=int)

            heights = smooth_proj[peaks]
            top_idx = np.argsort(heights)[::-1][:target_num_rows]
            return np.sort(peaks[top_idx]).astype(int)

        # Fallback: evenly spaced priors within active span refined to local peak
        priors = np.linspace(y_act0, y_act1, target_num_rows)
        refined: List[int] = []
        rad = max(5, int(expected_step * 0.38))
        for py in priors:
            lo = max(0, int(round(py)) - rad)
            hi = min(H, int(round(py)) + rad + 1)
            refined.append(lo + int(np.argmax(smooth_proj[lo:hi])))
        return np.array(refined, dtype=int)

    # Auto-detect number of rows (3, 4, 5, 6, 7, or 12)
    min_dist = max(12, int(H / 16.5))
    peaks, _ = sp_signal.find_peaks(
        smooth_proj,
        distance=min_dist,
        height=max(0.02, 0.18 * np.max(smooth_proj)),
        prominence=max(0.01, 0.08 * np.max(smooth_proj)),
    )
    if len(peaks) == 0:
        return np.array([H // 2], dtype=int)
    return np.sort(peaks).astype(int)


LAYOUT_ROW_COUNTS = (1, 3, 4, 5, 6, 7, 12)


def _smoothed_row_projection(sig_map: np.ndarray) -> np.ndarray:
    """Same horizontal ink projection as `detect_row_baselines` (labels / borders suppressed, Gaussian smoothed)."""
    H, W = sig_map.shape
    x_lo, x_hi = int(0.07 * W), int(0.97 * W)
    sub = sig_map[:, x_lo:x_hi] if x_hi > x_lo + 10 else sig_map
    row_proj = np.mean(sub > 0.10, axis=1).astype(np.float64) + 0.6 * np.mean(sub, axis=1).astype(np.float64)
    border_y = max(3, int(round(0.035 * H)))
    row_proj[:border_y] *= 0.1
    row_proj[-border_y:] *= 0.1
    return ndimage.gaussian_filter1d(row_proj, sigma=max(1.2, H * 0.0042))


def select_row_count(
    sig_map: np.ndarray,
    px_per_mm_y: Optional[float] = None,
    gain_mm_mv: float = 10.0,
    candidates: Tuple[int, ...] = LAYOUT_ROW_COUNTS,
) -> Tuple[int, np.ndarray, Dict[int, float]]:
    """
    Chooses how many ECG rows the sheet has by model selection instead of fixed peak thresholds: for every
    candidate row count R (the counts the supported layouts can have) the regular-spacing DP of
    `detect_row_baselines` places R baselines, and R is scored by how much of the projection's peak prominence
    those rows explain, minus prominent peaks they leave unexplained (too few rows) and baselines that sit on no
    peak (too many rows). With a trusted grid calibration, rows closer than ~0.85 x gain (8.5 mm at 10 mm/mV)
    are physically implausible and rejected.
    Returns `(best_R, baselines_for_best_R, scores)`.
    """
    H = sig_map.shape[0]
    sm = _smoothed_row_projection(sig_map)
    mx = float(np.max(sm)) + 1e-9
    peaks, props = sp_signal.find_peaks(sm, prominence=0.03 * mx, distance=max(6, H // 40))
    if len(peaks) == 0:
        return 1, np.array([H // 2], dtype=int), {}
    prom = props["prominences"] / mx
    total = float(np.sum(prom)) + 1e-9
    min_spacing_px = 0.85 * gain_mm_mv * px_per_mm_y if px_per_mm_y else 0.0

    scores: Dict[int, float] = {}
    baselines_by_r: Dict[int, np.ndarray] = {}
    for R in candidates:
        chosen = detect_row_baselines(sig_map, target_num_rows=R)
        baselines_by_r[R] = chosen
        spacing = float(np.median(np.diff(chosen))) if len(chosen) > 1 else H / 2.0
        tol = 0.25 * spacing
        matched: set = set()
        spurious = 0
        for b in chosen:
            d = np.abs(peaks - b)
            j = int(np.argmin(d))
            if d[j] <= tol and j not in matched:
                matched.add(j)
            else:
                spurious += 1
        explained = float(sum(prom[j] for j in matched))
        med_matched = float(np.median([prom[j] for j in matched])) if matched else 0.0
        missed = float(sum(prom[j] for j in range(len(peaks)) if j not in matched and prom[j] >= 0.35 * med_matched))
        score = explained / total - 0.8 * missed / total - 0.25 * spurious / R
        if R > 1:
            # Rows of one layout are (near) evenly spaced; a "row" squeezed in at < 55 % of the typical spacing is
            # a wave tip / text line next to a real baseline (group gaps and rhythm strips are WIDER, never narrower)
            diffs = np.diff(np.sort(chosen)).astype(np.float64)
            # (normalised by R: one weak row that forces two baselines together must not let a hypothesis that leaves
            # several strong rows unexplained win, e.g. a 12x1 A4 sheet with one flat lead)
            score -= 0.3 * float(np.sum(diffs < 0.55 * np.median(diffs))) / R
        if R > 1 and min_spacing_px > 0 and spacing < min_spacing_px:
            score -= 1.0
        scores[R] = round(score, 3)
    best_r = max(scores, key=lambda r: scores[r])
    return best_r, baselines_by_r[best_r], scores


def infer_best_layout(
    sig_map: np.ndarray,
    text_map: np.ndarray,
    detected_labels: List[Dict[str, Any]],
    detected_baselines: np.ndarray,
) -> str:
    """
    Automatically determines the ECG layout (`12x1`, `3x4_r1`, `3x4_r2`, `3x4`,
    `6x2_r1`, `6x2`, `6x1_precordial`, `6x1_limb`) from:
    1. Number of detected horizontal baseline rows
    2. Spatial distribution of detected lead labels from `LeadNameUNet`
    3. Aspect ratio and column transition markers
    """
    H, W = sig_map.shape
    n_rows = len(detected_baselines)

    # Check x-positions of precordial labels V1..V6 vs limb labels
    v_labels = [d for d in detected_labels if d["lead"].startswith("V")]
    limb_labels = [d for d in detected_labels if d["lead"] in ("II", "III", "aVR", "aVL", "aVF")]

    v_x = [d["x_norm"] for d in v_labels]
    limb_x = [d["x_norm"] for d in limb_labels]

    # Case A: 10 to 13 detected rows -> 12x1 vertical layout!
    if n_rows >= 9:
        return "12x1"

    # Case B: 7 rows -> 6x2 + 1 rhythm strip (like photo_2026-11-19_00-35-36.jpg)
    if n_rows == 7:
        return "6x2_r1"

    # Case C: 6 rows -> could be 6x1_precordial, 6x1_limb, or 6x2
    if n_rows == 6:
        # If V1..V6 labels are detected in the right half (x_norm > 0.38), it's 6x2!
        if v_x and float(np.median(v_x)) > 0.36:
            return "6x2"
        # Check if there is a central column gap or text label column around x ≈ 0.48..0.58 W
        mid_text = float(np.mean(text_map[:, int(0.45 * W) : int(0.60 * W)]))
        left_text = float(np.mean(text_map[:, int(0.20 * W) : int(0.40 * W)]))
        if mid_text > left_text * 1.45 and len(v_labels) >= 2 and len(limb_labels) >= 2:
            return "6x2"
        # Distinguish 6x1_precordial (V1-V6) vs 6x1_limb (I-aVF)
        v_score = sum(d["confidence"] for d in v_labels if d["x_norm"] < 0.35)
        limb_score = sum(d["confidence"] for d in limb_labels if d["x_norm"] < 0.35)
        if v_score > limb_score + 0.3:
            return "6x1_precordial"
        if limb_score > v_score + 0.3:
            return "6x1_limb"
        return "6x1_limb" if len(limb_labels) >= len(v_labels) else "6x1_precordial"

    # Case D: 5 rows -> 3x4 + 2 rhythm strips (like CardioBox screenshot photo_2026-11-19_00-37-21.jpg)
    if n_rows == 5:
        return "3x4_r2"

    # Case E: 4 rows -> 3x4 + 1 rhythm strip (like MEGACART 3 photo_2026-11-19_00-35-31.jpg)
    if n_rows == 4:
        return "3x4_r1"

    # Case F: 3 rows -> 3x4 standard
    if n_rows == 3:
        return "3x4"

    if n_rows == 1:
        return "single_strip"

    return "12x1" if H > W * 1.1 else "3x4_r1"


def estimate_local_baseline_curve(
    sig_map: np.ndarray,
    global_base_y: float,
    median_spacing: float,
    num_windows: int = 12,
) -> np.ndarray:
    """
    Estimates a smoothly varying local baseline Y(x) across x in [0, W) for a single lead row.
    Tracks paper tilt, perspective curvature, or creases across the page width.
    """
    H, W = sig_map.shape
    half_h = max(8, int(round(0.36 * median_spacing)))
    y0 = max(0, int(round(global_base_y)) - half_h)
    y1 = min(H, int(round(global_base_y)) + half_h + 1)
    if y1 <= y0 + 2:
        return np.full(W, global_base_y, dtype=np.float64)

    strip = sig_map[y0:y1, :]
    win_centers: List[float] = []
    win_ys: List[float] = []

    step_w = max(16, W // num_windows)
    for w_idx in range(num_windows):
        wx0 = max(int(0.05 * W), w_idx * step_w)
        wx1 = min(int(0.96 * W), wx0 + int(1.5 * step_w))
        if wx1 <= wx0 + 4:
            continue
        sub = strip[:, wx0:wx1]
        proj = np.mean(sub > 0.10, axis=1) + 0.5 * np.mean(sub, axis=1)
        proj_smooth = ndimage.gaussian_filter1d(proj.astype(np.float64), sigma=max(1.0, half_h * 0.12))
        if np.max(proj_smooth) > 0.015:
            local_y = float(y0 + int(np.argmax(proj_smooth)))
            win_centers.append(0.5 * (wx0 + wx1))
            win_ys.append(local_y)

    if len(win_centers) < 2:
        return np.full(W, global_base_y, dtype=np.float64)

    # Reject outlier window peaks using median absolute deviation
    ys_arr = np.array(win_ys, dtype=np.float64)
    med_y = float(np.median(ys_arr))
    inliers = np.abs(ys_arr - med_y) <= max(6.0, 0.22 * median_spacing)
    if np.sum(inliers) >= 2:
        xc = np.array(win_centers, dtype=np.float64)[inliers]
        yc = ys_arr[inliers]
    else:
        xc = np.array(win_centers, dtype=np.float64)
        yc = ys_arr

    x_full = np.arange(W, dtype=np.float64)
    curve = np.interp(x_full, xc, yc)
    curve = ndimage.gaussian_filter1d(curve, sigma=max(10.0, W * 0.045))
    return curve


def viterbi_trace_unclipped(
    prob_band: np.ndarray,
    local_baseline_rel_y: np.ndarray,
    median_spacing: float,
    qrs_col_mask: Optional[np.ndarray] = None,
    claimed_penalty_map: Optional[np.ndarray] = None,
) -> np.ndarray:
    """
    Vectorized continuous-path Viterbi DP tracker + sub-pixel centroid refinement for a single lead band `(H_b, W_b)`.
    - Outside `qrs_col_mask`: confines trace to `±0.55 * median_spacing` around the row's local baseline `b_r(x)`,
      making it impossible to jump to neighboring rows during P, PQ, ST, T, or baseline segments.
    - Inside `qrs_col_mask`: opens vertical search up to `-1.35 / +2.65 * median_spacing`, penalizes blank paper (`band < 0.055`)
      whenever the column contains ink elsewhere, and uses a 3-tier reward hierarchy:
        Unclaimed Ink (+2.0) >> Previously Claimed Ink (+0.75) >> Blank Paper (-0.50)
      while computing the O(1) prefix-sum ink-bridge integral (`blank_cumsum`) on the unpeeled ink map so crossing
      strokes from adjacent leads never create artificial blank-paper barriers.
    """
    H_b, W_b = prob_band.shape
    if H_b < 5 or W_b < 5:
        return local_baseline_rel_y.copy()

    ys = np.arange(H_b, dtype=np.float64)[:, None]  # (H_b, 1)
    base_y = np.clip(local_baseline_rel_y[None, :], 0.0, H_b - 1.0)  # (1, W_b)
    dist_from_base = np.abs(ys - base_y) / max(1.0, median_spacing)  # in units of row_spacing

    band = prob_band.astype(np.float64).copy()

    if qrs_col_mask is None:
        qrs_col_mask = np.ones(W_b, dtype=bool)

    # Outside QRS columns, strictly forbid leaving this row's territory (±0.55 * spacing)
    non_qrs_cols = ~qrs_col_mask
    if np.any(non_qrs_cols):
        out_of_row = (dist_from_base > 0.55) & non_qrs_cols[None, :]
        band[out_of_row] = 0.0

    col_max = np.max(band, axis=0)  # (W_b,)
    has_ink_col = col_max >= 0.07

    # Normalize each active column by its column maximum so faint background (< 0.16 * col_max or < 0.065)
    # is strictly penalized as blank paper (-0.55), preventing any horizontal shortcutting across R/S waves,
    # while saturating at 0.60 * col_max so thinner deep S-wave nadirs receive full ink reward!
    col_norm = np.where(has_ink_col[None, :], band / np.maximum(0.08, col_max[None, :]), 0.0)
    is_ink_pixel = (band >= 0.065) & (col_norm >= 0.16)
    norm_boost = np.clip(col_norm / 0.60, 0.0, 1.0)

    # Reward matrix:
    # - Ink pixel: strong positive reward (+0.80 + 1.40 * norm_boost + 0.60 * band)
    # - Blank paper pixel in a column that HAS ink elsewhere: negative penalty (-0.55) so the tracker NEVER
    #   cuts horizontally across blank paper when the trace has deflected up/down into a QRS wave!
    # - Blank column (gap in trace): gentle pull toward baseline
    reward = np.where(
        is_ink_pixel,
        0.80 + 1.40 * norm_boost + 0.60 * band,
        np.where(has_ink_col[None, :], -0.55, -0.30 * (dist_from_base ** 1.4)),
    )

    # Apply soft penalty on pixels already claimed by previous rows' traces (while keeping them > blank paper
    # and keeping `band` intact for `blank_cumsum` so transverse crossings are 100% penalty-free!)
    if claimed_penalty_map is not None:
        reward = reward - claimed_penalty_map

    # Distance prior: monotonically increasing with distance from row r's baseline!
    # - Outside QRS columns: strong prior toward baseline plus hard wall at 0.55*spacing
    # - Inside QRS columns: mild monotonic prior (0.10 * dist + 0.04 * dist^2) so row r always prefers
    #   its OWN connected QRS complex over a neighboring row's complex further away!
    dist_pen = np.where(
        qrs_col_mask[None, :],
        0.10 * dist_from_base + 0.04 * (dist_from_base ** 2),
        0.35 * (dist_from_base ** 1.5) + np.where(dist_from_base > 0.55, 5.0, 0.0),
    )
    reward = reward - dist_pen

    # Precompute O(1) prefix-sum ink-bridge integral along each column on the UNPEELED `band`:
    # A transition from y_prev (at x-1) to y (at x) is continuous if the vertical span [min(y_prev,y)..max(y_prev,y)]
    # contains ink in column x-1 or column x. Any blank paper pixels along that vertical span are penalized!
    bridge_prob = np.maximum(band, np.roll(band, 1, axis=1))
    bridge_prob = ndimage.maximum_filter1d(bridge_prob, size=3, axis=0)
    is_blank_bridge = (bridge_prob < 0.055).astype(np.float64)
    blank_cumsum = np.cumsum(is_blank_bridge, axis=0)  # (H_b, W_b)

    # Prebuild vectorized transition offsets up to ±48 px per column step (steep 50mm/s or 25mm/s QRS strokes)
    fine_off = np.arange(-14, 15, 1, dtype=np.int32)
    coarse_neg = np.arange(-48, -14, 2, dtype=np.int32)
    coarse_pos = np.arange(16, 49, 2, dtype=np.int32)
    offsets = np.concatenate([coarse_neg, fine_off, coarse_pos])  # (M,)

    rows_arange = np.arange(H_b, dtype=np.int32)
    idx_mat = np.clip(rows_arange[:, None] - offsets[None, :], 0, H_b - 1)  # (H_b, M)

    # Gentle step penalty along continuous ink inside QRS, stricter step penalty outside QRS
    pen_qrs = (0.025 * (np.abs(offsets) / max(8.0, 0.25 * median_spacing)) ** 1.35)[None, :]
    pen_non_qrs = (0.085 * (np.abs(offsets) / max(6.0, 0.18 * median_spacing)) ** 1.60)[None, :]

    dp = np.zeros((H_b, W_b), dtype=np.float64)
    backptr = np.zeros((H_b, W_b), dtype=np.int32)
    dp[:, 0] = reward[:, 0] - 0.50 * dist_from_base[:, 0]

    if _viterbi_forward_numba is not None:
        # JIT kernel: identical recurrence (same operation order & first-max tie breaking), ~10× faster
        _viterbi_forward_numba(
            dp,
            backptr,
            np.ascontiguousarray(reward, dtype=np.float64),
            np.ascontiguousarray(blank_cumsum, dtype=np.float64),
            np.ascontiguousarray(qrs_col_mask, dtype=np.bool_),
            idx_mat.astype(np.int32),
            np.ascontiguousarray(pen_qrs[0], dtype=np.float64),
            np.ascontiguousarray(pen_non_qrs[0], dtype=np.float64),
        )
    else:
        for x in range(1, W_b):
            prev_col = dp[:, x - 1]
            pen_vec = pen_qrs if qrs_col_mask[x] else pen_non_qrs
            # Exact number of blank non-ink pixels crossed vertically between y_prev and y in O(1) via prefix sum!
            col_cs = blank_cumsum[:, x]
            blank_crossed = np.abs(col_cs[:, None] - col_cs[idx_mat])  # (H_b, M)
            bridge_pen = 0.42 * blank_crossed
            cands = prev_col[idx_mat] - pen_vec - bridge_pen  # (H_b, M)
            best_m = np.argmax(cands, axis=1)
            dp[:, x] = reward[:, x] + cands[rows_arange, best_m]
            backptr[:, x] = idx_mat[rows_arange, best_m]

    # Backtrack optimal continuous path
    end_scores = dp[:, W_b - 1] - 0.35 * dist_from_base[:, W_b - 1]
    curr_y = int(np.argmax(end_scores))
    path_y = np.zeros(W_b, dtype=np.float64)
    path_y[W_b - 1] = float(curr_y)
    for x in range(W_b - 1, 0, -1):
        curr_y = int(backptr[curr_y, x])
        path_y[x - 1] = float(curr_y)

    # Sub-pixel refinement & QRS tip preservation within ±5 px of path_y
    trace_y = np.empty(W_b, dtype=np.float64)
    ys_1d = np.arange(H_b, dtype=np.float64)
    for x in range(W_b):
        py = int(round(path_y[x]))
        b_y = float(local_baseline_rel_y[x])
        lo = max(0, py - 5)
        hi = min(H_b, py + 6)
        w_sl = band[lo:hi, x]
        w_sum = float(np.sum(w_sl))
        if w_sum > 0.03:
            if py < b_y - 0.20 * median_spacing:
                tip_idx = lo + int(np.argmax(w_sl >= 0.30 * np.max(w_sl)))
                lo_t = max(0, tip_idx - 1)
                hi_t = min(H_b, tip_idx + 4)
                ws = band[lo_t:hi_t, x]
                trace_y[x] = float(np.sum(ys_1d[lo_t:hi_t] * ws) / max(1e-6, float(np.sum(ws))))
            elif py > b_y + 0.20 * median_spacing:
                active_pts = np.where(w_sl >= 0.30 * np.max(w_sl))[0]
                tip_idx = lo + int(active_pts[-1]) if len(active_pts) > 0 else py
                lo_t = max(0, tip_idx - 3)
                hi_t = min(H_b, tip_idx + 2)
                ws = band[lo_t:hi_t, x]
                trace_y[x] = float(np.sum(ys_1d[lo_t:hi_t] * ws) / max(1e-6, float(np.sum(ws))))
            else:
                trace_y[x] = float(np.sum(ys_1d[lo:hi] * w_sl) / w_sum)
        else:
            trace_y[x] = path_y[x]

    trace_y = ndimage.median_filter(trace_y, size=3, mode="nearest")
    trace_y = ndimage.gaussian_filter1d(trace_y, sigma=0.65)
    return trace_y


def determine_column_x_ranges(
    sig_map: np.ndarray,
    text_map: np.ndarray,
    detected_labels: List[Dict[str, Any]],
    n_cols: int,
) -> List[Tuple[int, int]]:
    """
    Determines the exact horizontal pixel ranges `[(cx0, cx1), ...]` for each column `0 .. n_cols-1`.
    In 2-column layouts (like UTAS 6x2), uses detected V1..V6 label X-coordinates or the central
    text/gap divider so Column 1 does not bleed into the V1..V6 labels and Column 2 starts cleanly
    after the V1..V6 labels.
    """
    H, W = sig_map.shape
    if n_cols <= 1:
        return [(int(round(0.11 * W)), int(round(0.985 * W)))]

    if n_cols == 2:
        # Check if V1..V6 labels were detected near the middle of the image (0.42 <= x_norm <= 0.68)
        v_xs = [d["x_norm"] for d in detected_labels if d["lead"].startswith("V") and 0.42 <= d["x_norm"] <= 0.68]
        limb_xs = [d["x_norm"] for d in detected_labels if not d["lead"].startswith("V") and 0.02 <= d["x_norm"] <= 0.25]

        x0_col0 = int(round((float(np.median(limb_xs)) + 0.032) * W)) if limb_xs else int(round(0.105 * W))
        x0_col0 = int(np.clip(x0_col0, int(0.06 * W), int(0.16 * W)))

        if v_xs:
            v_med = float(np.median(v_xs))
            x1_col0 = int(round((v_med - 0.045) * W))
            x0_col1 = int(round((v_med + 0.025) * W))
            return [(x0_col0, max(x0_col0 + 40, x1_col0)), (x0_col1, int(round(0.985 * W)))]

        # Fallback for 2 columns: look for peak of text_map or minimum of sig_map in [0.46 W, 0.62 W]
        mid_lo = int(round(0.46 * W))
        mid_hi = int(round(0.62 * W))
        col_score = np.mean(sig_map[:, mid_lo:mid_hi], axis=0) - 0.8 * np.mean(text_map[:, mid_lo:mid_hi], axis=0)
        split_x = mid_lo + int(np.argmin(ndimage.gaussian_filter1d(col_score, sigma=5.0)))
        return [
            (x0_col0, max(x0_col0 + 40, split_x - int(0.02 * W))),
            (min(W - 40, split_x + int(0.03 * W)), int(round(0.985 * W))),
        ]

    # General N-column split (e.g. 3x4 where n_cols == 4)
    x_start = int(round(0.065 * W))
    x_end = int(round(0.985 * W))
    col_w = (x_end - x_start) // n_cols
    ranges: List[Tuple[int, int]] = []
    for c in range(n_cols):
        c0 = x_start + c * col_w + (int(0.012 * W) if c > 0 else 0)
        c1 = (x_start + (c + 1) * col_w - int(0.008 * W)) if c < n_cols - 1 else x_end
        ranges.append((c0, max(c0 + 20, c1)))
    return ranges


def extract_column_leads_with_peeling(
    col_sig_map: np.ndarray,
    n_rows_in_col: int,
) -> Tuple[List[np.ndarray], List[np.ndarray], np.ndarray]:
    """
    Extracts `n_rows_in_col` lead traces from a single column sub-image `col_sig_map` `(H, W_c)`:
    1. Detects the exact baseline Y positions and smooth local baseline curves `b_r(x)` within this column.
    2. Allows an unclipped vertical search range up to `±2.6 * median_spacing` so deep S waves (V1-V4)
       and tall R waves (I, aVL, V5-V6) are never truncated.
    3. Suppresses neighboring rows' horizontal baselines (`horiz_smooth`) without attenuating vertical QRS strokes.
    4. Iteratively traces each row with `viterbi_trace_unclipped` and peels off its high-excursion QRS strokes
       from `work_sig` so adjacent overlapping leads (e.g. V1->V2->V3->V4 deep S waves) never steal each other's tips!
    """
    H, W_c = col_sig_map.shape
    baselines_y = detect_row_baselines(col_sig_map, target_num_rows=n_rows_in_col)
    row_spacings = np.diff(baselines_y) if len(baselines_y) > 1 else np.array([H * 0.45])
    median_spacing = float(np.median(row_spacings)) if len(row_spacings) > 0 else float(H * 0.45)

    baseline_curves: List[np.ndarray] = [
        estimate_local_baseline_curve(col_sig_map, float(by), median_spacing)
        for by in baselines_y
    ]

    # Horizontal baseline component (long horizontal segments)
    horiz_kernel = np.ones((1, max(11, int(0.04 * W_c))), dtype=np.float32)
    horiz_smooth = cv2.morphologyEx(col_sig_map, cv2.MORPH_OPEN, horiz_kernel)

    # Also suppress thin 1-3px vertical calibration tick bars ('|') that cross baselines symmetrically
    vert_tick_kernel = np.ones((max(15, int(0.28 * median_spacing)), 1), dtype=np.float32)
    vert_ticks = cv2.morphologyEx(col_sig_map, cv2.MORPH_OPEN, vert_tick_kernel)
    # A calibration tick is very narrow horizontally (disappears under a 5px horizontal opening)
    wide_strokes = cv2.morphologyEx(col_sig_map, cv2.MORPH_OPEN, np.ones((1, 4), dtype=np.float32))
    thin_tick_only = np.clip(vert_ticks - 1.5 * wide_strokes, 0.0, 1.0)
    work_sig = np.clip(col_sig_map - 0.85 * thin_tick_only, 0.0, 1.0)

    # Detect horizontal QRS complex windows across this column using fast vertical-stroke contrast
    # restricted to the active ECG rows [baselines_y[0]..baselines_y[-1]] (excluding header/footer text!):
    w_slow = max(15, int(round(0.22 * median_spacing)))
    slow_waves = ndimage.uniform_filter(work_sig, size=(3, w_slow))
    fast_strokes = np.clip(work_sig - 1.12 * slow_waves, 0.0, 1.0)

    y_qrs_lo = max(0, int(round(baselines_y[0] - 0.35 * median_spacing)))
    y_qrs_hi = min(H, int(round(baselines_y[-1] + 0.35 * median_spacing)))
    fast_roi = fast_strokes[y_qrs_lo:y_qrs_hi, :] if y_qrs_hi > y_qrs_lo + 10 else fast_strokes

    qrs_energy_1d = ndimage.gaussian_filter1d(
        np.mean(fast_roi > 0.09, axis=0).astype(np.float64) + 2.2 * np.mean(fast_roi, axis=0).astype(np.float64),
        sigma=max(2.5, 0.035 * median_spacing),
    )

    qrs_col_mask = np.zeros(W_c, dtype=bool)
    q_med = float(np.percentile(qrs_energy_1d, 50))
    q_max = float(np.max(qrs_energy_1d))
    if q_max > q_med + 1e-4:
        q_thr = q_med + 0.28 * (q_max - q_med)
        min_pk_dist = max(18, int(round(0.38 * median_spacing)))
        qrs_peaks, _ = sp_signal.find_peaks(qrs_energy_1d, distance=min_pk_dist, height=max(0.008, q_thr))
        half_qrs_w = max(12, int(round(0.25 * median_spacing)))
        for pk in qrs_peaks:
            qrs_col_mask[max(0, int(pk) - half_qrs_w) : min(W_c, int(pk) + half_qrs_w + 1)] = True
    if not np.any(qrs_col_mask):
        # Fallback if no sharp peak found
        raw_qrs_cols = qrs_energy_1d >= np.percentile(qrs_energy_1d, 78)
        dil_w = max(8, int(round(0.20 * median_spacing)))
        qrs_col_mask = ndimage.binary_dilation(raw_qrs_cols, structure=np.ones(2 * dil_w + 1, dtype=bool))

    traces_px: List[np.ndarray] = []
    # Soft claimed-trace penalty map (never erases `work_sig` into blank paper, so crossing strokes remain valid ink bridges!)
    claimed_penalty_full = np.zeros((H, W_c), dtype=np.float64)

    for r_idx, base_y in enumerate(baselines_y):
        # Vertical search range:
        # - Top row (r_idx == 0, e.g. Lead I and V1): allow up to 1.35 * spacing upward into top margin.
        # - Lower rows (r_idx > 0): cap upward search at 0.80 * spacing so a lower row can NEVER reach
        #   the row above's baseline (at 1.00 * spacing), while still capturing tall upward R-waves (II, aVL, V6)!
        # - Downward search: allow up to 2.65 * spacing downward for deep V1-V4 S-waves!
        up_limit = int(round(median_spacing * (1.35 if r_idx == 0 else 0.80)))
        down_limit = int(round(median_spacing * 2.65))
        y0 = max(int(round(0.02 * H)), int(base_y) - up_limit)
        y1 = min(H - int(round(0.02 * H)), int(base_y) + down_limit + 1)

        band = work_sig[y0:y1, :].copy()
        band_horiz = horiz_smooth[y0:y1, :]
        claimed_band = claimed_penalty_full[y0:y1, :].copy()

        # Remove ONLY the horizontal baseline component near other rows' baselines outside QRS windows
        # (inside QRS windows, subtract only 0.40 * band_horiz so deep nadirs touching lower rows stay strong!)
        ys_b = np.arange(band.shape[0], dtype=np.float64)[:, None]
        horiz_sub_factor = np.where(qrs_col_mask[None, :], 0.40, 0.95)
        for other_idx, other_curve in enumerate(baseline_curves):
            if other_idx == r_idx:
                continue
            rel_other_curve = other_curve - y0  # (W_c,)
            dist_to_other = np.abs(ys_b - rel_other_curve[None, :])
            near_other_base = dist_to_other <= max(4.0, 0.16 * median_spacing)
            band[near_other_base] = np.clip(
                band[near_other_base] - (horiz_sub_factor * band_horiz)[near_other_base],
                0.0,
                1.0,
            )

        local_base_rel = baseline_curves[r_idx] - y0
        # Never penalize pixels immediately around this row's own baseline curve
        near_own_base = np.abs(ys_b - local_base_rel[None, :]) <= max(4.0, 0.15 * median_spacing)
        claimed_band[near_own_base] = 0.0

        local_trace = viterbi_trace_unclipped(
            band,
            local_baseline_rel_y=local_base_rel,
            median_spacing=median_spacing,
            qrs_col_mask=qrs_col_mask,
            claimed_penalty_map=claimed_band,
        )
        global_y = y0 + local_trace
        traces_px.append(global_y)

        # Record this row's traced waveform into `claimed_penalty_full`:
        # - Standard claimed QRS stroke penalty (+1.65): prevents subsequent leads (like V5) from riding
        #   an already-claimed deep S-wave limb (like V4's S-wave), while keeping `work_sig` intact for `blank_cumsum`!
        # - Strong turn-around nadir/apex penalty (+2.95): prevents subsequent leads (e.g. V2, V3, V4) from turning around
        #   early at a previous lead's S-wave nadir!
        excursion = np.abs(global_y - baseline_curves[r_idx])
        slope_abs = np.abs(np.gradient(global_y))
        for x in range(W_c):
            gy = int(round(global_y[x]))
            exc = float(excursion[x])
            is_nadir_tip = (exc > 0.38 * median_spacing) and (float(slope_abs[x]) <= 9.0)
            if is_nadir_tip:
                lo_seg = max(0, gy - 7)
                hi_seg = min(H, gy + 8)
                x_lo = max(0, x - 3)
                x_hi = min(W_c, x + 4)
                claimed_penalty_full[lo_seg:hi_seg, x_lo:x_hi] = np.maximum(
                    claimed_penalty_full[lo_seg:hi_seg, x_lo:x_hi], 2.95
                )
            else:
                pen_val = 1.65 if exc > 0.16 * median_spacing else 0.95
                lo_seg = max(0, gy - 3)
                hi_seg = min(H, gy + 4)
                claimed_penalty_full[lo_seg:hi_seg, x] = np.maximum(claimed_penalty_full[lo_seg:hi_seg, x], pen_val)

    return traces_px, baseline_curves, baselines_y


def extract_all_leads_for_layout(
    sig_map: np.ndarray,
    layout_key: str,
    px_per_mm_x: float,
    px_per_mm_y: float,
    paper_speed_mm_s: float = 25.0,
    gain_mm_mv: float = 10.0,
    target_fs: float = 500.0,
    text_map: Optional[np.ndarray] = None,
    detected_labels: Optional[List[Dict[str, Any]]] = None,
) -> Tuple[Dict[str, List[float]], List[Dict[str, Any]], np.ndarray]:
    """
    Extracts calibrated digital signals (in mV, sampled at `target_fs` Hz) and
    pixel-space trace overlays for every lead in the specified `layout_key`.
    Uses per-column baseline detection, smart column boundary detection, unclipped
    2.8x spacing Viterbi tracking, and iterative QRS stroke peeling.
    """
    H, W = sig_map.shape
    if text_map is None:
        text_map = np.zeros_like(sig_map)
    if detected_labels is None:
        detected_labels = []

    layout_def = LAYOUT_DEFINITIONS.get(layout_key, LAYOUT_DEFINITIONS["12x1"])
    grid_rows: List[List[str]] = layout_def["grid"]
    rhythm_leads: List[str] = layout_def.get("rhythm", [])
    n_main_rows = len(grid_rows)
    n_rhythm_rows = len(rhythm_leads)
    total_rows = n_main_rows + n_rhythm_rows
    n_cols = layout_def["cols"]

    col_ranges = determine_column_x_ranges(sig_map, text_map, detected_labels, n_cols)

    leads_mv: Dict[str, List[float]] = {}
    overlay_traces: List[Dict[str, Any]] = []
    all_baselines_y: List[int] = []

    def slice_pixels_to_calibrated_mv(
        seg_y: np.ndarray,
        seg_base: np.ndarray,
        invert_sign: bool = False,
    ) -> List[float]:
        seg_len_px = len(seg_y)
        if seg_len_px < 5:
            return [0.0] * 100

        # Voltage in mV relative to the smooth local baseline curve
        mv_raw = (seg_base - seg_y) / max(1e-4, px_per_mm_y * gain_mm_mv)
        if invert_sign:
            mv_raw = -mv_raw

        width_mm = seg_len_px / max(1e-4, px_per_mm_x)
        # Keep the true physical duration (a silent clip would distort the time base of every interval);
        # only guard against absurd values caused by a failed grid calibration.
        duration_sec = float(np.clip(width_mm / max(5.0, paper_speed_mm_s), 0.2, 60.0))
        num_samples = max(100, int(round(duration_sec * target_fs)))

        x_old = np.linspace(0.0, 1.0, len(mv_raw))
        x_new = np.linspace(0.0, 1.0, num_samples)
        mv_resampled = np.interp(x_new, x_old, mv_raw)
        mv_resampled = mv_resampled - np.median(mv_resampled)
        return [round(float(v), 4) for v in mv_resampled]

    # If there are rhythm strips at the bottom, separate the vertical region of main rows vs rhythm rows
    global_baselines = detect_row_baselines(sig_map, target_num_rows=total_rows)
    all_baselines_y = [int(y) for y in global_baselines]

    if n_rhythm_rows > 0 and len(global_baselines) >= n_main_rows + 1:
        main_y_limit = int(round(0.5 * (global_baselines[n_main_rows - 1] + global_baselines[n_main_rows])))
    else:
        main_y_limit = H

    # Extract each main column independently (so staggered columns like UTAS 6x2 have exact per-column baselines!)
    for c_idx in range(n_cols):
        cx0, cx1 = col_ranges[c_idx]
        col_slice = sig_map[:main_y_limit, cx0:cx1]
        col_traces, col_bases, col_by = extract_column_leads_with_peeling(col_slice, n_main_rows)

        for r_idx in range(min(n_main_rows, len(col_traces))):
            row_lead_names = grid_rows[r_idx]
            if c_idx >= len(row_lead_names):
                continue
            raw_lead_name = row_lead_names[c_idx]
            invert = raw_lead_name.startswith("-")
            clean_name = raw_lead_name.lstrip("-")
            display_name = raw_lead_name

            trace_y = col_traces[r_idx]
            base_c = col_bases[r_idx]
            mv_series = slice_pixels_to_calibrated_mv(trace_y, base_c, invert_sign=invert)
            leads_mv[display_name] = mv_series
            if invert and clean_name not in leads_mv:
                leads_mv[clean_name] = [round(-v, 4) for v in mv_series]

            step_ov = max(1, (cx1 - cx0) // 350)
            xs_local = list(range(0, cx1 - cx0, step_ov))
            pts_px = [[int(cx0 + xl), round(float(trace_y[xl]), 1)] for xl in xs_local]
            overlay_traces.append({
                "lead": display_name,
                "row": r_idx,
                "col": c_idx,
                "baseline_y_px": round(float(col_by[r_idx]), 1),
                "x_range_px": [cx0, cx1],
                "points_px": pts_px,
            })

    # Extract full-width rhythm strips at the bottom if present
    if n_rhythm_rows > 0:
        rx0 = col_ranges[0][0]
        rx1 = col_ranges[-1][1]
        rhy_y0 = max(0, main_y_limit - int(0.08 * H))
        rhy_slice = sig_map[rhy_y0:, rx0:rx1]
        rhy_traces, rhy_bases, rhy_by = extract_column_leads_with_peeling(rhy_slice, n_rhythm_rows)
        for rhy_i, rhy_name in enumerate(rhythm_leads):
            if rhy_i >= len(rhy_traces):
                break
            trace_y = rhy_y0 + rhy_traces[rhy_i]
            base_c = rhy_y0 + rhy_bases[rhy_i]
            mv_series = slice_pixels_to_calibrated_mv(trace_y, base_c, invert_sign=False)
            leads_mv[rhy_name] = mv_series
            step_ov = max(1, (rx1 - rx0) // 500)
            xs_local = list(range(0, rx1 - rx0, step_ov))
            pts_px = [[int(rx0 + xl), round(float(trace_y[xl]), 1)] for xl in xs_local]
            overlay_traces.append({
                "lead": rhy_name,
                "row": n_main_rows + rhy_i,
                "col": 0,
                "baseline_y_px": round(float(rhy_y0 + rhy_by[rhy_i]), 1),
                "x_range_px": [rx0, rx1],
                "points_px": pts_px,
            })

    return leads_mv, overlay_traces, np.array(all_baselines_y, dtype=int)


def render_diagnostic_visualizations(
    aligned_rgb: np.ndarray,
    sig_map: np.ndarray,
    grid_map: np.ndarray,
    overlay_traces: List[Dict[str, Any]],
    px_per_mm_x: float,
    px_per_mm_y: float,
) -> Dict[str, str]:
    """
    Creates base64 diagnostic images for the frontend inspection tabs:
    1. `aligned_image`: Cropped & perspective/skew-corrected RGB ECG photo
    2. `trace_overlay_image`: Digital extracted traces + 5mm calibration grid overlaid on the aligned photo
    3. `segmentation_heatmap`: Color-coded U-Net / Hybrid segmentation map (Red = Grid, Cyan/Green = ECG Signal)
    """
    H, W, _ = aligned_rgb.shape

    # 1. Aligned image
    b64_aligned = encode_image_base64(aligned_rgb, quality=88)

    # 2. Trace & 5mm Grid overlay image
    overlay_img = aligned_rgb.copy()
    # Draw subtle 5mm calibration verification grid in top-left 75x75mm patch
    box_w = max(8.0, 5.0 * px_per_mm_x)
    box_h = max(8.0, 5.0 * px_per_mm_y)
    for gx in range(0, min(W, int(12 * box_w)), max(1, int(round(box_w)))):
        cv2.line(overlay_img, (gx, 0), (gx, min(H, int(8 * box_h))), (255, 165, 0), 1, cv2.LINE_AA)
    for gy in range(0, min(H, int(8 * box_h)), max(1, int(round(box_h)))):
        cv2.line(overlay_img, (0, gy), (min(W, int(12 * box_w)), gy), (255, 165, 0), 1, cv2.LINE_AA)

    palette = [
        (0, 230, 118),
        (0, 176, 255),
        (255, 64, 129),
        (255, 215, 64),
        (124, 77, 255),
        (0, 229, 255),
    ]
    for idx, tr in enumerate(overlay_traces):
        pts = np.array(tr["points_px"], dtype=np.int32)
        if len(pts) >= 2:
            color = palette[idx % len(palette)]
            cv2.polylines(overlay_img, [pts], isClosed=False, color=color, thickness=2, lineType=cv2.LINE_AA)
            lx, ly = int(pts[0, 0]) + 6, max(18, int(tr["baseline_y_px"]) - 10)
            cv2.putText(
                overlay_img,
                str(tr["lead"]),
                (lx, ly),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                (15, 23, 42),
                3,
                cv2.LINE_AA,
            )
            cv2.putText(
                overlay_img,
                str(tr["lead"]),
                (lx, ly),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.55,
                color,
                1,
                cv2.LINE_AA,
            )
    b64_overlay = encode_image_base64(overlay_img, quality=88)

    # 3. Segmentation heatmap (R = Grid probability, G/B = Signal probability)
    heat = np.zeros((H, W, 3), dtype=np.uint8)
    heat[:, :, 0] = np.clip(grid_map * 210.0, 0, 255).astype(np.uint8)
    heat[:, :, 1] = np.clip(sig_map * 255.0, 0, 255).astype(np.uint8)
    heat[:, :, 2] = np.clip(sig_map * 220.0 + grid_map * 45.0, 0, 255).astype(np.uint8)
    b64_heatmap = encode_image_base64(heat, quality=84)

    return {
        "aligned_image": b64_aligned,
        "trace_overlay_image": b64_overlay,
        "segmentation_heatmap": b64_heatmap,
    }


def digitize_ecg_image(
    img_rgb: np.ndarray,
    method: str = "hybrid_ensemble",
    layout: str = "auto",
    paper_speed_mm_s: float = 25.0,
    gain_mm_mv: float = 10.0,
    target_fs: float = 500.0,
    rotate_deg: int = 0,
    custom_px_per_mm: Optional[float] = None,
    custom_roi: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    """
    Main entry point for ECG photo digitization.
    Args:
        img_rgb: RGB uint8 image array (H, W, 3)
        method: 'hybrid_ensemble' | 'open_ecg_unet' | 'krones_hough_cv' | 'dangnh_heatmap_dp'
        layout: 'auto' or one of LAYOUT_DEFINITIONS keys ('12x1', '3x4_r1', '6x2', '6x1_precordial', '6x1_limb', etc.)
        paper_speed_mm_s: 25.0 or 50.0 mm/s
        gain_mm_mv: 10.0, 5.0, or 20.0 mm/mV
        target_fs: Output sampling frequency in Hz (default 500 Hz)
        rotate_deg: Explicit user rotation (0, 90, 180, 270)
        custom_px_per_mm: Optional manual calibration override (pixels per 1 mm)
        custom_roi: Optional normalized crop box {'x': float, 'y': float, 'w': float, 'h': float}
    """
    t0 = time.time()
    warnings: List[str] = []
    requested_method = method

    if method not in SUPPORTED_METHODS:
        warnings.append(f"Неизвестный метод «{method}» — использован hybrid_ensemble")
        method = "hybrid_ensemble"
    if method in DL_METHODS:
        dl_status = deep_learning_status()
        if not dl_status["available"]:
            warnings.append(f"Нейросетевой метод недоступен ({dl_status['reason']}) — использован классический krones_hough_cv")
            method = "krones_hough_cv"

    if rotate_deg == 90:
        img_rgb = cv2.rotate(img_rgb, cv2.ROTATE_90_CLOCKWISE)
    elif rotate_deg == 180:
        img_rgb = cv2.rotate(img_rgb, cv2.ROTATE_180)
    elif rotate_deg == 270:
        img_rgb = cv2.rotate(img_rgb, cv2.ROTATE_90_COUNTERCLOCKWISE)

    H, W, _ = img_rgb.shape

    # Stage 1: Probability map extraction according to chosen method
    if method == "krones_hough_cv":
        sig_prob, grid_prob = classical_grid_and_signal_maps(img_rgb)
        text_prob = np.zeros_like(sig_prob)
    elif method == "open_ecg_unet":
        sig_prob, grid_prob, text_prob = run_open_ecg_unet_segmentation(img_rgb)
    else:
        # 'hybrid_ensemble' and 'dangnh_heatmap_dp' combine U-Net deep features with sharp high-res ink map
        unet_sig, unet_grid, text_prob = run_open_ecg_unet_segmentation(img_rgb)
        cv_sig, cv_grid = classical_grid_and_signal_maps(img_rgb)
        # Gate classical high-res ink map by active U-Net paper neighborhood and SUPPRESS U-Net text_prob & grid_prob!
        paper_mask = ndimage.gaussian_filter(np.clip(unet_grid + unet_sig, 0.0, 1.0), sigma=max(5.0, min(H, W) * 0.02))
        paper_gate = np.clip(paper_mask / (np.percentile(paper_mask, 75) + 1e-6), 0.10, 1.0)
        not_text_or_grid = np.clip(1.0 - 1.8 * text_prob - 1.25 * unet_grid, 0.0, 1.0)
        cv_sig_clean = cv_sig * paper_gate * not_text_or_grid
        if method == "dangnh_heatmap_dp":
            sig_prob = np.clip(0.75 * unet_sig + 0.25 * cv_sig_clean, 0.0, 1.0)
            grid_prob = np.clip(0.80 * unet_grid + 0.20 * (cv_grid * paper_gate), 0.0, 1.0)
        else:
            sig_prob = np.clip(0.82 * unet_sig + 0.18 * cv_sig_clean, 0.0, 1.0)
            grid_prob = np.clip(0.85 * unet_grid + 0.15 * (cv_grid * paper_gate), 0.0, 1.0)

    # Stage 2: Paper ROI Crop & Hough Perspective / Skew Rectification
    aligned_rgb, aligned_sig, aligned_grid, aligned_text, align_meta = crop_and_deskew_ecg_region(
        img_rgb,
        sig_prob,
        grid_prob,
        text_prob,
        custom_roi=custom_roi,
    )

    # Stage 3: Lead label recognition & layout identification
    detected_labels: List[Dict[str, Any]] = []
    # Lead labels are only consumed by layout inference (`auto`) and by the 2-column split (6x2 layouts):
    # skip the ~5 s LeadName U-Net pass when the user fixed any other layout.
    explicit_layout = layout != "auto" and layout in LAYOUT_DEFINITIONS
    labels_needed = (not explicit_layout) or LAYOUT_DEFINITIONS[layout]["cols"] == 2
    if labels_needed and np.max(aligned_text) > 0.05:
        try:
            detected_labels = detect_lead_labels_with_unet(aligned_text)
        except Exception:
            detected_labels = []

    # Stage 4: Grid Pixel Size Calibration (joint isotropic comb search -> PixelSizeFinder -> paper prior).
    # Runs BEFORE layout inference: the calibrated row spacing in mm is a strong cue for the number of rows.
    explicit_rows = (
        len(LAYOUT_DEFINITIONS[layout]["grid"]) + len(LAYOUT_DEFINITIONS[layout].get("rhythm", [])) if explicit_layout else 6
    )
    if custom_px_per_mm is not None and custom_px_per_mm > 0.5:
        spacing = {
            "px_per_mm_x": float(custom_px_per_mm),
            "px_per_mm_y": float(custom_px_per_mm),
            "px_per_mm": float(custom_px_per_mm),
            "mm_per_px_x": round(1.0 / float(custom_px_per_mm), 5),
            "mm_per_px_y": round(1.0 / float(custom_px_per_mm), 5),
            "method": "manual",
        }
    else:
        spacing = estimate_pixel_spacing_mm(aligned_grid, aligned_rgb, expected_rows=explicit_rows)
        if spacing.get("method") == "paper_size_fallback":
            warnings.append(
                "Шаг миллиметровой сетки не найден автоматически — масштаб оценён по размеру листа; "
                "проверьте калибровку (2 точки по клеткам 5 мм) перед измерением интервалов"
            )
        else:
            # Plausibility: visible paper is ~100–320 mm wide (thermal strip … A4 landscape). A grid period locked onto
            # the 5-mm (instead of 1-mm) lines or onto texture gives absurd widths and a wrong time base.
            visible_w_mm = aligned_rgb.shape[1] / max(1e-6, float(spacing["px_per_mm_x"]))
            if visible_w_mm > 420.0 or visible_w_mm < 40.0:
                warnings.append(
                    f"Подозрительная калибровка сетки: ширина изображения ≈ {visible_w_mm:.0f} мм "
                    f"({spacing['px_per_mm']:.2f} пикс/мм) — проверьте масштаб по клеткам 5 мм"
                )

    # Stage 3b: layout identification (model selection over row counts + lead-label cues)
    row_count_scores: Dict[int, float] = {}
    if explicit_layout:
        chosen_layout = layout
    else:
        trusted_scale = spacing.get("method") in ("joint_grid_search", "pixel_size_finder", "manual")
        n_rows, row_baselines, row_count_scores = select_row_count(
            aligned_sig,
            px_per_mm_y=float(spacing["px_per_mm_y"]) if trusted_scale else None,
            gain_mm_mv=gain_mm_mv,
        )
        chosen_layout = infer_best_layout(aligned_sig, aligned_text, detected_labels, row_baselines)
        if method == "krones_hough_cv":
            # The classical ink map also responds to grid lines, which look like extra "rows" in the projection
            warnings.append(
                f"Раскладка определена автоматически классическим методом ({chosen_layout}) — это ненадёжно; "
                "проверьте её или выберите раскладку вручную"
            )
    layout_info = LAYOUT_DEFINITIONS[chosen_layout]

    # Stage 5: Waveform Extraction for all leads in layout
    leads_mv, overlay_traces, final_baselines = extract_all_leads_for_layout(
        aligned_sig,
        layout_key=chosen_layout,
        px_per_mm_x=spacing["px_per_mm_x"],
        px_per_mm_y=spacing["px_per_mm_y"],
        paper_speed_mm_s=paper_speed_mm_s,
        gain_mm_mv=gain_mm_mv,
        target_fs=target_fs,
        text_map=aligned_text,
        detected_labels=detected_labels,
    )

    # Stage 6: Render Diagnostic Overlays
    visuals = render_diagnostic_visualizations(
        aligned_rgb,
        aligned_sig,
        aligned_grid,
        overlay_traces,
        px_per_mm_x=spacing["px_per_mm_x"],
        px_per_mm_y=spacing["px_per_mm_y"],
    )

    elapsed_s = round(time.time() - t0, 2)

    return {
        "method": method,
        "requested_method": requested_method,
        "warnings": warnings,
        "layout": chosen_layout,
        "layout_label": layout_info["label"],
        "paper_speed_mm_s": paper_speed_mm_s,
        "gain_mm_mv": gain_mm_mv,
        "sampling_rate_hz": target_fs,
        "pixel_spacing": spacing,
        "alignment": {
            **align_meta,
            "aligned_size": [int(aligned_rgb.shape[1]), int(aligned_rgb.shape[0])],
            "detected_row_baselines_px": [int(y) for y in final_baselines],
            "detected_lead_labels": detected_labels,
            "row_count_scores": {str(k): v for k, v in row_count_scores.items()},
        },
        "leads_mv": leads_mv,
        "overlay_traces": overlay_traces,
        "visualizations": visuals,
        "elapsed_sec": elapsed_s,
    }
