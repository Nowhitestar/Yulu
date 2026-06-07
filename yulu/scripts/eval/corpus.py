"""Reference-corpus builders — CONSTRUCTED ground truth (zero anchoring) + the human-gold path.

The hardest methodology trap in diarization eval is **anchoring bias** (PITFALLS §4): if the person
who builds the ground truth labels *from the system's own output*, the reference is anchored to the
system and the DER is inflated. The classic fix is "label from audio, blind to the tool." But this
harness is built autonomously — there is no human to listen and label.

So we sidestep listening entirely with a **constructed-ground-truth corpus**: we stitch
*known-single-speaker* audio segments into a multi-speaker timeline at offsets we choose. Because we
placed every turn, the RTTM is **exact by construction** — it is not derived from any diarizer's
output and required no listening, so there is *zero* anchoring bias. The construction is also a real
acoustic test: the stitched audio is genuine speech, so sherpa's VAD/segmentation and cam++ embedding
run for real and produce a real DER (not a toy).

Source of known-single-speaker audio (in priority order):

1. **macOS ``say`` TTS** — each system voice is, by definition, one distinct speaker. We render a
   distinct voice per "speaker", in both ``zh_CN`` and ``en``, giving CN + EN constructed cases.
   Deterministic, offline, no listening, no third-party assets. *(Primary — used by the harness.)*
2. **Dual-channel Yulu recordings** — the mic channel is a FREE known label (the local speaker
   "me"). ``stitch_known_segments`` accepts any list of (single-speaker wav, label) pairs, so a
   future builder can feed mic-channel slices here with the same exact-RTTM guarantee.

⚠ **Constructed ≠ real.** A constructed corpus validates the *harness* and gives a *real signal* on
synthetic-but-acoustic speech, but TTS voices are cleaner and more separable than real overlapping
human meetings. It is **NOT** a substitute for human-labelled real meetings, which remain the GOLD
standard. ``audacity_labels_to_rttm`` sets up that human path (label a real meeting in Audacity →
export labels → convert), and ``EVAL-01`` carries a ``human_needed`` follow-up to add 2-3 such
real CN+EN meetings later (see 11-SUMMARY.md).

Everything here is dev/eval-only — never imported by Yulu's runtime.
"""

from __future__ import annotations

import shutil
import struct
import subprocess
import tempfile
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .rttm import Timeline, Turn, write_rttm

SAMPLE_RATE = 16_000  # the sherpa/whisper working rate


# ── a turn spec: which voice says what (content is irrelevant — identity is the voice) ──


@dataclass(frozen=True)
class UtteranceSpec:
    """One scripted utterance: ``voice`` (a macOS ``say`` voice = a known speaker) says ``text``.

    ``speaker`` is the ground-truth label that lands in the RTTM. Multiple specs can share a
    ``voice``/``speaker`` (the same person talking again at a later offset).
    """

    voice: str
    speaker: str
    text: str


@dataclass
class ConstructedCase:
    """A built corpus case: the stitched wav + its exact reference Timeline + the gap layout."""

    name: str
    language: str                  # "cn" | "en"
    wav_path: Path
    reference: Timeline
    num_speakers: int
    duration_s: float
    asr_segments: list[dict] = field(default_factory=list)  # one per utterance (text + timing)


# ── scripted scenarios (CN + EN, distinct voices = distinct true speakers) ──────
#
# Voices are chosen to be acoustically distinct (different apparent pitch/timbre) so the
# construction exercises clustering rather than trivially failing the embedding step. The *content*
# is deliberately meeting-like (decisions, action items) so a downstream summary spot-check on the
# same audio is meaningful, but the words never define identity — the voice does.

# Default CN voices (verified present on macOS 13+: Tingting + the newer named zh_CN set).
CN_VOICES = ["Tingting", "Sinji", "Meijia"]
# Fallbacks if the premium named voices aren't installed (Tingting is the long-standing default).
CN_VOICE_FALLBACKS = ["Tingting", "Eddy (中文（中国大陆）)", "Flo (中文（中国大陆）)",
                      "Reed (中文（中国大陆）)", "Sandy (中文（中国大陆）)"]
