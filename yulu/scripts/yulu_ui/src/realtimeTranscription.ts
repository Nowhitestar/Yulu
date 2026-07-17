import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  CaptionSource,
  StreamingCaptionEngine,
  StreamingCaptionUpdate,
} from "./localCaptionEngine.js";
import type { AppChannels, PubSub } from "./pubsub.js";

export type TranscriptionLanguage = "zh" | "en" | "ja" | "auto";

export interface TranscriptionResult {
  transcript: string;
  provider: string;
  chunks: number;
  language?: TranscriptionLanguage;
}

export interface WavFormat {
  dataOffset: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
}

interface Session {
  audioPath: string;
  stem: string;
  title: string;
  language: TranscriptionLanguage;
  format: WavFormat;
  mode: "streaming" | "segmented";
  captionProvider: string;
  offset: number;
  text: string;
  partialBySource: Record<CaptionSource, string>;
  stableSegments: Array<{ source: CaptionSource; text: string; endMs: number; order: number }>;
  stableOrder: number;
  resamplePhase: number;
  chunks: number;
  coveredMs: number;
  pendingPcm: Buffer;
  overlapPcm: Buffer;
  sourceText: string;
  sourceSegments: string[];
  sequence: number;
  startedAt: string;
  translationEnabled: boolean;
  targetLanguage: string;
  translationText: string;
  translationStatus: "disabled" | "pending" | "ready" | "failed";
  translationGeneration: number;
  translationRunning: boolean;
  queuedTranslation: TranslationRequest | null;
  timer: ReturnType<typeof setInterval> | null;
  pump: Promise<void> | null;
  error: string | null;
}

interface TranslationRequest {
  generation: number;
  sourceText: string;
  context: string[];
  targetLanguage: string;
}

const PCM_BYTES_PER_MS = 32; // 16 kHz, mono, signed 16-bit PCM
const DEFAULT_MIN_SEGMENT_MS = 1_200;
const DEFAULT_TAIL_SILENCE_MS = 450;
const DEFAULT_MAX_SEGMENT_MS = 6_000;
const DEFAULT_OVERLAP_MS = 800;
const DEFAULT_STREAMING_POLL_MS = 80;

export interface SourceSeparatedPcm {
  chunks: Partial<Record<CaptionSource, Buffer>>;
  phase: number;
}

export interface RealtimeAssessment {
  trusted: boolean;
  reason: string | null;
}

export function normalizeTranscriptionLanguage(value: unknown): TranscriptionLanguage {
  return value === "en" || value === "ja" || value === "auto" ? value : "zh";
}

export function cleanTranscriptText(value: string): string {
  const blocked = [
    /请不吝点赞.*订阅.*转发.*打赏.*明镜与点点栏目/,
    /字幕志愿者/,
    /中文字幕/,
    /我用了字幕.*可能不正确.*请勿模仿/,
  ];
  const lines: string[] = [];
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || blocked.some((pattern) => pattern.test(line)) || lines.at(-1) === line) continue;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

function pcmDurationMs(pcm: Buffer): number {
  return Math.floor(pcm.length / PCM_BYTES_PER_MS);
}

function frameEnergy(pcm: Buffer): number {
  if (pcm.length < 2) return 0;
  let squares = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset);
    squares += value * value;
    samples += 1;
  }
  return Math.sqrt(squares / Math.max(1, samples));
}

export function trailingSilenceMs(pcm: Buffer, frameMs = 50): number {
  const frameBytes = Math.max(2, frameMs * PCM_BYTES_PER_MS);
  let silentBytes = 0;
  for (let end = pcm.length; end > 0;) {
    const start = Math.max(0, end - frameBytes);
    const frame = pcm.subarray(start, end);
    if (hasVoice(frame)) break;
    silentBytes += frame.length;
    end = start;
  }
  return Math.floor(silentBytes / PCM_BYTES_PER_MS);
}

