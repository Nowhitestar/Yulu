"""Speaker-count strategy — the over-split fix (COUNT-01..03).

sherpa-onnx auto speaker-count is brittle: on real CN meetings it *over-splits*
(spike 002: 59→32→20 phantom speakers as the threshold rises, never near the true ~5); on the
constructed-TTS eval corpus the *same* brittleness shows up as the opposite failure — it collapses
3 acoustically-similar Mandarin voices to 1 (Phase-11 CN auto-DER 0.682). Either way, **raw auto
clustering is not trustworthy**, and the single knob that reliably moves the count toward truth is a
**supplied count** — which Yulu already has for free: the calendar attendee count (via ``gog``).

This module is the **deliberate count-strategy ladder** that decides, per meeting, how the diarizer
should be configured BEFORE it clusters. It is pure logic (no sherpa, no I/O, no daemon) so it is
unit-testable in CI and reusable by both the live pipeline (Phase 13) and the eval harness.

The ladder (PITFALLS §2 "fallback ladder"; ROADMAP Phase-12 success criteria 1-3):

  1. **Supplied count wins** (criterion 1). When a calendar event carries an attendee count, use it
     as the hard ``num_clusters`` — the empirically reliable lever (eval: CN DER 0.682→0.505, count
     -2→+0). This is the path Phase 13 feeds and the lever the milestone leans on.
  2. **Calibrated threshold** (criterion 2) when no count is supplied. We sweep the eval corpus to
     pick the default rather than trusting the library default. The chosen value is EN-optimal AND
     the best available CN value (CN is flat across thresholds on the constructed corpus — see
     ``CALIBRATED_THRESHOLD`` note), and a language hint reserves a seam for a future CN-specific
     value if a real CN gold corpus ever proves one helps.
  3. **Fail toward UNDER-merge** (criterion 3). A supplied count is *clamped* to a conservative
     ceiling and never blown up by a noisy prior: an attendee list of 30 on a 25-minute call does
     not become 30 clusters. When the count is uncertain we bias DOWN (fewer speakers, recoverable
     by a user *merge/split*) rather than UP (many phantom speakers, the catastrophic over-split).

Two ways to use the prior (and why "reconcile" is the default for criterion 4)
-----------------------------------------------------------------------------
Forcing a supplied count is the reliable CN lever, but the eval surfaced a sharp caveat: forcing a
count that sherpa's *auto* mode would already get right slightly REGRESSES it (sherpa's forced-count
clustering path differs from its auto path — EN DER 0.007→0.318 when we forced the already-correct
count of 3). Criterion 4 ("fixing CN must not regress EN") makes that unacceptable. So the strategy
exposes two modes:

* :func:`resolve_speaker_count` — the *one-pass* decision (prior → config). Forces the prior
  whenever one exists. Simple; use when you trust the prior unconditionally (e.g. an operator pin).
* :func:`reconcile_count` — the *two-pass* decision (criterion 4 default). Run auto first, observe
  sherpa's auto count, then force the calendar prior ONLY when auto *disagrees* with it (auto is
  clearly wrong — the over-split/under-merge case). When auto already agrees with the prior, keep
  auto untouched. Verified on the eval: CN auto=1 vs prior=3 → force 3 (DER 0.682→0.505, count
  fixed); EN auto=3 vs prior=3 → keep auto (DER 0.007 preserved — NO regression).

Phase-13 interface (how the pipeline passes the calendar count)
---------------------------------------------------------------
Phase 13 resolves the recording's calendar event (the ``meeting_id`` already threaded through
``meeting_daemon.py`` / ``schedule.json``; ``check_meetings.py`` returns each event's ``attendees``
list), counts the attendees, and runs the **reconcile** two-pass flow::

    from stt_daemon.speaker_count import resolve_speaker_count, reconcile_count

    attendee_count = len(event["attendees"]) or None        # None when unknown
    initial = resolve_speaker_count(                          # what to try on pass 1
        attendee_count=attendee_count, language=lang,
        config_num_speakers=cfg.diarize_num_speakers,
        config_threshold=cfg.diarize_threshold,
    )
    if initial.source == "config":                           # operator pin → one pass, done
        turns = await diar.diarize(audio_path=wav, num_speakers=initial.num_clusters,
                                   threshold=initial.threshold, cancel_token=token)
    else:                                                     # auto-first, then reconcile
        turns = await diar.diarize(audio_path=wav, num_speakers=None,
                                   threshold=initial.threshold, cancel_token=token)
        auto_count = len({t.speaker_idx for t in turns})
        final = reconcile_count(auto_count=auto_count, attendee_count=attendee_count,
                                language=lang, config_threshold=cfg.diarize_threshold)
        if final.num_clusters is not None and final.num_clusters != auto_count:
            turns = await diar.diarize(audio_path=wav, num_speakers=final.num_clusters,
                                       threshold=final.threshold, cancel_token=token)

The two ``diarize`` calls are served by the backend's count-keyed pipeline cache, so the override
pass can never bleed into the auto pass (Phase-12 carry-forward fix). Nothing here touches sherpa or
the network — both are pure decision functions.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

# ── Calibrated constants (derived empirically — see 12-SUMMARY.md DER table) ─────
#
# CALIBRATED_THRESHOLD: the auto-clustering threshold used when NO count is supplied.
#   In sherpa's FastClustering path, lower thresholds are more sensitive and can over-split real
#   Yulu meetings into many phantom speakers. A local real-meeting scan produced
#   20→12→7→6→4 speakers at thresholds 0.2→0.3→0.4→0.5→0.6, so 0.6 is the conservative default:
#   fewer false speakers while avoiding the more aggressive 0.7/0.8 merge setting. The reliable
#   Chinese lever is still a supplied count when available; this default only tunes the no-count
#   auto path.
CALIBRATED_THRESHOLD = 0.6

# CN_THRESHOLD: reserved language-specific override seam. Set EQUAL to the calibrated default today
#   because the available real-world sample supports the same less-sensitive auto default. Kept as a
#   distinct, language-keyed constant so a future real-CN gold corpus can tune it in one place.
CN_THRESHOLD = 0.6

# MAX_AUTO_SPEAKERS: the conservative ceiling that enforces fail-toward-under-merge (criterion 3).
#   A supplied attendee count is clamped to this so a 30-person invite (most of whom never speak)
#   can't drive 30 phantom clusters. Real Yulu meetings are small; an over-large prior is far more
#   likely wrong (a big invite, a recurring all-hands) than a genuine 12-way conversation, and the
#   recoverable failure is under-merge (user merges two labels), never a 30-speaker wall.
MAX_AUTO_SPEAKERS = 8

# MIN_SPEAKERS: a supplied count below this is meaningless for diarization (0/1 ⇒ "don't cluster",
#   i.e. fall back to auto). 1 attendee = no diarization needed; auto handles the single-speaker case.
MIN_SPEAKERS = 2

# RECONCILE_TOLERANCE: in the two-pass reconcile flow, how far sherpa's auto count may differ from
#   the calendar prior before we override it. 0 = override on ANY disagreement (the eval-validated
#   default: it fixes CN auto=1-vs-prior=3 and leaves EN auto=3-vs-prior=3 untouched). A larger
#   tolerance trusts auto more (only override on a gross mismatch) — kept tunable for a future real
#   corpus, but 0 is correct on the evidence we have (auto is either right or badly wrong, not
#   off-by-one, on the constructed corpus).
RECONCILE_TOLERANCE = 0


# ── Where a count came from (provenance — feeds honest UI/log copy in Phase 13/14) ──

SOURCE_CONFIG = "config"          # explicit transcription.diarization.num_speakers (operator pin)
SOURCE_CALENDAR = "calendar"      # derived from the calendar attendee count (the free prior)
SOURCE_CALENDAR_CLAMPED = "calendar_clamped"  # calendar count, clamped down to MAX_AUTO_SPEAKERS
SOURCE_AUTO = "auto"              # no usable count → calibrated-threshold auto clustering
SOURCE_AUTO_AGREED = "auto_agreed"  # reconcile: auto count already matched the prior → kept auto


@dataclass(frozen=True)
class SpeakerCountStrategy:
    """The decided diarizer configuration for one meeting.

    ``num_clusters`` is the hard speaker count to force (``None`` ⇒ auto threshold-based
    clustering). ``threshold`` is the auto-mode clustering threshold, only consulted when
    ``num_clusters is None``. ``source`` records where the decision came from (for honest copy /
    logs). ``attendee_count`` echoes the raw prior (pre-clamp) for transparency.
    """

    num_clusters: Optional[int]
    threshold: float
    source: str
    attendee_count: Optional[int] = None

    @property
    def is_supplied(self) -> bool:
        """True when a concrete count was chosen (config or calendar) vs auto clustering."""
        return self.num_clusters is not None

    def as_dict(self) -> dict:
        return {
            "num_clusters": self.num_clusters,
            "threshold": self.threshold,
            "source": self.source,
            "attendee_count": self.attendee_count,
        }


def calibrated_threshold(language: Optional[str]) -> float:
    """The auto-mode clustering threshold for ``language`` (criterion 2).

    Language-keyed so a future CN-specific value lives in one place; today CN == default.
    """
    if _is_chinese(language):
        return CN_THRESHOLD
    return CALIBRATED_THRESHOLD


def resolve_speaker_count(
    *,
    attendee_count: Optional[int] = None,
    language: Optional[str] = None,
    config_num_speakers: Optional[int] = None,
    config_threshold: Optional[float] = None,
    max_speakers: int = MAX_AUTO_SPEAKERS,
) -> SpeakerCountStrategy:
    """Decide the diarizer configuration for one meeting (the COUNT-01..03 ladder).

    Args:
        attendee_count: speaker-count prior from the calendar event (``len(attendees)``), or
            ``None`` when no event/attendee list is available. The free calendar prior (COUNT-01).
        language: transcription language hint (``"zh"`` / ``"en"`` / ``None``) — selects the
            calibrated auto threshold (COUNT-02). Does NOT change a supplied count.
        config_num_speakers: an explicit operator pin (``transcription.diarization.num_speakers``).
            When set (> 0) it WINS over everything — the operator asked for exactly this many.
        config_threshold: the configured auto threshold; overrides the calibrated default when set.
        max_speakers: the under-merge ceiling (criterion 3); a larger prior is clamped down to it.

    Precedence (highest first):
        1. ``config_num_speakers`` (explicit operator pin) — ``source=config``.
        2. ``attendee_count`` (calendar prior), clamped to ``[MIN_SPEAKERS, max_speakers]`` —
           ``source=calendar`` (or ``calendar_clamped`` when the clamp bit). A prior < MIN_SPEAKERS
           is treated as "no usable count" and falls through to auto.
        3. Auto threshold-based clustering at the calibrated (language-aware) threshold —
           ``source=auto``.

    Returns a :class:`SpeakerCountStrategy`. Pure function — no I/O, no sherpa, deterministic.
    """
    threshold = (
        config_threshold
        if (config_threshold is not None and config_threshold > 0)
        else calibrated_threshold(language)
    )

    # 1. Explicit operator pin wins outright (still clamped UP-only for sanity, never below 2).
    if config_num_speakers is not None and config_num_speakers > 0:
        n = max(MIN_SPEAKERS, int(config_num_speakers)) if config_num_speakers >= MIN_SPEAKERS \
            else int(config_num_speakers)
        # An operator who pins 1 means "single speaker / effectively no clustering" — honor it as a
        # supplied count of 1 (the backend treats <=0 as auto, but 1 is a legitimate explicit pin).
        return SpeakerCountStrategy(
            num_clusters=n, threshold=threshold,
            source=SOURCE_CONFIG, attendee_count=attendee_count,
        )

    # 2. Calendar attendee prior (the free count — COUNT-01), biased toward under-merge (COUNT-03).
    if attendee_count is not None and attendee_count >= MIN_SPEAKERS:
        clamped = min(int(attendee_count), int(max_speakers))
        source = SOURCE_CALENDAR_CLAMPED if clamped != attendee_count else SOURCE_CALENDAR
        return SpeakerCountStrategy(
            num_clusters=clamped, threshold=threshold,
            source=source, attendee_count=attendee_count,
        )

    # 3. No usable count → auto clustering at the calibrated threshold (COUNT-02).
    return SpeakerCountStrategy(
        num_clusters=None, threshold=threshold,
        source=SOURCE_AUTO, attendee_count=attendee_count,
    )


def reconcile_count(
    *,
    auto_count: int,
    attendee_count: Optional[int] = None,
    language: Optional[str] = None,
    config_threshold: Optional[float] = None,
    max_speakers: int = MAX_AUTO_SPEAKERS,
    tolerance: int = RECONCILE_TOLERANCE,
) -> SpeakerCountStrategy:
    """Second-pass decision: given sherpa's observed ``auto_count``, decide the FINAL count.

    The criterion-4 lever. After a first auto pass, compare the auto speaker count with the calendar
    prior (clamped toward under-merge). Override to the prior ONLY when auto *disagrees* with it by
    more than ``tolerance`` (auto is clearly wrong — the over-split/under-merge case); otherwise keep
    auto untouched so a case auto already got right is never regressed.

    Returns a :class:`SpeakerCountStrategy` whose ``num_clusters`` is:
      * the clamped prior (``source=calendar`` / ``calendar_clamped``) when auto disagrees, OR
      * ``None`` (``source=auto`` when there is no usable prior, ``auto_agreed`` when the prior
        matched auto) — meaning "keep the auto result you already have, no second pass."

    Pure function — no sherpa, no I/O. Phase 13 runs the actual second ``diarize`` call only when
    ``num_clusters`` is not None and differs from ``auto_count``.
    """
    threshold = (
        config_threshold
        if (config_threshold is not None and config_threshold > 0)
        else calibrated_threshold(language)
    )

    # No usable prior → nothing to reconcile against; keep the auto result.
    if attendee_count is None or attendee_count < MIN_SPEAKERS:
        return SpeakerCountStrategy(
            num_clusters=None, threshold=threshold,
            source=SOURCE_AUTO, attendee_count=attendee_count,
        )

    clamped = min(int(attendee_count), int(max_speakers))

    # Auto already agrees with the (clamped) prior → keep auto, don't force (criterion 4: no EN regress).
    if abs(int(auto_count) - clamped) <= int(tolerance):
        return SpeakerCountStrategy(
            num_clusters=None, threshold=threshold,
            source=SOURCE_AUTO_AGREED, attendee_count=attendee_count,
        )

    # Auto disagrees with the prior → trust the calendar prior (the reliable CN lever).
    source = SOURCE_CALENDAR_CLAMPED if clamped != attendee_count else SOURCE_CALENDAR
    return SpeakerCountStrategy(
        num_clusters=clamped, threshold=threshold,
        source=source, attendee_count=attendee_count,
    )


# ── helpers ─────────────────────────────────────────────────────────────────────


def _is_chinese(language: Optional[str]) -> bool:
    """True for any Chinese language hint (``zh``, ``zh-CN``, ``cn``, ``chinese``, ...)."""
    if not language:
        return False
    lang = str(language).strip().lower()
    return lang.startswith("zh") or lang.startswith("cn") or lang == "chinese"