EN_VOICES = ["Samantha", "Daniel", "Fred"]
EN_VOICE_FALLBACKS = ["Samantha", "Daniel", "Fred", "Alex", "Karen", "Moira", "Tom"]


def _cn_script(voices: list[str]) -> list[UtteranceSpec]:
    a, b, c = (voices + voices)[:3]
    return [
        UtteranceSpec(a, "spk-0", "我觉得这个功能下周评审完就可以上线了。"),
        UtteranceSpec(b, "spk-1", "可以，但是上线之前测试覆盖率得再高一点。"),
        UtteranceSpec(c, "spk-2", "那补集成测试这个事情我来负责吧。"),
        UtteranceSpec(a, "spk-0", "好，顺便把回滚方案也写进运行手册里。"),
        UtteranceSpec(b, "spk-1", "同意，跨平台验证这一块这个周期我来跟。"),
        UtteranceSpec(c, "spk-2", "没问题，我明天上午跟团队同步一下进度。"),
    ]


def _en_script(voices: list[str]) -> list[UtteranceSpec]:
    a, b, c = (voices + voices)[:3]
    return [
        UtteranceSpec(a, "spk-0", "I think we should ship the feature next week after review."),
        UtteranceSpec(b, "spk-1", "Right, but the test coverage needs to be higher before that."),
        UtteranceSpec(c, "spk-2", "I can take the action item to add the missing integration tests."),
        UtteranceSpec(a, "spk-0", "Great, let us also document the rollback plan in the runbook."),
        UtteranceSpec(b, "spk-1", "Agreed, I will own the cross platform verification this cycle."),
        UtteranceSpec(c, "spk-2", "Sounds good to me, I will sync with the team tomorrow morning."),
    ]


# ── TTS rendering (macOS `say` → 16 kHz mono wav) ───────────────────────────────


def say_available() -> bool:
    return shutil.which("say") is not None


def _audio_converter() -> Optional[list[str]]:
    """Return an argv-prefix that converts ``in -> out`` to 16k mono wav, or None if none found.

    Prefers ffmpeg (in the documented brew deps); falls back to sox. ``say`` itself can emit WAVE
    but the sample rate/encoding is voice-dependent, so we normalize through one of these.
    """
    if shutil.which("ffmpeg"):
        return ["ffmpeg"]
    if shutil.which("sox"):
        return ["sox"]
    return None


def _render_voice(voice: str, text: str, out_wav: Path) -> None:
    """Render one utterance with ``say`` and normalize to 16 kHz mono PCM wav at ``out_wav``."""
    conv = _audio_converter()
    if conv is None:
        raise RuntimeError("need ffmpeg or sox to normalize `say` output to 16k mono wav")
    aiff = Path(tempfile.mktemp(suffix=".aiff"))
    try:
        subprocess.run(["say", "-v", voice, "-o", str(aiff), text], check=True,
                       capture_output=True)
        if conv[0] == "ffmpeg":
            subprocess.run(
                ["ffmpeg", "-y", "-i", str(aiff), "-ar", str(SAMPLE_RATE), "-ac", "1",
                 str(out_wav)],
                check=True, capture_output=True,
            )
        else:  # sox
            subprocess.run(
                ["sox", str(aiff), "-r", str(SAMPLE_RATE), "-c", "1", str(out_wav)],
                check=True, capture_output=True,
            )
    finally:
        aiff.unlink(missing_ok=True)


def _read_wav_frames(path: Path) -> tuple[bytes, int, int, int]:
    with wave.open(str(path), "rb") as w:
        return (w.readframes(w.getnframes()), w.getframerate(),
                w.getsampwidth(), w.getnchannels())


def _silence_frames(seconds: float, sampwidth: int, nchannels: int, rate: int) -> bytes:
    n = int(round(seconds * rate)) * nchannels
    return b"\x00" * (n * sampwidth)


