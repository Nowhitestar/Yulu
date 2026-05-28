import { useEffect, useRef, useState } from "react";
import { useWsChannel } from "../ws.js";
import "./LogTail.css";

export interface LogTailProps {
  daemonShortName: string;
  daemonLabel: string;
  initialLines: string[];
  paused: boolean;
  onClear: () => void;
}

const MAX_LINES = 2000;
const AUTOSCROLL_THRESHOLD_PX = 50;

export function LogTail({ daemonShortName, daemonLabel, initialLines, paused }: LogTailProps) {
  const [lines, setLines] = useState<string[]>(initialLines);
  const preRef = useRef<HTMLPreElement>(null);
  const pausedRef = useRef(paused);

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { setLines(initialLines); }, [initialLines]);

  useWsChannel("logs", (msg: { name: string; line: string; ts: number }) => {
    if (msg.name !== daemonShortName) return;
    if (pausedRef.current) return;
    setLines((prev) => {
      const next = prev.concat(msg.line);
      if (next.length > MAX_LINES) return next.slice(next.length - MAX_LINES);
      return next;
    });
  });

  // Auto-scroll to bottom unless user scrolled up
  useEffect(() => {
    const pre = preRef.current;
    if (!pre) return;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < AUTOSCROLL_THRESHOLD_PX;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }, [lines]);

  if (lines.length === 0) {
    return (
      <div className="logtail" data-daemon={daemonLabel}>
        <div className="logtail-empty">No log entries yet for {daemonShortName}.</div>
      </div>
    );
  }

  return (
    <div className="logtail" data-daemon={daemonLabel}>
      <pre ref={preRef} className="logtail-pre" data-testid="logtail-pre">
        {lines.map((line, i) => (
          <div key={i} className="logtail-line">{line}</div>
        ))}
      </pre>
    </div>
  );
}
