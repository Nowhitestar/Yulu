// web/src/components/settings/SettingsCategoryList.tsx
import { NavLink } from "react-router";
import { CATEGORIES } from "./categories.js";
import "./SettingsCategoryList.css";

/**
 * The master column of the settings MasterDetail: one NavLink per category,
 * styled like the inbox `.recording-row` (borderless, hover=row-hover,
 * active=accent-soft). No emoji (locked by brainstorm). Each row shows the
 * Chinese category label plus a one-line description.
 */
export function SettingsCategoryList() {
  return (
    <div className="settings-category-list">
      {CATEGORIES.map((cat) => (
        <NavLink
          key={cat.id}
          to={`/settings/${cat.id}`}
          data-testid="settings-category"
          className={({ isActive }) => "recording-row settings-category-row" + (isActive ? " active" : "")}
        >
          <div className="recording-row-title">{cat.label}</div>
          <div className="settings-category-desc">{cat.description}</div>
        </NavLink>
      ))}
    </div>
  );
}
