import { execFile } from "node:child_process";
import { mkdtempSync, openAsBlob, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { envWithFallbackPath, resolveExecutable } from "./executables.js";
import type { GlossaryContract } from "./glossaryContract.js";
import { AudioEvidence } from "./audioEvidence.js";
import type {
  CaptionSource,
  CaptionSourceUpdate,
  StreamingCaptionEngine,
  StreamingCaptionOptions,
  StreamingCaptionUpdate,
} from "./localCaptionEngine.js";
import type { TranscriptionLanguage } from "./realtimeTranscription.js";
import { captionsLikelyDuplicate, cleanTranscriptText, dedupeTranscriptSegment, hasVoice } from "./realtimeTranscription.js";
import { XaiCredentialManager, type XaiCredential } from "./xaiCredentials.js";

function providerFor(source: XaiCredential["source"] | null): string {
  return source === "api-key" ? "xai-api-key:yulu" : "xai-oauth:yulu";
}

interface XaiTranscriptEvent {
  type?: string;
  text?: string;
  is_final?: boolean;
  speech_final?: boolean;
  channel_index?: number;
  start?: number;
  duration?: number;
  words?: Array<{ text: string; start: number; end: number }>;
  message?: string;
}

interface XaiSttResponse {
  text?: string;
  language?: string;
  duration?: number;
  detail?: string;
  error?: string | { message?: string };
}

interface FinalTranscriptSegment {
  text: string;
  startMs: number;
  endMs: number;
  generation: number;
}

const SOURCE_BY_CHANNEL: Record<number, CaptionSource> = { 0: "mic", 1: "system" };
const XAI_STT_URL = "https://api.x.ai/v1/stt";
const XAI_STT_TIMEOUT_MS = 30 * 60_000;
const XAI_STT_MAX_UPLOAD_BYTES = 500_000_000;
const XAI_STT_SEGMENT_SEC = 10 * 60;
const REALTIME_STALL_VOICE_MS = 12_000;
const REALTIME_REPLAY_MS = 15_000;
const REALTIME_RECONNECT_MIN_MS = 1_000;
const REALTIME_RECONNECT_MAX_MS = 5_000;
const STEREO_PCM_BYTES_PER_MS = 64;
const execFileAsync = promisify(execFile);

function interleaveStereo(mic: Buffer | undefined, system: Buffer | undefined): Buffer {
  const frames = Math.max(mic?.length ?? 0, system?.length ?? 0) >> 1;
  const output = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame += 1) {
    const inputOffset = frame * 2;
    output.writeInt16LE(inputOffset + 1 < (mic?.length ?? 0) ? mic!.readInt16LE(inputOffset) : 0, frame * 4);
    output.writeInt16LE(inputOffset + 1 < (system?.length ?? 0) ? system!.readInt16LE(inputOffset) : 0, frame * 4 + 2);
  }
  return output;
}

function audioMs(pcm: Buffer | undefined): number {
  return Math.floor((pcm?.length ?? 0) / 32);
}

function xaiLanguage(language: TranscriptionLanguage): string | null {
  return language === "en" || language === "ja" ? language : null;
}

function keyterms(glossary?: GlossaryContract): string[] {
  return [...new Set((glossary?.prompt.split("，") ?? [])
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && term.length <= 50))].slice(0, 100);
}

function realtimeUrl(language: TranscriptionLanguage, glossary?: GlossaryContract, dictation = false): URL {
  const url = new URL("wss://api.x.ai/v1/stt");
  url.searchParams.set("sample_rate", "16000");
  url.searchParams.set("encoding", "pcm");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("endpointing", "800");
  if (!dictation) url.searchParams.set("multichannel", "true");
  url.searchParams.set("channels", dictation ? "1" : "2");
  const formattedLanguage = xaiLanguage(language);
  if (formattedLanguage) url.searchParams.set("language", formattedLanguage);
  if (!dictation) for (const term of keyterms(glossary)) url.searchParams.append("keyterm", term);
  return url;
}

function isRetryableRealtimeStartError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /TLS|socket|ECONN|ETIMEDOUT|ENET|EAI_AGAIN|network|closed early|timed out/i.test(message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
  });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

