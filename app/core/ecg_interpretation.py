"""
Rule-based ECG interpretation (Russian-language report) on top of `ecg_autoanalysis.analyze_ecg`.

Every statement is a *finding* with an explicit criterion, so the physician can see why it was made, untick it and
edit the generated text. Criteria / thresholds:
- Rhythm: P presence on each beat + P axis (sinus), RR regularity (CV, max-min RR), premature beats.
- Axis: Russian (+30..+69 normal, 0..+29 horizontal, +70..+90 vertical) or AHA (-30..+90 normal) convention.
- Conduction: PR > 200 ms (AV block I), PR < 120 ms (+ QRS >= 110 ms: pre-excitation), QRS >= 120 ms with V1/V6
  morphology (complete RBBB / LBBB, otherwise non-specific IVCD), 110-119 ms with rSR' (incomplete RBBB),
  LAFB / LPFB (axis + limb-lead qR / rS patterns, QRS < 120 ms).
- Hypertrophy: Sokolow-Lyon >= 3.5 mV, Cornell >= 2.8 / 2.0 mV (men / women), Cornell product >= 2440 mm*ms,
  Peguero-Lo Presti >= 2.3 / 2.8 mV, R aVL >= 1.1 mV; RVH >= 2 of (R V1 >= 0.7 mV, R/S V1 >= 1, R V1 + S V5/V6
  >= 1.05 mV, axis >= +110); P II >= 0.25 mV (right atrium); P >= 120 ms or P terminal force V1 <= -0.04 mm*s (left).
- Ischaemia / infarction (4th Universal Definition of MI): new ST elevation at J in >= 2 contiguous leads,
  >= 0.1 mV, in V2-V3 >= 0.2 mV (men >= 40 y), >= 0.25 mV (men < 40 y), >= 0.15 mV (women); ST depression
  >= 0.05 mV; T inversion >= 0.1 mV with a prominent R; pathological Q >= 30 ms and >= 0.1 mV deep (any Q >= 20 ms
  or QS in V2-V3); ST criteria are not applied with LBBB.
- QTc (Fridericia): > 450 ms (men) / > 460 ms (women), >= 500 ms critical; < 340 ms short.
- Low voltage: all limb leads < 0.5 mV, all precordial < 1.0 mV peak-to-peak.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Sequence, Tuple

SECTIONS = ("rhythm", "axis", "intervals", "conduction", "hypertrophy", "ischemia", "repolarization", "other", "quality")
SEVERITY_ORDER = {"critical": 0, "abnormal": 1, "borderline": 2, "normal": 3, "info": 4}
CONTIGUOUS_PAIRS: Tuple[Tuple[str, str], ...] = (
    ("II", "III"), ("II", "aVF"), ("III", "aVF"), ("I", "aVL"), ("I", "V6"), ("V5", "V6"), ("V4", "V5"),
    ("V3", "V4"), ("V2", "V3"), ("V1", "V2"),
)
TERRITORY = {
    "II": "нижней стенки", "III": "нижней стенки", "aVF": "нижней стенки",
    "I": "боковой стенки", "aVL": "боковой стенки", "V5": "боковой стенки", "V6": "боковой стенки",
    "V1": "перегородочной области", "V2": "перегородочной области",
    "V3": "передней стенки", "V4": "передней стенки",
}
LIMB = ("I", "II", "III", "aVR", "aVL", "aVF")
PRECORDIAL = ("V1", "V2", "V3", "V4", "V5", "V6")


def _finding(code: str, section: str, severity: str, text: str, evidence: str = "", leads: Sequence[str] = (), default: bool = True) -> Dict[str, Any]:
    return {"code": code, "section": section, "severity": severity, "text": text.rstrip(".") + ".", "evidence": evidence,
            "leads": list(leads), "default": default}


def _mm(mv: float) -> str:
    return f"{abs(mv) * 10:.1f}".replace(".0", "") + " мм"


def _fmt_leads(leads: Sequence[str]) -> str:
    order = list(LIMB) + list(PRECORDIAL)
    return ", ".join(sorted(set(leads), key=lambda ln: order.index(ln) if ln in order else 99))


def _territories(leads: Sequence[str]) -> str:
    terr = []
    for ln in sorted(set(leads), key=lambda x: (list(LIMB) + list(PRECORDIAL)).index(x) if x in LIMB + PRECORDIAL else 99):
        t = TERRITORY.get(ln)
        if t and t not in terr:
            terr.append(t)
    return ", ".join(terr)


def _contiguous(leads: Sequence[str]) -> List[str]:
    s = set(leads)
    hit = set()
    for a, b in CONTIGUOUS_PAIRS:
        if a in s and b in s:
            hit.update((a, b))
    return sorted(hit)


def _axis_text(axis: float, convention: str) -> Tuple[str, str]:
    a = f"{axis:+.0f}°"
    if convention == "aha":
        if -30 <= axis <= 90:
            return f"Нормальное положение ЭОС (α = {a})", "normal"
        if -90 <= axis < -30:
            return f"Отклонение ЭОС влево (α = {a})", "abnormal"
        if 90 < axis <= 180:
            return f"Отклонение ЭОС вправо (α = {a})", "abnormal"
        return f"Резкое отклонение ЭОС (северо-западная ось, α = {a})", "abnormal"
    if 30 <= axis < 70:
        return f"Нормальное положение ЭОС (α = {a})", "normal"
    if 70 <= axis <= 90:
        return f"Вертикальное положение ЭОС (α = {a})", "normal"
    if 0 <= axis < 30:
        return f"Горизонтальное положение ЭОС (α = {a})", "normal"
    if -30 <= axis < 0:
        return f"Отклонение ЭОС влево (α = {a})", "borderline"
    if -90 <= axis < -30:
        return f"Резкое отклонение ЭОС влево (α = {a})", "abnormal"
    if 90 < axis <= 180:
        return f"Отклонение ЭОС вправо (α = {a})", "abnormal"
    return f"ЭОС в «ничейной» зоне — северо-западная ось (α = {a})", "abnormal"


def interpret(
    analysis: Dict[str, Any],
    patient: Optional[Dict[str, Any]] = None,
    options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    patient = patient or {}
    options = options or {}
    sex = patient.get("sex") if patient.get("sex") in ("male", "female") else None
    try:
        age = int(patient["age"]) if patient.get("age") not in (None, "") else None
    except (TypeError, ValueError):
        age = None
    convention = "aha" if options.get("axis_convention") == "aha" else "ru"

    iv = analysis.get("intervals", {})
    rh = analysis.get("rhythm", {})
    ax = analysis.get("axes", {})
    all_feats: Dict[str, Dict[str, Any]] = analysis.get("features", {})
    feats = {ln: f for ln, f in all_feats.items() if f.get("quality") != "bad"}
    excluded = sorted(ln for ln, f in all_feats.items() if f.get("quality") == "bad")

    def F(ln: str, key: str, default: float = 0.0) -> float:
        """Feature of a usable lead (0.0 when the lead is absent/excluded — every rule checks presence first)."""
        return float(feats[ln].get(key, default)) if ln in feats else 0.0

    findings: List[Dict[str, Any]] = []

    hr_known = rh.get("hr_bpm") is not None
    hr = float(rh.get("hr_bpm") or 0.0)
    qrs = iv.get("qrs_ms")
    pr = iv.get("pr_ms")
    p_ms = iv.get("p_ms")
    qrs_axis = ax.get("qrs_axis_deg")

    # ------------------------------------------------------------------ rhythm & rate
    n_beats = int(rh.get("n_beats") or 0)
    pfrac = float(rh.get("p_present_fraction") or 0.0)
    p_axis = ax.get("p_axis_deg")
    rr_cv = float(rh.get("rr_cv") or 0.0)
    irregular = rr_cv > 0.12
    rate_word = "брадикардия" if hr < 60 else ("тахикардия" if hr > 100 else "")
    if n_beats < 2 or not hr_known:
        findings.append(_finding("rhythm_unknown", "rhythm", "borderline",
                                 "Ритм и ЧСС автоматически не оценены (в записи менее двух комплексов, например усреднённые комплексы)"))
    elif pfrac >= 0.5 and pr is not None and (p_axis is None or -15 <= p_axis <= 90):
        kind = "Синусовый ритм" if not rate_word else f"Синусовая {rate_word}"
        reg = "неправильный" if irregular else "правильный"
        sev = "normal" if not rate_word else "borderline"
        if hr < 40 or hr > 150:
            sev = "critical"
        findings.append(_finding("sinus", "rhythm", sev, f"{kind}, ритм {reg}, ЧСС {hr:.0f} уд/мин",
                                 f"P перед {pfrac * 100:.0f}% комплексов, ось P {p_axis:+.0f}°" if p_axis is not None else f"P перед {pfrac * 100:.0f}% комплексов"))
    elif pfrac >= 0.5 and p_axis is not None and not (-15 <= p_axis <= 90):
        findings.append(_finding("ectopic_atrial", "rhythm", "abnormal",
                                 f"Эктопический предсердный ритм (ось P {p_axis:+.0f}°), ЧСС {hr:.0f} уд/мин",
                                 "P присутствуют, но их ось вне синусового диапазона (−15…+90°)"))
    elif irregular:
        form = "тахисистолическая" if hr > 100 else ("брадисистолическая" if hr < 60 else "нормосистолическая")
        findings.append(_finding("af", "rhythm", "critical" if hr > 130 else "abnormal",
                                 f"Фибрилляция предсердий, {form} форма (средняя ЧСЖ {hr:.0f} уд/мин)",
                                 f"нерегулярные RR (коэффициент вариации {rr_cv:.2f}), зубцы P не определяются"))
    elif 35 <= hr <= 60 and (qrs or 0) < 120:
        findings.append(_finding("junctional", "rhythm", "abnormal",
                                 f"Возможен ритм из АВ-соединения, ЧСС {hr:.0f} уд/мин",
                                 "ритм правильный, узкие QRS, зубцы P автоматически не определяются"))
    else:
        findings.append(_finding("rhythm_regular_no_p", "rhythm", "borderline",
                                 f"Ритм правильный, ЧСС {hr:.0f} уд/мин; зубцы P автоматически не идентифицированы — оцените ритм вручную",
                                 "P найдены менее чем перед половиной комплексов"))
    if n_beats >= 3 and not irregular and pfrac >= 0.5:
        rr = [float(v) for v in analysis.get("leads", {}).get(rh.get("p_lead", ""), {}).get("rr_intervals_ms", [])]
        if len(rr) >= 3 and max(rr) - min(rr) > 120:
            findings.append(_finding("sinus_arrhythmia", "rhythm", "borderline", "Синусовая аритмия",
                                     f"разница RR {max(rr) - min(rr):.0f} мс > 120 мс"))
    prem = rh.get("premature_beats") or []
    for kind, label in (("supraventricular", "наджелудочковая"), ("ventricular", "желудочковая")):
        cnt = sum(1 for p in prem if p.get("type") == kind)
        if cnt:
            what = "Одиночная" if cnt == 1 else "Частая" if cnt >= 3 else "Редкая"
            findings.append(_finding(f"pvc_{kind}", "rhythm", "abnormal" if kind == "ventricular" else "borderline",
                                     f"{what} {label} экстрасистолия ({cnt} за {rh.get('duration_s', 0):.0f} с)",
                                     "преждевременные комплексы (RR < 80 % медианы с последующей паузой); форма QRS " + ("отличается от основной" if kind == "ventricular" else "как у основных")))

    # ------------------------------------------------------------------ axis
    if qrs_axis is not None:
        text, sev = _axis_text(float(qrs_axis), convention)
        findings.append(_finding("axis", "axis", sev, text, "по амплитудам QRS в I и aVF"))
    else:
        findings.append(_finding("axis_unknown", "axis", "info", "ЭОС не определена (нет отведений от конечностей)"))

    # ------------------------------------------------------------------ intervals line
    qt = iv.get("qt_ms")
    qtcf = iv.get("qtc_fridericia_ms")
    qtcb = iv.get("qtc_bazett_ms")
    parts = []
    if pr is not None:
        parts.append(f"PQ {pr:.0f} мс")
    if qrs is not None:
        parts.append(f"QRS {qrs:.0f} мс")
    if qt is not None and qtcf is not None and qtcb is not None:
        parts.append(f"QT {qt:.0f} мс, QTc {qtcf:.0f} мс (Фридеричиа; по Базетту {qtcb:.0f} мс)")
    elif qt is not None:
        parts.append(f"QT {qt:.0f} мс (QTc не рассчитан — неизвестен интервал RR)")
    if p_ms is not None:
        parts.insert(0, f"P {p_ms:.0f} мс")
    if parts:
        findings.append(_finding("intervals", "intervals", "info", "Интервалы: " + ", ".join(parts)))

    # ------------------------------------------------------------------ conduction
    def morph(ln: str) -> str:
        return str(feats.get(ln, {}).get("qrs_morphology", ""))

    if pr is not None:
        if pr > 200:
            findings.append(_finding("av1", "conduction", "abnormal", f"АВ-блокада I степени (PQ {pr:.0f} мс)", "PQ > 200 мс"))
        elif pr < 120:
            if qrs is not None and qrs >= 110:
                findings.append(_finding("preexcitation", "conduction", "abnormal",
                                         f"Признаки предвозбуждения желудочков (PQ {pr:.0f} мс, QRS {qrs:.0f} мс) — исключите синдром WPW",
                                         "PQ < 120 мс + QRS ≥ 110 мс; проверьте дельта-волну"))
            else:
                findings.append(_finding("short_pr", "conduction", "borderline", f"Укорочение интервала PQ ({pr:.0f} мс)", "PQ < 120 мс"))

    rbbb_pattern = any("R'" in morph(ln) for ln in ("V1", "V2")) or (
        "V1" in feats and F("V1", "r_amp_mv") > abs(F("V1", "s_amp_mv")) and F("V1", "r_amp_mv") > 0.3)
    wide_s_lat = any((F(ln, "s_dur_ms") or 0) >= 40 for ln in ("I", "V6") if ln in feats)
    v1_s_dominant = "V1" in feats and (morph("V1") in ("QS", "rS", "rs", "S", "s") or abs(F("V1", "s_amp_mv")) > 2 * F("V1", "r_amp_mv"))
    lat_no_q = all((F(ln, "q_amp_mv") or 0) > -0.05 for ln in ("I", "V6") if ln in feats) and any(ln in feats for ln in ("I", "V6"))
    lat_r_dom = any(F(ln, "r_amp_mv") > abs(F(ln, "s_amp_mv")) for ln in ("I", "V6") if ln in feats)
    lbbb = False
    if qrs is not None and qrs >= 120:
        if rbbb_pattern and (wide_s_lat or "V1" in feats):
            findings.append(_finding("rbbb", "conduction", "abnormal", f"Полная блокада правой ножки пучка Гиса (QRS {qrs:.0f} мс)",
                                     "QRS ≥ 120 мс, rSR'/доминирующий R в V1–V2, широкий S в I/V6", ("V1", "V2", "I", "V6")))
        elif v1_s_dominant and lat_no_q and lat_r_dom:
            lbbb = True
            findings.append(_finding("lbbb", "conduction", "abnormal", f"Полная блокада левой ножки пучка Гиса (QRS {qrs:.0f} мс)",
                                     "QRS ≥ 120 мс, QS/rS в V1, широкий R без q в I/V6; оценка ST по стандартным критериям невозможна",
                                     ("V1", "I", "V6")))
        else:
            findings.append(_finding("ivcd", "conduction", "abnormal",
                                     f"Нарушение внутрижелудочковой проводимости (QRS {qrs:.0f} мс)", "QRS ≥ 120 мс без типичной картины БПНПГ/БЛНПГ"))
    elif qrs is not None and 110 <= qrs < 120:
        if rbbb_pattern:
            findings.append(_finding("irbbb", "conduction", "borderline", f"Неполная блокада правой ножки пучка Гиса (QRS {qrs:.0f} мс)",
                                     "rSR' в V1–V2, QRS 110–119 мс", ("V1", "V2")))
        else:
            findings.append(_finding("slow_ivc", "conduction", "borderline",
                                     f"Замедление внутрижелудочковой проводимости (QRS {qrs:.0f} мс)", "QRS 110–119 мс"))
    if qrs_axis is not None and (qrs or 0) < 120:
        inf_present = [ln for ln in ("II", "III", "aVF") if ln in feats]
        inf_rs = len(inf_present) >= 2 and all(morph(ln).lower().startswith("r") and abs(F(ln, "s_amp_mv")) > F(ln, "r_amp_mv") for ln in inf_present)
        if qrs_axis <= -45 and "aVL" in feats and F("aVL", "q_amp_mv") < -0.02 and F("aVL", "r_amp_mv") > 0.1 and inf_rs:
            findings.append(_finding("lafb", "conduction", "abnormal", "Блокада передней ветви левой ножки пучка Гиса",
                                     f"α = {qrs_axis:+.0f}° (≤ −45°), qR в aVL, rS в II, III, aVF", ("aVL", "II", "III", "aVF")))
        lat_rs = all(abs(F(ln, "s_amp_mv")) > F(ln, "r_amp_mv") for ln in ("I", "aVL") if ln in feats)
        inf_qr = all(F(ln, "q_amp_mv") < -0.02 and F(ln, "r_amp_mv") > abs(F(ln, "s_amp_mv")) for ln in ("III", "aVF") if ln in feats)
        if qrs_axis >= 90 and lat_rs and inf_qr and "III" in feats:
            findings.append(_finding("lpfb", "conduction", "borderline", "Возможна блокада задней ветви левой ножки пучка Гиса (исключите гипертрофию ПЖ)",
                                     f"α = {qrs_axis:+.0f}°, rS в I/aVL, qR в III/aVF", ("I", "aVL", "III", "aVF")))

    # ------------------------------------------------------------------ hypertrophy
    def r(ln: str) -> float:
        return max(0.0, F(ln, "r_amp_mv")) if ln in feats else 0.0

    def sd(ln: str) -> float:
        return max(0.0, -F(ln, "s_amp_mv")) if ln in feats else 0.0

    lvh_crit: List[str] = []
    if "V1" in feats and ("V5" in feats or "V6" in feats):
        sok = sd("V1") + max(r("V5"), r("V6"))
        if sok >= 3.5:
            lvh_crit.append(f"Соколов–Лайон {sok * 10:.0f} мм")
    if "aVL" in feats and "V3" in feats:
        corn = r("aVL") + sd("V3")
        thr = 2.0 if sex == "female" else 2.8
        if corn >= thr:
            lvh_crit.append(f"Корнелл {corn * 10:.0f} мм (порог {thr * 10:.0f} мм)")
        if qrs is not None:
            prod = (corn * 10 + (6 if sex == "female" else 0)) * qrs
            if prod >= 2440:
                lvh_crit.append(f"произведение Корнелла {prod:.0f} мм·мс")
    if "V4" in feats and feats:
        deepest = max(sd(ln) for ln in feats)
        pl = deepest + sd("V4")
        thr = 2.8 if sex == "female" else 2.3
        if pl >= thr:
            lvh_crit.append(f"Пегеро–Ло Прести {pl * 10:.0f} мм")
    if "aVL" in feats and r("aVL") >= 1.1:
        lvh_crit.append(f"R aVL {r('aVL') * 10:.0f} мм")
    if lvh_crit and not lbbb:
        strain_leads = [ln for ln in ("V5", "V6", "I", "aVL") if ln in feats and F(ln, "st_80_mv") <= -0.05 and F(ln, "t_amp_mv") < -0.05]
        txt = "Признаки гипертрофии левого желудочка" + (" с вторичными изменениями ST–T (перегрузка)" if strain_leads else "")
        ev = "; ".join(lvh_crit) + (" (у лиц моложе 35 лет вольтажные критерии малоспецифичны)" if age is not None and age < 35 else "")
        findings.append(_finding("lvh", "hypertrophy", "abnormal", txt, ev, ("V1", "V5", "V6", "aVL", "V3")))
    rvh = []
    if "V1" in feats:
        if r("V1") >= 0.7:
            rvh.append(f"R V1 {r('V1') * 10:.0f} мм")
        if sd("V1") > 0 and r("V1") / max(1e-6, sd("V1")) >= 1 and (qrs or 0) < 120:
            rvh.append("R/S V1 ≥ 1")
        if r("V1") + max(sd("V5"), sd("V6")) >= 1.05:
            rvh.append(f"R V1 + S V5/V6 {(r('V1') + max(sd('V5'), sd('V6'))) * 10:.0f} мм")
    if qrs_axis is not None and qrs_axis >= 110:
        rvh.append(f"α = {qrs_axis:+.0f}°")
    if len(rvh) >= 2 and not any(f["code"] == "rbbb" for f in findings):
        findings.append(_finding("rvh", "hypertrophy", "abnormal", "Признаки гипертрофии правого желудочка", "; ".join(rvh), ("V1", "V5", "V6")))
    if "II" in feats and F("II", "p_amp_mv") >= 0.25:
        findings.append(_finding("rae", "hypertrophy", "borderline", "Признаки перегрузки правого предсердия (P-pulmonale)",
                                 f"P во II {F('II', 'p_amp_mv') * 10:.1f} мм ≥ 2.5 мм", ("II",)))
    lae = []
    if p_ms is not None and p_ms >= 120:
        lae.append(f"P {p_ms:.0f} мс")
    if "V1" in feats and F("V1", "p_terminal_force_mm_s", 0.0) <= -0.04:
        lae.append(f"терминальная фаза P V1 {F('V1', 'p_terminal_force_mm_s', 0.0):.3f} мм·с")
    if lae:
        findings.append(_finding("lae", "hypertrophy", "borderline", "Признаки перегрузки левого предсердия", "; ".join(lae), ("II", "V1")))

    # ------------------------------------------------------------------ ischaemia / infarction
    bad_baseline = sorted(ln for ln in feats if abs(F(ln, "baseline_mismatch_mv")) > 0.25)
    st_feats = [ln for ln in feats if ln not in bad_baseline]
    if bad_baseline:
        findings.append(_finding("st_unreliable", "quality", "info",
                                 f"Сегмент ST в отведениях {_fmt_leads(bad_baseline)} автоматически не оценён (неустойчивая изолиния)",
                                 "уровень PR и TP медианного комплекса расходятся более чем на 2.5 мм"))
    if not lbbb:
        def ste_thr(ln: str) -> float:
            if ln in ("V2", "V3"):
                if sex == "female":
                    return 0.15
                if sex == "male" and age is not None and age < 40:
                    return 0.25
                return 0.2
            return 0.1

        # sustained elevation: at J AND at J+60 ms (a J point misplaced on the QRS tail of a digitized trace must not
        # read as a STEMI)
        ste = [ln for ln in st_feats if ln != "aVR" and ln in TERRITORY and F(ln, "st_j_mv") >= ste_thr(ln)
               and F(ln, "st_60_mv") >= 0.75 * ste_thr(ln)]
        ste_c = _contiguous(ste)
        has_lvh = any(f["code"] == "lvh" for f in findings)
        # LVH: ST elevation in V1-V3 discordant to deep S waves is a secondary repolarisation change unless it is
        # disproportionate (ST/S >= 25 %, the Smith-modified Sgarbossa ratio)
        lvh_discordant = bool(ste_c) and has_lvh and set(ste_c) <= {"V1", "V2", "V3"} and all(
            sd(ln) > 0 and F(ln, "st_j_mv") < 0.25 * sd(ln) for ln in ste_c)
        if ste_c and lvh_discordant:
            mx = max(F(ln, "st_j_mv") for ln in ste_c)
            findings.append(_finding(
                "ste_lvh", "ischemia", "borderline",
                f"Подъём ST до {_mm(mx)} в отведениях {_fmt_leads(ste_c)}, дискордантный глубоким S — вероятно вторичный при гипертрофии ЛЖ",
                "ST/S < 25 % (модифицированный критерий Смита); при клинике ОКС сравните с предыдущими ЭКГ", ste_c))
        elif ste_c:
            mx = max(F(ln, "st_j_mv") for ln in ste_c)
            recip = [ln for ln in st_feats if ln not in ste_c and ln != "aVR" and F(ln, "st_80_mv") <= -0.05]
            findings.append(_finding(
                "ste", "ischemia", "critical",
                f"Подъём сегмента ST до {_mm(mx)} в отведениях {_fmt_leads(ste_c)} (область {_territories(ste_c)})"
                + (f" с реципрокной депрессией в {_fmt_leads(recip)}" if recip else "")
                + " — соответствует критериям ST-элевации; исключите острый коронарный синдром",
                "4-е универсальное определение ИМ: ≥ 1 мм, в V2–V3 ≥ 2 мм (мужчины ≥ 40 лет), ≥ 2.5 мм (< 40 лет), ≥ 1.5 мм (женщины)"
                + ("; пол/возраст не указаны — пороги для мужчин ≥ 40 лет" if sex is None or age is None else ""),
                ste_c))
        std = [ln for ln in st_feats if ln not in ("aVR",) and F(ln, "st_80_mv") <= -0.05 and F(ln, "st_60_mv") <= -0.05
               and F(ln, "st_slope_mv_s") <= 0.5]
        std_c = [ln for ln in _contiguous(std) if ln not in ste_c]
        if std_c:
            mn = min(F(ln, "st_80_mv") for ln in std_c)
            diffuse = len(std) >= 6 and "aVR" in feats and F("aVR", "st_j_mv") >= 0.1
            findings.append(_finding(
                "std", "ischemia", "critical" if diffuse else "abnormal",
                f"Депрессия сегмента ST до {_mm(mn)} в отведениях {_fmt_leads(std_c)}"
                + (" при подъёме ST в aVR — возможна ишемия при поражении ствола ЛКА / многососудистом поражении" if diffuse else ""),
                "горизонтальная/косонисходящая депрессия ≥ 0.5 мм (J+80 мс) в ≥ 2 смежных отведениях", std_c))
        twi = [ln for ln in st_feats if ln not in ("aVR", "V1", "III") and F(ln, "t_amp_mv") <= -0.1 and F(ln, "r_amp_mv") >= 0.25]
        twi_c = _contiguous(twi)
        if twi_c:
            findings.append(_finding("twi", "ischemia", "abnormal", f"Отрицательные зубцы T в отведениях {_fmt_leads(twi_c)} (область {_territories(twi_c)})",
                                     "инверсия T ≥ 1 мм в ≥ 2 смежных отведениях с выраженным R", twi_c))
        qwaves = []
        for ln in feats:
            if ln in ("aVR", "V1"):  # QS / Q in aVR and V1 is a normal finding
                continue
            qd, qa, m = F(ln, "q_dur_ms"), F(ln, "q_amp_mv"), morph(ln)
            if ln in ("V2", "V3") and (qd >= 20 or m == "QS"):
                qwaves.append(ln)
            elif m == "QS" or (qd >= 30 and qa <= -0.1):
                qwaves.append(ln)
        q_c = _contiguous(qwaves)
        if q_c:
            findings.append(_finding("pathq", "ischemia", "abnormal",
                                     f"Патологические зубцы Q (QS) в отведениях {_fmt_leads(q_c)} — возможны рубцовые изменения {_territories(q_c)}",
                                     "Q ≥ 30 мс и ≥ 1 мм (в V2–V3 любой Q ≥ 20 мс или QS) в ≥ 2 смежных отведениях", q_c))
        if all(ln in feats for ln in ("V1", "V2", "V3")) and r("V3") <= 0.3 and not any(f["code"] in ("rbbb", "pathq") for f in findings):
            findings.append(_finding("prwp", "ischemia", "borderline", "Плохое нарастание зубца R в V1–V3",
                                     f"R V3 {r('V3') * 10:.1f} мм ≤ 3 мм", ("V1", "V2", "V3")))
        brug = [ln for ln in ("V1", "V2") if ln in feats and F(ln, "st_j_mv") >= 0.2 and F(ln, "t_amp_mv") < 0 and F(ln, "st_80_mv") < F(ln, "st_j_mv")]
        if brug:
            findings.append(_finding("brugada", "ischemia", "abnormal", f"Подозрение на паттерн Бругада 1 типа ({_fmt_leads(brug)})",
                                     "куполообразный подъём ST ≥ 2 мм с отрицательным T в V1–V2", brug))

    # ------------------------------------------------------------------ repolarization
    if qtcf is not None:
        long_thr = 460 if sex == "female" else 450
        if qtcf >= 500:
            findings.append(_finding("long_qt", "repolarization", "critical", f"Выраженное удлинение интервала QT (QTc {qtcf:.0f} мс) — риск желудочковых аритмий",
                                     "QTc (Фридеричиа) ≥ 500 мс"))
        elif qtcf > long_thr:
            findings.append(_finding("long_qt", "repolarization", "abnormal", f"Удлинение интервала QT (QTc {qtcf:.0f} мс)",
                                     f"QTc (Фридеричиа) > {long_thr} мс" + ("; пол не указан — порог для мужчин" if sex is None else "")))
        elif qtcf < 340:
            findings.append(_finding("short_qt", "repolarization", "abnormal", f"Укорочение интервала QT (QTc {qtcf:.0f} мс)", "QTc < 340 мс"))
    angle = ax.get("qrs_t_angle_deg")
    if angle is not None and angle > 100:
        findings.append(_finding("qrst_angle", "repolarization", "borderline", f"Увеличен фронтальный угол QRS–T ({angle:.0f}°)", "> 100°"))

    # ------------------------------------------------------------------ voltage / other
    limb_present = [ln for ln in LIMB if ln in feats]
    if len(limb_present) >= 4 and all(F(ln, "qrs_p2p_mv") < 0.5 for ln in limb_present):
        findings.append(_finding("lowv_limb", "other", "borderline", "Низкий вольтаж QRS в отведениях от конечностей", "размах QRS < 5 мм во всех отведениях от конечностей"))
    prec_present = [ln for ln in PRECORDIAL if ln in feats]
    if len(prec_present) >= 4 and all(F(ln, "qrs_p2p_mv") < 1.0 for ln in prec_present):
        findings.append(_finding("lowv_prec", "other", "borderline", "Низкий вольтаж QRS в грудных отведениях", "размах QRS < 10 мм во всех грудных отведениях"))

    # ------------------------------------------------------------------ quality / limitations
    present = set(all_feats)
    missing = [ln for ln in LIMB + PRECORDIAL if ln not in present]
    if missing and len(missing) < 12:
        findings.append(_finding("limited_leads", "quality", "info", f"Анализ ограничен имеющимися отведениями (нет {_fmt_leads(missing)})"))
    if excluded:
        one = len(excluded) == 1
        findings.append(_finding("excluded_leads", "quality", "info",
                                 f"{'Отведение' if one else 'Отведения'} {_fmt_leads(excluded)} {'исключено' if one else 'исключены'}"
                                 " из анализа из-за низкого качества оцифровки"))
    if not analysis.get("simultaneous_leads", True):
        findings.append(_finding("non_simultaneous", "quality", "info",
                                 "Группы отведений записаны не одновременно — интервалы оценены по группам"))

    abnormal = [f for f in findings if SEVERITY_ORDER[f["severity"]] <= 1]
    if not abnormal and n_beats >= 2:
        borderline = any(f["severity"] == "borderline" for f in findings)
        findings.append(_finding("no_abnormal", "other", "normal",
                                 ("Выраженных патологических изменений" if borderline else "Патологических изменений")
                                 + " автоматически не выявлено"))

    findings.sort(key=lambda f: (SECTIONS.index(f["section"]), SEVERITY_ORDER[f["severity"]]))
    return {
        "findings": findings,
        "conclusion_text": compose_conclusion(findings),
        "patient": {"sex": sex, "age": age},
        "axis_convention": convention,
    }


DISCLAIMER = "Автоматическое заключение — требует проверки и подтверждения врачом."


def compose_conclusion(findings: List[Dict[str, Any]], include: Optional[Sequence[str]] = None) -> str:
    """Joins the selected findings (default ones when `include` is None) into the report text, section by section."""
    chosen = [f for f in findings if (f["code"] in include if include is not None else f.get("default", True))]
    lines: List[str] = []
    for sec in SECTIONS:
        texts = [f["text"] for f in chosen if f["section"] == sec]
        if texts:
            lines.append(" ".join(texts))
    lines.append(DISCLAIMER)
    return "\n".join(lines)
