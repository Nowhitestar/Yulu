import { useId } from "react";
import "./Logo.css";

export interface LogoProps {
  size?: number;
}

const SILHOUETTE = [
  "M64 22",
  "C89 21 108 35 116 52",
  "C124 68 121 84 110 96",
  "C100 106 84 109 64 109",
  "C42 109 25 106 15 96",
  "C6 86 5 72 12 59",
  "C20 39 39 24 60 22",
  "C61 22 63 22 64 22 Z",
].join(" ");

function quote(cx: number): string {
  return [
    `M${cx + 8} 36`,
    `C${cx + 10} 36 ${cx + 10} 39 ${cx + 8} 40`,
    `C${cx + 1} 41 ${cx - 4} 45 ${cx - 7} 50`,
    `C${cx - 5} 49 ${cx - 2} 48 ${cx + 1} 48`,
    `C${cx + 8} 48 ${cx + 12} 54 ${cx + 12} 62`,
    `C${cx + 12} 70 ${cx + 7} 76 ${cx} 76`,
    `C${cx - 8} 76 ${cx - 13} 70 ${cx - 13} 62`,
    `C${cx - 13} 50 ${cx - 5} 40 ${cx + 8} 36 Z`,
  ].join(" ");
}

const QUOTE_LEFT = quote(49);
const QUOTE_RIGHT = quote(79);

/** Yulu's liquid-glass quotation mark from the final brand guide. */
export function Logo({ size = 30 }: LogoProps) {
  const uid = useId().replace(/:/g, "");

  return (
    <svg
      className="yulu-logo"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      width={size}
      height={size}
      role="img"
      aria-label="Yulu"
    >
      <defs>
        <linearGradient id={`yulu-lens-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="oklch(0.72 0.13 250)" />
          <stop offset="1" stopColor="oklch(0.5 0.16 262)" />
        </linearGradient>
        <linearGradient id={`yulu-bead-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.72" />
        </linearGradient>
        <radialGradient id={`yulu-glow-${uid}`} cx="0.32" cy="0.24" r="0.9">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="0.45" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <path data-testid="logo-silhouette" d={SILHOUETTE} fill={`url(#yulu-lens-${uid})`} />
      <path d={SILHOUETTE} fill={`url(#yulu-glow-${uid})`} />
      <g data-testid="logo-quotes" transform="translate(16 21) scale(0.75)">
        <path d={QUOTE_LEFT} fill={`url(#yulu-bead-${uid})`} />
        <path d={QUOTE_RIGHT} fill={`url(#yulu-bead-${uid})`} />
      </g>
      <path
        d={SILHOUETTE}
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.5"
        strokeWidth="1.6"
      />
    </svg>
  );
}
