#!/usr/bin/env python3
"""FunASR cam++ diarization spike harness.

Runs paraformer-zh + fsmn-vad + ct-punc + cam++ over an audio file on a chosen
device and emits a single structured JSON line (prefix SPIKE_RESULT_JSON) with
wall-clock timing, RTF, speaker stats, a sample of sentence_info, and — critically —
the ACTUAL torch device each sub-model's weights ended up on (to detect silent
CPU fallback when device=mps is requested).

Throwaway spike code. Not part of Yulu. Run with the spike venv:
  ~/funasr-spike/venv/bin/python spike_run.py --input <wav> --device cpu|mps [--no-spk] [--disable-update] [--dump out.json]
"""
import argparse, json, os, sys, time, traceback, wave


def wav_seconds(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def dev_of(m):
    """Best-effort: which torch device does this sub-model's first parameter live on?"""
    if m is None:
        return None
    try:
        p = next(m.parameters())
        return str(p.device)
    except StopIteration:
        return "no-params"
    except Exception as e:
        return f"n/a({type(e).__name__})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--device", default="cpu", help="cpu | mps | cuda")
    ap.add_argument("--hub", default="ms", help="ms (modelscope) | hf (huggingface)")
    ap.add_argument("--disable-update", action="store_true")
    ap.add_argument("--no-spk", action="store_true", help="omit cam++ to isolate diarization cost")
    ap.add_argument("--batch-size-s", type=int, default=300)
    ap.add_argument("--tag", default="")
    ap.add_argument("--dump", default="", help="dump full {text, sentence_info} to this json path")
    args = ap.parse_args()

    result = {
        "tag": args.tag,
        "device_requested": args.device,
        "hub": args.hub,
        "no_spk": args.no_spk,
        "disable_update": args.disable_update,
        "input": os.path.basename(args.input),
        "mps_fallback_env": os.environ.get("PYTORCH_ENABLE_MPS_FALLBACK"),
        "ok": False,
    }

    try:
        import torch  # noqa
        from funasr import AutoModel

        result["torch_version"] = torch.__version__
        result["mps_available"] = bool(torch.backends.mps.is_available())
        result["mps_built"] = bool(torch.backends.mps.is_built())

        try:
            result["audio_seconds"] = round(wav_seconds(args.input), 1)
        except Exception:
            result["audio_seconds"] = None

        kw = dict(
            model="paraformer-zh",
            vad_model="fsmn-vad",
            punc_model="ct-punc",
            device=args.device,
            hub=args.hub,
        )
        if not args.no_spk:
            kw["spk_model"] = "cam++"
        if args.disable_update:
            kw["disable_update"] = True

        t0 = time.time()
        model = AutoModel(**kw)
        result["load_seconds"] = round(time.time() - t0, 1)

        # Where did each sub-model actually land?
        result["actual_device"] = {
            "asr": dev_of(getattr(model, "model", None)),
            "vad": dev_of(getattr(model, "vad_model", None)),
            "punc": dev_of(getattr(model, "punc_model", None)),
            "spk": dev_of(getattr(model, "spk_model", None)),
        }

        t1 = time.time()
        res = model.generate(input=args.input, batch_size_s=args.batch_size_s)
        gen = time.time() - t1
        result["generate_seconds"] = round(gen, 1)

        r0 = res[0] if res else {}
        text = r0.get("text", "")
        si = r0.get("sentence_info", []) or []
        spks = sorted({s.get("spk") for s in si if "spk" in s})

        dur = result.get("audio_seconds") or 0
        result.update({
            "rtf": round(gen / dur, 4) if dur else None,             # <1 = faster than realtime
            "speed_x_realtime": round(dur / gen, 2) if gen else None,
            "num_sentences": len(si),
            "num_speakers": len(spks),
            "speaker_ids": spks,
            "text_chars": len(text),
            "text_head": text[:200],
            "sentence_info_keys": sorted(si[0].keys()) if si else [],
            "sample_sentences": [
                {k: v for k, v in s.items() if k in ("spk", "start", "end", "text")}
                for s in si[:8]
            ],
            "ok": True,
        })

        if args.dump:
            with open(args.dump, "w") as f:
                json.dump({"text": text, "sentence_info": si}, f, ensure_ascii=False, indent=2)
            result["dumped_to"] = args.dump

    except Exception as e:
        result["error_type"] = type(e).__name__
        result["error"] = str(e)[:500]
        result["traceback_tail"] = "".join(traceback.format_exc()).splitlines()[-6:]

    print("SPIKE_RESULT_JSON " + json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    main()
