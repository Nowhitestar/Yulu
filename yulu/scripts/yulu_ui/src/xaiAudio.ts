import { execFile } from "node:child_process";
import { mkdtempSync, openAsBlob, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { envWithFallbackPath, resolveExecutable } from "./executables.js";
import type { GlossaryContract } from "./glossaryContract.js";
import type {
  CaptionSource,
  CaptionSourceUpdate,
  StreamingCaptionEngine,
  StreamingCaptionUpdate,
} from "./localCaptionEngine.js";
import type { TranscriptionLanguage } from "./realtimeTranscription.js";
import { captionsLikelyDuplicate, cleanTranscriptText, dedupeTranscriptSegment } from "./realtimeTranscription.js";
import { XaiCredentialManager, type XaiCredential, type XaiCredentialSource } from "./xaiCredentials.js";

interface XaiTranscriptEvent {
  type?: string;
  text?: string;
  is_final?: boolean;
  channel_index?: number;
  start?: number;
  duration?: number;
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
}

const SOURCE_BY_CHANNEL: Record<number, CaptionSource> = { 0: "mic", 1: "system" };
const XAI_STT_URL = "https://api.x.ai/v1/stt";
const XAI_STT_TIMEOUT_MS = 30 * 60_000;
const XAI_STT_MAX_UPLOAD_BYTES = 500_000_000;
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
  private activeSource: "hermes" | "openclaw" | null = null;
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
  private doneChannels = new Set<number>();

  constructor(
    private readonly credentials: XaiCredentialManager,
    private readonly credentialSource: () => XaiCredentialSource,
  ) {}

  get provider(): string {
    return this.activeSource ? `xai-oauth:${this.activeSource}` : "xai-oauth";
  }

  async warm(): Promise<void> {
    await this.credentials.resolve(this.credentialSource());
  }

  async start(language: TranscriptionLanguage): Promise<void> {
    await this.abort();
    const credential = await this.credentials.resolve(this.credentialSource());
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

    const url = new URL("wss://api.x.ai/v1/stt");
    url.searchParams.set("sample_rate", "16000");
    url.searchParams.set("encoding", "pcm");
    url.searchParams.set("interim_results", "true");
    url.searchParams.set("endpointing", "800");
    url.searchParams.set("multichannel", "true");
    url.searchParams.set("channels", "2");
    const formattedLanguage = xaiLanguage(language);
    if (formattedLanguage) url.searchParams.set("language", formattedLanguage);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.connectRealtime(credential, url);
        return;
      } catch (error) {
        await this.abort();
        if (attempt > 0 || !isRetryableRealtimeStartError(error)) throw error;
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
    }
  }

  private async connectRealtime(credential: XaiCredential, url: URL): Promise<void> {
    this.activeSource = credential.source;
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
      if (this.doneChannels.size >= 2) this.doneResolve?.();
      else if (this.socket === socket) this.fail(new Error("xAI streaming STT connection closed early"));
    });
    await withTimeout(this.ready, 15_000, "xAI streaming STT start timed out");
  }

  async feed(chunks: Partial<Record<CaptionSource, Buffer>>): Promise<StreamingCaptionUpdate> {
    const socket = this.requireOpenSocket();
    const pcm = interleaveStereo(chunks.mic, chunks.system);
    if (pcm.length > 0) socket.send(pcm);
    this.elapsedMs.mic += audioMs(chunks.mic);
    this.elapsedMs.system += audioMs(chunks.system);
    await new Promise<void>((resolve) => setImmediate(resolve));
    return this.drain();
  }

  async finish(): Promise<StreamingCaptionUpdate> {
    const socket = this.socket;
    if (!socket) return { updates: {} };
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "audio.done" }));
    try {
      await withTimeout(this.done!, 30_000, "xAI streaming STT finish timed out");
      return this.drain();
    } finally {
      socket.close();
      this.socket = null;
      this.activeSource = null;
    }
  }

  async abort(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.activeSource = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  async close(): Promise<void> {
    await this.abort();
  }

  async transcribeFile(
    audioPath: string,
    language: TranscriptionLanguage,
    glossary?: GlossaryContract,
  ): Promise<{ transcript: string; provider: string; chunks: number; language: TranscriptionLanguage }> {
    const credential = await this.credentials.resolve(this.credentialSource());
    const tempRoot = mkdtempSync(join(tmpdir(), "yulu-xai-stt-"));
    const uploadPath = join(tempRoot, "audio.flac");
    try {
      await execFileAsync(resolveExecutable("ffmpeg"), [
        "-y", "-v", "error", "-i", audioPath,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "flac", uploadPath,
      ], { env: envWithFallbackPath(), timeout: 5 * 60_000 });
      if (statSync(uploadPath).size > XAI_STT_MAX_UPLOAD_BYTES) {
        throw new Error("xAI transcription audio still exceeds the 500 MB upload limit after compression");
      }

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const form = new FormData();
        const formattedLanguage = xaiLanguage(language);
        if (formattedLanguage) {
          form.append("format", "true");
          form.append("language", formattedLanguage);
        }
        for (const term of (glossary?.prompt.split("，") ?? [])
          .map((item) => item.trim())
          .filter((item) => item.length > 0 && item.length <= 50)
          .slice(0, 100)) {
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
          const transcript = cleanTranscriptText(String(payload.text ?? ""));
          if (!transcript) throw new Error("xAI returned an empty transcript");
          return {
            transcript,
            provider: `xai-oauth:${credential.source}`,
            chunks: 1,
            language,
          };
        } catch (error) {
          if (attempt === 0 && error instanceof TypeError) {
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
            continue;
          }
          throw error;
        }
      }
      throw new Error("xAI transcription failed after retry");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  async testCredential(source: XaiCredentialSource): Promise<{ ok: true; provider: string }> {
    const credential = await this.credentials.resolve(source);
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
    return { ok: true, provider: `xai-oauth:${credential.source}` };
  }

  credentialStatus(source: XaiCredentialSource) {
    return this.credentials.cachedStatus(source);
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
    if (!source) return;
    const text = cleanTranscriptText(String(event.text ?? ""));
    if (event.type === "transcript.partial") {
      if (event.is_final) {
        this.partial[source] = "";
        this.commitFinalRevision(source, text, event);
      } else {
        this.partial[source] = text;
      }
      return;
    }
    if (event.type === "transcript.done") {
      if (text) this.commitFinalRevision(source, text, event, true);
      this.partial[source] = "";
      this.doneChannels.add(channel);
      if (this.doneChannels.size >= 2) this.doneResolve?.();
    }
  }

  private drain(): StreamingCaptionUpdate {
    const updates: StreamingCaptionUpdate["updates"] = {};
    for (const source of ["mic", "system"] as const) {
      updates[source] = {
        partial: this.partial[source],
        stable: this.pendingStable[source].splice(0),
        audioMs: this.elapsedMs[source],
        ...(this.pendingReplace[source] ? { replaceStable: true } : {}),
      };
      this.pendingReplace[source] = false;
    }
    return { updates };
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
    const startMs = hasRange ? Math.max(0, Math.round(start * 1_000)) : this.finalSegments[source].at(-1)?.endMs ?? 0;
    const endMs = hasRange ? Math.max(startMs, Math.round((start + duration) * 1_000)) : this.elapsedMs[source];
    let segments = this.finalSegments[source];
    const replacesAll = authoritative || (!hasRange && captionsLikelyDuplicate(this.finalText[source], text));
    if (replacesAll) {
      segments = [];
    } else if (hasRange) {
      segments = segments.filter((segment) => endMs <= segment.startMs || startMs >= segment.endMs);
    }
    segments.push({ text, startMs: replacesAll ? 0 : startMs, endMs });
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

  private requireOpenSocket(): WebSocket {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("xAI streaming STT session is not open");
    }
    return this.socket;
  }

  private fail(error: Error): void {
    this.readyReject?.(error);
    this.doneReject?.(error);
  }
}
