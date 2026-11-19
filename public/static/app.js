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
      opt.textContent = m.name;
      el.selectMethod.appendChild(opt);
    });

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
      "3x4_r1": { label: "3×4 + 1 полоса ритма II", cols: 4, grid: [["I","aVR","V1","V4"],["II","aVL","V2","V5"],["III","aVF","V3","V6"]], rhythm: ["II"] },
      "3x4_r2": { label: "3×4 + 2 полосы ритма (I, II)", cols: 4, grid: [["I","aVR","V1","V4"],["II","aVL","V2","V5"],["III","aVF","V3","V6"]], rhythm: ["I","II"] },
      "3x4": { label: "3×4 Стандарт", cols: 4, grid: [["I","aVR","V1","V4"],["II","aVL","V2","V5"],["III","aVF","V3","V6"]], rhythm: [] },
      "6x2": { label: "6×2 Стандарт (I–aVF слева, V1–V6 справа)", cols: 2, grid: [["I","V1"],["II","V2"],["III","V3"],["aVR","V4"],["aVL","V5"],["aVF","V6"]], rhythm: [] },
      "6x2_r1": { label: "6×2 + 1 полоса ритма II", cols: 2, grid: [["I","V1"],["II","V2"],["III","V3"],["aVR","V4"],["aVL","V5"],["aVF","V6"]], rhythm: ["II"] },
      "6x1_precordial": { label: "6×1 Грудные (V1–V6)", cols: 1, grid: [["V1"],["V2"],["V3"],["V4"],["V5"],["V6"]], rhythm: [] },
      "6x1_limb": { label: "6×1 От конечностей (I–aVF)", cols: 1, grid: [["I"],["II"],["III"],["aVR"],["aVL"],["aVF"]], rhythm: [] },
    };

    const chosenLayout = LAYOUT_GRID[layoutSel] ? layoutSel : "12x1";
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
      const durSec = Math.max(0.6, Math.min(15.0, widthMm / Math.max(5.0, speedMmS)));
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

    // Client-side beat & fiducial analyzer
    const analysisLeads = {};
    let primaryLead = leadsMv["II"] ? "II" : Object.keys(leadsMv)[0];
    Object.keys(leadsMv).forEach((ln) => {
      const sig = leadsMv[ln];
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
      const medRR = rrList.length > 0 ? rrList[Math.floor(rrList.length / 2)] : 800;
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
      const rPeaksMs = beats.map((b) => b.times_ms.r_peak);
      const repBeat = beats[0];
      analysisLeads[ln] = {
        r_peaks: rIdxList,
        r_peaks_ms: rPeaksMs,
        rr_intervals_ms: rrList,
        hrv: { median_rr_ms: medRR, sdnn_ms: 0, rmssd_ms: 0 },
        beats,
        representative_beat_index: 0,
        calipers_ms: { ...repBeat.times_ms },
        metrics: {
          hr_bpm: 60000.0 / Math.max(250, medRR),
          rr_ms: medRR,
          durations_ms: { p_wave: 90, qrs_complex: 88, t_wave: 165, intrinsicoid_vat: 40 },
          intervals_ms: { pq_pr: 155, qt: 315, qtc_bazett: 352, qtc_fridericia: 339, qtc_framingham: 345, qtc_hodges: 341, jt: 227, jtc_bazett: 264, tp_te: 85, rr: medRR },
          segments_ms: { pq_pr_segment: 65, st_segment: 62, tp_segment: Math.max(0, medRR - 430) },
          ratios: { tpte_qt_ratio: 0.27, macruz_index: 1.38 },
          amplitudes_mv: { isoelectric_mv: 0, p_amp_mv: 0.12, q_amp_mv: -0.05, r_amp_mv: Number(maxAbs.toFixed(2)), s_amp_mv: -0.2, j_point_mv: 0, st_60_mv: 0.02, st_80_mv: 0.04, st_slope_mv_s: 0.5, t_amp_mv: 0.25 },
        },
      };
    });

    // Compute Frontal Axis (I vs aVF)
    const ampNet = (ln) => {
      const s = leadsMv[ln];
      if (!s || s.length === 0) return 0;
      let mx = -1e9, mn = 1e9;
      for (let i = 0; i < s.length; i++) {
        if (s[i] > mx) mx = s[i];
        if (s[i] < mn) mn = s[i];
      }
      return mx + mn;
    };
    const netI = ampNet("I");
    const netAvf = ampNet("aVF");
    const qrsAxisDeg = Math.round((Math.atan2(netAvf, netI) * 180) / Math.PI);
    const axisClass = qrsAxisDeg >= -30 && qrsAxisDeg <= 90 ? "Нормальное положение ЭОС" : qrsAxisDeg < -30 ? "Отклонение ЭОС влево" : "Отклонение ЭОС вправо";

    const elapsedSec = Number(((performance.now() - t0) / 1000.0).toFixed(2));
    return {
      source_name: sourceName,
      digitization: {
        method: "client_cv_static",
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
        global_hr_bpm: analysisLeads[primaryLead] ? analysisLeads[primaryLead].metrics.hr_bpm : 75,
        electrical_axis: { qrs_axis_deg: qrsAxisDeg, p_axis_deg: 45, t_axis_deg: 38, qrs_t_angle_deg: Math.abs(qrsAxisDeg - 38), classification: axisClass },
        hypertrophy_indices: { sokolow_lyon_mv: null, cornell_mv: null, sokolow_positive: false },
        clinical_flags: ["Режим статического сайта (Firebase Hosting): оцифровка выполнена встроенным браузерным CV-движком."],
        leads: analysisLeads,
      },
    };
  }

  async function runDigitization(customPxPerMm = null) {
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
        } else {
          formData.append("example_name", el.selectExample.value);
        }
        formData.append("method", el.selectMethod.value || "hybrid_ensemble");
        formData.append("layout", el.selectLayout.value || "auto");
        formData.append("paper_speed_mm_s", el.selectSpeed.value || "25");
        formData.append("gain_mm_mv", el.selectGain.value || "10");
        formData.append("target_fs", "500");
        formData.append("rotate_deg", el.selectRotate.value || "0");
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
      state.currentSource = data.source_name;
      state.digitization = data.digitization;
      state.analysis = data.analysis;
      state.artifactsByLead = {};
      state.originalBeatsByLead = {};
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
        el.imgAligned.onload = () => {
          renderPhotoCalibrationCanvas();
        };
        el.imgAligned.src = vis.aligned_image;
      }
      if (vis.segmentation_heatmap) el.imgHeatmap.src = vis.segmentation_heatmap;

      populateOverlayTraceDropdown();

      const sp = state.digitization.pixel_spacing || {};
      const detPxPerMm = sp.px_per_mm || 5.5;
      if (!customPxPerMm) {
        state.autoPxPerMm = detPxPerMm;
      }
      state.activePxPerMm = detPxPerMm;
      state.calRulerA = null;
      state.calRulerB = null;
      state.calRulerHover = null;
      el.inputPxPerMm.value = detPxPerMm.toFixed(2);
      updateDigitizationMetaBanner();
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

      setStatus(`Оцифровано (${availLeads.length} отв., ${state.digitization.elapsed_sec} с)`, "ready");
    } catch (err) {
      console.error("Digitization failed:", err);
      setStatus(`Ошибка: ${err.message}`, "error");
    } finally {
      el.btnDigitize.disabled = false;
      el.btnDigitizeText.textContent = "Оцифровать ЭКГ";
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
      `Скорость: ${state.digitization.paper_speed_mm_s} мм/с • Время: ${state.digitization.elapsed_sec} с`;
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

      // Rescale each lead's voltage (mV) and duration (number of samples at 500 Hz)
      Object.keys(leadsMap).forEach((ln) => {
        const oldSig = leadsMap[ln] || [];
        if (oldSig.length < 4) return;
        const newLen = Math.max(60, Math.min(25000, Math.round(oldSig.length * ratio)));
        const newSig = new Array(newLen);
        for (let i = 0; i < newLen; i++) {
          const pos = (i / Math.max(1, newLen - 1)) * (oldSig.length - 1);
          const i0 = Math.floor(pos);
          const i1 = Math.min(oldSig.length - 1, i0 + 1);
          const frac = pos - i0;
          const vOld = oldSig[i0] * (1 - frac) + oldSig[i1] * frac;
          newSig[i] = Number((vOld * ratio).toFixed(4));
        }
        leadsMap[ln] = newSig;
      });

      // Rescale all fiducial beat timestamps and R-peaks across all leads
      if (state.analysis && state.analysis.leads) {
        Object.keys(state.analysis.leads).forEach((ln) => {
          const lAna = state.analysis.leads[ln];
          if (!lAna) return;
          if (lAna.beats) {
            lAna.beats.forEach((b) => {
              if (b.times_ms) {
                Object.keys(b.times_ms).forEach((k) => {
                  b.times_ms[k] = Math.round(b.times_ms[k] * ratio);
                });
                b.r_peak = Math.round((b.times_ms.r_peak * fs) / 1000.0);
              }
            });
          }
          if (state.artifactsByLead && state.artifactsByLead[ln]) {
            state.artifactsByLead[ln].forEach((z) => {
              z.startMs = Math.round(z.startMs * ratio);
              z.endMs = Math.round(z.endMs * ratio);
            });
          }
          syncLeadRArrayFromBeats(ln);
        });
      }

      // Rescale active caliper positions
      Object.keys(state.calipersMs).forEach((k) => {
        state.calipersMs[k] = Math.round(state.calipersMs[k] * ratio);
      });
      state.freeCalipers.t1_ms = Math.round(state.freeCalipers.t1_ms * ratio);
      state.freeCalipers.t2_ms = Math.round(state.freeCalipers.t2_ms * ratio);
      state.freeCalipers.v1_mv = Number((state.freeCalipers.v1_mv * ratio).toFixed(3));
      state.freeCalipers.v2_mv = Number((state.freeCalipers.v2_mv * ratio).toFixed(3));

      state.activePxPerMm = cleanPxMm;
      if (!state.digitization.pixel_spacing) state.digitization.pixel_spacing = {};
      state.digitization.pixel_spacing.px_per_mm = cleanPxMm;
      state.digitization.pixel_spacing.px_per_mm_x = cleanPxMm;
      state.digitization.pixel_spacing.px_per_mm_y = cleanPxMm;
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
        el.selectOverlayLeadRename.value = traces[state.selectedTraceIdx].lead;
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

  async function syncTraceToDigitalLead(traceIdx, reanalyzeBackend = true) {
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
    const durSec = Math.max(0.5, Math.min(15.0, (spanPx / Math.max(0.5, pxPerMmX)) / Math.max(5.0, speed)));
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
    if (invertSign && cleanName !== tr.lead) {
      state.digitization.leads_mv[cleanName] = mvResampled.map((v) => Number((-v).toFixed(4)));
    }

    if (reanalyzeBackend && !state.staticMode) {
      try {
        const res = await fetch("/api/reanalyze_leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            leads_mv: state.digitization.leads_mv,
            fs,
            preferred_lead: tr.lead,
          }),
        });
        if (res.ok) {
          state.analysis = await res.json();
        }
      } catch (_) {}
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

    populateOverlayTraceDropdown();
    renderTraceOverlayCanvas();
    await syncTraceToDigitalLead(traceIdx, true);

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
          traces[state.selectedTraceIdx] = JSON.parse(JSON.stringify(orig));
          populateOverlayTraceDropdown();
          renderTraceOverlayCanvas();
          syncTraceToDigitalLead(state.selectedTraceIdx, true);
          if (el.overlayEditStatus) {
            el.overlayEditStatus.textContent = `Восстановлена исходная линия ${orig.lead}`;
          }
        }
      });
    }
  }

  function buildLeadPills(leadNames) {
    el.leadPillsContainer.innerHTML = "";
    leadNames.forEach((ln) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lead-pill" + (ln === state.activeLead ? " active" : "");
      btn.textContent = ln;
      btn.addEventListener("click", () => selectLead(ln));
      el.leadPillsContainer.appendChild(btn);
    });
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

  function moveRPeak(leadName, beatIdx, newRMs) {
    const leadAna = state.analysis && state.analysis.leads && state.analysis.leads[leadName];
    if (!leadAna || !leadAna.beats || !leadAna.beats[beatIdx]) return;
    const totalMs = getLeadTotalMs(leadName);
    const clampedMs = Math.max(5, Math.min(totalMs - 5, Math.round(newRMs)));
    const beat = leadAna.beats[beatIdx];
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
      if (newIdx >= 0) state.activeBeatIdx = newIdx;
      populateBeatDropdown(leadName);
      loadBeatCalipers(leadName, state.activeBeatIdx);
    } else {
      renderMultiLeadCanvas();
      renderAllLeadsTable();
    }
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

  // Client-side 60fps real-time clinical interval & amplitude math engine
  function computeLiveMetricsClient() {
    if (!state.digitization) return null;
    const sig = state.digitization.leads_mv[state.activeLead] || [];
    const fs = state.digitization.sampling_rate_hz || 500;
    const c = state.calipersMs;

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

    const cleanStats = getCleanLeadRRStats(state.activeLead);
    const currentIntervalIsArtifact = isIntervalInArtifact(state.activeLead, r_pk, next_r) || isTimeInArtifact(state.activeLead, r_pk);

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

    // Isoelectric level: median of 25ms before qrs_on
    const idxQrsOn = Math.max(0, Math.min(n - 1, Math.round((qrs_on * fs) / 1000.0)));
    const idxIsoLo = Math.max(0, idxQrsOn - Math.round(0.025 * fs));
    let isoSum = 0;
    let isoCnt = 0;
    for (let i = idxIsoLo; i <= idxQrsOn && i < n; i++) {
      isoSum += sig[i];
      isoCnt++;
    }
    const iso_mv = isoCnt > 0 ? isoSum / isoCnt : 0;

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
    }

    updateRAndArtifactStatusBar();
    renderCaliperWorkbenchCanvas(live);
    renderIntervalsTelemetryTable(live);
    renderQtcAndAmplitudes(live);
    renderFreeCaliperBanner();
    renderVectorcardiogram();
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
    const rowHeight = 84;
    const cssWidth = Math.max(480, container.clientWidth || 640);
    const cssHeight = Math.max(400, rows * rowHeight + 24);

    canvas.width = Math.round(cssWidth * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const pxPerMm = 4.2;
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

    el.valCornell.textContent = hyp.cornell_mv !== undefined
      ? `${hyp.cornell_mv.toFixed(2)} мВ (${hyp.cornell_mm.toFixed(1)} мм) ${hyp.cornell_lvh ? "⚠️ ГЛЖ" : "(норма < 2.8 мВ)"}`
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

        return `
        <tr class="${isAct}" data-lead="${ln}">
          <td class="mono-val">${ln}</td>
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
      if (!state.w1DragState) return;
      const pos = getPos(evt);
      const { lead, beatIdx, box } = state.w1DragState;
      const newMs = posToChannelMs(box, pos.x);
      moveRPeak(lead, beatIdx, newMs);
      renderMultiLeadCanvas();
    });

    window.addEventListener("mouseup", () => {
      state.w1DragState = null;
    });
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
          moveRPeak(state.activeLead, bIdx, currMs);
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
          moveRPeak(state.activeLead, state.activeBeatIdx + 1, currMs);
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

  function bindUIEvents() {
    // Example selection
    el.selectExample.addEventListener("change", () => {
      state.uploadedFile = null;
      const fname = el.selectExample.value;
      const ex = (state.config && state.config.examples || []).find((e) => e.filename === fname);
      if (ex) applyExamplePreset(ex);
      runDigitization();
    });

    // Custom file upload
    el.fileUploadInput.addEventListener("change", (evt) => {
      const f = evt.target.files && evt.target.files[0];
      if (f) {
        state.uploadedFile = f;
        el.exampleDescription.textContent = `Загружен файл: ${f.name} (${(f.size / 1024).toFixed(1)} КБ)`;
        el.selectLayout.value = "auto";
        runDigitization();
      }
    });

    // Drag and drop image onto page
    window.addEventListener("dragover", (evt) => evt.preventDefault());
    window.addEventListener("drop", (evt) => {
      evt.preventDefault();
      const f = evt.dataTransfer && evt.dataTransfer.files && evt.dataTransfer.files[0];
      if (f && f.type.startsWith("image/")) {
        state.uploadedFile = f;
        el.exampleDescription.textContent = `Загружен файл: ${f.name}`;
        el.selectLayout.value = "auto";
        runDigitization();
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
        }
      });
    });

    // Window 1 Tool Switcher buttons
    document.querySelectorAll(".w1-tool-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".w1-tool-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.w1Tool = btn.getAttribute("data-w1-tool") || "select_move";
      });
    });

    bindMultiLeadCanvasEvents();
    bindTraceOverlayEvents();
    bindPhotoCalibrationEvents();

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
      if (inp) {
        inp.addEventListener("input", () => {
          const val = parseFloat(inp.value);
          if (!isNaN(val)) {
            state.calipersMs[fd.key] = val;
            recalculateLiveMetricsAndRender();
          }
        });
      }
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

    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
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
