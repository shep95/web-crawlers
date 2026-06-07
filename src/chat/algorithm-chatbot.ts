/**
 * Algorithm chatbot — ELIZA-style pattern matching, not an LLM.
 * Based on the supervised-learning lecture: scripts that mirror, reflect, and
 * alternate fixed prompts ("Tell me more." / "This is interesting.") to simulate dialogue.
 */

import { rankSentencesForQuestion } from "./retrieval-ranker.js";

export type ChatMode = "eliza" | "retrieval" | "continuation" | "reflect";

export interface ChatDocument {
  text: string;
  url: string;
  title: string;
  /** Must be live web crawl — never test fixtures or local report files. */
  source: "live";
  fetchedAt?: string;
}

export interface ChatSource {
  url: string;
  title: string;
  excerpt: string;
}

export interface ChatSession {
  id: string;
  turnCount: number;
  /** Alternates 0/1 for the two-phrase demo from the lecture. */
  phraseIndex: number;
  lastQuestion: string;
  lastTopic: string;
  /** Index into ranked sentences for "tell me more" continuations. */
  retrievalCursor: number;
  rankedSentences: Array<{ sentence: string; url: string; title: string; score: number }>;
}

export interface ChatReply {
  reply: string;
  mode: ChatMode;
  session: ChatSession;
  sources: ChatSource[];
  /** Honest disclosure — this is pattern matching, not verified AI. */
  disclaimer: string;
}

const DISCLAIMER =
  "Algorithm chatbot — live web retrieval and pattern matching only; never test files or archive data.";

const CONTINUATION_RE =
  /\b(tell me more|more about that|go on|continue|keep going|what else|elaborate|expand on|say more|go deeper|dive deeper)\b/i;

