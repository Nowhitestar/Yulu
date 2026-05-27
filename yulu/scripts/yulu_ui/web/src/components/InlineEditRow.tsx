import { useEffect, useRef, useState } from "react";
import { trpc } from "../trpc.js";
import "./InlineEditRow.css";

export type RowStatus = "saved" | "restart" | "typing" | null;

interface BaseProps {
  label: string;
  help?: string;
  status?: RowStatus;
}

type TextProps = BaseProps & { type: "text"; value: string; onCommit: (v: string) => void };
type NumberProps = BaseProps & { type: "number"; value: number; min?: number; max?: number; step?: number; onCommit: (v: number) => void };
type SelectProps = BaseProps & { type: "select"; value: string; options: Array<{ value: string; label: string }>; onCommit: (v: string) => void };
type ToggleProps = BaseProps & { type: "toggle"; value: boolean; onCommit: (v: boolean) => void };
type PathProps = BaseProps & { type: "path"; value: string; mode: "file" | "folder"; filter?: "wav" | "bin" | "json" | "pem"; onCommit: (v: string) => void };
type ReadonlyProps = BaseProps & { type: "readonly"; value: string; revealInFinder?: boolean };

export type InlineEditRowProps = TextProps | NumberProps | SelectProps | ToggleProps | PathProps | ReadonlyProps;

export function InlineEditRow(props: InlineEditRowProps) {
  return (
    <div className="row">
      <div className="row-label">
        <div>{props.label}</div>
        {props.help && <div className="row-help">{props.help}</div>}
      </div>
      <div className="row-value">{renderValue(props)}</div>
      <div className="row-status" data-testid="row-status">{statusGlyph(props.status)}</div>
    </div>
  );
}

function statusGlyph(status: RowStatus | undefined) {
  if (status === "saved") return <span className="status-saved">✓</span>;
  if (status === "restart") return <span className="status-restart">⟳</span>;
  if (status === "typing") return <span className="status-typing">●</span>;
  return null;
}

function renderValue(props: InlineEditRowProps): React.ReactNode {
  switch (props.type) {
    case "text":     return <TextValue {...props} />;
    case "number":   return <NumberValue {...props} />;
    case "select":   return <SelectValue {...props} />;
    case "toggle":   return <ToggleValue {...props} />;
    case "path":     return <PathValue {...props} />;
    case "readonly": return <ReadonlyValue {...props} />;
  }
}

function TextValue({ value, onCommit }: TextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  useEffect(() => { setDraft(value); }, [value]);

  if (!editing) return <span className="value-display" onClick={() => setEditing(true)}>{value}</span>;
  const commit = () => { setEditing(false); if (draft !== value) onCommit(draft); };
  return (
    <input
      ref={ref}
      className="value-input"
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
    />
  );
}

function NumberValue({ value, onCommit, min, max, step }: NumberProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  useEffect(() => { setDraft(String(value)); }, [value]);

  if (!editing) return <span className="value-display" onClick={() => setEditing(true)}>{value}</span>;
  const commit = () => {
    setEditing(false);
    const n = parseFloat(draft);
    if (!Number.isFinite(n)) { setDraft(String(value)); return; }
    if (n !== value) onCommit(n);
  };
  return (
    <input
      ref={ref}
      className="value-input"
      type="number"
      value={draft}
      min={min} max={max} step={step}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(String(value)); setEditing(false); } }}
    />
  );
}

function SelectValue({ value, options, onCommit }: SelectProps) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  if (!editing) {
    const label = options.find((o) => o.value === value)?.label ?? value;
    return <span className="value-display" onClick={() => setEditing(true)}>{label}</span>;
  }
  return (
    <select
      ref={ref}
      className="value-input"
      value={value}
      onChange={(e) => { setEditing(false); if (e.target.value !== value) onCommit(e.target.value); }}
      onBlur={() => setEditing(false)}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function ToggleValue({ value, onCommit }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={"toggle" + (value ? " on" : "")}
      onClick={() => onCommit(!value)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function PathValue({ value, mode, filter, onCommit }: PathProps) {
  const pickFile = trpc.system.pickFile.useMutation();
  const openInFinder = trpc.system.openInFinder.useMutation();
  const choose = async () => {
    const res = await pickFile.mutateAsync({ mode, filter });
    if (res.path) onCommit(res.path);
  };
  return (
    <div className="path-value">
      <span className="path-display" title={value}>{value || "(unset)"}</span>
      <button type="button" className="path-btn" onClick={choose} disabled={pickFile.isPending}>Choose…</button>
      {value && <button type="button" className="path-btn" onClick={() => openInFinder.mutate({ path: value, reveal: true })}>Reveal</button>}
    </div>
  );
}

function ReadonlyValue({ value, revealInFinder }: ReadonlyProps) {
  const openInFinder = trpc.system.openInFinder.useMutation();
  return (
    <div className="path-value">
      <span className="path-display">{value}</span>
      {revealInFinder && <button type="button" className="path-btn" onClick={() => openInFinder.mutate({ path: value, reveal: true })}>Reveal</button>}
    </div>
  );
}
