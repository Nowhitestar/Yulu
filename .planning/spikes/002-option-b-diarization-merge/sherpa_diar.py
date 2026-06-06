#!/usr/bin/env python3
"""sherpa-onnx offline speaker diarization (ONNX, no torch) — option-B path for Yulu.
Pyannote-3.0 segmentation + 3D-Speaker cam++ embedding + fast clustering.
Emits SHERPA_DIAR_JSON (timing/RTF/#speakers) and dumps speaker time-segments to JSON.

Usage: venv-sherpa/bin/python sherpa_diar.py <wav> <out_segments.json> [num_speakers|-1]
"""
import json, sys, time
import numpy as np
import soundfile as sf
import sherpa_onnx

SEG = f"{sys.argv[0].rsplit('/',1)[0]}/../../../../funasr-spike/sherpa-models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
EMB = f"{sys.argv[0].rsplit('/',1)[0]}/../../../../funasr-spike/sherpa-models/campplus.onnx"
import os
SEG = os.path.expanduser("~/funasr-spike/sherpa-models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx")
EMB = os.path.expanduser("~/funasr-spike/sherpa-models/campplus.onnx")

wav = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else "sherpa_diar_segments.json"
num_speakers = int(sys.argv[3]) if len(sys.argv) > 3 else -1   # -1/0 = auto (threshold)
threshold = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5    # used only in auto mode

cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
    segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=SEG)),
    embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=EMB),
    clustering=sherpa_onnx.FastClusteringConfig(num_clusters=num_speakers, threshold=threshold),
    min_duration_on=0.3,
    min_duration_off=0.5,
)
sd = sherpa_onnx.OfflineSpeakerDiarization(cfg)

audio, sr = sf.read(wav, dtype="float32", always_2d=False)
if audio.ndim > 1:
    audio = audio[:, 0]
if sr != sd.sample_rate:
    # simple linear resample to the model rate
    tgt = sd.sample_rate
    x = np.linspace(0, len(audio), int(len(audio) * tgt / sr), endpoint=False)
    audio = np.interp(x, np.arange(len(audio)), audio).astype("float32")
    sr = tgt
dur = len(audio) / sr

t0 = time.time()
result = sd.process(audio).sort_by_start_time()
gen = time.time() - t0

segs = [{"start": round(r.start, 3), "end": round(r.end, 3), "spk": r.speaker} for r in result]
spks = sorted({s["spk"] for s in segs})
json.dump(segs, open(out, "w"), ensure_ascii=False)
print("SHERPA_DIAR_JSON " + json.dumps({
    "wav": wav.rsplit("/", 1)[-1], "audio_s": round(dur, 1), "gen_s": round(gen, 1),
    "rtf": round(gen / dur, 4) if dur else None, "speed_x": round(dur / gen, 2) if gen else None,
    "num_speakers": len(spks), "num_segments": len(segs), "out": out,
}, ensure_ascii=False))
