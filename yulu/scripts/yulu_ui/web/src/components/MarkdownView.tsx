import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram.js";
import "./MarkdownView.css";

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

/** The source of a ```mermaid block, or null for any other <pre>. */
function mermaidSource(pre: HastNode | undefined): string | null {
  const code = pre?.children?.find((child) => child.type === "element" && child.tagName === "code");
  const classes = code?.properties?.className;
  if (!Array.isArray(classes) || !classes.includes("language-mermaid")) return null;
  return (code?.children ?? []).map((child) => (child.type === "text" ? child.value ?? "" : "")).join("");
}

export interface MarkdownViewProps {
  text: string;
}

/**
 * Render Markdown safely.
 *
 * The summary text is produced by the user's own LLM, but we still render it
 * defensively: react-markdown does NOT pass raw HTML through unless you opt in
 * with rehype-raw (we don't), so embedded `<script>`/`<img onerror=…>` etc. are
 * rendered as inert text, never injected into the DOM. remark-gfm adds tables,
 * strikethrough, task lists, and autolinks.
 *
 * Links are forced to open in a new tab with `rel="noopener noreferrer"` so a
 * malicious summary can't reach back into the opener.
 *
 * A ```mermaid block becomes a diagram drawn locally in strict mode; anything
 * else stays a code block.
 */
export function MarkdownView({ text }: MarkdownViewProps) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          pre: ({ children, node }) => {
            const source = mermaidSource(node as HastNode | undefined);
            return source !== null ? <MermaidDiagram source={source} /> : <pre>{children}</pre>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
