import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Play, Pause } from "lucide-react";
import { useT } from "../i18n/LanguageProvider.js";
import "./AudioPlayer.css";

export interface AudioPlayerProps {
  src: string;
  initialSeek?: number;
  onSeek?: (time: number) => void;
}

export function AudioPlayer({ src, initialSeek, onSeek }: AudioPlayerProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<ReturnType<typeof WaveSurfer.create> | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    // Reset local state for the new src — prevents stale isPlaying / duration
    // from leaking into the new track's UI before its events fire.
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setReady(false);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: src,
      waveColor: "rgba(139, 146, 160, 0.55)",
      progressColor: "var(--accent)",
      cursorColor: "var(--accent)",
      barWidth: 2,
      barRadius: 2,
      barGap: 1,
      height: 48,
      normalize: true,
    });
    wsRef.current = ws;
    ws.on("ready", () => {
      setDuration(ws.getDuration());
      setReady(true);
      if (typeof initialSeek === "number" && initialSeek > 0) ws.setTime(initialSeek);
    });
    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));
    ws.on("finish", () => setIsPlaying(false));
    ws.on("audioprocess", (t: number) => {
      setCurrentTime(t);
      onSeek?.(t);
    });
    ws.on("seeking", (t: number) => {
      setCurrentTime(t);
      onSeek?.(t);
    });
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const toggle = () => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    if (isPlaying) ws.pause();
    else ws.play();
  };

  return (
    <div className="audioplayer">
      <button
        type="button"
        className="audioplayer-play"
        onClick={toggle}
        disabled={!ready}
        aria-label={isPlaying ? t("player.pause") : t("player.play")}
      >
        {isPlaying ? <Pause size={14} strokeWidth={1.75} /> : <Play size={14} strokeWidth={1.75} />}
      </button>
      <div ref={containerRef} className="audioplayer-wave" />
      <div className="audioplayer-time">
        {formatTime(currentTime)} / {formatTime(duration)}
      </div>
    </div>
  );
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
