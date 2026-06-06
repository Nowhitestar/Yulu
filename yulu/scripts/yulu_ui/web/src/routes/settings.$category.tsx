// web/src/routes/settings.$category.tsx
import { useParams, useOutletContext } from "react-router";
import { categoryMeta } from "../components/settings/categories.js";
import type { SettingsOutletContext } from "./settings.js";

/**
 * SettingsCategory — the detail pane of the settings MasterDetail. Reads the
 * `:category` route param and renders that category's heading. Field rows and
 * rich section widgets are wired in Task 3.
 */
export function SettingsCategory() {
  const { category } = useParams();
  const { tracker: _tracker } = useOutletContext<SettingsOutletContext>();
  const meta = categoryMeta(category ?? "");

  if (!meta) {
    return (
      <div className="settings-detail">
        <div className="settings-detail-empty">未知设置分类。</div>
      </div>
    );
  }

  return (
    <div className="settings-detail">
      <div className="settings-detail-head">
        <h1 className="settings-detail-title">{meta.label}</h1>
        <p className="settings-detail-sub">{meta.description}</p>
      </div>
      {meta.id === "automation" && (
        <div className="settings-detail-empty">更多自动化设置即将到来 (P2)。</div>
      )}
    </div>
  );
}
