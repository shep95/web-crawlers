import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  rankSentences,
  respondAlgorithm,
  type ChatDocument,
} from "../src/chat/algorithm-chatbot.js";
import {
  assertLiveSeeds,
  isBlockedLocalPath,
  isLiveHttpUrl,
  pagesToLiveDocuments,
} from "../src/chat/live-data-policy.js";

const LIVE_DOC = (url: string, text: string, title = "Live page"): ChatDocument => ({
  url,
  title,
  text,
  source: "live",
  fetchedAt: "2026-06-07T12:00:00.000Z",
});

describe("live-data-policy", () => {
  it("rejects test and local report paths", () => {
    expect(isBlockedLocalPath("tests/fixtures/sample.json")).toBe(true);
    expect(isBlockedLocalPath("data/reports/asher-live-raw.json")).toBe(true);
    expect(isBlockedLocalPath("file:///etc/passwd")).toBe(true);
  });

  it("rejects example.com and localhost", () => {
    expect(isLiveHttpUrl("https://example.com/page")).toBe(false);
    expect(isLiveHttpUrl("http://127.0.0.1:8080")).toBe(false);
    expect(isLiveHttpUrl("https://arxiv.org/list/cs.AI/recent")).toBe(true);
  });

  it("assertLiveSeeds requires public https seeds", () => {
    expect(() => assertLiveSeeds(["https://example.com"])).toThrow(/LIVE_URL_REQUIRED/);
    expect(assertLiveSeeds(["https://arxiv.org/"])).toEqual(["https://arxiv.org/"]);
  });

  it("pagesToLiveDocuments drops archive and test URLs", () => {
    const docs = pagesToLiveDocuments([
      {
        url: "https://arxiv.org/abs/1234",
        finalUrl: "https://arxiv.org/abs/1234",
        title: "Paper",
        depth: 0,
        source: "live",
        engine: "http",
        fetchedAt: "2026-06-07T12:00:00.000Z",
        linksFound: 0,
        metadata: {},
        text: "Supervised machine learning uses labeled examples to tune model weights over many epochs.",
      },
      {
        url: "https://web.archive.org/web/2020/https://arxiv.org/abs/1234",
        finalUrl: "https://web.archive.org/web/2020/https://arxiv.org/abs/1234",
        title: "Archive",
        depth: 0,
        source: "wayback",
        engine: "archive",
        fetchedAt: "2026-06-07T12:00:00.000Z",
        linksFound: 0,
        metadata: {},
        text: "Archived copy should never enter the live training corpus for chat retrieval.",
      },
    ]);
    expect(docs).toHaveLength(1);
    expect(docs[0].source).toBe("live");
    expect(docs[0].url).toContain("arxiv.org");
  });
});

describe("algorithm-chatbot", () => {
  let session: ReturnType<typeof createSession>;

  beforeEach(() => {
    session = createSession("test-session");
  });

  it("alternates Tell me more / This is interesting on vague input", () => {
    const r1 = respondAlgorithm(session, "help");
    expect(r1.reply).toBe("Tell me more.");
    const r2 = respondAlgorithm(r1.session, "yeah");
    expect(r2.reply).toBe("This is interesting.");
    const r3 = respondAlgorithm(r2.session, "ok");
    expect(r3.reply).toBe("Tell me more.");
  });

  it("mirrors I-statements ELIZA-style", () => {
    const r = respondAlgorithm(session, "I am depressed much of the time");
    expect(r.mode).toBe("eliza");
    expect(r.reply.toLowerCase()).toMatch(/depressed|why/);
  });

  it("returns ranked sentence from live crawled documents only", () => {
    const docs = [
      LIVE_DOC(
        "https://arxiv.org/abs/1234",
        "Supervised machine learning uses labeled examples to tune weights. " +
          "Backpropagation adjusts neural network weights until predictions match labels.",
      ),
    ];
    const r = respondAlgorithm(session, "what is supervised machine learning", docs);
    expect(r.mode).toBe("retrieval");
    expect(r.reply.toLowerCase()).toContain("supervised");
    expect(r.sources[0].url).toBe("https://arxiv.org/abs/1234");
  });

  it("ignores non-live document sources", () => {
    const archiveDoc = {
      url: "https://arxiv.org/abs/9999",
      title: "Archive copy",
      text: "This sentence would match supervised machine learning keywords easily.",
      source: "wayback",
    } as unknown as ChatDocument;
    const r = respondAlgorithm(session, "supervised machine learning", [archiveDoc]);
    expect(r.mode).not.toBe("retrieval");
  });

  it("continues with next sentence on tell me more", () => {
    const docs = [
      LIVE_DOC(
        "https://arxiv.org/abs/1234",
        "Supervised machine learning uses labeled examples to tune weights. " +
          "Neural networks learn through backpropagation on labeled machine learning data.",
      ),
    ];
    const first = respondAlgorithm(session, "machine learning labeled", docs);
    expect(first.mode).toBe("retrieval");
    const second = respondAlgorithm(first.session, "tell me more");
    expect(second.mode).toBe("continuation");
    expect(second.reply).not.toBe(first.reply);
  });

  it("ranks sentences by term overlap from live docs", () => {
    const docs = [
      LIVE_DOC("https://a.example-blocked.test", "Cats sleep on mats all day long."),
      LIVE_DOC(
        "https://paperswithcode.com/task/machine-learning",
        "Neural networks learn weights through backpropagation on labeled data sets.",
      ),
    ];
    const ranked = rankSentences("neural network backpropagation", docs);
    expect(ranked[0].url).toContain("paperswithcode.com");
  });

  it("includes honest disclaimer on every reply", () => {
    const r = respondAlgorithm(session, "hello");
    expect(r.disclaimer.toLowerCase()).toContain("pattern matching");
  });
});
