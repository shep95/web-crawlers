import type { ChatDocument } from "./algorithm-chatbot.js";

export type QuestionKind = "definition" | "general";

export interface QuestionFocus {
  terms: string[];
  kind: QuestionKind;
  rawFocus: string;
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "you", "what", "how", "why", "can", "does",
  "was", "were", "who", "when", "where", "which", "that", "this", "about",
]);

const DEFINITION_CUES =
  /^(?:what\s+(?:is|are)|who\s+(?:is|are)|define|explain(?:\s+what)?|describe|tell\s+me\s+about)\s+(.+?)\??$/i;

const DEFINITION_SENTENCE =
  /\b(is|are|was|were|means|refer(s)?\s+to|defined\s+as|consists\s+of|involves|describes|known\s+as)\b/i;

const SUBJECT_FIRST =
  /^(?:an?\s+)?[a-z][\w\s-]{0,60}\s+(is|are|was|were)\s+(?:a|an|the)\b/i;

const NOISE_SENTENCE =
  /\b(github|click here|sign up|subscribe|cookie|privacy policy|terms of service|download now|get started|our platform|self-evolving memory|portable memory layer)\b/i;

const ACADEMIC_LIST_NOISE =
  /\b(comments:\s*\d+\s+pages|subjects:|figures,\s+\d+\s+appendices|arxiv:|doi:|(?:vol\.|pp\.)\s*\d)\b/i;

const EDUCATIONAL_HOST =
  /(?:^|\.)((?:arxiv|britannica|wikipedia|worldhistory|paperswithcode|nature|ncbi|nih)\.(?:org|com|gov))/i;

export function parseQuestionFocus(question: string): QuestionFocus {
  const trimmed = question.trim();
  const def = trimmed.match(DEFINITION_CUES);
  if (def) {
    const rawFocus = def[1].replace(/\?+$/, "").trim();
    return {
      terms: tokenize(rawFocus),
      kind: "definition",
      rawFocus,
    };
  }
  return {
    terms: tokenize(trimmed),
    kind: "general",
    rawFocus: trimmed,
  };
}

export function tokenize(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((t) => !STOPWORDS.has(t)),
    ),
  ];
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40 && s.length <= 520);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function seedHostBoost(url: string, seedHosts: Set<string>): number {
  const host = hostOf(url);
  if (!host) return 0;
  for (const seed of seedHosts) {
    if (host === seed || host.endsWith(`.${seed}`)) return 2;
  }
  return 0;
}

function termMatches(text: string, term: string): boolean {
  if (text.includes(term)) return true;
  if (term.endsWith("s") && term.length > 4 && text.includes(term.slice(0, -1))) return true;
  if (!term.endsWith("s") && text.includes(`${term}s`)) return true;
  return false;
}

function scoreSentence(
  sentence: string,
  focus: QuestionFocus,
  doc: ChatDocument,
  seedHosts: Set<string>,
): number {
  const lowered = sentence.toLowerCase();
  const titleLower = doc.title.toLowerCase();

  if (!focus.terms.length) return 0;

  const matched = focus.terms.filter((t) => termMatches(lowered, t) || termMatches(titleLower, t));
  if (!matched.length) return 0;

  const coverage = matched.length / focus.terms.length;
  let score = matched.length + coverage * 2;

  if (focus.terms.some((t) => titleLower.includes(t))) score += 1.5;

  if (focus.kind === "definition") {
    if (DEFINITION_SENTENCE.test(sentence) || SUBJECT_FIRST.test(sentence)) score += 4;
    if (NOISE_SENTENCE.test(sentence)) score -= 6;
    if (ACADEMIC_LIST_NOISE.test(sentence)) score -= 5;
    if (/github\.com/i.test(doc.url)) score -= 5;
    if (/\/list\/\w+\/new/i.test(doc.url)) score -= 4;
    if (/\b(modular|runtime|repository|repo|agent|platform)\b/i.test(sentence) && !DEFINITION_SENTENCE.test(sentence)) {
      score -= 2;
    }
    if (focus.rawFocus && lowered.includes(focus.rawFocus.toLowerCase())) score += 2;
  }

  if (EDUCATIONAL_HOST.test(doc.url)) score += 1;
  score += seedHostBoost(doc.url, seedHosts);

  return score;
}

export function rankSentencesForQuestion(
  question: string,
  documents: ChatDocument[],
  seedUrls: string[] = [],
): Array<{ sentence: string; url: string; title: string; score: number }> {
  const focus = parseQuestionFocus(question);
  if (!focus.terms.length) return [];

  const seedHosts = new Set(seedUrls.map((s) => hostOf(s)).filter(Boolean));
  const ranked: Array<{ sentence: string; url: string; title: string; score: number }> = [];

  for (const doc of documents) {
    for (const sentence of splitSentences(doc.text)) {
      const score = scoreSentence(sentence, focus, doc, seedHosts);
      if (score > 0) ranked.push({ sentence, url: doc.url, title: doc.title, score });
    }
  }

  ranked.sort((a, b) => b.score - a.score || b.sentence.length - a.sentence.length);

  if (focus.kind === "definition") {
    return ranked
      .filter((r) => DEFINITION_SENTENCE.test(r.sentence) || SUBJECT_FIRST.test(r.sentence))
      .slice(0, 50);
  }

  return ranked.slice(0, 50);
}

/** Add site search URLs so crawls land on topic pages, not random outbound links. */
export function augmentSeedsForQuestion(seeds: string[], question: string): string[] {
  const { terms, rawFocus } = parseQuestionFocus(question);
  const query = encodeURIComponent(terms.join(" ") || rawFocus || question);
  const out = new Set(seeds);

  for (const seed of seeds) {
    try {
      const host = new URL(seed).hostname.replace(/^www\./, "").toLowerCase();
      if (host === "arxiv.org") out.add(`https://arxiv.org/search/?query=${query}&searchtype=all`);
      if (host === "paperswithcode.com") out.add(`https://paperswithcode.com/search?q=${query}`);
      if (host.includes("britannica.com")) {
        out.add(`https://www.britannica.com/search?query=${query}`);
        for (const term of terms.slice(0, 2)) {
          const slug = term.replace(/s$/, "");
          out.add(`https://www.britannica.com/science/${slug}`);
          out.add(`https://www.britannica.com/topic/${slug}`);
        }
      }
      if (host.includes("wikipedia.org")) {
        const lang = host.split(".")[0];
        out.add(`https://${lang}.wikipedia.org/wiki/Special:Search?search=${query}`);
      }
    } catch {
      /* skip invalid seed */
    }
  }

  return [...out];
}
