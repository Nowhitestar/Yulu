import { useState, useEffect } from "react";
import { useT } from "../i18n/LanguageProvider.js";
import "./CommandEditor.css";

export interface CommandEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
}

export function CommandEditor({ value, onChange }: CommandEditorProps) {
  const t = useT();
  const [draft, setDraft] = useState(() => cleanArgs(value));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const cleanValue = cleanArgs(value);
    if (sameArgs(cleanValue, draft)) {
      if (dirty) setDirty(false);
      return;
    }
    if (!dirty) setDraft(cleanValue);
  }, [value, draft, dirty]);

  const commit = (next: string[]) => {
    const clean = cleanArgs(next);
    setDirty(true);
    setDraft(clean);
    onChange(clean);
  };

  const updateAt = (i: number, v: string) => {
    const next = draft.slice();
    next[i] = v;
    setDirty(true);
    setDraft(next);
  };

  const onBlurAt = (i: number) => {
    const cleanValue = cleanArgs(value);
    const clean = cleanArgs(draft);
    if (sameArgs(clean, cleanValue)) {
      setDirty(false);
      setDraft(cleanValue);
      return;
    }
    commit(clean);
  };

  const removeAt = (i: number) => {
    const next = draft.slice();
    next.splice(i, 1);
    commit(next);
  };

  const add = () => { setDirty(true); setDraft([...draft, ""]); };

  const onDragStart = (i: number) => (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", String(i));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
  const onDrop = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const from = Number(e.dataTransfer.getData("text/plain"));
    if (from === i || Number.isNaN(from)) return;
    const next = draft.slice();
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved!);
    commit(next);
  };

  return (
    <div className="cmd-editor">
      {draft.map((arg, i) => (
        <div
          key={i}
          className="cmd-row"
          draggable
          onDragStart={onDragStart(i)}
          onDragOver={onDragOver}
          onDrop={onDrop(i)}
        >
          <span className="cmd-grip" aria-hidden="true">⠿</span>
          <input
            className="cmd-input"
            type="text"
            value={arg}
            onChange={(e) => updateAt(i, e.target.value)}
            onBlur={() => onBlurAt(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") { setDirty(false); setDraft(cleanArgs(value)); }
            }}
          />
          <button type="button" className="cmd-remove" onClick={() => removeAt(i)} aria-label={t("cmd.removeAria", { i })}>×</button>
        </div>
      ))}
      <button type="button" className="cmd-add" onClick={add}>{t("cmd.add")}</button>
    </div>
  );
}

function sameArgs(a: string[], b: string[]) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function cleanArgs(args: string[]) {
  return args.filter((arg) => arg.trim().length > 0);
}