export function segmentCutBytes(pcm: Buffer, input: {
  force?: boolean;
  minSegmentMs?: number;
  tailSilenceMs?: number;
  maxSegmentMs?: number;
} = {}): number {
  const alignedLength = pcm.length - (pcm.length % 2);
  if (input.force) return alignedLength;
  const minSegmentMs = input.minSegmentMs ?? DEFAULT_MIN_SEGMENT_MS;
  const tailSilence = input.tailSilenceMs ?? DEFAULT_TAIL_SILENCE_MS;
  const maxSegmentMs = input.maxSegmentMs ?? DEFAULT_MAX_SEGMENT_MS;
  const durationMs = pcmDurationMs(pcm);
  if (durationMs < minSegmentMs) return 0;
  if (trailingSilenceMs(pcm) >= tailSilence && hasVoice(pcm)) return alignedLength;
  if (durationMs < maxSegmentMs) return 0;

  const frameMs = 50;
  const frameBytes = frameMs * PCM_BYTES_PER_MS;
  const searchStart = Math.max(minSegmentMs * PCM_BYTES_PER_MS, alignedLength - 1_500 * PCM_BYTES_PER_MS);
  let quietestEnd = alignedLength;
  let quietestEnergy = Number.POSITIVE_INFINITY;
  for (let start = searchStart; start + frameBytes <= alignedLength; start += frameBytes) {
    const energy = frameEnergy(pcm.subarray(start, start + frameBytes));
    if (energy < quietestEnergy) {
      quietestEnergy = energy;
      quietestEnd = start + frameBytes;
    }
  }
  return quietestEnd - (quietestEnd % 2);
}

export function dedupeTranscriptSegment(existing: string, incoming: string): string {
  const previous = cleanTranscriptText(existing);
  const next = cleanTranscriptText(incoming);
  if (!next || previous.split(/\n+/).at(-1) === next) return "";
  const maxOverlap = Math.min(previous.length, next.length, 160);
  for (let length = maxOverlap; length >= 4; length -= 1) {
    if (previous.endsWith(next.slice(0, length))) return next.slice(length).trim();
  }
  return next;
}

function captionKey(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, "");
}

function bigrams(value: string): Set<string> {
  const out = new Set<string>();
  for (let index = 0; index + 1 < value.length; index += 1) out.add(value.slice(index, index + 2));
  return out;
}

/** Suppress the delayed microphone copy of system audio without dropping overlap speech. */
export function captionsLikelyDuplicate(left: string, right: string): boolean {
  const a = captionKey(left);
  const b = captionKey(right);
  if (Math.min(a.length, b.length) < 6) return a === b && a.length >= 3;
  if (a.includes(b) || b.includes(a)) return true;
  const aa = bigrams(a);
  const bb = bigrams(b);
  let intersection = 0;
  for (const pair of aa) if (bb.has(pair)) intersection += 1;
  const dice = 2 * intersection / Math.max(1, aa.size + bb.size);
  return dice >= 0.82;
}

export function assessRealtimeTranscript(input: {
  text: string;
  language: TranscriptionLanguage;
  coveredMs: number;
  totalMs: number;
}): RealtimeAssessment {
  const text = cleanTranscriptText(input.text);
  if (!text) return { trusted: false, reason: "empty transcript" };
  if (!/[A-Za-z0-9\u3400-\u9fff\u3040-\u30ff]/.test(text)) {
    return { trusted: false, reason: "transcript contains no speech text" };
  }
  const coverage = input.totalMs > 0 ? input.coveredMs / input.totalMs : 0;
  if (coverage < 0.85) return { trusted: false, reason: "incomplete audio coverage" };

  const han = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (input.language === "zh" && han < 4 && latin > 20) {
    return { trusted: false, reason: "requested Chinese but transcript is English-only" };
  }
  if (input.language === "ja" && han + kana < 4 && latin > 20) {
    return { trusted: false, reason: "requested Japanese but transcript is English-only" };
  }

  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (lines.length >= 4 && new Set(lines).size / lines.length < 0.5) {
    return { trusted: false, reason: "repetitive transcript" };
  }
  return { trusted: true, reason: null };
}

