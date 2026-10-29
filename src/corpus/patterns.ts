import type { PatternStat } from "./types.js";

/**
 * URL pattern key used by the learned yield model: host + path template where
 * numeric / hash-like segments become placeholders and file names collapse to
 * their extension. e.g. zenodo.org/records/{n}/files/*.csv
 */
export function patternKey(url: string): string {
  const u = new URL(url);
  const segs = u.pathname.split("/").filter(Boolean).slice(0, 6);
  const last = segs.length - 1;
  const tpl = segs.map((s, i) => {
    if (/^\d+$/.test(s)) return "{n}";
    if (/^[0-9a-f-]{12,}$/i.test(s) || /^[A-Za-z0-9_-]{20,}$/.test(s)) return "{id}";
    if (i === last && /\.[A-Za-z0-9]{1,6}$/.test(s)) return `*${s.slice(s.lastIndexOf(".")).toLowerCase()}`;
    if (/\d{4}-\d{2}(-\d{2})?/.test(s)) return "{date}";
    return s.length > 40 ? "{slug}" : s.toLowerCase();
  });
  const q = [...u.searchParams.keys()].sort().join("&");
  return `${u.hostname}/${tpl.join("/")}${q ? `?${q}` : ""}`;
}

/**
 * Priority adjustment learned from outcomes: rewards patterns that yield many
 * categories and index successfully, penalises patterns that keep failing,
 * and keeps an exploration bonus for patterns seen rarely (UCB-style).
 */
export function learnedAdjustment(stat: PatternStat | undefined): { delta: number; reason: string } {
  if (!stat || stat.fetched === 0) return { delta: 6, reason: "unexplored pattern (exploration bonus)" };
  const success = stat.indexed / stat.fetched;
  const yieldPerResource = stat.indexed ? stat.catsSum / stat.indexed / 41 : 0;
  const explore = 8 / Math.sqrt(1 + stat.fetched);
  if (stat.fetched >= 5 && stat.failed / stat.fetched > 0.8) return { delta: -25, reason: `learned: ${Math.round((stat.failed / stat.fetched) * 100)}% failures over ${stat.fetched} fetches` };
  const delta = 20 * (success * yieldPerResource - 0.25) + explore;
  return { delta: Math.round(delta * 10) / 10, reason: `learned: ${Math.round(success * 100)}% indexed, ${(yieldPerResource * 41).toFixed(1)} categories/resource over ${stat.fetched} fetches` };
}
