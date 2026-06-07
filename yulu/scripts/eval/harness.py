"""The re-runnable diarization eval harness (EVAL-04) — provider → hyp RTTM → metric table.

This is the GATE made executable: it builds (or loads) the fixed reference corpus, runs a
diarization provider to produce hypothesis RTTMs, scores every recording with the torch-free
metrics, buckets the results by language (CN/EN), and prints a table the ADR quotes. Re-running it
on the fixed corpus turns accuracy into a *tracked number* every later phase can regress against
(EVAL success criterion 5).

Layering — what is and isn't CI-safe:

* The metric math (``metrics``) and RTTM I/O (``rttm``) are pure stdlib → run anywhere, tested in CI.
* **Running a provider** (sherpa / FunASR) needs heavy deps + models, so it is **opt-in**:
  - ``run_provider_sherpa`` imports the Phase-10 ``SherpaDiarizeBackend`` lazily and is only reached
    when you pass ``--provider sherpa`` (with sherpa installed + models present);
  - ``--from-rttm DIR`` scores pre-computed hypothesis RTTMs with **no provider import at all** —
    the path CI/tests use, and the path that scores a hyp produced once in the spike venv.
* ``pyannote.metrics`` is an **optional cross-check** (``--cross-check``); it is imported lazily and
  only when present in the *eval* venv. It is never required and never added to Yulu's runtime.

Typical dev invocations::

    # 1. Build the constructed corpus + measure with sherpa (run from a venv that has sherpa-onnx):
    ~/funasr-spike/venv-sherpa/bin/python -m eval.harness \\
        --build-corpus --provider sherpa \\
        --seg-model ~/funasr-spike/sherpa-models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx \\
        --emb-model ~/funasr-spike/sherpa-models/campplus.onnx \\
        --out /tmp/yulu-eval --json /tmp/yulu-eval/report.json

    # 2. Re-score an existing corpus + hyp RTTMs with the pure metrics (CI-safe, no provider):
    python3 -m eval.harness --corpus /tmp/yulu-eval --from-rttm /tmp/yulu-eval/hyp_sherpa

    # 3. Cross-check the hand-rolled DER against pyannote.metrics (eval venv only):
    ~/funasr-spike/venv-eval/bin/python -m eval.harness --corpus /tmp/yulu-eval \\
        --from-rttm /tmp/yulu-eval/hyp_sherpa --cross-check
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import metrics
from .rttm import Timeline, Turn, load_rttm_one, write_rttm


# ── corpus descriptor (decouples scoring from how the corpus was built) ─────────


@dataclass
class CorpusItem:
    name: str
    language: str
    wav_path: Optional[Path]
    reference: Timeline
    asr_segments: list[dict] = field(default_factory=list)


def load_corpus(corpus_dir: Path) -> list[CorpusItem]:
    """Load a built corpus from ``<dir>/ref/*.rttm`` (+ ``audio/<name>.wav`` + ``asr/<name>.json``).

    Language is inferred from the filename (``*_cn_*`` → cn, ``*_en_*`` → en); ASR segments (for
    WDER/SER) are loaded from ``asr/<name>.json`` when present. This lets the harness re-score a
    corpus without re-building it (the fixed-corpus regression path).
    """
    ref_dir = corpus_dir / "ref"
    if not ref_dir.is_dir():
        raise FileNotFoundError(f"no ref/ dir under {corpus_dir} — build the corpus first")
    items: list[CorpusItem] = []
    for rttm in sorted(ref_dir.glob("*.rttm")):
        name = rttm.stem
        lang = "cn" if "_cn" in name else ("en" if "_en" in name else "unknown")
        wav = corpus_dir / "audio" / f"{name}.wav"
        asr_json = corpus_dir / "asr" / f"{name}.json"
        asr_segments = json.loads(asr_json.read_text()) if asr_json.is_file() else []
        items.append(CorpusItem(
            name=name, language=lang,
            wav_path=wav if wav.is_file() else None,
            reference=load_rttm_one(rttm),
            asr_segments=asr_segments,
        ))
    return items


def build_corpus(out_dir: Path, *, gap_s: float = 0.4) -> list[CorpusItem]:
    """Build the constructed TTS corpus into ``out_dir`` and return it as ``CorpusItem``s.

    Persists ASR segments to ``asr/<name>.json`` so a later ``--from-rttm`` re-score can compute
    WDER/SER without rebuilding audio.
    """
    from . import corpus as corpus_mod  # lazy: only needed when building

    cases = corpus_mod.build_default_corpus(out_dir, gap_s=gap_s)
    asr_dir = out_dir / "asr"
    asr_dir.mkdir(parents=True, exist_ok=True)
    items: list[CorpusItem] = []
    for c in cases:
        (asr_dir / f"{c.name}.json").write_text(
            json.dumps(c.asr_segments, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        items.append(CorpusItem(
            name=c.name, language=c.language, wav_path=c.wav_path,
            reference=c.reference, asr_segments=c.asr_segments,
        ))
    return items


# ── providers (opt-in, lazily imported) ─────────────────────────────────────────


def run_provider_sherpa(
    item: CorpusItem,
    *,
    seg_model: str,
    emb_model: str,
    num_speakers: Optional[int] = None,
    threshold: float = 0.5,
) -> Timeline:
    """Run the Phase-10 ``SherpaDiarizeBackend`` on one item → a hypothesis ``Timeline``.

    Imports the real backend (proving the harness scores *the same engine Yulu ships*, not a
    re-implementation). Only reached under ``--provider sherpa``; needs sherpa-onnx + models.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # yulu/scripts on path
    from stt_daemon.backends.diarize import SherpaDiarizeBackend  # lazy heavy import
    from stt_daemon.runtime import CancelToken

    if item.wav_path is None:
        raise FileNotFoundError(f"no audio for {item.name} — cannot run a provider")
    backend = SherpaDiarizeBackend(
        seg_model=seg_model, emb_model=emb_model,
        num_speakers=num_speakers, threshold=threshold,
    )

    async def _go():
        await backend.warm_up()
        turns = await backend.diarize(
            audio_path=str(item.wav_path),
            num_speakers=num_speakers,
            cancel_token=CancelToken(),
        )
        backend.release()
        return turns

    turns = asyncio.run(_go())
    return Timeline(
        (Turn(t.start, t.end, f"spk-{t.speaker_idx}") for t in turns),
        file_id=item.name,
    )


def run_provider_funasr(
    item: CorpusItem,
    *,
    model_dir: Optional[str] = None,
    num_speakers: Optional[int] = None,
) -> Timeline:
    """Optional FunASR comparison provider (the high-accuracy macOS fallback in spike 002).

    Lazily imports ``funasr``; only reached under ``--provider funasr`` in the funasr venv. Kept
    minimal — its purpose is a comparison DER for the provider ADR, not a shipped path.
    """
    from funasr import AutoModel  # lazy heavy import (torch)

    if item.wav_path is None:
        raise FileNotFoundError(f"no audio for {item.name}")
    kw = {"disable_update": True}
    if model_dir:
        kw["model"] = model_dir
    else:
        kw["model"] = "iic/speech_campplus_speaker-diarization_common"
    model = AutoModel(**kw)
    res = model.generate(input=str(item.wav_path),
                         **({"preset_spk_num": num_speakers} if num_speakers else {}))
    turns: list[Turn] = []
    # FunASR diarization returns sentence_info-style spans with speaker ids (ms).
    payload = res[0] if isinstance(res, list) and res else res
    for s in payload.get("sentence_info", payload.get("spk_segments", [])):
        start = float(s.get("start", 0)) / (1000.0 if s.get("start", 0) > 100 else 1.0)
        end = float(s.get("end", 0)) / (1000.0 if s.get("end", 0) > 100 else 1.0)
        turns.append(Turn(start, end, f"spk-{s.get('spk', s.get('speaker', 0))}"))
    return Timeline(turns, file_id=item.name)


# ── scoring + aggregation ───────────────────────────────────────────────────────


def score_item(item: CorpusItem, hyp: Timeline) -> dict:
    """Full metric bundle for one recording, plus provenance (lang, #ref/#hyp speakers)."""
    bundle = metrics.evaluate(
        ref=item.reference, hyp=hyp,
        asr_segments=item.asr_segments or None,
    )
    bundle["name"] = item.name
    bundle["language"] = item.language
    bundle["ref_speakers"] = item.reference.num_speakers()
    bundle["hyp_speakers"] = hyp.num_speakers()
    return bundle


def aggregate(results: list[dict]) -> dict:
    """Aggregate per-recording results into per-language + overall means.

    DER variants are averaged per protocol key; count error is averaged (signed + abs) so the
    over-split signal survives; WDER/SER are micro-averaged (pool words/segments) when present.
    """
    def _agg(subset: list[dict]) -> dict:
        if not subset:
            return {}
        protocols = ["collar0.25_overlap", "collar0.25_nooverlap", "full_overlap", "full_nooverlap"]
        der_means = {
            p: round(sum(r["der"][p]["der"] for r in subset) / len(subset), 4)
            for p in protocols
        }
        signed = sum(r["count"]["error"] for r in subset) / len(subset)
        abs_err = sum(r["count"]["abs_error"] for r in subset) / len(subset)
        out = {
            "n": len(subset),
            "der": der_means,
            "count_error_mean": round(signed, 2),
            "count_abs_error_mean": round(abs_err, 2),
        }
        wder_subset = [r for r in subset if "wder" in r]
        if wder_subset:
            ww = sum(r["wder"]["wrong"] for r in wder_subset)
            wt = sum(r["wder"]["total"] for r in wder_subset)
            sw = sum(r["ser"]["wrong"] for r in wder_subset)
            st = sum(r["ser"]["total"] for r in wder_subset)
            out["wder"] = round(ww / wt, 4) if wt else 0.0
            out["ser"] = round(sw / st, 4) if st else 0.0
        return out

    by_lang = {}
    for lang in sorted({r["language"] for r in results}):
        by_lang[lang] = _agg([r for r in results if r["language"] == lang])
    return {"overall": _agg(results), "by_language": by_lang}


# ── optional pyannote.metrics cross-check (eval venv only) ───────────────────────


def pyannote_cross_check(item: CorpusItem, hyp: Timeline) -> Optional[dict]:
    """Score the same ref/hyp with ``pyannote.metrics`` for an independent DER (collar 0.25, overlap
    scored). Returns ``None`` if pyannote isn't installed (so the harness degrades gracefully).
    """
    try:
        from pyannote.core import Annotation, Segment  # type: ignore
        from pyannote.metrics.diarization import DiarizationErrorRate  # type: ignore
    except Exception:
        return None

    def _to_annotation(tl: Timeline) -> "Annotation":
        ann = Annotation(uri=tl.file_id)
        for t in tl:
            ann[Segment(t.start, t.end)] = t.speaker
        return ann

    ref = _to_annotation(item.reference)
    hyp_ann = _to_annotation(hyp)
    der_collar = DiarizationErrorRate(collar=0.25, skip_overlap=False)(ref, hyp_ann)
    der_full = DiarizationErrorRate(collar=0.0, skip_overlap=False)(ref, hyp_ann)
    return {"pyannote_der_collar0.25": round(float(der_collar), 4),
            "pyannote_der_full": round(float(der_full), 4)}


# ── CLI ──────────────────────────────────────────────────────────────────────


def _format_table(report: dict) -> str:
    lines = ["", "=== Diarization eval — DER by protocol (lower is better) ===",
             f"{'recording':<24} {'lang':<5} {'ref':>3} {'hyp':>3} "
             f"{'c.25+ov':>8} {'c.25-ov':>8} {'full+ov':>8} {'full-ov':>8} "
             f"{'WDER':>6} {'SER':>6} {'cnt±':>5}"]
    for r in report["per_recording"]:
        d = r["der"]
        wder = f"{r['wder']['wder']:.3f}" if "wder" in r else "  -  "
        ser = f"{r['ser']['ser']:.3f}" if "ser" in r else "  -  "
        lines.append(
            f"{r['name']:<24} {r['language']:<5} {r['ref_speakers']:>3} {r['hyp_speakers']:>3} "
            f"{d['collar0.25_overlap']['der']:>8.3f} {d['collar0.25_nooverlap']['der']:>8.3f} "
            f"{d['full_overlap']['der']:>8.3f} {d['full_nooverlap']['der']:>8.3f} "
            f"{wder:>6} {ser:>6} {r['count']['error']:>+5d}"
        )
    agg = report["aggregate"]
    lines.append("-" * 96)
    for lang, a in agg["by_language"].items():
        if not a:
            continue
        wder = f"{a.get('wder', 0):.3f}" if "wder" in a else "  -  "
        ser = f"{a.get('ser', 0):.3f}" if "ser" in a else "  -  "
        d = a["der"]
        lines.append(
            f"{'MEAN ['+lang+']':<24} {'':<5} {'':>3} {'':>3} "
            f"{d['collar0.25_overlap']:>8.3f} {d['collar0.25_nooverlap']:>8.3f} "
            f"{d['full_overlap']:>8.3f} {d['full_nooverlap']:>8.3f} "
            f"{wder:>6} {ser:>6} {a['count_error_mean']:>+5}"
        )
    return "\n".join(lines)


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Yulu diarization eval harness (Phase 11 gate).")
    ap.add_argument("--build-corpus", action="store_true",
                    help="build the constructed TTS corpus into --out (needs macOS say + ffmpeg)")
    ap.add_argument("--corpus", type=Path, help="load an already-built corpus from this dir")
    ap.add_argument("--out", type=Path, default=Path("/tmp/yulu-eval"),
                    help="output dir for --build-corpus and reports")
    ap.add_argument("--provider", choices=["sherpa", "funasr"],
                    help="run this provider to produce hypotheses (opt-in; needs deps+models)")
    ap.add_argument("--from-rttm", type=Path,
                    help="score pre-computed hypothesis RTTMs from this dir (no provider import)")
    ap.add_argument("--seg-model", help="sherpa segmentation .onnx (for --provider sherpa)")
    ap.add_argument("--emb-model", help="sherpa cam++ embedding .onnx (for --provider sherpa)")
    ap.add_argument("--funasr-model-dir", help="local FunASR model dir (for --provider funasr)")
    ap.add_argument("--num-speakers", type=int, default=None,
                    help="force the speaker count (default: auto threshold clustering)")
    ap.add_argument("--threshold", type=float, default=0.5, help="sherpa auto-clustering threshold")
    ap.add_argument("--cross-check", action="store_true",
                    help="also score with pyannote.metrics (eval venv only)")
    ap.add_argument("--json", type=Path, help="write the full report JSON here")
    args = ap.parse_args(argv)

    # 1. Get the corpus.
    if args.build_corpus:
        items = build_corpus(args.out)
        corpus_dir = args.out
    elif args.corpus:
        items = load_corpus(args.corpus)
        corpus_dir = args.corpus
    else:
        ap.error("need --build-corpus or --corpus")
        return 2

    hyp_dir = (corpus_dir / f"hyp_{args.provider}") if args.provider else args.from_rttm

    # 2. Produce / load hypotheses + score.
    per_recording: list[dict] = []
    for item in items:
        if args.from_rttm:
            hyp = load_rttm_one(args.from_rttm / f"{item.name}.rttm")
        elif args.provider == "sherpa":
            if not (args.seg_model and args.emb_model):
                ap.error("--provider sherpa needs --seg-model and --emb-model")
            hyp = run_provider_sherpa(
                item, seg_model=args.seg_model, emb_model=args.emb_model,
                num_speakers=args.num_speakers, threshold=args.threshold,
            )
            if hyp_dir:
                write_rttm(hyp_dir / f"{item.name}.rttm", hyp, file_id=item.name)
        elif args.provider == "funasr":
            hyp = run_provider_funasr(
                item, model_dir=args.funasr_model_dir, num_speakers=args.num_speakers
            )
            if hyp_dir:
                write_rttm(hyp_dir / f"{item.name}.rttm", hyp, file_id=item.name)
        else:
            ap.error("need --provider or --from-rttm to produce hypotheses")
            return 2

        scored = score_item(item, hyp)
        if args.cross_check:
            cc = pyannote_cross_check(item, hyp)
            if cc:
                scored["cross_check"] = cc
        per_recording.append(scored)

    report = {
        "corpus_dir": str(corpus_dir),
        "provider": args.provider or "from-rttm",
        "num_speakers_forced": args.num_speakers,
        "threshold": args.threshold,
        "per_recording": per_recording,
        "aggregate": aggregate(per_recording),
    }

    print(_format_table(report))
    if any("cross_check" in r for r in per_recording):
        print("\n=== pyannote.metrics cross-check (DER collar0.25 / full) ===")
        for r in per_recording:
            if "cross_check" in r:
                cc = r["cross_check"]
                print(f"  {r['name']:<24} pyannote={cc['pyannote_der_collar0.25']:.3f}/"
                      f"{cc['pyannote_der_full']:.3f}  ours="
                      f"{r['der']['collar0.25_overlap']['der']:.3f}/"
                      f"{r['der']['full_overlap']['der']:.3f}")
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\nwrote {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
