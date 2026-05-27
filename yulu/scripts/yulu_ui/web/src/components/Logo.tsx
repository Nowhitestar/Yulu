import "./Logo.css";

export interface LogoProps {
  size?: number;
}

/**
 * Yulu brand mark — Songti SC 语 + cinnabar dot on parchment.
 * Inlines assets/logo.svg so it works offline and inherits React state.
 */
export function Logo({ size = 30 }: LogoProps) {
  return (
    <svg
      className="yulu-logo"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 120 120"
      width={size}
      height={size}
      role="img"
      aria-label="Yulu"
    >
      <rect width="120" height="120" rx="22" fill="#F5F1E8" />
      <text
        x="60"
        y="84"
        fontFamily="'Songti SC', 'STSong', 'Source Han Serif CN', 'Noto Serif CJK SC', 'Hiragino Mincho ProN', serif"
        fontSize="74"
        fontWeight="500"
        fill="#1B1B1B"
        textAnchor="middle"
      >
        语
      </text>
      <circle cx="96" cy="94" r="3.6" fill="#A23B2B" />
    </svg>
  );
}