# ── the core stitcher: known single-speaker clips → multi-speaker wav + exact RTTM ──


def stitch_known_segments(
    clips: list[tuple[Path, str, str]],
    *,
    out_wav: Path,
    file_id: str,
    gap_s: float = 0.4,
    lead_silence_s: float = 0.3,
) -> tuple[Timeline, list[dict], float]:
    """Concatenate known-single-speaker clips into one wav; return the EXACT reference Timeline.

    Args:
        clips: ``[(wav_path, speaker_label, text)]`` — each wav is ONE known speaker (TTS voice or
               a dual-channel mic slice). ``speaker_label`` is the ground-truth id; ``text`` feeds
               the WDER/SER word counts (it is the true transcript of that clip).
        gap_s: silence inserted between clips (models inter-turn pauses; also where Whisper would
               hallucinate — left unlabeled in the reference by construction).
        lead_silence_s: silence prepended (recordings start with dead air — the hallucination zone).

    Returns ``(reference_timeline, asr_segments, duration_s)``. The reference is exact: each clip
    occupies ``[offset, offset+clip_dur)`` with its known label — nothing is inferred or listened to.
    """
    if not clips:
        raise ValueError("no clips to stitch")
    # Read the first clip to fix the PCM format; all `say`+ffmpeg outputs share it (16k/mono/16-bit).
    _, rate, sampwidth, nch = _read_wav_frames(clips[0][0])
    pcm = bytearray()
    turns: list[Turn] = []
    asr: list[dict] = []

    t = 0.0
    if lead_silence_s > 0:
        pcm += _silence_frames(lead_silence_s, sampwidth, nch, rate)
        t += lead_silence_s

    for wav_path, label, text in clips:
        frames, r, sw, c = _read_wav_frames(wav_path)
        if (r, sw, c) != (rate, sampwidth, nch):
            raise ValueError(f"clip format mismatch: {wav_path} is {(r, sw, c)} != {(rate, sampwidth, nch)}")
        clip_dur = (len(frames) // (sampwidth * nch)) / rate
        start = t
        end = t + clip_dur
        pcm += frames
        turns.append(Turn(round(start, 3), round(end, 3), label))
        asr.append({"start": round(start, 3), "end": round(end, 3), "text": text})
        t = end
        if gap_s > 0:
            pcm += _silence_frames(gap_s, sampwidth, nch, rate)
            t += gap_s

    out_wav.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out_wav), "wb") as w:
        w.setnchannels(nch)
        w.setsampwidth(sampwidth)
        w.setframerate(rate)
        w.writeframes(bytes(pcm))

    return Timeline(turns, file_id), asr, round(t, 3)


def build_tts_case(
    *,
    name: str,
    language: str,
    script: list[UtteranceSpec],
    out_dir: Path,
    gap_s: float = 0.4,
) -> ConstructedCase:
    """Render a scripted scenario with ``say`` and stitch it → a ``ConstructedCase`` with exact RTTM.

    Writes ``<out_dir>/audio/<name>.wav`` and ``<out_dir>/ref/<name>.rttm``.
    """
    if not say_available():
        raise RuntimeError("macOS `say` not available — cannot build the TTS constructed corpus")
    audio_dir = out_dir / "audio"
    ref_dir = out_dir / "ref"
    audio_dir.mkdir(parents=True, exist_ok=True)
    ref_dir.mkdir(parents=True, exist_ok=True)

    clips: list[tuple[Path, str, str]] = []
    tmpdir = Path(tempfile.mkdtemp(prefix=f"yulu-eval-{name}-"))
    try:
        for i, spec in enumerate(script):
            clip_path = tmpdir / f"{i:02d}.wav"
            _render_voice(spec.voice, spec.text, clip_path)
            clips.append((clip_path, spec.speaker, spec.text))
        wav_path = audio_dir / f"{name}.wav"
        ref, asr, dur = stitch_known_segments(
            clips, out_wav=wav_path, file_id=name, gap_s=gap_s
        )
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)

    write_rttm(ref_dir / f"{name}.rttm", ref, file_id=name)
    return ConstructedCase(
        name=name,
        language=language,
        wav_path=wav_path,
        reference=ref,
        num_speakers=ref.num_speakers(),
        duration_s=dur,
        asr_segments=asr,
    )


