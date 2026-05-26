import { useMemo } from "react";
import type { ReactNode } from "react";
import { trpc } from "../trpc.js";
import "./TranscriptView.css";

export interface TranscriptViewProps {
  text: string;
}

interface GlossaryRow {
  term: string;
}

const SPEAKER_RE = /^(Speaker [A-Z]:)/;

export function TranscriptView({ text }: TranscriptViewProps) {
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

  return (
    <div className="transcript">
      {text.split("\n").map((line, i) => (
        <p key={i} className="transcript-line">
          {renderLine(line, vocabRegex)}
        </p>
      ))}
    </div>
  );
}

function renderLine(line: string, vocabRegex: RegExp | null): ReactNode {
  const speakerMatch = line.match(SPEAKER_RE);
  let prefix: ReactNode = null;
  let body = line;
  if (speakerMatch) {
    prefix = <span className="speaker">{speakerMatch[1]}</span>;
    body = line.slice(speakerMatch[1]!.length);
  }
  if (!vocabRegex) {
    return (
      <>
        {prefix}
        {body}
      </>
    );
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
  return (
    <>
      {prefix}
      {parts}
    </>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
