"""
Readers for digital ECG / Holter recordings (no image digitization needed).

Supported (detected by content, not only by extension):
- EDF / EDF+ / BDF (.edf, .bdf, .rec)            — European Data Format, most Holters / PSG recorders
- ISHNE Holter (.ecg, .ishne)                     — ISHNE 1.0 standard Holter format
- WFDB / PhysioNet (.hea + .dat, formats 16/212/80/61, or a .zip with both)
- GE MUSE XML (RestingECG)                        — base64 int16 rhythm waveforms
- HL7 aECG XML (AnnotatedECG, FDA)                — SLIST_PQ digit sequences
- DICOM ECG waveform (.dcm)                       — 12-lead / general ECG Waveform IODs (pydicom)
- CSV / TXT columns                               — incl. this application's own CSV export

Every reader returns a `Recording`: physical signals in mV per lead, the native sampling rate and metadata.
`load_recording` then normalises lead names (MLII -> II, "Lead V1" -> V1, ...), derives missing limb leads from
I and II (III, aVR, aVL, aVF, Einthoven/Goldberger), resamples to the workbench rate (500 Hz) and cuts the
requested segment of long (Holter) recordings.
"""

from __future__ import annotations

import base64
import csv
import io
import math
import re
import struct
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from scipy import signal as sp_signal

TARGET_FS = 500.0
MAX_SEGMENT_S = 120.0
CANONICAL = ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"]


class FormatError(ValueError):
    """Raised for unsupported / malformed files (message is shown to the user)."""


@dataclass
class Recording:
    leads: Dict[str, np.ndarray]  # mV, native rate
    fs: float
    format: str
    info: Dict[str, Any] = field(default_factory=dict)  # patient / device / start time
    warnings: List[str] = field(default_factory=list)


# ------------------------------------------------------------------------------------------------ lead names
_ISHNE_LEADS = {
    0: "Unknown", 1: "Bipolar", 2: "X-bipolar", 3: "Y-bipolar", 4: "Z-bipolar", 5: "I", 6: "II", 7: "III", 8: "aVR",
    9: "aVL", 10: "aVF", 11: "V1", 12: "V2", 13: "V3", 14: "V4", 15: "V5", 16: "V6", 17: "ES", 18: "AS", 19: "AI",
    20: "X", 21: "Y", 22: "Z", 23: "CC5", 24: "CM5", 25: "LA", 26: "RA", 27: "LL", 28: "fI", 29: "fE", 30: "fC",
    31: "fA", 32: "fM", 33: "fF", 34: "fH", 35: "I-cal",
}


def normalize_lead_name(raw: str) -> str:
    """'Lead I (Einthoven)', 'ECG II', 'MDC_ECG_LEAD_V1', 'MLII', 'avl' -> canonical names; others kept as is."""
    s = str(raw).strip()
    u = re.sub(r"[\s_\-]+", " ", s.upper())
    u = re.sub(r"\(.*?\)", "", u).strip()
    for prefix in ("MDC ECG LEAD ", "LEAD ", "ECG ", "EKG "):
        if u.startswith(prefix):
            u = u[len(prefix):].strip()
    u = u.replace(" ", "")
    if u in ("MLII", "ML2", "MII"):
        return "II"
    if u in ("MLI", "ML1"):
        return "I"
    if u in ("MLIII", "ML3"):
        return "III"
    m = re.fullmatch(r"M?V([1-6])", u)
    if m:
        return f"V{m.group(1)}"
    for c in ("I", "II", "III"):
        if u == c:
            return c
    for c in ("AVR", "AVL", "AVF"):
        if u == c:
            return "a" + c[1:]
    return s


def _derive_limb_leads(leads: Dict[str, np.ndarray]) -> List[str]:
    """III, aVR, aVL, aVF from I and II when the device stored only 8 independent leads (GE, HL7, many PC-ECGs)."""
    added = []
    if "I" in leads and "II" in leads:
        i, ii = leads["I"], leads["II"]
        n = min(len(i), len(ii))
        i, ii = i[:n], ii[:n]
        derived = {"III": ii - i, "aVR": -(i + ii) / 2.0, "aVL": i - ii / 2.0, "aVF": ii - i / 2.0}
        for k, v in derived.items():
            if k not in leads:
                leads[k] = v
                added.append(k)
    return added


