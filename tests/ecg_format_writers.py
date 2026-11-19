"""Minimal writers for the digital ECG formats (test fixtures for app.core.ecg_formats)."""

from __future__ import annotations

import base64
import io
import struct
from typing import Dict, List, Optional

import numpy as np


def _pad(s: str, n: int) -> bytes:
    return s.encode("latin-1")[:n].ljust(n, b" ")


def write_edf(leads: Dict[str, np.ndarray], fs: float, bdf: bool = False, with_annotations: bool = False,
              patient: str = "X M 01-JAN-1960 Test_Patient") -> bytes:
    names = list(leads)
    n = min(len(v) for v in leads.values())
    spr = int(fs)  # 1-s records
    n_rec = n // spr
    sigs = [np.asarray(leads[k][: n_rec * spr], dtype=np.float64) * 1000.0 for k in names]  # uV
    labels = names + (["EDF Annotations"] if with_annotations else [])
    ns = len(labels)
    dmin, dmax = (-(2 ** 23), 2 ** 23 - 1) if bdf else (-32768, 32767)
    pmin, pmax = -8000.0, 8000.0
    hdr = (b"\xffBIOSEMI" if bdf else _pad("0", 8)) + _pad(patient, 80) + _pad("Startdate 01-JAN-2026 X X X", 80)
    hdr += _pad("01.01.26", 8) + _pad("10.00.00", 8) + _pad(str(256 + 256 * ns), 8)
    hdr += _pad("EDF+C" if with_annotations else ("24BIT" if bdf else ""), 44) + _pad(str(n_rec), 8) + _pad("1", 8) + _pad(str(ns), 4)
    sh = b"".join(_pad(lb, 16) for lb in labels)
    sh += b"".join(_pad("AgAgCl", 80) for _ in labels)
    sh += b"".join(_pad("uV" if lb != "EDF Annotations" else "", 8) for lb in labels)
    sh += b"".join(_pad(f"{pmin:g}", 8) for _ in labels) + b"".join(_pad(f"{pmax:g}", 8) for _ in labels)
    sh += b"".join(_pad(str(dmin), 8) for _ in labels) + b"".join(_pad(str(dmax), 8) for _ in labels)
    sh += b"".join(_pad("HP:0.05Hz", 80) for _ in labels)
    ann_spr = 30
    sh += b"".join(_pad(str(spr if lb != "EDF Annotations" else ann_spr), 8) for lb in labels)
    sh += b"".join(_pad("", 32) for _ in labels)
    scale = (dmax - dmin) / (pmax - pmin)
    body = io.BytesIO()
    for r in range(n_rec):
        for s in sigs:
            d = np.clip(np.round((s[r * spr:(r + 1) * spr] - pmin) * scale + dmin), dmin, dmax).astype(np.int32)
            if bdf:
                b = (d & 0xFFFFFF).astype("<u4").view(np.uint8).reshape(-1, 4)[:, :3]
                body.write(b.tobytes())
            else:
                body.write(d.astype("<i2").tobytes())
        if with_annotations:
            tal = f"+{r}\x14\x14\x00".encode("latin-1").ljust(ann_spr * 2, b"\x00")
            body.write(tal)
    return hdr + sh + body.getvalue()


ISHNE_CODES = {"I": 5, "II": 6, "III": 7, "aVR": 8, "aVL": 9, "aVF": 10, "V1": 11, "V2": 12, "V3": 13, "V4": 14, "V5": 15, "V6": 16}


def write_ishne(leads: Dict[str, np.ndarray], fs: float, res_nv: int = 2500) -> bytes:
    names = list(leads)[:12]
    n = min(len(leads[k]) for k in names)
    fixed = struct.pack("<iiii", 0, n, 522, 522) + struct.pack("<h", 1)
    fixed += b"Ivan".ljust(40, b"\0") + b"Petrov".ljust(40, b"\0") + b"ID42".ljust(20, b"\0")
    fixed += struct.pack("<hh", 1, 0) + struct.pack("<9h", 1, 1, 1960, 1, 1, 2026, 1, 1, 2026) + struct.pack("<3h", 8, 30, 0)
    specs = [ISHNE_CODES.get(k, 0) for k in names] + [-9] * (12 - len(names))
    fixed += struct.pack("<h", len(names)) + struct.pack("<12h", *specs) + struct.pack("<12h", *([0] * 12))
    fixed += struct.pack("<12h", *([res_nv] * len(names) + [-9] * (12 - len(names))))
    fixed += struct.pack("<h", 0) + b"TestRec".ljust(40, b"\0") + struct.pack("<h", int(fs))
    fixed += b"\0" * 80 + b"\0" * 80 + b"\0" * 88
    assert len(fixed) == 512
    mat = np.stack([np.round(np.asarray(leads[k][:n]) * 1.0e6 / res_nv) for k in names], axis=1).astype("<i2")
    return b"ISHNE1.0" + b"\0\0" + fixed + mat.tobytes()


