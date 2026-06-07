import * as cheerio from "cheerio";

/** Strip HTML to readable plain text for RAG ingestion. */
export function extractPlainText(html: string, maxChars = 120_000): string {
  if (!html) return "";
  const trimmed = html.trim();
  if (!trimmed.startsWith("<")) {
    return trimmed.replace(/\s+/g, " ").slice(0, maxChars).trim();
  }
  const $ = cheerio.load(trimmed);
  $("script, style, nav, footer, header, noscript, iframe, svg").remove();
  const text = $.root().text().replace(/\s+/g, " ").trim();
  return text.slice(0, maxChars);
}
