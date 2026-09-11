import { isTrustedNotionUrl, normalizeNotionPageId } from "./notionDelivery.js";

/** Compare page identity, not a link's presentation (hyphens, title or pvs query). */
export function notionSharingPageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = normalizeNotionPageId(value);
  if (id) return id;
  if (!isTrustedNotionUrl(value)) return null;
  const segment = new URL(value).pathname.split("/").filter(Boolean).at(-1) ?? "";
  const suffix = segment.match(/(?:^|-)([0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return suffix ? normalizeNotionPageId(suffix[1]!) : null;
}

export function normalizeNotionShareDestination(value: string): string {
  const trimmed = value.trim();
  const pageId = notionSharingPageId(trimmed);
  if (pageId) {
    const dashed = pageId.replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5");
    return JSON.stringify({ page_id: dashed });
  }
  try {
    const parent: unknown = JSON.parse(trimmed);
    if (parent && typeof parent === "object" && !Array.isArray(parent)) {
      const record = parent as Record<string, unknown>;
      const key = record.page_id !== undefined ? "page_id" : "data_source_id";
      if (typeof record[key] === "string" && normalizeNotionPageId(record[key]) &&
          (record.type === undefined || record.type === key) &&
          Object.keys(record).every((field) => field === key || field === "type")) {
        return JSON.stringify({ [key]: record[key].trim() });
      }
    }
  } catch { /* An unambiguous page link, ID or parent object is required. */ }
  throw new Error("Paste a Notion page link or page ID, or select a discovered destination; a page title alone is not a destination");
}

/** Notion discards empty paragraph separators, but never discard code whitespace. */
export function notionShareContentMatches(observed: string, expected: string): boolean {
  const normalize = (markdown: string) => {
    let fence: { char: string; length: number } | null = null;
    return markdown.replaceAll("\r\n", "\n").split("\n").filter((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker) {
        if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
        else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = null;
        return true;
      }
      return fence !== null || line !== "";
    }).join("\n");
  };
  return normalize(observed) === normalize(expected);
}

export interface NotionFetchedSharePage {
  id: string;
  url: string;
  parent: { page_id: string };
  content: string;
}

/** Parse only the observed Notion fetch envelope, never model prose or title/path hints. */
export function notionFetchedSharePage(value: unknown): NotionFetchedSharePage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const metadata = record.metadata as Record<string, unknown> | undefined;
  if (metadata?.type !== "page" || typeof record.text !== "string" || typeof record.url !== "string") return null;
  if ([record, metadata].some((part) => part.truncated === true ||
      (part.unknown_block_count !== undefined && part.unknown_block_count !== 0) ||
      (part.unknown_block_ids !== undefined && (!Array.isArray(part.unknown_block_ids) || part.unknown_block_ids.length !== 0)))) return null;
  const text = record.text.replaceAll("\r\n", "\n");
  // Share pages contain just the immutable content. Reject duplicate structural tags,
  // nested pages and malformed wrappers rather than matching an embedded decoy.
  if ((text.match(/^<page\b/gm) ?? []).length !== 1 ||
      (text.match(/^<ancestor-path>/gm) ?? []).length !== 1 ||
      (text.match(/^<content>/gm) ?? []).length !== 1 ||
      (text.match(/^<\/content>/gm) ?? []).length !== 1 ||
      (text.match(/^<\/page>/gm) ?? []).length !== 1) return null;
  const page = /(?:^|\n)<page url="([^"\n]+)">\n<ancestor-path>([\s\S]*?)<\/ancestor-path>\n[\s\S]*?\n<content>\n([\s\S]*?)\n<\/content>\n<\/page>$/.exec(text);
  if (!page) return null;
  const id = notionSharingPageId(page[1]);
  if (!id || notionSharingPageId(record.url) !== id ||
      (record.id !== undefined && notionSharingPageId(record.id) !== id)) return null;
  const ancestors = page[2]!.trim().split("\n");
  const directParent = /^<parent-page url="([^"\n]+)"(?: title="[^"\n]*")?\/>$/.exec(ancestors[0] ?? "");
  const parentId = directParent ? notionSharingPageId(directParent[1]) : null;
  if (!parentId || ancestors.some((line) => !/^<parent-[a-z-]+\s[^<>]*\/>$/.test(line))) return null;
  return { id, url: record.url, parent: { page_id: parentId }, content: page[3]! };
}