def _order(leads: Dict[str, np.ndarray]) -> Dict[str, np.ndarray]:
    ordered = {k: leads[k] for k in CANONICAL if k in leads}
    ordered.update({k: v for k, v in leads.items() if k not in ordered})
    return ordered


def _to_mv(values: np.ndarray, unit: str) -> np.ndarray:
    u = (unit or "").strip().lower().replace("µ", "u").replace("μ", "u")
    if u in ("uv", "microvolt", "microvolts", "mkv"):
        return values / 1000.0
    if u in ("v", "volt", "volts"):
        return values * 1000.0
    if u in ("nv",):
        return values / 1.0e6
    return values  # mV (default)


# ------------------------------------------------------------------------------------------------------- EDF
def read_edf(data: bytes) -> Recording:
    if len(data) < 256:
        raise FormatError("Файл EDF слишком короткий")
    is_bdf = data[0:1] == b"\xff"
    hdr = data[:256].decode("latin-1")
    try:
        header_bytes = int(hdr[184:192].strip())
        n_records = int(hdr[236:244].strip())
        rec_dur = float(hdr[244:252].strip() or 1.0)
        ns = int(hdr[252:256].strip())
    except ValueError as exc:
        raise FormatError("Повреждённый заголовок EDF") from exc
    if ns <= 0 or header_bytes != 256 + 256 * ns:
        raise FormatError("Некорректный заголовок EDF (число сигналов)")
    sh = data[256:header_bytes].decode("latin-1")

    def field_list(offset: int, width: int) -> List[str]:
        return [sh[offset + i * width: offset + (i + 1) * width].strip() for i in range(ns)]

    off = 0
    labels = field_list(off, 16); off += 16 * ns
    off += 80 * ns  # transducer
    units = field_list(off, 8); off += 8 * ns
    pmin = [float(v) for v in field_list(off, 8)]; off += 8 * ns
    pmax = [float(v) for v in field_list(off, 8)]; off += 8 * ns
    dmin = [float(v) for v in field_list(off, 8)]; off += 8 * ns
    dmax = [float(v) for v in field_list(off, 8)]; off += 8 * ns
    off += 80 * ns  # prefilter
    nsamp = [int(v) for v in field_list(off, 8)]
    bps = 3 if is_bdf else 2
    rec_size = sum(nsamp) * bps
    body = data[header_bytes:]
    if n_records < 0:
        n_records = len(body) // max(1, rec_size)
    n_records = min(n_records, len(body) // max(1, rec_size))
    if n_records <= 0:
        raise FormatError("EDF не содержит записей данных")
    raw = np.frombuffer(body[: n_records * rec_size], dtype=np.uint8).reshape(n_records, rec_size)
    leads: Dict[str, np.ndarray] = {}
    fs_list = []
    pos = 0
    for i in range(ns):
        width = nsamp[i] * bps
        chunk = raw[:, pos:pos + width].reshape(-1)
        pos += width
        if "annotation" in labels[i].lower():
            continue
        if is_bdf:
            b = chunk.reshape(-1, 3).astype(np.int32)
            dig = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
            dig = np.where(dig >= 1 << 23, dig - (1 << 24), dig).astype(np.float64)
        else:
            dig = np.frombuffer(chunk.tobytes(), dtype="<i2").astype(np.float64)
        scale = (pmax[i] - pmin[i]) / (dmax[i] - dmin[i]) if dmax[i] != dmin[i] else 1.0
        phys = (dig - dmin[i]) * scale + pmin[i]
        leads[labels[i] or f"ch{i + 1}"] = _to_mv(phys, units[i])
        fs_list.append(nsamp[i] / rec_dur)
    if not leads:
        raise FormatError("EDF не содержит сигналов ЭКГ")
    fs = max(set(fs_list), key=fs_list.count)
    keep = {k: v for (k, v), f in zip(leads.items(), fs_list) if abs(f - fs) < 1e-6}
    info = {"patient": hdr[8:88].strip(), "recording": hdr[88:168].strip(), "start": f"{hdr[168:176].strip()} {hdr[176:184].strip()}"}
    _parse_edfplus_patient(info, hdr)
    rec = Recording(keep, fs, "BDF" if is_bdf else ("EDF+" if hdr[192:197] in ("EDF+C", "EDF+D") else "EDF"), info)
    if len(keep) < len(leads):
        rec.warnings.append("Каналы с другой частотой дискретизации пропущены")
    return rec


_MONTHS = {m: i + 1 for i, m in enumerate(["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"])}


def _parse_edfplus_patient(info: Dict[str, Any], hdr: str) -> None:
    """EDF+ local patient id: 'code sex dd-MMM-yyyy Name_Surname' ('X' for unknown subfields)."""
    parts = info["patient"].split()
    if len(parts) < 4 or parts[1] not in ("M", "F", "X"):
        return
    code, sex, birth, name = parts[0], parts[1], parts[2], " ".join(parts[3:])
    info["patient"] = "" if name == "X" else name.replace("_", " ")
    if code != "X":
        info["patient_id"] = code
    if sex in ("M", "F"):
        info["sex"] = "male" if sex == "M" else "female"
    bm = re.match(r"(\d{2})-([A-Z]{3})-(\d{4})$", birth.upper())
    sm = re.search(r"Startdate\s+(\d{2})-([A-Z]{3})-(\d{4})", info.get("recording", ""), re.I)
    if bm and bm.group(2) in _MONTHS:
        by, bmo, bd = int(bm.group(3)), _MONTHS[bm.group(2)], int(bm.group(1))
        if sm and sm.group(2).upper() in _MONTHS:
            ry, rmo, rd = int(sm.group(3)), _MONTHS[sm.group(2).upper()], int(sm.group(1))
        else:
            d = re.match(r"(\d{2})\.(\d{2})\.(\d{2})", hdr[168:176])
            if not d:
                return
            yy = int(d.group(3))
            ry, rmo, rd = (2000 + yy if yy < 85 else 1900 + yy), int(d.group(2)), int(d.group(1))
        info["age"] = ry - by - ((rmo, rd) < (bmo, bd))


# ----------------------------------------------------------------------------------------------------- ISHNE
def read_ishne(data: bytes) -> Recording:
    if not data.startswith(b"ISHNE1.0"):
        raise FormatError("Не файл ISHNE 1.0")
    h = 10  # magic + CRC
    _var_len, _n_samples, _off_var, off_ecg = struct.unpack_from("<iiii", data, h)
    p = h + 16 + 2  # + file version
    first = data[p:p + 40].split(b"\0")[0].decode("latin-1", "ignore").strip(); p += 40
    last = data[p:p + 40].split(b"\0")[0].decode("latin-1", "ignore").strip(); p += 40
    pid = data[p:p + 20].split(b"\0")[0].decode("latin-1", "ignore").strip(); p += 20
    sex, _race = struct.unpack_from("<hh", data, p); p += 4
    p += 6 * 3  # birth / record / file dates
    start = struct.unpack_from("<hhh", data, p); p += 6
    n_leads = struct.unpack_from("<h", data, p)[0]; p += 2
    specs = struct.unpack_from("<12h", data, p); p += 24
    p += 24  # quality
    res = struct.unpack_from("<12h", data, p); p += 24
    p += 2 + 40  # pacemaker + recorder
    fs = float(struct.unpack_from("<h", data, p)[0])
    if n_leads <= 0 or n_leads > 12 or fs <= 0:
        raise FormatError("Некорректный заголовок ISHNE")
    body = np.frombuffer(data[off_ecg:], dtype="<i2")
    total = (len(body) // n_leads) * n_leads
    mat = body[:total].reshape(-1, n_leads).astype(np.float64)
    leads = {}
    for i in range(n_leads):
        name = _ISHNE_LEADS.get(int(specs[i]), f"ch{i + 1}")
        if name in leads:
            name = f"{name}-{i + 1}"
        leads[name] = mat[:, i] * float(res[i] or 1) / 1.0e6  # nV -> mV
    info = {"patient": f"{last} {first}".strip(), "patient_id": pid, "start": f"{start[0]:02d}:{start[1]:02d}:{start[2]:02d}",
            "sex": {1: "male", 2: "female"}.get(int(sex))}
    return Recording(leads, fs, "ISHNE", info)


# ------------------------------------------------------------------------------------------------------ WFDB
def _decode_wfdb(raw: bytes, fmt: int, n_sig: int) -> np.ndarray:
    if fmt == 16:
        d = np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2").astype(np.int32)
    elif fmt == 61:
        d = np.frombuffer(raw[: len(raw) // 2 * 2], dtype=">i2").astype(np.int32)
    elif fmt == 80:
        d = np.frombuffer(raw, dtype=np.uint8).astype(np.int32) - 128
    elif fmt == 212:
        b = np.frombuffer(raw[: len(raw) // 3 * 3], dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        s1 = b[:, 0] | ((b[:, 1] & 0x0F) << 8)
        s2 = b[:, 2] | ((b[:, 1] & 0xF0) << 4)
        d = np.empty(s1.size * 2, dtype=np.int32)
        d[0::2], d[1::2] = s1, s2
        d = np.where(d > 2047, d - 4096, d)
    else:
        raise FormatError(f"Формат WFDB {fmt} не поддерживается (поддерживаются 16, 212, 80, 61)")
    return d[: len(d) // n_sig * n_sig].reshape(-1, n_sig)


def read_wfdb(header: str, dat_files: Dict[str, bytes]) -> Recording:
    lines = [ln.strip() for ln in header.splitlines() if ln.strip() and not ln.startswith("#")]
    if not lines:
        raise FormatError("Пустой заголовок WFDB (.hea)")
    rec = lines[0].split()
    n_sig = int(rec[1])
    fs = float(rec[2].split("/")[0]) if len(rec) > 2 else 250.0
    sig_lines = lines[1:1 + n_sig]
    by_file: Dict[str, List[Tuple[int, List[str]]]] = {}
    for idx, ln in enumerate(sig_lines):
        by_file.setdefault(ln.split()[0], []).append((idx, ln.split()))
    leads: Dict[str, np.ndarray] = {}
    for fname, items in by_file.items():
        raw = dat_files.get(fname) or dat_files.get(fname.split("/")[-1])
        if raw is None:
            raise FormatError(f"Не найден файл данных WFDB «{fname}» — загрузите .hea вместе с .dat (или .zip)")
        fmt = int(items[0][1][1].split("x")[0].split(":")[0].split("+")[0])
        mat = _decode_wfdb(raw, fmt, len(items))
        for col, (_, parts) in enumerate(items):
            gain_s = parts[2] if len(parts) > 2 else "200"
            m = re.match(r"([\d.eE+-]+)(?:\(([-\d]+)\))?(?:/(\S+))?", gain_s)
            gain = float(m.group(1)) if m and float(m.group(1)) != 0 else 200.0
            unit = m.group(3) if m and m.group(3) else "mV"
            adc_zero = int(parts[4]) if len(parts) > 4 else 0
            baseline = int(m.group(2)) if m and m.group(2) else adc_zero
            desc = " ".join(parts[8:]) if len(parts) > 8 else f"ch{col + 1}"
            leads[desc or f"ch{col + 1}"] = _to_mv((mat[:, col] - baseline) / gain, unit)
    return Recording(leads, fs, "WFDB", {"record": rec[0]})


# ------------------------------------------------------------------------------------------------------- XML
def _strip_ns(root: ET.Element) -> None:
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]


def read_muse_xml(root: ET.Element) -> Recording:
    waves = root.findall(".//Waveform")
    wave = next((w for w in waves if (w.findtext("WaveformType") or "").strip().lower() == "rhythm"), waves[0] if waves else None)
    if wave is None:
        raise FormatError("В XML GE MUSE нет блока <Waveform>")
    fs = float(wave.findtext("SampleBase") or 500)
    leads = {}
    for ld in wave.findall("LeadData"):
        name = (ld.findtext("LeadID") or "").strip()
        b64 = (ld.findtext("WaveFormData") or "").strip()
        if not name or not b64:
            continue
        uv_per_bit = float(ld.findtext("LeadAmplitudeUnitsPerBit") or 4.88)
        unit = (ld.findtext("LeadAmplitudeUnits") or "MICROVOLTS").upper()
        vals = np.frombuffer(base64.b64decode(b64), dtype="<i2").astype(np.float64) * uv_per_bit
        leads[name] = vals / 1000.0 if "MICRO" in unit else vals
    demo = root.find(".//PatientDemographics")
    info: Dict[str, Any] = {}
    if demo is not None:
        info = {"patient": f"{demo.findtext('PatientLastName') or ''} {demo.findtext('PatientFirstName') or ''}".strip(),
                "patient_id": demo.findtext("PatientID") or "", "age": demo.findtext("PatientAge")}
        g = (demo.findtext("Gender") or "").upper()
        info["sex"] = "male" if g.startswith("M") else ("female" if g.startswith("F") else None)
    return Recording(leads, fs, "GE MUSE XML", info)


def read_hl7_aecg(root: ET.Element) -> Recording:
    for parent in list(root.iter()):
        for child in list(parent):
            if child.tag in ("derivation", "derivedSeries"):
                parent.remove(child)
    seq_set = root.find(".//sequenceSet")
    if seq_set is None:
        raise FormatError("В HL7 aECG нет блока <sequenceSet>")
    leads = {}
    fs = None
    for seq in seq_set.iter("sequence"):
        code = seq.find("code")
        val = seq.find("value")
        if code is None or val is None:
            continue
        c = code.get("code", "")
        if "TIME" in c.upper():
            inc = val.find("increment")
            if inc is not None and fs is None:
                step = float(inc.get("value", "0.002"))
                fs = 1.0 / (step / 1000.0 if inc.get("unit", "s") == "ms" else step)
            continue
        digits = val.findtext("digits")
        if not digits:
            continue
        origin = val.find("origin")
        scale = val.find("scale")
        o = float(origin.get("value", 0)) if origin is not None else 0.0
        sc = float(scale.get("value", 1)) if scale is not None else 1.0
        unit = (scale.get("unit") if scale is not None else "uV") or "uV"
        arr = np.array(digits.split(), dtype=np.float64) * sc + o
        leads[c.replace("MDC_ECG_LEAD_", "")] = _to_mv(arr, unit)
    if not leads:
        raise FormatError("В HL7 aECG не найдены последовательности отведений")
    return Recording(leads, fs or 500.0, "HL7 aECG", {})


# ----------------------------------------------------------------------------------------------------- DICOM
def read_dicom(data: bytes) -> Recording:
    try:
        import pydicom
    except Exception as exc:  # pragma: no cover
        raise FormatError("Для DICOM ЭКГ установите pydicom") from exc
    ds = pydicom.dcmread(io.BytesIO(data), force=True)
    if "WaveformSequence" not in ds:
        raise FormatError("DICOM не содержит ЭКГ-кривых (WaveformSequence)")
    idx = 0
    for i, w in enumerate(ds.WaveformSequence):
        if int(getattr(w, "NumberOfWaveformChannels", 0)) >= 2:
            idx = i
            break
    w = ds.WaveformSequence[idx]
    arr = ds.waveform_array(idx).astype(np.float64)  # sensitivity / baseline applied by pydicom
    fs = float(w.SamplingFrequency)
    leads = {}
    for ch, chdef in enumerate(w.ChannelDefinitionSequence):
        name = f"ch{ch + 1}"
        src = getattr(chdef, "ChannelSourceSequence", None)
        if src:
            name = str(getattr(src[0], "CodeMeaning", name))
        unit = "uV"
        su = getattr(chdef, "ChannelSensitivityUnitsSequence", None)
        if su:
            unit = str(getattr(su[0], "CodeValue", "uV"))
        leads[name] = _to_mv(arr[:, ch], unit)
    info = {"patient": str(getattr(ds, "PatientName", "") or ""), "patient_id": str(getattr(ds, "PatientID", "") or ""),
            "sex": {"M": "male", "F": "female"}.get(str(getattr(ds, "PatientSex", "")).upper())}
    age = str(getattr(ds, "PatientAge", "") or "")
    if age[:3].isdigit():
        info["age"] = int(age[:3])
    return Recording(leads, fs, "DICOM ECG", info)


# ------------------------------------------------------------------------------------------------------- CSV
_CSV_TIME_S = {"time_s", "time_sec", "time", "t", "t_s", "sec", "seconds", "time (s)", "time(s)"}
_CSV_TIME_MS = {"time_ms", "t_ms", "ms", "time (ms)", "time(ms)"}
_CSV_SKIP = {"sample", "sample_idx", "sample_index", "index", "idx", "n", "#", "no"}


def read_csv(data: bytes, fs_hint: Optional[float] = None) -> Recording:
    text = data.decode("utf-8-sig", errors="replace")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t ")
        delim = dialect.delimiter
    except csv.Error:
        delim = ","
    rows = [r for r in csv.reader(io.StringIO(text), delimiter=delim) if any(c.strip() for c in r)]
    if len(rows) < 3:
        raise FormatError("CSV слишком короткий")
    header = [c.strip() for c in rows[0]]
    has_header = any(re.search(r"[A-Za-zА-Яа-я]", c) for c in header)
    body = rows[1:] if has_header else rows
    if not has_header:
        header = [f"ch{i + 1}" for i in range(len(rows[0]))]
    mat = np.array([[float(c.replace(",", ".")) if c.strip() else np.nan for c in r[:len(header)]] for r in body], dtype=np.float64)
    fs = fs_hint
    leads: Dict[str, np.ndarray] = {}
    mv_cols = [i for i, h in enumerate(header) if h.lower().endswith("_mv")]
    for i, h in enumerate(header):
        hl = h.lower().strip()
        if hl in _CSV_TIME_S or hl in _CSV_TIME_MS:
            if fs is None and len(mat) > 2:
                d = float(np.nanmedian(np.diff(mat[:, i])))
                if d > 0:
                    fs = (1.0 if hl in _CSV_TIME_S else 1000.0) / d
            continue
        if hl in _CSV_SKIP:
            continue
        if mv_cols and i not in mv_cols:
            continue  # own export: keep *_mV, drop the duplicated *_uV columns
        name = re.sub(r"_(mv|uv)$", "", h, flags=re.I)
        col = mat[:, i]
        unit = "uV" if hl.endswith("_uv") or (np.nanmax(np.abs(col)) > 50 and not hl.endswith("_mv")) else "mV"
        leads[name] = _to_mv(col, unit)
    if not leads:
        raise FormatError("В CSV не найдено столбцов с сигналами")
    rec = Recording(leads, float(fs or 500.0), "CSV", {})
    if fs is None and fs_hint is None:
        rec.warnings.append("Частота дискретизации в CSV не указана — принята 500 Гц")
    return rec


# ------------------------------------------------------------------------------------------- detection & load
SIGNAL_EXTENSIONS = (".edf", ".bdf", ".rec", ".ecg", ".ishne", ".hea", ".dat", ".xml", ".dcm", ".csv", ".txt", ".zip")


def is_signal_file(filename: str, head: bytes) -> bool:
    name = filename.lower()
    if name.endswith(SIGNAL_EXTENSIONS):
        return True
    return head.startswith(b"ISHNE1.0") or head[:8] == b"0       " or head[128:132] == b"DICM"


def detect_and_read(files: Dict[str, bytes], fs_hint: Optional[float] = None) -> Recording:
    """`files`: {filename: bytes} (several files for WFDB). Zip archives are expanded."""
    expanded: Dict[str, bytes] = {}
    for name, data in files.items():
        if name.lower().endswith(".zip") or data[:4] == b"PK\x03\x04":
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for zi in zf.infolist():
                    if not zi.is_dir() and zi.file_size < 300 * 1024 * 1024:
                        expanded[zi.filename.split("/")[-1]] = zf.read(zi)
        else:
            expanded[name.split("/")[-1].split("\\")[-1]] = data
    heas = [n for n in expanded if n.lower().endswith(".hea")]
    if heas:
        hea = heas[0]
        return read_wfdb(expanded[hea].decode("latin-1"), {n: d for n, d in expanded.items() if n != hea})
    if len(expanded) != 1:
        if any(n.lower().endswith(".dat") for n in expanded):
            raise FormatError("Для WFDB загрузите заголовок .hea вместе с файлом .dat")
        raise FormatError("Загрузите один файл записи (или .hea + .dat / .zip для WFDB)")
    name, data = next(iter(expanded.items()))
    low = name.lower()
    if data.startswith(b"ISHNE1.0"):
        return read_ishne(data)
    if data[:8] == b"0       " or data[0:1] == b"\xff" and data[1:8] == b"BIOSEMI":
        return read_edf(data)
    if len(data) > 132 and data[128:132] == b"DICM" or low.endswith(".dcm"):
        return read_dicom(data)
    if low.endswith(".xml") or data.lstrip()[:1] == b"<":
        try:
            root = ET.fromstring(data)
        except ET.ParseError as exc:
            raise FormatError(f"Некорректный XML: {exc}") from exc
        _strip_ns(root)
        tag = root.tag
        if tag == "RestingECG" or root.find(".//Waveform/LeadData") is not None:
            return read_muse_xml(root)
        if tag == "AnnotatedECG" or root.find(".//sequenceSet") is not None:
            return read_hl7_aecg(root)
        if tag in ("restingecgdata",) or root.find(".//parsedwaveforms") is not None:
            raise FormatError("Philips XML (сжатие XLI) пока не поддерживается — экспортируйте запись в EDF, DICOM или HL7 aECG")
        raise FormatError(f"Неизвестный XML-формат ЭКГ (корневой элемент <{tag}>)")
    if low.endswith(".scp"):
        raise FormatError("SCP-ECG пока не поддерживается — экспортируйте запись в EDF, DICOM, HL7 aECG или CSV")
    if low.endswith((".csv", ".txt")):
        return read_csv(data, fs_hint)
    raise FormatError("Формат файла не распознан")


def _resample(x: np.ndarray, fs: float, target: float) -> np.ndarray:
    if abs(fs - target) < 1e-6:
        return x
    frac = Fraction(target / fs).limit_denominator(200)
    return sp_signal.resample_poly(x, frac.numerator, frac.denominator)


def prepare_recording(files: Dict[str, bytes], fs_hint: Optional[float] = None) -> Recording:
    """Read + normalise lead names + derive missing limb leads. Signals are float32 (24-h Holters stay < 1 GB)."""
    rec = detect_and_read(files, fs_hint=fs_hint)
    if not (20.0 <= rec.fs <= 20000.0):
        raise FormatError(f"Недопустимая частота дискретизации записи: {rec.fs} Гц")
    leads: Dict[str, np.ndarray] = {}
    for raw_name, sig in rec.leads.items():
        name = normalize_lead_name(raw_name)
        if name in leads:
            name = str(raw_name)
        leads[name] = np.nan_to_num(np.asarray(sig, dtype=np.float32))
    if not leads:
        raise FormatError("В записи нет сигналов")
    derived = _derive_limb_leads(leads)
    if derived:
        rec.warnings.append(f"Отведения {', '.join(derived)} вычислены из I и II (запись содержит 8 независимых отведений)")
    n_native = min(len(v) for v in leads.values())
    if n_native < int(0.5 * rec.fs):
        raise FormatError("Запись короче 0.5 с")
    rec.leads = {k: v[:n_native] for k, v in _order(leads).items()}
    rec.info["duration_s"] = n_native / rec.fs
    return rec


def extract_segment(rec: Recording, segment_start_s: float = 0.0, segment_duration_s: Optional[float] = None) -> Dict[str, Any]:
    total_s = float(rec.info["duration_s"])
    seg_dur = float(segment_duration_s) if segment_duration_s else (total_s if total_s <= 60.0 else 30.0)
    seg_dur = float(np.clip(seg_dur, 2.0, MAX_SEGMENT_S))
    seg_dur = min(seg_dur, total_s)
    start = float(np.clip(segment_start_s or 0.0, 0.0, max(0.0, total_s - seg_dur)))
    a, b = int(round(start * rec.fs)), int(round((start + seg_dur) * rec.fs))
    out: Dict[str, List[float]] = {}
    for name, sig in rec.leads.items():
        seg = sig[a:b].astype(np.float64)
        seg = seg - np.median(seg)
        out[name] = [round(float(v), 4) for v in _resample(seg, rec.fs, TARGET_FS)]
    warnings = list(rec.warnings)
    if total_s > seg_dur + 0.5:
        warnings.append(f"Длинная запись ({_fmt_hms(total_s)}): показан фрагмент {_fmt_hms(start)}–{_fmt_hms(start + seg_dur)}")
    return {
        "leads_mv": out,
        "format": rec.format,
        "native_fs": rec.fs,
        "record_duration_s": round(total_s, 3),
        "segment_start_s": round(start, 3),
        "segment_duration_s": round(seg_dur, 3),
        "info": {k: v for k, v in rec.info.items() if v not in (None, "") and k != "duration_s"},
        "warnings": warnings,
    }


def _fmt_hms(t: float) -> str:
    t = int(round(t))
    h, m, s = t // 3600, (t % 3600) // 60, t % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def hr_trend(rec: Recording, max_bins: int = 2000) -> Optional[Dict[str, Any]]:
    """Coarse heart-rate trend of a long (Holter) recording for navigation: per-bin median / min / max HR,
    irregularity (share of RR deviating > 20 % from the local median) and pauses (RR > 2 s).
    Fast single-lead energy detector on a box-decimated (~125 Hz) signal; not a substitute for beat-by-beat review."""
    total_s = float(rec.info["duration_s"])
    if total_s < 90.0:
        return None
    lead = next((ln for ln in ("II", "V5", "I", "V1") if ln in rec.leads), next(iter(rec.leads)))
    x = rec.leads[lead]
    q = max(1, int(rec.fs // 125))
    n = len(x) // q * q
    xd = x[:n].reshape(-1, q).mean(axis=1).astype(np.float64)
    fsd = rec.fs / q
    hi = min(20.0, 0.45 * fsd)
    sos = sp_signal.butter(2, [8.0, hi], btype="band", fs=fsd, output="sos")
    y = sp_signal.sosfiltfilt(sos, xd)
    e = np.convolve(y * y, np.ones(max(1, int(0.08 * fsd))) / max(1, int(0.08 * fsd)), mode="same")
    blk = int(5 * fsd)
    nb = max(1, len(e) // blk)
    p98 = np.array([np.percentile(e[i * blk:(i + 1) * blk], 98) for i in range(nb)])
    p98 = sp_signal.medfilt(p98, 5) if nb >= 5 else p98
    thr = np.repeat(0.3 * p98, blk)
    thr = np.concatenate([thr, np.full(max(0, len(e) - len(thr)), thr[-1] if len(thr) else 0.0)])[: len(e)]
    peaks, _ = sp_signal.find_peaks(e, height=thr, distance=max(1, int(0.25 * fsd)))
    if len(peaks) < 10:
        return None
    t = peaks / fsd
    rr = np.diff(t)
    tr = t[1:]
    ok = (rr >= 0.25) & (rr <= 3.5)
    bin_s = float(max(10, math.ceil(total_s / max_bins / 10.0) * 10))
    n_bins = int(math.ceil(total_s / bin_s))
    idx = np.minimum((tr / bin_s).astype(int), n_bins - 1)
    med = np.full(n_bins, np.nan)
    mn = np.full(n_bins, np.nan)
    mx = np.full(n_bins, np.nan)
    irr = np.full(n_bins, np.nan)
    for bi in range(n_bins):
        r = rr[(idx == bi) & ok]
        if r.size < 3:
            continue
        hr = 60.0 / r
        med[bi], mn[bi], mx[bi] = np.median(hr), np.percentile(hr, 5), np.percentile(hr, 95)
        irr[bi] = float(np.mean(np.abs(r - np.median(r)) > 0.2 * np.median(r)))
    pauses = [{"t_s": round(float(tr[i] - rr[i]), 2), "rr_s": round(float(rr[i]), 2)} for i in np.where((rr > 2.0) & (rr <= 3.5))[0]]
    pauses = sorted(pauses, key=lambda p: -p["rr_s"])[:50]

    def clean(a: np.ndarray) -> List[Optional[float]]:
        return [None if not np.isfinite(v) else round(float(v), 1) for v in a]

    valid = np.isfinite(med)
    return {
        "lead": lead,
        "bin_s": bin_s,
        "hr_median": clean(med),
        "hr_min": clean(mn),
        "hr_max": clean(mx),
        "irregular_fraction": [None if not np.isfinite(v) else round(float(v), 2) for v in irr],
        "pauses": pauses,
        "n_beats": int(len(peaks)),
        "hr_mean_bpm": round(float(60.0 * len(peaks) / total_s), 1),
        "hr_min_bpm": round(float(np.nanmin(mn)), 1) if valid.any() else None,
        "hr_max_bpm": round(float(np.nanmax(mx)), 1) if valid.any() else None,
    }


def load_recording(
    files: Dict[str, bytes],
    segment_start_s: float = 0.0,
    segment_duration_s: Optional[float] = None,
    fs_hint: Optional[float] = None,
) -> Dict[str, Any]:
    rec = prepare_recording(files, fs_hint=fs_hint)
    return extract_segment(rec, segment_start_s, segment_duration_s)
