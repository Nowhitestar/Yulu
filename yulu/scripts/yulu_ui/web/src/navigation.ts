// The app's destinations, declared once. The sidebar shows the few you use
// every day; everything else is one step behind Settings or ⌘K.
import { Activity, AudioLines, Bell, BookOpen, FileText, ListChecks, MessageCircle, Mic, Plug, Settings, SlidersHorizontal, type LucideIcon } from "lucide-react";

export interface Destination {
  to: string;
  labelKey: string;
  icon: LucideIcon;
}

export const MAIN_NAV: Destination[] = [
  { to: "/agent-console", labelKey: "nav.agentConsole", icon: MessageCircle },
  { to: "/inbox", labelKey: "nav.recordings", icon: Mic },
  { to: "/voice-input", labelKey: "nav.voiceInput", icon: AudioLines },
];

export const SETTINGS_ENTRY: Destination = { to: "/settings", labelKey: "nav.settings", icon: Settings };
export const SETUP_ENTRY: Destination = { to: "/onboarding", labelKey: "nav.onboarding", icon: ListChecks };

/** Settings sidebar, in groups: preferences, your content rules, diagnostics. */
export const SETTINGS_NAV: Destination[][] = [
  [
    { to: "/settings/general", labelKey: "settings.category.general.label", icon: SlidersHorizontal },
    { to: "/settings/recording", labelKey: "settings.category.recording.label", icon: Mic },
    { to: "/settings/meetings", labelKey: "settings.category.meetings.label", icon: Bell },
    { to: "/settings/voice", labelKey: "settings.category.voice.label", icon: AudioLines },
    { to: "/settings/connections", labelKey: "settings.category.connections.label", icon: Plug },
  ],
  [
    { to: "/knowledge/prompts", labelKey: "nav.prompts", icon: FileText },
    { to: "/knowledge/glossary", labelKey: "nav.glossary", icon: BookOpen },
  ],
  [
    { to: "/health", labelKey: "nav.health", icon: Activity },
  ],
];

/** Every destination, for the command palette. */
export const ALL_DESTINATIONS: Destination[] = [...MAIN_NAV, ...SETTINGS_NAV.flat(), SETUP_ENTRY];
