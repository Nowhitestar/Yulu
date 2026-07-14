import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { TranscriptionResult } from "./agentGateway.js";
import type { AppChannels, PubSub } from "./pubsub.js";

export type TranscriptionLanguage = "zh" | "en" | "ja" | "auto";

interface WavFormat {
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
  offset: number;
  text: string;
  chunks: number;
  coveredMs: number;
  timer: ReturnType<typeof setInterval> | null;
  pump: Promise<void> | null;
  error: string | null;
}

export interface RealtimeAssessment {
  trusted: boolean;
  reason: string | null;
}

export function normalizeTranscriptionLanguage(value: unknown): TranscriptionLanguage {
  return value === "en" || value === "ja" || value === "auto" ? value : "zh";
}

export function cleanTranscriptText(value: string): string {
  const blocked = new Set([
    "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目",
  ]);
  const lines: string[] = [];
  for (const raw of value.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || blocked.has(line) || lines.at(-1) === line) continue;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

export function assessRealtimeTranscript(input: {
  text: string;
  language: TranscriptionLanguage;
  coveredMs: number;
  totalMs: number;
}): RealtimeAssessment {
  const text = cleanTranscriptText(input.text);
  if (!text) return { trusted: false, reason: "empty transcript" };
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

function parseWavFormat(path: string): WavFormat {
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
  private readonly chunkSec: number;
  private readonly pollMs: number;
  private readonly allowedRoot: string | null;

  constructor(private readonly options: {
    pubsub: PubSub<AppChannels>;
    transcribe: (audioPath: string, language: TranscriptionLanguage) => Promise<TranscriptionResult>;
    allowedRoot?: string;
    chunkSec?: number;
    pollMs?: number;
  }) {
    this.chunkSec = options.chunkSec ?? 15;
    this.pollMs = options.pollMs ?? 1_000;
    this.allowedRoot = options.allowedRoot ? realpathSync(options.allowedRoot) : null;
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
    const session: Session = {
      audioPath,
      stem: basename(audioPath, ".wav"),
      title: input.title,
      language: normalizeTranscriptionLanguage(input.language),
      format,
      offset: format.dataOffset,
      text: "",
      chunks: 0,
      coveredMs: 0,
      timer: null,
      pump: null,
      error: null,
    };
    rmSync(sidecarPath(audioPath), { force: true });
    rmSync(coveragePath(audioPath), { force: true });
    this.active = session;
    this.publish(session, "starting", false);
    await this.queuePump(false);
    session.timer = setInterval(() => { void this.queuePump(false); }, this.pollMs);
    session.timer.unref();
  }

  async stop(audioPath?: string): Promise<AppChannels["realtime-transcript"] | null> {
    const session = this.active;
    if (!session || (audioPath && realpathSync(audioPath) !== session.audioPath)) return null;
    if (session.timer) clearInterval(session.timer);
    session.timer = null;
    if (session.pump) await session.pump;
    await this.queuePump(true);
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
    const result = this.message(session, session.error ? "failed" : "finished", trusted, reason);
    this.options.pubsub.publish("realtime-transcript", result);
    rmSync(`${session.audioPath}.realtime`, { recursive: true, force: true });
    this.active = null;
    return result;
  }

  async close(): Promise<void> {
    if (this.active) await this.stop(this.active.audioPath);
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
    const chunkBytes = Math.max(session.format.blockAlign, Math.floor(this.chunkSec * bytesPerSecond));
    while (this.active === session) {
      const size = statSync(session.audioPath).size;
      const available = Math.floor((size - session.offset) / session.format.blockAlign) * session.format.blockAlign;
      if (available <= 0 || (!force && available < chunkBytes)) return;
      const consume = force ? available : Math.min(available, chunkBytes);
      const fd = openSync(session.audioPath, "r");
      const source = Buffer.alloc(consume);
      try {
        readSync(fd, source, 0, consume, session.offset);
      } finally {
        closeSync(fd);
      }
      session.offset += consume;
      session.coveredMs = Math.round((session.offset - session.format.dataOffset) / bytesPerSecond * 1000);
      const pcm = mono16kPcm(source, session.format);
      if (hasVoice(pcm)) {
        const chunkDir = `${session.audioPath}.realtime`;
        mkdirSync(chunkDir, { recursive: true, mode: 0o700 });
        const chunkPath = join(chunkDir, `chunk-${session.chunks.toString().padStart(4, "0")}.wav`);
        writeMonoWav(chunkPath, pcm);
        try {
          const result = await this.options.transcribe(chunkPath, session.language);
          const partial = cleanTranscriptText(result.transcript);
          if (partial && session.text.split(/\n+/).at(-1) !== partial) {
            session.text = cleanTranscriptText([session.text, partial].filter(Boolean).join("\n"));
            atomicWrite(sidecarPath(session.audioPath), session.text + "\n");
          }
          session.chunks += 1;
        } finally {
          rmSync(chunkPath, { force: true });
        }
      }
      this.writeCoverage(session, this.durationMs(session), false, null, false);
      this.publish(session, "transcribing", false);
      if (force) continue;
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
      text: session.text,
      coveredMs: session.coveredMs,
      trusted,
      reason,
      error: session.error ?? undefined,
    };
  }

  private publish(
    session: Session,
    status: AppChannels["realtime-transcript"]["status"],
    trusted: boolean,
    reason: string | null = null,
  ): void {
    this.options.pubsub.publish("realtime-transcript", this.message(session, status, trusted, reason));
  }
}

export function trustedRealtimeTranscript(
  audioPath: string,
  language: TranscriptionLanguage,
): { transcript: string; chunks: number } | null {
  try {
    const coverage = JSON.parse(readFileSync(coveragePath(audioPath), "utf8")) as Record<string, unknown>;
    if (coverage.finished !== true || coverage.trusted !== true || coverage.language !== language) return null;
    const transcript = cleanTranscriptText(readFileSync(sidecarPath(audioPath), "utf8"));
    if (!transcript) return null;
    return { transcript, chunks: Number(coverage.chunks ?? 0) };
  } catch {
    return null;
  }
}
