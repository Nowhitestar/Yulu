# Phase I — Reader Audio Fix + Manual Transcription/Summary Triggers

**Date:** 2026-05-27
**Status:** Approved
**Scope:** Fix the audio-playback regression when switching voicemail items in the reader, and add "Re-transcribe" + "Re-generate summary" buttons so users can manually rerun the pipeline on existing recordings whose transcripts/summaries are missing or out of date.

---

## 1. Background

Phase F shipped the voicemail/meeting reader pages with a wavesurfer-based `<AudioPlayer>`. Two issues surfaced in real-machine use:

1. **Audio playback regression** — after playing voicemail A, navigating to voicemail B, then back to A, the play button no longer starts playback. State leaks across the `src` change.
2. **No manual pipeline trigger** — when transcription or summary fails to run automatically (e.g. `sttdaemon` was down, or `llm.command` returned an error), there's no UI way to retry. Users have to drop to a CLI.

Phase I addresses both. Phase H finalized the IA + visual system; Phase I rounds out reader functionality so the inbox-reader experience is genuinely production-grade.

## 2. Goals & Non-Goals

**Goals**

- `<AudioPlayer>` resets local state (`isPlaying`, `currentTime`, `duration`) on every `src` change, and disables Play until the new wavesurfer fires `ready`.
- Add backend tRPC mutations `voicemails.transcribe`, `voicemails.summarize`, `meetings.transcribe`, `meetings.summarize` that spawn the existing pipeline tools (or enqueue via agent-queue) and return a `jobId`.
- Track per-recording job status (`idle | transcribing | summarizing | failed`) in a process-local `Map<stem, JobStatus>` on the yulu_ui server.
- Expose `status` on `voicemails.list`, `voicemails.get`, `meetings.list`, `meetings.get` so the UI can drive button state from data.
- Add a `jobs` pubsub channel that publishes status transitions; web subscribes via existing WsProvider so the UI updates in real time without polling lag.
- New `<ReprocessButton>` component with 4 visual states: idle / running (spinner) / done (✓, briefly) / failed (red, tooltip with error).
- VoicemailReader + MeetingReader each get two buttons (Re-transcribe + Re-generate summary).
- For summary in `queue` mode (when `llm.command` is `null`), the server writes to `~/.config/yulu/agent-queue.json` and watches it for completion via fs.watch (reusing the inboxWatcher pattern).

**Non-Goals**

- **Voicemails + Meetings inbox unification** — Phase J.
- **macOS menu bar (StatusAgent) changes** — Phase J.
- **Progress bars / percentage estimates** during transcription — out of scope. We show "Running…" with an indeterminate spinner.
- **Job persistence across yulu_ui restart** — if the user restarts yulu_ui mid-transcription, the in-memory job Map clears; the child process may complete and write its output but the UI loses its tracking. Acceptable for v1.
- **Audio waveform visual polish** — Phase H spec § 4.13 mentioned waveform contrast tweaks; the user did not select them. Out of scope for I.
- **Realtime tab improvements** — only the main `transcript` + `summary` flows get manual triggers. Realtime is a live-recording feature and doesn't need a re-run.

## 3. Architecture

Phase I touches both backend (yulu_ui server) and frontend.

```
┌───────────────────────────────────────────────────────────────────┐
│ Phase I components                                                │
├───────────────────────────────────────────────────────────────────┤
│                                                                   │
│  yulu_ui server                       yulu_ui web                 │
│  ──────────────                       ───────────                 │
│  jobStatus.ts (new)                   <AudioPlayer> fix           │
│   - Map<stem, JobStatus>                - state reset on src      │
│   - transitions + publish                - disable until ready    │
│                                                                   │
│  routers/voicemails.ts (modify)       <ReprocessButton> (new)     │
│   - +transcribe mutation                - 4 visual states         │
│   - +summarize mutation                  - Lucide RefreshCw       │
│   - list/get add `status` field          - Lucide Sparkles        │
│                                                                   │
│  routers/meetings.ts (modify)         <VoicemailReader> integrate │
│   - same 2 mutations                  <MeetingReader> integrate   │
│   - same `status` field                                           │
│                                                                   │
│  jobRunner.ts (new)                   ws.ts (modify)              │
│   - spawn transcribe.py                 - "jobs" channel subscribe│
│   - spawn / enqueue summary                                       │
│   - fs.watch agent-queue.json                                     │
│   - publish to "jobs" channel                                     │
│                                                                   │
│  pubsub.ts (modify)                                               │
│   - +"jobs" channel type                                          │
└───────────────────────────────────────────────────────────────────┘
```

