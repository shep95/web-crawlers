export type SearchMode = "people" | "knowledge";

const KNOWLEDGE_CUES =
  /^(what|how|why|when|where|explain|define|tutorial|guide to|introduction to|overview of|history of|compare|difference between)\b/i;

const TECH_DOMAIN_CUES =
  /\b(algorithm|protocol|framework|architecture|api|database|compiler|encryption|blockchain|quantum|biology|physics|chemistry|mathematics|theorem|specification|rfc|documentation|intelligence|artificial|learning|technology|science|economics|philosophy|history|politics|culture|medicine|engineering)\b/i;

const PERSON_CUES =
  /\b(mr\.|mrs\.|ms\.|dr\.|born|age\s+\d{1,3}|lives in|resides|hometown|family|married|linkedin\.com\/in|facebook\.com\/|instagram\.com\/)\b/i;

const INTERNATIONAL_LOCATION_CUES =
  /\b(india|china|russia|japan|germany|france|brazil|mexico|canada|australia|uk|united kingdom|nigeria|south africa|korea|pakistan|indonesia|vietnam|thailand|egypt|saudi arabia|uae|singapore|taiwan|hong kong|europe|asia|africa|latin america)\b/i;

const LOCATION_CUES =
  /\b(united states|usa|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY))\b/;

const NAME_LIKE = /\b[A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\b/;

export interface SearchModeResult {
  mode: SearchMode;
  confidence: number;
  reason: string;
}

/** Classify query as people search (human) vs knowledge search (domain/topic). */
export function classifySearchMode(query: string): SearchModeResult {
  const q = query.trim();
  let peopleScore = 0;
  let knowledgeScore = 0;
  const reasons: string[] = [];

  if (KNOWLEDGE_CUES.test(q)) {
    knowledgeScore += 3;
    reasons.push("question/explainer phrasing");
  }
  if (/\b(is|are|was|were)\b/i.test(q) && TECH_DOMAIN_CUES.test(q)) {
    knowledgeScore += 2;
    reasons.push("definitional topic query");
  }
  if (TECH_DOMAIN_CUES.test(q) && !NAME_LIKE.test(q)) {
    knowledgeScore += 2;
    reasons.push("technical domain vocabulary");
  }
  if (PERSON_CUES.test(q)) {
    peopleScore += 3;
    reasons.push("personal/biographical cues");
  }
  if (LOCATION_CUES.test(q)) {
    peopleScore += 2;
    reasons.push("geographic person anchor");
  }
  if (INTERNATIONAL_LOCATION_CUES.test(q)) {
    peopleScore += 1;
    reasons.push("international geographic anchor");
  }
  if (NAME_LIKE.test(q)) {
    peopleScore += 2;
    reasons.push("name-like token sequence");
  }
  if (KNOWLEDGE_CUES.test(q) && TECH_DOMAIN_CUES.test(q)) {
    peopleScore = Math.max(0, peopleScore - 2);
    knowledgeScore += 2;
    reasons.push("explainer + domain topic overrides name-like tokens");
  }

  const words = q.split(/\s+/).filter(Boolean);
  const capitalized = words.filter((w) => /^[A-Z][a-z]+/.test(w)).length;
  if (capitalized >= 2 && capitalized >= words.length * 0.4) {
    peopleScore += 2;
    reasons.push("multiple proper-name tokens");
  }
  if (words.length <= 2 && TECH_DOMAIN_CUES.test(q)) {
    knowledgeScore += 2;
  }
  if (/\b(search|find|lookup|who is|person|profile)\b/i.test(q)) {
    peopleScore += 2;
    reasons.push("people lookup intent");
  }

  const mode: SearchMode = peopleScore >= knowledgeScore ? "people" : "knowledge";
  const total = peopleScore + knowledgeScore || 1;
  const confidence = Math.min(0.98, Math.max(0.55, Math.abs(peopleScore - knowledgeScore) / total + 0.5));

  return {
    mode,
    confidence,
    reason: reasons.length ? reasons.join("; ") : mode === "people" ? "default person query" : "default knowledge query",
  };
}

export function resolveSearchMode(query: string, explicit?: string): SearchModeResult {
  if (explicit === "people" || explicit === "knowledge") {
    return { mode: explicit, confidence: 1, reason: "explicit --mode flag" };
  }
  return classifySearchMode(query);
}
