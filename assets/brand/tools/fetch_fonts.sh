#!/usr/bin/env bash
# Download the font subsets the brand kit outlines (only the glyphs it sets).
# Usage: fetch_fonts.sh <fonts_dir>
# All four families are under the SIL Open Font License; the kit ships the
# outlined paths, never the font files.
set -euo pipefail
OUT="${1:?usage: fetch_fonts.sh <fonts_dir>}"
mkdir -p "$OUT"
# An old user agent makes Google Fonts serve TrueType, which fontTools reads.
UA="Mozilla/5.0 (Windows NT 6.1) AppleWebKit/534.30 (KHTML, like Gecko) Safari/534.30"
fetch() { # file name, css2 URL
  local css url
  css=$(curl -fsS -A "$UA" "$2")
  url=$(printf '%s' "$css" | grep -o 'https://fonts.gstatic.com[^)]*' | head -1)
  [[ -n "$url" ]] || { echo "no font URL in $2" >&2; exit 1; }
  curl -fsS -A "$UA" -o "$OUT/$1" "$url"
}
fetch notoserif-sc-700.ttf "https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@700&text=%E8%AF%AD%E5%BD%95"
fetch fraunces-600-144.ttf "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@144,600&text=Yulu"
fetch fraunces-400-72.ttf "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@72,400&text=NativeMmgcpur.Lsy-Agdtn%20ACefhilory"
fetch inter-400.ttf "https://fonts.googleapis.com/css2?family=Inter:wght@400&text=macOS%C2%B7localbydefuitvnsMCP%20"
echo "fonts in $OUT"