## 4. Components

### 4.1 `<AudioPlayer>` fix

`components/AudioPlayer.tsx` currently:

```tsx
useEffect(() => {
  // create wavesurfer, set wsRef
  ws.on("ready", () => setDuration(ws.getDuration()));
  // ...
  return () => { ws.destroy(); wsRef.current = null; };
}, [src]);
```

The bug: `isPlaying`, `currentTime`, `duration` are not reset when `src` changes. After unmount+remount, the new wavesurfer's `ready` event will eventually fire and set duration, but for ~200 ms the UI shows stale state. If the user clicks Play during that window, `ws.play()` may return a promise that rejects (audio not loaded), leaving the button visually "playing" while nothing happens.

**Fix:**
1. At the top of the effect (before creating the new wavesurfer), call `setIsPlaying(false); setCurrentTime(0); setDuration(0);`.
2. Disable the play button (`<button disabled>`) whenever `duration === 0`. Add CSS for the disabled state (lower opacity, no pointer cursor).
3. Track a `ready` boolean explicitly so `disabled` is independent of any future `duration` semantic (e.g. zero-length files).

Test (vitest, jsdom): mount with `src="A.wav"`, simulate play, re-render with `src="B.wav"`, assert `isPlaying === false` after rerender. Mock wavesurfer.

Test (Playwright): navigate to voicemail A → click Play → wait 1 s → navigate B → navigate back to A → click Play → assert button shows Pause icon (means play started).

### 4.2 `jobStatus.ts` — process-local state

New file `yulu/scripts/yulu_ui/src/jobStatus.ts`:

```ts
type Action = "transcribe" | "summarize";
type State = "idle" | "transcribing" | "summarizing" | "failed";

interface JobStatus {
  stem: string;
  action: Action;
  state: State;
  startedAt: number;
  jobId: string;
  error?: string;
  // For "queue" mode, the agent-queue.json entry id we're watching
  queueEntryId?: string;
}

export class JobRegistry {
  private map = new Map<string, JobStatus>();
  set(stem: string, status: JobStatus): void;
  get(stem: string): JobStatus | undefined;
  clear(stem: string): void;
  // For list-route responses
  snapshot(): Map<string, JobStatus>;
}
```

Singleton instance exported. The voicemails + meetings routers read it for the `status` field. The jobRunner writes to it on state transitions.

Stem is unique across voicemail+meeting domains because the file naming differs (`voicemail_YYYYMMDD_HHMMSS` vs `<title>_YYYYMMDD_HHMMSS`).

### 4.3 `jobRunner.ts` — spawn / enqueue + watch

New file `yulu/scripts/yulu_ui/src/jobRunner.ts`. Exports two functions:

```ts
runTranscribe({ stem, wavPath, config, paths, pubsub, registry }): Promise<{ jobId: string }>
runSummarize({ stem, wavPath, config, paths, pubsub, registry }): Promise<{ jobId: string; mode: "queue" | "direct" }>
```

`runTranscribe`:
1. Generate `jobId = randomUUID()`.
2. `registry.set(stem, { state: "transcribing", action: "transcribe", startedAt: Date.now(), jobId })`.
3. Publish `pubsub.jobs` event `{ stem, jobId, state: "transcribing" }`.
4. `child_process.spawn("python3", [pathToTranscribePy, wavPath], { detached: false, stdio: "pipe" })`.
5. On exit:
   - code 0 → `registry.clear(stem)`; publish `{ stem, jobId, state: "done" }`.
   - non-zero → `registry.set(stem, { ..., state: "failed", error: stderr.slice(0, 200) })`; publish failed event.
6. Return `{ jobId }`.

