/**
 * ECG Photo Digitizer & Interactive Clinical Caliper Workstation
 * Frontend Application Engine
 */

(() => {
  "use strict";

  // Application State
  const state = {
    config: null,
    uploadedFile: null,
    // Original (un-rectified) user upload; `uploadedFile` may later hold a rectified / cleaned derivative of it
    sourceFile: null,
    // Monotonic id of the latest digitization request (stale responses are ignored)
    digitizeRunId: 0,
    // Per-lead pristine signal + px/mm it was produced at (calibration rescales from it, never cumulatively)
    calibBase: {},
    uploadedPdfDoc: null,
    uploadedPdfRawFile: null,
    uploadedPdfPage: 1,
    currentSource: null,
    digitization: null,
    analysis: null,
    activeLead: "II",
    activeBeatIdx: 0,
    caliperMode: "fiducial", // 'fiducial' | 'r_edit' | 'artifact' | 'free' | 'marching'
    w1Tool: "select_move", // 'select_move' | 'r_add_del' | 'artifact'
    zoomX: 1.0,
    zoomY: 1.0,
    panOffsetMs: 0,
    // Artifact exclusion zones per lead: { [leadName]: Array<{ startMs: number, endMs: number, label?: string }> }
    artifactsByLead: {},
    // Backup of initial auto-detected R-peaks per lead for reset
    originalBeatsByLead: {},
    // Active drag state in Window 1 or Window 2
    w1DragState: null,
    artifactDragStartMs: null,
    // Active fiducial caliper positions in ms for current lead & beat
    calipersMs: {
      p_onset: 100,
      p_peak: 145,
      p_offset: 190,
      qrs_onset: 240,
      r_peak: 280,
      qrs_offset: 328,
      t_onset: 390,
      t_peak: 475,
      t_offset: 565,
      next_r_peak: 1040,
    },
    // Free / Marching caliper positions in ms and mV
    freeCalipers: {
      t1_ms: 200,
      t2_ms: 400,
      v1_mv: 0.0,
      v2_mv: 0.8,
    },
    draggingHandle: null,
    hoverHandle: null,
    // Viewport mapping for caliperCanvas
    viewWindow: {
      startMs: 0,
      endMs: 1500,
      pxPerMm: 7.5,
      centerY: 185,
      padLeft: 48,
      padRight: 24,
      padTop: 34,
      padBottom: 32,
    },
    // Manual 2-point calibration & interactive grid overlay state on #calGridCanvas
    calClicks: [],
    autoPxPerMm: 5.5,
    activePxPerMm: 5.5,
    calGridOrigin: { x: 0, y: 0 },
    calRulerA: null,
    calRulerB: null,
    calRulerHover: null,
    calPhaseDrag: null,
    calZoom: 1.0,
    // Interactive Trace Overlay (Zoom + Lead Rename + Auto-Trace Line Correction)
    overlayZoom: 1.0,
    overlayTool: "view", // 'view' | 'autotrace' | 'draw'
    selectedTraceIdx: 0,
    originalOverlayTraces: [],
    overlayInkMap: null,
    overlayBadgeHitBoxes: [],
    overlayDrawActive: false,
    overlayLastPt: null,
    // Window 1 Zoom & Panning
    w1Zoom: 1.0,
    w1PanState: null,
    // Grid Intersections (+) & Paper Deformation Rectification Tab
    gridNodesZoom: 1.0,
    gridNodesResult: null,
    originalAlignedDataUrl: null,
    gridNodesPanState: null,
    // Vectorcardiogram (VCG) view mode
    vcgPlane: "all3", // 'all3' | 'frontal' | 'horizontal' | 'sagittal' | '3d'
  };

  const FIDUCIAL_DEFS = [
    { key: "p_onset", label: "P_on", short: "Pon", color: "#0F4C81", group: "p", row: 0 },
    { key: "p_peak", label: "P_pk", short: "P", color: "#1D6FA5", group: "p", row: 1 },
    { key: "p_offset", label: "P_off", short: "Poff", color: "#0F4C81", group: "p", row: 0 },
    { key: "qrs_onset", label: "QRS_on", short: "Qon", color: "#D9381E", group: "qrs", row: 0 },
    { key: "r_peak", label: "R_pk", short: "R", color: "#B02310", group: "qrs", row: 1 },
    { key: "qrs_offset", label: "J (QRS_off)", short: "J", color: "#D9381E", group: "qrs", row: 0 },
    { key: "t_onset", label: "T_on", short: "Ton", color: "#0B7A53", group: "t", row: 0 },
    { key: "t_peak", label: "T_pk", short: "T", color: "#0E9F6E", group: "t", row: 1 },
    { key: "t_offset", label: "T_off", short: "Toff", color: "#0B7A53", group: "t", row: 0 },
    { key: "next_r_peak", label: "R_+1", short: "R+1", color: "#7C3AED", group: "rr", row: 0 },
  ];

  // DOM Elements
  const el = {
    selectExample: document.getElementById("selectExample"),
    selectPdfPage: document.getElementById("selectPdfPage"),
    fileUploadInput: document.getElementById("fileUploadInput"),
    exampleDescription: document.getElementById("exampleDescription"),
    selectMethod: document.getElementById("selectMethod"),
    methodDescription: document.getElementById("methodDescription"),
    selectLayout: document.getElementById("selectLayout"),
    selectSpeed: document.getElementById("selectSpeed"),
    selectGain: document.getElementById("selectGain"),
    selectRotate: document.getElementById("selectRotate"),
    btnDigitize: document.getElementById("btnDigitize"),
    btnDigitizeText: document.getElementById("btnDigitizeText"),
    statusBadge: document.getElementById("statusBadge"),
    digitizationMetaLine: document.getElementById("digitizationMetaLine"),
    multileadCanvas: document.getElementById("multileadCanvas"),
    multileadContainer: document.getElementById("multileadContainer"),
    btnW1ZoomOut: document.getElementById("btnW1ZoomOut"),
    selectW1Zoom: document.getElementById("selectW1Zoom"),
    btnW1ZoomIn: document.getElementById("btnW1ZoomIn"),
    btnW1ZoomReset: document.getElementById("btnW1ZoomReset"),
    chkSyncChannels: document.getElementById("chkSyncChannels"),
    chkShowFiducialsMulti: document.getElementById("chkShowFiducialsMulti"),
    btnQuickAddR: document.getElementById("btnQuickAddR"),
    btnDeleteActiveR: document.getElementById("btnDeleteActiveR"),
    btnArtifactRR: document.getElementById("btnArtifactRR"),
    btnArtifactRToEnd: document.getElementById("btnArtifactRToEnd"),
    btnArtifactStartToR: document.getElementById("btnArtifactStartToR"),
    btnClearArtifacts: document.getElementById("btnClearArtifacts"),
    lblRAndArtifactStatus: document.getElementById("lblRAndArtifactStatus"),
    imgTraceOverlay: document.getElementById("imgTraceOverlay"),
    traceOverlayCanvas: document.getElementById("traceOverlayCanvas"),
    overlayStageWrap: document.getElementById("overlayStageWrap"),
    overlayScrollBox: document.getElementById("overlayScrollBox"),
    selectOverlayZoom: document.getElementById("selectOverlayZoom"),
    btnOverlayZoomOut: document.getElementById("btnOverlayZoomOut"),
    btnOverlayZoomIn: document.getElementById("btnOverlayZoomIn"),
    selectOverlayTraceIdx: document.getElementById("selectOverlayTraceIdx"),
    selectOverlayLeadRename: document.getElementById("selectOverlayLeadRename"),
    btnApplyLeadRename: document.getElementById("btnApplyLeadRename"),
    btnAutoRetraceLead: document.getElementById("btnAutoRetraceLead"),
    btnResetOverlayTrace: document.getElementById("btnResetOverlayTrace"),
    overlayEditStatus: document.getElementById("overlayEditStatus"),
    imgAligned: document.getElementById("imgAligned"),
    imgHeatmap: document.getElementById("imgHeatmap"),
    calGridCanvas: document.getElementById("calGridCanvas"),
    calStageWrap: document.getElementById("calStageWrap"),
    calScrollBox: document.getElementById("calScrollBox"),
    selectCalZoom: document.getElementById("selectCalZoom"),
    selectCalRefMm: document.getElementById("selectCalRefMm"),
    btnCalMinus: document.getElementById("btnCalMinus"),
    btnCalPlus: document.getElementById("btnCalPlus"),
    chkShowCalGrid: document.getElementById("chkShowCalGrid"),
    chkShowCalMinorGrid: document.getElementById("chkShowCalMinorGrid"),
    calRulerStatus: document.getElementById("calRulerStatus"),
    inputPxPerMm: document.getElementById("inputPxPerMm"),
    btnApplyManualCal: document.getElementById("btnApplyManualCal"),
    btnResetManualCal: document.getElementById("btnResetManualCal"),
    selectGridColorMode: document.getElementById("selectGridColorMode"),
    btnDetectGridCrosses: document.getElementById("btnDetectGridCrosses"),
    btnRectifyByCrosses: document.getElementById("btnRectifyByCrosses"),
    btnCleanGridArtifacts: document.getElementById("btnCleanGridArtifacts"),
    btnResetGridRectify: document.getElementById("btnResetGridRectify"),
    btnGridNodesZoomOut: document.getElementById("btnGridNodesZoomOut"),
    selectGridNodesZoom: document.getElementById("selectGridNodesZoom"),
    btnGridNodesZoomIn: document.getElementById("btnGridNodesZoomIn"),
    chkShowGridCrosses: document.getElementById("chkShowGridCrosses"),
    chkShowWarpMesh: document.getElementById("chkShowWarpMesh"),
    chkShowWarpVectors: document.getElementById("chkShowWarpVectors"),
    gridNodesStatus: document.getElementById("gridNodesStatus"),
    gridNodesScrollBox: document.getElementById("gridNodesScrollBox"),
    gridNodesStageWrap: document.getElementById("gridNodesStageWrap"),
    imgGridNodesBase: document.getElementById("imgGridNodesBase"),
    gridNodesCanvas: document.getElementById("gridNodesCanvas"),
    leadPillsContainer: document.getElementById("leadPillsContainer"),
    selectBeat: document.getElementById("selectBeat"),
    selectZoomX: document.getElementById("selectZoomX"),
    selectZoomY: document.getElementById("selectZoomY"),
    btnAutoResetCalipers: document.getElementById("btnAutoResetCalipers"),
    caliperCanvas: document.getElementById("caliperCanvas"),
    caliperReadoutStrip: document.getElementById("caliperReadoutStrip"),
    freeCaliperBanner: document.getElementById("freeCaliperBanner"),
    freeDeltaT: document.getElementById("freeDeltaT"),
    freeEqBpm: document.getElementById("freeEqBpm"),
    freeDeltaV: document.getElementById("freeDeltaV"),
    freeSlope: document.getElementById("freeSlope"),
    lblActiveLead: document.getElementById("lblActiveLead"),
    tbodyIntervals: document.getElementById("tbodyIntervals"),
    qtcFormulaGrid: document.getElementById("qtcFormulaGrid"),
    ampBadgesGrid: document.getElementById("ampBadgesGrid"),
    clinicalFlagsBox: document.getElementById("clinicalFlagsBox"),
    hexaxialCanvas: document.getElementById("hexaxialCanvas"),
    valQrsAxis: document.getElementById("valQrsAxis"),
    valPAxis: document.getElementById("valPAxis"),
    valTAxis: document.getElementById("valTAxis"),
    valQrsTAngle: document.getElementById("valQrsTAngle"),
    valAxisClass: document.getElementById("valAxisClass"),
    valSokolow: document.getElementById("valSokolow"),
    valCornell: document.getElementById("valCornell"),
    selectPatientSex: document.getElementById("selectPatientSex"),
    calPulseActions: document.getElementById("calPulseActions"),
    calPulseText: document.getElementById("calPulseText"),
    btnApplyPulseGain: document.getElementById("btnApplyPulseGain"),
    valMacruz: document.getElementById("valMacruz"),
    vcgCanvas: document.getElementById("vcgCanvas"),
    chkVcgVectors: document.getElementById("chkVcgVectors"),
    chkVcgArrows: document.getElementById("chkVcgArrows"),
    vcgMethodLbl: document.getElementById("vcgMethodLbl"),
    vcgMaxQrs: document.getElementById("vcgMaxQrs"),
    vcgMaxT: document.getElementById("vcgMaxT"),
    vcgSpatialAngle: document.getElementById("vcgSpatialAngle"),
    vcgSvgVal: document.getElementById("vcgSvgVal"),
    vcgRotationLbl: document.getElementById("vcgRotationLbl"),
    tbodyAllLeads: document.getElementById("tbodyAllLeads"),
    btnExportCsv: document.getElementById("btnExportCsv"),
    btnExportJson: document.getElementById("btnExportJson"),
    btnPrintReport: document.getElementById("btnPrintReport"),
  };

  // Initialize application
  const STATIC_CONFIG = {
    examples: [
      { filename: "photo_2026-11-19_00-34-51.jpg", url: "/examples/photo_2026-11-19_00-34-51.jpg", title: "Кардио++ (12×1 вертикальная, 50 мм/с)", speed_mm_s: 50.0, gain_mm_mv: 10.0, layout_hint: "12x1", description: "Фото листа А4 в руке, 12 отведений (I–V6), 50 мм/с, 10 мм/мВ, ЧСС 90" },
      { filename: "photo_2026-11-19_00-35-31.jpg", url: "/examples/photo_2026-11-19_00-35-31.jpg", title: "MEGACART 3 (3×4 + полоса ритма II, 25 мм/с)", speed_mm_s: 25.0, gain_mm_mv: 10.0, layout_hint: "3x4_r1", description: "Сложенный бланк ЭКГ, 3×4 + ритм II, 25 мм/с, синусовая брадикардия (ЧСС 59)" },
      { filename: "photo_2026-11-19_00-35-36.jpg", url: "/examples/photo_2026-11-19_00-35-36.jpg", title: "Скан 12 отведений (6×2 + полоса ритма II, 25 мм/с)", speed_mm_s: 25.0, gain_mm_mv: 10.0, layout_hint: "6x2_r1", description: "Чистый цифровой скан 6×2 (I–aVF слева, V1–V6 справа) + ритм II внизу, 25 мм/с" },
      { filename: "photo_2026-11-19_00-35-40.jpg", url: "/examples/photo_2026-11-19_00-35-40.jpg", title: "UTAS Грудные отведения V1–V6 (6×1 лента, 25 мм/с)", speed_mm_s: 25.0, gain_mm_mv: 10.0, layout_hint: "6x1_precordial", description: "Термолента на столе, грудные отведения V1–V6 с высокой амплитудой QRS, 25 мм/с" },
      { filename: "photo_2026-11-19_00-35-47.jpg", url: "/examples/photo_2026-11-19_00-35-47.jpg", title: "UTAS Отведения от конечностей I–aVF (6×1 лента, 25 мм/с)", speed_mm_s: 25.0, gain_mm_mv: 10.0, layout_hint: "6x1_limb", description: "Термолента на столе, отведения I, II, III, aVR, aVL, aVF, 25 мм/с, ЧСС 58" },
      { filename: "photo_2026-11-19_00-35-51.jpg", url: "/examples/photo_2026-11-19_00-35-51.jpg", title: "UTAS Усредненный QRS (6×2 лента, 50 мм/с)", speed_mm_s: 50.0, gain_mm_mv: 10.0, layout_hint: "6x2", description: "Термолента с усредненными комплексами P-QRS-T всех 12 отведений (6×2), 50 мм/с" },
      { filename: "photo_2026-11-19_00-37-16.jpg", url: "/examples/photo_2026-11-19_00-37-16.jpg", title: "Скан 12×1 (50 мм/с, дрейф изолинии в V5)", speed_mm_s: 50.0, gain_mm_mv: 10.0, layout_hint: "12x1", description: "Полная 12-канальная развертка I–V6, скорость 50 мм/сек, выраженный дрейф в V5" },
      { filename: "photo_2026-11-19_00-37-21.jpg", url: "/examples/photo_2026-11-19_00-37-21.jpg", title: "CardioBox (3×4 + 2 полосы ритма I и II, 25 мм/с)", speed_mm_s: 25.0, gain_mm_mv: 10.0, layout_hint: "3x4_r2", description: "Скриншот интерфейса CardioBox: 3×4 + ритм I и II, 25 мм/с, ЧСС 73" },
    ],
    methods: [
      { id: "hybrid_ensemble", name: "Hybrid Ensemble (Open-ECG U-Net + Krones Hough + Viterbi DP)", description: "Ансамбль U-Net + Hough + Viterbi DP (на статическом хостинге используется браузерный CV-движок)." },
      { id: "open_ecg_unet", name: "Open-ECG-Digitizer (Ahus-AIM 4-class U-Net + LeadName U-Net)", description: "Нейросетевая сегментация Open-ECG-Digitizer." },
      { id: "dangnh_heatmap_dp", name: "Kaggle 5th Place Heatmap + Viterbi DP (dangnh0611)", description: "Тепловая карта высокой чёткости + алгоритм Витерби." },
      { id: "krones_hough_cv", name: "ECG-Digitiser Classical Hough + Color Decoupling (Felix Krones)", description: "Цветовое разделение сетки и чернил + трассировка." },
    ],
    layouts: [
      { id: "auto", label: "Автоопределение схемы" },
      { id: "12x1", label: "12×1 Стандарт (12 отведений вертикально)" },
      { id: "3x4_r1", label: "3×4 + 1 полоса ритма II" },
      { id: "3x4_r2", label: "3×4 + 2 полосы ритма (I, II)" },
      { id: "3x4", label: "3×4 Стандарт (4 столбца по 3 отведения)" },
      { id: "6x2", label: "6×2 Стандарт (I–aVF слева, V1–V6 справа)" },
      { id: "6x2_r1", label: "6×2 + 1 полоса ритма II" },
      { id: "6x1_precordial", label: "6×1 Грудные (V1–V6)" },
      { id: "6x1_limb", label: "6×1 От конечностей (I–aVF)" },
    ],
  };

  async function init() {
    bindUIEvents();
    try {
      setStatus("Загрузка конфигурации...", "busy");
      let cfg = null;
      try {
        const res = await fetch("/api/config");
        if (res.ok) {
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            cfg = await res.json();
          }
        }
      } catch (_) {
        cfg = null;
      }

      if (!cfg) {
        state.staticMode = true;
        cfg = STATIC_CONFIG;
      } else {
        state.staticMode = false;
      }

      state.config = cfg;
      populateSelectors(cfg);

      if (cfg.examples && cfg.examples.length > 0) {
        el.selectExample.value = cfg.examples[0].filename;
        applyExamplePreset(cfg.examples[0]);
        await runDigitization();
      } else {
        setStatus("Готов к загрузке фото", "ready");
      }
    } catch (err) {
      console.error("Init error:", err);
      setStatus("Ошибка инициализации", "error");
    }
  }

  function populateSelectors(cfg) {
    // Examples
    el.selectExample.innerHTML = "";
    cfg.examples.forEach((ex) => {
      const opt = document.createElement("option");
      opt.value = ex.filename;
      opt.textContent = ex.title;
      el.selectExample.appendChild(opt);
    });

    // Methods
    el.selectMethod.innerHTML = "";
    cfg.methods.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.unavailable ? `${m.name} — недоступно` : m.name;
      opt.disabled = !!m.unavailable;
      el.selectMethod.appendChild(opt);
    });
    // Without PyTorch / U-Net weights the backend only runs the classical pipeline: pre-select it
    const firstAvail = cfg.methods.find((m) => !m.unavailable);
    if (firstAvail) el.selectMethod.value = firstAvail.id;

    // Layouts
    el.selectLayout.innerHTML = "";
    cfg.layouts.forEach((ly) => {
      const opt = document.createElement("option");
      opt.value = ly.id;
      opt.textContent = ly.label;
      el.selectLayout.appendChild(opt);
    });
  }

  function applyExamplePreset(ex) {
    if (!ex) return;
    el.exampleDescription.textContent = ex.description || ex.title;
    if (ex.speed_mm_s) {
      el.selectSpeed.value = String(Math.round(ex.speed_mm_s));
    }
    if (ex.gain_mm_mv) {
      el.selectGain.value = String(Math.round(ex.gain_mm_mv));
    }
    if (ex.layout_hint) {
      el.selectLayout.value = ex.layout_hint;
    }
  }

  function setStatus(text, mode = "ready") {
    el.statusBadge.textContent = text;
    if (mode === "busy") {
      el.statusBadge.style.background = "#FEF7E0";
      el.statusBadge.style.color = "#B06000";
    } else if (mode === "error") {
      el.statusBadge.style.background = "#FCE8E6";
      el.statusBadge.style.color = "#C5221F";
    } else {
      el.statusBadge.style.background = "#E6F4EA";
      el.statusBadge.style.color = "#137333";
    }
  }

  // Client-side Canvas CV ECG Digitizer & Analyzer (for static Firebase Hosting without Python backend)
  async function runClientSideDigitization(customPxPerMm = null) {
    const t0 = performance.now();
    const speedMmS = parseFloat(el.selectSpeed.value) || 25.0;
    const gainMmMv = parseFloat(el.selectGain.value) || 10.0;
    const layoutSel = el.selectLayout.value || "auto";
    const rotateDeg = parseInt(el.selectRotate.value || "0", 10) || 0;
    const fs = 500;

    let imgUrl = "";
    let sourceName = el.selectExample.value || "photo.jpg";
    if (state.uploadedFile) {
      sourceName = state.uploadedFile.name;
      imgUrl = URL.createObjectURL(state.uploadedFile);
    } else {
      const ex = (state.config && state.config.examples || []).find((e) => e.filename === sourceName);
      imgUrl = (ex && ex.url) || `/examples/${sourceName}`;
    }

    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`Не удалось загрузить изображение ${sourceName}`));
      im.src = imgUrl;
    });

    // Resize to max 1200px for fast client-side CV processing
    const maxDim = 1200;
    let w = img.naturalWidth || 1000;
    let h = img.naturalHeight || 700;
    const scale = Math.min(1.0, maxDim / Math.max(w, h));
    w = Math.max(120, Math.round(w * scale));
    h = Math.max(120, Math.round(h * scale));

    const off = document.createElement("canvas");
    if (rotateDeg === 90 || rotateDeg === 270) {
      off.width = h;
      off.height = w;
    } else {
      off.width = w;
      off.height = h;
    }
    const octx = off.getContext("2d");
    octx.save();
    if (rotateDeg === 90) {
      octx.translate(h, 0);
      octx.rotate(Math.PI / 2);
    } else if (rotateDeg === 180) {
      octx.translate(w, h);
      octx.rotate(Math.PI);
    } else if (rotateDeg === 270) {
      octx.translate(0, w);
      octx.rotate(-Math.PI / 2);
    }
    octx.drawImage(img, 0, 0, w, h);
    octx.restore();

    const W = off.width;
    const H = off.height;
    const imgData = octx.getImageData(0, 0, W, H);
    const px = imgData.data;

    // Extract dark-ink probability map (ECG traces are dark neutral ink; paper grid is pinkish/red/light)
    const inkMap = new Float32Array(W * H);
    const gridMap = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const r = px[i * 4];
      const g = px[i * 4 + 1];
      const b = px[i * 4 + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      // Dark neutral trace
      const darkness = Math.max(0, (175 - lum) / 145.0);
      const neutralBonus = sat < 45 ? 1.0 : Math.max(0.15, 1.0 - (sat - 45) / 80.0);
      inkMap[i] = Math.min(1.0, darkness * neutralBonus);
      // Red/pink grid
      gridMap[i] = r > g + 12 && r > b + 10 ? Math.min(1.0, (r - 0.5 * (g + b)) / 90.0) : 0.0;
    }

    const LAYOUT_GRID = {
      "12x1": { label: "12×1 Стандарт (12 отведений вертикально)", cols: 1, grid: [["I"],["II"],["III"],["aVR"],["aVL"],["aVF"],["V1"],["V2"],["V3"],["V4"],["V5"],["V6"]], rhythm: [] },
      "3x4_r1": { label: "3×4 + 1 полоса ритма II", cols: 4, grid: [["I","aVR","V1","V4"],["II","aVL","V2","V5"],["III","aVF","V3","V6"]], rhythm: ["II (ритм)"] },
      "3x4_r2": { label: "3×4 + 2 полосы ритма (I, II)", cols: 4, grid: [["I","aVR","V1","V4"],["II","aVL","V2","V5"],["III","aVF","V3","V6"]], rhythm: ["I (ритм)","II (ритм)"] },
      "3x4": { label: "3×4 Стандарт", cols: 4, grid: [["I","aVR","V1","V4"],["II","aVL","V2","V5"],["III","aVF","V3","V6"]], rhythm: [] },
      "6x2": { label: "6×2 Стандарт (I–aVF слева, V1–V6 справа)", cols: 2, grid: [["I","V1"],["II","V2"],["III","V3"],["aVR","V4"],["aVL","V5"],["aVF","V6"]], rhythm: [] },
      "6x2_r1": { label: "6×2 + 1 полоса ритма II", cols: 2, grid: [["I","V1"],["II","V2"],["III","V3"],["aVR","V4"],["aVL","V5"],["aVF","V6"]], rhythm: ["II (ритм)"] },
      "6x1_precordial": { label: "6×1 Грудные (V1–V6)", cols: 1, grid: [["V1"],["V2"],["V3"],["V4"],["V5"],["V6"]], rhythm: [] },
      "6x1_limb": { label: "6×1 От конечностей (I–aVF)", cols: 1, grid: [["I"],["II"],["III"],["aVR"],["aVL"],["aVF"]], rhythm: [] },
    };

    const chosenLayout = LAYOUT_GRID[layoutSel] ? layoutSel : "12x1";
    const staticWarnings = [
      "Статический режим (без Python-сервера): упрощённая браузерная оцифровка; границы P/QRS/T — шаблон от R, проверьте калиперы вручную",
    ];
    if (!LAYOUT_GRID[layoutSel]) {
      staticWarnings.push(`Автоопределение раскладки недоступно в браузере — использована ${chosenLayout}; выберите раскладку вручную`);
    }
    const lay = LAYOUT_GRID[chosenLayout];
    const nRows = lay.grid.length + lay.rhythm.length;
    const pxPerMm = customPxPerMm && customPxPerMm > 0.5 ? customPxPerMm : Math.max(3.2, Math.min(10.0, W / 210.0));

    // Detect row baselines via horizontal ink projection
    const rowProj = new Float32Array(H);
    const xA = Math.round(0.08 * W);
    const xB = Math.round(0.95 * W);
    for (let y = Math.round(0.04 * H); y < Math.round(0.96 * H); y++) {
      let s = 0;
      for (let x = xA; x < xB; x += 2) {
        if (inkMap[y * W + x] > 0.25) s += inkMap[y * W + x];
      }
      rowProj[y] = s;
    }

    const baselines = [];
    const stepRow = (H * 0.86) / Math.max(1, nRows);
    for (let r = 0; r < nRows; r++) {
      const yCenterExp = Math.round(H * 0.08 + (r + 0.5) * stepRow);
      const yLo = Math.max(4, Math.round(yCenterExp - stepRow * 0.38));
      const yHi = Math.min(H - 5, Math.round(yCenterExp + stepRow * 0.38));
      let bestY = yCenterExp;
      let bestVal = -1;
      for (let y = yLo; y <= yHi; y++) {
        if (rowProj[y] > bestVal) {
          bestVal = rowProj[y];
          bestY = y;
        }
      }
      baselines.push(bestY);
    }

    const leadsMv = {};
    const overlayTraces = [];
    const palette = ["#00E676", "#00B0FF", "#FF4081", "#FFD740", "#7C4DFF", "#00E5FF"];
    const mainRows = lay.grid.length;
    const spacing = baselines.length > 1 ? (baselines[baselines.length - 1] - baselines[0]) / (baselines.length - 1) : H * 0.4;

    const extractStrip = (leadName, cx0, cx1, baseY) => {
      const lenPx = Math.max(10, cx1 - cx0);
      const halfSearch = Math.max(12, Math.round(spacing * 0.65));
      const y0 = Math.max(2, baseY - halfSearch);
      const y1 = Math.min(H - 3, baseY + halfSearch);
      const traceY = new Float64Array(lenPx);
      let prevY = baseY;
      for (let xi = 0; xi < lenPx; xi++) {
        const x = cx0 + xi;
        let num = 0;
        let den = 0;
        let bestScore = -1e9;
        let bestY = prevY;
        for (let y = y0; y <= y1; y++) {
          const val = inkMap[y * W + x];
          if (val > 0.20) {
            const score = val - 0.015 * Math.abs(y - prevY) - 0.004 * Math.abs(y - baseY);
            if (score > bestScore) {
              bestScore = score;
              bestY = y;
            }
          }
        }
        if (bestScore > 0.12) {
          for (let y = Math.max(y0, bestY - 3); y <= Math.min(y1, bestY + 3); y++) {
            const val = inkMap[y * W + x];
            if (val > 0.18) {
              num += y * val;
              den += val;
            }
          }
          prevY = den > 0 ? num / den : bestY;
        } else {
          prevY = 0.85 * prevY + 0.15 * baseY;
        }
        traceY[xi] = prevY;
      }

      const widthMm = lenPx / Math.max(0.5, pxPerMm);
      const durSec = Math.max(0.2, Math.min(60.0, widthMm / Math.max(5.0, speedMmS)));
      const nSamples = Math.max(120, Math.round(durSec * fs));
      const mvRaw = new Float64Array(lenPx);
      for (let i = 0; i < lenPx; i++) {
        mvRaw[i] = (baseY - traceY[i]) / Math.max(0.5, pxPerMm * gainMmMv);
      }
      const sortedMv = Array.from(mvRaw).sort((a, b) => a - b);
      const medMv = sortedMv[Math.floor(sortedMv.length / 2)] || 0;
      const mvOut = new Array(nSamples);
      for (let i = 0; i < nSamples; i++) {
        const pos = (i / Math.max(1, nSamples - 1)) * (lenPx - 1);
        const i0 = Math.floor(pos);
        const i1 = Math.min(lenPx - 1, i0 + 1);
        const f = pos - i0;
        mvOut[i] = Number(((mvRaw[i0] * (1 - f) + mvRaw[i1] * f) - medMv).toFixed(4));
      }
      leadsMv[leadName] = mvOut;

      const pts = [];
      const stepOv = Math.max(1, Math.floor(lenPx / 280));
      for (let xi = 0; xi < lenPx; xi += stepOv) {
        pts.push([cx0 + xi, Number(traceY[xi].toFixed(1))]);
      }
      overlayTraces.push({ lead: leadName, baseline_y_px: baseY, points_px: pts });
    };

    const colW = Math.floor((W * 0.86) / lay.cols);
    const xStart = Math.round(W * 0.09);
    for (let r = 0; r < mainRows; r++) {
      for (let c = 0; c < lay.cols; c++) {
        const ln = lay.grid[r][c];
        const cx0 = xStart + c * colW + (c > 0 ? 12 : 0);
        const cx1 = Math.min(W - 8, xStart + (c + 1) * colW - 8);
        extractStrip(ln, cx0, cx1, baselines[r]);
      }
    }
    for (let rr = 0; rr < lay.rhythm.length; rr++) {
      const rIdx = mainRows + rr;
      if (rIdx < baselines.length) {
        extractStrip(lay.rhythm[rr], xStart, Math.round(W * 0.96), baselines[rIdx]);
      }
    }

    // Build aligned_image, trace_overlay_image, segmentation_heatmap data URLs
    const alignedUrl = off.toDataURL("image/jpeg", 0.88);
    const ovCanvas = document.createElement("canvas");
    ovCanvas.width = W;
    ovCanvas.height = H;
    const ovCtx = ovCanvas.getContext("2d");
    ovCtx.drawImage(off, 0, 0);
    overlayTraces.forEach((tr, idx) => {
      if (tr.points_px.length < 2) return;
      ovCtx.strokeStyle = palette[idx % palette.length];
      ovCtx.lineWidth = 2;
      ovCtx.beginPath();
      tr.points_px.forEach((p, i) => (i === 0 ? ovCtx.moveTo(p[0], p[1]) : ovCtx.lineTo(p[0], p[1])));
      ovCtx.stroke();
    });
    const overlayUrl = ovCanvas.toDataURL("image/jpeg", 0.88);

    const heatCanvas = document.createElement("canvas");
    heatCanvas.width = W;
    heatCanvas.height = H;
    const hCtx = heatCanvas.getContext("2d");
    const hImg = hCtx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      hImg.data[i * 4] = Math.round(gridMap[i] * 210);
      hImg.data[i * 4 + 1] = Math.round(inkMap[i] * 255);
      hImg.data[i * 4 + 2] = Math.round(inkMap[i] * 220 + gridMap[i] * 45);
      hImg.data[i * 4 + 3] = 255;
    }
    hCtx.putImageData(hImg, 0, 0);
    const heatUrl = heatCanvas.toDataURL("image/jpeg", 0.82);

    // Client-side beat analyzer (metrics, axes and LVH indices are computed after state is populated,
    // see recomputeAllLeadMetricsClient() in runDigitization)
    const analysisLeads = {};
    const primaryLead = leadsMv["II"] ? "II" : Object.keys(leadsMv)[0];
    Object.keys(leadsMv).forEach((ln) => {
      analysisLeads[ln] = analyzeLeadClientSide(leadsMv[ln], fs);
    });

    const elapsedSec = Number(((performance.now() - t0) / 1000.0).toFixed(2));
    return {
      source_name: sourceName,
      digitization: {
        method: "client_cv_static",
        warnings: staticWarnings,
        layout: chosenLayout,
        layout_label: lay.label + " (Static Web)",
        paper_speed_mm_s: speedMmS,
        gain_mm_mv: gainMmMv,
        sampling_rate_hz: fs,
        pixel_spacing: { px_per_mm: Number(pxPerMm.toFixed(2)), px_per_mm_x: pxPerMm, px_per_mm_y: pxPerMm },
        alignment: { skew_angle_deg: 0, aligned_size: [W, H] },
        leads_mv: leadsMv,
        overlay_traces: overlayTraces,
        visualizations: { aligned_image: alignedUrl, trace_overlay_image: overlayUrl, segmentation_heatmap: heatUrl },
        elapsed_sec: elapsedSec,
      },
      analysis: {
        primary_lead: primaryLead,
        global_rr_ms: analysisLeads[primaryLead] ? analysisLeads[primaryLead].hrv.median_rr_ms : 800,
        global_hr_bpm: analysisLeads[primaryLead] ? Math.round(60000.0 / Math.max(250, analysisLeads[primaryLead].hrv.median_rr_ms)) : 75,
        axes: {},
        hypertrophy: {},
        leads: analysisLeads,
      },
    };
  }

  async function runDigitization(customPxPerMm = null) {
    const runId = ++state.digitizeRunId;
    try {
      el.btnDigitize.disabled = true;
      el.btnDigitizeText.textContent = state.staticMode ? "Оцифровка (Web CV)..." : "Оцифровка U-Net...";
      setStatus(state.staticMode ? "Выполняется оцифровка фото в браузере..." : "Выполняется нейросетевая сегментация и трассировка...", "busy");

      let data = null;
      if (state.staticMode) {
        data = await runClientSideDigitization(customPxPerMm);
      } else {
        const formData = new FormData();
        if (state.uploadedFile) {
          formData.append("file", state.uploadedFile);
          if (state.uploadedPdfPage) {
            formData.append("pdf_page", String(state.uploadedPdfPage));
          }
        } else {
          formData.append("example_name", el.selectExample.value);
        }
        formData.append("method", el.selectMethod.value || "hybrid_ensemble");
        formData.append("layout", el.selectLayout.value || "auto");
        formData.append("paper_speed_mm_s", el.selectSpeed.value || "25");
        formData.append("gain_mm_mv", el.selectGain.value || "10");
        formData.append("target_fs", "500");
        formData.append("rotate_deg", el.selectRotate.value || "0");
        if (el.selectPatientSex && el.selectPatientSex.value) {
          formData.append("patient_sex", el.selectPatientSex.value);
        }
        if (customPxPerMm && customPxPerMm > 0.5) {
          formData.append("custom_px_per_mm", String(customPxPerMm));
        }

        const res = await fetch("/api/digitize", {
          method: "POST",
          body: formData,
        });

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          throw new Error(errData.detail || `HTTP ${res.status}`);
        }
        data = await res.json();
      }
      // A newer digitization (another example / page / upload) was started meanwhile: drop this stale result
      if (runId !== state.digitizeRunId) return;
      state.currentSource = data.source_name;
      state.digitization = data.digitization;
      state.analysis = data.analysis;
      state.artifactsByLead = {};
      state.originalBeatsByLead = {};
      if (state.staticMode) {
        // No backend: measure every lead on its own signal, then derive axes / Sokolow / Cornell
        recomputeAllLeadMetricsClient(false);
      }
      if (state.analysis && state.analysis.leads) {
        Object.keys(state.analysis.leads).forEach((ln) => {
          state.artifactsByLead[ln] = [];
          state.originalBeatsByLead[ln] = JSON.parse(JSON.stringify(state.analysis.leads[ln]));
        });
      }

      // Enable exports
      el.btnExportCsv.disabled = false;
      el.btnExportJson.disabled = false;
      el.btnPrintReport.disabled = false;

      // Populate visual verification images (use clean aligned_image for interactive vector overlay)
      const vis = state.digitization.visualizations || {};
      state.originalOverlayTraces = JSON.parse(JSON.stringify(state.digitization.overlay_traces || []));
      state.originalTraceQuality = state.originalOverlayTraces.map((tr) =>
        state.digitization.lead_quality && state.digitization.lead_quality[tr.lead]
          ? JSON.parse(JSON.stringify(state.digitization.lead_quality[tr.lead]))
          : null
      );
      state.overlayInkMap = null;
      state.selectedTraceIdx = 0;

      if (vis.aligned_image || vis.trace_overlay_image) {
        el.imgTraceOverlay.onload = () => {
          state.overlayInkMap = null;
          renderTraceOverlayCanvas();
        };
        el.imgTraceOverlay.src = vis.aligned_image || vis.trace_overlay_image;
      }
      if (vis.aligned_image) {
        state.originalAlignedDataUrl = vis.aligned_image;
        state.gridNodesResult = null;
        el.imgAligned.onload = () => {
          renderPhotoCalibrationCanvas();
        };
        el.imgAligned.src = vis.aligned_image;

        if (el.imgGridNodesBase) {
          el.imgGridNodesBase.onload = () => {
            detectGridIntersectionsAndDeformation();
          };
          el.imgGridNodesBase.src = vis.aligned_image;
        }
      }
      if (vis.segmentation_heatmap) el.imgHeatmap.src = vis.segmentation_heatmap;

      populateOverlayTraceDropdown();

      const sp = state.digitization.pixel_spacing || {};
      const detPxPerMm = sp.px_per_mm || 5.5;
      if (!customPxPerMm) {
        state.autoPxPerMm = detPxPerMm;
      }
      state.activePxPerMm = detPxPerMm;
      // Pristine per-lead signals at the px/mm they were digitized with: manual re-calibration always
      // resamples from these (no cumulative interpolation drift after repeated +/- clicks)
      state.calibBase = {};
      Object.keys(state.digitization.leads_mv || {}).forEach((ln) => {
        state.calibBase[ln] = { sig: state.digitization.leads_mv[ln].slice(), pxPerMm: detPxPerMm };
      });
      state.calRulerA = null;
      state.calRulerB = null;
      state.calRulerHover = null;
      el.inputPxPerMm.value = detPxPerMm.toFixed(2);
      updateDigitizationMetaBanner();
      renderCalPulseActions();
      setTimeout(() => {
        renderPhotoCalibrationCanvas();
        renderTraceOverlayCanvas();
      }, 60);

      // Select primary lead and initialize calipers
      const availLeads = Object.keys(state.digitization.leads_mv || {});
      state.activeLead = state.analysis.primary_lead && availLeads.includes(state.analysis.primary_lead)
        ? state.analysis.primary_lead
        : (availLeads[0] || "II");

      buildLeadPills(availLeads);
      selectLead(state.activeLead);
      renderMultiLeadCanvas();
      renderHexaxialCompass();
      renderAllLeadsTable();

      const warns = state.digitization.warnings || [];
      if (warns.length > 0) {
        setStatus(`Оцифровано с предупреждениями (${availLeads.length} отв.): ${warns[0]}`, "busy");
      } else {
        setStatus(`Оцифровано (${availLeads.length} отв., ${state.digitization.elapsed_sec} с)`, "ready");
      }
    } catch (err) {
      if (runId !== state.digitizeRunId) return;
      console.error("Digitization failed:", err);
      setStatus(`Ошибка: ${err.message}`, "error");
    } finally {
      if (runId === state.digitizeRunId) {
        el.btnDigitize.disabled = false;
        el.btnDigitizeText.textContent = "Оцифровать ЭКГ";
      }
    }
  }

  function updateDigitizationMetaBanner() {
    if (!state.digitization) return;
    const sp = state.digitization.pixel_spacing || {};
    const pxMm = sp.px_per_mm || state.activePxPerMm || 5.5;
    const skew = (state.digitization.alignment && state.digitization.alignment.skew_angle_deg) || 0;
    el.digitizationMetaLine.textContent =
      `Источник: ${state.currentSource || "—"} • Раскладка: ${state.digitization.layout_label} • ` +
      `Калибровка сетки: ${pxMm.toFixed(2)} пикс/мм (1 клетка 5мм = ${(pxMm * 5).toFixed(1)} пикс, угол ${skew}°) • ` +
      `Скорость: ${state.digitization.paper_speed_mm_s} мм/с • Время: ${state.digitization.elapsed_sec} с` +
      calPulseSummary() +
      ((state.digitization.warnings || []).length ? ` • ⚠ ${state.digitization.warnings.join(" • ⚠ ")}` : "");
  }

  function calPulseSummary() {
    const cp = state.digitization && state.digitization.calibration_pulse;
    if (!cp) return "";
    if (cp.status === "not_found") return " • Импульс 1 мВ: не найден";
    const n = cp.consistent_count || cp.count;
    return ` • Импульс 1 мВ: ${cp.height_mm.toFixed(1)} мм (${n} шт.) ${cp.status === "ok" ? "✓ усиление подтверждено" : "≠ заданному усилению"}`;
  }

  // Interactive Photo & Grid Calibration Overlay Renderer (#calGridCanvas over #imgAligned)
  function renderPhotoCalibrationCanvas() {
    const img = el.imgAligned;
    const canvas = el.calGridCanvas;
    if (!img || !canvas) return;

    const natW = img.naturalWidth || 1000;
    const natH = img.naturalHeight || 700;
    if (el.calStageWrap && el.calScrollBox) {
      const boxW = Math.max(320, (el.calScrollBox.clientWidth || 600) - 20);
      const targetW = Math.round(boxW * (state.calZoom || 1.0));
      el.calStageWrap.style.width = `${targetW}px`;
    }
    const rect = img.getBoundingClientRect();
    const dispW = rect.width > 20 ? rect.width : img.clientWidth || natW;
    const dispH = rect.height > 20 ? rect.height : img.clientHeight || natH;
    if (dispW < 10 || dispH < 10) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(dispW * dpr);
    canvas.height = Math.round(dispH * dpr);

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, dispW, dispH);

    const scaleX = dispW / natW;
    const scaleY = dispH / natH;

    const inputVal = parseFloat(el.inputPxPerMm && el.inputPxPerMm.value);
    const pxPerMm = inputVal && inputVal > 0.5 ? inputVal : state.activePxPerMm || 5.5;

    const step1mmX = pxPerMm * scaleX;
    const step1mmY = pxPerMm * scaleY;
    const step5mmX = 5.0 * step1mmX;
    const step5mmY = 5.0 * step1mmY;

    const origX = ((state.calGridOrigin.x * scaleX) % step5mmX + step5mmX) % step5mmX;
    const origY = ((state.calGridOrigin.y * scaleY) % step5mmY + step5mmY) % step5mmY;

    const showMajor = !el.chkShowCalGrid || el.chkShowCalGrid.checked;
    const showMinor = !el.chkShowCalMinorGrid || el.chkShowCalMinorGrid.checked;

    // 1. Draw 1x1 mm minor calibration grid
    if (showMinor && step1mmX >= 2.2 && step1mmY >= 2.2) {
      const orig1X = ((state.calGridOrigin.x * scaleX) % step1mmX + step1mmX) % step1mmX;
      const orig1Y = ((state.calGridOrigin.y * scaleY) % step1mmY + step1mmY) % step1mmY;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(0, 210, 255, 0.25)";
      ctx.lineWidth = 0.7;
      for (let x = orig1X; x <= dispW; x += step1mmX) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, dispH);
      }
      for (let y = orig1Y; y <= dispH; y += step1mmY) {
        ctx.moveTo(0, y);
        ctx.lineTo(dispW, y);
      }
      ctx.stroke();
    }

    // 2. Draw 5x5 mm major calibration grid (large ECG squares)
    if (showMajor && step5mmX >= 6.0 && step5mmY >= 6.0) {
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255, 145, 0, 0.72)";
      ctx.lineWidth = 1.25;
      for (let x = origX; x <= dispW; x += step5mmX) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, dispH);
      }
      for (let y = origY; y <= dispH; y += step5mmY) {
        ctx.moveTo(0, y);
        ctx.lineTo(dispW, y);
      }
      ctx.stroke();

      // Highlight every 5th large square (25 mm = 1 sec at 25 mm/s)
      const step25mmX = 5.0 * step5mmX;
      const step25mmY = 5.0 * step5mmY;
      ctx.beginPath();
      ctx.strokeStyle = "rgba(255, 215, 0, 0.88)";
      ctx.lineWidth = 1.75;
      for (let x = origX; x <= dispW; x += step25mmX) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, dispH);
      }
      for (let y = origY; y <= dispH; y += step25mmY) {
        ctx.moveTo(0, y);
        ctx.lineTo(dispW, y);
      }
      ctx.stroke();

      // Top & left millimeter ruler badges at 25 mm intervals
      ctx.font = "600 10px 'IBM Plex Mono', monospace";
      let idx25 = 0;
      for (let x = origX; x <= dispW - 24; x += step25mmX) {
        const mmVal = idx25 * 25;
        ctx.fillStyle = "rgba(15, 23, 42, 0.82)";
        ctx.fillRect(x + 2, 3, 38, 14);
        ctx.fillStyle = "#FFD740";
        ctx.fillText(`${mmVal}мм`, x + 5, 13);
        idx25++;
      }
    }

    // 3. Top-right live calibration summary overlay badge
    const badgeText = `Сетка: ${pxPerMm.toFixed(2)} пикс/мм • 1 кл. (5 мм) = ${(pxPerMm * 5).toFixed(1)} пикс • 5 кл. (25 мм) = ${(pxPerMm * 25).toFixed(1)} пикс`;
    ctx.font = "600 11px 'IBM Plex Mono', monospace";
    const bw = ctx.measureText(badgeText).width + 18;
    const bx = Math.max(8, dispW - bw - 8);
    ctx.fillStyle = "rgba(15, 23, 42, 0.86)";
    ctx.fillRect(bx, 8, bw, 22);
    ctx.strokeStyle = "#00E5FF";
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, 8, bw, 22);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(badgeText, bx + 9, 23);

    // 4. Draw Interactive 2-Point Ruler (Point A -> Point B or live hover cursor)
    if (state.calRulerA) {
      const ax = state.calRulerA.x * scaleX;
      const ay = state.calRulerA.y * scaleY;
      const targetPt = state.calRulerB || state.calRulerHover;

      if (targetPt) {
        const bxPt = targetPt.x * scaleX;
        const byPt = targetPt.y * scaleY;

        // Glowing ruler line A -> B
        ctx.save();
        ctx.strokeStyle = "rgba(15, 23, 42, 0.85)";
        ctx.lineWidth = 4.5;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bxPt, byPt);
        ctx.stroke();

        ctx.strokeStyle = "#00E5FF";
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bxPt, byPt);
        ctx.stroke();

        // Draw intermediate cell division ticks along A -> B based on selected reference mm
        const refMm = parseFloat((el.selectCalRefMm && el.selectCalRefMm.value) || "25") || 25;
        const nCells = Math.max(1, Math.round(refMm / 5));
        const dx = bxPt - ax;
        const dy = byPt - ay;
        const len = Math.hypot(dx, dy);
        if (len > 12) {
          const nx = -dy / len;
          const ny = dx / len;
          ctx.strokeStyle = "#FFD740";
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          for (let c = 0; c <= nCells; c++) {
            const t = c / nCells;
            const tx = ax + dx * t;
            const ty = ay + dy * t;
            const tickHalf = c === 0 || c === nCells ? 9 : 6;
            ctx.moveTo(tx - nx * tickHalf, ty - ny * tickHalf);
            ctx.lineTo(tx + nx * tickHalf, ty + ny * tickHalf);
          }
          ctx.stroke();
        }

        // Endpoint B marker
        ctx.fillStyle = state.calRulerB ? "#00E676" : "#FFD740";
        ctx.strokeStyle = "#0F172A";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(bxPt, byPt, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Callout measurement pill at midpoint of A -> B
        const distNatPx = Math.hypot(targetPt.x - state.calRulerA.x, targetPt.y - state.calRulerA.y);
        const estPxMm = distNatPx / refMm;
        const lbl = `A–B: ${distNatPx.toFixed(1)} пикс / ${refMm} мм = ${estPxMm.toFixed(2)} пикс/мм`;
        ctx.font = "600 11px 'IBM Plex Mono', monospace";
        const lw = ctx.measureText(lbl).width + 14;
        const mx = Math.max(6, Math.min(dispW - lw - 6, (ax + bxPt) * 0.5 - lw * 0.5));
        const my = Math.max(34, Math.min(dispH - 10, (ay + byPt) * 0.5 - 12));
        ctx.fillStyle = "rgba(15, 23, 42, 0.92)";
        ctx.fillRect(mx, my - 15, lw, 20);
        ctx.strokeStyle = "#00E5FF";
        ctx.lineWidth = 1.2;
        ctx.strokeRect(mx, my - 15, lw, 20);
        ctx.fillStyle = "#00E5FF";
        ctx.fillText(lbl, mx + 7, my - 1);
        ctx.restore();
      }

      // Endpoint A marker
      ctx.save();
      ctx.fillStyle = "#00E5FF";
      ctx.strokeStyle = "#0F172A";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(ax, ay, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.font = "700 11px 'IBM Plex Mono', monospace";
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText("A", ax + 8, ay - 6);
      ctx.restore();
    }
  }

  // Applies a new calibration scale (px/mm) immediately in <10 ms to the grid overlay and all 12 digitized leads & calipers
  function applyCalibrationScaleLive(newPxPerMm) {
    if (!state.digitization || !state.digitization.leads_mv) return;
    const cleanPxMm = Math.max(1.0, Math.min(100.0, parseFloat(newPxPerMm) || 5.5));
    const oldPxMm = state.activePxPerMm || (state.digitization.pixel_spacing && state.digitization.pixel_spacing.px_per_mm) || cleanPxMm;
    el.inputPxPerMm.value = cleanPxMm.toFixed(2);

    const ratio = oldPxMm / cleanPxMm;
    if (Math.abs(ratio - 1.0) > 1e-4) {
      const fs = state.digitization.sampling_rate_hz || 500;
      const leadsMap = state.digitization.leads_mv;

      // Rescale each lead's voltage (mV) and duration (number of samples at 500 Hz).
      // Resample from the pristine per-lead signal (`state.calibBase`) with the TOTAL ratio, so repeated
      // +/- 0.05 clicks never accumulate interpolation smoothing / rounding drift.
      const resampleScaled = (srcSig, r) => {
        const newLen = Math.max(60, Math.min(30000, Math.round(srcSig.length * r)));
        const newSig = new Array(newLen);
        for (let i = 0; i < newLen; i++) {
          const pos = (i / Math.max(1, newLen - 1)) * (srcSig.length - 1);
          const i0 = Math.floor(pos);
          const i1 = Math.min(srcSig.length - 1, i0 + 1);
          const frac = pos - i0;
          const vOld = srcSig[i0] * (1 - frac) + srcSig[i1] * frac;
          newSig[i] = Number((vOld * r).toFixed(4));
        }
        return newSig;
      };
      Object.keys(leadsMap).forEach((ln) => {
        const base = state.calibBase && state.calibBase[ln];
        if (base && base.sig && base.sig.length >= 4 && base.pxPerMm > 0) {
          leadsMap[ln] = resampleScaled(base.sig, base.pxPerMm / cleanPxMm);
        } else {
          const oldSig = leadsMap[ln] || [];
          if (oldSig.length < 4) return;
          leadsMap[ln] = resampleScaled(oldSig, ratio);
        }
      });

      // Rescale fiducial timestamps (0.1 ms precision, no integer-ms rounding drift) of one lead analysis
      const scaleMs = (v) => Math.round(v * ratio * 10) / 10;
      const rescaleLeadTimes = (lAna) => {
        if (!lAna) return;
        (lAna.beats || []).forEach((b) => {
          if (b.times_ms) {
            Object.keys(b.times_ms).forEach((k) => {
              b.times_ms[k] = scaleMs(b.times_ms[k]);
            });
            b.r_peak = Math.round((b.times_ms.r_peak * fs) / 1000.0);
          }
        });
        if (lAna.calipers_ms) {
          Object.keys(lAna.calipers_ms).forEach((k) => {
            lAna.calipers_ms[k] = scaleMs(lAna.calipers_ms[k]);
          });
        }
        if (Array.isArray(lAna.r_peaks_ms)) lAna.r_peaks_ms = lAna.r_peaks_ms.map(scaleMs);
        if (Array.isArray(lAna.r_peaks_ms)) lAna.r_peaks = lAna.r_peaks_ms.map((ms) => Math.round((ms * fs) / 1000.0));
        if (Array.isArray(lAna.rr_intervals_ms)) lAna.rr_intervals_ms = lAna.rr_intervals_ms.map(scaleMs);
        if (lAna.hrv) {
          ["median_rr_ms", "sdnn_ms", "rmssd_ms"].forEach((k) => {
            if (typeof lAna.hrv[k] === "number") lAna.hrv[k] = scaleMs(lAna.hrv[k]);
          });
        }
      };

      // Rescale all fiducial beat timestamps and R-peaks across all leads
      if (state.analysis && state.analysis.leads) {
        Object.keys(state.analysis.leads).forEach((ln) => {
          const lAna = state.analysis.leads[ln];
          if (!lAna) return;
          rescaleLeadTimes(lAna);
          if (state.artifactsByLead && state.artifactsByLead[ln]) {
            state.artifactsByLead[ln].forEach((z) => {
              z.startMs = scaleMs(z.startMs);
              z.endMs = scaleMs(z.endMs);
            });
          }
          syncLeadRArrayFromBeats(ln);
        });
      }
      // Keep the "reset auto R-marks" backup on the SAME time scale as the live data
      Object.keys(state.originalBeatsByLead || {}).forEach((ln) => rescaleLeadTimes(state.originalBeatsByLead[ln]));

      // Rescale active caliper positions
      Object.keys(state.calipersMs).forEach((k) => {
        state.calipersMs[k] = scaleMs(state.calipersMs[k]);
      });
      state.freeCalipers.t1_ms = scaleMs(state.freeCalipers.t1_ms);
      state.freeCalipers.t2_ms = scaleMs(state.freeCalipers.t2_ms);
      state.freeCalipers.v1_mv = Number((state.freeCalipers.v1_mv * ratio).toFixed(3));
      state.freeCalipers.v2_mv = Number((state.freeCalipers.v2_mv * ratio).toFixed(3));

      state.activePxPerMm = cleanPxMm;
      if (!state.digitization.pixel_spacing) state.digitization.pixel_spacing = {};
      state.digitization.pixel_spacing.px_per_mm = cleanPxMm;
      state.digitization.pixel_spacing.px_per_mm_x = cleanPxMm;
      state.digitization.pixel_spacing.px_per_mm_y = cleanPxMm;

      // Durations & amplitudes of ALL leads (not only the active one) + axes / LVH indices / global HR
      recomputeAllLeadMetricsClient(true);
    }

    updateDigitizationMetaBanner();
    populateBeatDropdown(state.activeLead);
    syncNumericalInputsFromCalipers();
    renderPhotoCalibrationCanvas();
    recalculateLiveMetricsAndRender();
    renderMultiLeadCanvas();
    renderHexaxialCompass();
    renderAllLeadsTable();

    if (el.calRulerStatus) {
      el.calRulerStatus.textContent = `Применён масштаб: ${cleanPxMm.toFixed(2)} пикс/мм (1 клетка 5 мм = ${(cleanPxMm * 5).toFixed(1)} пикс)`;
    }
    setStatus(`Масштаб сетки обновлён: ${cleanPxMm.toFixed(2)} пикс/мм (все интервалы и амплитуды пересчитаны)`, "ready");
  }

  function bindPhotoCalibrationEvents() {
    const canvas = el.calGridCanvas;
    const img = el.imgAligned;
    if (!canvas || !img) return;

    const getNatPos = (evt) => {
      const rect = canvas.getBoundingClientRect();
      const natW = img.naturalWidth || rect.width || 1000;
      const natH = img.naturalHeight || rect.height || 700;
      const scaleX = natW / Math.max(1, rect.width);
      const scaleY = natH / Math.max(1, rect.height);
      return {
        x: (evt.clientX - rect.left) * scaleX,
        y: (evt.clientY - rect.top) * scaleY,
      };
    };

    // Right-click drag shifts grid phase (origin X/Y) to align with printed grid intersections
    canvas.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
    });

    canvas.addEventListener("mousedown", (evt) => {
      const pt = getNatPos(evt);
      // Right button or Shift+Drag shifts grid phase
      if (evt.button === 2 || evt.shiftKey) {
        state.calPhaseDrag = {
          startX: pt.x,
          startY: pt.y,
          origX: state.calGridOrigin.x,
          origY: state.calGridOrigin.y,
        };
        return;
      }

      // Left click: 2-point calibration ruler (Point A -> Point B)
      if (!state.calRulerA || (state.calRulerA && state.calRulerB)) {
        state.calRulerA = pt;
        state.calRulerB = null;
        state.calRulerHover = pt;
        // Snap grid origin to Point A so grid lines align right onto the clicked grid intersection!
        state.calGridOrigin = { x: pt.x, y: pt.y };
        const refMm = (el.selectCalRefMm && el.selectCalRefMm.value) || "25";
        if (el.calRulerStatus) {
          el.calRulerStatus.textContent = `Точка A отмечена. Кликните точку B через ${refMm} мм (${Math.round(refMm / 5)} кл.)...`;
        }
        setStatus(`Точка A отмечена. Кликните точку B через ${refMm} мм вдоль клеток сетки...`, "busy");
        renderPhotoCalibrationCanvas();
      } else {
        state.calRulerB = pt;
        state.calRulerHover = null;
        const distPx = Math.hypot(pt.x - state.calRulerA.x, pt.y - state.calRulerA.y);
        const refMm = parseFloat((el.selectCalRefMm && el.selectCalRefMm.value) || "25") || 25.0;
        if (distPx > 6) {
          const estPxPerMm = distPx / refMm;
          applyCalibrationScaleLive(estPxPerMm);
          if (el.calRulerStatus) {
            el.calRulerStatus.textContent = `Отрезок A–B: ${distPx.toFixed(1)} пикс / ${refMm} мм → ${estPxPerMm.toFixed(2)} пикс/мм (применено)`;
          }
        }
        renderPhotoCalibrationCanvas();
      }
    });

    canvas.addEventListener("mousemove", (evt) => {
      const pt = getNatPos(evt);
      if (state.calPhaseDrag) {
        state.calGridOrigin = {
          x: state.calPhaseDrag.origX + (pt.x - state.calPhaseDrag.startX),
          y: state.calPhaseDrag.origY + (pt.y - state.calPhaseDrag.startY),
        };
        renderPhotoCalibrationCanvas();
        return;
      }
      if (state.calRulerA && !state.calRulerB) {
        state.calRulerHover = pt;
        renderPhotoCalibrationCanvas();
      }
    });

    window.addEventListener("mouseup", () => {
      state.calPhaseDrag = null;
    });

    if (el.chkShowCalGrid) {
      el.chkShowCalGrid.addEventListener("change", () => renderPhotoCalibrationCanvas());
    }
    if (el.chkShowCalMinorGrid) {
      el.chkShowCalMinorGrid.addEventListener("change", () => renderPhotoCalibrationCanvas());
    }
    if (el.selectCalRefMm) {
      el.selectCalRefMm.addEventListener("change", () => {
        if (state.calRulerA && state.calRulerB) {
          const distPx = Math.hypot(state.calRulerB.x - state.calRulerA.x, state.calRulerB.y - state.calRulerA.y);
          const refMm = parseFloat(el.selectCalRefMm.value) || 25.0;
          if (distPx > 6) {
            applyCalibrationScaleLive(distPx / refMm);
          }
        } else {
          renderPhotoCalibrationCanvas();
        }
      });
    }
    if (el.inputPxPerMm) {
      el.inputPxPerMm.addEventListener("input", () => {
        renderPhotoCalibrationCanvas();
      });
    }
    if (el.btnCalMinus) {
      el.btnCalMinus.addEventListener("click", () => {
        const cur = parseFloat(el.inputPxPerMm.value) || state.activePxPerMm || 5.5;
        applyCalibrationScaleLive(Math.max(1.0, cur - 0.05));
      });
    }
    if (el.btnCalPlus) {
      el.btnCalPlus.addEventListener("click", () => {
        const cur = parseFloat(el.inputPxPerMm.value) || state.activePxPerMm || 5.5;
        applyCalibrationScaleLive(Math.min(100.0, cur + 0.05));
      });
    }
    if (el.btnApplyManualCal) {
      el.btnApplyManualCal.addEventListener("click", () => {
        const val = parseFloat(el.inputPxPerMm.value);
        if (val && val > 0.5) {
          applyCalibrationScaleLive(val);
        }
      });
    }
    if (el.btnResetManualCal) {
      el.btnResetManualCal.addEventListener("click", () => {
        state.calRulerA = null;
        state.calRulerB = null;
        state.calRulerHover = null;
        state.calGridOrigin = { x: 0, y: 0 };
        const autoVal = state.autoPxPerMm || 5.5;
        applyCalibrationScaleLive(autoVal);
        if (el.calRulerStatus) {
          el.calRulerStatus.textContent = `Восстановлен авто-масштаб сетки: ${autoVal.toFixed(2)} пикс/мм`;
        }
      });
    }
    if (el.selectCalZoom) {
      el.selectCalZoom.addEventListener("change", () => {
        state.calZoom = parseFloat(el.selectCalZoom.value) || 1.0;
        renderPhotoCalibrationCanvas();
      });
    }
  }

  // =========================================================================
  // Interactive Trace Overlay: Zoom + Lead Name Correction + Auto-Trace Line Correction
  // =========================================================================
  const OVERLAY_PALETTE = ["#00E676", "#00B0FF", "#FF4081", "#FFD740", "#7C4DFF", "#00E5FF"];

  function populateOverlayTraceDropdown() {
    if (!el.selectOverlayTraceIdx || !state.digitization) return;
    const traces = state.digitization.overlay_traces || [];
    el.selectOverlayTraceIdx.innerHTML = "";
    traces.forEach((tr, idx) => {
      const opt = document.createElement("option");
      opt.value = String(idx);
      opt.textContent = `#${idx + 1}: ${tr.lead}`;
      el.selectOverlayTraceIdx.appendChild(opt);
    });
    if (traces.length > 0) {
      state.selectedTraceIdx = Math.max(0, Math.min(state.selectedTraceIdx, traces.length - 1));
      el.selectOverlayTraceIdx.value = String(state.selectedTraceIdx);
      if (el.selectOverlayLeadRename) {
        const curName = traces[state.selectedTraceIdx].lead;
        // Non-standard names (e.g. rhythm strips "II (ритм)") must exist as options, otherwise the select is blank
        if (!Array.from(el.selectOverlayLeadRename.options).some((o) => o.value === curName)) {
          const opt = document.createElement("option");
          opt.value = curName;
          opt.textContent = curName;
          el.selectOverlayLeadRename.appendChild(opt);
        }
        el.selectOverlayLeadRename.value = curName;
      }
    }
  }

  function ensureOverlayInkMap() {
    if (state.overlayInkMap) return state.overlayInkMap;
    const img = el.imgTraceOverlay;
    if (!img || !img.complete || !img.naturalWidth) return null;
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const ctx = off.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    const ink = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = Math.max(r, g, b) - Math.min(r, g, b);
      const darkness = Math.max(0, (185 - lum) / 150.0);
      const neutral = sat < 45 ? 1.0 : Math.max(0.1, 1.0 - (sat - 45) / 80.0);
      ink[i] = Math.min(1.0, darkness * neutral);
    }
    state.overlayInkMap = { W, H, data: ink };
    return state.overlayInkMap;
  }

  function renderTraceOverlayCanvas() {
    const img = el.imgTraceOverlay;
    const canvas = el.traceOverlayCanvas;
    if (!img || !canvas || !state.digitization) return;

    const natW = img.naturalWidth || 1000;
    const natH = img.naturalHeight || 700;
    if (el.overlayStageWrap && el.overlayScrollBox) {
      const boxW = Math.max(320, (el.overlayScrollBox.clientWidth || 600) - 20);
      const targetW = Math.round(boxW * (state.overlayZoom || 1.0));
      el.overlayStageWrap.style.width = `${targetW}px`;
    }

    const rect = img.getBoundingClientRect();
    const dispW = rect.width > 20 ? rect.width : img.clientWidth || natW;
    const dispH = rect.height > 20 ? rect.height : img.clientHeight || natH;
    if (dispW < 10 || dispH < 10) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(dispW * dpr);
    canvas.height = Math.round(dispH * dpr);

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, dispW, dispH);

    const scaleX = dispW / natW;
    const scaleY = dispH / natH;

    // 1. Subtle 5mm verification grid in top-left corner
    const pxPerMm = (state.digitization.pixel_spacing && state.digitization.pixel_spacing.px_per_mm) || state.activePxPerMm || 5.5;
    const step5X = Math.max(8, 5.0 * pxPerMm * scaleX);
    const step5Y = Math.max(8, 5.0 * pxPerMm * scaleY);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 165, 0, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= Math.min(dispW, 12 * step5X); x += step5X) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, Math.min(dispH, 8 * step5Y));
    }
    for (let y = 0; y <= Math.min(dispH, 8 * step5Y); y += step5Y) {
      ctx.moveTo(0, y);
      ctx.lineTo(Math.min(dispW, 12 * step5X), y);
    }
    ctx.stroke();
    ctx.restore();

    // 2. Render all vector lead traces + interactive lead name badges
    const traces = state.digitization.overlay_traces || [];
    state.overlayBadgeHitBoxes = [];

    traces.forEach((tr, idx) => {
      const pts = tr.points_px || [];
      if (pts.length < 2) return;
      const color = OVERLAY_PALETTE[idx % OVERLAY_PALETTE.length];
      const isSel = idx === state.selectedTraceIdx;

      ctx.save();
      if (isSel) {
        ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
        ctx.lineWidth = 4.6;
        ctx.lineJoin = "round";
        ctx.beginPath();
        pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0] * scaleX, p[1] * scaleY) : ctx.lineTo(p[0] * scaleX, p[1] * scaleY)));
        ctx.stroke();
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = isSel ? 2.6 : 1.75;
      ctx.globalAlpha = isSel ? 1.0 : 0.86;
      ctx.lineJoin = "round";
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0] * scaleX, p[1] * scaleY) : ctx.lineTo(p[0] * scaleX, p[1] * scaleY)));
      ctx.stroke();
      ctx.restore();

      // Lead name badge at start of trace
      const bx = pts[0][0] * scaleX + 4;
      const by = Math.max(14, (tr.baseline_y_px || pts[0][1]) * scaleY - 12);
      const lbl = String(tr.lead || "");
      ctx.save();
      ctx.font = isSel ? "700 12px 'IBM Plex Mono', monospace" : "600 11px 'IBM Plex Mono', monospace";
      const tw = ctx.measureText(lbl).width + 10;
      const th = 17;
      ctx.fillStyle = isSel ? "#0F172A" : "rgba(15, 23, 42, 0.78)";
      ctx.fillRect(bx, by - 12, tw, th);
      ctx.strokeStyle = color;
      ctx.lineWidth = isSel ? 1.8 : 1.0;
      ctx.strokeRect(bx, by - 12, tw, th);
      ctx.fillStyle = color;
      ctx.fillText(lbl, bx + 5, by + 1);
      ctx.restore();

      state.overlayBadgeHitBoxes.push({
        idx,
        bx,
        by: by - 12,
        bw: tw,
        bh: th,
      });
    });

    // 3. Top-right Zoom indicator pill
    ctx.save();
    const zTxt = `Зум: ${(state.overlayZoom || 1.0).toFixed(1)}× • Отведение: ${traces[state.selectedTraceIdx] ? traces[state.selectedTraceIdx].lead : "—"}`;
    ctx.font = "600 11px 'IBM Plex Mono', monospace";
    const zw = ctx.measureText(zTxt).width + 16;
    const zx = Math.max(6, dispW - zw - 8);
    ctx.fillStyle = "rgba(15, 23, 42, 0.84)";
    ctx.fillRect(zx, 6, zw, 20);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(zTxt, zx + 8, 20);
    ctx.restore();
  }

  async function syncTraceToDigitalLead(traceIdx, reanalyzeBackend = true, markManual = true) {
    if (!state.digitization || !state.digitization.overlay_traces) return;
    const tr = state.digitization.overlay_traces[traceIdx];
    if (!tr || !tr.points_px || tr.points_px.length < 4) return;

    const sp = state.digitization.pixel_spacing || {};
    const pxPerMmX = sp.px_per_mm_x || sp.px_per_mm || state.activePxPerMm || 5.5;
    const pxPerMmY = sp.px_per_mm_y || sp.px_per_mm || state.activePxPerMm || 5.5;
    const speed = state.digitization.paper_speed_mm_s || 25.0;
    const gain = state.digitization.gain_mm_mv || 10.0;
    const fs = state.digitization.sampling_rate_hz || 500.0;

    const pts = tr.points_px;
    const baseY = tr.baseline_y_px !== undefined ? tr.baseline_y_px : pts[0][1];
    const invertSign = String(tr.lead).startsWith("-");
    const spanPx = Math.max(10, pts[pts.length - 1][0] - pts[0][0]);
    const durSec = Math.max(0.2, Math.min(60.0, (spanPx / Math.max(0.5, pxPerMmX)) / Math.max(5.0, speed)));
    const numSamples = Math.max(100, Math.round(durSec * fs));

    const mvRaw = new Float64Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      let v = (baseY - pts[i][1]) / Math.max(0.5, pxPerMmY * gain);
      if (invertSign) v = -v;
      mvRaw[i] = v;
    }
    const sorted = Array.from(mvRaw).sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || 0;
    const mvResampled = new Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const pos = (i / Math.max(1, numSamples - 1)) * (pts.length - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(pts.length - 1, i0 + 1);
      const f = pos - i0;
      mvResampled[i] = Number(((mvRaw[i0] * (1 - f) + mvRaw[i1] * f) - med).toFixed(4));
    }

    state.digitization.leads_mv[tr.lead] = mvResampled;
    const cleanName = String(tr.lead).replace(/^-/, "");
    const editedLeads = { [tr.lead]: mvResampled };
    if (invertSign && cleanName !== tr.lead) {
      state.digitization.leads_mv[cleanName] = mvResampled.map((v) => Number((-v).toFixed(4)));
      editedLeads[cleanName] = state.digitization.leads_mv[cleanName];
    }
    // The edited signal was produced at the CURRENT px/mm: it becomes this lead's new calibration base
    Object.keys(editedLeads).forEach((ln) => {
      state.calibBase[ln] = { sig: editedLeads[ln].slice(), pxPerMm: state.activePxPerMm || pxPerMmX };
    });
    // The automatic trace-quality verdict no longer applies to a hand-corrected line
    if (!state.digitization.lead_quality) state.digitization.lead_quality = {};
    if (markManual) {
      Object.keys(editedLeads).forEach((ln) => {
        state.digitization.lead_quality[ln] = { level: "manual", score: null, issues: ["линия исправлена вручную во вкладке «Контур»"] };
      });
    }

    if (reanalyzeBackend) {
      // Re-analyze ONLY the edited lead(s) and merge them: manual R-peak / caliper / artifact work on all
      // other leads is preserved. A sequence number drops out-of-order responses from quick successive edits.
      const seq = (state.reanalyzeSeq = (state.reanalyzeSeq || 0) + 1);
      let newLeadsAna = null;
      if (state.staticMode) {
        newLeadsAna = {};
        Object.keys(editedLeads).forEach((ln) => {
          newLeadsAna[ln] = analyzeLeadClientSide(editedLeads[ln], fs);
        });
      } else {
        try {
          const res = await fetch("/api/reanalyze_leads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              leads_mv: editedLeads,
              fs,
              preferred_lead: tr.lead,
              sex: (el.selectPatientSex && el.selectPatientSex.value) || null,
            }),
          });
          if (res.ok) newLeadsAna = (await res.json()).leads || null;
        } catch (err) {
          console.warn("Re-analysis of edited lead failed:", err);
        }
      }
      if (seq !== state.reanalyzeSeq) return;
      if (newLeadsAna && state.analysis) {
        if (!state.analysis.leads) state.analysis.leads = {};
        Object.keys(newLeadsAna).forEach((ln) => {
          state.analysis.leads[ln] = newLeadsAna[ln];
          state.originalBeatsByLead[ln] = JSON.parse(JSON.stringify(newLeadsAna[ln]));
          if (!state.artifactsByLead[ln]) state.artifactsByLead[ln] = [];
          if (state.staticMode) {
            const lAna = state.analysis.leads[ln];
            const m = computeLeadMetricsClient(ln, lAna.beats[lAna.representative_beat_index].times_ms);
            if (m) lAna.metrics = m;
          }
        });
        recomputeGlobalIndicesClient();
      }
    }

    buildLeadPills(Object.keys(state.digitization.leads_mv));
    selectLead(tr.lead);
    renderMultiLeadCanvas();
    renderHexaxialCompass();
    renderAllLeadsTable();
  }

  function autoTraceThroughPoint(traceIdx, natX, natY) {
    const inkObj = ensureOverlayInkMap();
    const traces = state.digitization && state.digitization.overlay_traces;
    if (!inkObj || !traces || !traces[traceIdx]) return;

    const tr = traces[traceIdx];
    const pts = tr.points_px;
    if (!pts || pts.length < 6) return;

    // Locate closest point index to clicked X
    let ci = 0;
    let bestDx = 1e9;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i][0] - natX);
      if (d < bestDx) {
        bestDx = d;
        ci = i;
      }
    }

    const pxPerMm = (state.digitization.pixel_spacing && state.digitization.pixel_spacing.px_per_mm) || state.activePxPerMm || 5.5;
    const halfWinIdx = Math.max(8, Math.min(Math.floor(pts.length * 0.16), Math.round((3.8 * pxPerMm) / Math.max(1, (pts[pts.length - 1][0] - pts[0][0]) / pts.length))));
    const i0 = Math.max(0, ci - halfWinIdx);
    const i1 = Math.min(pts.length - 1, ci + halfWinIdx);
    if (i1 <= i0 + 2) return;

    let minY = natY;
    let maxY = natY;
    for (let k = i0; k <= i1; k++) {
      if (pts[k][1] < minY) minY = pts[k][1];
      if (pts[k][1] > maxY) maxY = pts[k][1];
    }
    const padY = Math.max(16, Math.round(2.5 * pxPerMm));
    const yLo = Math.max(1, Math.floor(minY - padY));
    const yHi = Math.min(inkObj.H - 2, Math.ceil(maxY + padY));
    const H_b = yHi - yLo + 1;
    const lenK = i1 - i0 + 1;

    // Constrained 2D Viterbi DP path from pts[i0] through (natX, natY) to pts[i1]
    const dp = new Float64Array(lenK * H_b);
    const back = new Int32Array(lenK * H_b);
    const maxStep = Math.max(10, Math.round(H_b * 0.45));
    const anchorRel = Math.max(0, Math.min(H_b - 1, Math.round(natY) - yLo));
    const startRel = Math.max(0, Math.min(H_b - 1, Math.round(pts[i0][1]) - yLo));
    const endRel = Math.max(0, Math.min(H_b - 1, Math.round(pts[i1][1]) - yLo));

    for (let r = 0; r < H_b; r++) {
      dp[r] = -0.35 * Math.abs(r - startRel);
    }

    for (let k = 1; k < lenK; k++) {
      const absIdx = i0 + k;
      const x = Math.max(0, Math.min(inkObj.W - 1, Math.round(pts[absIdx][0])));
      const isAnchor = absIdx === ci;
      const isEnd = k === lenK - 1;
      for (let r = 0; r < H_b; r++) {
        const yImg = yLo + r;
        let rew = inkObj.data[yImg * inkObj.W + x] * 2.2;
        if (isAnchor) {
          rew -= 1.8 * Math.abs(r - anchorRel);
        }
        if (isEnd) {
          rew -= 1.5 * Math.abs(r - endRel);
        }
        let bestPrev = -1e9;
        let bestR = r;
        const rMin = Math.max(0, r - maxStep);
        const rMax = Math.min(H_b - 1, r + maxStep);
        for (let pr = rMin; pr <= rMax; pr++) {
          const cand = dp[(k - 1) * H_b + pr] - 0.045 * Math.abs(r - pr);
          if (cand > bestPrev) {
            bestPrev = cand;
            bestR = pr;
          }
        }
        dp[k * H_b + r] = rew + bestPrev;
        back[k * H_b + r] = bestR;
      }
    }

    let currR = endRel;
    let bestEndScore = -1e9;
    for (let r = 0; r < H_b; r++) {
      if (dp[(lenK - 1) * H_b + r] > bestEndScore) {
        bestEndScore = dp[(lenK - 1) * H_b + r];
        currR = r;
      }
    }
    for (let k = lenK - 1; k >= 0; k--) {
      pts[i0 + k][1] = Number((yLo + currR).toFixed(1));
      if (k > 0) currR = back[k * H_b + currR];
    }
    pts[ci][1] = Number(natY.toFixed(1));

    renderTraceOverlayCanvas();
  }

  function autoRetraceFullLead(traceIdx) {
    const inkObj = ensureOverlayInkMap();
    const traces = state.digitization && state.digitization.overlay_traces;
    if (!inkObj || !traces || !traces[traceIdx]) return;
    const tr = traces[traceIdx];
    const pts = tr.points_px;
    if (!pts || pts.length < 6) return;

    const baseY = tr.baseline_y_px !== undefined ? tr.baseline_y_px : pts[0][1];
    const pxPerMm = (state.digitization.pixel_spacing && state.digitization.pixel_spacing.px_per_mm) || state.activePxPerMm || 5.5;
    const halfBand = Math.max(24, Math.round(11.0 * pxPerMm));
    const yLo = Math.max(1, Math.floor(baseY - halfBand));
    const yHi = Math.min(inkObj.H - 2, Math.ceil(baseY + halfBand));
    const H_b = yHi - yLo + 1;
    const lenK = pts.length;
    const baseRel = Math.max(0, Math.min(H_b - 1, Math.round(baseY) - yLo));

    const dp = new Float64Array(lenK * H_b);
    const back = new Int32Array(lenK * H_b);
    const maxStep = Math.max(12, Math.round(H_b * 0.32));

    for (let r = 0; r < H_b; r++) {
      dp[r] = -0.08 * Math.abs(r - baseRel);
    }
    for (let k = 1; k < lenK; k++) {
      const x = Math.max(0, Math.min(inkObj.W - 1, Math.round(pts[k][0])));
      for (let r = 0; r < H_b; r++) {
        const rew = inkObj.data[(yLo + r) * inkObj.W + x] * 2.1 - 0.012 * Math.abs(r - baseRel);
        let bestPrev = -1e9;
        let bestR = r;
        const rMin = Math.max(0, r - maxStep);
        const rMax = Math.min(H_b - 1, r + maxStep);
        for (let pr = rMin; pr <= rMax; pr++) {
          const cand = dp[(k - 1) * H_b + pr] - 0.045 * Math.abs(r - pr);
          if (cand > bestPrev) {
            bestPrev = cand;
            bestR = pr;
          }
        }
        dp[k * H_b + r] = rew + bestPrev;
        back[k * H_b + r] = bestR;
      }
    }
    let currR = baseRel;
    let bestEnd = -1e9;
    for (let r = 0; r < H_b; r++) {
      if (dp[(lenK - 1) * H_b + r] > bestEnd) {
        bestEnd = dp[(lenK - 1) * H_b + r];
        currR = r;
      }
    }
    for (let k = lenK - 1; k >= 0; k--) {
      pts[k][1] = Number((yLo + currR).toFixed(1));
      if (k > 0) currR = back[k * H_b + currR];
    }
    renderTraceOverlayCanvas();
    syncTraceToDigitalLead(traceIdx, true);
    if (el.overlayEditStatus) {
      el.overlayEditStatus.textContent = `Выполнена авто-перетрассировка канала ${tr.lead}`;
    }
  }

  function freehandDrawTracePoint(traceIdx, ptA, ptB) {
    const traces = state.digitization && state.digitization.overlay_traces;
    if (!traces || !traces[traceIdx]) return;
    const pts = traces[traceIdx].points_px;
    if (!pts || pts.length < 2) return;
    const xMin = Math.min(ptA.x, ptB.x);
    const xMax = Math.max(ptA.x, ptB.x);
    for (let i = 0; i < pts.length; i++) {
      const px = pts[i][0];
      if (px >= xMin - 2 && px <= xMax + 2) {
        const t = Math.abs(ptB.x - ptA.x) > 0.5 ? Math.max(0, Math.min(1, (px - ptA.x) / (ptB.x - ptA.x))) : 1.0;
        pts[i][1] = Number((ptA.y * (1 - t) + ptB.y * t).toFixed(1));
      }
    }
    renderTraceOverlayCanvas();
  }

  async function renameOverlayTrace(traceIdx, newLeadName) {
    if (!state.digitization || !state.digitization.overlay_traces) return;
    const traces = state.digitization.overlay_traces;
    if (!traces[traceIdx] || !newLeadName) return;
    const oldName = traces[traceIdx].lead;
    if (oldName === newLeadName) return;

    // If another trace already has newLeadName, swap them cleanly
    const otherIdx = traces.findIndex((t, i) => i !== traceIdx && t.lead === newLeadName);
    if (otherIdx >= 0) {
      traces[otherIdx].lead = oldName;
    }
    traces[traceIdx].lead = newLeadName;

    // Rebuild leads_mv in the updated trace order
    const oldMap = state.digitization.leads_mv || {};
    const tempMap = { ...oldMap };
    if (otherIdx >= 0 && oldMap[oldName] && oldMap[newLeadName]) {
      tempMap[newLeadName] = oldMap[oldName];
      tempMap[oldName] = oldMap[newLeadName];
    } else if (oldMap[oldName]) {
      tempMap[newLeadName] = oldMap[oldName];
      delete tempMap[oldName];
    }

    const orderedMap = {};
    traces.forEach((t) => {
      if (tempMap[t.lead]) orderedMap[t.lead] = tempMap[t.lead];
    });
    Object.keys(tempMap).forEach((k) => {
      if (!orderedMap[k]) orderedMap[k] = tempMap[k];
    });
    state.digitization.leads_mv = orderedMap;

    // Move / swap every per-lead store together with the signal, so beats, artifact zones, the
    // "reset auto R-marks" backup and the calibration base keep following the renamed trace.
    const migrateKey = (store) => {
      if (!store) return;
      const a = store[oldName];
      const b = store[newLeadName];
      if (otherIdx >= 0) {
        if (b !== undefined) store[oldName] = b;
        else delete store[oldName];
      } else {
        delete store[oldName];
      }
      if (a !== undefined) store[newLeadName] = a;
      else delete store[newLeadName];
    };
    migrateKey(state.analysis && state.analysis.leads);
    migrateKey(state.artifactsByLead);
    migrateKey(state.originalBeatsByLead);
    migrateKey(state.calibBase);
    migrateKey(state.digitization.lead_quality);
    // Keep the "reset line" backup aligned with the new names too (it is indexed by trace position)
    if (state.originalOverlayTraces[traceIdx]) state.originalOverlayTraces[traceIdx].lead = newLeadName;
    if (otherIdx >= 0 && state.originalOverlayTraces[otherIdx]) state.originalOverlayTraces[otherIdx].lead = oldName;
    if (state.analysis && state.analysis.primary_lead === oldName) state.analysis.primary_lead = newLeadName;

    populateOverlayTraceDropdown();
    renderTraceOverlayCanvas();
    await syncTraceToDigitalLead(traceIdx, true, false);

    const msg = otherIdx >= 0 ? `Отведения ${oldName} ↔ ${newLeadName} поменяны местами` : `Отведение ${oldName} переименовано в ${newLeadName}`;
    if (el.overlayEditStatus) el.overlayEditStatus.textContent = msg;
    setStatus(msg, "ready");
  }

  function bindTraceOverlayEvents() {
    const canvas = el.traceOverlayCanvas;
    const img = el.imgTraceOverlay;
    if (!canvas || !img) return;

    const getNatPos = (evt) => {
      const rect = canvas.getBoundingClientRect();
      const natW = img.naturalWidth || rect.width || 1000;
      const natH = img.naturalHeight || rect.height || 700;
      return {
        x: ((evt.clientX - rect.left) * natW) / Math.max(1, rect.width),
        y: ((evt.clientY - rect.top) * natH) / Math.max(1, rect.height),
      };
    };

    const getCssPos = (evt) => {
      const rect = canvas.getBoundingClientRect();
      return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
    };

    const selectTraceAtClick = (cssPos, natPos) => {
      // 1. Check badge hitboxes first
      const bHit = (state.overlayBadgeHitBoxes || []).find(
        (b) => cssPos.x >= b.bx - 3 && cssPos.x <= b.bx + b.bw + 3 && cssPos.y >= b.by - 3 && cssPos.y <= b.by + b.bh + 3
      );
      if (bHit) return bHit.idx;

      // 2. Otherwise find nearest curve
      const traces = (state.digitization && state.digitization.overlay_traces) || [];
      let bestIdx = -1;
      let bestDist = 28;
      traces.forEach((tr, idx) => {
        const pts = tr.points_px || [];
        for (let i = 0; i < pts.length; i += 2) {
          const d = Math.hypot(pts[i][0] - natPos.x, pts[i][1] - natPos.y);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = idx;
          }
        }
      });
      return bestIdx;
    };

    canvas.addEventListener("mousedown", (evt) => {
      const natPos = getNatPos(evt);
      const cssPos = getCssPos(evt);
      if (state.overlayTool === "view") {
        const hitIdx = selectTraceAtClick(cssPos, natPos);
        if (hitIdx >= 0) {
          state.selectedTraceIdx = hitIdx;
          populateOverlayTraceDropdown();
          renderTraceOverlayCanvas();
          const tr = state.digitization.overlay_traces[hitIdx];
          if (tr) {
            selectLead(tr.lead);
            if (el.overlayEditStatus) {
              el.overlayEditStatus.textContent = `Выбрано отведение ${tr.lead} — можно переименовать или править линию`;
            }
          }
        }
        return;
      }

      if (state.overlayTool === "autotrace") {
        state.overlayDrawActive = true;
        autoTraceThroughPoint(state.selectedTraceIdx, natPos.x, natPos.y);
        return;
      }

      if (state.overlayTool === "draw") {
        state.overlayDrawActive = true;
        state.overlayLastPt = natPos;
        freehandDrawTracePoint(state.selectedTraceIdx, natPos, natPos);
      }
    });

    canvas.addEventListener("mousemove", (evt) => {
      if (!state.overlayDrawActive) return;
      const natPos = getNatPos(evt);
      if (state.overlayTool === "autotrace") {
        autoTraceThroughPoint(state.selectedTraceIdx, natPos.x, natPos.y);
      } else if (state.overlayTool === "draw" && state.overlayLastPt) {
        freehandDrawTracePoint(state.selectedTraceIdx, state.overlayLastPt, natPos);
        state.overlayLastPt = natPos;
      }
    });

    window.addEventListener("mouseup", () => {
      if (state.overlayDrawActive) {
        state.overlayDrawActive = false;
        state.overlayLastPt = null;
        syncTraceToDigitalLead(state.selectedTraceIdx, true);
        const tr = state.digitization && state.digitization.overlay_traces && state.digitization.overlay_traces[state.selectedTraceIdx];
        if (tr && el.overlayEditStatus) {
          el.overlayEditStatus.textContent = `Линия ${tr.lead} скорректирована и пересчитана`;
        }
      }
    });

    // Zoom controls
    const setOverlayZoom = (z) => {
      state.overlayZoom = Math.max(1.0, Math.min(4.0, z));
      if (el.selectOverlayZoom) {
        const opts = Array.from(el.selectOverlayZoom.options).map((o) => parseFloat(o.value));
        const nearest = opts.reduce((a, b) => (Math.abs(b - state.overlayZoom) < Math.abs(a - state.overlayZoom) ? b : a));
        el.selectOverlayZoom.value = String(nearest);
      }
      renderTraceOverlayCanvas();
    };
    if (el.selectOverlayZoom) {
      el.selectOverlayZoom.addEventListener("change", () => setOverlayZoom(parseFloat(el.selectOverlayZoom.value) || 1.0));
    }
    if (el.btnOverlayZoomOut) {
      el.btnOverlayZoomOut.addEventListener("click", () => setOverlayZoom((state.overlayZoom || 1.0) - 0.5));
    }
    if (el.btnOverlayZoomIn) {
      el.btnOverlayZoomIn.addEventListener("click", () => setOverlayZoom((state.overlayZoom || 1.0) + 0.5));
    }

    // Tool switcher (view / autotrace / draw)
    document.querySelectorAll(".ov-tool-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".ov-tool-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.overlayTool = btn.getAttribute("data-ov-tool") || "view";
        canvas.style.cursor = state.overlayTool === "view" ? "pointer" : "crosshair";
      });
    });

    if (el.selectOverlayTraceIdx) {
      el.selectOverlayTraceIdx.addEventListener("change", () => {
        state.selectedTraceIdx = parseInt(el.selectOverlayTraceIdx.value, 10) || 0;
        const tr = state.digitization && state.digitization.overlay_traces && state.digitization.overlay_traces[state.selectedTraceIdx];
        if (tr && el.selectOverlayLeadRename) {
          el.selectOverlayLeadRename.value = tr.lead;
          selectLead(tr.lead);
        }
        renderTraceOverlayCanvas();
      });
    }

    if (el.btnApplyLeadRename) {
      el.btnApplyLeadRename.addEventListener("click", () => {
        const newName = el.selectOverlayLeadRename && el.selectOverlayLeadRename.value;
        if (newName) renameOverlayTrace(state.selectedTraceIdx, newName);
      });
    }

    if (el.btnAutoRetraceLead) {
      el.btnAutoRetraceLead.addEventListener("click", () => {
        autoRetraceFullLead(state.selectedTraceIdx);
      });
    }

    if (el.btnResetOverlayTrace) {
      el.btnResetOverlayTrace.addEventListener("click", () => {
        const orig = state.originalOverlayTraces && state.originalOverlayTraces[state.selectedTraceIdx];
        const traces = state.digitization && state.digitization.overlay_traces;
        if (orig && traces && traces[state.selectedTraceIdx]) {
          // Restore the original LINE but keep the current (possibly corrected) lead name,
          // otherwise the old name would be re-created as a duplicate lead
          const currentName = traces[state.selectedTraceIdx].lead;
          traces[state.selectedTraceIdx] = { ...JSON.parse(JSON.stringify(orig)), lead: currentName };
          // Back to the automatic line → back to its automatic quality verdict
          const origQ = state.originalTraceQuality && state.originalTraceQuality[state.selectedTraceIdx];
          if (origQ && state.digitization.lead_quality) state.digitization.lead_quality[currentName] = JSON.parse(JSON.stringify(origQ));
          populateOverlayTraceDropdown();
          renderTraceOverlayCanvas();
          syncTraceToDigitalLead(state.selectedTraceIdx, true, false);
          if (el.overlayEditStatus) {
            el.overlayEditStatus.textContent = `Восстановлена исходная линия ${orig.lead}`;
          }
        }
      });
    }
  }

  // =========================================================================
  // Grid Intersections ('+' Crosses) Detection, 2D Paper Deformation Field,
  // Geometric Dewarping & Grid/Lighting Artifact Removal
  // =========================================================================
  function detectGridIntersectionsAndDeformation() {
    const img = el.imgGridNodesBase;
    if (!img || !img.complete || !img.naturalWidth) return null;

    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const ctx = off.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;

    // 1. Auto-detect colored (red/pink/orange) vs grayscale/B&W (photo/PDF) grid
    const modeSel = (el.selectGridColorMode && el.selectGridColorMode.value) || "auto";
    let redCount = 0;
    const sampleStep = 4;
    let totalSamples = 0;
    for (let y = Math.floor(H * 0.08); y < Math.floor(H * 0.92); y += sampleStep) {
      for (let x = Math.floor(W * 0.08); x < Math.floor(W * 0.92); x += sampleStep) {
        const idx = (y * W + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (r - Math.max(g, b) >= 12) redCount++;
        totalSamples++;
      }
    }
    const redFrac = redCount / Math.max(1, totalSamples);
    const useRedGrid = modeSel === "color_red" ? true : modeSel === "bw_gray" ? false : redFrac >= 0.015;
    const detectedModeLabel = useRedGrid ? "Цветная сетка (красная/розовая)" : "Ч/Б сетка (серая, фото/PDF)";

    // 2. Build grid intensity map G(x, y) in [0, 1]
    const gridMap = new Float32Array(W * H);
    if (useRedGrid) {
      for (let i = 0; i < W * H; i++) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        const redEx = r - 0.52 * g - 0.48 * b;
        // Suppress very dark neutral ECG ink (where R, G, B are all low)
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (redEx > 4.0 && lum > 55) {
          gridMap[i] = Math.min(1.0, (redEx - 4.0) / 55.0);
        }
      }
    } else {
      // Grayscale / B&W photo or PDF: estimate local paper brightness via fast downsampled row/col background
      const lumArr = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) {
        lumArr[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
      }
      // Fast 1D horizontal + vertical box blur (radius 14) for local paper illumination
      const bgH = new Float32Array(W * H);
      const radBg = 14;
      for (let y = 0; y < H; y++) {
        const rowOff = y * W;
        let acc = 0;
        let cnt = 0;
        for (let x = 0; x <= Math.min(W - 1, radBg); x++) {
          acc += lumArr[rowOff + x];
          cnt++;
        }
        for (let x = 0; x < W; x++) {
          bgH[rowOff + x] = acc / Math.max(1, cnt);
          const addX = x + radBg + 1;
          const remX = x - radBg;
          if (addX < W) {
            acc += lumArr[rowOff + addX];
            cnt++;
          }
          if (remX >= 0) {
            acc -= lumArr[rowOff + remX];
            cnt--;
          }
        }
      }
      for (let i = 0; i < W * H; i++) {
        const diff = bgH[i] - lumArr[i];
        // Gray grid lines sit between subtle paper grain (diff > 5) and thick black ECG ink (diff < 115)
        if (diff > 5.0 && diff < 120.0) {
          const inkAtten = diff > 75.0 ? Math.max(0.25, 1.0 - (diff - 75.0) / 50.0) : 1.0;
          gridMap[i] = Math.min(1.0, ((diff - 5.0) / 48.0) * inkAtten);
        }
      }
    }

    // 3. O(1) prefix-sum directional arm responses for '+' cross detection
    const estPxPerMm =
      (state.digitization && state.digitization.pixel_spacing && state.digitization.pixel_spacing.px_per_mm) ||
      state.activePxPerMm ||
      5.5;
    const armLen = Math.max(6, Math.min(22, Math.round(2.1 * estPxPerMm)));

    // Row prefix sums & Col prefix sums
    const rowCum = new Float32Array((W + 1) * H);
    for (let y = 0; y < H; y++) {
      let s = 0;
      const rIn = y * W;
      const rOut = y * (W + 1);
      rowCum[rOut] = 0;
      for (let x = 0; x < W; x++) {
        s += gridMap[rIn + x];
        rowCum[rOut + x + 1] = s;
      }
    }

    const colCum = new Float32Array(W * (H + 1));
    for (let x = 0; x < W; x++) {
      let s = 0;
      colCum[x] = 0;
      for (let y = 0; y < H; y++) {
        s += gridMap[y * W + x];
        colCum[(y + 1) * W + x] = s;
      }
    }

    const crossScore = new Float32Array(W * H);
    const colProj = new Float64Array(W);
    const rowProj = new Float64Array(H);
    const invArm = 1.0 / armLen;

    for (let y = armLen; y < H - armLen; y++) {
      const rOut = y * (W + 1);
      for (let x = armLen; x < W - armLen; x++) {
        const left = (rowCum[rOut + x] - rowCum[rOut + x - armLen]) * invArm;
        const right = (rowCum[rOut + x + 1 + armLen] - rowCum[rOut + x + 1]) * invArm;
        const up = (colCum[y * W + x] - colCum[(y - armLen) * W + x]) * invArm;
        const down = (colCum[(y + 1 + armLen) * W + x] - colCum[(y + 1) * W + x]) * invArm;

        const hResp = 0.5 * (left + right);
        const vResp = 0.5 * (up + down);
        colProj[x] += vResp;
        rowProj[y] += hResp;

        const minArm = Math.min(left, right, up, down);
        if (hResp > 0.05 && vResp > 0.05) {
          crossScore[y * W + x] = Math.sqrt(hResp * vResp) * (0.45 + 0.55 * Math.sqrt(Math.max(0, minArm)));
        }
      }
    }

    // 4. Estimate 5mm major grid period Sx, Sy via 1D autocorrelation of colProj and rowProj
    const findPeriod = (proj, expStep) => {
      const n = proj.length;
      let mean = 0;
      for (let i = 0; i < n; i++) mean += proj[i];
      mean /= Math.max(1, n);
      const centered = new Float64Array(n);
      for (let i = 0; i < n; i++) centered[i] = proj[i] - mean;

      const lo = Math.max(10, Math.round(expStep * 0.65));
      const hi = Math.min(Math.floor(n * 0.25), Math.round(expStep * 1.45));
      let bestLag = Math.round(expStep);
      let bestAc = -1e18;
      for (let lag = lo; lag <= hi; lag++) {
        let sum = 0;
        const lim = n - lag;
        for (let i = 0; i < lim; i++) sum += centered[i] * centered[i + lag];
        const ac = sum / Math.max(1, lim);
        if (ac > bestAc) {
          bestAc = ac;
          bestLag = lag;
        }
      }
      return bestLag;
    };

    const exp5mm = 5.0 * estPxPerMm;
    const Sx = findPeriod(colProj, exp5mm);
    const Sy = findPeriod(rowProj, exp5mm);

    // Find best grid phase (x0, y0) in [0..Sx), [0..Sy)
    const findPhase = (proj, period) => {
      const n = proj.length;
      let bestP = 0;
      let bestSum = -1e18;
      for (let p = 0; p < period; p++) {
        let s = 0;
        let cnt = 0;
        for (let pos = p; pos < n; pos += period) {
          s += proj[pos];
          cnt++;
        }
        const avg = s / Math.max(1, cnt);
        if (avg > bestSum) {
          bestSum = avg;
          bestP = p;
        }
      }
      return bestP;
    };

    const phaseX = findPhase(colProj, Sx);
    const phaseY = findPhase(rowProj, Sy);

    // 5. Build 2D lattice (i, j) and snap each ideal intersection to the true '+' cross peak
    const colsCount = Math.floor((W - phaseX) / Sx);
    const rowsCount = Math.floor((H - phaseY) / Sy);
    const searchRadX = Math.max(4, Math.round(Sx * 0.36));
    const searchRadY = Math.max(4, Math.round(Sy * 0.36));

    // Find global max crossScore for normalization
    let maxCS = 1e-6;
    for (let i = 0; i < crossScore.length; i++) {
      if (crossScore[i] > maxCS) maxCS = crossScore[i];
    }

    const nodes = [];
    const nodeGrid = Array.from({ length: rowsCount }, () => new Array(colsCount).fill(null));
    const minScoreThr = maxCS * 0.14;

    for (let i = 0; i < rowsCount; i++) {
      const idealY = phaseY + i * Sy;
      if (idealY < armLen + 2 || idealY > H - armLen - 3) continue;
      for (let j = 0; j < colsCount; j++) {
        const idealX = phaseX + j * Sx;
        if (idealX < armLen + 2 || idealX > W - armLen - 3) continue;

        let bestV = -1;
        let bestX = idealX;
        let bestY = idealY;
        const y0 = Math.max(armLen, Math.round(idealY) - searchRadY);
        const y1 = Math.min(H - armLen - 1, Math.round(idealY) + searchRadY);
        const x0 = Math.max(armLen, Math.round(idealX) - searchRadX);
        const x1 = Math.min(W - armLen - 1, Math.round(idealX) + searchRadX);

        for (let y = y0; y <= y1; y++) {
          const rOff = y * W;
          for (let x = x0; x <= x1; x++) {
            const v = crossScore[rOff + x];
            if (v > bestV) {
              bestV = v;
              bestX = x;
              bestY = y;
            }
          }
        }

        if (bestV >= minScoreThr) {
          // Sub-pixel 3x3 centroid refinement
          let numX = 0, numY = 0, den = 0;
          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const yy = bestY + dy;
              const xx = bestX + dx;
              if (yy >= 0 && yy < H && xx >= 0 && xx < W) {
                const wv = crossScore[yy * W + xx];
                numX += xx * wv;
                numY += yy * wv;
                den += wv;
              }
            }
          }
          const rx = den > 0 ? numX / den : bestX;
          const ry = den > 0 ? numY / den : bestY;
          const node = {
            i,
            j,
            x: rx,
            y: ry,
            idealX,
            idealY,
            dx: rx - idealX,
            dy: ry - idealY,
            conf: Math.min(1.0, bestV / maxCS),
          };
          nodes.push(node);
          nodeGrid[i][j] = node;
        }
      }
    }

    // 6. Compute recovered calibrated scale & paper deformation telemetry from detected crosses
    const stepXs = [];
    const stepYs = [];
    for (let i = 0; i < rowsCount; i++) {
      for (let j = 0; j < colsCount; j++) {
        const cur = nodeGrid[i][j];
        if (!cur) continue;
        if (j + 1 < colsCount && nodeGrid[i][j + 1]) {
          stepXs.push(nodeGrid[i][j + 1].x - cur.x);
        }
        if (i + 1 < rowsCount && nodeGrid[i + 1][j]) {
          stepYs.push(nodeGrid[i + 1][j].y - cur.y);
        }
      }
    }
    const medianOf = (arr, fb) => {
      if (!arr.length) return fb;
      const s = arr.slice().sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    const medStepX = medianOf(stepXs, Sx);
    const medStepY = medianOf(stepYs, Sy);
    const pxPerMmX = medStepX / 5.0;
    const pxPerMmY = medStepY / 5.0;
    const pxPerMmAvg = 0.5 * (pxPerMmX + pxPerMmY);

    let sumSq = 0;
    let maxWarp = 0;
    nodes.forEach((nd) => {
      const mag = Math.hypot(nd.dx, nd.dy);
      sumSq += mag * mag;
      if (mag > maxWarp) maxWarp = mag;
    });
    const rmsWarpPx = nodes.length > 0 ? Math.sqrt(sumSq / nodes.length) : 0;
    const warpPct = (rmsWarpPx / Math.max(1, 0.5 * (medStepX + medStepY))) * 100.0;
    const anisotropyPct = (Math.abs(pxPerMmX - pxPerMmY) / Math.max(0.1, pxPerMmAvg)) * 100.0;

    state.gridNodesResult = {
      W,
      H,
      useRedGrid,
      detectedModeLabel,
      Sx: medStepX,
      Sy: medStepY,
      phaseX,
      phaseY,
      rowsCount,
      colsCount,
      pxPerMmX,
      pxPerMmY,
      pxPerMmAvg,
      rmsWarpPx,
      maxWarpPx: maxWarp,
      warpPct,
      anisotropyPct,
      nodes,
      nodeGrid,
    };

    if (el.gridNodesStatus) {
      el.gridNodesStatus.textContent =
        `${detectedModeLabel} • Крестиков: ${nodes.length} • Шаг: ${pxPerMmX.toFixed(2)}×${pxPerMmY.toFixed(2)} пикс/мм • ` +
        `Деформация листа: RMS ${rmsWarpPx.toFixed(1)} пикс (${warpPct.toFixed(1)}%), макс ${maxWarp.toFixed(1)} пикс`;
    }
    renderGridNodesCanvas();
    return state.gridNodesResult;
  }

  function renderGridNodesCanvas() {
    const img = el.imgGridNodesBase;
    const canvas = el.gridNodesCanvas;
    const res = state.gridNodesResult;
    if (!img || !canvas) return;

    const natW = img.naturalWidth || (res && res.W) || 1000;
    const natH = img.naturalHeight || (res && res.H) || 700;
    if (el.gridNodesStageWrap && el.gridNodesScrollBox) {
      const boxW = Math.max(320, (el.gridNodesScrollBox.clientWidth || 600) - 20);
      const targetW = Math.round(boxW * (state.gridNodesZoom || 1.0));
      el.gridNodesStageWrap.style.width = `${targetW}px`;
    }

    const rect = img.getBoundingClientRect();
    const dispW = rect.width > 20 ? rect.width : img.clientWidth || natW;
    const dispH = rect.height > 20 ? rect.height : img.clientHeight || natH;
    if (dispW < 10 || dispH < 10) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(dispW * dpr);
    canvas.height = Math.round(dispH * dpr);
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, dispW, dispH);

    if (!res) return;

    const scaleX = dispW / natW;
    const scaleY = dispH / natH;
    const showCrosses = !el.chkShowGridCrosses || el.chkShowGridCrosses.checked;
    const showMesh = !el.chkShowWarpMesh || el.chkShowWarpMesh.checked;
    const showVecs = !el.chkShowWarpVectors || el.chkShowWarpVectors.checked;

    // 1. Draw 2D Paper Deformation Mesh connecting adjacent detected crosses
    if (showMesh && res.nodeGrid) {
      ctx.save();
      ctx.strokeStyle = "rgba(0, 229, 255, 0.42)";
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      for (let i = 0; i < res.rowsCount; i++) {
        for (let j = 0; j < res.colsCount; j++) {
          const cur = res.nodeGrid[i][j];
          if (!cur) continue;
          const cx = cur.x * scaleX;
          const cy = cur.y * scaleY;
          if (j + 1 < res.colsCount && res.nodeGrid[i][j + 1]) {
            const nxt = res.nodeGrid[i][j + 1];
            ctx.moveTo(cx, cy);
            ctx.lineTo(nxt.x * scaleX, nxt.y * scaleY);
          }
          if (i + 1 < res.rowsCount && res.nodeGrid[i + 1][j]) {
            const btm = res.nodeGrid[i + 1][j];
            ctx.moveTo(cx, cy);
            ctx.lineTo(btm.x * scaleX, btm.y * scaleY);
          }
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    // 2. Draw Displacement Vectors from ideal flat grid -> deformed cross (amplified 2.0x for visibility)
    if (showVecs && res.nodes) {
      ctx.save();
      ctx.strokeStyle = "rgba(255, 64, 129, 0.85)";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      res.nodes.forEach((nd) => {
        const mag = Math.hypot(nd.dx, nd.dy);
        if (mag < 0.8) return;
        const ix = nd.idealX * scaleX;
        const iy = nd.idealY * scaleY;
        const tx = (nd.idealX + nd.dx * 2.0) * scaleX;
        const ty = (nd.idealY + nd.dy * 2.0) * scaleY;
        ctx.moveTo(ix, iy);
        ctx.lineTo(tx, ty);
      });
      ctx.stroke();
      ctx.restore();
    }

    // 3. Draw '+' Crosses at every detected grid intersection
    if (showCrosses && res.nodes) {
      ctx.save();
      const crossR = Math.max(3.5, Math.min(7.5, 4.5 * Math.sqrt(state.gridNodesZoom || 1.0)));
      res.nodes.forEach((nd) => {
        const cx = nd.x * scaleX;
        const cy = nd.y * scaleY;
        const mag = Math.hypot(nd.dx, nd.dy);
        ctx.strokeStyle = mag > 4.5 ? "#FF5252" : mag > 2.2 ? "#FFD740" : "#00E676";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx - crossR, cy);
        ctx.lineTo(cx + crossR, cy);
        ctx.moveTo(cx, cy - crossR);
        ctx.lineTo(cx, cy + crossR);
        ctx.stroke();
      });
      ctx.restore();
    }

    // 4. Top-right telemetry summary pill
    ctx.save();
    const txt = `Крестиков: ${res.nodes.length} • ${res.pxPerMmAvg.toFixed(2)} пикс/мм • RMS деформ.: ${res.rmsWarpPx.toFixed(1)} пикс (${res.warpPct.toFixed(1)}%)`;
    ctx.font = "600 11px 'IBM Plex Mono', monospace";
    const tw = ctx.measureText(txt).width + 16;
    const tx = Math.max(6, dispW - tw - 8);
    ctx.fillStyle = "rgba(15, 23, 42, 0.86)";
    ctx.fillRect(tx, 6, tw, 22);
    ctx.strokeStyle = "#00E676";
    ctx.lineWidth = 1;
    ctx.strokeRect(tx, 6, tw, 22);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(txt, tx + 8, 21);
    ctx.restore();
  }

  // 2D Piecewise Bilinear Dewarp of the ECG photo using detected '+' grid crosses
  async function rectifyPaperByGridCrosses() {
    const img = el.imgGridNodesBase;
    const res = state.gridNodesResult || detectGridIntersectionsAndDeformation();
    if (!img || !res || res.nodes.length < 6) {
      setStatus("Недостаточно крестиков сетки для распрямления листа", "error");
      return;
    }

    setStatus("Выполняется 2D-распрямление деформации бумаги по крестикам сетки...", "busy");
    const { W, H, rowsCount, colsCount, phaseX, phaseY, Sx, Sy, nodeGrid, pxPerMmAvg } = res;

    // Build complete (rowsCount x colsCount) displacement lattice (dx, dy), filling gaps from nearest detected crosses
    const dxLat = new Float32Array(rowsCount * colsCount);
    const dyLat = new Float32Array(rowsCount * colsCount);
    for (let i = 0; i < rowsCount; i++) {
      for (let j = 0; j < colsCount; j++) {
        const nd = nodeGrid[i][j];
        if (nd) {
          dxLat[i * colsCount + j] = nd.dx;
          dyLat[i * colsCount + j] = nd.dy;
        } else {
          // Inverse-distance weighted fill from nearby detected crosses
          let wSum = 0, sDx = 0, sDy = 0;
          for (let k = 0; k < res.nodes.length; k++) {
            const o = res.nodes[k];
            const d2 = (o.i - i) * (o.i - i) + (o.j - j) * (o.j - j);
            if (d2 <= 16) {
              const w = 1.0 / (d2 + 0.25);
              wSum += w;
              sDx += o.dx * w;
              sDy += o.dy * w;
            }
          }
          dxLat[i * colsCount + j] = wSum > 0 ? sDx / wSum : 0;
          dyLat[i * colsCount + j] = wSum > 0 ? sDy / wSum : 0;
        }
      }
    }

    // Read source image pixels
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = W;
    srcCanvas.height = H;
    const sCtx = srcCanvas.getContext("2d");
    sCtx.drawImage(img, 0, 0, W, H);
    const srcData = sCtx.getImageData(0, 0, W, H).data;

    const dstCanvas = document.createElement("canvas");
    dstCanvas.width = W;
    dstCanvas.height = H;
    const dCtx = dstCanvas.getContext("2d");
    const dstImg = dCtx.createImageData(W, H);
    const dstData = dstImg.data;

    // Inverse-warp every pixel (u, v) -> sample source at (u + dx(u,v), v + dy(u,v))
    const targetStep = 5.0 * pxPerMmAvg; // Make cells isotropic squares!
    for (let v = 0; v < H; v++) {
      const fi = (v - phaseY) / targetStep;
      const i0 = Math.max(0, Math.min(rowsCount - 1, Math.floor(fi)));
      const i1 = Math.max(0, Math.min(rowsCount - 1, i0 + 1));
      const ty = Math.max(0, Math.min(1, fi - i0));

      for (let u = 0; u < W; u++) {
        const fj = (u - phaseX) / targetStep;
        const j0 = Math.max(0, Math.min(colsCount - 1, Math.floor(fj)));
        const j1 = Math.max(0, Math.min(colsCount - 1, j0 + 1));
        const tx = Math.max(0, Math.min(1, fj - j0));

        const idx00 = i0 * colsCount + j0;
        const idx01 = i0 * colsCount + j1;
        const idx10 = i1 * colsCount + j0;
        const idx11 = i1 * colsCount + j1;

        const w00 = (1 - tx) * (1 - ty);
        const w01 = tx * (1 - ty);
        const w10 = (1 - tx) * ty;
        const w11 = tx * ty;

        const ddx = dxLat[idx00] * w00 + dxLat[idx01] * w01 + dxLat[idx10] * w10 + dxLat[idx11] * w11;
        const ddy = dyLat[idx00] * w00 + dyLat[idx01] * w01 + dyLat[idx10] * w10 + dyLat[idx11] * w11;

        // Also correct any X/Y anisotropy toward targetStep
        const sx = u * (Sx / targetStep) + ddx;
        const sy = v * (Sy / targetStep) + ddy;

        const x0 = Math.max(0, Math.min(W - 2, Math.floor(sx)));
        const y0 = Math.max(0, Math.min(H - 2, Math.floor(sy)));
        const fx = Math.max(0, Math.min(1, sx - x0));
        const fy = Math.max(0, Math.min(1, sy - y0));

        const p00 = (y0 * W + x0) * 4;
        const p01 = p00 + 4;
        const p10 = p00 + W * 4;
        const p11 = p10 + 4;

        const outP = (v * W + u) * 4;
        for (let c = 0; c < 3; c++) {
          const val =
            srcData[p00 + c] * (1 - fx) * (1 - fy) +
            srcData[p01 + c] * fx * (1 - fy) +
            srcData[p10 + c] * (1 - fx) * fy +
            srcData[p11 + c] * fx * fy;
          dstData[outP + c] = Math.round(val);
        }
        dstData[outP + 3] = 255;
      }
    }
    dCtx.putImageData(dstImg, 0, 0);

    const rectifiedBlob = await new Promise((resolve) => dstCanvas.toBlob(resolve, "image/png"));
    const rectFile = new File([rectifiedBlob], `rectified_${state.currentSource || "ecg"}.png`, { type: "image/png" });
    state.uploadedFile = rectFile;
    if (el.exampleDescription) {
      el.exampleDescription.textContent = `Выпрямлено по ${res.nodes.length} крестикам сетки (${pxPerMmAvg.toFixed(2)} пикс/мм, RMS был ${res.rmsWarpPx.toFixed(1)} пикс)`;
    }
    await runDigitization(Number(pxPerMmAvg.toFixed(2)));
    setStatus(`Лист выпрямлен по ${res.nodes.length} крестикам, масштаб ${pxPerMmAvg.toFixed(2)} пикс/мм применён`, "ready");
  }

  // Remove grid lines, shadows & uneven paper illumination artifacts while preserving dark ECG traces
  async function cleanGridAndLightingArtifacts() {
    const img = el.imgGridNodesBase;
    const res = state.gridNodesResult || detectGridIntersectionsAndDeformation();
    if (!img || !res) return;

    setStatus("Удаление артефактов сетки, теней и выравнивание фона бумаги...", "busy");
    const { W, H, useRedGrid } = res;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, W, H);
    const imgData = ctx.getImageData(0, 0, W, H);
    const d = imgData.data;

    // Estimate local illumination envelope via 1D horizontal box filter (radius 24)
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }
    const bg = new Float32Array(W * H);
    const rad = 22;
    for (let y = 0; y < H; y++) {
      const off = y * W;
      let acc = 0, cnt = 0;
      for (let x = 0; x <= Math.min(W - 1, rad); x++) {
        acc += lum[off + x];
        cnt++;
      }
      for (let x = 0; x < W; x++) {
        bg[off + x] = acc / Math.max(1, cnt);
        if (x + rad + 1 < W) { acc += lum[off + x + rad + 1]; cnt++; }
        if (x - rad >= 0) { acc -= lum[off + x - rad]; cnt--; }
      }
    }

    for (let i = 0; i < W * H; i++) {
      const r = d[i * 4];
      const g = d[i * 4 + 1];
      const b = d[i * 4 + 2];
      const l = lum[i];
      const localBg = Math.max(85, bg[i]);
      const redEx = r - 0.52 * g - 0.48 * b;
      const isColoredGrid = useRedGrid && redEx > 6 && l > 65;

      // Normalize illumination so shadows & uneven paper lighting become clean white (252)
      let norm = Math.min(255, Math.max(0, (l / localBg) * 248));
      if (isColoredGrid) {
        norm = 250;
      } else if (!useRedGrid && localBg - l < 42) {
        // Suppress light gray grid lines on B&W scans while preserving darker ECG waveforms
        norm = 250;
      } else if (norm < 210) {
        // Sharpen dark ECG ink trace contrast
        norm = Math.max(0, (norm - 40) * 1.15);
      } else {
        norm = 252;
      }
      const v = Math.round(Math.max(0, Math.min(255, norm)));
      d[i * 4] = v;
      d[i * 4 + 1] = v;
      d[i * 4 + 2] = v;
      d[i * 4 + 3] = 255;
    }

    ctx.putImageData(imgData, 0, 0);
    const cleanedBlob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
    const cleanFile = new File([cleanedBlob], `cleaned_${state.currentSource || "ecg"}.png`, { type: "image/png" });
    state.uploadedFile = cleanFile;
    await runDigitization(Number(res.pxPerMmAvg.toFixed(2)));
    setStatus("Артефакты сетки и тени удалены, сигнал пересчитан", "ready");
  }

  function bindGridNodesEvents() {
    const setGridZoom = (z) => {
      state.gridNodesZoom = Math.max(1.0, Math.min(4.0, z));
      if (el.selectGridNodesZoom) {
        const opts = Array.from(el.selectGridNodesZoom.options).map((o) => parseFloat(o.value));
        const nearest = opts.reduce((a, b) => (Math.abs(b - state.gridNodesZoom) < Math.abs(a - state.gridNodesZoom) ? b : a));
        el.selectGridNodesZoom.value = String(nearest);
      }
      renderGridNodesCanvas();
    };

    if (el.selectGridNodesZoom) {
      el.selectGridNodesZoom.addEventListener("change", () => setGridZoom(parseFloat(el.selectGridNodesZoom.value) || 1.0));
    }
    if (el.btnGridNodesZoomOut) {
      el.btnGridNodesZoomOut.addEventListener("click", () => setGridZoom((state.gridNodesZoom || 1.0) - 0.5));
    }
    if (el.btnGridNodesZoomIn) {
      el.btnGridNodesZoomIn.addEventListener("click", () => setGridZoom((state.gridNodesZoom || 1.0) + 0.5));
    }
    if (el.selectGridColorMode) {
      el.selectGridColorMode.addEventListener("change", () => detectGridIntersectionsAndDeformation());
    }
    if (el.btnDetectGridCrosses) {
      el.btnDetectGridCrosses.addEventListener("click", () => detectGridIntersectionsAndDeformation());
    }
    if (el.btnRectifyByCrosses) {
      el.btnRectifyByCrosses.addEventListener("click", () => rectifyPaperByGridCrosses());
    }
    if (el.btnCleanGridArtifacts) {
      el.btnCleanGridArtifacts.addEventListener("click", () => cleanGridAndLightingArtifacts());
    }
    if (el.btnResetGridRectify) {
      el.btnResetGridRectify.addEventListener("click", () => {
        // Restore the ORIGINAL source (user upload or PDF page) instead of silently falling back to the example list
        state.uploadedFile = state.sourceFile || null;
        if (el.exampleDescription) {
          el.exampleDescription.textContent = state.sourceFile
            ? `Восстановлен исходный файл: ${state.sourceFile.name}`
            : "Восстановлено исходное изображение примера";
        }
        runDigitization(null);
      });
    }
    if (el.chkShowGridCrosses) el.chkShowGridCrosses.addEventListener("change", () => renderGridNodesCanvas());
    if (el.chkShowWarpMesh) el.chkShowWarpMesh.addEventListener("change", () => renderGridNodesCanvas());
    if (el.chkShowWarpVectors) el.chkShowWarpVectors.addEventListener("change", () => renderGridNodesCanvas());

    // Drag-to-pan on gridNodesScrollBox
    if (el.gridNodesCanvas && el.gridNodesScrollBox) {
      el.gridNodesCanvas.addEventListener("mousedown", (evt) => {
        state.gridNodesPanState = {
          startX: evt.clientX,
          startY: evt.clientY,
          scrollL: el.gridNodesScrollBox.scrollLeft,
          scrollT: el.gridNodesScrollBox.scrollTop,
        };
        el.gridNodesCanvas.style.cursor = "grabbing";
      });
      window.addEventListener("mousemove", (evt) => {
        if (!state.gridNodesPanState) return;
        el.gridNodesScrollBox.scrollLeft = state.gridNodesPanState.scrollL - (evt.clientX - state.gridNodesPanState.startX);
        el.gridNodesScrollBox.scrollTop = state.gridNodesPanState.scrollT - (evt.clientY - state.gridNodesPanState.startY);
      });
      window.addEventListener("mouseup", () => {
        if (state.gridNodesPanState) {
          state.gridNodesPanState = null;
          el.gridNodesCanvas.style.cursor = "grab";
        }
      });
      el.gridNodesScrollBox.addEventListener("wheel", (evt) => {
        if (evt.ctrlKey) {
          evt.preventDefault();
          setGridZoom((state.gridNodesZoom || 1.0) + (evt.deltaY < 0 ? 0.5 : -0.5));
        }
      }, { passive: false });
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // Backend per-lead trust score: { level: ok|warn|bad|manual, score, issues[] } → class + tooltip text
  function leadQualityInfo(leadName) {
    const q = state.digitization && state.digitization.lead_quality && state.digitization.lead_quality[leadName];
    if (!q) return { level: "", title: "" };
    const label = { ok: "Качество трассировки: хорошее", warn: "Качество трассировки: сомнительное", bad: "Качество трассировки: плохое — проверьте линию", manual: "Линия исправлена вручную" }[q.level] || "";
    const score = typeof q.score === "number" ? ` (${Math.round(q.score * 100)}%)` : "";
    const issues = (q.issues || []).map((t) => `• ${t}`).join("\n");
    return { level: q.level, title: `${label}${score}${issues ? "\n" + issues : ""}` };
  }

  function buildLeadPills(leadNames) {
    el.leadPillsContainer.innerHTML = "";
    leadNames.forEach((ln) => {
      const btn = document.createElement("button");
      btn.type = "button";
      const qi = leadQualityInfo(ln);
      btn.className = "lead-pill" + (ln === state.activeLead ? " active" : "") + (qi.level && qi.level !== "ok" ? ` q-${qi.level}` : "");
      btn.textContent = ln;
      if (qi.title) btn.title = qi.title;
      btn.addEventListener("click", () => selectLead(ln));
      el.leadPillsContainer.appendChild(btn);
    });
  }

  // 1-mV calibration pulse: offer to re-digitize with the gain the pulse actually shows
  function renderCalPulseActions() {
    if (!el.calPulseActions) return;
    const cp = state.digitization && state.digitization.calibration_pulse;
    if (!cp || cp.status !== "mismatch") {
      el.calPulseActions.hidden = true;
      return;
    }
    const entered = cp.entered_gain_mm_mv;
    const sugg = cp.suggested_gain_mm_mv;
    el.calPulseText.textContent =
      `Калибровочный импульс 1 мВ = ${cp.height_mm.toFixed(1)} мм, а задано ${entered} мм/мВ` +
      (sugg ? ` — вероятно, запись сделана с усилением ${sugg} мм/мВ.` : ". Проверьте усиление.");
    el.btnApplyPulseGain.hidden = !sugg || state.staticMode;
    el.btnApplyPulseGain.textContent = sugg ? `Применить ${sugg} мм/мВ и пересчитать` : "Применить";
    el.calPulseActions.hidden = false;
  }

  function getLeadTotalMs(leadName) {
    if (!state.digitization || !state.digitization.leads_mv || !state.digitization.leads_mv[leadName]) return 2500;
    const fs = state.digitization.sampling_rate_hz || 500;
    return (state.digitization.leads_mv[leadName].length * 1000.0) / fs;
  }

  function isTimeInArtifact(leadName, tMs) {
    const zones = (state.artifactsByLead && state.artifactsByLead[leadName]) || [];
    return zones.some((z) => tMs >= z.startMs - 2 && tMs <= z.endMs + 2);
  }

  function isIntervalInArtifact(leadName, t1Ms, t2Ms) {
    const lo = Math.min(t1Ms, t2Ms);
    const hi = Math.max(t1Ms, t2Ms);
    const zones = (state.artifactsByLead && state.artifactsByLead[leadName]) || [];
    return zones.some((z) => Math.min(hi, z.endMs) - Math.max(lo, z.startMs) > 6);
  }

  function getCleanLeadRRStats(leadName) {
    const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[leadName];
    if (!leadAna) return { cleanRRs: [], medianRR: 800, cleanBeatsCount: 0, totalRCount: 0 };
    const beats = leadAna.beats || [];
    const rList = beats.map((b) => (b.times_ms ? b.times_ms.r_peak : 0));
    const cleanRRs = [];
    let cleanBeatsCount = 0;
    for (let i = 0; i < rList.length; i++) {
      if (!isTimeInArtifact(leadName, rList[i])) {
        cleanBeatsCount++;
      }
      if (i + 1 < rList.length) {
        const r1 = rList[i];
        const r2 = rList[i + 1];
        const dt = r2 - r1;
        if (dt >= 240 && dt <= 2400 && !isIntervalInArtifact(leadName, r1, r2)) {
          cleanRRs.push(dt);
        }
      }
    }
    let medianRR = (leadAna.hrv && leadAna.hrv.median_rr_ms) || (state.analysis && state.analysis.global_rr_ms) || 800;
    if (cleanRRs.length > 0) {
      const sorted = [...cleanRRs].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      medianRR = sorted.length % 2 !== 0 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
    }
    return { cleanRRs, medianRR, cleanBeatsCount, totalRCount: rList.length };
  }

  function syncLeadRArrayFromBeats(leadName) {
    const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[leadName];
    if (!leadAna || !leadAna.beats) return;
    const fs = (state.digitization && state.digitization.sampling_rate_hz) || 500;
    const totalMs = getLeadTotalMs(leadName);

    // Sort beats chronologically by r_peak
    leadAna.beats.sort((a, b) => (a.times_ms.r_peak || 0) - (b.times_ms.r_peak || 0));

    const stats = getCleanLeadRRStats(leadName);
    leadAna.r_peaks_ms = [];
    leadAna.r_peaks = [];
    leadAna.beats.forEach((b, idx) => {
      const rMs = Math.max(0, Math.min(totalMs, b.times_ms.r_peak));
      b.times_ms.r_peak = rMs;
      b.r_peak = Math.round((rMs * fs) / 1000.0);
      leadAna.r_peaks_ms.push(rMs);
      leadAna.r_peaks.push(b.r_peak);
      if (idx + 1 < leadAna.beats.length) {
        b.times_ms.next_r_peak = leadAna.beats[idx + 1].times_ms.r_peak;
      } else {
        b.times_ms.next_r_peak = Math.min(totalMs, rMs + stats.medianRR);
      }
    });

    const refreshedStats = getCleanLeadRRStats(leadName);
    if (!leadAna.hrv) leadAna.hrv = {};
    leadAna.hrv.median_rr_ms = refreshedStats.medianRR;
    leadAna.rr_intervals_ms = refreshedStats.cleanRRs;
  }

  function updateRAndArtifactStatusBar() {
    if (!el.lblRAndArtifactStatus || !state.analysis) return;
    const ln = state.activeLead;
    const stats = getCleanLeadRRStats(ln);
    const zones = (state.artifactsByLead && state.artifactsByLead[ln]) || [];
    if (zones.length === 0) {
      el.lblRAndArtifactStatus.textContent = `Канал ${ln}: меток R = ${stats.totalRCount} (чистых интервалов RR: ${stats.cleanRRs.length}) • Артефакты: нет`;
    } else {
      const zText = zones.map((z) => `[${z.startMs.toFixed(0)}–${z.endMs.toFixed(0)} мс]`).join(", ");
      el.lblRAndArtifactStatus.textContent =
        `Канал ${ln}: меток R = ${stats.totalRCount} (чистых RR: ${stats.cleanRRs.length}) • ▬▬ Исключено артефактов (${zones.length}): ${zText}`;
    }
  }

  function populateBeatDropdown(leadName) {
    const leadAna = (state.analysis && state.analysis.leads && state.analysis.leads[leadName]) || null;
    el.selectBeat.innerHTML = "";
    if (leadAna && leadAna.beats && leadAna.beats.length > 0) {
      leadAna.beats.forEach((b, idx) => {
        const opt = document.createElement("option");
        opt.value = String(idx);
        const rMs = b.times_ms ? b.times_ms.r_peak : 0;
        const inArt = isTimeInArtifact(leadName, rMs);
        opt.textContent = `R#${idx + 1} (${rMs.toFixed(0)} мс)${inArt ? " [Артефакт]" : ""}`;
        el.selectBeat.appendChild(opt);
      });
      state.activeBeatIdx = Math.max(0, Math.min(state.activeBeatIdx, leadAna.beats.length - 1));
      el.selectBeat.value = String(state.activeBeatIdx);
    } else {
      const opt = document.createElement("option");
      opt.value = "0";
      opt.textContent = "R#1";
      el.selectBeat.appendChild(opt);
      state.activeBeatIdx = 0;
    }
    updateRAndArtifactStatusBar();
  }

  function createBeatAtMs(leadName, rMs) {
    const fs = (state.digitization && state.digitization.sampling_rate_hz) || 500;
    const totalMs = getLeadTotalMs(leadName);
    const clampedR = Math.max(10, Math.min(totalMs - 10, Math.round(rMs)));
    return {
      r_peak: Math.round((clampedR * fs) / 1000.0),
      times_ms: {
        p_onset: Math.max(0, clampedR - 155),
        p_peak: Math.max(0, clampedR - 110),
        p_offset: Math.max(0, clampedR - 65),
        qrs_onset: Math.max(0, clampedR - 38),
        q_peak: Math.max(0, clampedR - 18),
        r_peak: clampedR,
        s_peak: Math.min(totalMs, clampedR + 22),
        qrs_offset: Math.min(totalMs, clampedR + 48),
        st_60: Math.min(totalMs, clampedR + 108),
        st_80: Math.min(totalMs, clampedR + 128),
        t_onset: Math.min(totalMs, clampedR + 105),
        t_peak: Math.min(totalMs, clampedR + 185),
        t_offset: Math.min(totalMs, clampedR + 265),
        next_r_peak: Math.min(totalMs, clampedR + 700),
      },
    };
  }

  function applyToTargetLeads(primaryLead, fn) {
    const syncAll = el.chkSyncChannels && el.chkSyncChannels.checked;
    if (syncAll && state.analysis && state.analysis.leads) {
      const refTotal = getLeadTotalMs(primaryLead);
      Object.keys(state.analysis.leads).forEach((ln) => {
        if (Math.abs(getLeadTotalMs(ln) - refTotal) < 120) {
          fn(ln);
        }
      });
    } else {
      fn(primaryLead);
    }
  }

  // Moves one R peak (with its whole P-QRS-T) and returns the beat's NEW index after chronological re-sorting,
  // so drag handlers can keep following the same beat when it is dragged past a neighbouring R.
  function moveRPeak(leadName, beatIdx, newRMs) {
    const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[leadName];
    if (!leadAna || !leadAna.beats || !leadAna.beats[beatIdx]) return -1;
    const totalMs = getLeadTotalMs(leadName);
    const clampedMs = Math.max(5, Math.min(totalMs - 5, Math.round(newRMs)));
    const beat = leadAna.beats[beatIdx];
    // Remember which beat is active so dragging R_+1 (the NEXT beat) never switches the active beat
    const activeBeatObj = leadName === state.activeLead ? leadAna.beats[state.activeBeatIdx] : null;
    const oldMs = beat.times_ms.r_peak;
    const delta = clampedMs - oldMs;

    // Shift fiducials of this beat along with R peak
    ["p_onset", "p_peak", "p_offset", "qrs_onset", "q_peak", "r_peak", "s_peak", "qrs_offset", "st_60", "st_80", "t_onset", "t_peak", "t_offset"].forEach((k) => {
      if (beat.times_ms[k] !== undefined) {
        beat.times_ms[k] = Math.max(0, Math.min(totalMs, beat.times_ms[k] + delta));
      }
    });
    beat.times_ms.r_peak = clampedMs;

    syncLeadRArrayFromBeats(leadName);
    const newIdx = leadAna.beats.indexOf(beat);
    if (leadName === state.activeLead) {
      const activeIdx = activeBeatObj ? leadAna.beats.indexOf(activeBeatObj) : -1;
      if (activeIdx >= 0) state.activeBeatIdx = activeIdx;
      else if (newIdx >= 0) state.activeBeatIdx = newIdx;
      populateBeatDropdown(leadName);
      loadBeatCalipers(leadName, state.activeBeatIdx);
    } else {
      renderMultiLeadCanvas();
      renderAllLeadsTable();
    }
    return newIdx;
  }

  function addRPeak(leadName, clickMs) {
    applyToTargetLeads(leadName, (ln) => {
      const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[ln];
      if (!leadAna) return;
      if (!leadAna.beats) leadAna.beats = [];
      // Optional local snap within ±22 ms to nearest signal extremum
      const fs = (state.digitization && state.digitization.sampling_rate_hz) || 500;
      const sig = state.digitization.leads_mv[ln] || [];
      const centerIdx = Math.round((clickMs * fs) / 1000.0);
      const rad = Math.round(0.022 * fs);
      let bestIdx = Math.max(0, Math.min(sig.length - 1, centerIdx));
      let bestVal = -1;
      for (let i = Math.max(0, centerIdx - rad); i <= Math.min(sig.length - 1, centerIdx + rad); i++) {
        if (Math.abs(sig[i]) > bestVal) {
          bestVal = Math.abs(sig[i]);
          bestIdx = i;
        }
      }
      const snappedMs = Math.round((bestIdx * 1000.0) / fs);
      const newBeat = createBeatAtMs(ln, snappedMs);
      leadAna.beats.push(newBeat);
      syncLeadRArrayFromBeats(ln);
      if (ln === state.activeLead) {
        state.activeBeatIdx = leadAna.beats.indexOf(newBeat);
      }
    });

    if (leadName !== state.activeLead) {
      selectLead(leadName);
    } else {
      populateBeatDropdown(state.activeLead);
      loadBeatCalipers(state.activeLead, state.activeBeatIdx);
      renderMultiLeadCanvas();
      renderAllLeadsTable();
    }
    setStatus(`Добавлена метка R на канале ${leadName} (${clickMs.toFixed(0)} мс)`, "ready");
  }

  function deleteRPeak(leadName, beatIdx) {
    const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[leadName];
    if (!leadAna || !leadAna.beats || leadAna.beats.length <= 1) {
      setStatus("На канале должна остаться хотя бы 1 метка R", "busy");
      return;
    }
    const targetMs = leadAna.beats[beatIdx] ? leadAna.beats[beatIdx].times_ms.r_peak : 0;

    applyToTargetLeads(leadName, (ln) => {
      const lAna = state.analysis && state.analysis.leads && state.analysis.leads[ln];
      if (!lAna || !lAna.beats || lAna.beats.length <= 1) return;
      let delIdx = beatIdx;
      if (ln !== leadName) {
        // Find closest R peak within 60 ms
        let bestD = 65;
        delIdx = -1;
        lAna.beats.forEach((b, idx) => {
          const d = Math.abs(b.times_ms.r_peak - targetMs);
          if (d < bestD) {
            bestD = d;
            delIdx = idx;
          }
        });
      }
      if (delIdx >= 0 && delIdx < lAna.beats.length) {
        lAna.beats.splice(delIdx, 1);
        syncLeadRArrayFromBeats(ln);
      }
    });

    state.activeBeatIdx = Math.max(0, Math.min(state.activeBeatIdx, leadAna.beats.length - 1));
    populateBeatDropdown(state.activeLead);
    loadBeatCalipers(state.activeLead, state.activeBeatIdx);
    renderMultiLeadCanvas();
    renderAllLeadsTable();
    setStatus(`Удалена метка R (${targetMs.toFixed(0)} мс)`, "ready");
  }

  function addOrToggleArtifactZone(leadName, t1Ms, t2Ms, forceAdd = false) {
    const totalMs = getLeadTotalMs(leadName);
    const sMs = Math.max(0, Math.min(totalMs, Math.round(Math.min(t1Ms, t2Ms))));
    const eMs = Math.max(0, Math.min(totalMs, Math.round(Math.max(t1Ms, t2Ms))));
    if (eMs - sMs < 15) return;

    applyToTargetLeads(leadName, (ln) => {
      if (!state.artifactsByLead[ln]) state.artifactsByLead[ln] = [];
      const zones = state.artifactsByLead[ln];
      // Check if an identical or heavily overlapping zone exists
      const existingIdx = zones.findIndex(
        (z) => Math.abs(z.startMs - sMs) < 25 && Math.abs(z.endMs - eMs) < 25
      );
      if (existingIdx >= 0 && !forceAdd) {
        zones.splice(existingIdx, 1);
      } else if (existingIdx < 0) {
        zones.push({ startMs: sMs, endMs: eMs });
        zones.sort((a, b) => a.startMs - b.startMs);
      }
      syncLeadRArrayFromBeats(ln);
    });

    populateBeatDropdown(state.activeLead);
    recalculateLiveMetricsAndRender();
    renderMultiLeadCanvas();
    renderAllLeadsTable();
  }

  function toggleSmartArtifactAtClick(leadName, clickMs) {
    if (!state.artifactsByLead[leadName]) state.artifactsByLead[leadName] = [];
    const zones = state.artifactsByLead[leadName];
    // 1. If click is inside an existing blue artifact line, remove it!
    const hitIdx = zones.findIndex((z) => clickMs >= z.startMs - 10 && clickMs <= z.endMs + 10);
    if (hitIdx >= 0) {
      const removed = zones[hitIdx];
      applyToTargetLeads(leadName, (ln) => {
        if (!state.artifactsByLead[ln]) return;
        state.artifactsByLead[ln] = state.artifactsByLead[ln].filter(
          (z) => !(Math.abs(z.startMs - removed.startMs) < 30 && Math.abs(z.endMs - removed.endMs) < 30)
        );
        syncLeadRArrayFromBeats(ln);
      });
      populateBeatDropdown(state.activeLead);
      recalculateLiveMetricsAndRender();
      renderMultiLeadCanvas();
      renderAllLeadsTable();
      setStatus(`Снята метка артефакта [${removed.startMs.toFixed(0)}–${removed.endMs.toFixed(0)} мс]`, "ready");
      return;
    }

    // 2. Otherwise determine interval [R_i, R_{i+1}], [R_last, totalMs], or [0, R_1] containing clickMs
    const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[leadName];
    const totalMs = getLeadTotalMs(leadName);
    const rList = (leadAna && leadAna.beats ? leadAna.beats.map((b) => b.times_ms.r_peak) : []).sort((a, b) => a - b);

    let sMs = 0;
    let eMs = totalMs;
    if (rList.length === 0) {
      sMs = Math.max(0, clickMs - 200);
      eMs = Math.min(totalMs, clickMs + 200);
    } else if (clickMs >= rList[rList.length - 1]) {
      // From last R to end of signal
      sMs = rList[rList.length - 1];
      eMs = totalMs;
    } else if (clickMs <= rList[0]) {
      // From start of signal to first R
      sMs = 0;
      eMs = rList[0];
    } else {
      for (let i = 0; i < rList.length - 1; i++) {
        if (clickMs >= rList[i] && clickMs <= rList[i + 1]) {
          sMs = rList[i];
          eMs = rList[i + 1];
          break;
        }
      }
    }

    addOrToggleArtifactZone(leadName, sMs, eMs, true);
    setStatus(`Участок [${sMs.toFixed(0)}–${eMs.toFixed(0)} мс] помечен как артефакт (исключён из анализа)`, "ready");
  }

  function selectLead(leadName) {
    if (!state.digitization || !state.digitization.leads_mv[leadName]) return;
    state.activeLead = leadName;
    el.lblActiveLead.textContent = leadName;

    // Highlight active pill
    Array.from(el.leadPillsContainer.children).forEach((btn) => {
      btn.classList.toggle("active", btn.textContent === leadName);
    });

    const leadAna = (state.analysis && state.analysis.leads && state.analysis.leads[leadName]) || null;
    if (leadAna && leadAna.beats && leadAna.beats.length > 0) {
      state.activeBeatIdx = Math.min(leadAna.representative_beat_index || 0, leadAna.beats.length - 1);
      populateBeatDropdown(leadName);
      loadBeatCalipers(leadName, state.activeBeatIdx);
    } else {
      populateBeatDropdown(leadName);
    }

    renderMultiLeadCanvas();
    renderAllLeadsTable();
  }

  function loadBeatCalipers(leadName, beatIdx) {
    const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[leadName];
    if (!leadAna) return;
    const beat = (leadAna.beats && leadAna.beats[beatIdx]) || null;
    const tms = (beat && beat.times_ms) || leadAna.calipers_ms || {};
    const fs = (state.digitization && state.digitization.sampling_rate_hz) || 500;
    const sig = state.digitization.leads_mv[leadName] || [];
    const totalMs = (sig.length * 1000) / fs;

    const rPeak = tms.r_peak !== undefined ? tms.r_peak : totalMs * 0.4;
    const medRr = (leadAna.hrv && leadAna.hrv.median_rr_ms) || state.analysis.global_rr_ms || 800;
    const nextR = tms.next_r_peak !== undefined ? tms.next_r_peak : Math.min(totalMs, rPeak + medRr);

    state.calipersMs = {
      p_onset: tms.p_onset !== undefined ? tms.p_onset : Math.max(0, rPeak - 160),
      p_peak: tms.p_peak !== undefined ? tms.p_peak : Math.max(0, rPeak - 115),
      p_offset: tms.p_offset !== undefined ? tms.p_offset : Math.max(0, rPeak - 70),
      qrs_onset: tms.qrs_onset !== undefined ? tms.qrs_onset : Math.max(0, rPeak - 40),
      r_peak: rPeak,
      qrs_offset: tms.qrs_offset !== undefined ? tms.qrs_offset : Math.min(totalMs, rPeak + 48),
      t_onset: tms.t_onset !== undefined ? tms.t_onset : Math.min(totalMs, rPeak + 115),
      t_peak: tms.t_peak !== undefined ? tms.t_peak : Math.min(totalMs, rPeak + 205),
      t_offset: tms.t_offset !== undefined ? tms.t_offset : Math.min(totalMs, rPeak + 295),
      next_r_peak: nextR,
    };

    // Initialize free caliper around QRS-T of current beat
    state.freeCalipers.t1_ms = state.calipersMs.qrs_onset;
    state.freeCalipers.t2_ms = state.calipersMs.t_offset;
    state.freeCalipers.v1_mv = 0.0;
    state.freeCalipers.v2_mv = 1.0;

    state.panOffsetMs = 0;
    syncNumericalInputsFromCalipers();
    recalculateLiveMetricsAndRender();
  }

  function syncNumericalInputsFromCalipers() {
    FIDUCIAL_DEFS.forEach((fd) => {
      const inp = document.getElementById(`num_${fd.key}`);
      if (inp && state.calipersMs[fd.key] !== undefined) {
        inp.value = state.calipersMs[fd.key].toFixed(0);
      }
    });
  }

  // Client-side 60fps real-time clinical interval & amplitude math engine (active lead + active calipers)
  function computeLiveMetricsClient() {
    if (!state.digitization) return null;
    return computeLeadMetricsClient(state.activeLead, state.calipersMs);
  }

  // Same math for ANY lead and any set of fiducial times (ms) — used for non-active leads, static mode,
  // and after re-calibration so every lead in the summary table is computed the same way.
  function computeLeadMetricsClient(leadName, c) {
    if (!state.digitization || !c) return null;
    const sig = state.digitization.leads_mv[leadName] || [];
    const fs = state.digitization.sampling_rate_hz || 500;

    const p_on = c.p_onset;
    const p_pk = c.p_peak;
    const p_off = c.p_offset;
    const qrs_on = c.qrs_onset;
    const r_pk = c.r_peak;
    const qrs_off = c.qrs_offset;
    const t_on = c.t_onset;
    const t_pk = c.t_peak;
    const t_off = c.t_offset;
    const next_r = c.next_r_peak;

    const cleanStats = getCleanLeadRRStats(leadName);
    const currentIntervalIsArtifact = isIntervalInArtifact(leadName, r_pk, next_r) || isTimeInArtifact(leadName, r_pk);

    let rr_ms =
      !currentIntervalIsArtifact && next_r > r_pk + 200
        ? next_r - r_pk
        : cleanStats.medianRR || (state.analysis ? state.analysis.global_rr_ms : 800);
    rr_ms = Math.max(250, rr_ms);
    const rr_sec = rr_ms / 1000.0;
    const hr_bpm = 60000.0 / rr_ms;

    const p_dur = Math.max(0, p_off - p_on);
    const pq_int = Math.max(0, qrs_on - p_on);
    const pq_seg = Math.max(0, qrs_on - p_off);
    const qrs_dur = Math.max(0, qrs_off - qrs_on);
    const vat_ms = Math.max(0, r_pk - qrs_on);
    const st_seg = Math.max(0, t_on - qrs_off);
    const t_dur = Math.max(0, t_off - t_on);
    const qt_int = Math.max(0, t_off - qrs_on);
    const jt_int = Math.max(0, qt_int - qrs_dur);
    const tpte_ms = Math.max(0, t_off - t_pk);
    const tpte_qt = qt_int > 0 ? tpte_ms / qt_int : 0;
    const tp_seg = Math.max(0, rr_ms - (t_off - p_on));
    const macruz = pq_seg > 5 ? p_dur / pq_seg : null;

    const qtc_b = qt_int / Math.sqrt(rr_sec);
    const qtc_f = qt_int / Math.cbrt(rr_sec);
    const qtc_fram = qt_int + 154.0 * (1.0 - rr_sec);
    const qtc_h = qt_int + 1.75 * (hr_bpm - 60.0);
    const jtc_b = Math.max(0, qtc_b - qrs_dur);

    // Sample voltage helper
    const n = sig.length;
    const sampleAtMs = (ms) => {
      if (n === 0) return 0;
      const idx = Math.max(0, Math.min(n - 1, Math.round((ms * fs) / 1000.0)));
      return sig[idx] || 0;
    };

    // Isoelectric level: MEDIAN of the 25 ms PR segment before qrs_on (same estimator as the Python backend,
    // robust to a sample of the QRS upstroke leaking into the window)
    const idxQrsOn = Math.max(0, Math.min(n - 1, Math.round((qrs_on * fs) / 1000.0)));
    const idxIsoLo = Math.max(0, idxQrsOn - Math.round(0.025 * fs));
    const isoVals = [];
    for (let i = idxIsoLo; i <= idxQrsOn && i < n; i++) isoVals.push(sig[i]);
    isoVals.sort((a, b) => a - b);
    const iso_mv = isoVals.length > 0
      ? (isoVals.length % 2 ? isoVals[(isoVals.length - 1) / 2] : 0.5 * (isoVals[isoVals.length / 2 - 1] + isoVals[isoVals.length / 2]))
      : 0;

    // QRS min/max
    const idxQrsOff = Math.max(idxQrsOn, Math.min(n - 1, Math.round((qrs_off * fs) / 1000.0)));
    const idxRPk = Math.max(idxQrsOn, Math.min(idxQrsOff, Math.round((r_pk * fs) / 1000.0)));
    let r_amp = sampleAtMs(r_pk) - iso_mv;
    let q_amp = 0;
    let s_amp = 0;
    for (let i = idxQrsOn; i <= idxRPk && i < n; i++) {
      q_amp = Math.min(q_amp, sig[i] - iso_mv);
      r_amp = Math.max(r_amp, sig[i] - iso_mv);
    }
    for (let i = idxRPk; i <= idxQrsOff && i < n; i++) {
      s_amp = Math.min(s_amp, sig[i] - iso_mv);
      r_amp = Math.max(r_amp, sig[i] - iso_mv);
    }

    const p_amp = sampleAtMs(p_pk) - iso_mv;
    const j_mv = sampleAtMs(qrs_off) - iso_mv;
    const st60_mv = sampleAtMs(qrs_off + 60) - iso_mv;
    const st80_mv = sampleAtMs(qrs_off + 80) - iso_mv;
    const t_amp = sampleAtMs(t_pk) - iso_mv;
    const st_slope = (st80_mv - j_mv) / 0.08;

    return {
      hr_bpm,
      rr_ms,
      durations_ms: { p_wave: p_dur, qrs_complex: qrs_dur, t_wave: t_dur, intrinsicoid_vat: vat_ms },
      intervals_ms: {
        pq_pr: pq_int,
        qt: qt_int,
        qtc_bazett: qtc_b,
        qtc_fridericia: qtc_f,
        qtc_framingham: qtc_fram,
        qtc_hodges: qtc_h,
        jt: jt_int,
        jtc_bazett: jtc_b,
        tp_te: tpte_ms,
        rr: rr_ms,
      },
      segments_ms: { pq_pr_segment: pq_seg, st_segment: st_seg, tp_segment: tp_seg },
      ratios: { tpte_qt_ratio: tpte_qt, macruz_index: macruz },
      amplitudes_mv: {
        isoelectric_mv: iso_mv,
        p_amp_mv: p_amp,
        q_amp_mv: q_amp,
        r_amp_mv: r_amp,
        s_amp_mv: s_amp,
        // Net QRS area proxy (R + deepest negative deflection), as used by the backend for the electrical axis
        qrs_net_mv: r_amp + Math.min(q_amp, s_amp),
        qrs_p2p_mv: r_amp - Math.min(q_amp, s_amp),
        j_point_mv: j_mv,
        st_60_mv: st60_mv,
        st_80_mv: st80_mv,
        st_slope_mv_s: st_slope,
        t_amp_mv: t_amp,
      },
    };
  }

  function recalculateLiveMetricsAndRender() {
    const live = computeLiveMetricsClient();
    if (!live) return;

    // Update current lead metrics in state so tables reflect live caliper positions
    if (state.analysis && state.analysis.leads && state.analysis.leads[state.activeLead]) {
      const leadAna = state.analysis.leads[state.activeLead];
      leadAna.calipers_ms = { ...state.calipersMs };
      if (leadAna.beats && leadAna.beats[state.activeBeatIdx]) {
        leadAna.beats[state.activeBeatIdx].times_ms = { ...state.calipersMs };
      }
      leadAna.metrics = {
        ...leadAna.metrics,
        ...live,
      };
      // Axis / Sokolow / Cornell depend on per-lead amplitudes: keep them in sync with caliper & R edits
      recomputeGlobalIndicesClient();
      renderHexaxialCompass();
    }

    updateRAndArtifactStatusBar();
    renderCaliperWorkbenchCanvas(live);
    renderIntervalsTelemetryTable(live);
    renderQtcAndAmplitudes(live);
    renderFreeCaliperBanner();
    renderVectorcardiogram();
  }

  // Recomputes metrics of EVERY lead from its own representative beat (not only the active one).
  // Needed after re-calibration (all amplitudes/durations change) and in static mode (no backend).
  function recomputeAllLeadMetricsClient(useActiveCalipers = true) {
    if (!state.analysis || !state.analysis.leads || !state.digitization) return;
    Object.keys(state.analysis.leads).forEach((ln) => {
      const lAna = state.analysis.leads[ln];
      if (!lAna || !state.digitization.leads_mv[ln]) return;
      const isActive = useActiveCalipers && ln === state.activeLead;
      const bIdx = isActive ? state.activeBeatIdx : Math.min(lAna.representative_beat_index || 0, Math.max(0, (lAna.beats || []).length - 1));
      const tms = isActive ? state.calipersMs : ((lAna.beats && lAna.beats[bIdx] && lAna.beats[bIdx].times_ms) || lAna.calipers_ms);
      const m = computeLeadMetricsClient(ln, tms);
      if (m) lAna.metrics = { ...(lAna.metrics || {}), ...m };
    });
    recomputeGlobalIndicesClient();
  }

  // Client-side mirror of `analyze_all_leads` global block (ecg_analysis.py): hexaxial P/QRS/T axes,
  // QRS–T angle, Sokolow–Lyon and Cornell indices, consensus RR / HR.
  function recomputeGlobalIndicesClient() {
    if (!state.analysis || !state.analysis.leads) return;
    const leads = state.analysis.leads;
    const amp = (ln) => (leads[ln] && leads[ln].metrics && leads[ln].metrics.amplitudes_mv) || null;

    const hexaxial = (key) => {
      const aI = amp("I");
      if (!aI || aI[key] === undefined) return null;
      const vI = aI[key];
      const aAvf = amp("aVF");
      const aII = amp("II");
      let y = null;
      // Goldberger aVF = (√3/2)·|E|·sin α, lead I = |E|·cos α  →  tan α = (2/√3)·aVF / I
      if (aAvf && aAvf[key] !== undefined) y = (2.0 / Math.sqrt(3.0)) * aAvf[key];
      else if (aII && aII[key] !== undefined) y = (2.0 * aII[key] - vI) / Math.sqrt(3.0);
      if (y === null || Math.abs(vI) + Math.abs(y) <= 1e-4) return null;
      return Math.round(((Math.atan2(y, vI) * 180.0) / Math.PI) * 10) / 10;
    };

    const qrsAxis = hexaxial("qrs_net_mv");
    const pAxis = hexaxial("p_amp_mv");
    const tAxis = hexaxial("t_amp_mv");
    let qrsT = null;
    if (qrsAxis !== null && tAxis !== null) {
      const d = Math.abs(qrsAxis - tAxis) % 360;
      qrsT = Math.round((d > 180 ? 360 - d : d) * 10) / 10;
    }
    let cls = "Не определяется (нет отведений от конечностей)";
    if (qrsAxis !== null) {
      const sgn = `${qrsAxis >= 0 ? "+" : ""}${qrsAxis.toFixed(0)}°`;
      if (qrsAxis >= 0 && qrsAxis <= 70) cls = `Нормальное положение ЭОС (${sgn})`;
      else if (qrsAxis >= -30 && qrsAxis < 0) cls = `Горизонтальное положение ЭОС (${sgn})`;
      else if (qrsAxis > 70 && qrsAxis <= 90) cls = `Вертикальное положение ЭОС (${sgn})`;
      else if (qrsAxis >= -90 && qrsAxis < -30) cls = `Отклонение ЭОС влево (${sgn})`;
      else if (qrsAxis > 90 && qrsAxis <= 180) cls = `Отклонение ЭОС вправо (${sgn})`;
      else cls = `Резкое отклонение ЭОС (северо-западная ось, ${sgn})`;
    }
    state.analysis.axes = { qrs_axis_deg: qrsAxis, p_axis_deg: pAxis, t_axis_deg: tAxis, qrs_t_angle_deg: qrsT, classification: cls };

    const hyp = {};
    // Wave height / depth only: a QS complex has R = 0 (not a negative R that would subtract from the index)
    const rH = (a) => (a ? Math.max(0, a.r_amp_mv || 0) : 0);
    const sD = (a) => (a ? Math.max(0, -(a.s_amp_mv || 0)) : 0);
    const aV1 = amp("V1");
    const aV5 = amp("V5");
    const aV6 = amp("V6");
    if (aV1 && (aV5 || aV6)) {
      const sok = sD(aV1) + Math.max(rH(aV5), rH(aV6));
      hyp.sokolow_lyon_mv = Math.round(sok * 100) / 100;
      hyp.sokolow_lyon_mm = Math.round(sok * 100) / 10;
      hyp.sokolow_lyon_lvh = sok >= 3.5;
    }
    const aAvl = amp("aVL");
    const aV3 = amp("V3");
    if (aAvl && aV3) {
      const corn = rH(aAvl) + sD(aV3);
      // Sex-specific Cornell voltage criterion: ≥ 2.8 mV (men), ≥ 2.0 mV (women); unknown sex → men's threshold,
      // with a "possible LVH in women" note in the 2.0–2.8 mV grey zone
      const sex = (el.selectPatientSex && el.selectPatientSex.value) || "";
      const thr = sex === "female" ? 2.0 : 2.8;
      hyp.cornell_mv = Math.round(corn * 100) / 100;
      hyp.cornell_mm = Math.round(corn * 100) / 10;
      hyp.cornell_threshold_mv = thr;
      hyp.cornell_sex = sex || null;
      hyp.cornell_lvh = corn >= thr;
      hyp.cornell_lvh_if_female = !sex && corn >= 2.0 && corn < 2.8;
    }
    state.analysis.hypertrophy = hyp;

    const rrs = Object.values(leads)
      .map((l) => l && l.hrv && l.hrv.median_rr_ms)
      .filter((v) => v >= 300 && v <= 2000)
      .sort((a, b) => a - b);
    if (rrs.length > 0) {
      const mid = Math.floor(rrs.length / 2);
      const rr = rrs.length % 2 ? rrs[mid] : 0.5 * (rrs[mid - 1] + rrs[mid]);
      state.analysis.global_rr_ms = Math.round(rr * 10) / 10;
      state.analysis.global_hr_bpm = Math.round((60000.0 / Math.max(250, rr)) * 10) / 10;
    }
  }

  // Lightweight browser R-peak detector + template fiducials (static Firebase mode / static re-analysis).
  // NOTE: P/QRS/T boundaries are fixed offsets from R (a template, not a delineation) — the user must
  // verify them with the calipers; amplitudes are then measured on the real signal.
  function analyzeLeadClientSide(sig, fs) {
    const n = sig.length;
    const totalMs = (n * 1000.0) / fs;
    const minDist = Math.round(0.32 * fs);
    let maxAbs = 0.05;
    for (let i = 0; i < n; i++) {
      if (Math.abs(sig[i]) > maxAbs) maxAbs = Math.abs(sig[i]);
    }
    const rIdxList = [];
    for (let i = 10; i < n - 10; i++) {
      if (Math.abs(sig[i]) >= 0.42 * maxAbs) {
        let isMax = true;
        for (let j = Math.max(0, i - 14); j <= Math.min(n - 1, i + 14); j++) {
          if (Math.abs(sig[j]) > Math.abs(sig[i])) {
            isMax = false;
            break;
          }
        }
        if (isMax && (rIdxList.length === 0 || i - rIdxList[rIdxList.length - 1] >= minDist)) {
          rIdxList.push(i);
        }
      }
    }
    if (rIdxList.length === 0) rIdxList.push(Math.floor(n * 0.45));
    const rrList = [];
    for (let i = 1; i < rIdxList.length; i++) {
      rrList.push(((rIdxList[i] - rIdxList[i - 1]) * 1000.0) / fs);
    }
    const rrSorted = [...rrList].sort((a, b) => a - b);
    const medRR = rrSorted.length > 0 ? rrSorted[Math.floor(rrSorted.length / 2)] : 800;
    const beats = rIdxList.map((ri, bIdx) => {
      const rMs = Math.round((ri * 1000.0) / fs);
      const nextR = bIdx + 1 < rIdxList.length ? Math.round((rIdxList[bIdx + 1] * 1000.0) / fs) : Math.min(totalMs, rMs + medRR);
      return {
        r_peak: ri,
        times_ms: {
          p_onset: Math.max(0, rMs - 155),
          p_peak: Math.max(0, rMs - 110),
          p_offset: Math.max(0, rMs - 65),
          qrs_onset: Math.max(0, rMs - 40),
          q_peak: Math.max(0, rMs - 20),
          r_peak: rMs,
          s_peak: Math.min(totalMs, rMs + 22),
          qrs_offset: Math.min(totalMs, rMs + 48),
          st_60: Math.min(totalMs, rMs + 108),
          st_80: Math.min(totalMs, rMs + 128),
          t_onset: Math.min(totalMs, rMs + 110),
          t_peak: Math.min(totalMs, rMs + 190),
          t_offset: Math.min(totalMs, rMs + 275),
          next_r_peak: Math.round(nextR),
        },
      };
    });
    // Representative beat: a middle one (edge beats are often truncated), as on the backend
    const repIdx = beats.length >= 3 ? Math.floor(beats.length / 2) : 0;
    let sdnn = 0;
    let rmssd = 0;
    if (rrList.length >= 2) {
      const mean = rrList.reduce((a, b) => a + b, 0) / rrList.length;
      sdnn = Math.sqrt(rrList.reduce((a, b) => a + (b - mean) ** 2, 0) / rrList.length);
    }
    if (rrList.length >= 3) {
      let acc = 0;
      for (let i = 1; i < rrList.length; i++) acc += (rrList[i] - rrList[i - 1]) ** 2;
      rmssd = Math.sqrt(acc / (rrList.length - 1));
    }
    return {
      r_peaks: rIdxList,
      r_peaks_ms: beats.map((b) => b.times_ms.r_peak),
      rr_intervals_ms: rrList,
      hrv: { median_rr_ms: medRR, sdnn_ms: Math.round(sdnn * 10) / 10, rmssd_ms: Math.round(rmssd * 10) / 10 },
      beats,
      representative_beat_index: repIdx,
      calipers_ms: { ...beats[repIdx].times_ms },
      metrics: {},
    };
  }

  // Draws millimeter ECG paper grid on any 2D canvas
  function drawMillimeterGrid(ctx, width, height, pxPerMm) {
    ctx.fillStyle = "#FFFDFB";
    ctx.fillRect(0, 0, width, height);

    const step1mm = Math.max(2.5, pxPerMm);
    const step5mm = step1mm * 5.0;

    // 1mm minor grid lines
    if (step1mm >= 3.2) {
      ctx.beginPath();
      ctx.strokeStyle = "rgba(200, 62, 77, 0.11)";
      ctx.lineWidth = 0.75;
      for (let x = 0; x <= width; x += step1mm) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
      }
      for (let y = 0; y <= height; y += step1mm) {
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
      }
      ctx.stroke();
    }

    // 5mm major grid lines
    ctx.beginPath();
    ctx.strokeStyle = "rgba(200, 62, 77, 0.28)";
    ctx.lineWidth = 1.15;
    for (let x = 0; x <= width; x += step5mm) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = 0; y <= height; y += step5mm) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  // Renders the Multi-Lead Overview Digital ECG Canvas (#multileadCanvas)
  function renderMultiLeadCanvas() {
    if (!state.digitization || !state.digitization.leads_mv) return;
    const canvas = el.multileadCanvas;
    const container = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;

    const leadsMap = state.digitization.leads_mv;
    const leadNames = Object.keys(leadsMap);
    if (leadNames.length === 0) return;

    const cols = leadNames.length >= 12 ? 2 : 1;
    const rows = Math.ceil(leadNames.length / cols);
    const z = state.w1Zoom || 1.0;
    const baseW = Math.max(480, (container.clientWidth || 640) - 4);
    const rowHeight = Math.round(84 * z);
    const cssWidth = Math.round(baseW * z);
    const cssHeight = Math.max(400, rows * rowHeight + 24);

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const pxPerMm = 4.2 * z;
    drawMillimeterGrid(ctx, cssWidth, cssHeight, pxPerMm);

    const colWidth = cssWidth / cols;
    const fs = state.digitization.sampling_rate_hz || 500;
    const rawGainMmMv = state.digitization.gain_mm_mv || 10;
    // Auto-scale multi-lead overview gain gently when high-amplitude QRS waves (e.g. -4.5 mV deep S waves) are present
    // while NEVER applying a flat per-row square clamp!
    let globalMaxAbsMv = 1.0;
    leadNames.forEach((ln) => {
      const s = leadsMap[ln] || [];
      for (let i = 0; i < s.length; i++) {
        const av = Math.abs(s[i]);
        if (av > globalMaxAbsMv) globalMaxAbsMv = av;
      }
    });
    const gainMmMv = globalMaxAbsMv > 1.35
      ? Math.max(rawGainMmMv * 0.42, (rowHeight * 0.48) / (pxPerMm * Math.min(3.6, globalMaxAbsMv)))
      : rawGainMmMv;
    const showMarks = el.chkShowFiducialsMulti.checked;

    state.multileadHitBoxes = [];
    state.w1RPeakHitBoxes = [];

    leadNames.forEach((ln, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x0 = col * colWidth;
      const yCenter = row * rowHeight + rowHeight * 0.54;
      const wBox = colWidth;
      const sig = leadsMap[ln] || [];
      const totalMs = (sig.length * 1000.0) / fs;
      const traceX0 = x0 + 24;
      const traceW = wBox - 34;

      state.multileadHitBoxes.push({
        lead: ln,
        x0,
        y0: row * rowHeight,
        x1: x0 + wBox,
        y1: (row + 1) * rowHeight,
        traceX0,
        traceW,
        totalMs,
        yCenter,
      });

      // Highlight active lead box
      if (ln === state.activeLead) {
        ctx.fillStyle = "rgba(15, 76, 129, 0.065)";
        ctx.fillRect(x0 + 2, row * rowHeight + 2, wBox - 4, rowHeight - 4);
        ctx.strokeStyle = "rgba(15, 76, 129, 0.45)";
        ctx.lineWidth = 1.2;
        ctx.strokeRect(x0 + 2, row * rowHeight + 2, wBox - 4, rowHeight - 4);
      }

      // Draw standard 1 mV calibration pulse on left
      const calH = gainMmMv * pxPerMm;
      const calX = x0 + 10;
      ctx.beginPath();
      ctx.strokeStyle = "#4A5568";
      ctx.lineWidth = 1.2;
      ctx.moveTo(calX, yCenter);
      ctx.lineTo(calX + 4, yCenter);
      ctx.lineTo(calX + 4, yCenter - calH);
      ctx.lineTo(calX + 14, yCenter - calH);
      ctx.lineTo(calX + 14, yCenter);
      ctx.lineTo(calX + 18, yCenter);
      ctx.stroke();

      // Lead label badge
      ctx.fillStyle = ln === state.activeLead ? "#0F4C81" : "#141923";
      ctx.font = "600 12px 'IBM Plex Mono', monospace";
      ctx.fillText(ln, x0 + 24, row * rowHeight + 17);

      if (sig.length < 2) return;

      // Draw Digitized Waveform Trace (unclipped across row boundaries, just like real paper ECGs!)
      ctx.beginPath();
      ctx.strokeStyle = ln === state.activeLead ? "#0B132B" : "#1A202C";
      ctx.lineWidth = ln === state.activeLead ? 1.65 : 1.3;
      for (let i = 0; i < sig.length; i++) {
        const px = traceX0 + (i / (sig.length - 1)) * traceW;
        const py = yCenter - sig[i] * gainMmMv * pxPerMm;
        const safeY = Math.max(3, Math.min(cssHeight - 3, py));
        if (i === 0) ctx.moveTo(px, safeY);
        else ctx.lineTo(px, safeY);
      }
      ctx.stroke();

      // Draw Artifact Zones (Bold Blue Horizontal Line) in Window 1
      const artZones = (state.artifactsByLead && state.artifactsByLead[ln]) || [];
      if (showMarks && artZones.length > 0 && totalMs > 0) {
        artZones.forEach((z) => {
          const ax1 = traceX0 + Math.max(0, Math.min(1, z.startMs / totalMs)) * traceW;
          const ax2 = traceX0 + Math.max(0, Math.min(1, z.endMs / totalMs)) * traceW;
          if (ax2 > ax1 + 1) {
            ctx.save();
            ctx.fillStyle = "rgba(29, 78, 216, 0.11)";
            ctx.fillRect(ax1, row * rowHeight + 3, ax2 - ax1, rowHeight - 6);

            // Bold blue horizontal line
            ctx.strokeStyle = "#1D4ED8";
            ctx.lineWidth = 5.0;
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(ax1, yCenter);
            ctx.lineTo(ax2, yCenter);
            ctx.stroke();

            // Vertical end caps
            ctx.lineWidth = 2.0;
            ctx.beginPath();
            ctx.moveTo(ax1, yCenter - 7);
            ctx.lineTo(ax1, yCenter + 7);
            ctx.moveTo(ax2, yCenter - 7);
            ctx.lineTo(ax2, yCenter + 7);
            ctx.stroke();
            ctx.restore();
          }
        });
      }

      // Draw Interactive Draggable R-Peak Markers in Window 1
      if (showMarks && state.analysis && state.analysis.leads && state.analysis.leads[ln]) {
        const beats = state.analysis.leads[ln].beats || [];
        beats.forEach((b, bIdx) => {
          const rMs = b.times_ms ? b.times_ms.r_peak : 0;
          if (totalMs <= 0) return;
          const rx = traceX0 + Math.max(0, Math.min(1, rMs / totalMs)) * traceW;
          const inArt = isTimeInArtifact(ln, rMs);

          ctx.save();
          ctx.strokeStyle = inArt ? "rgba(100, 116, 139, 0.65)" : "rgba(217, 56, 30, 0.72)";
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(rx, row * rowHeight + 4);
          ctx.lineTo(rx, row * rowHeight + rowHeight - 6);
          ctx.stroke();

          // Draggable top R badge
          const bw = 18;
          const bh = 12;
          const bx = rx - bw / 2;
          const by = row * rowHeight + 3;
          ctx.fillStyle = inArt ? "#64748B" : (ln === state.activeLead && bIdx === state.activeBeatIdx ? "#141923" : "#D9381E");
          ctx.fillRect(bx, by, bw, bh);
          ctx.fillStyle = "#FFFFFF";
          ctx.font = "600 8.5px 'IBM Plex Mono', monospace";
          ctx.textAlign = "center";
          ctx.fillText(`R${bIdx + 1}`, rx, by + 9);
          ctx.restore();

          state.w1RPeakHitBoxes.push({
            lead: ln,
            beatIdx: bIdx,
            rMs,
            x: rx,
            bx,
            by,
            bw,
            bh,
            rowY0: row * rowHeight,
            rowY1: (row + 1) * rowHeight,
            traceX0,
            traceW,
            totalMs,
          });
        });
      }
    });
  }

  // Renders the Precision Interactive Caliper Workbench (#caliperCanvas)
  function renderCaliperWorkbenchCanvas(liveMetrics) {
    if (!state.digitization || !state.digitization.leads_mv) return;
    const sig = state.digitization.leads_mv[state.activeLead] || [];
    if (sig.length < 2) return;

    const canvas = el.caliperCanvas;
    const container = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(520, container.clientWidth || 720);
    const cssHeight = 375;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const fs = state.digitization.sampling_rate_hz || 500;
    const speedMmS = state.digitization.paper_speed_mm_s || 25;
    const gainMmMv = (state.digitization.gain_mm_mv || 10) * state.zoomY;
    const totalSigMs = (sig.length * 1000) / fs;

    // Determine visible time window [startMs, endMs]: full channel sweep when zoomX <= 1.05
    let startMs = 0;
    let endMs = totalSigMs;
    if (state.zoomX > 1.05) {
      const visibleSpanMs = Math.max(400, Math.min(totalSigMs, totalSigMs / state.zoomX));
      const focusCenterMs = (state.calipersMs.r_peak + state.calipersMs.t_peak) * 0.5 + state.panOffsetMs;
      startMs = Math.max(0, focusCenterMs - visibleSpanMs * 0.45);
      endMs = startMs + visibleSpanMs;
      if (endMs > totalSigMs) {
        endMs = totalSigMs;
        startMs = Math.max(0, endMs - visibleSpanMs);
      }
    }

    const padLeft = 48;
    const padRight = 20;
    const padTop = 44;
    const padBottom = 34;
    const plotW = cssWidth - padLeft - padRight;
    const plotH = cssHeight - padTop - padBottom;

    // Calculate physical pxPerMm on screen from visible time span and paper speed
    const visibleMmX = ((endMs - startMs) / 1000.0) * speedMmS;
    const pxPerMm = plotW / Math.max(10, visibleMmX);

    // Auto-fit vertical centerY and gainMmMv when deep S-waves (-4.5 mV) or tall R-waves (+2.5 mV)
    // would otherwise exceed plotH at the current horizontal scale!
    const iVis0 = Math.max(0, Math.floor((startMs * fs) / 1000.0));
    const iVis1 = Math.min(sig.length - 1, Math.ceil((endMs * fs) / 1000.0));
    let minVisMv = -0.5;
    let maxVisMv = 0.8;
    for (let i = iVis0; i <= iVis1; i++) {
      if (sig[i] < minVisMv) minVisMv = sig[i];
      if (sig[i] > maxVisMv) maxVisMv = sig[i];
    }
    const spanVisMv = Math.max(1.4, (maxVisMv - minVisMv) + 0.45);
    const maxFitGain = (plotH - 22) / Math.max(1e-3, pxPerMm * spanVisMv);
    const effGainMmMv = Math.min(gainMmMv, maxFitGain * state.zoomY);
    const topRatio = Math.max(0.22, Math.min(0.82, (maxVisMv + 0.22) / spanVisMv));
    const centerY = padTop + 11 + topRatio * (plotH - 22);

    state.viewWindow = {
      startMs,
      endMs,
      pxPerMm,
      gainMmMv: effGainMmMv,
      centerY,
      padLeft,
      padRight,
      padTop,
      padBottom,
      plotW,
      plotH,
      cssWidth,
      cssHeight,
      totalSigMs,
    };

    const msToX = (ms) => padLeft + ((ms - startMs) / Math.max(1, endMs - startMs)) * plotW;
    const mvToY = (mv) => centerY - mv * effGainMmMv * pxPerMm;

    // 1. Millimeter paper grid
    drawMillimeterGrid(ctx, cssWidth, cssHeight, pxPerMm);

    // 2. Isoelectric baseline reference (PR level)
    const isoMv = (liveMetrics && liveMetrics.amplitudes_mv && liveMetrics.amplitudes_mv.isoelectric_mv) || 0.0;
    const isoY = mvToY(isoMv);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(74, 85, 104, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, isoY);
    ctx.lineTo(cssWidth - padRight, isoY);
    ctx.stroke();
    ctx.restore();

    // Voltage scale labels on left margin
    ctx.fillStyle = "#4A5568";
    ctx.font = "500 10.5px 'IBM Plex Mono', monospace";
    [-4.5, -4.0, -3.5, -3.0, -2.5, -2.0, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0].forEach((v) => {
      const y = mvToY(isoMv + v);
      if (y >= padTop + 8 && y <= cssHeight - padBottom - 6) {
        ctx.fillText(`${v >= 0 ? "+" : ""}${v.toFixed(1)}мВ`, 4, y + 3);
      }
    });

    // Time scale ruler at bottom
    const timeStepMs = (endMs - startMs) <= 1200 ? 100 : 200;
    const firstTick = Math.ceil(startMs / timeStepMs) * timeStepMs;
    ctx.fillStyle = "#4A5568";
    ctx.font = "500 10.5px 'IBM Plex Mono', monospace";
    for (let t = firstTick; t <= endMs; t += timeStepMs) {
      const tx = msToX(t);
      ctx.fillText(`${t.toFixed(0)} мс`, tx - 16, cssHeight - 10);
    }

    // 3. Shaded interval bands in fiducial mode
    const c = state.calipersMs;
    if (state.caliperMode === "fiducial") {
      const drawBand = (ms1, ms2, fillRgba) => {
        const x1 = Math.max(padLeft, Math.min(cssWidth - padRight, msToX(ms1)));
        const x2 = Math.max(padLeft, Math.min(cssWidth - padRight, msToX(ms2)));
        if (x2 > x1) {
          ctx.fillStyle = fillRgba;
          ctx.fillRect(x1, padTop, x2 - x1, plotH);
        }
      };
      drawBand(c.p_onset, c.p_offset, "rgba(15, 76, 129, 0.07)");
      drawBand(c.qrs_onset, c.qrs_offset, "rgba(217, 56, 30, 0.08)");
      drawBand(c.t_onset, c.t_offset, "rgba(11, 122, 83, 0.07)");
    }

    // 4. Draw Digitized ECG Waveform Trace
    const iStart = Math.max(0, Math.floor((startMs * fs) / 1000.0));
    const iEnd = Math.min(sig.length - 1, Math.ceil((endMs * fs) / 1000.0));

    ctx.save();
    ctx.beginPath();
    ctx.rect(padLeft, padTop, plotW, plotH);
    ctx.clip();

    ctx.beginPath();
    ctx.strokeStyle = "#111622";
    ctx.lineWidth = 2.0;
    ctx.lineJoin = "round";
    for (let i = iStart; i <= iEnd; i++) {
      const tMs = (i * 1000.0) / fs;
      const px = msToX(tMs);
      const py = mvToY(sig[i]);
      if (i === iStart) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();

    // 5. Render ST J+60ms and J+80ms measurement markers
    if ((state.caliperMode === "fiducial" || state.caliperMode === "r_edit") && liveMetrics) {
      const st80Ms = c.qrs_offset + 80;
      const xSt80 = msToX(st80Ms);
      const st80Mv = (liveMetrics.amplitudes_mv.st_80_mv || 0) + isoMv;
      const ySt80 = mvToY(st80Mv);

      if (xSt80 >= padLeft && xSt80 <= cssWidth - padRight) {
        ctx.strokeStyle = "#B06000";
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(xSt80, isoY);
        ctx.lineTo(xSt80, ySt80);
        ctx.stroke();

        ctx.fillStyle = "#B06000";
        ctx.beginPath();
        ctx.arc(xSt80, ySt80, 3.5, 0, Math.PI * 2);
        ctx.fill();

        const deltaSt = liveMetrics.amplitudes_mv.st_80_mv || 0;
        ctx.font = "600 10.5px 'IBM Plex Mono', monospace";
        ctx.fillText(
          `J+80: ${deltaSt >= 0 ? "+" : ""}${deltaSt.toFixed(2)}мВ`,
          xSt80 + 5,
          ySt80 - 6
        );
      }
    }

    ctx.restore();

    // 5b. Render Artifact Exclusion Zones (Bold Blue Horizontal Line) on Window 2
    drawWindow2ArtifactsAndAllRPeaks(ctx, msToX, isoY);

    // 6. Render Active Calipers according to Mode
    if (state.caliperMode === "fiducial" || state.caliperMode === "r_edit" || state.caliperMode === "artifact") {
      drawFiducialCalipersAndBrackets(ctx, msToX, mvToY, liveMetrics);
    } else if (state.caliperMode === "free") {
      drawFreeCalipers(ctx, msToX, mvToY);
    } else if (state.caliperMode === "marching") {
      drawMarchingCalipers(ctx, msToX);
    }
  }

  function drawWindow2ArtifactsAndAllRPeaks(ctx, msToX, isoY) {
    const { padLeft, padTop, plotW, plotH, cssWidth, padRight } = state.viewWindow;
    const ln = state.activeLead;
    const zones = (state.artifactsByLead && state.artifactsByLead[ln]) || [];

    // 1. Draw all marked Artifact Exclusion Zones as BOLD BLUE HORIZONTAL LINES
    zones.forEach((z, zIdx) => {
      const x1 = Math.max(padLeft, Math.min(cssWidth - padRight, msToX(z.startMs)));
      const x2 = Math.max(padLeft, Math.min(cssWidth - padRight, msToX(z.endMs)));
      if (x2 <= x1 + 1) return;

      ctx.save();
      // Shaded blue exclusion band
      ctx.fillStyle = "rgba(29, 78, 216, 0.10)";
      ctx.fillRect(x1, padTop, x2 - x1, plotH);

      // Bold Blue Horizontal Line along the signal baseline
      const lineY = Math.max(padTop + 28, Math.min(padTop + plotH - 28, isoY));
      ctx.strokeStyle = "#1D4ED8";
      ctx.lineWidth = 6.5;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(x1, lineY);
      ctx.lineTo(x2, lineY);
      ctx.stroke();

      // End handles on left & right of the bold blue line
      ctx.fillStyle = "#1E3A8A";
      ctx.fillRect(x1 - 4, lineY - 9, 8, 18);
      ctx.fillRect(x2 - 4, lineY - 9, 8, 18);

      // Artifact badge label
      const lbl = `▬▬ АРТЕФАКТ: НЕ АНАЛИЗИРУЕТСЯ (${z.startMs.toFixed(0)}–${z.endMs.toFixed(0)} мс)`;
      ctx.font = "700 10.5px 'IBM Plex Mono', monospace";
      const tw = ctx.measureText(lbl).width + 12;
      const midX = (x1 + x2) * 0.5;
      ctx.fillStyle = "#1D4ED8";
      ctx.fillRect(midX - tw * 0.5, lineY - 22, tw, 16);
      ctx.fillStyle = "#FFFFFF";
      ctx.textAlign = "center";
      ctx.fillText(lbl, midX, lineY - 10);
      ctx.restore();
    });

    // Live drag preview while creating a new artifact zone in Window 2
    if (state.artifactDragStartMs !== null && state.artifactDragCurrMs !== null) {
      const sMs = Math.min(state.artifactDragStartMs, state.artifactDragCurrMs);
      const eMs = Math.max(state.artifactDragStartMs, state.artifactDragCurrMs);
      const x1 = Math.max(padLeft, Math.min(cssWidth - padRight, msToX(sMs)));
      const x2 = Math.max(padLeft, Math.min(cssWidth - padRight, msToX(eMs)));
      if (x2 > x1 + 2) {
        ctx.save();
        ctx.fillStyle = "rgba(37, 99, 235, 0.16)";
        ctx.fillRect(x1, padTop, x2 - x1, plotH);
        ctx.strokeStyle = "#2563EB";
        ctx.lineWidth = 6.5;
        ctx.beginPath();
        ctx.moveTo(x1, isoY);
        ctx.lineTo(x2, isoY);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 2. Draw ALL R-peaks (R1, R2, R3...) of the active channel across the full sweep
    const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[ln];
    const beats = (leadAna && leadAna.beats) || [];
    state.w2RPeakHitBoxes = [];

    beats.forEach((b, bIdx) => {
      const rMs = b.times_ms ? b.times_ms.r_peak : 0;
      const rx = msToX(rMs);
      if (rx < padLeft - 8 || rx > cssWidth - padRight + 8) return;
      const isSelectedBeat = bIdx === state.activeBeatIdx;
      const inArt = isTimeInArtifact(ln, rMs);

      ctx.save();
      // Vertical R marker line across full channel
      ctx.strokeStyle = inArt ? "rgba(100, 116, 139, 0.7)" : (isSelectedBeat ? "#B02310" : "rgba(217, 56, 30, 0.75)");
      ctx.lineWidth = isSelectedBeat ? 1.8 : 1.3;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(rx, padTop);
      ctx.lineTo(rx, padTop + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      // Top R# badge on row y=2 (above fiducial flags)
      const label = isSelectedBeat ? `★R${bIdx + 1}` : `R${bIdx + 1}`;
      const bw = isSelectedBeat ? 32 : 24;
      const bh = 15;
      const bx = rx - bw / 2;
      const by = 2;

      ctx.fillStyle = inArt ? "#64748B" : (isSelectedBeat ? "#141923" : "#D9381E");
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 3);
      ctx.fill();

      ctx.fillStyle = "#FFFFFF";
      ctx.font = "700 10px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(label, rx, by + 11);

      // Inter-beat RR label between R_k and R_{k+1}
      if (bIdx + 1 < beats.length) {
        const nextRMs = beats[bIdx + 1].times_ms.r_peak;
        const rxNext = msToX(nextRMs);
        if (rxNext - rx > 42) {
          const midX = 0.5 * (rx + rxNext);
          const rrVal = nextRMs - rMs;
          const isExc = isIntervalInArtifact(ln, rMs, nextRMs);
          ctx.font = "600 9.5px 'IBM Plex Mono', monospace";
          ctx.fillStyle = isExc ? "#1D4ED8" : "#7C3AED";
          ctx.fillText(isExc ? "▬▬ ИСКЛ." : `${rrVal.toFixed(0)} мс`, midX, padTop + 12);
        }
      }
      ctx.restore();

      state.w2RPeakHitBoxes.push({
        beatIdx: bIdx,
        rMs,
        x: rx,
        bx,
        by,
        bw,
        bh,
      });
    });
  }

  function drawFiducialCalipersAndBrackets(ctx, msToX, mvToY, live) {
    const { padLeft, padTop, plotW, plotH, cssWidth, padRight, cssHeight, padBottom } = state.viewWindow;
    const c = state.calipersMs;

    // Draw vertical caliper lines and top handles
    FIDUCIAL_DEFS.forEach((fd) => {
      const ms = c[fd.key];
      if (ms === undefined) return;
      const x = msToX(ms);
      if (x < padLeft - 10 || x > cssWidth - padRight + 10) return;

      const isActive = state.draggingHandle === fd.key || state.hoverHandle === fd.key;

      ctx.save();
      ctx.strokeStyle = fd.color;
      ctx.lineWidth = isActive ? 2.2 : 1.35;
      if (fd.row === 1) {
        ctx.setLineDash([3, 3]);
      }
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + plotH);
      ctx.stroke();
      ctx.restore();

      // Handle flag at top (shifted down slightly so top row R1..Rn badges sit cleanly at y=2..17)
      const flagY = fd.row === 0 ? 18 : 31;
      const flagW = fd.short.length * 6.5 + 9;
      ctx.fillStyle = isActive ? "#141923" : fd.color;
      ctx.beginPath();
      ctx.roundRect(x - flagW / 2, flagY, flagW, 13, 3);
      ctx.fill();

      ctx.fillStyle = "#FFFFFF";
      ctx.font = "600 9.5px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(fd.short, x, flagY + 9.5);
      ctx.textAlign = "left";
    });

    if (!live) return;

    // Draw horizontal clinical dimension brackets inside the plot
    const drawBracket = (ms1, ms2, yPos, color, label) => {
      const x1 = Math.max(padLeft, Math.min(cssWidth - padRight, msToX(ms1)));
      const x2 = Math.max(padLeft, Math.min(cssWidth - padRight, msToX(ms2)));
      if (x2 - x1 < 22) return;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1.25;

      // Horizontal bar with end ticks
      ctx.beginPath();
      ctx.moveTo(x1, yPos - 4);
      ctx.lineTo(x1, yPos + 4);
      ctx.moveTo(x2, yPos - 4);
      ctx.lineTo(x2, yPos + 4);
      ctx.moveTo(x1, yPos);
      ctx.lineTo(x2, yPos);
      ctx.stroke();

      // Label pill in center
      ctx.font = "600 10.5px 'IBM Plex Mono', monospace";
      const tw = ctx.measureText(label).width + 8;
      const cx = (x1 + x2) * 0.5;
      ctx.fillStyle = "rgba(255, 253, 251, 0.92)";
      ctx.fillRect(cx - tw * 0.5, yPos - 8, tw, 14);
      ctx.fillStyle = color;
      ctx.textAlign = "center";
      ctx.fillText(label, cx, yPos + 3);
      ctx.restore();
    };

    const yTop1 = padTop + 22;
    const yTop2 = padTop + 42;
    const yBot1 = cssHeight - padBottom - 38;
    const yBot2 = cssHeight - padBottom - 18;

    drawBracket(c.p_onset, c.p_offset, yTop1, "#0F4C81", `P: ${live.durations_ms.p_wave.toFixed(0)} мс`);
    drawBracket(c.p_onset, c.qrs_onset, yTop2, "#0F4C81", `PQ: ${live.intervals_ms.pq_pr.toFixed(0)} мс`);
    drawBracket(c.qrs_onset, c.qrs_offset, yBot1, "#D9381E", `QRS: ${live.durations_ms.qrs_complex.toFixed(0)} мс`);
    drawBracket(c.qrs_offset, c.t_onset, yTop1, "#B06000", `ST: ${live.segments_ms.st_segment.toFixed(0)} мс`);
    drawBracket(c.t_peak, c.t_offset, yTop2, "#0B7A53", `Tp-Te: ${live.intervals_ms.tp_te.toFixed(0)} мс`);
    drawBracket(
      c.qrs_onset,
      c.t_offset,
      yBot2,
      "#0B7A53",
      `QT: ${live.intervals_ms.qt.toFixed(0)} мс (QTcF ${live.intervals_ms.qtc_fridericia.toFixed(0)} мс)`
    );
    if (c.next_r_peak > c.r_peak + 150) {
      drawBracket(
        c.r_peak,
        c.next_r_peak,
        padTop + 62,
        "#7C3AED",
        `RR: ${live.intervals_ms.rr.toFixed(0)} мс (${live.hr_bpm.toFixed(0)} уд/мин)`
      );
    }
  }

  function drawFreeCalipers(ctx, msToX, mvToY) {
    const { padLeft, padTop, plotW, plotH, cssWidth, padRight } = state.viewWindow;
    const fc = state.freeCalipers;
    const x1 = msToX(fc.t1_ms);
    const x2 = msToX(fc.t2_ms);
    const y1 = mvToY(fc.v1_mv);
    const y2 = mvToY(fc.v2_mv);

    ctx.save();
    // Shaded measurement box
    ctx.fillStyle = "rgba(124, 58, 237, 0.08)";
    ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));

    // Vertical time blades
    [
      { key: "free_t1", x: x1, label: "T1" },
      { key: "free_t2", x: x2, label: "T2" },
    ].forEach((b) => {
      ctx.strokeStyle = "#7C3AED";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x, padTop);
      ctx.lineTo(b.x, padTop + plotH);
      ctx.stroke();

      ctx.fillStyle = "#7C3AED";
      ctx.fillRect(b.x - 14, 6, 28, 16);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = "600 10.5px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(b.label, b.x, 18);
    });

    // Horizontal voltage blades
    [
      { key: "free_v1", y: y1, label: `V1 (${fc.v1_mv >= 0 ? "+" : ""}${fc.v1_mv.toFixed(2)}мВ)` },
      { key: "free_v2", y: y2, label: `V2 (${fc.v2_mv >= 0 ? "+" : ""}${fc.v2_mv.toFixed(2)}мВ)` },
    ].forEach((b) => {
      ctx.strokeStyle = "#0F4C81";
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(padLeft, b.y);
      ctx.lineTo(cssWidth - padRight, b.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "#0F4C81";
      ctx.fillRect(cssWidth - padRight - 96, b.y - 15, 92, 14);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = "600 10px 'IBM Plex Mono', monospace";
      ctx.textAlign = "right";
      ctx.fillText(b.label, cssWidth - padRight - 8, b.y - 4);
    });
    ctx.restore();
  }

  function drawMarchingCalipers(ctx, msToX) {
    const { padLeft, padTop, plotH, cssWidth, padRight, startMs, endMs } = state.viewWindow;
    const fc = state.freeCalipers;
    const dt = Math.max(80, Math.abs(fc.t2_ms - fc.t1_ms));
    const tAnchor = Math.min(fc.t1_ms, fc.t2_ms);

    ctx.save();
    // Primary blades T1 and T2
    [
      { x: msToX(fc.t1_ms), label: "Марш T1" },
      { x: msToX(fc.t2_ms), label: `Марш T2 (Δ=${dt.toFixed(0)}мс)` },
    ].forEach((b) => {
      ctx.strokeStyle = "#7C3AED";
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(b.x, padTop);
      ctx.lineTo(b.x, padTop + plotH);
      ctx.stroke();

      ctx.fillStyle = "#7C3AED";
      ctx.fillRect(b.x - 24, 6, 48, 16);
      ctx.fillStyle = "#FFFFFF";
      ctx.font = "600 10px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(b.label, b.x, 18);
    });

    // Marching harmonic spikes at tAnchor ± k * dt
    ctx.strokeStyle = "rgba(124, 58, 237, 0.72)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    for (let k = -8; k <= 12; k++) {
      if (k === 0 || k === 1) continue;
      const tk = tAnchor + k * dt;
      if (tk < startMs || tk > endMs) continue;
      const xk = msToX(tk);
      if (xk < padLeft || xk > cssWidth - padRight) continue;
      ctx.beginPath();
      ctx.moveTo(xk, padTop);
      ctx.lineTo(xk, padTop + plotH);
      ctx.stroke();

      ctx.fillStyle = "#7C3AED";
      ctx.font = "600 10px 'IBM Plex Mono', monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${k > 0 ? "+" : ""}${k}×`, xk, padTop + 14);
    }
    ctx.restore();
  }

  function renderFreeCaliperBanner() {
    const isFreeOrMarch = state.caliperMode === "free" || state.caliperMode === "marching";
    el.freeCaliperBanner.hidden = !isFreeOrMarch;
    if (!isFreeOrMarch || !state.digitization) return;

    const speed = state.digitization.paper_speed_mm_s || 25;
    const gain = state.digitization.gain_mm_mv || 10;
    const dtMs = Math.abs(state.freeCalipers.t2_ms - state.freeCalipers.t1_ms);
    const dtMm = (dtMs / 1000.0) * speed;
    const eqBpm = dtMs > 20 ? 60000.0 / dtMs : 0;
    const dvMv = state.freeCalipers.v2_mv - state.freeCalipers.v1_mv;
    const dvMm = dvMv * gain;
    const dvUv = dvMv * 1000.0;
    const slope = dtMs > 1 ? (dvMv / (dtMs / 1000.0)) : 0;

    el.freeDeltaT.textContent = `${dtMs.toFixed(1)} мс (${dtMm.toFixed(2)} мм)`;
    el.freeEqBpm.textContent = `${eqBpm.toFixed(1)} уд/мин`;
    el.freeDeltaV.textContent = `${dvMv >= 0 ? "+" : ""}${dvMv.toFixed(3)} мВ (${dvMm.toFixed(1)} мм / ${dvUv.toFixed(0)} мкВ)`;
    el.freeSlope.textContent = `${slope >= 0 ? "+" : ""}${slope.toFixed(2)} мВ/с`;
  }

  // Updates the Clinical Intervals & Segments Table (#tbodyIntervals)
  function renderIntervalsTelemetryTable(live) {
    if (!live || !state.digitization) return;
    const speed = state.digitization.paper_speed_mm_s || 25;
    const msToMm = (ms) => ((ms / 1000.0) * speed).toFixed(2);

    const rows = [
      {
        name: "ЧСС / Интервал RR",
        bounds: "R(i) → R(i+1)",
        val: `${live.intervals_ms.rr.toFixed(0)} мс (${live.hr_bpm.toFixed(1)} уд/мин)`,
        mm: `${msToMm(live.intervals_ms.rr)} мм`,
        ref: "600–1000 мс (60–100 уд/мин)",
        status: live.hr_bpm < 60 ? ["warn", "Брадикардия"] : (live.hr_bpm > 100 ? ["warn", "Тахикардия"] : ["normal", "Норма"]),
      },
      {
        name: "Зубец P (длительность)",
        bounds: "P_on → P_off",
        val: `${live.durations_ms.p_wave.toFixed(0)} мс`,
        mm: `${msToMm(live.durations_ms.p_wave)} мм`,
        ref: "80–110 мс (≤ 120 мс)",
        status: live.durations_ms.p_wave > 120 ? ["warn", "Уширение P"] : ["normal", "Норма"],
      },
      {
        name: "Интервал PQ (PR)",
        bounds: "P_on → QRS_on",
        val: `${live.intervals_ms.pq_pr.toFixed(0)} мс`,
        mm: `${msToMm(live.intervals_ms.pq_pr)} мм`,
        ref: "120–200 мс",
        status:
          live.intervals_ms.pq_pr > 200
            ? ["alert", "АВ-блокада I ст. (>200)"]
            : live.intervals_ms.pq_pr < 120
            ? ["warn", "Укорочение PQ (<120)"]
            : ["normal", "Норма"],
      },
      {
        name: "Сегмент PQ (PR)",
        bounds: "P_off → QRS_on",
        val: `${live.segments_ms.pq_pr_segment.toFixed(0)} мс`,
        mm: `${msToMm(live.segments_ms.pq_pr_segment)} мм`,
        ref: "40–100 мс",
        status: ["normal", "Изолиния"],
      },
      {
        name: "Комплекс QRS",
        bounds: "QRS_on → J (QRS_off)",
        val: `${live.durations_ms.qrs_complex.toFixed(0)} мс`,
        mm: `${msToMm(live.durations_ms.qrs_complex)} мм`,
        ref: "60–100 мс (< 120 мс)",
        status:
          live.durations_ms.qrs_complex >= 120
            ? ["alert", "Расширен ≥ 120 мс (БНПГ)"]
            : live.durations_ms.qrs_complex > 105
            ? ["warn", "Неполная блокада (>105)"]
            : ["normal", "Норма"],
      },
      {
        name: "Внутр. отклонение (VAT)",
        bounds: "QRS_on → R_peak",
        val: `${live.durations_ms.intrinsicoid_vat.toFixed(0)} мс`,
        mm: `${msToMm(live.durations_ms.intrinsicoid_vat)} мм`,
        ref: "≤ 35 мс (V1), ≤ 45 мс (V5–V6)",
        status: live.durations_ms.intrinsicoid_vat > 50 ? ["warn", "> 50 мс"] : ["normal", "Норма"],
      },
      {
        name: "Сегмент ST (длительность)",
        bounds: "J (QRS_off) → T_on",
        val: `${live.segments_ms.st_segment.toFixed(0)} мс`,
        mm: `${msToMm(live.segments_ms.st_segment)} мм`,
        ref: "80–120 мс",
        status: ["normal", "Измерено"],
      },
      {
        name: "Зубец T (длительность)",
        bounds: "T_on → T_off",
        val: `${live.durations_ms.t_wave.toFixed(0)} мс`,
        mm: `${msToMm(live.durations_ms.t_wave)} мм`,
        ref: "120–200 мс",
        status: ["normal", "Измерено"],
      },
      {
        name: "Интервал QT",
        bounds: "QRS_on → T_off",
        val: `${live.intervals_ms.qt.toFixed(0)} мс`,
        mm: `${msToMm(live.intervals_ms.qt)} мм`,
        ref: "350–440 мс (зависит от ЧСС)",
        status: ["normal", "См. QTc"],
      },
      {
        name: "Интервал QTc (Fridericia)",
        bounds: "QT / ∛RR",
        val: `${live.intervals_ms.qtc_fridericia.toFixed(0)} мс`,
        mm: "—",
        ref: "350–450 мс (муж), 350–460 мс (жен)",
        status:
          live.intervals_ms.qtc_fridericia > 460
            ? ["alert", "Удлинение QTc (>460)"]
            : live.intervals_ms.qtc_fridericia < 340
            ? ["warn", "Укорочение QTc"]
            : ["normal", "Норма"],
      },
      {
        name: "Интервал JT / JTc",
        bounds: "J → T_off (QT − QRS)",
        val: `${live.intervals_ms.jt.toFixed(0)} / ${live.intervals_ms.jtc_bazett.toFixed(0)} мс`,
        mm: `${msToMm(live.intervals_ms.jt)} мм`,
        ref: "JTc ≤ 360 мс",
        status: live.intervals_ms.jtc_bazett > 360 ? ["warn", "JTc > 360"] : ["normal", "Норма"],
      },
      {
        name: "Интервал Tp–Te (Tpeak–Tend)",
        bounds: "T_peak → T_off",
        val: `${live.intervals_ms.tp_te.toFixed(0)} мс (TpTe/QT = ${live.ratios.tpte_qt_ratio.toFixed(2)})`,
        mm: `${msToMm(live.intervals_ms.tp_te)} мм`,
        ref: "60–110 мс (TpTe/QT 0.15–0.25)",
        status: live.intervals_ms.tp_te > 115 ? ["warn", "Дисперсия реполяризации"] : ["normal", "Норма"],
      },
      {
        name: "Сегмент TP (диастола)",
        bounds: "T_off(i) → P_on(i+1)",
        val: `${live.segments_ms.tp_segment.toFixed(0)} мс`,
        mm: `${msToMm(live.segments_ms.tp_segment)} мм`,
        ref: "Изоэлектрический сегмент",
        status: ["normal", "Изолиния"],
      },
    ];

    el.tbodyIntervals.innerHTML = rows
      .map(
        (r) => `
      <tr>
        <td><strong>${r.name}</strong></td>
        <td class="mono-val">${r.bounds}</td>
        <td class="mono-val">${r.val}</td>
        <td class="mono-val">${r.mm}</td>
        <td>${r.ref}</td>
        <td><span class="badge-status badge-${r.status[0]}">${r.status[1]}</span></td>
      </tr>`
      )
      .join("");
  }

  function renderQtcAndAmplitudes(live) {
    if (!live || !state.digitization) return;
    const gain = state.digitization.gain_mm_mv || 10;
    const iv = live.intervals_ms;
    const amp = live.amplitudes_mv;

    el.qtcFormulaGrid.innerHTML = `
      <div class="qtc-box">
        <span class="qtc-label">QTc Bazett</span>
        <span class="qtc-val">${iv.qtc_bazett.toFixed(0)} мс</span>
        <span class="qtc-formula">QT / √RR</span>
      </div>
      <div class="qtc-box">
        <span class="qtc-label">QTc Fridericia</span>
        <span class="qtc-val">${iv.qtc_fridericia.toFixed(0)} мс</span>
        <span class="qtc-formula">QT / ∛RR</span>
      </div>
      <div class="qtc-box">
        <span class="qtc-label">QTc Framingham</span>
        <span class="qtc-val">${iv.qtc_framingham.toFixed(0)} мс</span>
        <span class="qtc-formula">QT + 154·(1 − RR)</span>
      </div>
      <div class="qtc-box">
        <span class="qtc-label">QTc Hodges</span>
        <span class="qtc-val">${iv.qtc_hodges.toFixed(0)} мс</span>
        <span class="qtc-formula">QT + 1.75·(ЧСС − 60)</span>
      </div>
    `;

    const fmtMv = (v) => {
      if (v === undefined || v === null) return "—";
      const sign = v >= 0 ? "+" : "";
      return `${sign}${v.toFixed(2)} мВ (${sign}${(v * gain).toFixed(1)} мм)`;
    };

    el.ampBadgesGrid.innerHTML = `
      <div class="amp-item"><span>Зубец P</span><strong>${fmtMv(amp.p_amp_mv)}</strong></div>
      <div class="amp-item"><span>Зубец Q</span><strong>${fmtMv(amp.q_amp_mv)}</strong></div>
      <div class="amp-item"><span>Зубец R</span><strong>${fmtMv(amp.r_amp_mv)}</strong></div>
      <div class="amp-item"><span>Зубец S</span><strong>${fmtMv(amp.s_amp_mv)}</strong></div>
      <div class="amp-item"><span>Точка J</span><strong>${fmtMv(amp.j_point_mv)}</strong></div>
      <div class="amp-item"><span>ST (J+60 мс)</span><strong>${fmtMv(amp.st_60_mv)}</strong></div>
      <div class="amp-item"><span>ST (J+80 мс)</span><strong>${fmtMv(amp.st_80_mv)}</strong></div>
      <div class="amp-item"><span>Наклон ST</span><strong>${amp.st_slope_mv_s >= 0 ? "+" : ""}${amp.st_slope_mv_s.toFixed(2)} мВ/с</strong></div>
      <div class="amp-item"><span>Зубец T</span><strong>${fmtMv(amp.t_amp_mv)}</strong></div>
    `;

    // Clinical interpretation flags
    const flags = [];
    if (live.hr_bpm < 60) {
      flags.push({ level: "warn", text: `Брадикардия: ЧСС ${live.hr_bpm.toFixed(0)} уд/мин (RR = ${live.rr_ms.toFixed(0)} мс)` });
    } else if (live.hr_bpm > 100) {
      flags.push({ level: "warn", text: `Тахикардия: ЧСС ${live.hr_bpm.toFixed(0)} уд/мин (RR = ${live.rr_ms.toFixed(0)} мс)` });
    } else {
      flags.push({ level: "normal", text: `ЧСС в пределах нормокардии: ${live.hr_bpm.toFixed(0)} уд/мин` });
    }

    if (iv.pq_pr > 200) {
      flags.push({ level: "alert", text: `Удлинение интервала PQ (${iv.pq_pr.toFixed(0)} мс > 200 мс) — признак АВ-блокады I степени` });
    } else if (iv.pq_pr < 120) {
      flags.push({ level: "warn", text: `Укорочение интервала PQ (${iv.pq_pr.toFixed(0)} мс < 120 мс)` });
    }

    if (live.durations_ms.qrs_complex >= 120) {
      flags.push({ level: "alert", text: `Широкий комплекс QRS (${live.durations_ms.qrs_complex.toFixed(0)} мс ≥ 120 мс) — блокада ножки пучка Гиса / ВЖБ` });
    }

    if (amp.st_80_mv >= 0.1) {
      flags.push({ level: "alert", text: `Элевация сегмента ST в отведении ${state.activeLead}: +${amp.st_80_mv.toFixed(2)} мВ (+${(amp.st_80_mv * gain).toFixed(1)} мм на J+80 мс)` });
    } else if (amp.st_80_mv <= -0.1) {
      flags.push({ level: "alert", text: `Депрессия сегмента ST в отведении ${state.activeLead}: ${amp.st_80_mv.toFixed(2)} мВ (${(amp.st_80_mv * gain).toFixed(1)} мм на J+80 мс)` });
    } else {
      flags.push({ level: "normal", text: `Сегмент ST в отведении ${state.activeLead} близко к изолинии (${amp.st_80_mv >= 0 ? "+" : ""}${amp.st_80_mv.toFixed(2)} мВ)` });
    }

    el.clinicalFlagsBox.innerHTML = flags
      .map((f) => `<div class="flag-row badge-${f.level}">${f.text}</div>`)
      .join("");

    if (live.ratios.macruz_index !== null && live.ratios.macruz_index !== undefined) {
      el.valMacruz.textContent = `${live.ratios.macruz_index.toFixed(2)} (норма 1.1–1.6)`;
    } else {
      el.valMacruz.textContent = "—";
    }
  }

  // Draws the Hexaxial Einthoven/Bailey Vector Dial (#hexaxialCanvas)
  function renderHexaxialCompass() {
    if (!state.analysis) return;
    const axes = state.analysis.axes || {};
    const hyp = state.analysis.hypertrophy || {};

    el.valQrsAxis.textContent = axes.qrs_axis_deg !== null && axes.qrs_axis_deg !== undefined ? `${axes.qrs_axis_deg >= 0 ? "+" : ""}${axes.qrs_axis_deg}°` : "Н/Д";
    el.valPAxis.textContent = axes.p_axis_deg !== null && axes.p_axis_deg !== undefined ? `${axes.p_axis_deg >= 0 ? "+" : ""}${axes.p_axis_deg}°` : "Н/Д";
    el.valTAxis.textContent = axes.t_axis_deg !== null && axes.t_axis_deg !== undefined ? `${axes.t_axis_deg >= 0 ? "+" : ""}${axes.t_axis_deg}°` : "Н/Д";
    el.valQrsTAngle.textContent = axes.qrs_t_angle_deg !== null && axes.qrs_t_angle_deg !== undefined ? `${axes.qrs_t_angle_deg}° (норма < 60°)` : "Н/Д";
    el.valAxisClass.textContent = axes.classification || "—";

    el.valSokolow.textContent = hyp.sokolow_lyon_mv !== undefined
      ? `${hyp.sokolow_lyon_mv.toFixed(2)} мВ (${hyp.sokolow_lyon_mm.toFixed(1)} мм) ${hyp.sokolow_lyon_lvh ? "⚠️ ГЛЖ" : "(норма < 3.5 мВ)"}`
      : "Нет V1/V5–V6";

    const cornThr = hyp.cornell_threshold_mv || 2.8;
    el.valCornell.textContent = hyp.cornell_mv !== undefined
      ? `${hyp.cornell_mv.toFixed(2)} мВ (${hyp.cornell_mm.toFixed(1)} мм) ` +
        (hyp.cornell_lvh
          ? "⚠️ ГЛЖ"
          : hyp.cornell_lvh_if_female
            ? "(⚠️ ГЛЖ, если пациент — женщина: порог 2.0 мВ)"
            : `(норма < ${cornThr.toFixed(1)} мВ)`)
      : "Нет aVL/V3";

    const canvas = el.hexaxialCanvas;
    const dpr = window.devicePixelRatio || 1;
    const size = 232;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const cx = size / 2;
    const cy = size / 2;
    const r = 86;

    ctx.clearRect(0, 0, size, size);

    // Normal QRS axis shaded sector (-30° to +90°)
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, (-30 * Math.PI) / 180, (90 * Math.PI) / 180, false);
    ctx.closePath();
    ctx.fillStyle = "rgba(11, 122, 83, 0.10)";
    ctx.fill();

    // Outer circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#CBD5E0";
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // 6 Hexaxial reference axes
    const leadAxes = [
      { deg: 0, name: "I (0°)" },
      { deg: 60, name: "II (+60°)" },
      { deg: 90, name: "aVF (+90°)" },
      { deg: 120, name: "III (+120°)" },
      { deg: -30, name: "aVL (-30°)" },
      { deg: -150, name: "aVR (-150°)" },
    ];

    ctx.font = "500 9.5px 'IBM Plex Mono', monospace";
    ctx.fillStyle = "#718096";
    ctx.textAlign = "center";
    leadAxes.forEach((ax) => {
      const rad = (ax.deg * Math.PI) / 180;
      ctx.beginPath();
      ctx.strokeStyle = "#E2E8F0";
      ctx.lineWidth = 1;
      ctx.moveTo(cx - Math.cos(rad) * r, cy - Math.sin(rad) * r);
      ctx.lineTo(cx + Math.cos(rad) * r, cy + Math.sin(rad) * r);
      ctx.stroke();

      const lx = cx + Math.cos(rad) * (r + 17);
      const ly = cy + Math.sin(rad) * (r + 14);
      ctx.fillText(ax.name, lx, ly + 3);
    });

    // Helper to draw vector arrow
    const drawVector = (deg, color, lenFactor, label) => {
      if (deg === null || deg === undefined) return;
      const rad = (deg * Math.PI) / 180;
      const vx = cx + Math.cos(rad) * (r * lenFactor);
      const vy = cy + Math.sin(rad) * (r * lenFactor);

      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(vx, vy);
      ctx.stroke();

      // Arrowhead
      const headLen = 8;
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      ctx.lineTo(vx - headLen * Math.cos(rad - 0.35), vy - headLen * Math.sin(rad - 0.35));
      ctx.lineTo(vx - headLen * Math.cos(rad + 0.35), vy - headLen * Math.sin(rad + 0.35));
      ctx.closePath();
      ctx.fill();

      ctx.font = "700 10px 'IBM Plex Mono', monospace";
      ctx.fillText(label, vx + Math.cos(rad) * 10, vy + Math.sin(rad) * 10);
      ctx.restore();
    };

    drawVector(axes.p_axis_deg, "#0F4C81", 0.62, "P");
    drawVector(axes.t_axis_deg, "#0B7A53", 0.74, "T");
    drawVector(axes.qrs_axis_deg, "#D9381E", 0.90, "QRS");
  }

  /**
   * Synthesizes 3D Orthogonal Frank-Kors Vectorcardiogram (VCG) loops (X, Y, Z)
   * time-synchronized to the active beat and live caliper boundaries (P, QRS, T).
   */
  function synthesizeVcgLoops() {
    if (!state.digitization || !state.digitization.leads_mv || !state.analysis) return null;
    const leadsMap = state.digitization.leads_mv;
    const fs = state.digitization.sampling_rate_hz || 500;
    const c = state.calipersMs;

    // Relative offsets (in samples) around R_peak from the active caliper settings
    const toSamp = (ms) => Math.round((ms * fs) / 1000.0);
    const rRefSamp = toSamp(c.r_peak);
    const dPon = Math.min(-15, toSamp(c.p_onset) - rRefSamp);
    const dPoff = Math.min(-5, toSamp(c.p_offset) - rRefSamp);
    const dQon = Math.min(-4, toSamp(c.qrs_onset) - rRefSamp);
    const dQoff = Math.max(4, toSamp(c.qrs_offset) - rRefSamp);
    const dTon = Math.max(dQoff, toSamp(c.t_onset) - rRefSamp);
    const dToff = Math.max(dTon + 10, toSamp(c.t_offset) - rRefSamp);

    // Helper: sample a lead at offset `dSamp` relative to that lead's aligned R-peak, minus PR isoelectric level
    const leadAnchors = {};
    Object.keys(leadsMap).forEach((ln) => {
      const sig = leadsMap[ln];
      if (!sig || sig.length < 10) return;
      const lAna = state.analysis.leads && state.analysis.leads[ln];
      let rIdx = rRefSamp;
      if (ln === state.activeLead) {
        rIdx = rRefSamp;
      } else if (lAna && lAna.beats && lAna.beats.length > 0) {
        const bIdx = Math.min(state.activeBeatIdx, lAna.beats.length - 1);
        rIdx = lAna.beats[bIdx].r_peak;
      } else if (lAna && lAna.r_peaks && lAna.r_peaks.length > 0) {
        rIdx = lAna.r_peaks[Math.floor(lAna.r_peaks.length / 2)];
      }
      rIdx = Math.max(0, Math.min(sig.length - 1, rIdx));
      const isoIdx = Math.max(0, Math.min(sig.length - 1, rIdx + dQon));
      let isoSum = 0;
      let cnt = 0;
      for (let k = Math.max(0, isoIdx - 6); k <= isoIdx; k++) {
        isoSum += sig[k];
        cnt++;
      }
      leadAnchors[ln] = { sig, rIdx, iso: cnt > 0 ? isoSum / cnt : 0 };
    });

    const getVal = (ln, dSamp) => {
      const a = leadAnchors[ln];
      if (!a) return 0.0;
      const idx = Math.max(0, Math.min(a.sig.length - 1, a.rIdx + dSamp));
      return (a.sig[idx] || 0) - a.iso;
    };

    const hasLimb = Boolean(leadAnchors["I"] && (leadAnchors["II"] || leadAnchors["aVF"]));
    const hasChest = Boolean(leadAnchors["V1"] && (leadAnchors["V5"] || leadAnchors["V6"]));

    let methodLabel = "Матрица Корса (12 отв.)";
    if (hasLimb && !hasChest) {
      methodLabel = "Эйнтховен–Гольдбергер (I, II, aVF)";
    } else if (!hasLimb && hasChest) {
      methodLabel = "Ортогональная грудная (V1–V6)";
    }

    // Compute (X, Y, Z_ant) in mV at relative sample offset dSamp
    // Convention: +X = Left (0°), +Y = Inferior (+90° down), +Z = Anterior (forward toward chest)
    const evalXYZ = (dSamp) => {
      const I = getVal("I", dSamp);
      const II = leadAnchors["II"] ? getVal("II", dSamp) : (leadAnchors["II (ритм)"] ? getVal("II (ритм)", dSamp) : 0);
      const aVF = leadAnchors["aVF"] ? getVal("aVF", dSamp) : (II - 0.5 * I);
      const V1 = getVal("V1", dSamp);
      const V2 = getVal("V2", dSamp);
      const V3 = getVal("V3", dSamp);
      const V4 = getVal("V4", dSamp);
      const V5 = getVal("V5", dSamp);
      const V6 = getVal("V6", dSamp);

      if (hasLimb && hasChest) {
        // Kors Regression Matrix (1990)
        const X = 0.38 * I - 0.07 * II - 0.13 * V1 + 0.05 * V2 - 0.01 * V3 + 0.14 * V4 + 0.06 * V5 + 0.54 * V6;
        const Y = -0.07 * I + 0.93 * II + 0.06 * V1 - 0.02 * V2 - 0.05 * V3 + 0.06 * V4 - 0.17 * V5 + 0.13 * V6;
        // Standard Kors Z is posterior; negate so +Z is Anterior (clinical horizontal plane standard)
        const Z_post = 0.11 * I - 0.23 * II - 0.43 * V1 - 0.06 * V2 - 0.14 * V3 - 0.20 * V4 - 0.11 * V5 + 0.31 * V6;
        return { x: X, y: Y, z: -Z_post, ms: (dSamp * 1000.0) / fs };
      } else if (hasLimb) {
        const X = I;
        const Y = aVF;
        const Z = 0.22 * II - 0.14 * I;
        return { x: X, y: Y, z: Z, ms: (dSamp * 1000.0) / fs };
      } else {
        const X = -0.13 * V1 + 0.05 * V2 + 0.14 * V4 + 0.20 * V5 + 0.54 * V6;
        const Y = 0.06 * V1 - 0.05 * V3 + 0.25 * V5 + 0.35 * V6;
        const Z = 0.43 * V1 + 0.12 * V2 + 0.14 * V3 + 0.18 * V4 - 0.31 * V6;
        return { x: X, y: Y, z: Z, ms: (dSamp * 1000.0) / fs };
      }
    };

    const buildLoop = (dStart, dEnd, anchorOrigin = false) => {
      const pts = [];
      const p0 = evalXYZ(dStart);
      for (let d = dStart; d <= dEnd; d++) {
        const p = evalXYZ(d);
        if (anchorOrigin) {
          pts.push({
            x: p.x - p0.x,
            y: p.y - p0.y,
            z: p.z - p0.z,
            ms: p.ms,
            relMs: ((d - dStart) * 1000.0) / fs,
          });
        } else {
          pts.push({
            ...p,
            relMs: ((d - dStart) * 1000.0) / fs,
          });
        }
      }
      return pts;
    };

    const pLoop = buildLoop(dPon, dPoff, true);
    const qrsLoop = buildLoop(dQon, dQoff, true);
    const qrsStartRaw = evalXYZ(dQon);
    const tLoop = [];
    for (let d = dQoff; d <= dToff; d++) {
      const p = evalXYZ(d);
      tLoop.push({
        x: p.x - qrsStartRaw.x,
        y: p.y - qrsStartRaw.y,
        z: p.z - qrsStartRaw.z,
        ms: p.ms,
        relMs: ((d - dQoff) * 1000.0) / fs,
      });
    }

    // Find maximum 3D vectors Vmax_QRS and Vmax_T
    const findMaxVec = (loop) => {
      let best = { x: 0, y: 0, z: 0, mag: 0, ms: 0 };
      loop.forEach((p) => {
        const m = Math.hypot(p.x, p.y, p.z);
        if (m > best.mag) {
          best = { ...p, mag: m };
        }
      });
      return best;
    };

    const vMaxQrs = findMaxVec(qrsLoop);
    const vMaxT = findMaxVec(tLoop);
    const vMaxP = findMaxVec(pLoop);
    const jPoint = qrsLoop.length > 0 ? qrsLoop[qrsLoop.length - 1] : { x: 0, y: 0, z: 0 };

    // 3D Spatial QRS-T angle (degrees)
    let spatialAngleDeg = null;
    if (vMaxQrs.mag > 1e-4 && vMaxT.mag > 1e-4) {
      const dot = vMaxQrs.x * vMaxT.x + vMaxQrs.y * vMaxT.y + vMaxQrs.z * vMaxT.z;
      const cosVal = Math.max(-1.0, Math.min(1.0, dot / (vMaxQrs.mag * vMaxT.mag)));
      spatialAngleDeg = (Math.acos(cosVal) * 180.0) / Math.PI;
    }

    // Spatial Ventricular Gradient (SVG — Wilson's Gradient in mV*ms)
    const dtMs = 1000.0 / fs;
    let svgX = 0, svgY = 0, svgZ = 0;
    qrsLoop.forEach((p) => { svgX += p.x * dtMs; svgY += p.y * dtMs; svgZ += p.z * dtMs; });
    tLoop.forEach((p) => { svgX += p.x * dtMs; svgY += p.y * dtMs; svgZ += p.z * dtMs; });
    const svgMag = Math.hypot(svgX, svgY, svgZ);

    // Loop rotation direction via signed shoelace area in Frontal (XY) and Horizontal (XZ) planes
    const calcRotation = (loop, k1, k2) => {
      if (loop.length < 4) return "—";
      let area2 = 0;
      for (let i = 0; i < loop.length - 1; i++) {
        area2 += loop[i][k1] * loop[i + 1][k2] - loop[i + 1][k1] * loop[i][k2];
      }
      // In screen coordinates where +k1 is right and +k2 is down, area2 > 0 is clockwise (CW), area2 < 0 is CCW
      if (Math.abs(area2) < 1e-4) return "Линейная";
      return area2 < 0 ? "Против час. (CCW)" : "По часовой (CW)";
    };

    const rotFrontal = calcRotation(qrsLoop, "x", "y");
    const rotHoriz = calcRotation(qrsLoop, "x", "z");

    return {
      methodLabel,
      pLoop,
      qrsLoop,
      tLoop,
      jPoint,
      vMaxP,
      vMaxQrs,
      vMaxT,
      spatialAngleDeg,
      svgMag,
      rotFrontal,
      rotHoriz,
    };
  }

  /**
   * Renders the Vectorcardiogram (VCG) loops and updates spatial 3D VCG metrics.
   */
  function renderVectorcardiogram() {
    if (!el.vcgCanvas) return;
    const vcg = synthesizeVcgLoops();
    if (!vcg) return;

    // Update VCG telemetry strip
    el.vcgMethodLbl.textContent = vcg.methodLabel;
    const qrsFrontalDeg = (Math.atan2(vcg.vMaxQrs.y, vcg.vMaxQrs.x) * 180.0) / Math.PI;
    const tFrontalDeg = (Math.atan2(vcg.vMaxT.y, vcg.vMaxT.x) * 180.0) / Math.PI;

    el.vcgMaxQrs.textContent = `${vcg.vMaxQrs.mag.toFixed(2)} мВ (${qrsFrontalDeg >= 0 ? "+" : ""}${qrsFrontalDeg.toFixed(0)}°)`;
    el.vcgMaxT.textContent = `${vcg.vMaxT.mag.toFixed(2)} мВ (${tFrontalDeg >= 0 ? "+" : ""}${tFrontalDeg.toFixed(0)}°)`;
    el.vcgSpatialAngle.textContent = vcg.spatialAngleDeg !== null
      ? `${vcg.spatialAngleDeg.toFixed(1)}° ${vcg.spatialAngleDeg > 105 ? "⚠️ (>105°)" : "(Норма <105°)"}`
      : "Н/Д";
    el.vcgSvgVal.textContent = `${vcg.svgMag.toFixed(1)} мВ·мс`;
    el.vcgRotationLbl.textContent = `XY: ${vcg.rotFrontal} • XZ: ${vcg.rotHoriz}`;

    const canvas = el.vcgCanvas;
    const container = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = Math.max(440, container.clientWidth || 680);
    const cssHeight = 270;

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    // Determine auto-scale (max mV excursion across all loops)
    let maxAbsMv = 0.35;
    [...vcg.pLoop, ...vcg.qrsLoop, ...vcg.tLoop].forEach((p) => {
      maxAbsMv = Math.max(maxAbsMv, Math.abs(p.x), Math.abs(p.y), Math.abs(p.z));
    });
    maxAbsMv *= 1.18;

    const showVectors = el.chkVcgVectors ? el.chkVcgVectors.checked : true;
    const showArrows = el.chkVcgArrows ? el.chkVcgArrows.checked : true;

    // Draw a single 2D planar projection inside box [bx, by, bw, bh]
    const drawPlanarProjection = (bx, by, bw, bh, title, axisHLabel, axisVLabel, getU, getV) => {
      const cx = bx + bw * 0.5;
      const cy = by + bh * 0.53;
      const radiusPx = Math.min(bw, bh) * 0.38;
      const scalePxPerMv = radiusPx / maxAbsMv;

      // Subtle card frame & millimeter reticle
      ctx.save();
      ctx.fillStyle = "#FFFDFB";
      ctx.strokeStyle = "#E2E8F0";
      ctx.lineWidth = 1;
      ctx.fillRect(bx + 3, by + 3, bw - 6, bh - 6);
      ctx.strokeRect(bx + 3, by + 3, bw - 6, bh - 6);

      // Concentric mV calibration rings (0.25 mV, 0.5 mV, 1.0 mV)
      const ringStep = maxAbsMv > 1.2 ? 0.5 : 0.25;
      ctx.strokeStyle = "rgba(200, 62, 77, 0.16)";
      ctx.fillStyle = "#A0AEC0";
      ctx.font = "500 9px 'IBM Plex Mono', monospace";
      for (let mv = ringStep; mv <= maxAbsMv; mv += ringStep) {
        const rPx = mv * scalePxPerMv;
        ctx.beginPath();
        ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillText(`${mv.toFixed(2).replace(/0$/, "")}`, cx + 3, cy - rPx + 9);
      }

      // Orthogonal axes crosshairs
      ctx.strokeStyle = "rgba(74, 85, 104, 0.45)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(bx + 12, cy);
      ctx.lineTo(bx + bw - 12, cy);
      ctx.moveTo(cx, by + 22);
      ctx.lineTo(cx, by + bh - 12);
      ctx.stroke();

      // Title & axis labels
      ctx.fillStyle = "#141923";
      ctx.font = "600 11px 'IBM Plex Sans', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(title, bx + 10, by + 16);

      ctx.fillStyle = "#4A5568";
      ctx.font = "600 9.5px 'IBM Plex Mono', monospace";
      ctx.textAlign = "right";
      ctx.fillText(axisHLabel, bx + bw - 10, cy - 4);
      ctx.textAlign = "left";
      ctx.fillText(axisVLabel, cx + 5, by + bh - 12);

      const toScreen = (pt) => ({
        x: cx + getU(pt) * scalePxPerMv,
        y: cy + getV(pt) * scalePxPerMv,
      });

      // Helper to render one loop with 10ms tear-drop dashes and direction arrows
      const renderLoop = (loop, color, lineWidth, isQrs = false) => {
        if (!loop || loop.length < 2) return;
        // Shaded loop interior
        ctx.beginPath();
        loop.forEach((pt, idx) => {
          const s = toScreen(pt);
          if (idx === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.closePath();
        ctx.fillStyle = isQrs ? "rgba(217, 56, 30, 0.07)" : "rgba(11, 122, 83, 0.06)";
        ctx.fill();

        // Main loop trajectory
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.lineJoin = "round";
        loop.forEach((pt, idx) => {
          const s = toScreen(pt);
          if (idx === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.stroke();

        // 10 ms time markers and directional rotation chevrons
        if (showArrows) {
          const fs = (state.digitization && state.digitization.sampling_rate_hz) || 500;
          const step10ms = Math.max(2, Math.round(0.010 * fs));
          ctx.fillStyle = color;
          for (let i = step10ms; i < loop.length - 1; i += step10ms) {
            const sPrev = toScreen(loop[i - 1]);
            const sCurr = toScreen(loop[i]);
            const dx = sCurr.x - sPrev.x;
            const dy = sCurr.y - sPrev.y;
            const segLen = Math.hypot(dx, dy);
            // Draw 10ms node dot
            ctx.beginPath();
            ctx.arc(sCurr.x, sCurr.y, isQrs ? 2.2 : 1.6, 0, Math.PI * 2);
            ctx.fill();

            // Draw directional arrow chevron at ~35% and ~68% of QRS/T loop
            if (segLen >= 2.2 && (i === step10ms * 2 || i === step10ms * 4 || i === Math.floor(loop.length * 0.45))) {
              const ang = Math.atan2(dy, dx);
              const ah = 5.5;
              ctx.beginPath();
              ctx.moveTo(sCurr.x + Math.cos(ang) * 2, sCurr.y + Math.sin(ang) * 2);
              ctx.lineTo(sCurr.x - ah * Math.cos(ang - 0.45), sCurr.y - ah * Math.sin(ang - 0.45));
              ctx.lineTo(sCurr.x - ah * Math.cos(ang + 0.45), sCurr.y - ah * Math.sin(ang + 0.45));
              ctx.closePath();
              ctx.fill();
            }
          }
        }
      };

      // Render P, T, and QRS loops
      renderLoop(vcg.pLoop, "#0F4C81", 1.5, false);
      renderLoop(vcg.tLoop, "#0B7A53", 1.85, false);
      renderLoop(vcg.qrsLoop, "#D9381E", 2.25, true);

      // Draw Vmax vectors for QRS and T
      if (showVectors) {
        const drawMaxVec = (vecPt, color, lbl) => {
          const s = toScreen(vecPt);
          if (Math.hypot(s.x - cx, s.y - cy) < 5) return;
          ctx.save();
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          ctx.lineWidth = 1.4;
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(s.x, s.y);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.beginPath();
          ctx.arc(s.x, s.y, 3.0, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = "700 9.5px 'IBM Plex Mono', monospace";
          ctx.fillText(lbl, s.x + 4, s.y - 3);
          ctx.restore();
        };
        drawMaxVec(vcg.vMaxQrs, "#B02310", "VmaxQRS");
        drawMaxVec(vcg.vMaxT, "#0B7A53", "VmaxT");
      }

      // Mark J-point
      const sJ = toScreen(vcg.jPoint);
      ctx.fillStyle = "#B06000";
      ctx.beginPath();
      ctx.arc(sJ.x, sJ.y, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "700 9.5px 'IBM Plex Mono', monospace";
      ctx.fillText("J", sJ.x + 4, sJ.y + 9);

      ctx.restore();
    };

    // Draw 3D Axonometric Isometric View
    const draw3DIsometric = (bx, by, bw, bh) => {
      const cx = bx + bw * 0.48;
      const cy = by + bh * 0.52;
      const radiusPx = Math.min(bw, bh) * 0.39;
      const scale = radiusPx / maxAbsMv;

      ctx.save();
      ctx.fillStyle = "#FFFDFB";
      ctx.fillRect(bx, by, bw, bh);

      // Isometric projection: +X (left-front-right), +Y (down), +Z (anterior-left-down)
      const isoProject = (pt) => {
        const u = (pt.x * 0.88 - pt.z * 0.48) * scale;
        const v = (pt.y * 0.88 + pt.z * 0.32 + pt.x * 0.12) * scale;
        return { x: cx + u, y: cy + v };
      };

      // Draw 3D coordinate axes
      const axes3D = [
        { pt: { x: maxAbsMv, y: 0, z: 0 }, name: "+X (Влево)", color: "#4A5568" },
        { pt: { x: 0, y: maxAbsMv, z: 0 }, name: "+Y (Вниз / aVF)", color: "#4A5568" },
        { pt: { x: 0, y: 0, z: maxAbsMv }, name: "+Z (Вперёд / Ant)", color: "#0F4C81" },
      ];
      axes3D.forEach((ax) => {
        const pPos = isoProject(ax.pt);
        const pNeg = isoProject({ x: -ax.pt.x * 0.7, y: -ax.pt.y * 0.7, z: -ax.pt.z * 0.7 });
        ctx.strokeStyle = "#CBD5E0";
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(pNeg.x, pNeg.y);
        ctx.lineTo(pPos.x, pPos.y);
        ctx.stroke();

        ctx.fillStyle = ax.color;
        ctx.font = "600 10px 'IBM Plex Mono', monospace";
        ctx.fillText(ax.name, pPos.x + 4, pPos.y + 3);
      });

      const draw3DLoop = (loop, color, lw) => {
        if (!loop || loop.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = lw;
        loop.forEach((pt, idx) => {
          const s = isoProject(pt);
          if (idx === 0) ctx.moveTo(s.x, s.y);
          else ctx.lineTo(s.x, s.y);
        });
        ctx.stroke();
      };

      draw3DLoop(vcg.pLoop, "#0F4C81", 1.6);
      draw3DLoop(vcg.tLoop, "#0B7A53", 2.0);
      draw3DLoop(vcg.qrsLoop, "#D9381E", 2.4);

      if (showVectors) {
        const sQ = isoProject(vcg.vMaxQrs);
        const sT = isoProject(vcg.vMaxT);
        ctx.strokeStyle = "#D9381E";
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(sQ.x, sQ.y);
        ctx.stroke();

        ctx.strokeStyle = "#0B7A53";
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(sT.x, sT.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = "#141923";
      ctx.font = "600 12px 'IBM Plex Sans', sans-serif";
      ctx.fillText("3D Пространственная реконструкция петель P–QRS–T (X, Y, Z)", bx + 14, by + 20);
      ctx.restore();
    };

    ctx.clearRect(0, 0, cssWidth, cssHeight);

    if (state.vcgPlane === "all3") {
      const subW = cssWidth / 3.0;
      drawPlanarProjection(
        0,
        0,
        subW,
        cssHeight,
        "Фронтальная (XY)",
        "+X (Влево)",
        "+Y (Вниз)",
        (p) => p.x,
        (p) => p.y
      );
      drawPlanarProjection(
        subW,
        0,
        subW,
        cssHeight,
        "Горизонтальная (XZ)",
        "+X (Влево)",
        "+Z (Вперёд)",
        (p) => p.x,
        (p) => p.z
      );
      drawPlanarProjection(
        subW * 2,
        0,
        subW,
        cssHeight,
        "Сагиттальная (YZ)",
        "+Z (Вперёд)",
        "+Y (Вниз)",
        (p) => p.z,
        (p) => p.y
      );
    } else if (state.vcgPlane === "frontal") {
      drawPlanarProjection(
        0,
        0,
        cssWidth,
        cssHeight,
        "Фронтальная плоскость ВКГ (XY: Влево X vs Вниз Y)",
        "+X (Влево, I)",
        "+Y (Вниз, aVF)",
        (p) => p.x,
        (p) => p.y
      );
    } else if (state.vcgPlane === "horizontal") {
      drawPlanarProjection(
        0,
        0,
        cssWidth,
        cssHeight,
        "Горизонтальная (аксиальная) плоскость ВКГ (XZ: Влево X vs Вперёд Z)",
        "+X (Влево, V6)",
        "+Z (Вперёд, V1–V2)",
        (p) => p.x,
        (p) => p.z
      );
    } else if (state.vcgPlane === "sagittal") {
      drawPlanarProjection(
        0,
        0,
        cssWidth,
        cssHeight,
        "Левая сагиттальная плоскость ВКГ (YZ: Вперёд Z vs Вниз Y)",
        "+Z (Вперёд)",
        "+Y (Вниз)",
        (p) => p.z,
        (p) => p.y
      );
    } else if (state.vcgPlane === "3d") {
      draw3DIsometric(0, 0, cssWidth, cssHeight);
    }
  }

  function renderAllLeadsTable() {
    if (!state.analysis || !state.analysis.leads) return;
    const leads = state.analysis.leads;
    const gain = (state.digitization && state.digitization.gain_mm_mv) || 10;

    el.tbodyAllLeads.innerHTML = Object.keys(leads)
      .map((ln) => {
        const m = leads[ln].metrics || {};
        const dur = m.durations_ms || {};
        const iv = m.intervals_ms || {};
        const amp = m.amplitudes_mv || {};
        const st80 = amp.st_80_mv || 0;
        const isAct = ln === state.activeLead ? "active-row" : "";

        const qi = leadQualityInfo(ln);
        const qBadge = qi.level && qi.level !== "ok"
          ? `<span class="q-badge q-${qi.level}" title="${escapeHtml(qi.title)}">${qi.level === "manual" ? "✎" : "●"}</span>`
          : "";

        return `
        <tr class="${isAct}" data-lead="${escapeHtml(ln)}">
          <td class="mono-val">${escapeHtml(ln)}${qBadge}</td>
          <td class="mono-val">${(m.hr_bpm || 0).toFixed(0)}</td>
          <td class="mono-val">${(m.rr_ms || 0).toFixed(0)}</td>
          <td class="mono-val">${(dur.p_wave || 0).toFixed(0)}</td>
          <td class="mono-val">${(iv.pq_pr || 0).toFixed(0)}</td>
          <td class="mono-val">${(dur.qrs_complex || 0).toFixed(0)}</td>
          <td class="mono-val">${(iv.qt || 0).toFixed(0)} / ${(iv.qtc_fridericia || 0).toFixed(0)}</td>
          <td class="mono-val">${(amp.p_amp_mv || 0).toFixed(2)}</td>
          <td class="mono-val">${(amp.q_amp_mv || 0).toFixed(2)}</td>
          <td class="mono-val">${(amp.r_amp_mv || 0).toFixed(2)}</td>
          <td class="mono-val">${(amp.s_amp_mv || 0).toFixed(2)}</td>
          <td class="mono-val">${(amp.j_point_mv || 0).toFixed(2)}</td>
          <td class="mono-val">${st80 >= 0 ? "+" : ""}${st80.toFixed(2)} (${(st80 * gain).toFixed(1)} мм)</td>
          <td class="mono-val">${(amp.t_amp_mv || 0).toFixed(2)}</td>
        </tr>`;
      })
      .join("");

    Array.from(el.tbodyAllLeads.querySelectorAll("tr[data-lead]")).forEach((tr) => {
      tr.addEventListener("click", () => {
        const ln = tr.getAttribute("data-lead");
        if (ln) selectLead(ln);
      });
    });
  }

  // Interactive Mouse & Touch Events for Window 1 (#multileadCanvas)
  function bindMultiLeadCanvasEvents() {
    const canvas = el.multileadCanvas;

    const getPos = (evt) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: evt.clientX - rect.left,
        y: evt.clientY - rect.top,
      };
    };

    const findW1RPeakHit = (pos) => {
      if (!state.w1RPeakHitBoxes) return null;
      return state.w1RPeakHitBoxes.find(
        (b) =>
          pos.y >= b.rowY0 &&
          pos.y <= b.rowY1 &&
          Math.abs(pos.x - b.x) <= Math.max(10, b.bw * 0.65)
      );
    };

    const findW1ChannelBox = (pos) => {
      if (!state.multileadHitBoxes) return null;
      return state.multileadHitBoxes.find(
        (b) => pos.x >= b.x0 && pos.x <= b.x1 && pos.y >= b.y0 && pos.y <= b.y1
      );
    };

    const posToChannelMs = (box, x) => {
      const rel = Math.max(0, Math.min(1, (x - box.traceX0) / Math.max(1, box.traceW)));
      return rel * (box.totalMs || 2500);
    };

    canvas.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const pos = getPos(evt);
      const rHit = findW1RPeakHit(pos);
      if (rHit) {
        deleteRPeak(rHit.lead, rHit.beatIdx);
      }
    });

    canvas.addEventListener("mousedown", (evt) => {
      if (evt.button === 2) return; // handled by contextmenu
      // Panning in 'pan' mode or with middle mouse button
      if (state.w1Tool === "pan" || evt.button === 1) {
        evt.preventDefault();
        const wrap = el.multileadContainer || canvas.parentElement;
        state.w1PanState = {
          startX: evt.clientX,
          startY: evt.clientY,
          scrollL: wrap ? wrap.scrollLeft : 0,
          scrollT: wrap ? wrap.scrollTop : 0,
        };
        canvas.style.cursor = "grabbing";
        return;
      }

      const pos = getPos(evt);
      const rHit = findW1RPeakHit(pos);
      const chBox = findW1ChannelBox(pos);
      if (!chBox) return;

      const clickMs = posToChannelMs(chBox, pos.x);

      // Alt+Click on R peak deletes it in any mode
      if (rHit && (evt.altKey || state.w1Tool === "r_add_del")) {
        deleteRPeak(rHit.lead, rHit.beatIdx);
        return;
      }

      // Shift+Click or r_add_del mode on signal adds a new R peak
      if (evt.shiftKey || (state.w1Tool === "r_add_del" && !rHit)) {
        addRPeak(chBox.lead, clickMs);
        return;
      }

      // Ctrl+Click or artifact tool in Window 1 toggles smart bold blue artifact line
      if (evt.ctrlKey || state.w1Tool === "artifact") {
        if (chBox.lead !== state.activeLead) {
          selectLead(chBox.lead);
        }
        toggleSmartArtifactAtClick(chBox.lead, clickMs);
        return;
      }

      // If clicked on an R peak badge/line in select_move mode, start dragging that R peak in Window 1
      if (rHit) {
        if (rHit.lead !== state.activeLead) {
          selectLead(rHit.lead);
        }
        state.activeBeatIdx = rHit.beatIdx;
        populateBeatDropdown(rHit.lead);
        loadBeatCalipers(rHit.lead, rHit.beatIdx);
        state.w1DragState = {
          lead: rHit.lead,
          beatIdx: rHit.beatIdx,
          box: chBox,
        };
        return;
      }

      // Otherwise select the clicked channel
      if (chBox.lead !== state.activeLead) {
        selectLead(chBox.lead);
      }
    });

    window.addEventListener("mousemove", (evt) => {
      if (state.w1PanState) {
        const wrap = el.multileadContainer || canvas.parentElement;
        if (wrap) {
          wrap.scrollLeft = state.w1PanState.scrollL - (evt.clientX - state.w1PanState.startX);
          wrap.scrollTop = state.w1PanState.scrollT - (evt.clientY - state.w1PanState.startY);
        }
        return;
      }
      if (!state.w1DragState) return;
      const pos = getPos(evt);
      const { lead, beatIdx, box } = state.w1DragState;
      const newMs = posToChannelMs(box, pos.x);
      const followIdx = moveRPeak(lead, beatIdx, newMs);
      if (followIdx >= 0) state.w1DragState.beatIdx = followIdx;
      renderMultiLeadCanvas();
    });

    window.addEventListener("mouseup", () => {
      if (state.w1PanState) {
        state.w1PanState = null;
        canvas.style.cursor = state.w1Tool === "pan" ? "grab" : "pointer";
      }
      state.w1DragState = null;
    });

    // Window 1 Zoom Controls + Ctrl+Wheel Zoom
    const setW1Zoom = (newZ, anchorEvt = null) => {
      const wrap = el.multileadContainer || canvas.parentElement;
      const oldZ = state.w1Zoom || 1.0;
      const clampedZ = Math.max(1.0, Math.min(4.0, Math.round(newZ * 2) / 2));
      if (Math.abs(clampedZ - oldZ) < 0.01) return;

      let relX = 0.5;
      let relY = 0.5;
      if (wrap && anchorEvt) {
        const wRect = wrap.getBoundingClientRect();
        const mx = anchorEvt.clientX - wRect.left;
        const my = anchorEvt.clientY - wRect.top;
        relX = (wrap.scrollLeft + mx) / Math.max(1, canvas.clientWidth);
        relY = (wrap.scrollTop + my) / Math.max(1, canvas.clientHeight);
      }

      state.w1Zoom = clampedZ;
      if (el.selectW1Zoom) {
        const opts = Array.from(el.selectW1Zoom.options).map((o) => parseFloat(o.value));
        const nearest = opts.reduce((a, b) => (Math.abs(b - clampedZ) < Math.abs(a - clampedZ) ? b : a));
        el.selectW1Zoom.value = String(nearest);
      }
      renderMultiLeadCanvas();

      if (wrap && anchorEvt) {
        const wRect = wrap.getBoundingClientRect();
        wrap.scrollLeft = Math.max(0, relX * canvas.clientWidth - (anchorEvt.clientX - wRect.left));
        wrap.scrollTop = Math.max(0, relY * canvas.clientHeight - (anchorEvt.clientY - wRect.top));
      }
    };

    if (el.selectW1Zoom) {
      el.selectW1Zoom.addEventListener("change", () => setW1Zoom(parseFloat(el.selectW1Zoom.value) || 1.0));
    }
    if (el.btnW1ZoomOut) {
      el.btnW1ZoomOut.addEventListener("click", () => setW1Zoom((state.w1Zoom || 1.0) - 0.5));
    }
    if (el.btnW1ZoomIn) {
      el.btnW1ZoomIn.addEventListener("click", () => setW1Zoom((state.w1Zoom || 1.0) + 0.5));
    }
    if (el.btnW1ZoomReset) {
      el.btnW1ZoomReset.addEventListener("click", () => {
        setW1Zoom(1.0);
        const wrap = el.multileadContainer || canvas.parentElement;
        if (wrap) {
          wrap.scrollLeft = 0;
          wrap.scrollTop = 0;
        }
      });
    }
    if (el.multileadContainer) {
      el.multileadContainer.addEventListener("wheel", (evt) => {
        if (evt.ctrlKey) {
          evt.preventDefault();
          setW1Zoom((state.w1Zoom || 1.0) + (evt.deltaY < 0 ? 0.5 : -0.5), evt);
        }
      }, { passive: false });
    }
  }

  // Interactive Mouse & Touch Events for Window 2 (#caliperCanvas)
  function bindCaliperCanvasEvents() {
    const canvas = el.caliperCanvas;

    const getCanvasPos = (evt) => {
      const rect = canvas.getBoundingClientRect();
      const clientX = evt.touches ? evt.touches[0].clientX : evt.clientX;
      const clientY = evt.touches ? evt.touches[0].clientY : evt.clientY;
      return {
        x: clientX - rect.left,
        y: clientY - rect.top,
      };
    };

    const xToMs = (x) => {
      const { padLeft, plotW, startMs, endMs, totalSigMs } = state.viewWindow;
      const rel = (x - padLeft) / Math.max(1, plotW);
      const ms = startMs + rel * (endMs - startMs);
      return Math.max(0, Math.min(totalSigMs || 5000, ms));
    };

    const yToMv = (y) => {
      const { centerY, gainMmMv, pxPerMm } = state.viewWindow;
      return (centerY - y) / Math.max(1e-3, gainMmMv * pxPerMm);
    };

    const findW2GlobalRBadge = (pos) => {
      if (!state.w2RPeakHitBoxes) return null;
      // Check top badge strip (y <= 22) or in r_edit mode anywhere along the vertical R line
      return state.w2RPeakHitBoxes.find((b) => {
        if (pos.y <= 20 && pos.x >= b.bx - 4 && pos.x <= b.bx + b.bw + 4) {
          return true;
        }
        if (state.caliperMode === "r_edit" && Math.abs(pos.x - b.x) <= 10) {
          return true;
        }
        return false;
      });
    };

    const findNearestHandle = (pos) => {
      const { padLeft, plotW, startMs, endMs, centerY, gainMmMv, pxPerMm } = state.viewWindow;
      const msToX = (ms) => padLeft + ((ms - startMs) / Math.max(1, endMs - startMs)) * plotW;
      const mvToY = (mv) => centerY - mv * gainMmMv * pxPerMm;

      // 1. Check artifact zone end-handles first
      const zones = (state.artifactsByLead && state.artifactsByLead[state.activeLead]) || [];
      for (let i = 0; i < zones.length; i++) {
        const ax1 = msToX(zones[i].startMs);
        const ax2 = msToX(zones[i].endMs);
        if (Math.abs(pos.x - ax1) <= 8 && Math.abs(pos.y - centerY) <= 28) {
          return `art_start_${i}`;
        }
        if (Math.abs(pos.x - ax2) <= 8 && Math.abs(pos.y - centerY) <= 28) {
          return `art_end_${i}`;
        }
      }

      // 2. Check top global R1..Rn badges
      const rBadge = findW2GlobalRBadge(pos);
      if (rBadge) {
        return `w2_r_${rBadge.beatIdx}`;
      }

      if (state.caliperMode === "fiducial" || state.caliperMode === "r_edit") {
        let bestKey = null;
        let bestDist = 14; // px hit tolerance
        FIDUCIAL_DEFS.forEach((fd) => {
          const hx = msToX(state.calipersMs[fd.key]);
          const dist = Math.abs(pos.x - hx);
          const weight = pos.y >= 16 && pos.y <= 46 ? 0.65 : 1.0;
          if (dist * weight < bestDist) {
            bestDist = dist * weight;
            bestKey = fd.key;
          }
        });
        return bestKey;
      } else if (state.caliperMode === "free" || state.caliperMode === "marching") {
        const x1 = msToX(state.freeCalipers.t1_ms);
        const x2 = msToX(state.freeCalipers.t2_ms);
        if (Math.abs(pos.x - x1) < 12) return "free_t1";
        if (Math.abs(pos.x - x2) < 12) return "free_t2";
        if (state.caliperMode === "free") {
          const y1 = mvToY(state.freeCalipers.v1_mv);
          const y2 = mvToY(state.freeCalipers.v2_mv);
          if (Math.abs(pos.y - y1) < 10) return "free_v1";
          if (Math.abs(pos.y - y2) < 10) return "free_v2";
        }
        return null;
      }
      return null;
    };

    // Right-click on any R badge in Window 2 deletes that R peak
    canvas.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      const pos = getCanvasPos(evt);
      const rBadge = findW2GlobalRBadge(pos);
      if (rBadge) {
        deleteRPeak(state.activeLead, rBadge.beatIdx);
      }
    });

    canvas.addEventListener("mousedown", (evt) => {
      if (evt.button === 2) return;
      const pos = getCanvasPos(evt);
      const clickMs = xToMs(pos.x);

      // Alt+Click on any R badge deletes it
      const rBadge = findW2GlobalRBadge(pos);
      if (rBadge && evt.altKey) {
        deleteRPeak(state.activeLead, rBadge.beatIdx);
        return;
      }

      // Shift+Click anywhere adds an R peak immediately
      if (evt.shiftKey) {
        addRPeak(state.activeLead, clickMs);
        return;
      }

      // Ctrl+Click or Artifact Mode: start drag or toggle smart blue artifact line
      if (evt.ctrlKey || state.caliperMode === "artifact") {
        const handle = findNearestHandle(pos);
        if (handle && handle.startsWith("art_")) {
          state.draggingHandle = handle;
          return;
        }
        state.artifactDragStartMs = clickMs;
        state.artifactDragCurrMs = clickMs;
        return;
      }

      const handle = findNearestHandle(pos);
      if (handle) {
        // If clicked on a top R# badge, switch activeBeatIdx to that beat and allow dragging it
        if (handle.startsWith("w2_r_")) {
          const bIdx = parseInt(handle.replace("w2_r_", ""), 10);
          if (!isNaN(bIdx) && bIdx !== state.activeBeatIdx) {
            state.activeBeatIdx = bIdx;
            el.selectBeat.value = String(bIdx);
            loadBeatCalipers(state.activeLead, bIdx);
          }
        }
        state.draggingHandle = handle;
        return;
      }

      // In r_edit mode, clicking empty signal area adds a new R peak
      if (state.caliperMode === "r_edit") {
        addRPeak(state.activeLead, clickMs);
      }
    });

    window.addEventListener("mousemove", (evt) => {
      if (!state.digitization) return;
      const pos = getCanvasPos(evt);

      // Handle live artifact drag selection
      if (state.artifactDragStartMs !== null) {
        state.artifactDragCurrMs = xToMs(pos.x);
        renderCaliperWorkbenchCanvas(computeLiveMetricsClient());
        return;
      }

      if (!state.draggingHandle) {
        const hov = findNearestHandle(pos);
        if (hov !== state.hoverHandle) {
          state.hoverHandle = hov;
          canvas.style.cursor =
            hov && hov.startsWith("free_v")
              ? "ns-resize"
              : hov
              ? "ew-resize"
              : state.caliperMode === "r_edit" || state.caliperMode === "artifact"
              ? "pointer"
              : "crosshair";
          renderCaliperWorkbenchCanvas(computeLiveMetricsClient());
        }
        return;
      }

      const h = state.draggingHandle;
      const currMs = Math.round(xToMs(pos.x));

      if (h.startsWith("art_start_") || h.startsWith("art_end_")) {
        const parts = h.split("_");
        const zIdx = parseInt(parts[2], 10);
        const zones = state.artifactsByLead[state.activeLead] || [];
        if (zones[zIdx]) {
          if (parts[1] === "start") {
            zones[zIdx].startMs = Math.min(currMs, zones[zIdx].endMs - 15);
          } else {
            zones[zIdx].endMs = Math.max(currMs, zones[zIdx].startMs + 15);
          }
          syncLeadRArrayFromBeats(state.activeLead);
          recalculateLiveMetricsAndRender();
          renderMultiLeadCanvas();
        }
        return;
      }

      if (h.startsWith("w2_r_")) {
        const bIdx = parseInt(h.replace("w2_r_", ""), 10);
        if (!isNaN(bIdx)) {
          const followIdx = moveRPeak(state.activeLead, bIdx, currMs);
          if (followIdx >= 0) state.draggingHandle = `w2_r_${followIdx}`;
          renderMultiLeadCanvas();
        }
        return;
      }

      if (h === "free_t1") {
        state.freeCalipers.t1_ms = xToMs(pos.x);
      } else if (h === "free_t2") {
        state.freeCalipers.t2_ms = xToMs(pos.x);
      } else if (h === "free_v1") {
        state.freeCalipers.v1_mv = yToMv(pos.y);
      } else if (h === "free_v2") {
        state.freeCalipers.v2_mv = yToMv(pos.y);
      } else if (h === "r_peak") {
        moveRPeak(state.activeLead, state.activeBeatIdx, currMs);
        renderMultiLeadCanvas();
        return;
      } else if (h === "next_r_peak") {
        const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[state.activeLead];
        if (leadAna && leadAna.beats && state.activeBeatIdx + 1 < leadAna.beats.length) {
          // Keep R_+1 strictly after the active R so the next beat cannot be dragged over the active one
          const activeR = state.calipersMs.r_peak || 0;
          moveRPeak(state.activeLead, state.activeBeatIdx + 1, Math.max(activeR + 200, currMs));
          renderMultiLeadCanvas();
          return;
        } else {
          state.calipersMs.next_r_peak = currMs;
          syncNumericalInputsFromCalipers();
        }
      } else if (state.calipersMs[h] !== undefined) {
        state.calipersMs[h] = currMs;
        syncNumericalInputsFromCalipers();
      }
      recalculateLiveMetricsAndRender();
    });

    window.addEventListener("mouseup", () => {
      if (state.artifactDragStartMs !== null) {
        const sMs = state.artifactDragStartMs;
        const eMs = state.artifactDragCurrMs !== null ? state.artifactDragCurrMs : sMs;
        state.artifactDragStartMs = null;
        state.artifactDragCurrMs = null;
        if (Math.abs(eMs - sMs) >= 25) {
          addOrToggleArtifactZone(state.activeLead, sMs, eMs, true);
          setStatus(`Помечен артефакт [${Math.min(sMs, eMs).toFixed(0)}–${Math.max(sMs, eMs).toFixed(0)} мс]`, "ready");
        } else {
          // Single click in artifact mode -> smart interval [R_i, R_{i+1}] or [R_last, End]
          toggleSmartArtifactAtClick(state.activeLead, sMs);
        }
      }
      state.draggingHandle = null;
    });
  }

  async function renderUploadedPdfPage(pageNum = 1) {
    if (!state.uploadedPdfDoc || !state.uploadedPdfRawFile) return;
    try {
      const pdfDoc = state.uploadedPdfDoc;
      const cleanPage = Math.max(1, Math.min(pdfDoc.numPages, parseInt(pageNum, 10) || 1));
      state.uploadedPdfPage = cleanPage;
      setStatus(`Рендеринг страницы ${cleanPage}/${pdfDoc.numPages} PDF ЭКГ...`, "busy");

      const page = await pdfDoc.getPage(cleanPage);
      const baseVp = page.getViewport({ scale: 1.0 });
      const targetScale = Math.max(2.0, Math.min(3.5, 1800 / Math.max(400, Math.max(baseVp.width, baseVp.height))));
      const viewport = page.getViewport({ scale: targetScale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      // Fill solid white background so transparent PDFs never render with dark/black background
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const baseName = state.uploadedPdfRawFile.name.replace(/\.pdf$/i, "");
      const pageFileName = `${baseName}_page_${cleanPage}.png`;
      state.uploadedFile = new File([blob], pageFileName, { type: "image/png" });
      state.sourceFile = state.uploadedFile;
      el.exampleDescription.textContent =
        `PDF: ${state.uploadedPdfRawFile.name} (стр. ${cleanPage}/${pdfDoc.numPages}, ${canvas.width}×${canvas.height} пикс)`;
      el.selectLayout.value = "auto";
      await runDigitization();
    } catch (err) {
      console.error("PDF page render error:", err);
      // Fallback: pass raw PDF file to backend PyMuPDF if available
      state.uploadedFile = state.uploadedPdfRawFile;
      state.sourceFile = state.uploadedFile;
      await runDigitization();
    }
  }

  async function handleUploadedImageOrPdf(file) {
    if (!file) return;
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      state.uploadedPdfDoc = null;
      state.uploadedPdfRawFile = null;
      state.uploadedPdfPage = 1;
      if (el.selectPdfPage) el.selectPdfPage.hidden = true;
      state.uploadedFile = file;
      state.sourceFile = file;
      el.exampleDescription.textContent = `Загружен файл: ${file.name} (${(file.size / 1024).toFixed(1)} КБ)`;
      el.selectLayout.value = "auto";
      await runDigitization();
      return;
    }

    state.uploadedPdfRawFile = file;
    state.uploadedPdfPage = 1;
    setStatus(`Чтение PDF файла ${file.name}...`, "busy");

    if (window.pdfjsLib) {
      try {
        if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        }
        const ab = await file.arrayBuffer();
        const pdfDoc = await window.pdfjsLib.getDocument({ data: new Uint8Array(ab) }).promise;
        state.uploadedPdfDoc = pdfDoc;

        if (el.selectPdfPage) {
          el.selectPdfPage.innerHTML = "";
          for (let p = 1; p <= pdfDoc.numPages; p++) {
            const opt = document.createElement("option");
            opt.value = String(p);
            opt.textContent = `Стр. ${p}/${pdfDoc.numPages}`;
            el.selectPdfPage.appendChild(opt);
          }
          el.selectPdfPage.value = "1";
          el.selectPdfPage.hidden = false;
        }
        await renderUploadedPdfPage(1);
        return;
      } catch (pdfErr) {
        console.warn("PDF.js fallback to server-side PyMuPDF:", pdfErr);
      }
    }

    // Fallback to direct backend PyMuPDF PDF decoding
    if (el.selectPdfPage) el.selectPdfPage.hidden = true;
    state.uploadedFile = file;
    state.sourceFile = file;
    el.exampleDescription.textContent = `Загружен PDF: ${file.name} (${(file.size / 1024).toFixed(1)} КБ)`;
    el.selectLayout.value = "auto";
    await runDigitization();
  }

  function bindUIEvents() {
    // Calibration pulse disagrees with the entered gain → re-digitize with the gain the pulse shows
    if (el.btnApplyPulseGain) {
      el.btnApplyPulseGain.addEventListener("click", () => {
        const cp = state.digitization && state.digitization.calibration_pulse;
        if (!cp || !cp.suggested_gain_mm_mv) return;
        const val = String(cp.suggested_gain_mm_mv);
        if (!Array.from(el.selectGain.options).some((o) => o.value === val)) {
          const opt = document.createElement("option");
          opt.value = val;
          opt.textContent = `${val} мм/мВ`;
          el.selectGain.appendChild(opt);
        }
        el.selectGain.value = val;
        runDigitization();
      });
    }

    // Patient sex only changes the Cornell LVH threshold: recompute indices without re-digitizing
    if (el.selectPatientSex) {
      el.selectPatientSex.addEventListener("change", () => {
        recomputeGlobalIndicesClient();
        renderHexaxialCompass();
      });
    }

    // Example selection
    el.selectExample.addEventListener("change", () => {
      state.uploadedFile = null;
      state.sourceFile = null;
      state.uploadedPdfDoc = null;
      state.uploadedPdfRawFile = null;
      if (el.selectPdfPage) el.selectPdfPage.hidden = true;
      const fname = el.selectExample.value;
      const ex = (state.config && state.config.examples || []).find((e) => e.filename === fname);
      if (ex) applyExamplePreset(ex);
      runDigitization();
    });

    if (el.selectPdfPage) {
      el.selectPdfPage.addEventListener("change", () => {
        const p = parseInt(el.selectPdfPage.value, 10) || 1;
        renderUploadedPdfPage(p);
      });
    }

    // Custom file upload (image or PDF)
    el.fileUploadInput.addEventListener("change", (evt) => {
      const f = evt.target.files && evt.target.files[0];
      if (f) {
        handleUploadedImageOrPdf(f);
      }
    });

    // Drag and drop image or PDF onto page
    window.addEventListener("dragover", (evt) => evt.preventDefault());
    window.addEventListener("drop", (evt) => {
      evt.preventDefault();
      const f = evt.dataTransfer && evt.dataTransfer.files && evt.dataTransfer.files[0];
      if (f && (f.type.startsWith("image/") || f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"))) {
        handleUploadedImageOrPdf(f);
      }
    });

    // Method description update
    el.selectMethod.addEventListener("change", () => {
      const m = (state.config && state.config.methods || []).find((x) => x.id === el.selectMethod.value);
      if (m) el.methodDescription.textContent = m.description;
    });

    el.btnDigitize.addEventListener("click", () => runDigitization());

    // Tabs switching
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        const tabId = `tab-${btn.getAttribute("data-tab")}`;
        const pane = document.getElementById(tabId);
        if (pane) pane.classList.add("active");
        if (btn.getAttribute("data-tab") === "multilead") {
          renderMultiLeadCanvas();
        } else if (btn.getAttribute("data-tab") === "overlay") {
          setTimeout(() => renderTraceOverlayCanvas(), 20);
        } else if (btn.getAttribute("data-tab") === "aligned") {
          setTimeout(() => renderPhotoCalibrationCanvas(), 20);
        } else if (btn.getAttribute("data-tab") === "gridnodes") {
          setTimeout(() => {
            if (!state.gridNodesResult) {
              detectGridIntersectionsAndDeformation();
            } else {
              renderGridNodesCanvas();
            }
          }, 25);
        }
      });
    });

    // Window 1 Tool Switcher buttons
    document.querySelectorAll(".w1-tool-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".w1-tool-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.w1Tool = btn.getAttribute("data-w1-tool") || "select_move";
        if (el.multileadCanvas) {
          el.multileadCanvas.style.cursor = state.w1Tool === "pan" ? "grab" : "pointer";
        }
      });
    });

    bindMultiLeadCanvasEvents();
    bindTraceOverlayEvents();
    bindPhotoCalibrationEvents();
    bindGridNodesEvents();

    el.chkShowFiducialsMulti.addEventListener("change", () => renderMultiLeadCanvas());

    // Caliper mode buttons
    document.querySelectorAll(".mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.caliperMode = btn.getAttribute("data-mode") || "fiducial";
        recalculateLiveMetricsAndRender();
      });
    });

    // Quick R & Artifact Action Bar Buttons
    if (el.btnQuickAddR) {
      el.btnQuickAddR.addEventListener("click", () => {
        document.querySelectorAll(".mode-btn").forEach((b) => {
          b.classList.toggle("active", b.getAttribute("data-mode") === "r_edit");
        });
        state.caliperMode = "r_edit";
        setStatus("Режим коррекции R: кликните по пику на сигнале для добавления метки R (ПКМ по метке — удалить)", "busy");
        recalculateLiveMetricsAndRender();
      });
    }

    if (el.btnDeleteActiveR) {
      el.btnDeleteActiveR.addEventListener("click", () => {
        deleteRPeak(state.activeLead, state.activeBeatIdx);
      });
    }

    if (el.btnArtifactRR) {
      el.btnArtifactRR.addEventListener("click", () => {
        const r1 = state.calipersMs.r_peak;
        const r2 = state.calipersMs.next_r_peak;
        if (r2 > r1 + 30) {
          addOrToggleArtifactZone(state.activeLead, r1, r2);
          setStatus(`Переключена метка артефакта между R и R+1 [${r1.toFixed(0)}–${r2.toFixed(0)} мс]`, "ready");
        }
      });
    }

    if (el.btnArtifactRToEnd) {
      el.btnArtifactRToEnd.addEventListener("click", () => {
        const totalMs = getLeadTotalMs(state.activeLead);
        const rStart = state.calipersMs.r_peak;
        if (totalMs > rStart + 20) {
          addOrToggleArtifactZone(state.activeLead, rStart, totalMs);
          setStatus(`Переключена метка артефакта от R до конца сигнала [${rStart.toFixed(0)}–${totalMs.toFixed(0)} мс]`, "ready");
        }
      });
    }

    if (el.btnArtifactStartToR) {
      el.btnArtifactStartToR.addEventListener("click", () => {
        const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[state.activeLead];
        const firstR =
          leadAna && leadAna.beats && leadAna.beats.length > 0
            ? leadAna.beats[0].times_ms.r_peak
            : state.calipersMs.r_peak;
        if (firstR > 20) {
          addOrToggleArtifactZone(state.activeLead, 0, firstR);
          setStatus(`Переключена метка артефакта от начала до R1 [0–${firstR.toFixed(0)} мс]`, "ready");
        }
      });
    }

    if (el.btnClearArtifacts) {
      el.btnClearArtifacts.addEventListener("click", () => {
        applyToTargetLeads(state.activeLead, (ln) => {
          state.artifactsByLead[ln] = [];
          syncLeadRArrayFromBeats(ln);
        });
        populateBeatDropdown(state.activeLead);
        recalculateLiveMetricsAndRender();
        renderMultiLeadCanvas();
        renderAllLeadsTable();
        setStatus("Все синие метки артефактов очищены", "ready");
      });
    }

    // Beat & Zoom selectors
    el.selectBeat.addEventListener("change", () => {
      state.activeBeatIdx = parseInt(el.selectBeat.value, 10) || 0;
      loadBeatCalipers(state.activeLead, state.activeBeatIdx);
    });

    el.selectZoomX.addEventListener("change", () => {
      state.zoomX = parseFloat(el.selectZoomX.value) || 1.0;
      recalculateLiveMetricsAndRender();
    });

    el.selectZoomY.addEventListener("change", () => {
      state.zoomY = parseFloat(el.selectZoomY.value) || 1.0;
      recalculateLiveMetricsAndRender();
    });

    el.btnAutoResetCalipers.addEventListener("click", () => {
      if (state.originalBeatsByLead && state.originalBeatsByLead[state.activeLead]) {
        state.analysis.leads[state.activeLead] = JSON.parse(
          JSON.stringify(state.originalBeatsByLead[state.activeLead])
        );
        state.artifactsByLead[state.activeLead] = [];
        populateBeatDropdown(state.activeLead);
      }
      loadBeatCalipers(state.activeLead, state.activeBeatIdx);
      renderMultiLeadCanvas();
      renderAllLeadsTable();
      setStatus("Восстановлена автоматическая расстановка меток R и калиперов", "ready");
    });

    // Direct numerical input boxes for fiducial calipers
    FIDUCIAL_DEFS.forEach((fd) => {
      const inp = document.getElementById(`num_${fd.key}`);
      if (!inp) return;
      if (fd.key === "r_peak" || fd.key === "next_r_peak") {
        // R / R_+1 are real beats: move them through moveRPeak so beats[], r_peaks[], RR and the
        // neighbour's next_r_peak stay consistent (applied on commit, not on every keystroke)
        inp.addEventListener("change", () => {
          const val = parseFloat(inp.value);
          if (isNaN(val)) return;
          const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[state.activeLead];
          const targetIdx = fd.key === "r_peak" ? state.activeBeatIdx : state.activeBeatIdx + 1;
          if (leadAna && leadAna.beats && leadAna.beats[targetIdx]) {
            moveRPeak(state.activeLead, targetIdx, val);
            renderMultiLeadCanvas();
          } else {
            state.calipersMs[fd.key] = val;
            recalculateLiveMetricsAndRender();
          }
        });
        return;
      }
      inp.addEventListener("input", () => {
        const val = parseFloat(inp.value);
        if (!isNaN(val)) {
          state.calipersMs[fd.key] = val;
          recalculateLiveMetricsAndRender();
        }
      });
    });

    bindCaliperCanvasEvents();

    // Vectorcardiogram (VCG) plane switcher & checkboxes
    document.querySelectorAll(".vcg-plane-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".vcg-plane-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.vcgPlane = btn.getAttribute("data-vcg-plane") || "all3";
        renderVectorcardiogram();
      });
    });

    if (el.chkVcgVectors) {
      el.chkVcgVectors.addEventListener("change", () => renderVectorcardiogram());
    }
    if (el.chkVcgArrows) {
      el.chkVcgArrows.addEventListener("change", () => renderVectorcardiogram());
    }

    // Exports
    el.btnExportCsv.addEventListener("click", exportCsv);
    el.btnExportJson.addEventListener("click", exportJson);
    el.btnPrintReport.addEventListener("click", () => window.print());

    window.addEventListener("resize", () => {
      renderMultiLeadCanvas();
      renderTraceOverlayCanvas();
      renderPhotoCalibrationCanvas();
      renderGridNodesCanvas();
      renderCaliperWorkbenchCanvas(computeLiveMetricsClient());
      renderVectorcardiogram();
    });
  }

  function exportCsv() {
    if (!state.digitization || !state.digitization.leads_mv) return;
    const leadsMap = state.digitization.leads_mv;
    const leadNames = Object.keys(leadsMap);
    if (leadNames.length === 0) return;

    const fs = state.digitization.sampling_rate_hz || 500;
    const maxLen = Math.max(...leadNames.map((k) => leadsMap[k].length));
    const headerCols = ["sample_idx", "time_sec", "time_ms"];
    leadNames.forEach((ln) => {
      headerCols.push(`${ln}_mV`);
      headerCols.push(`${ln}_uV`);
    });

    const lines = [headerCols.join(",")];
    for (let i = 0; i < maxLen; i++) {
      const tSec = (i / fs).toFixed(4);
      const tMs = ((i * 1000.0) / fs).toFixed(1);
      const row = [i, tSec, tMs];
      leadNames.forEach((ln) => {
        const vMv = leadsMap[ln][i];
        if (vMv !== undefined && vMv !== null) {
          row.push(vMv.toFixed(4));
          row.push((vMv * 1000.0).toFixed(1));
        } else {
          row.push("");
          row.push("");
        }
      });
      lines.push(row.join(","));
    }

    // UTF-8 BOM so Excel shows Cyrillic headers ("II (ритм)_mV") correctly
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(state.currentSource || "ecg").replace(/\.[^.]+$/, "")}_digitized_${fs}Hz.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportJson() {
    if (!state.digitization || !state.analysis) return;
    const payload = {
      source_name: state.currentSource,
      exported_at: new Date().toISOString(),
      active_lead: state.activeLead,
      active_calipers_ms: state.calipersMs,
      active_live_metrics: computeLiveMetricsClient(),
      digitization: {
        ...state.digitization,
        visualizations: undefined, // keep JSON compact
      },
      analysis: state.analysis,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(state.currentSource || "ecg").replace(/\.[^.]+$/, "")}_report.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
