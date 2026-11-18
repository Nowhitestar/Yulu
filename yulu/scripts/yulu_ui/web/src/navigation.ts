// Every place in the app, declared once. The window itself only ever shows
// recordings; everything you configure sits behind the gear or ⌘K.
export interface Destination {
  to: string;
  labelKey: string;
}

export const RECORDINGS: Destination = { to: "/inbox", labelKey: "nav.recordings" };

/** The settings list, in groups: preferences, your content rules, diagnostics. */
export const SETTINGS_NAV: Destination[][] = [
  [
    { to: "/settings/general", labelKey: "settings.category.general.label" },
    { to: "/settings/recording", labelKey: "settings.category.recording.label" },
    { to: "/settings/meetings", labelKey: "settings.category.meetings.label" },
    { to: "/settings/voice", labelKey: "settings.category.voice.label" },
    { to: "/settings/connections", labelKey: "settings.category.connections.label" },
  ],
  [
    { to: "/knowledge/prompts", labelKey: "nav.prompts" },
    { to: "/knowledge/glossary", labelKey: "nav.glossary" },
  ],
  [
    { to: "/health", labelKey: "nav.health" },
  ],
];

export const ALL_DESTINATIONS: Destination[] = [RECORDINGS, ...SETTINGS_NAV.flat()];

const SETTINGS_AREAS = ["/settings", "/knowledge", "/health"];

export function isSettingsArea(pathname: string): boolean {
  return SETTINGS_AREAS.some((area) => pathname === area || pathname.startsWith(`${area}/`));
}

/** On a narrow window the list and what you opened from it never share the screen. */
export function showsDetail(pathname: string): boolean {
  return pathname !== "/inbox" && pathname !== "/settings";
}