function cleanRealtimeChunk(value: string, language: TranscriptionLanguage): string {
  return cleanTranscriptText(value)
    .split(/\n+/)
    .map((line) => {
      const cleaned = line.replace(
        /(?:[^\u3400-\u9fff\u3040-\u30ffA-Za-z0-9]*[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['-][A-Za-zÀ-ÖØ-öø-ÿ]+)?){2,}/g,
        (run) => {
          const words = run.match(/[A-Za-zÀ-ÖØ-öø-ÿ]+(?:['-][A-Za-zÀ-ÖØ-öø-ÿ]+)?/g)
            ?.map((word) => word.toLowerCase()) ?? [];
          return new Set(words).size < words.length ? "" : run;
        },
      ).replace(/^[\s，,、﹑﹐﹌﹗﹚]+|[\s，,、﹑﹐﹌﹗﹚]+$/g, "").trim();
      const tokens = cleaned.split(/[\s，,、﹑﹐﹌﹗﹚]+/).filter(Boolean);
      return tokens.length >= 2 && new Set(tokens).size === 1 ? "" : cleaned;
    })
    .filter((line) => {
      if (!assessRealtimeTranscript({ text: line, language, coveredMs: 1, totalMs: 1 }).trusted) return false;
      const han = (line.match(/[\u3400-\u9fff]/g) ?? []).length;
      const kana = (line.match(/[\u3040-\u30ff]/g) ?? []).length;
      const latin = (line.match(/[A-Za-z]/g) ?? []).length;
      if (language === "zh" && han < 4 && latin >= 8) return false;
      if (language === "ja" && han + kana < 4 && latin >= 8) return false;
      return true;
    })
    .join("\n");
}

function isLanguageContractRejection(error: unknown): boolean {
  return error instanceof Error && error.message.includes("violated the requested language contract");
}

function sidecarPath(audioPath: string): string {
  return audioPath.replace(/\.wav$/i, ".realtime.transcript.txt");
}

function coveragePath(audioPath: string): string {
  return audioPath.replace(/\.wav$/i, ".realtime.coverage.json");
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

export function parseWavFormat(path: string): WavFormat {
  const fd = openSync(path, "r");
  try {
    const size = Math.min(statSync(path).size, 4096);
    const header = Buffer.alloc(size);
    readSync(fd, header, 0, size, 0);
    if (size < 44 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("realtime transcription requires a PCM WAV recording");
    }
    let channels = 0;
    let sampleRate = 0;
    let blockAlign = 0;
    let bitsPerSample = 0;
    for (let offset = 12; offset + 8 <= header.length;) {
      const kind = header.toString("ascii", offset, offset + 4);
      const chunkSize = header.readUInt32LE(offset + 4);
      if (kind === "fmt " && offset + 24 <= header.length) {
        if (header.readUInt16LE(offset + 8) !== 1) throw new Error("realtime transcription requires PCM audio");
        channels = header.readUInt16LE(offset + 10);
        sampleRate = header.readUInt32LE(offset + 12);
        blockAlign = header.readUInt16LE(offset + 20);
        bitsPerSample = header.readUInt16LE(offset + 22);
      }
      if (kind === "data") {
        if (!channels || !sampleRate || !blockAlign || bitsPerSample !== 16) {
          throw new Error("unsupported realtime WAV format");
        }
        return { dataOffset: offset + 8, channels, sampleRate, blockAlign, bitsPerSample };
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    throw new Error("WAV data chunk is missing");
  } finally {
    closeSync(fd);
  }
}

function mono16kPcm(source: Buffer, format: WavFormat): Buffer {
  const sourceFrames = Math.floor(source.length / format.blockAlign);
  const stride = Math.max(1, Math.round(format.sampleRate / 16_000));
  const output = Buffer.alloc(Math.ceil(sourceFrames / stride) * 2);
  let out = 0;
  for (let frame = 0; frame < sourceFrames; frame += stride) {
    const offset = frame * format.blockAlign;
    let mixed = source.readInt16LE(offset);
    if (format.channels >= 2) mixed += source.readInt16LE(offset + 2);
    mixed = Math.max(-32768, Math.min(32767, mixed));
    output.writeInt16LE(mixed, out);
    out += 2;
  }
  return output.subarray(0, out);
}

/**
 * Preserve Yulu's capture contract (left=mic, right=system) while reducing the
 * growing WAV to exact-rate 16 kHz PCM streams. The integer phase accumulator
 * avoids timing drift for non-48 kHz devices without buffering whole files.
 */
export function sourceSeparated16kPcm(
  source: Buffer,
  format: WavFormat,
  initialPhase = 0,
): SourceSeparatedPcm {
  const sourceFrames = Math.floor(source.length / format.blockAlign);
  const capacity = Math.ceil((sourceFrames * 16_000 + initialPhase) / format.sampleRate);
  const mic = Buffer.alloc(Math.max(0, capacity) * 2);
  const system = format.channels >= 2 ? Buffer.alloc(Math.max(0, capacity) * 2) : null;
  let phase = initialPhase;
  let outputFrames = 0;
  for (let frame = 0; frame < sourceFrames; frame += 1) {
    phase += 16_000;
    if (phase < format.sampleRate) continue;
    phase -= format.sampleRate;
    const sourceOffset = frame * format.blockAlign;
    mic.writeInt16LE(source.readInt16LE(sourceOffset), outputFrames * 2);
    if (system) system.writeInt16LE(source.readInt16LE(sourceOffset + 2), outputFrames * 2);
    outputFrames += 1;
  }
  return {
    chunks: {
      mic: mic.subarray(0, outputFrames * 2),
      ...(system ? { system: system.subarray(0, outputFrames * 2) } : {}),
    },
    phase,
  };
}

function hasVoice(pcm: Buffer): boolean {
  if (pcm.length < 2) return false;
  let peak = 0;
  let squares = 0;
  let samples = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    const value = pcm.readInt16LE(offset);
    peak = Math.max(peak, Math.abs(value));
    squares += value * value;
    samples += 1;
  }
  if (peak >= 1200) return true;
  const rms = Math.sqrt(squares / Math.max(1, samples)) / 32767;
  return rms > 0 && 20 * Math.log10(rms) >= -42;
}

function writeMonoWav(path: string, pcm: Buffer): void {
  const wav = Buffer.alloc(44 + pcm.length);
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
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  writeFileSync(path, wav, { mode: 0o600 });
}

export class RealtimeTranscriptionCoordinator {
  private active: Session | null = null;
  private readonly pollMs: number;
  private readonly allowedRoot: string | null;
  private readonly minSegmentMs: number;
  private readonly tailSilenceMs: number;
  private readonly maxSegmentMs: number;
  private readonly overlapMs: number;

  constructor(private readonly options: {
    pubsub: PubSub<AppChannels>;
    transcribe: (audioPath: string, language: TranscriptionLanguage) => Promise<TranscriptionResult>;
    streaming?: StreamingCaptionEngine | null;
    stabilize?: (text: string) => string;
    warm?: () => Promise<void>;
    translate?: (sourceText: string, targetLanguage: string, context: string[]) => Promise<string>;
    defaultTargetLanguage?: () => string;
    defaultTranslationEnabled?: boolean;
    allowedRoot?: string;
    chunkSec?: number;
    pollMs?: number;
    minSegmentMs?: number;
    tailSilenceMs?: number;
    overlapMs?: number;
  }) {
    this.pollMs = options.pollMs ?? (options.streaming ? DEFAULT_STREAMING_POLL_MS : 250);
    this.allowedRoot = options.allowedRoot ? realpathSync(options.allowedRoot) : null;
    this.minSegmentMs = options.minSegmentMs ?? DEFAULT_MIN_SEGMENT_MS;
    this.tailSilenceMs = options.tailSilenceMs ?? DEFAULT_TAIL_SILENCE_MS;
    this.maxSegmentMs = (options.chunkSec ?? DEFAULT_MAX_SEGMENT_MS / 1_000) * 1_000;
    this.overlapMs = options.overlapMs ?? DEFAULT_OVERLAP_MS;
  }

  async start(input: { audioPath: string; title: string; language: TranscriptionLanguage }): Promise<void> {
    if (this.active) await this.stop(this.active.audioPath);
    if (extname(input.audioPath).toLowerCase() !== ".wav") throw new Error("realtime input must be a WAV file");
    const audioPath = realpathSync(input.audioPath);
    if (this.allowedRoot) {
      const child = relative(this.allowedRoot, audioPath);
      if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error("realtime input must be inside the recordings directory");
      }
    }
    const format = parseWavFormat(audioPath);
    const mode: Session["mode"] = this.options.streaming ? "streaming" : "segmented";
    if (mode === "streaming") {
      await this.options.streaming!.start(normalizeTranscriptionLanguage(input.language));
    }
    const session: Session = {
      audioPath,
      stem: basename(audioPath, ".wav"),
      title: input.title,
      language: normalizeTranscriptionLanguage(input.language),
      format,
      mode,
      captionProvider: mode === "streaming" ? this.options.streaming!.provider : "segmented",
      offset: format.dataOffset,
      text: "",
      partialBySource: { mic: "", system: "" },
      stableSegments: [],
      stableOrder: 0,
      resamplePhase: 0,
      chunks: 0,
      coveredMs: 0,
      pendingPcm: Buffer.alloc(0),
      overlapPcm: Buffer.alloc(0),
      sourceText: "",
      sourceSegments: [],
      sequence: 0,
      startedAt: new Date().toISOString(),
      translationEnabled: Boolean(this.options.translate && this.options.defaultTranslationEnabled),
      targetLanguage: this.options.defaultTargetLanguage?.().trim() || "English",
      translationText: "",
      translationStatus: this.options.translate && this.options.defaultTranslationEnabled ? "pending" : "disabled",
      translationGeneration: 0,
      translationRunning: false,
      queuedTranslation: null,
      timer: null,
      pump: null,
      error: null,
    };
    rmSync(sidecarPath(audioPath), { force: true });
    rmSync(coveragePath(audioPath), { force: true });
    this.active = session;
    void this.options.warm?.().catch(() => {});
    this.publish(session, "starting", false);
    await this.queuePump(false);
    session.timer = setInterval(() => { void this.queuePump(false); }, this.pollMs);
    session.timer.unref();
  }

  async updateOptions(input: {
    audioPath: string;
    targetLanguage: string;
    translationEnabled: boolean;
  }): Promise<AppChannels["realtime-transcript"]> {
    const session = this.active;
    if (!session || realpathSync(input.audioPath) !== session.audioPath) {
      throw new Error("realtime transcription session is not active");
    }
    session.translationEnabled = Boolean(this.options.translate && input.translationEnabled);
    session.targetLanguage = input.targetLanguage.trim() || session.targetLanguage;
    session.translationText = "";
    session.translationStatus = session.translationEnabled ? "pending" : "disabled";
    session.translationGeneration += 1;
    session.queuedTranslation = null;
    if (session.translationEnabled && session.sourceText) {
      this.queueTranslation(session);
      return this.message(session, "transcribing", false);
    }
    return this.publish(session, "transcribing", false);
  }

  async stop(audioPath?: string): Promise<AppChannels["realtime-transcript"] | null> {
    const session = this.active;
    if (!session || (audioPath && realpathSync(audioPath) !== session.audioPath)) return null;
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    if (session.pump) await session.pump;
    await this.queuePump(true);
    if (session.mode === "streaming" && session.error === null) {
      try {
        this.applyStreamingUpdate(session, await this.options.streaming!.finish());
      } catch (error) {
        session.error = (error as Error).message;
      }
    }
    const totalMs = this.durationMs(session);
    const assessment = assessRealtimeTranscript({
      text: session.text,
      language: session.language,
      coveredMs: session.coveredMs,
      totalMs,
    });
    const trusted = session.error === null && assessment.trusted;
    const reason = session.error === null
      ? assessment.reason
      : `realtime transcription failed: ${session.error}`;
    this.writeCoverage(session, totalMs, trusted, reason, true);
    session.translationGeneration += 1;
    session.queuedTranslation = null;
    session.sequence += 1;
    const result = this.message(session, session.error ? "failed" : "finished", trusted, reason);
    this.options.pubsub.publish("realtime-transcript", result);
    rmSync(`${session.audioPath}.realtime`, { recursive: true, force: true });
    this.active = null;
    return result;
  }

  async close(): Promise<void> {
    if (this.active) await this.stop(this.active.audioPath);
    await this.options.streaming?.close();
  }

  private async queuePump(force: boolean): Promise<void> {
    const session = this.active;
    if (!session) return;
    if (session.pump) {
      await session.pump;
      if (!force) return;
    }
    session.pump = this.pump(session, force)
      .catch((error) => {
        session.error = (error as Error).message;
        this.publish(session, "failed", false, session.error);
      })
      .finally(() => { session.pump = null; });
    await session.pump;
  }

  private async pump(session: Session, force: boolean): Promise<void> {
    const bytesPerSecond = session.format.sampleRate * session.format.blockAlign;
    const size = statSync(session.audioPath).size;
    const available = Math.floor((size - session.offset) / session.format.blockAlign) * session.format.blockAlign;
    if (available > 0) {
      const fd = openSync(session.audioPath, "r");
      const source = Buffer.alloc(available);
      try {
        readSync(fd, source, 0, available, session.offset);
      } finally {
        closeSync(fd);
      }
      session.offset += available;
      session.coveredMs = Math.round((session.offset - session.format.dataOffset) / bytesPerSecond * 1000);
      if (session.mode === "streaming") {
        const separated = sourceSeparated16kPcm(source, session.format, session.resamplePhase);
        session.resamplePhase = separated.phase;
        try {
          this.applyStreamingUpdate(session, await this.options.streaming!.feed(separated.chunks));
        } catch (error) {
          await this.options.streaming?.abort();
          throw error;
        }
      } else {
        const pcm = mono16kPcm(source, session.format);
        session.pendingPcm = Buffer.concat([session.pendingPcm, pcm]);
      }
    }
    if (session.mode === "segmented") await this.flushSegments(session, force);
  }

  private applyStreamingUpdate(session: Session, response: StreamingCaptionUpdate): void {
    const previousDisplay = this.displayText(session);
    const previousStable = session.text;
    const accepted: string[] = [];
    for (const source of ["system", "mic"] as const) {
      const update = response.updates[source];
      if (!update) continue;
      session.partialBySource[source] = cleanTranscriptText(update.partial);
      if (update.replaceStable) {
        session.stableSegments = session.stableSegments.filter((segment) => segment.source !== source);
      }
      for (const item of update.stable) {
        let text = cleanTranscriptText(item.text);
        if (text && this.options.stabilize) text = cleanTranscriptText(this.options.stabilize(text));
        if (!text) continue;
        const candidate = {
          source,
          text,
          endMs: item.endMs,
          order: session.stableOrder++,
        };
        const duplicate = session.stableSegments.findIndex((existing) =>
          existing.source !== source &&
          Math.abs(existing.endMs - candidate.endMs) <= 1_500 &&
          captionsLikelyDuplicate(existing.text, candidate.text),
        );
        if (duplicate >= 0) {
          const existing = session.stableSegments[duplicate]!;
          if (source === "system" && existing.source === "mic") {
            session.stableSegments.splice(duplicate, 1, candidate);
          }
          continue;
        }
        session.stableSegments.push(candidate);
        session.chunks += 1;
        accepted.push(text);
      }
    }
    session.stableSegments.sort((a, b) => a.endMs - b.endMs || a.order - b.order);
    let stableText = "";
    for (const segment of session.stableSegments) {
      const addition = dedupeTranscriptSegment(stableText, segment.text);
      if (addition) stableText = cleanTranscriptText([stableText, addition].filter(Boolean).join("\n"));
    }
    session.text = stableText;
    if (session.text !== previousStable) {
      atomicWrite(sidecarPath(session.audioPath), session.text ? `${session.text}\n` : "");
    }
    if (accepted.length > 0) {
      session.sourceText = accepted.join("\n");
      session.sourceSegments.push(session.sourceText);
      session.sourceSegments = session.sourceSegments.slice(-3);
      session.translationText = "";
      session.translationStatus = session.translationEnabled ? "pending" : "disabled";
      session.translationGeneration += 1;
      if (session.translationEnabled) this.queueTranslation(session);
    }
    this.writeCoverage(session, this.durationMs(session), false, null, false);
    if (!session.translationEnabled && this.displayText(session) !== previousDisplay) {
      this.publish(session, "transcribing", false);
    }
  }

  private displayText(session: Session): string {
    return cleanTranscriptText([
      session.text,
      session.partialBySource.system,
      session.partialBySource.mic,
    ].filter(Boolean).join("\n"));
  }

  private async flushSegments(session: Session, force: boolean): Promise<void> {
    while (this.active === session && session.pendingPcm.length > 0) {
      const cut = segmentCutBytes(session.pendingPcm, {
        force,
        minSegmentMs: this.minSegmentMs,
        tailSilenceMs: this.tailSilenceMs,
        maxSegmentMs: this.maxSegmentMs,
      });
      if (cut <= 0) return;
      const segment = session.pendingPcm.subarray(0, cut);
      session.pendingPcm = session.pendingPcm.subarray(cut);
      if (!hasVoice(segment)) {
        session.overlapPcm = Buffer.alloc(0);
        this.writeCoverage(session, this.durationMs(session), false, null, false);
        if (force) continue;
        continue;
      }

      const pcm = session.overlapPcm.length > 0
        ? Buffer.concat([session.overlapPcm, segment])
        : segment;
      const chunkDir = `${session.audioPath}.realtime`;
      mkdirSync(chunkDir, { recursive: true, mode: 0o700 });
      const chunkPath = join(chunkDir, `chunk-${session.chunks.toString().padStart(4, "0")}.wav`);
      writeMonoWav(chunkPath, pcm);
      try {
        const result = await this.options.transcribe(chunkPath, session.language);
        const sourceText = dedupeTranscriptSegment(
          session.text,
          cleanRealtimeChunk(result.transcript, session.language),
        );
        if (sourceText) {
          session.sourceText = sourceText;
          session.sourceSegments.push(sourceText);
          session.sourceSegments = session.sourceSegments.slice(-3);
          session.text = cleanTranscriptText([session.text, sourceText].filter(Boolean).join("\n"));
          atomicWrite(sidecarPath(session.audioPath), session.text + "\n");
          session.translationText = "";
          session.translationStatus = session.translationEnabled ? "pending" : "disabled";
          session.translationGeneration += 1;
          if (session.translationEnabled) this.queueTranslation(session);
          else this.publish(session, "transcribing", false);
        }
        session.chunks += 1;
      } catch (error) {
        if (!isLanguageContractRejection(error)) throw error;
        session.chunks += 1;
      } finally {
        rmSync(chunkPath, { force: true });
      }

      const silenceBytes = trailingSilenceMs(segment) * PCM_BYTES_PER_MS;
      const speechEnd = Math.max(0, segment.length - silenceBytes);
      const overlapBytes = this.overlapMs * PCM_BYTES_PER_MS;
      session.overlapPcm = segment.subarray(Math.max(0, speechEnd - overlapBytes), speechEnd);
      this.writeCoverage(session, this.durationMs(session), false, null, false);
      if (!force && session.pendingPcm.length === 0) return;
    }
  }

  private queueTranslation(session: Session): void {
    if (!this.options.translate || !session.translationEnabled || !session.sourceText) return;
    session.queuedTranslation = {
      generation: session.translationGeneration,
      sourceText: session.sourceText,
      context: session.sourceSegments.slice(-3, -1),
      targetLanguage: session.targetLanguage,
    };
    session.translationStatus = "pending";
    this.publish(session, "transcribing", false);
    if (!session.translationRunning) void this.drainTranslations(session);
  }

  private async drainTranslations(session: Session): Promise<void> {
    const translate = this.options.translate;
    if (!translate || session.translationRunning) return;
    session.translationRunning = true;
    try {
      while (this.active === session && session.queuedTranslation) {
        const request = session.queuedTranslation;
        session.queuedTranslation = null;
        try {
          const translated = cleanTranscriptText(await translate(
            request.sourceText,
            request.targetLanguage,
            request.context,
          ));
          if (
            this.active === session &&
            session.translationEnabled &&
            request.generation === session.translationGeneration
          ) {
            session.translationText = translated;
            session.translationStatus = translated ? "ready" : "failed";
            this.publish(session, "transcribing", false);
          }
        } catch {
          if (
            this.active === session &&
            session.translationEnabled &&
            request.generation === session.translationGeneration
          ) {
            session.translationText = "";
            session.translationStatus = "failed";
            this.publish(session, "transcribing", false);
          }
        }
      }
    } finally {
      session.translationRunning = false;
      if (this.active === session && session.queuedTranslation) void this.drainTranslations(session);
    }
  }

  private durationMs(session: Session): number {
    const bytes = Math.max(0, statSync(session.audioPath).size - session.format.dataOffset);
    return Math.round(bytes / (session.format.sampleRate * session.format.blockAlign) * 1000);
  }

  private writeCoverage(
    session: Session,
    totalMs: number,
    trusted: boolean,
    reason: string | null,
    finished: boolean,
  ): void {
    atomicWrite(coveragePath(session.audioPath), JSON.stringify({
      language: session.language,
      covered_ms: session.coveredMs,
      total_ms: totalMs,
      chunks: session.chunks,
      provider: session.captionProvider,
      trusted,
      reason,
      finished,
    }, null, 2) + "\n");
  }

  private message(
    session: Session,
    status: AppChannels["realtime-transcript"]["status"],
    trusted: boolean,
    reason: string | null = null,
  ): AppChannels["realtime-transcript"] {
    return {
      status,
      stem: session.stem,
      title: session.title,
      language: session.language,
      text: this.displayText(session),
      stableText: session.text,
      partialText: cleanTranscriptText([
        session.partialBySource.system,
        session.partialBySource.mic,
      ].filter(Boolean).join("\n")),
      captionProvider: session.captionProvider,
      captionMode: session.mode,
      coveredMs: session.coveredMs,
      trusted,
      sequence: session.sequence,
      sourceText: session.sourceText,
      sourceLanguage: session.language,
      translationText: session.translationText,
      targetLanguage: session.targetLanguage,
      translationStatus: session.translationStatus,
      startedAt: session.startedAt,
      emittedAt: new Date().toISOString(),
      reason,
      error: session.error ?? undefined,
    };
  }

  private publish(
    session: Session,
    status: AppChannels["realtime-transcript"]["status"],
    trusted: boolean,
    reason: string | null = null,
  ): AppChannels["realtime-transcript"] {
    session.sequence += 1;
    const message = this.message(session, status, trusted, reason);
    this.options.pubsub.publish("realtime-transcript", message);
    return message;
  }
}