const ELIZA_RULES: Array<{ pattern: RegExp; responses: string[] }> = [
  {
    pattern: /\b(hello|hi|hey|good morning|good evening)\b/i,
    responses: ["Hello. How are you feeling today?", "Hi there. Is something troubling you?"],
  },
  {
    pattern: /\b(bye|goodbye|see you|quit|exit)\b/i,
    responses: ["Goodbye. It was good talking with you.", "Take care. Feel free to come back anytime."],
  },
  {
    pattern: /\b(depressed|depression|sad|unhappy|miserable)\b/i,
    responses: [
      "I'm sorry to hear that you're depressed.",
      "Why do you think you feel depressed much of the time?",
    ],
  },
  {
    pattern: /\b(mother|mom|father|dad|family|parents)\b/i,
    responses: ["Tell me more about your family.", "How does your family figure into this?"],
  },
  {
    pattern: /\b(boyfriend|girlfriend|partner|relationship|married|wife|husband)\b/i,
    responses: [
      "Is it important to you that your relationship is going this way?",
      "Can you think of a specific example from your relationship?",
    ],
  },
  {
    pattern: /\b(always|never|all men|all women|everyone)\b/i,
    responses: [
      "Can you think of a specific example?",
      "What connection do you suppose they're always doing that?",
    ],
  },
  {
    pattern: /\b(kill myself|suicide|end my life|want to die)\b/i,
    responses: [
      "I'm a simple pattern matcher, not a counselor. Please talk to a real person you trust or a crisis line.",
      "That sounds very serious. This chatbot cannot help with that — please reach out to someone who can.",
    ],
  },
  {
    pattern: /\bi am (.+)/i,
    responses: ["Why do you say you are $1?", "Do you enjoy being $1?"],
  },
  {
    pattern: /\bi'm (.+)/i,
    responses: ["Why do you say you're $1?", "How long have you been $1?"],
  },
  {
    pattern: /\bi (.+)/i,
    responses: ["Why do you say you $1?", "You say you $1 — can you elaborate?"],
  },
  {
    pattern: /\b(you are|you're) (.+)/i,
    responses: ["What makes you think I am $2?", "Does it matter to you that I am $2?"],
  },
  {
    pattern: /\bwhat is (.+)\?/i,
    responses: [
      "Why do you ask what $1 is?",
      "What do you already know about $1?",
    ],
  },
  {
    pattern: /\bwhy (.+)\?/i,
    responses: ["Why do you think $1?", "What reason comes to mind for why $1?"],
  },
  {
    pattern: /\?$/,
    responses: [
      "Why do you ask that?",
      "What do you think the answer might be?",
    ],
  },
];

const PHRASE_CYCLE = ["Tell me more.", "This is interesting."] as const;

function liveDocumentsOnly(documents: ChatDocument[]): ChatDocument[] {
  return documents.filter((d) => d.source === "live");
}

export function rankSentences(
  question: string,
  documents: ChatDocument[],
  seedUrls: string[] = [],
): ChatSession["rankedSentences"] {
  return rankSentencesForQuestion(question, liveDocumentsOnly(documents), seedUrls);
}

function applyElizaRule(input: string): string | null {
  const trimmed = input.trim();
  for (const rule of ELIZA_RULES) {
    const match = trimmed.match(rule.pattern);
    if (!match) continue;
    const template = rule.responses[Math.floor(Math.random() * rule.responses.length)];
    return template.replace(/\$(\d+)/g, (_, n) => match[Number(n)] ?? "");
  }
  return null;
}

function isVagueInput(input: string): boolean {
  const words = input.trim().split(/\s+/).filter(Boolean);
  return words.length <= 3 && !input.includes("?");
}

function twoPhraseReply(session: ChatSession): string {
  const reply = PHRASE_CYCLE[session.phraseIndex % PHRASE_CYCLE.length];
  session.phraseIndex += 1;
  return reply;
}

function reflectInput(input: string): string {
  const trimmed = input.trim().replace(/[.!?]+$/, "");
  if (!trimmed) return "Is something troubling you?";
  return `Do you often think about ${trimmed.toLowerCase()}?`;
}

export function createSession(id: string): ChatSession {
  return {
    id,
    turnCount: 0,
    phraseIndex: 0,
    lastQuestion: "",
    lastTopic: "",
    retrievalCursor: 0,
    rankedSentences: [],
  };
}

export function respondAlgorithm(
  session: ChatSession,
  message: string,
  documents: ChatDocument[] = [],
  seedUrls: string[] = [],
): ChatReply {
  const input = message.trim();
  session.turnCount += 1;

  if (!input) {
    return {
      reply: "Is something troubling you?",
      mode: "eliza",
      session,
      sources: [],
      disclaimer: DISCLAIMER,
    };
  }

  if (CONTINUATION_RE.test(input) && session.rankedSentences.length) {
    session.retrievalCursor += 1;
    const idx = session.retrievalCursor % session.rankedSentences.length;
    const hit = session.rankedSentences[idx];
    return {
      reply: hit.sentence,
      mode: "continuation",
      session,
      sources: [{ url: hit.url, title: hit.title, excerpt: hit.sentence.slice(0, 240) }],
      disclaimer: DISCLAIMER,
    };
  }

  const liveDocs = liveDocumentsOnly(documents);
  if (liveDocs.length) {
    session.lastQuestion = input;
    session.rankedSentences = rankSentences(input, liveDocs, seedUrls);
    session.retrievalCursor = 0;

    if (session.rankedSentences.length) {
      const hit = session.rankedSentences[0];
      return {
        reply: hit.sentence,
        mode: "retrieval",
        session,
        sources: [{ url: hit.url, title: hit.title, excerpt: hit.sentence.slice(0, 240) }],
        disclaimer: DISCLAIMER,
      };
    }

    return {
      reply:
        "I crawled live sources but did not find a clear definitional sentence for that question. Try a more specific domain or rephrase.",
      mode: "reflect",
      session,
      sources: [],
      disclaimer: DISCLAIMER,
    };
  }

  const eliza = applyElizaRule(input);
  if (eliza) {
    session.lastTopic = input;
    return {
      reply: eliza,
      mode: "eliza",
      session,
      sources: [],
      disclaimer: DISCLAIMER,
    };
  }

  if (isVagueInput(input)) {
    return {
      reply: twoPhraseReply(session),
      mode: "eliza",
      session,
      sources: [],
      disclaimer: DISCLAIMER,
    };
  }

  session.lastTopic = input;
  return {
    reply: reflectInput(input),
    mode: "reflect",
    session,
    sources: [],
    disclaimer: DISCLAIMER,
  };
}
