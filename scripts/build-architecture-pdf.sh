#!/usr/bin/env bash
#
# Convert a Markdown doc (default: docs/architecture.md) into a proper PDF with
# its Mermaid diagrams rendered as images.
#
# Pipeline: mmdc renders every ```mermaid block to a PNG, then pandoc + xelatex
# produces the PDF (clickable TOC, capped image sizes, arrow-glyph fallback).
#
# Usage:
#   scripts/build-architecture-pdf.sh [SRC_MD] [OUT_PDF]
#
#   SRC_MD   source Markdown   (default: docs/architecture.md)
#   OUT_PDF  output PDF path    (default: docs/pdf/architecture.pdf)
#
# Requirements (all CLI tools on PATH):
#   - @mermaid-js/mermaid-cli   (mmdc)   — npm i -g @mermaid-js/mermaid-cli
#   - pandoc                              — brew install pandoc
#   - xelatex                             — a TeX distribution (e.g. MacTeX / TeX Live)
#
set -euo pipefail

# --- Resolve repo root (works from any cwd) ---------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC="${1:-$REPO_ROOT/docs/architecture.md}"
OUT="${2:-$REPO_ROOT/docs/pdf/architecture.pdf}"

# --- Prerequisite checks -----------------------------------------------------
missing=0
for tool in mmdc pandoc xelatex; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' not found on PATH." >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || { echo "Install the missing tool(s) above and retry." >&2; exit 1; }
[ -f "$SRC" ] || { echo "error: source not found: $SRC" >&2; exit 1; }

mkdir -p "$(dirname "$OUT")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1. Drop the hand-written "## Table of contents" section -----------------
# pandoc's --toc generates one whose links actually resolve; keeping both would
# duplicate it and leave broken anchors. Removes the heading through the next "## ".
awk '
  /^## Table of contents/ {skip=1; next}
  skip && /^## / {skip=0}
  !skip {print}
' "$SRC" > "$WORK/doc.md"

# --- 2. Render every ```mermaid block to a PNG (white bg, hi-res) -------------
mmdc -i "$WORK/doc.md" -o "$WORK/doc.pp.md" -e png -b white -w 1600 >/dev/null

# --- 3. LaTeX header: cap image size + arrow-glyph fallback -------------------
# Helvetica Neue lacks → and ⇒; map just those to Arial Unicode MS so body text
# keeps its font. Cap image width AND height so wide/tall diagrams fit the page.
cat > "$WORK/header.tex" <<'TEX'
\usepackage{graphicx}
\makeatletter
\def\maxwidth{\ifdim\Gin@nat@width>\linewidth\linewidth\else\Gin@nat@width\fi}
\def\maxheight{\ifdim\Gin@nat@height>0.85\textheight0.85\textheight\else\Gin@nat@height\fi}
\makeatother
\setkeys{Gin}{width=\maxwidth,height=\maxheight,keepaspectratio}
\usepackage{newunicodechar}
\newfontfamily{\fallbackfont}{Arial Unicode MS}
\newunicodechar{→}{{\fallbackfont →}}
\newunicodechar{⇒}{{\fallbackfont ⇒}}
TEX

# --- 4. Markdown → PDF -------------------------------------------------------
# --from=markdown-implicit_figures renders diagrams inline (no "Figure N:" caption).
# Capitalize the basename portably (avoid bash-4-only ${var^}).
title="$(basename "$SRC" .md | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
pandoc "$WORK/doc.pp.md" -o "$OUT" \
  --pdf-engine=xelatex \
  --from=markdown-implicit_figures \
  --toc --toc-depth=3 \
  --resource-path="$WORK" \
  -V geometry:margin=1in \
  -V colorlinks=true -V linkcolor=RoyalBlue -V urlcolor=RoyalBlue -V toccolor=black \
  -V mainfont="Helvetica Neue" -V monofont="Menlo" -V fontsize=10pt \
  --highlight-style=tango \
  -H "$WORK/header.tex" \
  --metadata title="Loom — $title" \
  --metadata author="Loom"

echo "wrote $OUT"
