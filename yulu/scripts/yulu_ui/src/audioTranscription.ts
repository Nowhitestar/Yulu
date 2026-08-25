import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import type { ConfigManager } from "./config.js";
import { AgentUnavailableError } from "./agentGateway.js";
import type { GlossaryContract } from "./glossaryContract.js";
import type {
  CaptionSource,
  StreamingCaptionEngine,
  StreamingCaptionUpdate,
} from "./localCaptionEngine.js";
import type { LocalCaptionManager } from "./localCaptionManager.js";
import {
  captionsLikelyDuplicate,
  cleanTranscriptText,
  dedupeTranscriptSegment,
  parseWavFormat,
  sourceSeparated16kPcm,
  type TranscriptionResult,
  type TranscriptionLanguage,
} from "./realtimeTranscription.js";
import { XaiAudioClient } from "./xaiAudio.js";
import { XAI_TRANSCRIPTION_DISCLOSURE_VERSION } from "./transcriptionConsent.js";

export type AudioTranscriptionEngine = "local" | "xai";

interface StableItem {
  source: CaptionSource;
  text: string;
  endMs: number;
  order: number;
}

function selectedEngine(config: ConfigManager): AudioTranscriptionEngine {
  return config.read().transcription.engine;
}

function trustedRealtimeTranscript(
  audioPath: string,
): Pick<TranscriptionResult, "transcript" | "provider" | "chunks"> | null {
  const transcriptPath = audioPath.replace(/\.wav$/i, ".realtime.transcript.txt");
  const coveragePath = audioPath.replace(/\.wav$/i, ".realtime.coverage.json");
  if (!existsSync(transcriptPath) || !existsSync(coveragePath)) return null;
  try {
    const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as {
      trusted?: boolean;
      finished?: boolean;
      final?: boolean;
      provider?: unknown;
      chunks?: unknown;
    };
    const transcript = cleanTranscriptText(readFileSync(transcriptPath, "utf8"));
    if (coverage.trusted !== true || (coverage.finished !== true && coverage.final !== true) || !transcript) return null;
    const provider = typeof coverage.provider === "string" ? coverage.provider.trim() : "";
    const chunks = typeof coverage.chunks === "number" && Number.isInteger(coverage.chunks) && coverage.chunks > 0
      ? coverage.chunks
      : 1;
    return { transcript, provider: provider || "realtime", chunks };
  } catch { return null; }
}

function acceptUpdates(items: StableItem[], response: StreamingCaptionUpdate, nextOrder: number): number {
  for (const source of ["system", "mic"] as const) {
    for (const stable of response.updates[source]?.stable ?? []) {
      const text = cleanTranscriptText(stable.text);
      if (!text) continue;
      const candidate = { source, text, endMs: stable.endMs, order: nextOrder++ };
      const duplicate = items.findIndex((existing) =>
        existing.source !== source &&
        Math.abs(existing.endMs - candidate.endMs) <= 1_500 &&
        captionsLikelyDuplicate(existing.text, candidate.text));
      if (duplicate >= 0) {
        if (source === "system" && items[duplicate]!.source === "mic") items.splice(duplicate, 1, candidate);
        continue;
      }
      items.push(candidate);
    }
  }
  return nextOrder;
}

function transcriptFromItems(items: StableItem[]): string {
  let transcript = "";
  for (const item of items.sort((a, b) => a.endMs - b.endMs || a.order - b.order)) {
    const addition = dedupeTranscriptSegment(transcript, item.text);
    if (addition) transcript = cleanTranscriptText([transcript, addition].filter(Boolean).join("\n"));
  }
  return transcript;
}

export class AudioTranscriptionService implements StreamingCaptionEngine {
  private active: StreamingCaptionEngine | null = null;

  constructor(
    private readonly config: ConfigManager,
    private readonly local: LocalCaptionManager,
    private readonly xai: XaiAudioClient,
    private readonly hasXaiTranscriptionConsent: () => boolean,
  ) {}

  get provider(): string {
    if (this.active) return this.active.provider;
    return selectedEngine(this.config) === "local" ? this.local.provider : this.xai.provider;
  }