export class XaiAudioClient implements StreamingCaptionEngine {
  private socket: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private done: Promise<void> | null = null;
  private doneResolve: (() => void) | null = null;
  private doneReject: ((error: Error) => void) | null = null;
  private readonly partial: Record<CaptionSource, string> = { mic: "", system: "" };
  private readonly pendingStable: Record<CaptionSource, CaptionSourceUpdate["stable"]> = { mic: [], system: [] };
  private readonly pendingReplace: Record<CaptionSource, boolean> = { mic: false, system: false };
  private readonly elapsedMs: Record<CaptionSource, number> = { mic: 0, system: 0 };
  private readonly finalText: Record<CaptionSource, string> = { mic: "", system: "" };
  private readonly finalSegments: Record<CaptionSource, FinalTranscriptSegment[]> = { mic: [], system: [] };
  private readonly captionChunks: Record<CaptionSource, FinalTranscriptSegment[]> = { mic: [], system: [] };
  private readonly stableCaption: Record<CaptionSource, CaptionSourceUpdate["stableCaption"]> = { mic: null, system: null };
  private doneChannels = new Set<number>();
  private realtimeUrl: URL | null = null;
  private realtimeGeneration = 0;
  private sessionBaseMs = 0;
  private voiceWithoutTranscriptMs = 0;
  private replayChunks: Buffer[] = [];
  private replayBytes = 0;
  private reconnectNotBeforeMs = 0;
  private reconnectDelayMs = REALTIME_RECONNECT_MIN_MS;
  private lastStreamingError: Error | null = null;
  private lifecycleGeneration = 0;
  private dictation = false;
  private evidence: Record<CaptionSource, AudioEvidence> | null = null;
  private finalizedMicMs = 0;
  private finishResolve: (() => void) | null = null;

  constructor(private readonly credentials: XaiCredentialManager) {}

  get provider(): string {
    return providerFor(this.credentials.cachedStatus().source);
  }

  async warm(): Promise<void> {
    await this.credentials.resolve();
  }

  async start(language: TranscriptionLanguage, options: StreamingCaptionOptions & { glossary?: GlossaryContract } = {}): Promise<void> {
    const aborting = this.abort();
    const generation = this.lifecycleGeneration;
    await aborting;
    if (generation !== this.lifecycleGeneration) throw new Error("xAI streaming STT was cancelled");
    this.partial.mic = "";
    this.partial.system = "";
    this.pendingStable.mic = [];
    this.pendingStable.system = [];
    this.pendingReplace.mic = false;
    this.pendingReplace.system = false;
    this.elapsedMs.mic = 0;
    this.elapsedMs.system = 0;
    this.finalText.mic = "";
    this.finalText.system = "";
    this.finalSegments.mic = [];
    this.finalSegments.system = [];
    this.captionChunks.mic = [];
    this.captionChunks.system = [];
    this.stableCaption.mic = null;
    this.stableCaption.system = null;
    this.realtimeGeneration = 0;
    this.sessionBaseMs = 0;
    this.voiceWithoutTranscriptMs = 0;
    this.replayChunks = [];
    this.replayBytes = 0;
    this.dictation = options.dictation === true;
    this.evidence = { mic: new AudioEvidence(), system: new AudioEvidence() };
    this.finalizedMicMs = 0;

    const url = realtimeUrl(language, options.glossary, this.dictation);
    this.realtimeUrl = url;

    await this.connectRealtimeWithRetry(url);
  }