`runSummarize`:
1. Read `config.llm.command` from `ConfigManager`.
2. If `command === null` (queue mode):
   - Write a `summary_request` event to `~/.config/yulu/agent-queue.json` (append to the array). The existing `agent_queue_worker.py` will pick it up.
   - `registry.set(stem, { state: "summarizing", queueEntryId: <generated>, ... })`.
   - Start an fs.watch on `~/.config/yulu/agent-queue.json`; when our entry is removed (worker processed it), check whether `<stem>.summary.md` was written — if yes, clear; if no, mark failed.
   - Return `{ jobId, mode: "queue" }`.
3. If `command` is set (direct mode):
   - Spawn the command with transcript piped to stdin. Capture stdout → write to `<stem>.summary.md`.
   - Same registry pattern as runTranscribe.
   - Return `{ jobId, mode: "direct" }`.

**Path resolution** (the location of `transcribe.py`): use `paths.scriptDir` (a new path added to `paths.ts` if not present, pointing at `yulu/scripts/`). The yulu_ui server runs from `yulu/scripts/yulu_ui/dist/` per the LaunchAgent, so `transcribe.py` is one directory up.

**Concurrency**: if a job is already in flight for a stem, second mutation returns 409-equivalent error. Frontend prevents double-clicks via button-disabled state, but server enforces.

### 4.4 `pubsub.ts` — add `jobs` channel

Modify `yulu/scripts/yulu_ui/src/pubsub.ts`:

```ts
export type AppChannels = {
  // ... existing
  jobs: { stem: string; jobId: string; state: "transcribing" | "summarizing" | "done" | "failed"; error?: string };
};
```

And register the channel in the WebSocket multiplexer (`ws.ts`).

### 4.5 Router additions

**`routers/voicemails.ts`:**

Add to the existing list result:
```ts
status: registry.get(stem)?.state ?? "idle",
statusError: registry.get(stem)?.error,
```

Add 2 new mutations:
```ts
transcribe: publicProcedure
  .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
  .mutation(async ({ ctx, input }) => {
    const wavPath = join(ctx.paths.voicemailsDir, `${input.stem}.wav`);
    if (!existsSync(wavPath)) throw new TRPCError({ code: "NOT_FOUND", message: "WAV missing" });
    if (ctx.jobs.get(input.stem)) throw new TRPCError({ code: "CONFLICT", message: "Job already running" });
    return runTranscribe({ stem: input.stem, wavPath, ... });
  }),

summarize: publicProcedure
  .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
  .mutation(async ({ ctx, input }) => {
    const transcriptPath = join(ctx.paths.voicemailsDir, `${input.stem}.transcript.txt`);
    if (!existsSync(transcriptPath)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Transcript missing — run transcribe first" });
    if (ctx.jobs.get(input.stem)) throw new TRPCError({ code: "CONFLICT", message: "Job already running" });
    return runSummarize({ stem: input.stem, wavPath: ..., ... });
  }),
```

`ctx.jobs` is a new field in `AppContext` pointing at the singleton registry. Server bootstrap (`server.ts`) wires it.

**`routers/meetings.ts`:**

Same pattern. Meeting stems match `(\w+)_\d{8}_\d{6}` (the title-prefix can be anything alphanumeric).

### 4.6 `<ReprocessButton>` component

New `components/ReprocessButton.tsx` + `.css`:

```ts
interface ReprocessButtonProps {
  label: string;                        // "Re-transcribe" or "Re-generate summary"
  icon: ReactNode;                      // Lucide RefreshCw or Sparkles
  state: "idle" | "running" | "done" | "failed";
  error?: string;                       // shown as tooltip when state="failed"
  onClick: () => void;
  disabled?: boolean;                   // e.g. transcribe disabled when WAV missing
  disabledReason?: string;              // tooltip when disabled
}
```

Visual states (Ayu palette):
- **idle** — neutral border, label + icon. Click → onClick.
- **running** — accent border + light glow, label changes to "Running…", icon replaced with Lucide `Loader2` rotating via CSS animation. Button disabled.
- **done** — green border + Lucide `Check`, holds for 2 s then transitions back to idle. Click ignored during the hold.
- **failed** — red border + Lucide `AlertCircle`, hover shows error tooltip. Click → re-attempt (returns to idle).

