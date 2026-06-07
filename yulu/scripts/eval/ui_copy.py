"""Honest speaker-accuracy UI copy — sourced from the MEASURED DER, not feel (EVAL-04).

This is the backend home for the speaker-label accuracy strings the future Phase-14 UI will
consume. It lives here (not in ``yulu_ui/``, which is gated this milestone) so the *number* and the
*framing* are owned next to the eval that produced them: when the corpus or provider changes, you
re-run ``eval.harness``, update ``MEASURED`` below, and the UI copy follows automatically.

Why copy is a Phase-11 deliverable (PITFALLS §12 — "over-promising accuracy"): diarization output
*looks* authoritative (clean "Alice:" prefixes), but the measured reality is uneven — English lands
near-perfect on clean speech while Chinese is materially worse and the speaker *count* is unstable
(PITFALLS §2). If the UI presents labels with the same authority as the transcript words, users
trust labels they shouldn't and lose trust in the whole feature on the first visible error. The
honest stance — "labels are a helpful, correctable hint; expect to fix some" — is what preserves
trust, and it must be sourced from the eval number, not marketing.

These are *defaults*. Phase 14 may translate / restyle them, but the substance (hint, not fact;
per-meeting; correctable) and the measured figure are fixed here.

Measured on the Phase-11 CONSTRUCTED corpus (macOS-TTS, zero anchoring bias) with the default
sherpa-onnx provider — see ``.planning/phases/11-der-wder-eval-harness/11-SUMMARY.md`` and the
provider ADR. ⚠ Constructed-corpus numbers validate the harness and give a real signal on clean
synthetic speech; they are NOT a substitute for human-labelled real meetings (the ``human_needed``
gold follow-up). Treat the figures as an order-of-magnitude expectation, not a guarantee.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MeasuredAccuracy:
    """The measured DER context that sources the copy. Updated when the eval is re-run."""

    #: Provider these numbers describe.
    provider: str
    #: Corpus the numbers came from (constructed vs human-gold) — stated so copy can be honest.
    corpus: str
    #: English DER (collar 0.25, overlap scored) on the constructed corpus — the clean best case.
    en_der_collar: float
    #: Chinese DER (collar 0.25, overlap scored) — materially worse; the known CN weakness.
    cn_der_collar: float
    #: Whether the speaker *count* was stable vs truth on the corpus (False ⇒ warn about count).
    count_stable: bool

    @property
    def en_accuracy_pct(self) -> int:
        """Rough EN 'speech correctly attributed' percentage = 100*(1 - DER), floored at 0."""
        return max(0, round((1.0 - self.en_der_collar) * 100))


#: The current measured snapshot (Phase 11, constructed corpus, default provider).
#: EN DER 0.007 collar / CN DER 0.682 collar; CN count under-merged 3→1 (count NOT stable).
MEASURED = MeasuredAccuracy(
    provider="sherpa-onnx",
    corpus="constructed (macOS-TTS, zero-anchoring; not yet human-gold)",
    en_der_collar=0.007,
    cn_der_collar=0.682,
    count_stable=False,
)


# ── the string set the UI consumes ──────────────────────────────────────────────
#
# Keyed, short, and substance-fixed. Phase 14 picks these up (and may localize). Each string is a
# *hint* about labels, never a claim of correctness.

#: Primary, always-visible framing under the speaker-labelled transcript.
LABELS_ARE_A_HINT = (
    "Speaker labels are an automatic best guess — a helpful starting point, not a fact. "
    "Expect to correct some, especially in Chinese meetings and where people talk over each other."
)

#: Shown near a rename/merge affordance — sets up that correction is expected, not a failure.
CORRECTION_IS_EXPECTED = (
    "Rename a speaker once and it applies everywhere; merge two labels if the same person was "
    "split. Your edits are saved and survive re-processing."
)

#: Per-meeting identity caveat (PITFALLS §9 — yesterday's 'Alice' is today's 'Speaker 2').
PER_MEETING_LABELS = (
    "Speakers are detected per meeting, so the same name is not carried across recordings."
)

#: Attached to a low-confidence segment (the ``confident=False`` flag from speaker_merge).
LOW_CONFIDENCE_SEGMENT = (
    "This line's speaker is uncertain — please double-check it."
)

#: Warn when the detected speaker count looks unreliable (the CN over-split / under-merge case).
COUNT_UNRELIABLE = (
    "The number of speakers detected here may be off — you can merge or split speakers to fix it."
)


def accuracy_blurb(measured: MeasuredAccuracy = MEASURED) -> str:
    """A one-line, measurement-grounded expectation string for a settings/help surface.

    Deliberately frames English and Chinese asymmetrically because the eval shows they differ by an
    order of magnitude — honest beats flattering.
    """
    en = measured.en_accuracy_pct
    base = (
        f"Speaker labels are a best guess. On clear English audio they are usually accurate "
        f"(~{en}% of speech attributed correctly in testing); on Chinese audio they are notably "
        f"less reliable and the number of speakers may be wrong."
    )
    if not measured.count_stable:
        base += " Treat them as a correctable hint and fix any that look wrong."
    return base


def all_strings(measured: MeasuredAccuracy = MEASURED) -> dict[str, str]:
    """The full keyed string set, for the UI to import as one object (and for tests to assert on)."""
    return {
        "labels_are_a_hint": LABELS_ARE_A_HINT,
        "correction_is_expected": CORRECTION_IS_EXPECTED,
        "per_meeting_labels": PER_MEETING_LABELS,
        "low_confidence_segment": LOW_CONFIDENCE_SEGMENT,
        "count_unreliable": COUNT_UNRELIABLE,
        "accuracy_blurb": accuracy_blurb(measured),
    }