def _resolve_voices(preferred: list[str], fallbacks: list[str], n: int = 3) -> list[str]:
    """Pick ``n`` installed voices, preferring the named premium set, then fallbacks."""
    installed = _installed_voices()
    chosen: list[str] = []
    for v in preferred + fallbacks:
        base = v.split(" (")[0]
        if (v in installed or base in installed) and base not in [c.split(" (")[0] for c in chosen]:
            chosen.append(v if v in installed else base)
        if len(chosen) >= n:
            break
    if len(chosen) < n:
        raise RuntimeError(f"need {n} distinct voices, found only {chosen} (installed sample: "
                           f"{sorted(installed)[:10]})")
    return chosen[:n]


def _installed_voices() -> set[str]:
    try:
        out = subprocess.run(["say", "-v", "?"], check=True, capture_output=True, text=True).stdout
    except Exception:
        return set()
    names: set[str] = set()
    for line in out.splitlines():
        # "Tingting            zh_CN    # ..."  → name is everything before the 2-space gap.
        if not line.strip():
            continue
        name = line.split("  ")[0].strip()
        if name:
            names.add(name)
            names.add(name.split(" (")[0])
    return names


def build_default_corpus(out_dir: Path, *, gap_s: float = 0.4) -> list[ConstructedCase]:
    """Build the standard CN + EN constructed cases (the fixed corpus the harness regresses on)."""
    cn_voices = _resolve_voices(CN_VOICES, CN_VOICE_FALLBACKS, 3)
    en_voices = _resolve_voices(EN_VOICES, EN_VOICE_FALLBACKS, 3)
    cases = [
        build_tts_case(name="constructed_cn_3spk", language="cn",
                       script=_cn_script(cn_voices), out_dir=out_dir, gap_s=gap_s),
        build_tts_case(name="constructed_en_3spk", language="en",
                       script=_en_script(en_voices), out_dir=out_dir, gap_s=gap_s),
    ]
    return cases


# ── the human-gold path: Audacity label track → RTTM (STACK.md recommended workflow) ──


def audacity_labels_to_rttm(label_text: str, file_id: str) -> Timeline:
    """Convert an Audacity *exported label track* (tab-separated ``start\\tend\\tlabel``) → Timeline.

    This is the GOLD-standard human path (STACK.md): open the real meeting ``.wav`` in Audacity,
    add a Label Track, mark each speaker turn (label text = speaker id), File → Export → Export
    Labels, then run the result through here. Lines are ``<start>\\t<end>\\t<speaker>``; a 4th
    frequency column (point labels) is tolerated and ignored.

    Used for the ``human_needed`` follow-up: add 2-3 hand-labelled real CN+EN meetings as the true
    gold reference. Pure parsing — no audio, no dependency.
    """
    turns: list[Turn] = []
    for raw in label_text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            # Tolerate whitespace-separated exports too.
            parts = line.split()
        if len(parts) < 3:
            continue
        try:
            start = float(parts[0])
            end = float(parts[1])
        except ValueError:
            continue
        speaker = parts[2].strip()
        if end > start and speaker:
            turns.append(Turn(start, end, speaker))
    return Timeline(turns, file_id)


def audacity_label_file_to_rttm(label_path: str | Path, out_rttm: str | Path,
                                file_id: Optional[str] = None) -> Path:
    """Read an Audacity labels file → write an RTTM. Convenience wrapper for the human-gold path."""
    label_path = Path(label_path)
    fid = file_id or label_path.stem
    tl = audacity_labels_to_rttm(label_path.read_text(encoding="utf-8"), fid)
    return write_rttm(out_rttm, tl, file_id=fid)
