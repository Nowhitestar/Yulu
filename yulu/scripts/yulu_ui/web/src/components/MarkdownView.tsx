import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./MarkdownView.css";

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
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
