import type { z } from "zod";
import { DictationCleanupSchema, type DictationCleanupResult, type DictationTextService } from "./dictationText.js";

/** Match the capture client's normalization, without erasing punctuation,
 * paragraphs, corrections, or meaningful spaces in names and code. */
export function normalizeDictationText(text: string): string {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim().replace(/\s+/g, " ")
    .replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff]) +(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, "")
    .replace(/ +([，。！？、；：,.!?;:])/g, "$1")
    .replace(/([，。！？、；：,.!?;:]) +(?=[\u3400-\u4dbf\u4e00-\u9fff])/g, "$1"))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Speculation may include an uncommitted utterance. Exact final-source checks
 * still gate reuse; partials never become the durable transcript or get pasted. */
export function speculativeDictationText(stable: string, partial: string): string {
  if (!partial) return stable;
  if (!stable) return partial;
  if (partial.startsWith(stable)) return partial;
  const combined = partial + "\0" + stable.slice(-partial.length);
  const prefix = new Uint32Array(combined.length);
  for (let i = 1; i < combined.length; i++) {
    let length = prefix[i - 1]!;
    while (length && combined[i] !== combined[length]) length = prefix[length - 1]!;
    if (combined[i] === combined[length]) length++;
    prefix[i] = length;
  }
  const overlap = prefix[prefix.length - 1]!;
  return overlap ? stable + partial.slice(overlap) : stable + "\n" + partial;
}

// A paragraph is reusable only while its exact source and editing context match.
// Corrections that can refer back across paragraphs take the full-text path.
export function dictationSegments(text: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  // Streaming Chinese often uses commas until the microphone closes. A comma
  // before an explicit new clause/request is also a useful paragraph boundary;
  // arbitrary word counts must not split names, numbers or unfinished words.
  for (const match of text.matchAll(/[。！？!?；;]+[”’"）)]*|[,，](?=\s*(?:请|然后|另外|最后|接下来|我们|你|我|他们|但是|不过|那么|所以|因此|I\b|We\b|Next\b|Finally\b))|\.(?=\s|$)/gu)) {
    const end = match.index! + match[0].length;
    if (end - start < 240) continue;
    pieces.push(text.slice(start, end).trim());
    start = end;
  }
  if (text.slice(start).trim()) pieces.push(text.slice(start).trim());
  if (!pieces.length) return [text];
  const correction = /不对|说错|更正|纠正|改成|改为|改到|换成|应该是|不是.+而是|取消|撤回|前面|刚才|等等|\b(?:actually|correction|instead|scratch that|I meant|change .* to)\b/iu;
  if (pieces.slice(1).some((part) => correction.test(part))) return [text];
  return pieces;
}

function joinEdits(parts: string[]): string {
  return parts.reduce((output, part) => {
    if (!output) return part;
    const listContinues = /(?:^|\n)\d+[.)] [^\n]+$/.test(output) && /^\d+[.)] /.test(part);
    return output + (listContinues ? "\n" : "\n\n") + part;
  }, "");
}

interface Candidate {
  raw: string;
  key: string;
  controller: AbortController;
  result: Promise<DictationCleanupResult>;
  value?: DictationCleanupResult;
  startedAt: number;
  finishedAt?: number;
}

interface PreviewSession {
  id: string;
  text: string;
  finished: boolean;
  requests: number;
  lastRequestAt: number;
  pieces: string[];
  candidates: Candidate[];
  cleanController?: AbortController;
}

/** One admitted dictation. Keep completed paragraphs and an editable tail;
 * never write provisional text into the destination application. */
