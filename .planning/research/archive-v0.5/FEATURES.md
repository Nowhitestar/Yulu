# Feature Research

**Domain:** Speaker diarization UX in a local-first, single-user, agent-native meeting-notes app (Yulu v0.6)
**Researched:** 2026-06-06
**Confidence:** HIGH on competitor behavior and Yulu surface dependencies; MEDIUM on which features Yulu users will actually demand (no Yulu user research; inferred from competitor norms + the single-user/local constraint)

> Scope: the spikes (001/002) settled the **engine** (sherpa-onnx cam++, Option-B merge by timestamp overlap). This file covers only the **product/UX layer the spikes did not touch**: how speaker turns render, how users name/merge/correct speakers, how corrections persist, how speakers reach the summary, and what to export. Comparables analyzed: Otter.ai, Fireflies, Granola, tl;dv, Descript, Trint/Reduct, Zoom/Teams transcripts.

---

## The single most load-bearing finding (read first)

**Yulu already ships a 2-speaker transcript.** When a dual-track WAV is captured, `stt_daemon/transcript_merge.py::merge_segments(mic, sys)` emits:

```
[00:03 我]   text from the microphone (the local user)
[00:07 对方] text from system audio (everyone on the far end)
```

This is exactly **Granola's desktop "Me / Them" model** — channel-derived, not voice-derived. So v0.6 is **not** "add speakers to an unlabeled transcript." It is: **go from 2 channel speakers → N voice-clustered speakers**, primarily by splitting the single `对方`/system-audio stream (where multiple remote people are mixed) into distinct voices, and letting the user name them. That reframing drives every complexity estimate below.

**Format-mismatch landmine (pre-existing):** the merge output uses `[MM:SS 我]` (Chinese label, bracketed timestamp), but the web `TranscriptView.tsx` speaker parser is `/^(Speaker [A-Z]:)/` (English `Speaker A:`, no timestamp). **The UI's existing speaker styling does not actually match the current transcript format.** Reconciling on one canonical line format is a prerequisite for nearly everything here — see Dependencies.

---

## Feature Landscape

### Table Stakes (Users Expect These)

Features users assume exist. Missing these = the diarization feels broken or pointless.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Speaker turns rendered as labeled blocks** (label + text, new block on speaker change) | Every tool does this (Otter, Fireflies, tl;dv, Descript, Zoom/Teams). A wall of text with no attribution defeats the point. | **LOW** | `TranscriptView.tsx` already groups by line + renders a `.speaker` span. Mostly: settle one canonical format and make the parser match it. |
| **Auto-labels by default** (`Speaker 1/2/3`, or keep `我`/`对方` + `Speaker 3…`) before any naming | Diarization is anonymous clustering; real names are a *separate* step (Recall.ai, BrassTranscripts both stress this distinction). Users expect generic labels first. | **LOW** | Output of the merge module. Reuse existing `我`/`对方` for the two channels; add `Speaker N` for far-end voice clusters. |
| **Rename a speaker → applies to all instances** | Otter, Fireflies, Descript, Trint all make "rename updates every occurrence" the default. Renaming line-by-line is unusable. | **MEDIUM** | Needs a **speaker label → display name map** persisted per recording, applied at render and at export. This is the core new state. Do NOT rewrite the `.txt` per rename (lossy, races re-transcribe + cleanup overwrites). |
| **Persist renames** (survive reload / re-open) | A correction that vanishes on refresh is worse than no feature. | **MEDIUM** | Per-recording sidecar (e.g. `{stem}.speakers.json`) or a small SQLite table. Sidecar matches Yulu's existing `{stem}.*.txt`/`.json` convention and the local-first/folder-sync model. |
| **Manual correction of a single misattributed segment** (reassign one utterance to a different speaker) | Diarization mis-assigns ~15–20% of utterances (spike 002: matched-label agreement 0.765; ~8–12% fall outside coverage). Users WILL hit wrong labels and expect to fix them. | **MEDIUM–HIGH** | Requires per-segment identity (segment index / time range) → speaker override. Pushes the data model from "flat text" toward "segments with a speaker field." Biggest single data-model decision of the milestone. |
| **Speaker count is roughly correct** (not 20 speakers for a 4-person call) | spike 002 flagged sherpa **over-splits on Chinese** (59→32 clusters). 20 phantom speakers reads as a broken product, not a labeling nuance. | **MEDIUM** | Engine/merge concern, but *experienced* as UX. Pair with manual **merge** below so users can recover from over-split. Supplied-count / threshold tuning lives in the engine plan. |
| **Merge two auto-labels into one speaker** (`Speaker 3` + `Speaker 5` are the same person) | Direct consequence of over-splitting; Descript/Trint/Reduct all offer merge. Without it, over-split has no user recovery path. | **MEDIUM** | "Merge" = map both labels to one name in the speaker map. Cheap *given* the rename map exists — effectively rename-to-same-name. |
| **Speakers carry into the generated summary/note** | The whole value chain: speaker-attributed action items ("Sarah will send the deck") is the #1 reason diarization matters for notes (Granola, Otter, Fellow). | **MEDIUM** | Yulu-specific: the labeled transcript flows through `agent-queue.json` to the coding agent. Largely "feed the speaker-tagged transcript + name map into the prompt." Prompt-library work, not new infra. See Dependencies. |
| **Playback stays in sync with speaker turns** | Yulu already has wavesurfer + seek-on-click; users expect to click a turn and hear it. | **LOW** | Existing `?seek=` + `AudioPlayer initialSeek` already support segment-time seeking. Wire speaker blocks to seek. Needs per-block timestamps (the merge format has them; the `Speaker A:` parser does not). |
| **Export includes speaker labels** | Plain-text/Markdown copy with `Speaker: text` is the baseline share format everywhere (Zoom VTT, Otter txt, BrassTranscripts). | **LOW** | Yulu's note is already Markdown on disk. Ensure the named (post-rename) transcript is what gets copied/exported, not the raw `Speaker N`. |

