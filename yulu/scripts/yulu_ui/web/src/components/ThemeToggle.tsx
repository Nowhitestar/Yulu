// web/src/components/ThemeToggle.tsx
import { useTheme, type ThemeChoice } from "../theme.js";
import "./ThemeToggle.css";

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "auto",  label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark",  label: "Dark" },
];

export function ThemeToggle() {
  const { choice, set } = useTheme();
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={choice === o.value}
          className={choice === o.value ? "active" : ""}
          onClick={() => set(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
