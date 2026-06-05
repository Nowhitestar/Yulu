import { useEffect, useRef, useState } from "react";
import { X, Plus } from "lucide-react";
import "./TagEditor.css";

export interface TagEditorProps {
  tags: string[];
  onChange: (tags: string[]) => void;
  disabled?: boolean;
}

/**
 * Compact tag chip editor. Type + Enter (or comma) to add, click ✕ to remove.
 * Normalizes locally (trim, case-insensitive dedupe) so the optimistic UI
 * matches what the server's parseTags() will persist.
 */
export function TagEditor({ tags, onChange, disabled }: TagEditorProps) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (adding) ref.current?.focus(); }, [adding]);

  const commit = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) {
      const next = [...tags];
      const lower = new Set(next.map((t) => t.toLowerCase()));
      for (const p of parts) {
        if (!lower.has(p.toLowerCase())) { next.push(p); lower.add(p.toLowerCase()); }
      }
      if (next.length !== tags.length) onChange(next);
    }
    setDraft("");
    setAdding(false);
  };

  const remove = (tag: string) => {
    onChange(tags.filter((t) => t !== tag));
  };

  return (
    <div className="tag-editor" data-testid="tag-editor">
      {tags.map((t) => (
        <span key={t} className="tag-chip">
          {t}
          {!disabled && (
            <button
              type="button"
              className="tag-chip-remove"
              aria-label={`Remove tag ${t}`}
              onClick={() => remove(t)}
            >
              <X size={11} strokeWidth={2.25} />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        adding ? (
          <input
            ref={ref}
            className="tag-input"
            value={draft}
            placeholder="tag…"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
              else if (e.key === "Escape") { setDraft(""); setAdding(false); }
            }}
          />
        ) : (
          <button
            type="button"
            className="tag-add"
            aria-label="Add tag"
            onClick={() => setAdding(true)}
          >
            <Plus size={12} strokeWidth={2} />
            {tags.length === 0 && <span>Add tag</span>}
          </button>
        )
      )}
    </div>
  );
}