### Differentiators (Competitive Advantage)

Features that set Yulu apart. Several are *cheap because Yulu is local + single-user + agent-native* — lean into those.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **"You" is auto-known, never asked** | Yulu captures the **mic channel = the local user**. Every cloud tool makes you tag yourself; Yulu already knows. Set your name **once** (global), and `我`/mic auto-resolves in every meeting. | **LOW** | Mic-channel identity is structural (already separated in `merge_segments`). One global setting (in `config.json` / settings page) beats per-meeting self-tagging. A genuine local-first edge. |
| **Persistent named voices across meetings (fully on-device)** | Otter/Fireflies do cross-meeting voiceprints **in the cloud**. Yulu can offer "this voice = Alex" reuse using cam++ embeddings stored **locally**, never leaving the laptop — a privacy story competitors structurally cannot match. | **HIGH** | Requires storing speaker embeddings + a local enrollment/matching step + threshold tuning. Strong long-term differentiator, but real engine + storage work. **Defer past v1** — see anti-features for the naive version. |
| **Agent-driven speaker cleanup** | Because notes route through the user's coding agent, the agent can *propose* names from context ("the person who said 'as PM I'll own this' is likely the PM") and from calendar attendees Yulu already pulls (`gog`). User confirms. | **MEDIUM** | Fits the agent-native thesis exactly. The agent already sees the transcript; give it the attendee list + a "suggest speaker names" prompt. Lower risk than voiceprints; no new ML. |
| **Calendar-attendee name suggestions** | Yulu already pulls Google Calendar events. Offer attendee names as one-tap rename choices instead of free typing. | **LOW–MEDIUM** | Mirrors how Zoom/Teams/Fireflies map participant lists to labels — but Yulu does it locally. Reuses existing calendar data; UI is a dropdown of attendees on the rename popup. |
| **Talk-time / participation stats** | Otter & Fireflies headline "talk-time analytics." For a single user, the useful framing is **"how much did *I* talk vs. the room"** — self-coaching, not team surveillance. | **LOW** | Trivial from segment durations (already have start/end). Render a small per-speaker bar. Cheap, demoable, on-brand for single-user. |
| **Speaker color-coding** | Standard in polished transcript UIs; cheap legibility win. Stable color per speaker label. | **LOW** | Pure CSS + a label→color hash. Color follows the label/identity, not the name string, so it survives renames. |
| **Speaker names become first-class searchable** | Renames feed Yulu's existing glossary/vocab + FTS muscle (proper nouns already get special treatment in `TranscriptView`). "Show me everything Alex said." | **MEDIUM** | Ties speaker names into existing SQLite search/vocab. Builds on infra Yulu already has. |

