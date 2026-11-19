"""
FastAPI Backend Server for the ECG Photo Digitizer & Clinical Caliper Workstation.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from collections import OrderedDict
from typing import Any, Dict, List, Literal, Optional

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from app.core.digitizer import LAYOUT_DEFINITIONS, SUPPORTED_METHODS, deep_learning_status, digitize_ecg_image
from app.core.ecg_analysis import analyze_all_leads, compute_intervals_from_calipers
from app.core.ecg_autoanalysis import NEUROKIT_VERSION, analyze_ecg
from app.core.ecg_formats import SIGNAL_EXTENSIONS, TARGET_FS, FormatError, Recording, extract_segment, hr_trend, prepare_recording
from app.core.ecg_interpretation import interpret

logger = logging.getLogger("ecg_workstation")

MAX_UPLOAD_BYTES = 40 * 1024 * 1024  # 40 MB: large phone photos / multi-page PDFs
MAX_IMAGE_SIDE_PX = 4000  # larger inputs (48 MP photos, 600-dpi scans) are downscaled before the Viterbi tracker
PDF_RENDER_DPI = 250
MAX_SIGNAL_UPLOAD_BYTES = 400 * 1024 * 1024  # 24-h Holter recordings (EDF / ISHNE / WFDB)
SIGNAL_CACHE_SIZE = 2  # parsed recordings kept in memory for segment navigation without re-upload

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EXAMPLES_DIR = os.path.join(BASE_DIR, "example")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(STATIC_DIR, exist_ok=True)

app = FastAPI(
    title="ECG Photo Digitizer & Clinical Caliper Workstation",
    description="Оцифровка бумажных ЭКГ (Open-ECG-Digitizer U-Net, Krones Hough-CV, dangnh0611 Viterbi-DP) и интерактивные кардиологические калиперы",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

if os.path.isdir(EXAMPLES_DIR):
    app.mount("/examples", StaticFiles(directory=EXAMPLES_DIR), name="examples")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


EXAMPLE_PRESETS: Dict[str, Dict[str, Any]] = {
    "photo_2026-11-19_00-34-51.jpg": {
        "title": "Кардио++ (12×1 вертикальная, 50 мм/с)",
        "speed_mm_s": 50.0,
        "gain_mm_mv": 10.0,
        "layout_hint": "12x1",
        "description": "Фото листа А4 в руке, 12 отведений (I–V6), 50 мм/с, 10 мм/мВ, ЧСС 90",
    },
    "photo_2026-11-19_00-35-31.jpg": {
        "title": "MEGACART 3 (3×4 + полоса ритма II, 25 мм/с)",
        "speed_mm_s": 25.0,
        "gain_mm_mv": 10.0,
        "layout_hint": "3x4_r1",
        "description": "Сложенный бланк ЭКГ, 3×4 + ритм II, 25 мм/с, синусовая брадикардия (ЧСС 59)",
    },
    "photo_2026-11-19_00-35-36.jpg": {
        "title": "Скан 12 отведений (6×2 + полоса ритма II, 25 мм/с)",
        "speed_mm_s": 25.0,
        "gain_mm_mv": 10.0,
        "layout_hint": "6x2_r1",
        "description": "Чистый цифровой скан 6×2 (I–aVF слева, V1–V6 справа) + ритм II внизу, 25 мм/с",
    },
    "photo_2026-11-19_00-35-40.jpg": {
        "title": "UTAS Грудные отведения V1–V6 (6×1 лента, 25 мм/с)",
        "speed_mm_s": 25.0,
        "gain_mm_mv": 10.0,
        "layout_hint": "6x1_precordial",
        "description": "Термолента на столе, грудные отведения V1–V6 с высокой амплитудой QRS, 25 мм/с",
    },
    "photo_2026-11-19_00-35-47.jpg": {
        "title": "UTAS Отведения от конечностей I–aVF (6×1 лента, 25 мм/с)",
        "speed_mm_s": 25.0,
        "gain_mm_mv": 10.0,
        "layout_hint": "6x1_limb",
        "description": "Термолента на столе, отведения I, II, III, aVR, aVL, aVF, 25 мм/с, ЧСС 58",
    },
    "photo_2026-11-19_00-35-51.jpg": {
        "title": "UTAS Усредненный QRS (6×2 лента, 50 мм/с)",
        "speed_mm_s": 50.0,
        "gain_mm_mv": 10.0,
        "layout_hint": "6x2",
        "description": "Термолента с усредненными комплексами P-QRS-T всех 12 отведений (6×2), 50 мм/с",
    },
    "photo_2026-11-19_00-37-16.jpg": {
        "title": "Скан 12×1 (50 мм/с, дрейф изолинии в V5)",
        "speed_mm_s": 50.0,
        "gain_mm_mv": 10.0,
        "layout_hint": "12x1",
        "description": "Полная 12-канальная развертка I–V6, скорость 50 мм/сек, выраженный дрейф в V5",
    },
    "photo_2026-11-19_00-37-21.jpg": {
        "title": "CardioBox (3×4 + 2 полосы ритма I и II, 25 мм/с)",
        "speed_mm_s": 25.0,
        "gain_mm_mv": 10.0,
        "layout_hint": "3x4_r2",
        "description": "Скриншот интерфейса CardioBox: 3×4 + ритм I и II, 25 мм/с, ЧСС 73",
    },
}


class CaliperRecalcRequest(BaseModel):
    calipers_ms: Dict[str, float]
    signal_mv: Optional[List[float]] = None
    fs: float = 500.0
    rr_ms: Optional[float] = None


class ReanalyzeLeadsRequest(BaseModel):
    leads_mv: Dict[str, List[float]]
    fs: float = 500.0
    preferred_lead: Optional[str] = None
    sex: Optional[Literal["male", "female"]] = None


@app.get("/", response_class=HTMLResponse)
async def index_page() -> FileResponse:
    index_path = os.path.join(STATIC_DIR, "index.html")
    if not os.path.isfile(index_path):
        raise HTTPException(status_code=404, detail="Frontend index.html not found")
    return FileResponse(index_path)


@app.get("/api/config")
async def get_workstation_config() -> Dict[str, Any]:
    examples: List[Dict[str, Any]] = []
    if os.path.isdir(EXAMPLES_DIR):
        for fname in sorted(os.listdir(EXAMPLES_DIR)):
            if fname.lower().endswith((".jpg", ".jpeg", ".png")):
                preset = EXAMPLE_PRESETS.get(fname, {})
                examples.append({
                    "filename": fname,
                    "url": f"/examples/{fname}",
                    "title": preset.get("title", fname),
                    "speed_mm_s": preset.get("speed_mm_s", 25.0),
                    "gain_mm_mv": preset.get("gain_mm_mv", 10.0),
                    "layout_hint": preset.get("layout_hint", "auto"),
                    "description": preset.get("description", "Пример фото ЭКГ"),
                })

    methods: List[Dict[str, Any]] = [
        {
            "id": "hybrid_ensemble",
            "name": "Hybrid Ensemble (Open-ECG U-Net + Krones Hough + Viterbi DP)",
            "badge": "Рекомендуется",
            "description": "Ансамбль: сегментация предобученной U-Net (Ahus-AIM) + авто-выделение бланка и коррекция перспективы Хафа (Krones) + автокорреляция сетки + Viterbi-трекинг перекрывающихся QRS (dangnh0611).",
        },
        {
            "id": "open_ecg_unet",
            "name": "Open-ECG-Digitizer (Ahus-AIM 4-class U-Net + LeadName U-Net)",
            "badge": "Deep Learning",
            "description": "Оригинальная нейросетевая сегментация Open-ECG-Digitizer (22.6M параметров, классы: сетка, сигнал, текст, фон) с автокорреляционным поиском шага миллиметровки.",
        },
        {
            "id": "dangnh_heatmap_dp",
            "name": "Kaggle 5th Place Heatmap + Viterbi Dynamic Programming (dangnh0611)",
            "badge": "Heatmap + DP",
            "description": "Многостадийная тепловая карта высокой четкости + динамическое программирование (Viterbi) и венгерский алгоритм для разделения накладывающихся зубцов R/S соседних отведений.",
        },
        {
            "id": "krones_hough_cv",
            "name": "ECG-Digitiser Classical Hough + Color Decoupling (Felix Krones et al.)",
            "badge": "Быстрый CV",
            "description": "Классическое цветовое разделение миллиметровой сетки и чернил в пространстве RGB/LAB + преобразование Хафа (1-е место PhysioNet Challenge 2024).",
        },
    ]

    layouts = [{"id": "auto", "label": "Автоопределение раскладки (LeadName U-Net + Профиль строк)"}]
    for k, v in LAYOUT_DEFINITIONS.items():
        layouts.append({"id": k, "label": v["label"], "rows": v["rows"], "cols": v["cols"]})

    dl_status = deep_learning_status()
    if not dl_status["available"]:
        for m in methods:
            if m["id"] != "krones_hough_cv":
                m["unavailable"] = True
                m["badge"] = "Недоступно"

    return {
        "examples": examples,
        "methods": methods,
        "layouts": layouts,
        "deep_learning": dl_status,
        "autoanalysis": {"available": True, "neurokit2": NEUROKIT_VERSION},
        "signal_formats": {"extensions": list(SIGNAL_EXTENSIONS), "max_upload_mb": MAX_SIGNAL_UPLOAD_BYTES // (1024 * 1024)},
    }


def _decode_pdf_page(raw_bytes: bytes, filename: str, pdf_page: int) -> tuple[np.ndarray, str]:
    import fitz  # PyMuPDF

    with fitz.open(stream=raw_bytes, filetype="pdf") as doc:
        if len(doc) == 0:
            raise ValueError("PDF не содержит страниц")
        p_idx = max(0, min(len(doc) - 1, int(pdf_page) - 1))
        page = doc[p_idx]
        # Cap the render so huge-format pages (A3 / long rhythm strips) do not explode into >6000 px bitmaps
        long_side_in = max(page.rect.width, page.rect.height) / 72.0
        dpi = int(max(96, min(PDF_RENDER_DPI, MAX_IMAGE_SIDE_PX / max(1e-3, long_side_in))))
        pix = page.get_pixmap(dpi=dpi, alpha=False)
        if pix.n != 3:
            pix = fitz.Pixmap(fitz.csRGB, pix)
        rgb_arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3).copy()
        name = f"{filename} (стр. {p_idx + 1}/{len(doc)})"
    return cv2.cvtColor(rgb_arr, cv2.COLOR_RGB2BGR), name


@app.post("/api/digitize")
async def api_digitize_ecg(
    file: Optional[UploadFile] = File(default=None),
    example_name: Optional[str] = Form(default=None),
    method: str = Form(default="hybrid_ensemble"),
    layout: str = Form(default="auto"),
    paper_speed_mm_s: float = Form(default=25.0),
    gain_mm_mv: float = Form(default=10.0),
    target_fs: float = Form(default=500.0),
    rotate_deg: int = Form(default=0),
    custom_px_per_mm: Optional[float] = Form(default=None),
    custom_roi_json: Optional[str] = Form(default=None),
    pdf_page: int = Form(default=1),
    patient_sex: Optional[str] = Form(default=None),
) -> JSONResponse:
    img_bgr: Optional[np.ndarray] = None
    source_name = "uploaded_ecg.jpg"

    if method not in SUPPORTED_METHODS:
        raise HTTPException(status_code=400, detail=f"Неизвестный метод оцифровки: {method}")
    if not (5.0 <= paper_speed_mm_s <= 200.0) or not (1.0 <= gain_mm_mv <= 100.0) or not (50.0 <= target_fs <= 2000.0):
        raise HTTPException(status_code=400, detail="Недопустимые параметры: скорость 5–200 мм/с, усиление 1–100 мм/мВ, частота 50–2000 Гц")
    if rotate_deg not in (0, 90, 180, 270):
        raise HTTPException(status_code=400, detail="Поворот допускается только на 0, 90, 180 или 270°")

    if file is not None and file.filename:
        raw_bytes = await file.read()
        if len(raw_bytes) == 0:
            raise HTTPException(status_code=400, detail="Загруженный файл пуст")
        if len(raw_bytes) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"Файл слишком большой (> {MAX_UPLOAD_BYTES // (1024 * 1024)} МБ)")
        is_pdf = file.filename.lower().endswith(".pdf") or raw_bytes[:4] == b"%PDF"
        if is_pdf:
            try:
                img_bgr, source_name = await run_in_threadpool(_decode_pdf_page, raw_bytes, file.filename, pdf_page)
            except Exception as exc:
                raise HTTPException(status_code=400, detail=f"Ошибка чтения PDF ЭКГ: {exc}") from exc
        else:
            arr = np.frombuffer(raw_bytes, dtype=np.uint8)
            img_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            source_name = file.filename
    elif example_name:
        safe_name = os.path.basename(example_name)
        fpath = os.path.join(EXAMPLES_DIR, safe_name)
        if not os.path.isfile(fpath):
            raise HTTPException(status_code=404, detail=f"Пример {safe_name} не найден")
        img_bgr = cv2.imread(fpath, cv2.IMREAD_COLOR)
        source_name = safe_name
    else:
        raise HTTPException(status_code=400, detail="Необходимо загрузить файл фото ЭКГ или выбрать пример из списка")

    if img_bgr is None:
        raise HTTPException(status_code=400, detail="Не удалось декодировать изображение ЭКГ")
    if min(img_bgr.shape[:2]) < 64:
        raise HTTPException(status_code=400, detail="Изображение слишком маленькое для оцифровки (< 64 px)")
    pre_warnings: List[str] = []
    long_side = max(img_bgr.shape[:2])
    if long_side > MAX_IMAGE_SIDE_PX:
        # Deterministic downscale: the returned aligned image, overlay coordinates, the auto-detected px/mm and any
        # manual px/mm the user derives from it all live in this same downscaled pixel space.
        scale = MAX_IMAGE_SIDE_PX / float(long_side)
        new_size = (max(1, int(round(img_bgr.shape[1] * scale))), max(1, int(round(img_bgr.shape[0] * scale))))
        pre_warnings.append(
            f"Изображение {img_bgr.shape[1]}×{img_bgr.shape[0]} px уменьшено до {new_size[0]}×{new_size[1]} px для ускорения оцифровки"
        )
        img_bgr = cv2.resize(img_bgr, new_size, interpolation=cv2.INTER_AREA)

    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

    custom_roi: Optional[Dict[str, float]] = None
    if custom_roi_json:
        try:
            parsed_roi = json.loads(custom_roi_json)
            if isinstance(parsed_roi, dict):
                custom_roi = {k: float(v) for k, v in parsed_roi.items() if k in ("x", "y", "w", "h")}
        except Exception:
            custom_roi = None

    # CPU-heavy (U-Net + Viterbi DP, seconds per image): run off the event loop so the server stays responsive
    try:
        dig_result = await run_in_threadpool(
            digitize_ecg_image,
            img_rgb=img_rgb,
            method=method,
            layout=layout,
            paper_speed_mm_s=float(paper_speed_mm_s),
            gain_mm_mv=float(gain_mm_mv),
            target_fs=float(target_fs),
            rotate_deg=int(rotate_deg),
            custom_px_per_mm=float(custom_px_per_mm) if (custom_px_per_mm and custom_px_per_mm > 0) else None,
            custom_roi=custom_roi,
        )
        analysis_result = await run_in_threadpool(
            analyze_all_leads,
            leads_mv=dig_result["leads_mv"],
            fs=float(target_fs),
            sex=patient_sex if patient_sex in ("male", "female") else None,
        )
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Digitization failed for %s", source_name)
        raise HTTPException(status_code=500, detail=f"Ошибка оцифровки ЭКГ: {type(exc).__name__}: {exc}") from exc

    dig_result["warnings"] = pre_warnings + list(dig_result.get("warnings", []))

    return JSONResponse({
        "source_name": source_name,
        "digitization": dig_result,
        "analysis": analysis_result,
    })


# ---------------------------------------------------------------------------------- digital ECG / Holter files
_signal_cache: "OrderedDict[str, Dict[str, Any]]" = OrderedDict()
_signal_cache_lock = threading.Lock()


def _cache_put(rec: Recording, trend: Optional[Dict[str, Any]], name: str) -> str:
    rid = uuid.uuid4().hex
    with _signal_cache_lock:
        _signal_cache[rid] = {"rec": rec, "trend": trend, "name": name}
        while len(_signal_cache) > SIGNAL_CACHE_SIZE:
            _signal_cache.popitem(last=False)
    return rid


def _cache_get(rid: str) -> Optional[Dict[str, Any]]:
    with _signal_cache_lock:
        item = _signal_cache.get(rid)
        if item is not None:
            _signal_cache.move_to_end(rid)
        return item


def _signal_payload(rid: str, item: Dict[str, Any], start_s: float, dur_s: Optional[float], sex: Optional[str],
                    t0: float) -> Dict[str, Any]:
    rec: Recording = item["rec"]
    seg = extract_segment(rec, start_s, dur_s)
    analysis = analyze_all_leads(leads_mv=seg["leads_mv"], fs=TARGET_FS, sex=sex if sex in ("male", "female") else None)
    n_leads = len(seg["leads_mv"])
    digitization = {
        "source_type": "signal",
        "method": "native_signal",
        "layout": "signal",
        "layout_label": f"{rec.format}, {n_leads} отв., {rec.fs:g} Гц",
        "paper_speed_mm_s": 25.0,
        "gain_mm_mv": 10.0,
        "sampling_rate_hz": TARGET_FS,
        "leads_mv": seg["leads_mv"],
        "overlay_traces": [],
        "lead_quality": {},
        "visualizations": {},
        "warnings": seg["warnings"],
        "elapsed_sec": round(time.perf_counter() - t0, 2),
        "signal": {
            "recording_id": rid,
            "format": seg["format"],
            "native_fs": seg["native_fs"],
            "record_duration_s": seg["record_duration_s"],
            "segment_start_s": seg["segment_start_s"],
            "segment_duration_s": seg["segment_duration_s"],
            "info": seg["info"],
            "channels": list(rec.leads),
            "trend": item["trend"],
        },
    }
    return {"source_name": item["name"], "digitization": digitization, "analysis": analysis}


@app.post("/api/load_signal")
async def api_load_signal(
    files: List[UploadFile] = File(...),
    segment_start_s: float = Form(default=0.0),
    segment_duration_s: Optional[float] = Form(default=None),
    fs_hint: Optional[float] = Form(default=None),
    patient_sex: Optional[str] = Form(default=None),
) -> JSONResponse:
    """Native digital recordings (EDF/BDF, ISHNE, WFDB, GE MUSE XML, HL7 aECG, DICOM, CSV): no image digitization."""
    t0 = time.perf_counter()
    blobs: Dict[str, bytes] = {}
    total = 0
    for f in files:
        if not f.filename:
            continue
        data = await f.read()
        total += len(data)
        if total > MAX_SIGNAL_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"Запись слишком большая (> {MAX_SIGNAL_UPLOAD_BYTES // (1024 * 1024)} МБ)")
        if data:
            blobs[f.filename] = data
    if not blobs:
        raise HTTPException(status_code=400, detail="Файлы записи пусты")
    if fs_hint is not None and not (50.0 <= fs_hint <= 20000.0):
        raise HTTPException(status_code=400, detail="Частота дискретизации должна быть 50–20000 Гц")
    name = " + ".join(sorted(blobs))
    try:
        rec = await run_in_threadpool(prepare_recording, blobs, fs_hint)
        trend = await run_in_threadpool(hr_trend, rec)
        rid = _cache_put(rec, trend, name)
        payload = await run_in_threadpool(_signal_payload, rid, _signal_cache[rid], segment_start_s, segment_duration_s,
                                          patient_sex, t0)
    except FormatError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Signal import failed for %s", name)
        raise HTTPException(status_code=400, detail=f"Не удалось прочитать запись: {type(exc).__name__}: {exc}") from exc
    return JSONResponse(payload)


class SignalSegmentRequest(BaseModel):
    recording_id: str
    segment_start_s: float = 0.0
    segment_duration_s: Optional[float] = None
    patient_sex: Optional[str] = None


@app.post("/api/signal_segment")
async def api_signal_segment(req: SignalSegmentRequest) -> JSONResponse:
    """Another window of a cached (Holter) recording: no re-upload of the file."""
    t0 = time.perf_counter()
    item = _cache_get(req.recording_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Запись не найдена в памяти сервера — загрузите файл заново")
    payload = await run_in_threadpool(_signal_payload, req.recording_id, item, req.segment_start_s, req.segment_duration_s,
                                      req.patient_sex, t0)
    return JSONResponse(payload)


@app.post("/api/recalculate_calipers")
def api_recalculate_calipers(req: CaliperRecalcRequest) -> JSONResponse:
    if not (50.0 <= req.fs <= 2000.0):
        raise HTTPException(status_code=400, detail="Частота дискретизации должна быть в диапазоне 50–2000 Гц")
    sig_arr = np.asarray(req.signal_mv, dtype=np.float64) if req.signal_mv else None
    metrics = compute_intervals_from_calipers(
        calipers_ms=req.calipers_ms,
        sig_mv=sig_arr,
        fs=req.fs,
        rr_ms=req.rr_ms,
    )
    return JSONResponse(metrics)


class AutoAnalysisRequest(BaseModel):
    leads_mv: Dict[str, List[float]]
    fs: float = 500.0
    # leads recorded simultaneously (same strip/column), e.g. [["I","II",...,"V6"]] for 12x1, 4 groups for 3x4
    groups: Optional[List[List[str]]] = None
    lead_quality: Optional[Dict[str, str]] = None
    artifacts_ms: Optional[Dict[str, List[List[float]]]] = None
    # "refresh from the workbench": the physician's R marks and calipers replace the automatic ones
    calipers_ms: Optional[Dict[str, Dict[str, float]]] = None
    r_peaks_ms: Optional[Dict[str, List[float]]] = None
    reference_lead: Optional[str] = None
    # fiducials the physician moved on the reference lead (only these override the automatic values)
    reference_edited: Optional[List[str]] = None
    patient: Optional[Dict[str, Any]] = None
    options: Optional[Dict[str, Any]] = None


def _run_autoanalysis(req: AutoAnalysisRequest) -> Dict[str, Any]:
    result = analyze_ecg(
        req.leads_mv,
        fs=req.fs,
        groups=req.groups,
        lead_quality=req.lead_quality,
        artifacts_ms={k: [tuple(z[:2]) for z in v if len(z) >= 2] for k, v in (req.artifacts_ms or {}).items()},
        calipers_override=req.calipers_ms,
        r_peaks_override_ms=req.r_peaks_ms,
        reference_lead=req.reference_lead,
        reference_edited=req.reference_edited,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=422, detail=result.get("error", "Автоанализ не выполнен"))
    interp = interpret(result, patient=req.patient, options=req.options)
    axis_text = next((f["text"].rstrip(".") for f in interp["findings"] if f["code"] in ("axis", "axis_unknown")), "—")
    analysis = {
        "primary_lead": result["primary_lead"],
        "global_hr_bpm": result["rhythm"]["hr_bpm"],
        "global_rr_ms": result["intervals"]["rr_ms"],
        "axes": {**result["axes"], "classification": axis_text},
        "hypertrophy": {},
        "leads": result["leads"],
    }
    summary = {k: result[k] for k in ("intervals", "rhythm", "axes", "methods", "groups", "simultaneous_leads", "features")}
    return {"analysis": analysis, "autoanalysis": summary, "interpretation": interp}


@app.post("/api/autoanalysis")
async def api_autoanalysis(req: AutoAnalysisRequest) -> JSONResponse:
    """Consensus QRS detection + median-beat global delineation + rule-based interpretation (see ecg_autoanalysis)."""
    if not (50.0 <= req.fs <= 2000.0):
        raise HTTPException(status_code=400, detail="Частота дискретизации должна быть в диапазоне 50–2000 Гц")
    if not req.leads_mv:
        raise HTTPException(status_code=400, detail="Нет сигналов отведений")
    try:
        payload = await run_in_threadpool(_run_autoanalysis, req)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Autoanalysis failed")
        raise HTTPException(status_code=500, detail=f"Ошибка автоанализа: {type(exc).__name__}: {exc}") from exc
    return JSONResponse(payload)


@app.post("/api/reanalyze_leads")
def api_reanalyze_leads(req: ReanalyzeLeadsRequest) -> JSONResponse:
    # Plain `def` endpoints run in FastAPI's threadpool, so re-analysis of 12 leads never blocks the event loop
    if not (50.0 <= req.fs <= 2000.0):
        raise HTTPException(status_code=400, detail="Частота дискретизации должна быть в диапазоне 50–2000 Гц")
    analysis_result = analyze_all_leads(
        leads_mv=req.leads_mv,
        fs=req.fs,
        preferred_lead=req.preferred_lead,
        sex=req.sex,
    )
    return JSONResponse(analysis_result)
