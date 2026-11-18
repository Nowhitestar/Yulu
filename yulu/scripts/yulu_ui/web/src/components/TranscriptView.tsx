import { useMemo } from "react";
import type { CSSProperties, ReactNode } from "react";
import { trpc } from "../trpc.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./TranscriptView.css";

export interface TranscriptViewProps {
  text: string;
  speakerData?: SpeakerData | null;
  onSeek?: (time: number) => void;
  onAssignSpeaker?: (segmentIndex: number, speakerId: string) => void;
}

interface GlossaryRow {
  term: string;
}

export interface SpeakerData {
  segments?: SpeakerSegment[];
  speakers?: Record<string, SpeakerEntry>;
}

export interface SpeakerSegment {
  start?: number;
  end?: number;
  text?: string;
  speaker_id?: string;
  display_name?: string;
  source?: string;
  confident?: boolean;
}

interface SpeakerEntry {
  display_name?: string;
  merged_into?: string | null;
}

interface RenderSegment extends SpeakerSegment {
  index: number;
  speakerId: string;
  displayName: string;
  color: string;
}

interface SpeakerOption {
  id: string;
  name: string;
  color: string;
}

const LEGACY_SPEAKER_RE = /^(Speaker [A-Z]:)/;
const TAGGED_LINE_RE = /^\[(\d{2}:\d{2}(?::\d{2})?)\s+(.+?)\]\s*(.*)$/;
const SPEAKER_COLORS = [
  "var(--blue)",
  "var(--green)",
  "var(--purple)",
  "var(--accent)",
  "var(--red)",
  "#5CCFE6",
];

export function TranscriptView({ text, speakerData, onSeek, onAssignSpeaker }: TranscriptViewProps) {
  const t = useT();
  const { data, isError } = trpc.glossary.list.useQuery();

  const vocabRegex = useMemo(() => {
    if (isError || !data) return null;
    const terms = (data as GlossaryRow[])
      .map((r) => r.term)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (terms.length === 0) return null;
    const escaped = terms.map(escapeRegExp);
    return new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
  }, [data, isError]);

  const speakerOptions = useMemo(() => buildSpeakerOptions(speakerData), [speakerData]);
  const speakerSegments = useMemo(
    () => buildSegments(speakerData, speakerOptions),
    [speakerData, speakerOptions],
  );

  if (speakerSegments.length > 0) {
    return (
      <div className="transcript transcript-speakerized">
        {speakerSegments.map((seg) => (
          <p
            key={seg.index}
            className={"transcript-line transcript-speaker-line" + (seg.confident === false ? " low-confidence" : "")}
            style={{ "--speaker-color": seg.color } as CSSProperties}
          >
            <button
              type="button"
              className="transcript-time"
              onClick={() => onSeek?.(Number(seg.start ?? 0))}
              aria-label={t("transcript.speaker.seek.aria", { time: formatTimestamp(seg.start) })}
            >
              {formatTimestamp(seg.start)}
            </button>
            <span className="speaker speaker-badge">{seg.displayName}</span>
            {seg.confident === false && (
              <span className="speaker-confidence" title={t("transcript.speaker.lowConfidence")}>?</span>
            )}
            <span className="transcript-content">
              {renderText(String(seg.text ?? ""), vocabRegex)}
            </span>
            {onAssignSpeaker && speakerOptions.length > 1 && (
              <select
                className="transcript-speaker-select"
                value={seg.speakerId}
                aria-label={t("transcript.speaker.assign.aria", { time: formatTimestamp(seg.start) })}
                onChange={(e) => onAssignSpeaker(seg.index, e.target.value)}
              >
                {speakerOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.name}</option>
                ))}
              </select>
            )}
          </p>
        ))}
      </div>
    );
  }

  return (
    <div className="transcript">
      {text.split("\n").map((line, i) => (
        <p key={i} className="transcript-line">
          {renderLine(line, vocabRegex, onSeek, t)}
        </p>
      ))}
    </div>
  );
}