### Anti-Features (Commonly Requested, Often Problematic)

Features that seem good but create problems for a local-first, single-user app. **Deliberately NOT built (or deferred).**

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| **Cloud voiceprint / speaker-ID service** (Otter/Fireflies-style global voice recognition) | "It should just know who everyone is across all my meetings." | Violates the hard local-first/privacy constraint (audio + transcripts never leave the laptop). Sends voice biometrics to a server. Off-limits by mandate. | On-device embedding match later (differentiator above), or agent-/calendar-driven name suggestion now. Never a cloud call. |
| **Live (real-time) diarization during recording** | "Show me who's talking *as* the meeting happens." | spike 002's engine is a **post-process** merge over completed segments; real-time clustering is a different, much harder problem. Granola itself does NOT do live diarization on desktop — only "Me/Them." Adds latency + a streaming clustering pipeline for marginal value in a notes tool. | Keep diarization a post-recording step. Live view stays the existing realtime mono / `我`-`对方` stream. |
| **Word-level speaker boundaries** (re-attribute mid-sentence) | "The label changed mid-sentence; let me split at the exact word." | Whisper segments are the atomic unit; sub-segment splitting fights the ASR's own boundaries and the timestamp-overlap merge. spike 002 already notes coverage gaps + hallucination artifacts at segment granularity. Disproportionate effort + brittle. | Segment-level reassign + an optional "split this block here" only if a block clearly spans a speaker change. Don't promise word precision. |
| **Mandatory speaker naming before you can read the note** | "Force me to label everyone so the note is clean." | Friction wall on the core flow. Diarization is a *hint* (spike 002: "treat speaker labels as a helpful hint," accuracy unproven). Blocking the note on labeling punishes the common case. | Auto-labels are always usable as-is. Naming is optional enrichment, never a gate. The summary must work with `Speaker N`. |
| **Team/shared speaker directory** | "Sync speaker names across my teammates' Yulus." | Yulu is explicitly single-user, no accounts, no Yulu-run sync (PROJECT.md Out of Scope). A shared directory implies a backend. | Per-user local name memory; if sharing is ever needed it rides the user's own folder sync (iCloud/Drive), like everything else. |
| **Auto-rewriting the transcript `.txt` on every rename** | "Just put the real names in the file." | `.transcript.txt` is overwritten by the cleanup prompt and regenerated on re-transcribe; baking names in is lossy and races those flows. Segment/coverage data already lives in separate JSON for this reason. | Keep names in a sidecar map applied at render/export. The canonical transcript stays label-based + reproducible. |
| **Per-speaker isolated audio / "play only Speaker 2"** | "Let me listen to just one person." | Requires source separation on a mixed stream — out of scope of cam++ diarization and the milestone. (Recall.ai: true per-speaker audio needs separate input streams, which Yulu lacks for the far end.) | Click-to-seek to that speaker's turns over the single mixed track. Good enough for a notes tool. |

---

## Feature Dependencies

```
Canonical speaker-line format (reconcile [MM:SS 我] vs /^Speaker [A-Z]:/)
    └──required by──> Speaker turns rendered as blocks
    └──required by──> Color-coding
    └──required by──> Click-to-seek per turn

Merge module emits per-segment speaker labels + timestamps  (engine; spike 002)
    └──required by──> Per-segment manual correction
                          └──required by──> Merge two labels into one
    └──required by──> Talk-time stats
    └──required by──> Speakers-in-summary

Speaker label → display-name map (persisted sidecar / SQLite)
    └──required by──> Rename-applies-to-all
    └──required by──> Merge labels (= rename-to-same)
    └──required by──> Named export
    └──required by──> Named transcript into agent-queue summary
    └──enhanced by──> Calendar-attendee suggestions
    └──enhanced by──> Agent-suggested names
    └──enhanced by──> "You" global self-name

On-device voice embeddings (cam++ vectors stored locally)
    └──required by──> Persistent named voices across meetings   (v2; defer)

Cloud voiceprint  ──conflicts──> Local-first/privacy mandate   (anti-feature; never)
Live diarization  ──conflicts──> Post-process Option-B engine  (anti-feature; defer)
```

### Dependency Notes

