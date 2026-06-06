#!/usr/bin/env python3
"""Option-B merge validation: take an independent ASR transcript (whisper.cpp segments) and assign
each segment a speaker by max time-overlap with a diarization's speaker time-segments. Do this for
both FunASR's diarization and sherpa-onnx's, then measure how much they agree.

Run with the funasr venv (needs numpy/scipy):
  ~/funasr-spike/venv/bin/python merge.py <sherpa_segments.json>
"""
import json, os, sys
from itertools import combinations
import numpy as np

HOME = os.path.expanduser("~")
SP = HOME + "/funasr-spike/"


def load_whisper(p):
    d = json.load(open(p))
    segs = []
    for s in d.get("transcription", []):
        o = s["offsets"]  # ms
        t = s["text"].strip()
        if t:
            segs.append({"start": o["from"] / 1000.0, "end": o["to"] / 1000.0, "text": t})
    return segs


def funasr_segments_from_dump(p):
    d = json.load(open(p))
    return [{"start": s["start"] / 1000.0, "end": s["end"] / 1000.0, "spk": s["spk"]}
            for s in d["sentence_info"]]


def load_sherpa(p):
    return [{"start": s["start"], "end": s["end"], "spk": s["spk"]} for s in json.load(open(p))]


def assign(w, diar):
    best, best_ov = None, 0.0
    for d in diar:
        ov = min(w["end"], d["end"]) - max(w["start"], d["start"])
        if ov > best_ov:
            best_ov, best = ov, d["spk"]
    return best


def clustering_agreement(la, lb):
    """label-independent: over all segment pairs both tools assigned, fraction where they agree
    on same-speaker-or-not."""
    idx = [i for i in range(len(la)) if la[i] is not None and lb[i] is not None]
    same = tot = 0
    for i, j in combinations(idx, 2):
        tot += 1
        if (la[i] == la[j]) == (lb[i] == lb[j]):
            same += 1
    return same / tot if tot else 0.0, len(idx)


def matched_agreement(la, lb):
    """optimal label mapping via Hungarian, then % segments agreeing."""
    from scipy.optimize import linear_sum_assignment
    idx = [i for i in range(len(la)) if la[i] is not None and lb[i] is not None]
    A = sorted({la[i] for i in idx}); B = sorted({lb[i] for i in idx})
    ai = {a: k for k, a in enumerate(A)}; bi = {b: k for k, b in enumerate(B)}
    M = np.zeros((len(A), len(B)), int)
    for i in idx:
        M[ai[la[i]], bi[lb[i]]] += 1
    r, c = linear_sum_assignment(-M)
    matched = M[r, c].sum()
    return matched / len(idx) if idx else 0.0


def main():
    sherpa_path = sys.argv[1] if len(sys.argv) > 1 else SP + "sherpa_core_5spk.json"
    whisper = load_whisper(SP + "whisper_core.json")
    funasr = funasr_segments_from_dump(SP + "core_cpu_dump.json")
    sherpa = load_sherpa(sherpa_path)

    lf = [assign(w, funasr) for w in whisper]
    ls = [assign(w, sherpa) for w in whisper]

    clu, npairs_n = clustering_agreement(lf, ls)
    mat = matched_agreement(lf, ls)

    out = {
        "whisper_segments": len(whisper),
        "funasr_speakers": len(set(s["spk"] for s in funasr)),
        "sherpa_speakers": len(set(s["spk"] for s in sherpa)),
        "sherpa_file": os.path.basename(sherpa_path),
        "assigned_by_funasr": sum(x is not None for x in lf),
        "assigned_by_sherpa": sum(x is not None for x in ls),
        "clustering_agreement": round(clu, 3),
        "matched_label_agreement": round(mat, 3),
    }
    print("MERGE_JSON " + json.dumps(out, ensure_ascii=False))
    print("\n=== side-by-side (whisper segment | FunASR spk | sherpa spk | text) ===")
    for i, w in enumerate(whisper[:30]):
        print(f"{w['start']:7.1f}-{w['end']:<7.1f} | F={lf[i]} | S={ls[i]} | {w['text'][:48]}")


if __name__ == "__main__":
    main()