  health(): { available: boolean; provider: string; reason: string | null } {
    const engine = selectedEngine(this.config);
    if (engine === "local") {
      const status = this.local.status();
      return {
        available: status.ready,
        provider: "local",
        reason: status.ready ? null : status.error || "本地转写模型尚未安装",
      };
    }
    const status = this.xaiCredentialStatus();
    return {
      available: status?.connected === true,
      provider: status?.connected ? "xai-oauth:yulu" : "xai-oauth",
      reason: status?.connected ? null : status?.detail || "正在检查 Yulu xAI OAuth",
    };
  }

  async warm(): Promise<void> {
    if (selectedEngine(this.config) === "local") await this.local.warm();
    else await this.xai.warm();
  }

  async start(language: TranscriptionLanguage): Promise<void> {
    this.requireXaiTranscriptionConsent();
    if (this.active) await this.active.abort();
    const engine = selectedEngine(this.config) === "local" ? this.local : this.xai;
    this.active = engine;
    try { await engine.start(language); }
    catch (error) {
      this.active = null;
      throw error;
    }
  }

  async feed(chunks: Partial<Record<CaptionSource, Buffer>>): Promise<StreamingCaptionUpdate> {
    if (!this.active) throw new Error("实时字幕引擎尚未启动");
    return await this.active.feed(chunks);
  }

  async finish(): Promise<StreamingCaptionUpdate> {
    if (!this.active) return { updates: {} };
    const active = this.active;
    try { return await active.finish(); }
    finally { this.active = null; }
  }

  async abort(): Promise<void> {
    const active = this.active;
    this.active = null;
    await active?.abort();
  }

  async close(): Promise<void> {
    await this.abort();
    await this.local.close();
    await this.xai.close();
  }

  async transcribeFile(
    audioPath: string,
    language: TranscriptionLanguage,
    glossary?: GlossaryContract,
  ): Promise<TranscriptionResult> {
    if (selectedEngine(this.config) === "xai") {
      this.requireXaiTranscriptionConsent();
      try { return await this.xai.transcribeFile(audioPath, language, glossary); }
      catch (error) {
        const realtime = trustedRealtimeTranscript(audioPath);
        if (realtime?.provider.startsWith("xai")) return { ...realtime, language };
        if (error instanceof AgentUnavailableError) throw error;
        throw new AgentUnavailableError((error as Error).message);
      }
    }
    const status = this.local.status();
    if (!status.ready) throw new AgentUnavailableError(status.error || "本地转写模型尚未安装");
    return await this.transcribeLocalFile(audioPath, language);
  }

  async testXai() {
    return await this.xai.testCredential();
  }

  private xaiCredentialStatus() {
    return this.xai.credentialStatus();
  }

  private requireXaiTranscriptionConsent(): void {
    if (selectedEngine(this.config) === "xai" && !this.hasXaiTranscriptionConsent()) {
      throw new AgentUnavailableError(
        `xAI audio processing requires current Cloud Transcription Consent (${XAI_TRANSCRIPTION_DISCLOSURE_VERSION})`,
      );
    }
  }

  private async transcribeLocalFile(audioPath: string, language: TranscriptionLanguage): Promise<TranscriptionResult> {
    const format = parseWavFormat(audioPath);
    const bytesPerChunk = Math.max(format.blockAlign, Math.floor(format.sampleRate * format.blockAlign / 5));
    const buffer = Buffer.alloc(bytesPerChunk - (bytesPerChunk % format.blockAlign));
    const items: StableItem[] = [];
    let order = 0;
    let phase = 0;
    let offset = format.dataOffset;
    let chunks = 0;
    const fd = openSync(audioPath, "r");
    try {
      await this.local.start(language);
      while (offset < statSync(audioPath).size) {
        const read = readSync(fd, buffer, 0, buffer.length, offset);
        if (read <= 0) break;
        offset += read;
        const aligned = buffer.subarray(0, read - (read % format.blockAlign));
        const separated = sourceSeparated16kPcm(aligned, format, phase);
        phase = separated.phase;
        order = acceptUpdates(items, await this.local.feed(separated.chunks), order);
        chunks += 1;
      }
      order = acceptUpdates(items, await this.local.finish(), order);
    } catch (error) {
      await this.local.abort();
      throw error;
    } finally {
      closeSync(fd);
    }
    const transcript = transcriptFromItems(items);
    if (!transcript) throw new Error("本地转写没有识别到语音");
    return { transcript, provider: this.local.provider, chunks: Math.max(1, chunks), language };
  }
}