def write_wfdb(leads: Dict[str, np.ndarray], fs: float, fmt: int = 16, gain: float = 200.0, baseline: int = 0,
               record: str = "rec") -> Dict[str, bytes]:
    names = list(leads)
    n = min(len(v) for v in leads.values())
    dig = np.stack([np.round(np.asarray(leads[k][:n]) * gain) + baseline for k in names], axis=1).astype(np.int32)
    flat = dig.reshape(-1)
    if fmt == 16:
        raw = flat.astype("<i2").tobytes()
    elif fmt == 212:
        if flat.size % 2:
            flat = np.append(flat, 0)
        v = flat & 0xFFF
        a, b = v[0::2], v[1::2]
        out = np.empty(a.size * 3, dtype=np.uint8)
        out[0::3] = a & 0xFF
        out[1::3] = ((a >> 8) & 0x0F) | (((b >> 8) & 0x0F) << 4)
        out[2::3] = b & 0xFF
        raw = out.tobytes()
    else:
        raise ValueError(fmt)
    lines = [f"{record} {len(names)} {fs:g} {n}"]
    for k in names:
        lines.append(f"{record}.dat {fmt} {gain:g}({baseline})/mV 12 {baseline} 0 0 0 {k}")
    return {f"{record}.hea": ("\n".join(lines) + "\n").encode(), f"{record}.dat": raw}


def write_muse_xml(leads: Dict[str, np.ndarray], fs: float, uv_per_bit: float = 4.88) -> bytes:
    parts = ['<?xml version="1.0" encoding="ISO-8859-1"?>', "<RestingECG>",
             "<PatientDemographics><PatientID>777</PatientID><PatientAge>63</PatientAge><Gender>FEMALE</Gender>"
             "<PatientLastName>Test</PatientLastName><PatientFirstName>Anna</PatientFirstName></PatientDemographics>",
             "<Waveform><WaveformType>Median</WaveformType><SampleBase>500</SampleBase>"
             "<LeadData><LeadID>I</LeadID><LeadAmplitudeUnitsPerBit>4.88</LeadAmplitudeUnitsPerBit>"
             "<LeadAmplitudeUnits>MICROVOLTS</LeadAmplitudeUnits><WaveFormData>AAAAAA==</WaveFormData></LeadData></Waveform>",
             f"<Waveform><WaveformType>Rhythm</WaveformType><SampleBase>{int(fs)}</SampleBase>"]
    for k in ("I", "II", "V1", "V2", "V3", "V4", "V5", "V6"):
        d = np.round(np.asarray(leads[k]) * 1000.0 / uv_per_bit).astype("<i2").tobytes()
        b64 = base64.b64encode(d).decode()
        b64 = "\n".join(b64[i:i + 76] for i in range(0, len(b64), 76))
        parts.append(f"<LeadData><LeadID>{k}</LeadID><LeadAmplitudeUnitsPerBit>{uv_per_bit}</LeadAmplitudeUnitsPerBit>"
                     f"<LeadAmplitudeUnits>MICROVOLTS</LeadAmplitudeUnits><WaveFormData>{b64}</WaveFormData></LeadData>")
    parts.append("</Waveform></RestingECG>")
    return "\n".join(parts).encode("latin-1")


