import { useState, useEffect } from "react";
import "./CommandEditor.css";

export interface CommandEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
}

export function CommandEditor({ value, onChange }: CommandEditorProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);

  const commit = (next: string[]) => { setDraft(next); onChange(next); };

  const updateAt = (i: number, v: string) => {
    const next = draft.slice();
    next[i] = v;
    setDraft(next);
  };

  const onBlurAt = (i: number) => {
    if (draft[i] !== value[i]) onChange(draft);
  };

  const removeAt = (i: number) => {
    const next = draft.slice();
    next.splice(i, 1);
    commit(next);
  };

  const add = () => commit([...draft, ""]);

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
          />
          <button type="button" className="cmd-remove" onClick={() => removeAt(i)} aria-label={`Remove arg ${i}`}>×</button>
        </div>
      ))}
      <button type="button" className="cmd-add" onClick={add}>+ Add arg</button>
    </div>
  );
}
