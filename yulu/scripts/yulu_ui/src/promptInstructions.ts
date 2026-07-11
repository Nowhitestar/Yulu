export const STANDARD_SUMMARY_INSTRUCTIONS =
  "Produce an accurate transcript and a factual, structured meeting summary.";

const TASK_TRANSCRIPT_REFERENCE =
  "the complete transcript returned for this task by the task-scoped MCP `recording_task_transcript_read` operation";
const TASK_SPEAKER_REFERENCE =
  "the speaker labels and metadata, when present, in the task-scoped MCP transcript";

export class InvalidPromptInstructionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPromptInstructionsError";
  }
}

export interface SummaryInstructionContext {
  title: string;
  date: string;
}

export interface SummaryPromptSnapshot {
  id: string;
  slug: string;
  name: string;
  content: string;
}

interface PromptDatabase {
  prepare: (sql: string) => {
    get: (...params: unknown[]) => unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Convert the timestamp encoded in a Yulu recording stem to a local calendar
 * date. The filename is created in local time, so no timezone conversion is
 * appropriate here.
 */
export function recordingDateFromStem(stem: string): string {
  const match = /_(\d{4})(\d{2})(\d{2})_\d{6}$/.exec(stem);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "";
}

/**
 * Render user-controlled summary instructions without ever embedding raw
 * transcript text. Legacy transcript variables become references to the
 * lease-scoped MCP read operation; only non-sensitive recording metadata is
 * expanded literally. Unknown or malformed variables fail closed.
 */
export function renderSummaryInstructions(
  template: string,
  context: SummaryInstructionContext,
): string {
  const placeholderPattern = /{{([\s\S]*?)}}/g;
  const unknown = new Set<string>();
  for (const match of template.matchAll(placeholderPattern)) {
    const variable = match[1]?.trim() ?? "";
    if (!/^[A-Za-z0-9_]+$/.test(variable)) {
      throw new InvalidPromptInstructionsError("Malformed summary template variable");
    }
    if (![
      "meeting_title", "date", "transcript", "best_transcript",
      "speaker_transcript", "my_transcript", "their_transcript", "speaker_list",
    ].includes(variable)) unknown.add(variable);
  }
  const withoutCompletePlaceholders = template.replace(placeholderPattern, "");
  if (withoutCompletePlaceholders.includes("{{") || withoutCompletePlaceholders.includes("}}")) {
    throw new InvalidPromptInstructionsError("Malformed summary template variable");
  }
  if (unknown.size > 0) {
    throw new InvalidPromptInstructionsError(
      `Unsupported summary template variable(s): ${[...unknown].sort().join(", ")}`,
    );
  }
  const rendered = template.replace(
    /{{\s*([A-Za-z0-9_]+)\s*}}/g,
    (_placeholder, variable: string) => {
      switch (variable) {
        case "meeting_title": return context.title;
        case "date": return context.date;
        case "transcript":
        case "best_transcript":
        case "speaker_transcript":
          return TASK_TRANSCRIPT_REFERENCE;
        case "my_transcript":
          return `${TASK_TRANSCRIPT_REFERENCE}, limited to the local/microphone speaker when the transcript identifies that channel`;
        case "their_transcript":
          return `${TASK_TRANSCRIPT_REFERENCE}, limited to the remote/system speaker when the transcript identifies that channel`;
        case "speaker_list":
          return TASK_SPEAKER_REFERENCE;
        default: return ""; // validated above; unreachable
      }
    },
  );
  return rendered.trim();
}

/** Select the single automatic summary template deterministically. */
export function selectAutomaticSummaryPrompt(db: unknown): SummaryPromptSnapshot | null {
  if (!db) return null;
  const row = (db as PromptDatabase).prepare(
    `SELECT id, slug, name, content
       FROM prompts
      WHERE category = ? AND is_auto_run = 1
      ORDER BY sort_order ASC, slug ASC
      LIMIT 1`,
  ).get("summary");
  if (!isRecord(row)) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.slug !== "string" ||
    typeof row.name !== "string" ||
    typeof row.content !== "string"
  ) return null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    content: row.content,
  };
}

/**
 * Read and render one automatic prompt. Catalog absence/read failures use the
 * built-in standard instructions; an invalid selected template still throws.
 */
export function automaticSummaryInstructions(
  getDb: (() => unknown) | undefined,
  context: SummaryInstructionContext,
): string {
  let selected: SummaryPromptSnapshot | null = null;
  try {
    selected = selectAutomaticSummaryPrompt(getDb?.());
  } catch {
    // The prompt catalog is optional for capture durability. A missing/corrupt
    // catalog must not prevent the standard summary workflow from being queued.
  }
  return renderSummaryInstructions(selected?.content ?? STANDARD_SUMMARY_INSTRUCTIONS, context);
}