- **Canonical line format is the true first task.** Everything visual (blocks, color, seek) and the parser depend on one agreed format. The current `[MM:SS 我]` merge output and the `Speaker A:` UI parser disagree *today*. Pick one (recommend keeping the bracketed timestamp + label, e.g. `[00:03] Speaker 1: …` / `[00:03] 我: …`) and update both `merge_segments` and the parser. Small, but it blocks the chain — schedule it first.
- **The speaker-name map is the keystone.** Rename, merge, named export, and named-summary all collapse to "maintain `label → name` and apply it." Build this once; four features fall out. Persist as a per-recording sidecar to match Yulu's `{stem}.*` convention and the folder-sync/local-first model.
- **Per-segment correction forces a data-model choice.** Flat `.txt` can render labels but cannot cleanly support "reassign segment #42." Either (a) keep `.txt` as the human artifact and add a structured `{stem}.segments.json` (speaker, start, end, text) as the UI source of truth, or (b) persist only sparse per-segment *overrides* keyed by time range. Decide before building correction; it gates merge and stats too.
- **Speakers-in-summary is mostly prompt work, not infra.** The labeled (and name-mapped) transcript is what gets enqueued to `agent-queue.json`; the prompt-library entry instructs the agent to attribute action items/decisions to speakers. No new pipeline — extends ADR-004's existing prompt + `agent_queue_worker` path.
- **Calendar + agent suggestions both *enhance* the rename map**; neither is required for v1. They reuse data Yulu already has (calendar via `gog`, agent via the queue) and keep naming on-device.

---

## MVP Definition

> Brownfield milestone. "Launch With" = ship this milestone; later tiers = sequence within/after.

### Launch With (v0.6)

Minimum to make diarization real and trustworthy for a single local user.

- [ ] **Canonical speaker-line format + matching parser** — unblocks all rendering; fixes the pre-existing format mismatch.
- [ ] **N-speaker auto-labels from the merge module** — the actual diarization output (far-end stream split into `Speaker N`, mic stays "you"); usable with zero naming.
- [ ] **Speaker blocks + color-coding + click-to-seek** — legible attributed transcript over existing wavesurfer playback.
- [ ] **Rename (applies to all) + persist** via per-recording name map — the interaction users reach for immediately.
- [ ] **Merge two labels into one** — required recovery path for sherpa's known over-splitting on Chinese.
- [ ] **"You" global self-name** — cheap, structural, local-first edge; resolves the mic channel everywhere.
- [ ] **Speaker-attributed summary via the prompt library** — connects diarization to Yulu's core value (the note), through the existing agent-queue seam.
- [ ] **Named export/copy** — the post-rename transcript is what leaves the app.
- [ ] **Honest accuracy framing in UI copy** — spike 002 mandates "treat as a hint"; one line of UI honesty prevents "it's wrong" churn.

### Add After Validation (v0.6.x)

Once labels + renaming prove useful.

- [ ] **Per-segment manual correction** — reassign a single misattributed utterance. (Higher data-model cost; ship once the segment store exists and users ask.)
- [ ] **Talk-time / "how much did I talk" stats** — easy once segment durations are surfaced; add when there's a place to show it.
- [ ] **Calendar-attendee name suggestions** — one-tap rename from existing calendar data.
- [ ] **Agent-suggested speaker names** — agent proposes from transcript context + attendees; user confirms.
- [ ] **Speaker names feed search/vocab** — "everything Alex said," builds on existing FTS.

### Future Consideration (later milestones)

- [ ] **On-device persistent voiceprints** ("this voice = Alex across all meetings") — high effort (embedding storage + matching thresholds + enrollment UX); the privacy-preserving headline differentiator, but only worth it after labeling proves valuable.
- [ ] **Block split** (split one block at a speaker change) — only if segment-level correction proves insufficient.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Canonical line format + parser fix | HIGH (unblocks all) | LOW | P1 |
| N-speaker auto-labels (merge output) | HIGH | MEDIUM (engine, spike-scoped) | P1 |
| Speaker blocks + color + seek | HIGH | LOW | P1 |
| Rename-all + persist (name map) | HIGH | MEDIUM | P1 |
| Merge labels into one | HIGH (over-split recovery) | LOW–MEDIUM (rides name map) | P1 |
| "You" global self-name | MEDIUM–HIGH | LOW | P1 |
| Speaker-attributed summary (agent-queue) | HIGH | MEDIUM (prompt work) | P1 |
| Named export/copy | MEDIUM | LOW | P1 |
| Accuracy framing copy | MEDIUM (prevents churn) | LOW | P1 |
| Per-segment correction | HIGH | MEDIUM–HIGH (data model) | P2 |
| Talk-time stats | MEDIUM | LOW | P2 |
| Calendar-attendee suggestions | MEDIUM | LOW–MEDIUM | P2 |
| Agent-suggested names | MEDIUM–HIGH | MEDIUM | P2 |
| Speaker names → search/vocab | MEDIUM | MEDIUM | P2 |
| On-device persistent voiceprints | HIGH (privacy moat) | HIGH | P3 |
| Cloud voiceprint | — | — | NEVER (anti) |
| Live diarization | LOW (for notes) | HIGH | NEVER/defer (anti) |
| Word-level boundaries | LOW | HIGH | NEVER (anti) |

