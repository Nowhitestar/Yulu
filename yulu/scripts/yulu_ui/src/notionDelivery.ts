const TRUSTED_NOTION_HOSTS = new Set([
  "app.notion.com",
  "notion.so",
  "www.notion.so",
]);

const NOTION_PAGE_ID_RE = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function isTrustedNotionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && TRUSTED_NOTION_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isValidNotionPageId(value: string): boolean {
  return NOTION_PAGE_ID_RE.test(value.trim());
}

export function normalizeNotionPageId(value: string): string | null {
  return isValidNotionPageId(value) ? value.trim().replaceAll("-", "").toLowerCase() : null;
}

export function notionPageIdFromUrl(value: string): string | null {
  if (!isTrustedNotionUrl(value)) return null;
  const pathname = new URL(value).pathname;
  const matches = pathname.match(/[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig);
  return matches?.length ? normalizeNotionPageId(matches.at(-1)!) : null;
}

export function notionPageIdentityProblem(url: string, pageId: string): string | null {
  if (!url || !pageId) return null;
  const urlPageId = notionPageIdFromUrl(url);
  if (!urlPageId) return "Notion delivery URL must contain its page ID when a page ID is also reported";
  return urlPageId === normalizeNotionPageId(pageId)
    ? null
    : "Notion delivery URL and page ID must identify the same page";
}

export function canonicalNotionPageIdentity(url: string, pageId: string): string | null {
  if (notionPageIdentityProblem(url, pageId)) return null;
  const normalizedPageId = pageId ? normalizeNotionPageId(pageId) : null;
  if (normalizedPageId) return normalizedPageId;
  const urlPageId = url ? notionPageIdFromUrl(url) : null;
  if (urlPageId) return urlPageId;
  return url && isTrustedNotionUrl(url) ? url.trim().toLowerCase().replace(/\/$/, "") : null;
}
