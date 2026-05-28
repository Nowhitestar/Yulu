import type { ReactNode } from "react";
import "./SettingsPage.css";

export interface SettingsPageProps {
  banner?: ReactNode;
  children: ReactNode;
}

export function SettingsPage({ banner, children }: SettingsPageProps) {
  return (
    <div className="settings-page">
      {banner && <div className="settings-banner">{banner}</div>}
      <div className="settings-body">{children}</div>
    </div>
  );
}