**Priority key:** P1 = must have for the v0.6 launch · P2 = add after validation · P3 = future milestone.

---

## Competitor Feature Analysis

| Feature | Otter.ai | Fireflies | Granola (desktop) | Zoom/Teams | Yulu's Approach |
|---------|----------|-----------|-------------------|------------|-----------------|
| Auto-labels | `Speaker 1/2` then names | `Speaker 1/2`; real names on Zoom/Meet | **"Me/Them"** (no real diarization on desktop) | `Speaker 1/2` in VTT; participant names when available | `我`(=you) + `Speaker N` for far-end voices — **you is structural, free** |
| Rename scope | One instance **or** all (choice) | One instance **or** "everywhere this speaker appears" (choice) | n/a (2 buckets) | Manual post-edit | **All-instances via name map** (v1); single-instance correction is P2 |
| Cross-meeting voice memory | Yes — **cloud** voiceprints | Yes — **cloud** | No | No | **On-device only**, deferred to v2 (privacy moat) |
| Talk-time stats | Yes (headline) | Yes (headline, per-participant) | No | Limited | **"How much did I talk"** single-user framing, P2 |
| Color-coding | Yes | Yes | Minimal | Minimal | Yes, stable per-label hash (P1) |
| Speakers → summary / action items | Yes (assigned action items) | Yes (owners + due dates) | Yes (uses your typed notes) | Basic | **Via agent-queue prompt** — agent attributes owners |
| Export with speakers | txt/docx/srt | txt/srt/json/API | Markdown note | **VTT** `<v Speaker>` | Markdown (named transcript); plain `Speaker: text` baseline |
| Live diarization | Streaming-ish | Bot-in-call | **No** (Me/Them only) | In-meeting captions | **No** — post-process by design |
| Source model | Mixed audio, cloud | Bot joins call, cloud | Mic + system audio, local-ish | Per-participant streams (best case) | Mic + system audio, **fully local**, far-end split by cam++ |

**Read of the field:**
- The **rename → applies-everywhere** map is universal table stakes; the single-vs-all *choice* (Otter/Fireflies) is a P2 nicety.
- **Cross-meeting voice identity is the premium feature everywhere — and everywhere it's cloud.** That's precisely the gap Yulu's local-first model can own later (P3), and the line not to cross now (no cloud voiceprint).
- **Granola validates Yulu's current state:** desktop Granola ships only "Me/Them," which is *exactly* what `merge_segments` already does. v0.6's job is to leapfrog that to true far-end N-speaker labeling — locally — which Granola desktop explicitly does not do.
- **Zoom/Teams** set the export bar: VTT `<v Speaker>` voice tags. Yulu's Markdown-native note already clears the practical sharing bar; VTT is nice-to-have, not required.

---

## Dependencies on Existing Yulu Surfaces (for the roadmapper)

