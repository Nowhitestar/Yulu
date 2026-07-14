export type GlossaryScope = "prompt" | "replace" | "both";

export interface GlossaryRow {
  term: string;
  canonical: string;
  scope: GlossaryScope;
}

export interface GlossaryContract {
  prompt: string;
  replacements: Array<{ term: string; canonical: string }>;
  summaryInstruction: string;
}

const MAX_PROMPT_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 4_000;

export function buildGlossaryContract(rows: GlossaryRow[]): GlossaryContract {
  const normalized = rows.flatMap((row) => {
    const term = String(row.term ?? "").trim();
    const canonical = String(row.canonical ?? "").trim();
    const scope = row.scope;
    return term && canonical && ["prompt", "replace", "both"].includes(scope)
      ? [{ term, canonical, scope }]
      : [];
  });

  const promptTerms = unique(normalized
    .filter((row) => row.scope === "prompt" || row.scope === "both")
    .map((row) => row.canonical));
  const replacements = uniqueMappings(normalized
    .filter((row) => row.scope === "replace" || row.scope === "both")
    .filter((row) => row.term !== row.canonical)
    .map(({ term, canonical }) => ({ term, canonical })))
    .sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));
  const canonicalTerms = unique(normalized.map((row) => row.canonical));

  const prompt = boundedJoin(promptTerms, "，", MAX_PROMPT_CHARS);
  const summaryParts = [
    canonicalTerms.length > 0
      ? `Use these canonical terms exactly when the transcript refers to them: ${boundedJoin(canonicalTerms, "; ", MAX_SUMMARY_CHARS)}`
      : "",
    replacements.length > 0
      ? `Apply these terminology mappings: ${boundedJoin(replacements.map((row) => `${row.term} => ${row.canonical}`), "; ", MAX_SUMMARY_CHARS)}`
      : "",
  ].filter(Boolean);

  return {
    prompt,
    replacements,
    summaryInstruction: boundedJoin(summaryParts, "\n", MAX_SUMMARY_CHARS),
  };
}

export function loadGlossaryContract(db: unknown): GlossaryContract {
  if (!db || typeof db !== "object") return buildGlossaryContract([]);
  try {
    const prepare = (db as { prepare?: unknown }).prepare;
    if (typeof prepare !== "function") return buildGlossaryContract([]);
    const statement = prepare.call(db, `
      SELECT term, canonical, scope
      FROM custom_words
      WHERE enabled = 1
      ORDER BY updated_at DESC, term
      LIMIT 400
    `) as { all?: () => unknown };
    const rows = typeof statement.all === "function" ? statement.all() : [];
    return buildGlossaryContract(Array.isArray(rows) ? rows as GlossaryRow[] : []);
  } catch {
    return buildGlossaryContract([]);
  }
}

export function hasGlossaryContract(contract: GlossaryContract): boolean {
  return Boolean(contract.prompt || contract.replacements.length || contract.summaryInstruction);
}

export function applyGlossaryContract(text: string, contract: GlossaryContract): string {
  return contract.replacements.reduce(
    (current, row) => current.split(row.term).join(row.canonical),
    text,
  );
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueMappings(rows: Array<{ term: string; canonical: string }>) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.term}\0${row.canonical}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function boundedJoin(values: string[], separator: string, limit: number): string {
  let output = "";
  for (const value of values) {
    const next = output ? `${output}${separator}${value}` : value;
    if (next.length > limit) break;
    output = next;
  }
  return output;
}