Disabled state when prop says so: muted opacity, hover shows `disabledReason`.

Done → idle transition uses a `setTimeout(2000)` cleared on unmount.

Tests (vitest, ~10 cases):
- Renders idle by default
- State="running" disables button and shows spinner
- State="failed" shows error in tooltip
- State="done" auto-transitions back to idle after 2 s (use vi.useFakeTimers)
- Click in idle calls onClick
- Click in running does NOT call onClick
- Click in failed calls onClick
- Disabled prop prevents click + shows tooltip

### 4.7 Reader integration

**`<VoicemailReader>`** + **`<MeetingReader>`** (paths in `routes/inbox/voicemails.$stem.tsx` and `meetings.$stem.tsx`):

Add a small toolbar above the audio player:

```tsx
<div className="reader-actions">
  <ReprocessButton
    label="Re-transcribe"
    icon={<RefreshCw size={14} strokeWidth={1.75} />}
    state={voicemail.status === "transcribing" ? "running" : voicemail.status === "failed" && lastAction === "transcribe" ? "failed" : "idle"}
    error={voicemail.statusError}
    onClick={() => transcribeMutation.mutate({ stem })}
    disabled={!hasWav}
    disabledReason={!hasWav ? "Original WAV file missing" : undefined}
  />
  <ReprocessButton
    label="Re-generate summary"
    icon={<Sparkles size={14} strokeWidth={1.75} />}
    state={voicemail.status === "summarizing" ? "running" : voicemail.status === "failed" && lastAction === "summarize" ? "failed" : "idle"}
    error={voicemail.statusError}
    onClick={() => summarizeMutation.mutate({ stem })}
    disabled={!hasTranscript}
    disabledReason={!hasTranscript ? "Transcript required first — click Re-transcribe" : undefined}
  />
</div>
```

`lastAction` is local component state tracking which button was last clicked (so the right one shows the failed state).

Subscribe to `jobs` WS channel via `useWsChannel`:

```ts
useWsChannel("jobs", (msg) => {
  if (msg.stem !== stem) return;
  if (msg.state === "done" || msg.state === "failed") {
    qc.invalidateQueries({ queryKey: [["voicemails", "get"]] });
    qc.invalidateQueries({ queryKey: [["voicemails", "list"]] });
  }
});
```

This way the reader refetches immediately on completion, not waiting for the next 5 s polling tick.

### 4.8 Reader list integration

`<VoicemailsList>` and `<MeetingsList>` already render a row per recording. Optionally show a small "transcribing…" / "summarizing…" hint on the row when `row.status !== "idle"`. Use a subtle `--accent` colored text tag.

Phase H removed sidebar counts — this is the new "live activity" surface.

## 5. Data Flow

```
User clicks "Re-transcribe" on voicemail A:
 ─▶ React Query mutation → POST /trpc/voicemails.transcribe { stem: "A" }
     ─▶ Backend validates WAV exists, no in-flight job
     ─▶ runTranscribe spawns child process (transcribe.py)
     ─▶ jobs.set(A, { state: "transcribing", ... })
     ─▶ pubsub.publish("jobs", { stem: "A", state: "transcribing", jobId: "..." })
     ─▶ Returns { jobId } to client
 ─▶ WS pushes "transcribing" event to ALL connected clients
     ─▶ Reader's useWsChannel handler invalidates voicemails.get
     ─▶ list/get refetch returns status: "transcribing"
     ─▶ ReprocessButton renders "Running…" with spinner

[child process running for N minutes]

When child process exits:
 ─▶ jobRunner reads exit code
     ─▶ exit 0: jobs.clear(A); pubsub.publish("jobs", { stem: "A", state: "done", jobId })
     ─▶ exit !0: jobs.set(A, { state: "failed", error: stderr }); publish "failed"
 ─▶ Reader's WS handler invalidates voicemails.get → new transcript loads
 ─▶ ReprocessButton flashes "done ✓" for 2s, then idle (or "failed" + tooltip)
```

## 6. Error Handling

