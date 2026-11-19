import { MarkdownView } from "./MarkdownView.js";
import { useLocale, useT } from "../i18n/LanguageProvider.js";
import "./LiveNotesView.css";

export interface MyNoteView {
  at: string;
  text: string;
}

export function noteTime(at: string, locale: string): string {
  const date = new Date(at);
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** Notes as Markdown: what Yulu wrote, then the attendee's own lines. */
export function liveNotesMarkdown(
  notes: { markdown: string | null; myNotes: MyNoteView[] },
  heading: string,
  locale: string,
): string {
  const mine = notes.myNotes.map((note) => `- ${noteTime(note.at, locale)} ${note.text}`.replace(/^- {2}/, "- "));
  return [notes.markdown?.trim() ?? "", mine.length ? `## ${heading}\n\n${mine.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Live notes: what Yulu wrote during the meeting, then the attendee's own
 * notes, kept apart so it is always clear who said what.
 */
export function LiveNotesView({ markdown, myNotes, footer }: {
  markdown: string | null;
  myNotes: MyNoteView[];
  footer?: string;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <div className="live-notes">
      {markdown && <MarkdownView text={markdown} />}
      {myNotes.length > 0 && (
        <section className="live-notes-mine" aria-labelledby="live-notes-mine">
          <h2 id="live-notes-mine">{t("liveNotes.mine")}</h2>
          <ol>
            {myNotes.map((note, index) => (
              <li key={`${note.at}-${index}`}>
                <time dateTime={note.at}>{noteTime(note.at, locale)}</time>
                <span>{note.text}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {footer && <p className="live-notes-footer">{footer}</p>}
    </div>
  );
}