export class DictationPreview {
  private session: PreviewSession | null = null;
  private expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly service: DictationTextService, private readonly now = Date.now) {}

  start(id: string): void {
    this.close();
    this.session = { id, text: "", finished: false, requests: 0, lastRequestAt: -Infinity, pieces: [], candidates: [] };
  }

  private reconcile(session: PreviewSession, text: string): void {
    session.text = text;
    session.pieces = dictationSegments(text);
    const firstChanged = session.candidates.findIndex((candidate, i) => candidate.raw !== session.pieces[i]);
    if (firstChanged >= 0) session.candidates.splice(firstChanged).forEach((candidate) => candidate.controller.abort());
  }

  observe(id: string, input: { text: string; partialText: string; quietMs: number }): void {
    const session = this.session;
    if (!session || session.id !== id || session.finished) return;
    const text = normalizeDictationText(input.text);
    this.reconcile(session, text);
    if (!text || text.length > 20_000 || session.requests >= 64 || this.now() - session.lastRequestAt < 1_500) return;
    const index = session.candidates.length;
    if (index >= session.pieces.length || session.candidates.some((candidate) => !candidate.value)) return;
    // Complete paragraphs can be prepared while the next sentence is spoken.
    // Speculate on the short tail only during an actual microphone pause.
    if (index === session.pieces.length - 1 && (input.partialText.trim() || input.quietMs < 650)) return;
    const raw = session.pieces[index]!;
    const preceding = joinEdits(session.candidates.map((candidate) => candidate.value!.text)).slice(-2_000);
    let prepared;
    try { prepared = this.service.prepare({ text: raw, context: "", timeoutMs: 20_000 }, preceding); }
    catch { return; }
    if (prepared.key === null) return;
    const controller = new AbortController();
    session.lastRequestAt = this.now();
    session.requests += 1;
    const candidate: Candidate = {
      raw, key: prepared.key, controller, startedAt: this.now(), result: prepared.run(controller.signal),
    };
    session.candidates.push(candidate);
    void candidate.result.then((result) => { candidate.value = result; candidate.finishedAt = this.now(); });
  }

  finish(id: string, text: string, trusted: boolean): void {
    const session = this.session;
    if (!session || session.id !== id) return;
    if (!trusted) { this.close(); return; }
    session.finished = true;
    this.reconcile(session, normalizeDictationText(text));
    this.expiry = setTimeout(() => { if (this.session === session) this.close(); }, 60_000);
    this.expiry.unref();
  }

  cancel(id: string): void {
    if (this.session?.id === id) this.close();
  }

  async clean(input: z.infer<typeof DictationCleanupSchema>) {
    const whole = this.service.prepare(input);
    const session = this.session;
    if (!session?.finished || session.id !== input.sessionId || whole.key === null ||
        session.text !== normalizeDictationText(input.text) || !session.candidates.length) {
      if (session?.id === input.sessionId) this.close();
      return { ...await whole.run(), cleanupSource: "final" as const, previewSavedMs: 0 };
    }
    const startedAt = this.now();
    const controller = new AbortController();
    session.cleanController = controller;
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Dictation cleanup deadline", "TimeoutError"));
      session.candidates.forEach((candidate) => candidate.controller.abort(controller.signal.reason));
    }, input.timeoutMs);
    timer.unref();
    const results: DictationCleanupResult[] = [];
    let reused = 0;
    let savedMs = 0;
    try {
      for (const [index, text] of session.pieces.entries()) {
        if (this.session !== session) throw new DOMException("Dictation cancelled", "AbortError");
        const prepared = this.service.prepare({ ...input, text }, joinEdits(results.map((result) => result.text)).slice(-2_000));
        const candidate = session.candidates[index];
        if (candidate && prepared.key !== null && candidate.key === prepared.key) {
          const result = await candidate.result;
          results.push(result);
          reused += 1;
          savedMs += Math.max(0, Math.min(candidate.finishedAt ?? this.now(), startedAt) - candidate.startedAt);
        } else {
          candidate?.controller.abort();
          results.push(await prepared.run(controller.signal));
        }
      }
      if (this.session !== session) throw new DOMException("Dictation cancelled", "AbortError");
      const failed = results.find((result) => result.warning);
      const cleaned = results.find((result) => result.status === "cleaned");
      const metadata = failed ?? cleaned ?? results[0]!;
      return { ...metadata, text: joinEdits(results.map((result) => result.text)),
        cleanupSource: reused ? (session.pieces.length > 1 ? "incremental" as const : "preview" as const) : "final" as const,
        previewSavedMs: savedMs };
    } finally {
      clearTimeout(timer);
      if (this.session === session) this.close();
    }
  }

  close(): void {
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    this.session?.candidates.forEach((candidate) => candidate.controller.abort());
    this.session?.cleanController?.abort();
    this.session = null;
  }
}
