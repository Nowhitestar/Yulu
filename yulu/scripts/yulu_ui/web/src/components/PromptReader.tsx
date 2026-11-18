import { useEffect, useState } from "react";
import { useConfirm } from "../hooks/useConfirm.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./PromptReader.css";

export type Category = "summary" | "cleanup" | "voice";

export interface PromptData {
  id: string;
  slug: string;
  name: string;
  category: Category;
  content: string;
  is_auto_run: number;       // SQLite stores 0/1
  source: string;
  sort_order: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface UpdateInput {
  name?: string;
  slug?: string;
  category?: Category;
  content?: string;
  isAutoRun?: boolean;
}

export interface CreateInput {
  name: string;
  slug: string;
  category: Category;
  content: string;
  isAutoRun: boolean;
}

export interface PromptReaderProps {
  prompt: PromptData | null;          // null = create mode
  onSave: (input: UpdateInput | CreateInput) => void;
  onDelete: () => void;
}

const CATEGORIES: Category[] = ["summary", "cleanup", "voice"];

export function PromptReader({ prompt, onSave, onDelete }: PromptReaderProps) {
  const t = useT();
  const isCreate = prompt === null;
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [category, setCategory] = useState<Category>("summary");
  const [content, setContent] = useState("");
  const [isAutoRun, setIsAutoRun] = useState(false);
  const autoRunAvailable = category === "summary";

  useEffect(() => {
    if (prompt) {
      setName(prompt.name);
      setSlug(prompt.slug);
      setCategory(prompt.category);
      setContent(prompt.content);
      setIsAutoRun(prompt.category === "summary" && prompt.is_auto_run === 1);
    } else {
      setName(""); setSlug(""); setCategory("summary"); setContent(""); setIsAutoRun(false);
    }
  }, [prompt]);

  const confirm = useConfirm();

  let canSave = false;
  let pendingDiff: UpdateInput | CreateInput | null = null;

  if (isCreate) {
    canSave = !!name.trim() && !!slug.trim() && !!content.trim();
    pendingDiff = { name, slug, category, content, isAutoRun };
  } else {
    const diff: UpdateInput = {};
    if (name !== prompt!.name) diff.name = name;
    if (slug !== prompt!.slug) diff.slug = slug;
    if (category !== prompt!.category) diff.category = category;
    if (content !== prompt!.content) diff.content = content;
    if (isAutoRun !== (prompt!.is_auto_run === 1)) diff.isAutoRun = isAutoRun;
    canSave = Object.keys(diff).length > 0;
    pendingDiff = diff;
  }

  const onSaveClick = () => { if (pendingDiff) onSave(pendingDiff); };
  const onDeleteClick = () => {
    if (confirm(t("promptReader.deleteConfirm", { name: prompt?.name ?? "" }))) onDelete();
  };

  return (
    <div className="preader">
      <div className="preader-field">
        <label className="preader-label" htmlFor="prompt-name">{t("promptReader.name")}</label>
        <input id="prompt-name" className="preader-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="preader-meta">
        <div className="preader-field">
          <label className="preader-label" htmlFor="prompt-slug">{t("promptReader.slug")}</label>
          <input id="prompt-slug" className="field preader-slug" value={slug} onChange={(e) => setSlug(e.target.value)} />
        </div>
        <div className="preader-field">
          <label className="preader-label" htmlFor="prompt-category">{t("promptReader.category")}</label>
          <select
            id="prompt-category"
            className="field"
            value={category}
            onChange={(e) => {
              const next = e.target.value as Category;
              setCategory(next);
              if (next !== "summary") setIsAutoRun(false);
            }}
          >
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
          </select>
        </div>
      </div>
      <div className="preader-autorun">
        <div>
          <span className="preader-autorun-title">{t("promptReader.autorun")}</span>
          <span id="prompt-autorun-help" className="preader-help">
            {t(autoRunAvailable ? "promptReader.autorunHelp" : "promptReader.autorunSummaryOnly")}
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isAutoRun}
          aria-label={t("promptReader.autorun")}
          aria-describedby="prompt-autorun-help"
          disabled={!autoRunAvailable}
          className={"preader-toggle" + (isAutoRun ? " on" : "")}
          onClick={() => setIsAutoRun(!isAutoRun)}
        >
          <span className="preader-toggle-knob" />
        </button>
      </div>
      <div className="preader-field">
        <label className="preader-label" htmlFor="prompt-content">{t("promptReader.content")}</label>
        <textarea
          id="prompt-content"
          className="field preader-textarea"
          value={content}
          spellCheck={false}
          onChange={(e) => setContent(e.target.value)}
          rows={Math.max(15, content.split("\n").length + 2)}
        />
      </div>
      <div className="preader-actions">
        <button type="button" className="btn btn-primary" disabled={!canSave} onClick={onSaveClick}>{t("promptReader.save")}</button>
        {!isCreate && (
          <button type="button" className="btn btn-danger" onClick={onDeleteClick}>{t("promptReader.delete")}</button>
        )}
      </div>
    </div>
  );
}