function renderLine(
  line: string,
  vocabRegex: RegExp | null,
  onSeek: ((time: number) => void) | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
): ReactNode {
  const taggedMatch = line.match(TAGGED_LINE_RE);
  if (taggedMatch) {
    const [, rawTs, speaker = "", body = ""] = taggedMatch;
    const ts = rawTs ?? "00:00";
    const seconds = parseTimestamp(ts);
    return (
      <>
        {onSeek ? (
          <button
            type="button"
            className="transcript-time"
            onClick={() => onSeek(seconds)}
            aria-label={t("transcript.speaker.seek.aria", { time: ts })}
          >
            {ts}
          </button>
        ) : (
          <span className="transcript-time">{ts}</span>
        )}
        <span className="speaker speaker-badge">{speaker}</span>
        <span className="transcript-content">{renderText(body, vocabRegex)}</span>
      </>
    );
  }

  const speakerMatch = line.match(LEGACY_SPEAKER_RE);
  let prefix: ReactNode = null;
  let body = line;
  if (speakerMatch) {
    prefix = <span className="speaker">{speakerMatch[1]}</span>;
    body = line.slice(speakerMatch[1]!.length);
  }
  return (
    <>
      {prefix}
      {renderText(body, vocabRegex)}
    </>
  );
}

function renderText(body: string, vocabRegex: RegExp | null): ReactNode {
  if (!vocabRegex) {
    return body;
  }
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  // Reset regex state (global flag preserves lastIndex across calls)
  vocabRegex.lastIndex = 0;
  body.replace(vocabRegex, (match, _g1, offset: number) => {
    if (offset > lastIndex) parts.push(body.slice(lastIndex, offset));
    parts.push(
      <span key={offset} className="vocab">
        {match}
      </span>,
    );
    lastIndex = offset + match.length;
    return match;
  });
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));
  return parts;
}

function buildSpeakerOptions(speakerData?: SpeakerData | null): SpeakerOption[] {
  if (!speakerData) return [];
  const ids = new Set<string>();
  const speakers = speakerData.speakers ?? {};
  for (const id of Object.keys(speakers)) ids.add(resolveSpeakerId(speakerData, id));
  for (const seg of speakerData.segments ?? []) {
    if (seg.speaker_id) ids.add(resolveSpeakerId(speakerData, seg.speaker_id));
  }
  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .filter(Boolean)
    .map((id, index) => ({
      id,
      name: speakerDisplayName(speakerData, id),
      color: SPEAKER_COLORS[index % SPEAKER_COLORS.length]!,
    }));
}

function buildSegments(speakerData: SpeakerData | null | undefined, options: SpeakerOption[]): RenderSegment[] {
  if (!speakerData?.segments?.length) return [];
  return speakerData.segments
    .map((seg, index) => {
      const speakerId = resolveSpeakerId(speakerData, seg.speaker_id || "unknown");
      const option = options.find((opt) => opt.id === speakerId);
      return {
        ...seg,
        index,
        speakerId,
        displayName: speakerDisplayName(speakerData, speakerId),
        color: option?.color ?? "var(--fg-3)",
      };
    })
    .filter((seg) => String(seg.text ?? "").trim().length > 0)
    .sort((a, b) => Number(a.start ?? 0) - Number(b.start ?? 0));
}

function resolveSpeakerId(speakerData: SpeakerData, speakerId: string): string {
  let cur = speakerId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const next = speakerData.speakers?.[cur]?.merged_into;
    if (!next) break;
    cur = next;
  }
  return cur;
}

function speakerDisplayName(speakerData: SpeakerData, speakerId: string): string {
  const resolved = resolveSpeakerId(speakerData, speakerId);
  const name = speakerData.speakers?.[resolved]?.display_name;
  if (name && name.trim()) return name;
  if (resolved === "unknown") return "Unknown";
  const m = resolved.match(/^spk-(\d+)$/);
  if (m?.[1]) return `Speaker ${Number(m[1]) + 1}`;
  return resolved;
}

function formatTimestamp(seconds: unknown): string {
  const total = Math.max(0, Math.floor(typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function parseTimestamp(ts: string | undefined): number {
  const parts = String(ts ?? "0:00").split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  return 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