  private async connectRealtimeWithRetry(url: URL): Promise<boolean> {
    const generation = this.lifecycleGeneration;
    if (Date.now() < this.reconnectNotBeforeMs) return false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const credential = await this.credentials.resolve();
        if (generation !== this.lifecycleGeneration) throw new Error("xAI streaming STT was cancelled");
        await this.connectRealtime(credential, url);
        if (generation !== this.lifecycleGeneration) throw new Error("xAI streaming STT was cancelled");
        this.reconnectNotBeforeMs = 0;
        this.reconnectDelayMs = REALTIME_RECONNECT_MIN_MS;
        this.lastStreamingError = null;
        return true;
      } catch (error) {
        if (generation !== this.lifecycleGeneration) throw error;
        this.disconnectSocket();
        if (!isRetryableRealtimeStartError(error)) throw error;
        if (attempt > 0) {
          this.lastStreamingError = error instanceof Error ? error : new Error(String(error));
          this.reconnectNotBeforeMs = Date.now() + this.reconnectDelayMs;
          this.reconnectDelayMs = Math.min(REALTIME_RECONNECT_MAX_MS, this.reconnectDelayMs * 2);
          return false;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        if (generation !== this.lifecycleGeneration) throw new Error("xAI streaming STT was cancelled");
      }
    }
    return false;
  }

  private async connectRealtime(credential: XaiCredential, url: URL): Promise<void> {
    this.doneChannels = new Set();
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.done = new Promise<void>((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });
    void this.done.catch(() => {});
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${credential.accessToken}` },
      handshakeTimeout: 15_000,
    });
    this.socket = socket;
    socket.on("message", (data) => {
      if (this.socket === socket) this.handleMessage(data.toString());
    });
    socket.once("error", (error) => {
      if (this.socket === socket) this.fail(error);
    });
    socket.once("close", () => {
      if (this.socket !== socket) return;
      if (this.doneChannels.size >= (this.dictation ? 1 : 2)) this.doneResolve?.();
      else this.fail(new Error("xAI streaming STT connection closed early"));
    });
    await withTimeout(this.ready, 15_000, "xAI streaming STT start timed out");
  }

  async feed(chunks: Partial<Record<CaptionSource, Buffer>>): Promise<StreamingCaptionUpdate> {
    const generation = this.lifecycleGeneration;
    const pcm = this.dictation ? chunks.mic ?? Buffer.alloc(0) : interleaveStereo(chunks.mic, chunks.system);
    if (chunks.mic) this.evidence?.mic.append(chunks.mic);
    if (!this.dictation && chunks.system) this.evidence?.system.append(chunks.system);
    this.elapsedMs.mic += audioMs(chunks.mic);
    this.elapsedMs.system += audioMs(chunks.system);
    this.appendReplay(pcm);
    const voicedMs = Math.max(audioMs(chunks.mic), audioMs(chunks.system));
    if ((chunks.mic && hasVoice(chunks.mic)) || (chunks.system && hasVoice(chunks.system))) {
      this.voiceWithoutTranscriptMs += voicedMs;
    }
    const socketOpen = this.socket?.readyState === WebSocket.OPEN;
    if (pcm.length > 0 && (!socketOpen || this.voiceWithoutTranscriptMs >= REALTIME_STALL_VOICE_MS)) {
      await this.reconnectRealtime();
    } else if (pcm.length > 0) {
      this.socket!.send(pcm);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (generation !== this.lifecycleGeneration) throw new Error("xAI streaming STT was cancelled");
    return this.drain();
  }

  async finish(): Promise<StreamingCaptionUpdate> {
    const generation = this.lifecycleGeneration;
    const socket = this.socket;
    if (!socket) {
      if (this.lastStreamingError) throw this.lastStreamingError;
      return { updates: {} };
    }
    const finalized = new Promise<void>((resolve) => { this.finishResolve = resolve; });
    if (socket.readyState === WebSocket.OPEN) {
      if (this.dictation) socket.send(JSON.stringify({ type: "Finalize" }));
      socket.send(JSON.stringify({ type: "audio.done" }));
      this.resolveFinalizedTail();
    }
    try {
      await withTimeout(this.dictation ? Promise.race([this.done!, finalized]) : this.done!, 30_000, "xAI streaming STT finish timed out");
      if (generation !== this.lifecycleGeneration) throw new Error("xAI streaming STT was cancelled");
      return this.drain();
    } finally {
      this.finishResolve = null;
      socket.close();
      if (this.socket === socket) {
        this.socket = null;
        this.realtimeUrl = null;
        this.replayChunks = [];
        this.replayBytes = 0;
      }
    }
  }

  async abort(): Promise<void> {
    this.lifecycleGeneration += 1;
    const error = new Error("xAI streaming STT was cancelled");
    this.readyReject?.(error);
    this.doneReject?.(error);
    this.readyReject = null;
    this.doneReject = null;
    this.finishResolve = null;
    this.disconnectSocket();
    this.realtimeUrl = null;
    this.replayChunks = [];
    this.replayBytes = 0;
    this.reconnectNotBeforeMs = 0;
    this.reconnectDelayMs = REALTIME_RECONNECT_MIN_MS;
    this.lastStreamingError = null;
  }

  async close(): Promise<void> {
    await this.abort();
  }

  async transcribeFile(
    audioPath: string,
    language: TranscriptionLanguage,
    glossary?: GlossaryContract,
  ): Promise<{ transcript: string; provider: string; chunks: number; language: TranscriptionLanguage }> {
    const tempRoot = mkdtempSync(join(tmpdir(), "yulu-xai-stt-"));
    const uploadTemplate = join(tempRoot, "audio-%04d.flac");
    try {
      await execFileAsync(resolveExecutable("ffmpeg"), [
        "-y", "-v", "error", "-i", audioPath,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac",
        "-f", "segment", "-segment_time", String(XAI_STT_SEGMENT_SEC),
        "-reset_timestamps", "1", uploadTemplate,
      ], { env: envWithFallbackPath(), timeout: 5 * 60_000 });
      const uploadPaths = readdirSync(tempRoot)
        .filter((name) => /^audio-\d+\.flac$/.test(name))
        .sort()
        .map((name) => join(tempRoot, name));
      if (uploadPaths.length === 0) throw new Error("xAI transcription audio segmentation produced no audio");
      let transcript = "";
      let provider = "xai-oauth";

      for (const uploadPath of uploadPaths) {
        if (statSync(uploadPath).size > XAI_STT_MAX_UPLOAD_BYTES) {
          throw new Error("xAI transcription audio segment exceeds the 500 MB upload limit after compression");
        }
        let segmentTranscript = "";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const credential = await this.credentials.resolve();
          provider = providerFor(credential.source);
          const form = new FormData();
          const formattedLanguage = xaiLanguage(language);
          if (formattedLanguage) {
            form.append("format", "true");
            form.append("language", formattedLanguage);
          }
          for (const term of keyterms(glossary)) {
            form.append("keyterm", term);
          }
          form.append("file", await openAsBlob(uploadPath, { type: "audio/flac" }), "audio.flac");
          try {
            const response = await fetch(XAI_STT_URL, {
              method: "POST",
              headers: { Authorization: `Bearer ${credential.accessToken}` },
              body: form,
              signal: AbortSignal.timeout(XAI_STT_TIMEOUT_MS),
            });
            const payload = await response.json().catch(() => ({})) as XaiSttResponse;
            if (!response.ok) {
              if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
                await new Promise<void>((resolve) => setTimeout(resolve, 500));
                continue;
              }
              const detail = payload.detail ||
                (typeof payload.error === "string" ? payload.error : payload.error?.message) ||
                (response.status === 413
                  ? "audio exceeds xAI's 500 MB upload limit"
                  : response.status >= 500 ? "xAI service returned an internal error after retry" : "unknown error");
              throw new Error(`xAI transcription failed (${response.status}): ${detail}`);
            }
            segmentTranscript = cleanTranscriptText(String(payload.text ?? ""));
            if (!segmentTranscript) throw new Error("xAI returned an empty transcript");
            break;
          } catch (error) {
            if (attempt === 0 && error instanceof TypeError) {
              await new Promise<void>((resolve) => setTimeout(resolve, 500));
              continue;
            }
            throw error;
          }
        }
        if (!segmentTranscript) throw new Error("xAI transcription failed after retry");
        const addition = dedupeTranscriptSegment(transcript, segmentTranscript);
        if (addition) transcript = cleanTranscriptText([transcript, addition].filter(Boolean).join("\n"));
      }
      return { transcript, provider, chunks: uploadPaths.length, language };
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  async testCredential(): Promise<{ ok: true; provider: string; credentialSource: XaiCredential["source"] }> {
    const credential = await this.credentials.resolve();
    const wav = Buffer.alloc(44 + 32_000);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16_000, 24);
    wav.writeUInt32LE(32_000, 28);
    wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(32_000, 40);
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "probe.wav");
    const response = await fetch(XAI_STT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${credential.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`xAI 音频权限验证失败（HTTP ${response.status}）`);
    return { ok: true, provider: providerFor(credential.source), credentialSource: credential.source };
  }

  async testRealtimeCredential(): Promise<{
    ok: true;
    provider: string;
    credentialSource: XaiCredential["source"];
  }> {
    const credential = await this.credentials.resolve();
    const probe = new XaiAudioClient(this.credentials);
    try {
      await probe.connectRealtime(credential, realtimeUrl("auto"));
      return {
        ok: true,
        provider: providerFor(credential.source),
        credentialSource: credential.source,
      };
    } finally {
      await probe.abort();
    }
  }

  credentialStatus() {
    return this.credentials.cachedStatus();
  }

  private handleMessage(raw: string): void {
    let event: XaiTranscriptEvent;
    try { event = JSON.parse(raw) as XaiTranscriptEvent; }
    catch { return; }
    if (event.type === "transcript.created") {
      this.readyResolve?.();
      return;
    }
    if (event.type === "error") {
      this.fail(new Error(event.message || "xAI streaming STT failed"));
      return;
    }
    const channel = Number(event.channel_index ?? 0);
    const source = SOURCE_BY_CHANNEL[channel];
    if (!source || (this.dictation && source !== "mic")) return;
    const evidence = this.evidence?.[source];
    const startMs = this.sessionBaseMs + Math.max(0, Number(event.start) || 0) * 1000;
    const endMs = Number.isFinite(event.duration) ? startMs + Number(event.duration) * 1000 : this.elapsedMs[source];
    const grounded = !evidence || (evidence.overlaps(startMs, endMs) &&
      (!event.words?.length || event.words.every((word) => !/[\p{L}\p{N}]/u.test(word.text) || evidence.overlaps(
        this.sessionBaseMs + word.start * 1000, this.sessionBaseMs + word.end * 1000))));
    // Reject words from silent channels/intervals, including authoritative done
    // revisions, so a silent result cannot overwrite accepted speech.
    const text = grounded ? cleanTranscriptText(String(event.text ?? "")) : "";
    if (event.type === "transcript.partial") {
      if (text) this.voiceWithoutTranscriptMs = 0;
      if (event.is_final) {
        this.partial[source] = "";
        const caption = this.utteranceCaption(source, text, event);
        if (caption.text) this.stableCaption[source] = caption;
        this.commitFinalRevision(source, text, event);
        if (grounded && source === "mic" && event.speech_final === true && Number.isFinite(event.duration)) {
          this.finalizedMicMs = Math.max(this.finalizedMicMs, endMs);
          this.resolveFinalizedTail();
        }
      } else {
        this.partial[source] = this.utteranceCaption(source, text, event).text;
      }
      return;
    }
    if (event.type === "transcript.done") {
      if (text) this.voiceWithoutTranscriptMs = 0;
      if (text) this.commitFinalRevision(source, text, event, true);
      this.partial[source] = "";
      this.doneChannels.add(channel);
      if (this.doneChannels.size >= (this.dictation ? 1 : 2)) this.doneResolve?.();
    }
  }

  private resolveFinalizedTail(): void {
    const evidence = this.evidence?.mic;
    if (this.dictation && evidence && !this.partial.mic &&
        (!evidence.lastVoiceMs || (this.finalText.mic && this.finalizedMicMs >= evidence.lastVoiceMs))) {
      this.finishResolve?.();
    }
  }

  private drain(): StreamingCaptionUpdate {
    const updates: StreamingCaptionUpdate["updates"] = {};
    for (const source of ["mic", "system"] as const) {
      updates[source] = {
        partial: this.partial[source],
        stable: this.pendingStable[source].splice(0),
        stableCaption: this.stableCaption[source],
        audioMs: this.elapsedMs[source],
        ...(this.pendingReplace[source] ? { replaceStable: true } : {}),
      };
      this.pendingReplace[source] = false;
    }
    return { updates };
  }

  private utteranceCaption(source: CaptionSource, text: string, event: XaiTranscriptEvent): { text: string; endMs: number } {
    const start = Number(event.start);
    const duration = Number(event.duration);
    const hasRange = Number.isFinite(start) && Number.isFinite(duration) && duration > 0;
    const chunks = this.captionChunks[source];
    const startMs = hasRange ? this.sessionBaseMs + Math.round(start * 1_000)
      : chunks.at(-1)?.endMs ?? this.sessionBaseMs;
    const endMs = hasRange ? this.sessionBaseMs + Math.round((start + duration) * 1_000)
      : this.elapsedMs[source];
    // A speech-final event already stitches/corrects every chunk in this utterance.
    // A missing flag is treated as a standalone final for older server responses.
    if (event.is_final && event.speech_final !== false) {
      this.captionChunks[source] = [];
      return { text, endMs };
    }
    const segments = chunks.filter((chunk) => !hasRange || endMs <= chunk.startMs || startMs >= chunk.endMs);
    if (text) segments.push({ text, startMs, endMs, generation: this.realtimeGeneration });
    segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    if (event.is_final) this.captionChunks[source] = segments;
    let combined = "";
    for (const segment of segments) {
      const addition = dedupeTranscriptSegment(combined, segment.text);
      if (!addition) continue;
      const separator = /[a-z0-9]$/i.test(combined) && /^[a-z0-9]/i.test(addition) ? " " : "";
      combined += separator + addition;
    }
    return { text: combined, endMs };
  }

  private commitFinalRevision(
    source: CaptionSource,
    text: string,
    event: Pick<XaiTranscriptEvent, "start" | "duration">,
    authoritative = false,
  ): void {
    if (!text) return;
    const start = Number(event.start);
    const duration = Number(event.duration);
    const hasRange = Number.isFinite(start) && Number.isFinite(duration) && duration > 0;
    const generationSegments = this.finalSegments[source]
      .filter((segment) => segment.generation === this.realtimeGeneration);
    const startMs = hasRange
      ? this.sessionBaseMs + Math.max(0, Math.round(start * 1_000))
      : generationSegments.at(-1)?.endMs ?? this.sessionBaseMs;
    const endMs = hasRange
      ? this.sessionBaseMs + Math.max(0, Math.round((start + duration) * 1_000))
      : this.elapsedMs[source];
    let segments = this.finalSegments[source];
    const replacesAll = authoritative || (!hasRange && captionsLikelyDuplicate(this.finalText[source], text));
    if (replacesAll) {
      segments = segments.filter((segment) => segment.generation !== this.realtimeGeneration);
    } else if (hasRange) {
      segments = segments.filter((segment) => segment.generation !== this.realtimeGeneration ||
        endMs <= segment.startMs || startMs >= segment.endMs);
    }
    segments.push({ text, startMs, endMs, generation: this.realtimeGeneration });
    segments.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    this.finalSegments[source] = segments;
    let combined = "";
    for (const segment of segments) {
      const addition = dedupeTranscriptSegment(combined, segment.text);
      if (addition) combined = cleanTranscriptText([combined, addition].filter(Boolean).join("\n"));
    }
    if (!combined || combined === this.finalText[source]) return;
    this.finalText[source] = combined;
    this.pendingStable[source] = [{ text: combined, endMs: Math.max(endMs, this.elapsedMs[source]) }];
    this.pendingReplace[source] = true;
  }

  private appendReplay(pcm: Buffer): void {
    if (pcm.length === 0) return;
    const maxBytes = REALTIME_REPLAY_MS * (this.dictation ? 32 : STEREO_PCM_BYTES_PER_MS);
    const chunk = pcm.length > maxBytes ? pcm.subarray(pcm.length - maxBytes) : pcm;
    this.replayChunks.push(chunk);
    this.replayBytes += chunk.length;
    while (this.replayChunks.length > 1 && this.replayBytes > maxBytes) {
      this.replayBytes -= this.replayChunks.shift()!.length;
    }
  }

  private async reconnectRealtime(): Promise<void> {
    const generation = this.lifecycleGeneration;
    if (!this.realtimeUrl) throw new Error("xAI streaming STT session is not configured");
    if (Date.now() < this.reconnectNotBeforeMs) return;
    const replay = Buffer.concat(this.replayChunks);
    const replayDurationMs = Math.floor(replay.length / (this.dictation ? 32 : STEREO_PCM_BYTES_PER_MS));
    this.disconnectSocket();
    this.realtimeGeneration += 1;
    this.sessionBaseMs = Math.max(0, Math.max(this.elapsedMs.mic, this.elapsedMs.system) - replayDurationMs);
    this.partial.mic = "";
    this.partial.system = "";
    this.captionChunks.mic = [];
    this.captionChunks.system = [];
    if (!await this.connectRealtimeWithRetry(this.realtimeUrl)) return;
    if (generation !== this.lifecycleGeneration) throw new Error("xAI streaming STT was cancelled");
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("xAI streaming STT reconnect did not open a session");
    }
    if (replay.length > 0) this.socket.send(replay);
    this.voiceWithoutTranscriptMs = 0;
  }

  private disconnectSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  private fail(error: Error): void {
    this.lastStreamingError = error;
    this.readyReject?.(error);
    this.doneReject?.(error);
    this.disconnectSocket();
  }
}
