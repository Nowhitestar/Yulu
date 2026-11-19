import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A quiet trigger that reveals secondary actions. Closes on outside click and
 * Escape (returning focus to the trigger); items opt in to closing the menu by
 * carrying `data-close`.
 */
export function PopoverMenu({ label, icon, children, className = "" }: {
  label: string;
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className={`popmenu ${className}`.trim()} ref={root}>
      <button ref={trigger} type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={open}
        aria-label={label} title={label} onClick={() => setOpen((value) => !value)}>
        {icon}
      </button>
      {open && (
        <div className="menu popmenu-panel" role="menu" aria-label={label}
          onClick={(event) => { if ((event.target as Element).closest("[data-close]")) setOpen(false); }}>
          {children}
        </div>
      )}
    </div>
  );
}
