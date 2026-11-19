import { useEffect, useId, useState } from "react";
import "./MermaidDiagram.css";

type Mermaid = typeof import("mermaid")["default"];

let loading: Promise<Mermaid> | null = null;
function loadMermaid(): Promise<Mermaid> {
  // The renderer is large; load it only when a note actually has a diagram.
  loading ??= import("mermaid").then((module) => module.default);
  return loading;
}

/**
 * A Mermaid diagram from live notes, drawn on this Mac. Strict security keeps
 * labels as text and disables click handlers and links. A diagram that does not
 * parse shows its source instead, so the notes never break.
 */
export function MermaidDiagram({ source }: { source: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const dark = document.documentElement.getAttribute("data-theme") === "dark";
    loadMermaid()
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "neutral",
          fontFamily: "inherit",
        });
        const result = await mermaid.render(id, source);
        if (!cancelled) {
          setSvg(result.svg);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [id, source]);

  if (failed) return <pre className="mermaid-source"><code>{source}</code></pre>;
  if (!svg) return <div className="mermaid-diagram mermaid-diagram--loading" aria-hidden="true" />;
  return <figure className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