| Existing surface | File(s) | What v0.6 needs from it | Effort signal |
|---|---|---|---|
| **2-speaker merge already exists** | `stt_daemon/transcript_merge.py` (`merge_segments`, `我`/`对方`) | Extend from channel-2 to voice-N; reconcile output format. **This is the foundation, not a greenfield.** | Medium |
| **Transcript render + speaker span** | `web/.../TranscriptView.tsx` (`SPEAKER_RE`, `.speaker`) | Fix parser to match canonical format; add blocks, color, seek, rename affordance. Already glossary-highlights. | Low–Medium |
| **Reader playback + seek** | `recordings.$stem.tsx` (`?seek=`, `AudioPlayer initialSeek`), wavesurfer | Wire speaker turns to existing seek; no new player. | Low |
| **Flat-text transcript storage** | `transcribe.py` → `{stem}.transcript.txt` / `.raw.transcript.txt` / `.mic.`/`.sys.` | Add a **name-map sidecar** + likely a **segments sidecar**; do NOT overwrite `.txt` per rename (cleanup prompt overwrites it). | Medium (data-model decision) |
| **Segment + coverage data already on disk** | `.realtime.json`, `.realtime.coverage.json`; daemon returns `segments` (start/end/text) | Source of per-segment timestamps for blocks/seek/stats/correction. Already produced — reuse. | Low |
| **Summary via agent-queue** | `agent-queue.json`, `agent_queue_worker.py`, ADR-004 | Feed name-mapped, speaker-tagged transcript; prompt instructs attribution. No new pipeline. | Medium (prompt) |
| **Prompt library** | `prompts/` SQLite, `PromptsCache` | Add/adjust a speaker-aware summary prompt; auto-run path unchanged. | Low–Medium |
| **Search / vocab** | `search/` FTS, `vocab/` SQLite, glossary | (P2) index speaker names → "what did X say"; names as vocab terms. | Medium |
| **Calendar attendees** | `run_calendar_services.py`, `gog` | (P2) attendee names as rename suggestions. | Low–Medium |
| **Settings page / config** | `routes/settings.tsx`, `config.json` | "Your name" global setting; diarization on/off + accuracy copy. | Low |

---

## Sources

- Otter.ai Help Center — Tagging speaker names, Rename a speaker, Speaker Identification Overview: https://help.otter.ai/hc/en-us/articles/360048465453-Tagging-speaker-names-in-a-conversation , https://help.otter.ai/hc/en-us/articles/21665980053655-Rename-a-speaker , https://help.otter.ai/hc/en-us/articles/21665587209367-Speaker-Identification-Overview
- Fireflies Knowledge Base — Edit speaker labels/names; Analytics & Conversation Intelligence: https://guide.fireflies.ai/articles/4994477228-how-to-edit-speaker-labels-or-names-in-a-transcript , https://guide.fireflies.ai/articles/2608597716-understand-fireflies-analytics-and-conversation-intelligence
- Granola Docs — How transcription works (desktop "Me/Them", no live diarization; iPhone-only speaker recognition): https://docs.granola.ai/help-center/taking-notes/transcription
- Granola Blog — Meeting action items / AI extraction (speaker-attributed commitments): https://www.granola.ai/blog/meeting-action-items-ai-extraction
- tl;dv Help Center — Speaker identification in transcript: https://intercom.help/tldv/en/articles/6171907-speaker-identification-in-transcript
- Descript Help — Detect and label speakers; Speakers (rename/merge, propagation): https://help.descript.com/hc/en-us/articles/10249423506061-Detect-and-label-speakers-in-your-transcript , https://help.descript.com/hc/en-us/articles/10164803814285-Speakers
- Trint / Reduct — speaker detection & renaming: https://info.trint.com/knowledge/speaker-detection-trint-help-center , https://help.reduct.video/en/articles/6640770-renaming-speakers
- Recall.ai — Speaker diarization (diarization vs identification; accuracy failure modes): https://www.recall.ai/blog/speaker-diarization
- BrassTranscripts — Multi-speaker transcript formats (TXT/SRT/VTT/JSON); action-items prompt: https://brasstranscripts.com/blog/multi-speaker-transcript-formats-srt-vtt-json , https://brasstranscripts.com/blog/meeting-transcript-action-items-ai-prompt
- Zoom/Teams transcript VTT speaker labels (export format): https://gotranscript.com/en/blog/fix-zoom-transcript-speaker-names-multi-speaker-labeling
- **Yulu codebase (primary, HIGH confidence):** `stt_daemon/transcript_merge.py`, `yulu_ui/web/src/components/TranscriptView.tsx`, `yulu_ui/web/src/routes/inbox/recordings.$stem.tsx`, `yulu_ui/src/routers/recordings.ts`, `transcribe.py`; spike `002-option-b-diarization-merge/REPORT.md`; `.planning/PROJECT.md`

---
*Feature research for: speaker diarization UX in a local-first single-user agent-native meeting recorder*
*Researched: 2026-06-06*
