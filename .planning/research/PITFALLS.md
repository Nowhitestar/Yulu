# Pitfalls Research

**Domain:** Speaker diarization in a local-first, single-user, agent-native macOS meeting recorder (Yulu v0.6) — engine settled (sherpa-onnx cam++, option B: ASR + standalone diarization merged by timestamp overlap)
**Researched:** 2026-06-06
**Confidence:** HIGH (engine behavior grounded in spikes 001/002 on real Yulu meetings; methodology + failure-mode claims corroborated by pyannote.metrics docs, AssemblyAI/Deepgram/Recall.ai engineering write-ups, and 2025–2026 arXiv work on Whisper hallucination, CDER/SER, and segment-level reassignment)

> **Scope note for the roadmapper.** This milestone's engine question is *settled* (spike 002). These pitfalls are deliberately **product / quality / eval / integration** failures — the things that make a *mechanically working* diarizer ship a bad meeting note. Phases are referenced by **function**, not number, because the v0.6 roadmap isn't drawn yet. The natural phase decomposition (from spike 002's "what /gsd-plan-phase should cover") is:
>
> - **P-ENGINE** — `diarization` capability provider (sherpa-onnx behind the `CapabilityProvider` abstraction; FunASR optional)
> - **P-COUNT** — speaker-count strategy (the over-split fix)
> - **P-MERGE** — speaker↔transcript merge + coverage-gap fallback + hallucination handling
> - **P-PROVISION** — model bundling/download, offline-by-default
> - **P-EVAL** — DER/quality harness on labelled CN+EN meetings (the gate that picks the default + sets UI copy)
> - **P-UI** — speaker labels in the transcript: rename / merge / correct
> - **P-XPLAT** — cross-platform validation behind the abstraction
> - **P-PERF** — latency/footprint regression guard on the existing pipeline
>
> Several pitfalls are owned **jointly by P-EVAL and a build phase**: P-EVAL is where you *detect and quantify* the failure; the build phase is where you *prevent or mitigate* it. That split is called out per-pitfall.
>
> A prior-milestone (v0.5) PITFALLS.md is preserved at `.planning/research/archive-v0.5/PITFALLS.md`.

---

## Critical Pitfalls

### Pitfall 1: The eval harness is the product gate — building it last (or weakly) ships unmeasured accuracy

**What goes wrong:**
Diarization gets integrated, "looks coherent" by eyeball (exactly as both spikes admit — "0.765–0.843 is inter-tool agreement, not correctness"), and ships. There is no number anyone can defend. The moment a user sees Speaker 3's words under Speaker 1, the team has no baseline to say whether that's a 2%-of-utterances tail or a 25% disaster, no way to compare sherpa vs FunASR on evidence (the whole point of keeping FunASR as a fallback), and no principled UI copy ("labels are a hint" vs "labels are reliable").

**Why it happens:**
Eval feels like "testing" — assumed to be cheap and deferrable to the end. In diarization it is the *opposite*: the harness is what converts "it runs" into "it works," it's the only way to make the sherpa-vs-FunASR default decision the milestone explicitly defers to evidence, and it's slow to build because reference labels must be created by hand (Pitfall 4). It is a **first-class deliverable**, not a QA afterthought — spike 002 lists it as *required*.

**How to avoid:**
- Treat **P-EVAL as a gating phase that lands early/parallel**, not a closing chore. Build it right after P-ENGINE can produce *any* labels, so every subsequent change (count strategy, merge, fallback) is measured against it.
- Report **multiple metrics, not just DER** (see Pitfall 4): DER with and without collar, **WDER** (word-level — the metric that actually matches "wrong speaker on these words"), and a **speaker-count error** (predicted vs true). DER alone hides the failures users feel.
- Make the harness **re-runnable in CI-ish fashion** on a fixed labelled corpus so accuracy is a tracked number, not a memory.
- The default-provider decision (sherpa vs FunASR) is an **output of this harness**, recorded as an ADR — not a guess.

**Warning signs:**
"It looks right on the demo clip." No DER number in any doc. Provider choice argued on footprint/feel alone. UI copy promising accuracy with no measurement behind it.

**Phase to address:** **P-EVAL (owner).** Lands before/parallel with P-MERGE and P-COUNT so they can be tuned against it.

---

### Pitfall 2: Speaker-count over-split — sherpa auto-clustering invents speakers on Chinese meetings

**What goes wrong:**
This is the milestone's known, measured engine weakness. Spike 002: sherpa-onnx auto speaker-count **over-splits on Chinese meetings — 59→32→20 speakers as the clustering threshold rises 0.5→0.7, never landing near the true ~5.** A 5-person product weekly renders as a transcript with twenty "speakers," most of them fragments of the same person. The note is unusable: no coherent who-said-what, summaries attribute one person's decisions across a dozen phantom labels, and the rename UI (Pitfall 11) is overwhelmed before the user even starts.

**Why it happens:**
Agglomerative clustering of speaker embeddings is acutely sensitive to its stopping threshold, and that threshold does not transfer across languages/acoustics. Mandarin's phonetics, plus the short turns and backchannels typical of CN meetings (Pitfall 7), inflate intra-speaker embedding variance, so the clusterer keeps splitting. FunASR clustered the same clip cleanly to 5 — proving the *embedding/segmentation* path is fine and the failure is specifically in **count estimation/stopping**, the most brittle single knob in the whole pipeline.

**How to avoid:**
- **Do not ship raw auto-count.** Implement a deliberate **speaker-count strategy** (spike 002 item 5) with a fallback ladder:
  1. **User-supplied count** when known (calendar attendee count is a free prior — Yulu already has Google Calendar integration; meeting events often carry attendee lists). Offer a simple "how many speakers?" control in the UI.
  2. **Segmentation-model estimate / calibrated threshold** tuned *specifically on Chinese* against the P-EVAL corpus — not the library default.
  3. **Constrained clustering** (cap the max speakers, or bias toward fewer) so the failure mode is *under*-merge (two people sharing a label — recoverable by user split) rather than *over*-split into 20.
- **Calibrate, then verify on the eval set.** The threshold that fixes CN must not wreck EN — sweep it and pick on DER + count-error across *both* language buckets (Pitfall 6).
- Keep **FunASR as the gated high-accuracy fallback** precisely because it wins on count — if calibration can't get sherpa close enough, the milestone already planned this escape hatch.

**Warning signs:**
Predicted speaker count >> attendee count. Many one- or two-utterance "speakers." Count climbs as you *loosen* the threshold (the documented sherpa signature). Different counts on CN vs EN clips with the same settings.

**Phase to address:** **P-COUNT (owner)**, calibrated and verified against **P-EVAL**. The calendar-attendee prior touches **P-UI** (entry point) but the strategy lives in P-COUNT.

---

### Pitfall 3: Coverage gap — ~10% of ASR segments fall outside diarization, and the fallback is silently wrong

**What goes wrong:**
Spike 002 measured it directly: **~8–12% of ASR segments fall outside diarization coverage.** Option B merges two independently-timestamped streams (Whisper ASR segments vs sherpa diarization turns); they don't tile the same timeline. Some ASR text lands in a gap with *no* speaker turn under it. If the merge module has no fallback, those segments render unlabeled (ugly, "Unknown" everywhere). If it has a *naive* fallback ("assign to previous speaker"), it confidently mislabels ~10% of the transcript — and mislabels are worse than blanks because they're invisible and propagate into the summary (Pitfall 14).

**Why it happens:**
Two engines, two VAD/segmentation regimes, two timestamp clocks. ASR keeps low-energy/edge speech that the diarization VAD dropped; diarization boundaries don't align to ASR sentence boundaries. The gap is *structural to option B*, not a bug — spike 002 calls a coverage-gap fallback **required**, item 3.

**How to avoid:**
- Build the **merge as an explicit stage** (spike 002 item 2/3), not an inline join. Assign each ASR segment a speaker by **timestamp-overlap**, choosing the speaker with **maximum temporal overlap** (not just "the one that started first").
- For gap segments, use a **principled, conservative fallback**, in order: (a) extend the **temporally-nearest** diarization turn if within a small window; (b) if the gap is short and bracketed by the *same* speaker on both sides, fill with that speaker; (c) otherwise mark **explicitly low-confidence / "Unknown"** rather than guessing across a speaker change.
- **Carry a per-segment confidence/source flag** (matched-overlap vs nearest vs gap-fill vs unknown). This is the hook the UI uses to *visually mark* uncertain attributions (Pitfall 11) and the harness uses to measure them.
- **Never silently snap a gap segment across a speaker boundary** — that's the high-cost mislabel.

**Warning signs:**
Unlabeled segments in output. A merge function with no "no overlap found" branch. Fallback that always picks "previous speaker." No confidence/source field on merged segments. Coverage % not measured per meeting.

**Phase to address:** **P-MERGE (owner).** Confidence surfacing is consumed by **P-UI**; coverage % is tracked by **P-EVAL**.

---

### Pitfall 4: DER methodology gotchas — wrong collar/overlap/metric makes the eval lie

**What goes wrong:**
The team builds an eval harness (good) but reports a single DER computed with defaults, and that number is misleading. Three classic traps:
- **Collar:** research convention removes a **250ms collar each side of every turn boundary (500ms total)** to forgive annotation slop. With a generous collar, boundary errors and short turns vanish from the score — DER looks great while the user still sees wrong labels at turn changes. With **no collar ("Full" DER)** the same system scores far worse. **Leaderboards routinely mix these settings**, so a quoted DER is meaningless without its protocol.
- **Overlap scoring:** many DER setups **ignore overlap regions** (or `skip_overlap=True`); since real meetings have substantial overlap (Pitfall 5), ignoring it deletes exactly the hardest cases from the score. A diarizer that simply never predicts overlap can post a flattering DER.
- **Wrong metric for the symptom:** **DER is time-weighted at the frame level.** A speaker confusion during a brief hesitation barely moves DER but can corrupt several *important words* — which is what the user reads. **WDER** (word-level) and **CDER/SER** (utterance-level, each segment counts once) capture short-utterance errors that DER hides. A system can have low DER and high SER.

Two more harness-specific traps the question flags:
- **Reference-label creation bias:** the person who builds the ground truth often labels *from the system's own output* (correcting it) rather than from scratch — this anchors the reference to the system and inflates the score. Boundary placement during annotation also subtly matches whatever the tool produced.
- **Tiny test sets:** 2–3 meetings (what spike 002 proposes as the *minimum*) give a high-variance number; one bad meeting swings the average. Fine as a *gate*, dangerous as a *headline accuracy claim*.

**Why it happens:**
DER is "the standard metric," so people report it without its parameters and assume comparability. The defaults (collar, skip-overlap) optimize for clean academic comparison, not for "did the meeting note attribute words correctly." Hand-labelling is tedious, so people shortcut by correcting the tool's output (the bias). And labelling is expensive, so the set stays tiny.

**How to avoid:**
- **Pin and document the protocol** explicitly: report DER **both** with the 0.25s collar **and** Full (no collar), and **both** with overlap scored and skipped. State it next to every number.
- **Lead with WDER** for the product decision — it's the metric that maps to "wrong speaker on these words," which is what users feel. Add **CDER or SER** so short-utterance/backchannel errors (Pitfall 7) aren't hidden by time-weighting.
- Use a **standard scorer** (e.g. pyannote.metrics / `dscore`/`spyder`-style) rather than a hand-rolled DER, which is easy to get subtly wrong.
- **Label references blind to the system output** (annotate from audio, ideally a second engine or person), to avoid anchoring bias.
- **Bucket results CN vs EN vs code-switch (Pitfall 6) and by meeting** — never a single pooled average over a tiny set. Treat the number as a *gate threshold*, and state the small-N caveat wherever the number is quoted.

**Warning signs:**
A DER quoted with no collar/overlap stated. Only DER, never WDER/SER. Hand-written scoring code. References produced by editing the tool's output. One pooled number across 2–3 clips presented as "accuracy." Suspiciously low DER on overlap-heavy meetings (overlap silently skipped).

**Phase to address:** **P-EVAL (owner).** This pitfall *is* the methodology of the gate.

---

### Pitfall 5: Overlapping / crosstalk speech mis-attribution — the dominant real-meeting error

**What goes wrong:**
When two people talk at once (interruptions, "yeah"-while-someone-talks, two-people-laughing-then-one-continues), single-stream diarization assigns the overlap to **one** speaker (or the wrong one). Documented impact: **WDER jumps from 2.68% with two speakers to 11.65% with three** as overlap density rises. In a meeting note the cost is asymmetric and severe — if an interjection that contains a *commitment* ("I'll own that") is attributed to the wrong person, the **action item, the summary line, and the decision log all inherit the misattribution** (this cascade is Pitfall 14).

**Why it happens:**
Yulu captures a **mono mixdown** — system audio + mic merged into one track. There's no spatial/channel separation to pull overlapping voices apart, and the cam++ embedding path assumes one dominant speaker per segment. Overlap is the single hardest case for *any* mono diarizer; it's not a sherpa-specific defect. (Clean-room note: a future separate-mic/channel capture would help, but that's out of scope this milestone.)

**How to avoid:**
- **Set expectations honestly in the UI** (Pitfall 12): labels are a *hint*; overlap regions are where they're least reliable. This is a product decision the milestone already framed ("treat speaker labels as a helpful hint").
- **Detect and mark overlap** where possible (the segmentation model emits overlap/uncertainty) and **flag those segments low-confidence** rather than rendering a clean wrong label. Borrow the human-transcription convention of a visible `[overlap]` / uncertain marker.
- **Measure overlap explicitly** in P-EVAL (don't skip overlap in scoring — Pitfall 4) and **report DER on overlap-heavy meetings separately** so the known weak spot is quantified, not buried.
- **Don't over-invest** in overlap-resolution algorithms this milestone — mono overlap is a research-grade problem; the pragmatic win is *honest marking* + measurement, not a separation pipeline.

**Warning signs:**
Action items attributed to the wrong person in summaries. Interjections ("right," "exactly") absorbed into the dominant speaker's turn. WDER on 3+ speaker clips far above 2-speaker clips. Overlap silently excluded from the eval.

**Phase to address:** Detection/marking in **P-MERGE** + **P-ENGINE** (use the segmentation model's overlap signal); honest framing in **P-UI**; quantification in **P-EVAL**.

---

### Pitfall 6: CN vs EN vs code-switch accuracy divergence — tuned for one, broken for the other

**What goes wrong:**
The team tunes the clustering threshold and merge windows on Chinese meetings (where the over-split pain is loudest — Pitfall 2), ships it, and English or **CN/EN code-switched** meetings regress — different optimal threshold, different count behavior, different segment durations. Or the reverse: tuned on English defaults, CN over-splits in production. Code-switching is worst: a single speaker who switches CN↔EN mid-sentence can shift their own embedding enough to be **split into two speakers**, and ASR/diarization timestamp drift is often larger at language-switch points (compounding Pitfall 3's coverage gap).

**Why it happens:**
Speaker embeddings and clustering thresholds are **not language-invariant**; cam++ has language-dependent behavior, and the over-split is explicitly a *Chinese* phenomenon per spike 002. Yulu's real user base is bilingual — the milestone explicitly requires labelling **CN + EN** meetings — so single-language tuning is a guaranteed gap.

**How to avoid:**
- **Eval corpus must contain CN, EN, and at least one code-switch meeting** (spike 002 item 6 calls for CN + EN; add code-switch since it's a Yulu reality). **Bucket every metric by language** — never a single pooled number (ties back to Pitfall 4).
- **Pick parameters that are robust across buckets**, not optimal on one. If no single setting works, consider a **language-aware** path (Yulu/Whisper already detects language) — but only if the eval proves the gap is large enough to justify the complexity (YAGNI otherwise).
- **Validate the chosen default on both** before locking it; record the per-bucket DER/WDER in the provider-choice ADR.

**Warning signs:**
Tuning notes mention only one language. A single pooled DER. Code-switch meetings split one person into two. EN regresses after a CN tuning pass (or vice-versa). No code-switch clip in the test set.

**Phase to address:** **P-EVAL (owner — corpus + buckets)**; parameter robustness in **P-COUNT**; optional language-aware path in **P-ENGINE**.

---

### Pitfall 7: Short-utterance / backchannel misattribution ("嗯", "对", "OK", "right")

**What goes wrong:**
Brief turns — backchannels ("嗯", "对", "mm-hmm", "yeah"), one-word confirmations — are **too short to embed reliably** and get dropped, marked Unknown, or **glued onto the previous speaker's turn**. In a meeting this both clutters (phantom micro-speakers if over-split) and corrupts meaning: a "对" (agreement) attributed to the wrong person changes who-agreed-to-what. These are also the segments where the coverage gap (Pitfall 3) and overlap (Pitfall 5) bite hardest, because backchannels frequently occur *during* another speaker's turn.

**Why it happens:**
Speaker embeddings need ~0.5–1s of voiced speech to be discriminative; research finds **best results around a 0.5s minimum-segment floor** — below that, accuracy on the small segment drops sharply. A min-duration floor *helps* over-segmentation robustness but *trades away* accuracy on exactly these short turns — a genuine tension, not a free fix. And **time-weighted DER barely registers these errors** (each is a fraction of a second), so they're invisible unless you measure at the utterance level (Pitfall 4's SER/CDER).

**How to avoid:**
- **Choose the min-segment / merge policy deliberately** (~0.5s is the documented sweet spot) and treat it as a tuned parameter against the eval, not a default.
- For sub-threshold segments, **prefer "low-confidence / Unknown" over a confident guess** when they sit at a speaker boundary; only glue to a neighbor when both neighbors are the *same* speaker (consistent with the Pitfall 3 fallback ladder).
- **Measure with SER/CDER**, not just DER, so backchannel misattribution is actually visible in the number that gates the release.
- **UI: render very short attributed turns subtly** (or fold consecutive same-speaker turns) so a wrong micro-label is less load-bearing visually.

**Warning signs:**
"对/嗯/OK" lines attributed to the wrong speaker. Backchannels swallowed into a monologue. DER fine but SER poor. Min-segment value set to a library default no one chose.

**Phase to address:** **P-MERGE (owner — min-segment + fallback policy)**; visibility in **P-EVAL** (SER); rendering in **P-UI**.

---

### Pitfall 8: Whisper.cpp hallucination / repeat on silence pollutes the labelled transcript

**What goes wrong:**
Whisper (incl. whisper.cpp / large-v3) **hallucinates on silence and non-speech** — looping a phrase, or inserting filler like "so", "thank you", subtitle-credit boilerplate ("字幕by…"), with **as much as 55% of non-speech audio transcribed as "so"** in one study and repeated-phrase loops a known signature. In Yulu's pipeline these phantom segments are *real ASR segments with timestamps*, so the merge stage will dutifully **assign them a speaker** — producing confident, attributed nonsense in the meeting note. Silences at the **start/end** of a recording are the classic trigger; meetings have plenty (dead air before people join, after they leave, long pauses).

**Why it happens:**
On near-silent input Whisper's audio embeddings are near-zero and the model — trained on speech — "fills in" the closest match, looping the most recent phrase. Spike 002 explicitly flags "handling whisper hallucination/repeat artefacts" as a merge-module responsibility (item 3). Diarization VAD often *correctly* finds no speaker there (contributing to the Pitfall 3 coverage gap) — so a hallucinated ASR segment in a silent stretch is *both* a fake transcript line *and* a coverage-gap segment, the worst combination.

**How to avoid:**
- **VAD-gate ASR segments before merging** — drop/flag ASR text in regions the diarization VAD (or a dedicated VAD) marks as non-speech. "Use a VAD to remove non-speech segments" is the documented near-foolproof mitigation.
- **Detect repeat/loop artifacts**: flag segments that are exact/near-duplicate consecutive text, or known boilerplate ("so" alone, subtitle credits, "thank you for watching"), as suspect.
- **Treat a hallucination-flagged segment as no-speaker, not previous-speaker** — don't let the Pitfall 3 fallback launder hallucinated text into a confident attribution.
- **Measure it:** include start/end-silence and a long-pause clip in the eval corpus; check the output has no looped/boilerplate lines.

**Warning signs:**
Repeated identical lines in transcripts. "so" / "字幕"/ "thank you for watching" appearing in silent stretches. Attributed text in regions with no diarization coverage. Hallucinations clustering at recording start/end.

**Phase to address:** **P-MERGE (owner — VAD-gate + artifact filter)**, with a VAD dependency possibly shared from **P-ENGINE**'s segmentation model. Verified in **P-EVAL**.

---

### Pitfall 9: Label instability across re-runs and across meetings — renames get clobbered

**What goes wrong:**
Two related, both painful:
- **Cross-meeting:** diarization labels are **per-recording only** — "Speaker 2" in today's standup is a *different person* than "Speaker 2" yesterday. Users naturally expect their named teammates to persist; they don't. This is intrinsic to diarization (it's clustering, not identification — a *different technology*).
- **Within/across re-runs + user edits:** if a user **renames "Speaker 2 → Alice"** and then the meeting is **re-transcribed/re-diarized** (settings change, model upgrade, coverage-gap re-merge), the new run produces *fresh anonymous labels* with no stable mapping — **clobbering the user's rename.** Clustering is also non-deterministic enough that label *indices* can permute between runs even on the same audio, so "Speaker 1/2/3" aren't stable identifiers to key edits on.

**Why it happens:**
Diarization assigns **arbitrary cluster indices** with no inherent identity; nothing ties cluster #2 in run A to cluster #2 in run B, let alone to a human. Persisting identity across recordings requires **speaker *identification* / voiceprint enrollment** — a separate, heavier capability (Pitfall 10) and a privacy decision (Pitfall 13). Teams conflate "diarization" with "speaker ID" and assume persistence comes for free; it doesn't.

**How to avoid:**
- **Store user renames keyed to a stable per-meeting speaker record**, not to the volatile "Speaker N" index. Re-runs must **re-attach existing user labels** by best-effort mapping (embedding similarity or overlap with the prior segmentation) and **never silently overwrite** a user's name. If mapping is uncertain, *preserve the old name and flag*, don't clobber.
- **Set expectations in copy:** "Speaker names are per-meeting" (Pitfall 12) — so users aren't surprised that yesterday's Alice is today's Speaker 2.
- **Decide cross-meeting persistence as an explicit, scoped choice.** Either (a) **out of scope** for v0.6 (honest, simple — diarization-only, names per meeting), or (b) a **deliberate later feature** built on opt-in voiceprint enrollment (Pitfall 10 + 13). Do **not** half-build it (e.g. naive name-matching by index) — that produces *confident wrong* persistence.
- **Make re-diarization explicit and non-destructive:** treat it like a re-index that proposes new labels and merges in old names, with the user's edits as source of truth.

**Warning signs:**
User renames vanish after a re-transcribe. The same person is "Speaker 1" in one meeting and "Speaker 3" in another with no warning. Edits keyed to "Speaker N". Re-running the same audio permutes labels. Bug reports: "it forgot the names I set."

**Phase to address:** **P-UI (owner — rename persistence model + re-attach-don't-clobber)**; expectations copy in **P-UI**; the cross-meeting-persistence scope decision is a **roadmap/PROJECT decision** (in or out for v0.6).

---

### Pitfall 10: Mis-scoping diarization as speaker *identification* — building the wrong (heavy, privacy-laden) thing

**What goes wrong:**
Driven by the very natural "but I want it to know it's Alice" desire (Pitfall 9), the team starts building **voiceprint enrollment / persistent speaker recognition** — capturing per-person voice samples, storing embeddings in a database, matching new audio against enrolled identities. This is **scope creep into a different, heavier capability** than the milestone signed up for ("who-said-what" within a meeting), it drags in real **privacy obligations** (biometric voiceprints — Pitfall 13), and it's a known accuracy rabbit hole (enrollment quality, drift, cross-condition robustness).

**Why it happens:**
The line between **diarization** (cluster turns within one recording, anonymous labels) and **speaker identification** (match to a known, enrolled person) is genuinely blurry in users' minds and in marketing copy. The pull from Pitfall 9 ("names should persist") leads straight here. It feels like "just a bit more."

**How to avoid:**
- **Name the boundary explicitly in PROJECT/REQUIREMENTS:** v0.6 ships **diarization** (anonymous, per-meeting), **not** speaker identification/enrollment. The milestone's own scope ("who-said-what", "rename/merge/correct") is diarization + manual labels — keep it there.
- If persistent identity is wanted, **defer to a future milestone** with its own privacy design and opt-in enrollment UX (Pitfall 13). Manual rename + per-meeting labels is the v0.6 answer to "who is this."
- **Reuse, don't build, where the abstraction allows:** identity belongs behind a future capability provider, not bolted into the v0.6 merge stage.

**Warning signs:**
A "voiceprints" / "enrolled speakers" table appearing in the schema. Cross-meeting matching code in v0.6. Storing per-person embeddings persistently. Requirements drifting from "rename" to "auto-recognize."

**Phase to address:** **Roadmap / PROJECT scope guard** (keep it out of v0.6); revisited only as a future milestone.

---

## Moderate Pitfalls

### Pitfall 11: The correction UI is an afterthought — no merge/split, only rename

**What goes wrong:**
The UI shows speaker labels and lets users **rename** ("Speaker 2 → Alice") but can't **merge** (over-split produced Speaker 2 and Speaker 7 that are the same person — the *direct* consequence of Pitfall 2) or **split/reassign** (a turn or word range attributed wrong — consequence of Pitfalls 3/5/7). Given that this engine's known failure is over-splitting, a rename-only UI leaves users manually renaming twenty fragments to the same name — exhausting and lossy. Spike 002 explicitly says labels must be **"editable/mergeable"** (item 7), not just editable.

**Why it happens:**
"Show the labels" reads as the feature; correction tooling looks like polish. But because the engine *will* mislabel (especially over-split), correction is **core to making the output usable**, not optional.

**How to avoid:**
- Ship **rename + merge + reassign** as the v0.6 correction set. Merge is the highest-value op given over-split. Reassign-a-range handles overlap/coverage-gap errors.
- **Visually mark low-confidence attributions** (using the per-segment confidence/source flag from Pitfall 3) so users know *where* to look — don't make them re-read everything.
- **Persist corrections robustly** against re-runs (Pitfall 9).
- Consider a **"merge all into N"** or count-correction affordance tied to the speaker-count strategy (Pitfall 2) as the fast path out of over-split.

**Warning signs:**
Rename-only UI. No way to combine two labels. Users renaming many fragments to one name. No visual cue for uncertain segments. Corrections lost on re-transcribe.

**Phase to address:** **P-UI (owner)**, consuming the confidence flag from **P-MERGE** and the count strategy from **P-COUNT**.

---

### Pitfall 12: Over-promising accuracy in copy — labels presented as fact, not hint

**What goes wrong:**
The UI presents speaker labels with the same visual authority as the transcript text, implying they're as reliable as the words. Given measured ~15–20% arguable attributions (spike 002) plus overlap/short-utterance/coverage-gap tails, users trust labels they shouldn't — and lose trust in the whole feature when they catch an obvious error, because nothing told them to expect any.

**Why it happens:**
Diarization output *looks* authoritative (clean "Alice:" prefixes). Teams ship the happy-path framing. Spike 002 explicitly says to **"treat speaker labels as a helpful hint"** and **"set the accuracy expectation in the UI copy"** (caveats + item 6) — easy to skip.

**How to avoid:**
- **Frame labels as assistive, correctable hints** in copy and visual treatment; surface a calibrated expectation from the **actual eval number** (P-EVAL), not marketing.
- **Visually distinguish low-confidence** attributions (Pitfall 11) so the UI's own design communicates uncertainty.
- Make correction obviously available (Pitfall 11) — "we expect you'll fix some of these" is the honest, trust-preserving stance.

**Warning signs:**
Copy claims "accurate speaker identification." No uncertainty in the UI. Accuracy expectation set before the eval ran. User trust cratering on first visible error.

**Phase to address:** **P-UI (owner)**, sourced from **P-EVAL**.

---

### Pitfall 13: Speaker-identity / voiceprint privacy in a local-first app

**What goes wrong:**
Diarization produces **speaker embeddings** (voice fingerprints) and per-speaker audio segmentation. If any of this is persisted, exported, synced, or sent to a cloud LLM carelessly, Yulu — whose entire value prop is "audio never leaves the laptop unless you opt in" — leaks **biometric voiceprint data**, the most sensitive class. Concrete leak paths in *this* architecture: (a) embeddings written into a synced `data_dir` (Phase 5 cloud-folder sync); (b) per-speaker audio/labels handed to the agent over the `agent-queue.json` boundary and thence to a cloud LLM under cloud-fallback/cloud-priority transcription mode; (c) a future enrollment DB (Pitfall 10).

**Why it happens:**
Embeddings feel like "just numbers," and the existing pipeline already passes transcripts to the agent — adding speaker data to that flow is frictionless and easy to do without a privacy review. The local-first guarantee is a *promise*, and diarization quietly introduces a new, more sensitive data type the promise must now cover.

**How to avoid:**
- **Default: embeddings are ephemeral.** Compute, cluster, label, **discard** — don't persist voiceprints unless a future opt-in enrollment feature (Pitfall 10) requires it, and then with explicit consent + local-only storage.
- **Decide deliberately what crosses the agent boundary.** Speaker *labels* in the transcript are fine; raw embeddings/voiceprints should **not** be shipped to a cloud LLM. Honor the existing local-by-default / opt-in-cloud contract for any speaker-derived data exactly as for audio.
- **Keep any persisted speaker data out of the synced content split** unless intended — respect Phase 5's runtime-vs-syncable separation; voiceprints (if ever stored) lean toward local-only.
- **Models stay offline** (Pitfall 15 / spike 001's offline lesson) — no phone-home for diarization.
- **Document the data flow** so the privacy promise demonstrably still holds with diarization added.

**Warning signs:**
A persistent embeddings/voiceprint store with no consent flow. Speaker embeddings in `data_dir` (synced). Raw voice features in the agent-queue payload to a cloud LLM. No statement of where speaker data lives and whether it syncs.

**Phase to address:** **P-PROVISION + P-ENGINE** (ephemeral-by-default, offline models, no phone-home); boundary/sync decisions touch **P-MERGE** (agent-queue payload) and the **PROJECT privacy contract**.

---

### Pitfall 14: Misattribution cascades into summaries, action items, and decisions

**What goes wrong:**
A diarization error isn't a cosmetic transcript blemish — it **propagates through every downstream stage**. The transcript feeds the agent (`agent-queue.json` → summary prompt). A wrong speaker on a sentence containing a commitment becomes a **wrong-owner action item**; a decision gets **logged under the wrong person**; the summary's "Alice proposed X" is just false. Because Yulu's whole point is turning speech into a *clean note*, a confidently-wrong label is *more* damaging than no label — it manufactures false structured facts the user may act on. (This is the through-line that makes Pitfalls 3/5/7/8 matter.)

**Why it happens:**
Speaker labels become *input* to the LLM, which treats them as ground truth and amplifies them into structured claims (owners, decisions). The error surface moves from "a word looks off" to "an action item is assigned to the wrong colleague."

**How to avoid:**
- **Pass uncertainty downstream, don't hide it.** When attributions are low-confidence (the Pitfall 3 flag), either omit speaker attribution for those lines in the agent payload or mark them uncertain so the agent doesn't confidently assign ownership.
- **Prefer "Unknown" to a wrong guess** specifically for segments that will drive action-item/decision extraction.
- **Eval the user-visible outcome, not just DER:** spot-check that summaries/action items on the eval meetings don't carry obvious misattributions — a qualitative gate alongside the quantitative one (P-EVAL).
- This is the **core argument** for getting Pitfalls 3, 5, 7, 8 right: their blast radius is the summary, not the transcript.

**Warning signs:**
Action items assigned to the wrong person in generated notes. Decisions logged under the wrong speaker. Confident attributions on segments the merge flagged uncertain. No uncertainty signal in the agent-queue payload.

**Phase to address:** **P-MERGE** (confidence in the payload) + **P-EVAL** (outcome-level spot-check); the agent prompt contract is a **P-UI / pipeline** concern.

---

### Pitfall 15: Offline breakage — diarization that phones home dies the moment the user is offline

**What goes wrong:**
Diarization (model download path, or a library that checks a remote registry) reaches the network at runtime, so the first offline meeting **fails or hangs**. This directly violates Yulu's local-first guarantee. Spike 001 hit this *hard* with FunASR/modelscope: **`disable_update=True` was NOT enough** — it still called `modelscope.cn`, got connection-refused, retried 5×, and failed with "model not registered." Even on the chosen sherpa-onnx path, the lesson stands: **verify true offline operation**, don't assume it.

**Why it happens:**
ML libraries default to "check for updates / resolve from a hub," and that path is often *not* fully short-circuited by the obvious flag (the spike proved it for modelscope). The dev machine is always online, so the failure never reproduces locally — it surfaces only on a user's plane/cafe/airgapped run.

**How to avoid:**
- **Bundle/provision models at setup** (spike 002 item 4: seg 5.7 MB + cam++ 27 MB ONNX, offline by default) and **load from explicit local file paths** — sherpa-onnx's advantage here is "clean local files," no hub resolution.
- **Test under forced offline** (dead proxy / network namespace, exactly as spike 001 did) and assert **zero network calls** during diarization.
- For the **FunASR fallback path specifically**, the milestone must carry the **modelscope `snapshot_download` cache short-circuit patch** (or a pinned fixed version / vendored copy) or that path breaks offline — spike 001 calls this **must-fix**.

**Warning signs:**
Any HTTP during a diarization run. Reliance on `disable_update`-style flags without an offline test. Models resolved by name/alias rather than absolute local path. First-offline-meeting failures in the field.

**Phase to address:** **P-PROVISION (owner — bundle + local-path load + offline test)**; FunASR-path patch in P-PROVISION if that fallback ships.

---

### Pitfall 16: Latency / footprint regression in the existing pipeline

**What goes wrong:**
Adding a diarization stage degrades the experience users already have: post-recording note appears noticeably later (extra processing after ASR), memory balloons, or the resident daemon set grows. The footprint surprises are real and measured: spike 001's **full FunASR pipeline peaked ~8 GB unified memory** and **1.13 GB venv** — unacceptable; sherpa-onnx is the answer (61s install / 131 MB venv, **RTF ~0.17 on CPU**, ~33 MB models), but its actual *option-B* footprint **wasn't measured** (spike measured the merge timing on a 20-min clip only). On Yulu's many-daemon launchd runtime, a heavy or always-resident diarizer competes with the existing `stt_daemon` model (~2 GB) and the rest of the 8-agent set.

**Why it happens:**
Diarization is "just a post-process," so its cost is assumed negligible — but model load (warm-up), per-meeting compute (cluster is O(segments²) — spike 001), and memory residency add up. **First sherpa/MPS run is ~2× slower** (shader/graph JIT — spike 001) so an uninstrumented first meeting feels sluggish. Clustering is O(n²) in segments — fine for hundreds (real meetings) but a long, dense recording could spike (spike 001 caveat).

**How to avoid:**
- **Measure the option-B path explicitly** (spike 002: "validate on 1h+"; spike 001 open item: "measure diarization-only footprint") — install size, peak RAM, added wall-clock per meeting, on 20-min / 1h / long clips. Set a **regression budget** vs current behavior.
- **Warm up** the diarization model (spike 001) so the first real meeting isn't penalized by JIT; decide resident-vs-on-demand deliberately given the existing daemon memory pressure.
- **Guard the O(n²) tail:** cap or chunk on pathologically long/dense recordings so a 4-hour meeting can't blow up clustering.
- **Prefer sherpa-onnx CPU/ONNX** (the milestone default) precisely to avoid the FunASR torch/MPS footprint; keep diarization off the critical path of *live* transcription (it's a post-process — don't let it stall the realtime stream).

**Warning signs:**
Note appears much later after recording stops. RAM/footprint jump after enabling diarization. First-meeting-after-boot sluggish (no warm-up). Long meetings hang in clustering. Footprint never measured for the actual option-B path.

**Phase to address:** **P-PERF (owner)** + **P-ENGINE** (warm-up, resident-vs-on-demand). Budget tracked alongside **P-EVAL**.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Ship raw sherpa auto-count | One less knob to build | Over-split → unusable CN notes (Pitfall 2); twenty phantom speakers | **Never** — the milestone's known failure; count strategy is mandatory |
| Eyeball accuracy, skip the DER harness | Faster to "done" | Unmeasured quality; can't pick sherpa vs FunASR on evidence; UI copy is a guess (Pitfall 1) | **Never** — spike 002 lists eval as *required* |
| Naive "previous speaker" coverage-gap fallback | One-line merge | ~10% confident mislabels feeding summaries (Pitfalls 3, 14) | **Never** for boundary gaps; OK only when both neighbors are the same speaker |
| Report DER only, with defaults | Single clean number | Hides overlap + short-utterance errors users feel; non-comparable (Pitfall 4) | Internal smoke only — never as the ship gate |
| Label references by correcting the tool's output | Faster annotation | Anchoring bias inflates the score (Pitfall 4) | Only if cross-checked blind on a subset |
| Rename-only correction UI | Less UI work | Users hand-rename over-split fragments; no recovery from mislabels (Pitfall 11) | Acceptable **only** if count strategy makes over-split rare *and* eval proves it — risky; prefer shipping merge |
| Persist voiceprint embeddings "for later" | Future-proofs identity | Biometric data at rest violating local-first (Pitfall 13); scope creep (Pitfall 10) | **Never** without explicit opt-in enrollment design + consent |
| Tune only on Chinese meetings | Fixes the loudest pain fast | EN / code-switch regress silently (Pitfall 6) | **Never** — eval must bucket CN/EN/code-switch |
| Always-resident diarization daemon | Lower per-meeting latency | Competes with stt_daemon (~2GB) on the 8-daemon runtime (Pitfall 16) | Only after footprint is measured and budgeted |
| Trust `disable_update`-style flags for offline | Looks done | Dies on first offline meeting (Pitfall 15 — spike 001 proved the flag insufficient) | **Never** without a forced-offline test asserting zero network calls |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `stt_daemon` / MLX Whisper (ASR source) | Merging raw ASR segments incl. hallucinated/looped lines | VAD-gate + artifact-filter ASR segments before merge (Pitfall 8); keep ASR on MLX/whisper.cpp (spike: cleaner than FunASR's ASR) |
| `agent-queue.json` boundary → cloud LLM | Shipping confident speaker labels + (worse) embeddings to a cloud agent | Pass labels with uncertainty; never ship voiceprints to cloud; honor opt-in-cloud contract (Pitfalls 13, 14) |
| Phase 5 `data_dir` cloud sync | Writing speaker embeddings into the synced content split | Keep ephemeral/local-only voiceprints out of synced content (Pitfall 13); respect runtime-vs-syncable split |
| `CapabilityProvider` abstraction | Hard-coupling sherpa specifics into the pipeline | Diarization is a provider behind the abstraction (sherpa default, FunASR optional); pipeline depends on the Protocol, not sherpa (spike 002 item 1) |
| STT backend Protocol (`warm_up`/`transcribe`/`is_ready`/`release`) | Reinventing a lifecycle for the diarizer | Reuse the existing Protocol shape (spike 002 item 2); warm-up does a dummy diarization (Pitfall 16) |
| Google Calendar (`gog`) integration | Ignoring a free speaker-count prior | Use attendee count as a count hint for the over-split fix (Pitfall 2) |
| Model provisioning (setup) | Resolving models by hub name at runtime | Bundle/download ONNX at setup, load from local paths, offline by default (Pitfalls 13, 15) |
| FunASR fallback (if shipped) | Assuming offline works with `disable_update` | Carry the modelscope `snapshot_download` cache patch / pinned fix (spike 001 must-fix) |
| launchd daemon set | Adding an always-on heavy diarizer without budget | Measure footprint; choose resident-vs-on-demand against existing daemon memory pressure (Pitfall 16) |
| Cross-platform (P-XPLAT) | Verifying only on the dev's macOS | Confirm sherpa-onnx wheels + ONNX models behind the abstraction on non-macOS targets (spike 002 item 8; v0.5 stub-and-verify pattern) |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| O(n²) clustering on long/dense recordings | Clustering hangs; note never appears | Cap/chunk segment count; bound the cluster step | Thousands of speech segments (multi-hour dense meeting); fine at hundreds (spike 001) |
| Cold-start JIT on first run | First meeting after boot sluggish | `warm_up()` with a dummy diarization (spike 001) | Every first run post-boot until warmed |
| Unmeasured option-B footprint | RAM jump / install bloat discovered in field | Measure diarization-only path (spike open item) before ship | Whenever real footprint ≠ assumed |
| Diarization on the live/critical path | Realtime transcript stalls | Keep diarization a post-process; don't block the realtime stream | Any meeting if merge runs inline with live STT |
| Resident diarizer + stt_daemon memory contention | Swapping / slowdowns on 16 GB machines | Budget memory; on-demand load if resident cost too high | Concurrent heavy daemons on low-RAM Macs |

## Security / Privacy Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Persisting speaker embeddings (voiceprints) by default | Biometric data at rest; local-first promise broken | Ephemeral by default; persist only with opt-in enrollment + consent, local-only (Pitfalls 10, 13) |
| Voiceprints/audio in synced `data_dir` | Biometric data leaves the laptop via cloud folder sync | Keep speaker-derived data out of synced content unless intended (Pitfall 13) |
| Shipping embeddings/voice features to a cloud LLM via agent-queue | Sensitive voice biometrics sent off-device | Send labels (not voiceprints); honor opt-in-cloud contract (Pitfalls 13, 14) |
| Diarization phones home at runtime | Metadata leak + offline breakage | Offline-by-default, local-path model load, forced-offline test (Pitfall 15) |
| No documented speaker-data flow | Privacy promise unverifiable after a new sensitive data type is added | Document where speaker data lives, whether it persists, whether it syncs (Pitfall 13) |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Twenty "speakers" for a 5-person meeting | Note unusable; correction overwhelming | Speaker-count strategy so failure is under-merge, not over-split (Pitfall 2) |
| Rename-only, no merge/split | Hand-renaming many fragments; can't fix mislabels | Rename + merge + reassign; mark low-confidence segments (Pitfall 11) |
| Labels look as authoritative as the words | Misplaced trust → trust collapse on first error | Frame as correctable hints; show uncertainty; set expectation from eval (Pitfall 12) |
| Renames clobbered on re-transcribe | "It forgot the names I set" | Persist edits keyed to stable records; re-attach, don't overwrite (Pitfall 9) |
| Surprise that yesterday's "Alice" is today's "Speaker 2" | Confusion; perceived bug | Copy: names are per-meeting; scope cross-meeting persistence explicitly (Pitfalls 9, 10) |
| Confident wrong action-item owners in summary | User acts on false attribution | Pass uncertainty downstream; prefer Unknown over wrong guess (Pitfall 14) |

## "Looks Done But Isn't" Checklist

- [ ] **Speaker count:** Often missing the over-split fix — verify predicted count ≈ attendee count on a real CN meeting (not just EN), with a strategy beyond raw auto (Pitfall 2)
- [ ] **Eval harness:** Often missing WDER/SER + collar/overlap protocol — verify multiple metrics on a CN+EN(+code-switch) labelled corpus, protocol documented, references not anchored to tool output (Pitfalls 1, 4, 6)
- [ ] **Coverage gap:** Often missing a principled fallback — verify gap segments aren't snapped across speaker boundaries and carry a confidence flag (Pitfall 3)
- [ ] **Whisper hallucination:** Often missing VAD-gate/artifact-filter — verify silent start/end and long-pause clips produce no looped/boilerplate attributed lines (Pitfall 8)
- [ ] **Rename persistence:** Often missing re-run safety — verify a rename survives a re-transcribe and isn't clobbered (Pitfall 9)
- [ ] **Correction UI:** Often missing merge/split — verify users can merge two labels and reassign a range, not just rename (Pitfall 11)
- [ ] **Offline:** Often missing a real offline test — verify zero network calls during diarization under forced-offline (Pitfall 15)
- [ ] **Footprint:** Often missing option-B measurement — verify peak RAM + install size + added per-meeting latency against a budget on 20-min/1h clips (Pitfall 16)
- [ ] **Privacy:** Often missing a data-flow statement — verify embeddings are ephemeral and nothing voice-biometric syncs or hits the cloud LLM (Pitfall 13)
- [ ] **Downstream:** Often missing uncertainty propagation — verify summaries/action items on eval meetings have no obvious misattribution (Pitfall 14)
- [ ] **Cross-platform:** Often missing non-macOS verification — verify sherpa-onnx wheels + ONNX load behind the abstraction on a non-macOS target (P-XPLAT)
- [ ] **Code-switch:** Often missing — verify a CN↔EN speaker isn't split into two (Pitfall 6)

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Over-split shipped (Pitfall 2) | MEDIUM | Add count strategy (user-hint/calendar/calibrated threshold); re-diarize affected meetings; ensure renames survive re-run |
| No eval, accuracy disputed (Pitfall 1) | MEDIUM | Build harness retroactively; label a corpus; produce DER/WDER; reset UI copy to measured reality |
| Confident mislabels in summaries (Pitfall 14) | HIGH | Add uncertainty propagation; regenerate notes; user trust may already be damaged — costliest to undo |
| Renames clobbered (Pitfall 9) | MEDIUM | Add stable-key persistence + re-attach mapping; user re-enters lost names once |
| Offline breakage in field (Pitfall 15) | LOW–MEDIUM | Bundle models + local-path load (+ modelscope patch if FunASR); ship a point fix; add forced-offline test |
| Voiceprints persisted/leaked (Pitfall 13) | HIGH | Purge stored embeddings; remove from sync/cloud paths; disclose; redesign as opt-in — reputational + possibly irreversible |
| Footprint regression (Pitfall 16) | MEDIUM | Switch resident→on-demand; cap O(n²); add warm-up; set budget retroactively |
| Rename-only UI (Pitfall 11) | LOW–MEDIUM | Add merge/reassign in a follow-up; meanwhile users tolerate manual renaming |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1. Eval is the gate | **P-EVAL** | A documented DER+WDER+count-error number exists on a CN+EN corpus before ship; provider choice is an ADR output |
| 2. Speaker-count over-split | **P-COUNT** (verify in P-EVAL) | Predicted count ≈ attendee count on a real CN meeting; strategy beyond raw auto present |
| 3. Coverage gap | **P-MERGE** (track in P-EVAL) | Gap segments carry a confidence flag and are never snapped across a speaker boundary; coverage % measured |
| 4. DER methodology | **P-EVAL** | DER reported with/without collar, with/without overlap; WDER+SER present; standard scorer; references labelled blind |
| 5. Overlap/crosstalk | **P-MERGE + P-ENGINE** (frame in P-UI, quantify in P-EVAL) | Overlap scored (not skipped); overlap-heavy DER reported separately; overlap segments marked |
| 6. CN/EN/code-switch divergence | **P-EVAL** (corpus) + **P-COUNT** (params) | Metrics bucketed by language; chosen params validated on all buckets incl. code-switch |
| 7. Short-utterance misattribution | **P-MERGE** (verify via SER in P-EVAL) | Min-segment policy chosen deliberately (~0.5s); SER reported; backchannels not glued across boundaries |
| 8. Whisper hallucination | **P-MERGE** (VAD-gate) | Silent/long-pause clips yield no looped/boilerplate attributed lines |
| 9. Label instability / clobbered renames | **P-UI** (scope decision = roadmap) | Rename survives a re-transcribe; per-meeting-names expectation in copy |
| 10. Mis-scoped as speaker-ID | **Roadmap / PROJECT scope guard** | No voiceprint-enrollment/cross-meeting-match code in v0.6 |
| 11. Correction UI afterthought | **P-UI** | Merge + reassign shipped, not just rename; low-confidence segments visually marked |
| 12. Over-promising accuracy | **P-UI** (from P-EVAL) | Copy frames labels as correctable hints; expectation matches the eval number |
| 13. Voiceprint privacy | **P-PROVISION + P-ENGINE** (boundary in P-MERGE) | Embeddings ephemeral by default; nothing voice-biometric syncs or hits cloud LLM; data flow documented |
| 14. Misattribution cascade | **P-MERGE** (payload) + **P-EVAL** (outcome) | Uncertainty passed downstream; eval meetings' summaries free of obvious misattribution |
| 15. Offline breakage | **P-PROVISION** | Zero network calls during diarization under forced-offline; models load from local paths |
| 16. Latency/footprint regression | **P-PERF + P-ENGINE** | Option-B footprint + added latency measured against a budget; warm-up present; O(n²) bounded |

## Sources

- Spike 002 — `.planning/spikes/002-option-b-diarization-merge/REPORT.md` (sherpa over-split 59→32→20 on CN; ~8–12% coverage gap; 0.765–0.843 inter-tool agreement = not correctness; eval required; editable/mergeable UI; hallucination handling as merge responsibility) — **HIGH**, primary, measured on real Yulu meetings
- Spike 001 — `.planning/spikes/001-funasr-camplus-diarization/REPORT.md` (FunASR clean count=5; offline broke despite `disable_update`, modelscope cache patch must-fix; ~8 GB peak full-pipeline; warm-up ~2× first run; O(n²) clustering caveat; ground-truth DER still needed) — **HIGH**, primary
- `.planning/PROJECT.md` — milestone scope, constraints (local-first, opt-in cloud, cross-platform, agent boundary), Phase 5 data-folder sync, calendar integration — **HIGH**
- pyannote.metrics docs + "How to evaluate Speaker Diarization performance" (pyannote.ai) — collar (250ms/side = 500ms), DER vs JER, `skip_overlap`, leaderboards mix protocols — https://www.pyannote.ai/blog/how-to-evaluate-speaker-diarization-performance , https://pyannote.github.io/pyannote-metrics/reference.html — **HIGH** (official toolkit + maintainer)
- Recall.ai, AssemblyAI, Deepgram engineering write-ups — diarization labels are per-recording (not persistent); diarization ≠ speaker identification; short utterances → Unknown/previous-speaker; WDER 2.68%→11.65% (2→3 speakers); crosstalk cascade into action items/decisions — https://www.recall.ai/blog/speaker-diarization , https://www.assemblyai.com/blog/speaker-diarization-speaker-labels-for-mono-channel-files , https://www.assemblyai.com/blog/what-is-speaker-diarization-and-how-does-it-work , https://deepgram.com/learn/working-with-timestamps-utterances-and-speaker-diarization-in-deepgram — **MEDIUM–HIGH** (multiple vendor engineering sources agree)
- Circleback "How AI Meeting Notes Actually Work" + GoTranscript crosstalk-attribution guide — misattribution cascade into summaries; `[OVERLAP]`/`[UNKNOWN]` marking convention — https://circleback.ai/blog/how-ai-meeting-notes-work , https://gotranscript.com/en/blog/edit-crosstalk-in-transcripts-overlapping-speakers-attribution-rules — **MEDIUM**
- Whisper hallucination corpus: "Whisper Hallucination on Silence" (DEV), "Investigation of Whisper ASR Hallucinations Induced by Non-Speech Audio" (arXiv 2501.11378), "Calm-Whisper" (arXiv 2505.12969) — silence triggers looped phrases; ~55% of non-speech → "so"; VAD-gating is the documented mitigation — https://dev.to/nareshipme/whisper-hallucination-on-silence-why-your-transcript-loops-the-same-phrase-2pg4 , https://arxiv.org/abs/2501.11378 , https://arxiv.org/abs/2505.12969 — **HIGH** (peer-reviewed + reproduced)
- Short-segment / metric work: CDER/SER vs DER for short utterances; ~0.5s minimum-segment sweet spot; "Once more Diarization: segment-level speaker reassignment" (arXiv 2406.03155) — https://www.emergentmind.com/topics/segment-error-rate-ser , https://arxiv.org/pdf/2406.03155 — **MEDIUM–HIGH**
- SDBench (arXiv 2507.16136), "State of Speaker Diarization 2026" (Picovoice) — benchmark-protocol consistency, collar/overlap/VAD confounds — https://arxiv.org/pdf/2507.16136 , https://picovoice.ai/blog/state-of-speaker-diarization/ — **MEDIUM**

---
*Pitfalls research for: speaker diarization in a local-first agent-native meeting recorder (Yulu v0.6)*
*Researched: 2026-06-06*