- **No WAV file** → mutation throws TRPCError NOT_FOUND. Button stays disabled (disabledReason="Original WAV file missing").
- **Transcribe in progress, user clicks again** → mutation throws CONFLICT 409. Frontend treats as success (button already shows Running).
- **Transcribe in progress, user navigates away + back** → reader fetches voicemails.get on mount, sees status="transcribing", button correctly shows Running.
- **Server restart during job** → in-memory registry empties; child process may still complete in background and write output file. Reader on next fetch sees status="idle" (registry empty) but the new transcript file is present — UX shows "done" implicitly via content appearing. No false-positive Running state after restart.
- **transcribe.py exits non-zero** → registry → failed; stderr captured (first 200 chars) shown in button tooltip.
- **Summary "queue" mode and agent_queue_worker not running** → fs.watch on agent-queue.json times out (60 s). Registry → failed with error "agent queue worker not processing — check `yulu doctor`".
- **WS disconnect during a job** → status is still in voicemails.get response; list polling (5 s) eventually picks up the final state. Worst case 5 s delay.
- **Multiple browser tabs open** → both subscribe to `jobs` WS channel; both reflect state changes consistently.

## 7. Testing Strategy

| Layer | Test |
|---|---|
| Backend unit | `jobStatus.ts` Map set/get/clear; `jobRunner` spawn + exit-code handling (mocked child_process) |
| Backend integration | `voicemails.transcribe` mutation rejects when WAV missing / job in progress; `voicemails.list` returns correct `status` field |
| Frontend unit | `<ReprocessButton>` 4 states + transitions (vi.useFakeTimers for done→idle); `<AudioPlayer>` resets state on src change + disables Play while not ready |
| Frontend integration | VoicemailReader integration: button triggers mutation, status updates after `jobs` WS event, content refetches |
| E2E (Playwright, local-only) | A→B→A audio playback works after switching; Re-transcribe button on a voicemail with no transcript becomes available after transcript file appears (use a tiny test WAV with stubbed transcribe.py) |
| Real machine | Trigger an actual Re-transcribe on a real voicemail; observe Running→Done; verify new transcript file written |

## 8. Open Questions

None. Resolved during brainstorming:

- ✅ Audio bug: hypothesis-first (state reset + disable-until-ready), revisit if real-machine smoke shows another root cause.
- ✅ `status` field returned by both `list` and `get` so the inbox list row can also show running state.
- ✅ Queue-mode summary tracking: fs.watch agent-queue.json (option a) — reuses inboxWatcher pattern, surfaces both "completed" and "failed" outcomes.
- ✅ No job persistence across yulu_ui restart (v1 limit).
- ✅ No progress percentage (just indeterminate Running…).

## 9. Task Breakdown (preview for plan)

6 tasks. TDD where applicable.

| # | Task |
|---|---|
| I.1 | Backend: `jobStatus.ts` + `jobRunner.ts` + `pubsub.ts` "jobs" channel + `paths.ts` scriptDir |
| I.2 | Backend: `voicemails.transcribe / summarize` mutations + `status` field on list/get; same for meetings |
| I.3 | `<ReprocessButton>` component (4 states, Lucide icons, fake-timer test for done→idle) |
| I.4 | `<AudioPlayer>` bug fix (state reset + disabled-until-ready) + vitest |
| I.5 | `<VoicemailReader>` + `<MeetingReader>` integration: 2 buttons each, WS subscription, list row status hint |
| I.6 | Playwright e2e (audio switch + Re-transcribe stubbed) + real-machine smoke + push + PR update to A–I |

## 10. Future Phases (reminder)

- **Phase J — Recordings inbox unification** (~6 tasks). Includes:
  - macOS menu bar (StatusAgent.app) entries renamed/consolidated to match new unified "Recordings" naming.
  - Backend `recordings.list` facade + `type: "voicemail" | "meeting"` field.
  - Frontend `<RecordingsList>` replaces the two list components.
  - Routing alias: `/inbox/voicemails` / `/inbox/meetings` → `/inbox?type=...` or unified `/inbox/:stem`.
  - Realtime tab in reader conditional on `type === "meeting"`.
  - inboxWatcher.ts simplification.

Phase J should not start until Phase I is in.

---
