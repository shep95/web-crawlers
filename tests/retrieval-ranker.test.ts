import { describe, it, expect } from "vitest";
import {
  augmentSeedsForQuestion,
  parseQuestionFocus,
  rankSentencesForQuestion,
} from "../src/chat/retrieval-ranker.js";
import type { ChatDocument } from "../src/chat/algorithm-chatbot.js";

const live = (url: string, text: string, title = "Page"): ChatDocument => ({
  url,
  title,
  text,
  source: "live",
});

describe("retrieval-ranker", () => {
  it("extracts focus terms from definitional questions", () => {
    const focus = parseQuestionFocus("What Are Algorithms");
    expect(focus.kind).toBe("definition");
    expect(focus.terms).toContain("algorithms");
  });

  it("prefers definitional sentences over product marketing", () => {
    const docs = [
      live(
        "https://github.com/EverMind-AI/EverOS",
        "It brings a local-first runtime and modular algorithms through EverAlgo.",
      ),
      live(
        "https://www.britannica.com/science/algorithm",
        "An algorithm is a systematic procedure that produces an answer to a problem in a finite number of steps.",
      ),
    ];
    const ranked = rankSentencesForQuestion("What Are Algorithms", docs, ["https://www.britannica.com/"]);
    expect(ranked[0].url).toContain("britannica.com");
    expect(ranked[0].sentence.toLowerCase()).toContain("algorithm is");
  });

  it("returns empty when no definitional sentences exist", () => {
    const docs = [
      live(
        "https://arxiv.org/list/cond-mat/new",
        "Our analysis provides variational algorithms on hardware for quantum simulation.",
      ),
    ];
    const ranked = rankSentencesForQuestion("What Are Algorithms", docs);
    expect(ranked).toHaveLength(0);
  });
});