def write_hl7_aecg(leads: Dict[str, np.ndarray], fs: float, scale_uv: float = 5.0) -> bytes:
    seqs = [f'<component><sequence><code code="TIME_ABSOLUTE" codeSystem="2.16.840.1.113883.5.4"/>'
            f'<value xsi:type="GLIST_TS"><head value="20260101100000.000"/><increment value="{1.0 / fs:g}" unit="s"/></value>'
            f"</sequence></component>"]
    for k in ("I", "II", "V1", "V2", "V3", "V4", "V5", "V6"):
        digits = " ".join(str(int(v)) for v in np.round(np.asarray(leads[k]) * 1000.0 / scale_uv))
        seqs.append(f'<component><sequence><code code="MDC_ECG_LEAD_{k}" codeSystem="2.16.840.1.113883.6.24"/>'
                    f'<value xsi:type="SLIST_PQ"><origin value="0" unit="uV"/><scale value="{scale_uv:g}" unit="uV"/>'
                    f"<digits>{digits}</digits></value></sequence></component>")
    median = ('<derivation><derivedSeries><component><sequenceSet><component><sequence><code code="MDC_ECG_LEAD_I"/>'
              '<value xsi:type="SLIST_PQ"><origin value="0" unit="uV"/><scale value="1" unit="uV"/><digits>9999 9999</digits>'
              "</value></sequence></component></sequenceSet></component></derivedSeries></derivation>")
    xml = ('<?xml version="1.0" encoding="UTF-8"?><AnnotatedECG xmlns="urn:hl7-org:v3" '
           'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><component><series>'
           f"<component><sequenceSet>{''.join(seqs)}</sequenceSet></component>{median}</series></component></AnnotatedECG>")
    return xml.encode()


def write_dicom_ecg(leads: Dict[str, np.ndarray], fs: float, sensitivity_uv: float = 2.5) -> bytes:
    from pydicom.dataset import Dataset, FileMetaDataset
    from pydicom.uid import UID, ExplicitVRLittleEndian, generate_uid

    names = list(leads)[:12]
    n = min(len(leads[k]) for k in names)
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = UID("1.2.840.10008.5.1.4.1.1.9.1.1")
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset()
    ds.file_meta = meta
    ds.SOPClassUID = meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.Modality = "ECG"
    ds.PatientName = "Test^Oleg"
    ds.PatientID = "D-1"
    ds.PatientSex = "M"
    ds.PatientAge = "071Y"
    w = Dataset()
    w.WaveformOriginality = "ORIGINAL"
    w.NumberOfWaveformChannels = len(names)
    w.NumberOfWaveformSamples = n
    w.SamplingFrequency = fs
    chans = []
    for k in names:
        c = Dataset()
        src = Dataset()
        src.CodeValue = "5.6.3-9-1"
        src.CodingSchemeDesignator = "SCPECG"
        src.CodeMeaning = f"Lead {k}"
        c.ChannelSourceSequence = [src]
        c.ChannelSensitivity = f"{sensitivity_uv:g}"
        unit = Dataset()
        unit.CodeValue = "uV"
        unit.CodingSchemeDesignator = "UCUM"
        unit.CodeMeaning = "microvolt"
        c.ChannelSensitivityUnitsSequence = [unit]
        c.ChannelSensitivityCorrectionFactor = "1"
        c.ChannelBaseline = "0"
        c.WaveformBitsStored = 16
        chans.append(c)
    w.ChannelDefinitionSequence = chans
    w.WaveformBitsAllocated = 16
    w.WaveformSampleInterpretation = "SS"
    mat = np.stack([np.round(np.asarray(leads[k][:n]) * 1000.0 / sensitivity_uv) for k in names], axis=1).astype("<i2")
    w.WaveformData = mat.tobytes()
    ds.WaveformSequence = [w]
    buf = io.BytesIO()
    ds.save_as(buf, enforce_file_format=True)
    return buf.getvalue()


def write_csv(leads: Dict[str, np.ndarray], fs: float, names: Optional[List[str]] = None) -> bytes:
    names = names or list(leads)
    n = min(len(leads[k]) for k in names)
    rows = ["sample_idx,time_sec,time_ms," + ",".join(f"{k}_mV,{k}_uV" for k in names)]
    for i in range(n):
        vals = ",".join(f"{leads[k][i]:.4f},{leads[k][i] * 1000:.1f}" for k in names)
        rows.append(f"{i},{i / fs:.4f},{i * 1000 / fs:.2f},{vals}")
    return ("﻿" + "\n".join(rows)).encode("utf-8")
