import * as cheerio from "cheerio";
import type {
  PageRecord,
  PersonaAnalysis,
  PersonaContentSignal,
  SocialPlatform,
  SocialPlatformProfile,
  SocialPost,
  SocialPostImage,
  SocialTrailMap,
  TopicPageIntel,
} from "../core/models.js";
import type { TopicProfile } from "./index.js";

const KNOWN_PLATFORMS: SocialPlatform[] = [
  "twitter",
  "facebook",
  "instagram",
  "linkedin",
  "tiktok",
  "youtube",
  "github",
  "threads",
  "mastodon",
];

const PLATFORM_HOSTS: Array<{ platform: SocialPlatform; hosts: RegExp; profileRe: RegExp }> = [
  {
    platform: "twitter",
    hosts: /(?:^|\.)((?:x|twitter)\.com)$/i,
    profileRe: /^\/([a-zA-Z0-9_]{1,15})\/?(?:\?|#|$)/,
  },
  {
    platform: "facebook",
    hosts: /(?:^|\.)facebook\.com$/i,
    profileRe: /^\/(?!groups|pages|events|watch|share|photo|story|reel)([a-zA-Z0-9.]{2,50})\/?(?:\?|#|$)/,
  },
  {
    platform: "instagram",
    hosts: /(?:^|\.)instagram\.com$/i,
    profileRe: /^\/(?!p|reel|stories|explore|accounts|direct)([a-zA-Z0-9._]{1,30})\/?(?:\?|#|$)/,
  },
  {
    platform: "linkedin",
    hosts: /(?:^|\.)linkedin\.com$/i,
    profileRe: /^\/in\/([a-zA-Z0-9_-]{2,100})\/?(?:\?|#|$)/,
  },
  {
    platform: "tiktok",
    hosts: /(?:^|\.)tiktok\.com$/i,
    profileRe: /^\/@([a-zA-Z0-9._]{2,24})\/?(?:\?|#|$)/,
  },
  {
    platform: "youtube",
    hosts: /(?:^|\.)youtube\.com$/i,
    profileRe: /^\/(?:@|c\/|user\/)([a-zA-Z0-9._-]{2,50})\/?(?:\?|#|$)/,
  },
  {
    platform: "github",
    hosts: /(?:^|\.)github\.com$/i,
    profileRe: /^\/(?!orgs|topics|marketplace|features|settings|login|search|explore)([a-zA-Z0-9_-]{1,39})\/?(?:\?|#|$)/,
  },
  {
    platform: "threads",
    hosts: /(?:^|\.)threads\.net$/i,
    profileRe: /^\/@([a-zA-Z0-9._]{1,30})\/?(?:\?|#|$)/,
  },
  {
    platform: "mastodon",
    hosts: /mastodon\.|\.social$/i,
    profileRe: /^\/@([a-zA-Z0-9_]{1,30})\/?(?:\?|#|$)/,
  },
];

const REPOST_PATTERNS: RegExp[] = [
  /\bRT @/i,
  /\bretweeted\b/i,
  /\brepost(?:ed|ing)?\b/i,
  /\bshared (?:a )?post\b/i,
  /\bshared from\b/i,
  /\bvia @/i,
  /"retweeted_status"/i,
  /"is_retweet"\s*:\s*true/i,
  /"reposted"\s*:\s*true/i,
  /aria-label="[^"]*repost/i,
];

const SELF_IMAGE_PATTERNS: RegExp[] = [
  /\bselfie\b/i,
  /\bheadshot\b/i,
  /\bprofile (?:pic|photo|picture|image)\b/i,
  /\bmy face\b/i,
  /\bphoto of me\b/i,
  /\bpicture of me\b/i,
  /\bmirror (?:pic|selfie|shot)\b/i,
  /\/avatar/i,
  /\/profile/i,
  /profile_pic/i,
  /\/self\//i,
];

const THEME_KEYWORDS: Record<string, RegExp> = {
  technology: /\b(?:ai|software|code|coding|developer|tech|startup|prompt|llm|machine learning)\b/i,
  business: /\b(?:business|entrepreneur|founder|ceo|marketing|sales|brand|llc|company)\b/i,
  family: /\b(?:family|kids|children|wife|husband|mom|dad|parent)\b/i,
  fitness: /\b(?:gym|workout|fitness|run|running|health|nutrition)\b/i,
  travel: /\b(?:travel|trip|vacation|flight|hotel|beach|explore)\b/i,
  politics: /\b(?:politics|election|vote|president|congress|policy)\b/i,
  creative: /\b(?:art|design|music|photo|photography|video|film|creative)\b/i,
  education: /\b(?:school|university|college|student|learn|course|degree)\b/i,
};

const TRACKING_IMAGE =
  /(?:pixel|spacer|1x1|beacon|analytics|doubleclick|facebook\.com\/tr|\.gif\?)/i;

export function classifySocialUrl(url: string): { platform: SocialPlatform; username?: string; isProfile: boolean } | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const path = parsed.pathname;

    for (const entry of PLATFORM_HOSTS) {
      if (!entry.hosts.test(host)) continue;
      const m = path.match(entry.profileRe);
      if (m) {
        return { platform: entry.platform, username: m[1], isProfile: true };
      }
      return { platform: entry.platform, isProfile: false };
    }
  } catch {
    return null;
  }
  return null;
}

export function isSocialProfileUrl(url: string): boolean {
  const c = classifySocialUrl(url);
  return c?.isProfile === true;
}

export function normalizeProfileUrl(url: string): string | null {
  const c = classifySocialUrl(url);
  if (!c?.isProfile || !c.username) return null;
  const base: Record<SocialPlatform, (u: string) => string> = {
    twitter: (u) => `https://x.com/${u}`,
    facebook: (u) => `https://facebook.com/${u}`,
    instagram: (u) => `https://instagram.com/${u}`,
    linkedin: (u) => `https://linkedin.com/in/${u}`,
    tiktok: (u) => `https://tiktok.com/@${u}`,
    youtube: (u) => `https://youtube.com/@${u}`,
    github: (u) => `https://github.com/${u}`,
    threads: (u) => `https://threads.net/@${u}`,
    mastodon: (u) => url.split("/@")[0] + `/@${u}`,
    other: () => url,
  };
  return base[c.platform](c.username.toLowerCase());
}

export function isRepostText(text: string, html?: string): { isRepost: boolean; reason?: string } {
  const combined = `${text}\n${html ?? ""}`;
  for (const re of REPOST_PATTERNS) {
    if (re.test(combined)) return { isRepost: true, reason: re.source.slice(0, 60) };
  }
  return { isRepost: false };
}

export function isLikelySelfImage(
  imageUrl: string,
  altText: string | undefined,
  postText: string,
  profile: TopicProfile,
  avatarUrls: string[],
): { isSelf: boolean; reason?: string } {
  const blob = `${imageUrl} ${altText ?? ""} ${postText}`.toLowerCase();
  for (const re of SELF_IMAGE_PATTERNS) {
    if (re.test(blob)) return { isSelf: true, reason: re.source.slice(0, 40) };
  }
  for (const term of profile.terms) {
    if (term.length >= 4 && altText?.toLowerCase().includes(term)) {
      return { isSelf: true, reason: `alt text matches subject term "${term}"` };
    }
  }
  if (avatarUrls.some((a) => a && imageUrl.includes(new URL(a).pathname.split("/").pop() ?? "___"))) {
    return { isSelf: true, reason: "matches profile avatar" };
  }
  if (/\b(?:i am|i'm|myself|me in|of myself)\b/i.test(postText) && /photo|pic|image|selfie/i.test(blob)) {
    return { isSelf: true, reason: "first-person + photo context" };
  }
  return { isSelf: false };
}

function isValidPostImage(url: string): boolean {
  if (!url.startsWith("http")) return false;
  if (TRACKING_IMAGE.test(url)) return false;
  if (/\.(svg|ico)(\?|$)/i.test(url)) return false;
  if (/emoji|icon|logo|badge|sprite|favicon/i.test(url) && !/profile|avatar|photo|media/i.test(url)) return false;
  return true;
}

function extractHashtags(text: string): string[] {
  return [...new Set((text.match(/#[a-zA-Z0-9_]{2,40}/g) ?? []).map((h) => h.slice(1).toLowerCase()))];
}

function extractMentions(text: string): string[] {
  return [...new Set((text.match(/@([a-zA-Z0-9_]{2,30})/g) ?? []).map((m) => m.slice(1).toLowerCase()))];
}

function parseEmbeddedPosts(html: string, pageUrl: string, platform: SocialPlatform): SocialPost[] {
  const posts: SocialPost[] = [];
  const jsonBlocks: string[] = [];

  const ldMatches = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of ldMatches) {
    const inner = block.replace(/<\/?script[^>]*>/gi, "").trim();
    if (inner) jsonBlocks.push(inner);
  }
  const appJson = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of appJson) {
    const inner = block.replace(/<\/?script[^>]*>/gi, "").trim();
    if (inner.length > 50 && inner.length < 500_000) jsonBlocks.push(inner);
  }

  for (const raw of jsonBlocks) {
    try {
      const data = JSON.parse(raw) as unknown;
      walkJsonForPosts(data, pageUrl, platform, posts);
    } catch {
      /* skip malformed */
    }
  }

  const tweetTexts = html.match(/"full_text"\s*:\s*"((?:\\.|[^"\\])*)"/g) ?? [];
  for (const match of tweetTexts.slice(0, 20)) {
    const textMatch = match.match(/"full_text"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (!textMatch) continue;
    const text = unescapeJson(textMatch[1]);
    const repost = isRepostText(text, html);
    if (repost.isRepost) continue;
    posts.push({
      platform,
      postUrl: pageUrl,
      text,
      isRepost: false,
      images: [],
      hashtags: extractHashtags(text),
      mentions: extractMentions(text),
      sourcePage: pageUrl,
    });
  }

  return posts;
}

function unescapeJson(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function walkJsonForPosts(node: unknown, pageUrl: string, platform: SocialPlatform, posts: SocialPost[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkJsonForPosts(item, pageUrl, platform, posts);
    return;
  }
  const obj = node as Record<string, unknown>;
  const text =
    (typeof obj.full_text === "string" && obj.full_text) ||
    (typeof obj.text === "string" && obj.text) ||
    (typeof obj.caption === "string" && obj.caption) ||
    (typeof obj.description === "string" && obj.description && obj["@type"] === "SocialMediaPosting" ? obj.description : null);

  if (text && text.length > 5 && text.length < 5000) {
    const repost = isRepostText(text, JSON.stringify(obj));
    if (!repost.isRepost) {
      const postUrl =
        (typeof obj.url === "string" && obj.url) ||
        (typeof obj.permalink === "string" && obj.permalink) ||
        pageUrl;
      const images: SocialPostImage[] = [];
      collectJsonImages(obj, postUrl, platform, images);
      posts.push({
        platform,
        postUrl,
        text,
        publishedAt: typeof obj.created_at === "string" ? obj.created_at : undefined,
        isRepost: false,
        images,
        hashtags: extractHashtags(text),
        mentions: extractMentions(text),
        sourcePage: pageUrl,
      });
    }
  }
  for (const v of Object.values(obj)) walkJsonForPosts(v, pageUrl, platform, posts);
}

function collectJsonImages(obj: Record<string, unknown>, postUrl: string, platform: SocialPlatform, out: SocialPostImage[]): void {
  const url =
    (typeof obj.display_url === "string" && obj.display_url) ||
    (typeof obj.media_url_https === "string" && obj.media_url_https) ||
    (typeof obj.url === "string" && /\.(?:jpg|jpeg|png|webp)/i.test(obj.url) ? obj.url : null);
  if (url && isValidPostImage(url)) {
    out.push({
      imageUrl: url,
      postUrl,
      altText: typeof obj.alt_text === "string" ? obj.alt_text : undefined,
      isLikelySelfImage: false,
      platform,
    });
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") collectJsonImages(v as Record<string, unknown>, postUrl, platform, out);
  }
}

function extractImagesFromHtml(
  $: cheerio.CheerioAPI,
  pageUrl: string,
  platform: SocialPlatform,
  postText: string,
  profile: TopicProfile,
  avatarUrls: string[],
): SocialPostImage[] {
  const images: SocialPostImage[] = [];
  $("img[src], img[data-src]").each((_, el) => {
    const src = $(el).attr("src") ?? $(el).attr("data-src");
    if (!src) return;
    let imageUrl: string;
    try {
      imageUrl = new URL(src, pageUrl).toString();
    } catch {
      return;
    }
    if (!isValidPostImage(imageUrl)) return;
    const alt = $(el).attr("alt")?.trim();
    const parentLink = $(el).closest("a[href]").attr("href");
    let postUrl = pageUrl;
    if (parentLink) {
      try {
        postUrl = new URL(parentLink, pageUrl).toString();
      } catch {
        /* keep pageUrl */
      }
    }
    const self = isLikelySelfImage(imageUrl, alt, postText, profile, avatarUrls);
    images.push({
      imageUrl,
      postUrl,
      altText: alt,
      isLikelySelfImage: self.isSelf,
      selfImageReason: self.reason,
      platform,
    });
  });
  return images;
}

export function extractSocialContent(
  url: string,
  html: string,
  profile: TopicProfile,
  avatarUrls: string[] = [],
): { posts: SocialPost[]; profileMeta: Partial<SocialPlatformProfile> } {
  const classified = classifySocialUrl(url);
  const platform = classified?.platform ?? "other";
  const $ = cheerio.load(html);
  const posts: SocialPost[] = [...parseEmbeddedPosts(html, url, platform)];

  const ogImage = $('meta[property="og:image"]').attr("content")?.trim();
  const ogDesc = $('meta[property="og:description"]').attr("content")?.trim();
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim();
  const metaDesc = $('meta[name="description"]').attr("content")?.trim();

  const profileMeta: Partial<SocialPlatformProfile> = {
    platform,
    profileUrl: normalizeProfileUrl(url) ?? url,
    username: classified?.username,
    displayName: ogTitle ?? ($("h1").first().text().trim() || undefined),
    bio: ogDesc ?? metaDesc ?? undefined,
    avatarUrl: ogImage,
  };

  if (url.includes("github.com")) {
    const ghName = $(".p-name").first().text().trim();
    const ghBio = $(".p-note").first().text().trim();
    const ghAvatar = $(".avatar-user img, img.avatar").first().attr("src");
    if (ghName) profileMeta.displayName = ghName;
    if (ghBio) profileMeta.bio = ghBio;
    if (ghAvatar) profileMeta.avatarUrl = new URL(ghAvatar, url).toString();
    const pinned = $(".pinned-item-list-item, [data-hydro-click*='pinned']").slice(0, 5);
    pinned.each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 400);
      if (text.length > 10) {
        posts.push({
          platform: "github",
          postUrl: url,
          text: `Pinned: ${text}`,
          isRepost: false,
          images: [],
          hashtags: [],
          mentions: [],
          sourcePage: url,
        });
      }
    });
  }

  const articleTexts = $("article, [data-testid='tweet'], .tweet, .status, .post, .feed-shared-update-v2")
    .slice(0, 25)
    .map((_, el) => $(el).text().replace(/\s+/g, " ").trim())
    .get()
    .filter((t) => t.length > 15 && t.length < 4000);

  for (const text of articleTexts) {
    const repost = isRepostText(text);
    if (repost.isRepost) continue;
    const postUrl = url;
    const imgs = extractImagesFromHtml($, url, platform, text, profile, [
      ...avatarUrls,
      profileMeta.avatarUrl ?? "",
    ]);
    posts.push({
      platform,
      postUrl,
      text,
      isRepost: false,
      images: imgs,
      hashtags: extractHashtags(text),
      mentions: extractMentions(text),
      sourcePage: url,
    });
  }

  if (!posts.length && (ogDesc || metaDesc)) {
    const text = ogDesc ?? metaDesc ?? "";
    if (text.length > 10 && !isRepostText(text).isRepost) {
      posts.push({
        platform,
        postUrl: url,
        text,
        isRepost: false,
        images: ogImage && isValidPostImage(ogImage)
          ? [{
              imageUrl: ogImage,
              postUrl: url,
              isLikelySelfImage: isLikelySelfImage(ogImage, undefined, text, profile, avatarUrls).isSelf,
              selfImageReason: isLikelySelfImage(ogImage, undefined, text, profile, avatarUrls).reason,
              platform,
            }]
          : [],
        hashtags: extractHashtags(text),
        mentions: extractMentions(text),
        sourcePage: url,
      });
    }
  }

  return { posts, profileMeta };
}

export function discoverSocialProfiles(
  intelPages: TopicPageIntel[],
  allPages: PageRecord[],
  profile: TopicProfile,
): SocialPlatformProfile[] {
  const map = new Map<string, SocialPlatformProfile>();

  const consider = (rawUrl: string, source: string, confidence: number) => {
    const normalized = normalizeProfileUrl(rawUrl);
    if (!normalized) return;
    const classified = classifySocialUrl(normalized);
    if (!classified?.isProfile) return;

    const key = normalized.toLowerCase();
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        platform: classified.platform,
        profileUrl: normalized,
        username: classified.username,
        discoveredFrom: [source],
        confidence,
      });
    } else {
      existing.confidence = Math.max(existing.confidence, confidence);
      existing.discoveredFrom = [...new Set([...existing.discoveredFrom, source])];
    }
  };

  for (const intel of intelPages) {
    const conf = Math.min(0.95, 0.35 + intel.relevance);
    for (const link of intel.socialLinks) consider(link, intel.url, conf);
    for (const c of intel.connections) {
      if (c.url) consider(c.url, intel.url, conf * 0.9);
    }
    if (isSocialProfileUrl(intel.url)) consider(intel.url, intel.url, conf + 0.1);
  }

  for (const page of allPages) {
    if (isSocialProfileUrl(page.url)) {
      consider(page.url, page.url, 0.5);
    }
  }

  for (const slug of profile.slugVariants()) {
    if (slug.length >= 3) {
      consider(`https://github.com/${slug}`, "query-slug", 0.45);
      consider(`https://x.com/${slug}`, "query-slug", 0.4);
      consider(`https://instagram.com/${slug}`, "query-slug", 0.35);
    }
  }

  return [...map.values()]
    .filter((p) => p.platform !== "other")
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 25);
}

export function collectSocialProfileSeeds(
  intelPages: TopicPageIntel[],
  allPages: PageRecord[],
  profile: TopicProfile,
): string[] {
  return discoverSocialProfiles(intelPages, allPages, profile).map((p) => p.profileUrl);
}

export function analyzePersona(
  profile: TopicProfile,
  posts: SocialPost[],
  profiles: SocialPlatformProfile[],
  images: SocialPostImage[],
): PersonaAnalysis {
  const originalPosts = posts.filter((p) => !p.isRepost);
  const allText = originalPosts.map((p) => p.text).join("\n");
  const themes: string[] = [];
  for (const [theme, re] of Object.entries(THEME_KEYWORDS)) {
    if (re.test(allText)) themes.push(theme);
  }

  const tone: string[] = [];
  if (/!{2,}/.test(allText)) tone.push("emphatic");
  if (/\?/.test(allText)) tone.push("inquisitive");
  if (/[A-Z]{4,}/.test(allText)) tone.push("assertive/caps-heavy");
  if (/[\u{1F300}-\u{1FAFF}]/u.test(allText)) tone.push("emoji-rich");
  if (/\b(?:excited|grateful|thank|love|proud|happy)\b/i.test(allText)) tone.push("positive");
  if (/\b(?:frustrated|angry|disappointed|worried|concerned)\b/i.test(allText)) tone.push("negative/critical");
  if (!tone.length) tone.push("neutral/measured");

  const hashtagCounts = new Map<string, number>();
  for (const p of originalPosts) {
    for (const h of p.hashtags) hashtagCounts.set(h, (hashtagCounts.get(h) ?? 0) + 1);
  }
  const interests = [...hashtagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([h]) => h);
  for (const t of themes) {
    if (!interests.includes(t)) interests.push(t);
  }

  const communicationStyle: string[] = [];
  const firstPerson = (allText.match(/\b(?:I|I'm|I've|my|me|myself)\b/gi) ?? []).length;
  const promo = (allText.match(/\b(?:buy|sale|discount|link in bio|check out|launch|hire|dm me)\b/gi) ?? []).length;
  if (firstPerson > 5) communicationStyle.push("personal/self-disclosing");
  if (promo > 2) communicationStyle.push("promotional");
  if (originalPosts.some((p) => p.text.length > 280)) communicationStyle.push("long-form");
  if (originalPosts.some((p) => p.text.length < 80)) communicationStyle.push("short-form");
  if (!communicationStyle.length) communicationStyle.push("informational");

  const selfImages = images.filter((i) => i.isLikelySelfImage);
  const profilePhotos = [
    ...new Set(profiles.map((p) => p.avatarUrl).filter(Boolean) as string[]),
  ];

  const contentSignals: PersonaContentSignal[] = [];
  if (themes.length) {
    contentSignals.push({
      signal: `Recurring themes: ${themes.join(", ")}`,
      evidence: originalPosts.slice(0, 3).map((p) => p.text.slice(0, 120)),
      confidence: 0.7,
    });
  }
  if (selfImages.length) {
    contentSignals.push({
      signal: "Posts images likely depicting themselves",
      evidence: selfImages.slice(0, 3).map((i) => i.selfImageReason ?? i.imageUrl),
      confidence: 0.65,
    });
  }
  if (profiles.length) {
    contentSignals.push({
      signal: `Active on ${profiles.map((p) => p.platform).join(", ")}`,
      evidence: profiles.slice(0, 4).map((p) => p.profileUrl),
      confidence: 0.8,
    });
  }

  const summaryParts: string[] = [];
  if (profiles.length) {
    summaryParts.push(
      `Public social trail spans ${profiles.length} profile(s) across ${[...new Set(profiles.map((p) => p.platform))].join(", ")}.`,
    );
  } else {
    summaryParts.push("No confirmed social profiles discovered from crawled pages.");
  }
  if (originalPosts.length) {
    summaryParts.push(
      `${originalPosts.length} original post(s) analyzed (${posts.length - originalPosts.length} reposts excluded).`,
    );
  }
  if (themes.length) summaryParts.push(`Dominant themes: ${themes.slice(0, 4).join(", ")}.`);
  if (tone.length) summaryParts.push(`Tone signals: ${tone.slice(0, 3).join(", ")}.`);
  if (selfImages.length) {
    summaryParts.push(
      `${selfImages.length} image(s) appear to depict the subject (${Math.round((selfImages.length / Math.max(1, images.length)) * 100)}% of original-post images).`,
    );
  }

  return {
    summary: summaryParts.join(" "),
    themes,
    tone,
    interests,
    communicationStyle,
    selfPresentation: {
      postsImagesOfSelf: selfImages.length > 0,
      selfImageCount: selfImages.length,
      totalOriginalImages: images.length,
      selfImagePercentage: images.length ? Math.round((selfImages.length / images.length) * 100) : 0,
      profilePhotoUrls: profilePhotos,
    },
    contentSignals,
    disclaimer:
      "Persona analysis is derived from publicly crawled posts and images only. It reflects content patterns, not clinical psychology or verified identity.",
  };
}

export function emptySocialTrail(): SocialTrailMap {
  return {
    profiles: [],
    posts: [],
    images: [],
    persona: {
      summary: "No social media trail analyzed.",
      themes: [],
      tone: [],
      interests: [],
      communicationStyle: [],
      selfPresentation: {
        postsImagesOfSelf: false,
        selfImageCount: 0,
        totalOriginalImages: 0,
        selfImagePercentage: 0,
        profilePhotoUrls: [],
      },
      contentSignals: [],
      disclaimer:
        "Persona analysis is derived from publicly crawled posts and images only. It reflects content patterns, not clinical psychology or verified identity.",
    },
    platformsFound: [],
    platformsChecked: KNOWN_PLATFORMS,
  };
}

export function buildSocialTrail(
  intelPages: TopicPageIntel[],
  allPages: PageRecord[],
  profile: TopicProfile,
  loadBody: (page: PageRecord) => string,
): SocialTrailMap {
  const profiles = discoverSocialProfiles(intelPages, allPages, profile);
  const profileByUrl = new Map(profiles.map((p) => [p.profileUrl.toLowerCase(), p]));
  const avatarUrls = profiles.map((p) => p.avatarUrl).filter(Boolean) as string[];

  const allPosts: SocialPost[] = [];
  const seenPostKeys = new Set<string>();

  const socialPages = allPages.filter((p) => {
    const c = classifySocialUrl(p.url);
    return c !== null;
  });

  for (const page of socialPages) {
    const body = loadBody(page);
    if (!body || body.length < 50) continue;
    const { posts, profileMeta } = extractSocialContent(page.url, body, profile, avatarUrls);

    const norm = normalizeProfileUrl(page.url);
    if (norm) {
      const key = norm.toLowerCase();
      const existing = profileByUrl.get(key);
      if (existing) {
        if (profileMeta.displayName) existing.displayName = profileMeta.displayName;
        if (profileMeta.bio) existing.bio = profileMeta.bio;
        if (profileMeta.avatarUrl) existing.avatarUrl = profileMeta.avatarUrl;
        if (profileMeta.username) existing.username = profileMeta.username;
      } else {
        const pagePlatform = classifySocialUrl(page.url)?.platform ?? profileMeta.platform ?? "other";
        const added: SocialPlatformProfile = {
          platform: pagePlatform,
          profileUrl: norm,
          username: profileMeta.username,
          displayName: profileMeta.displayName,
          bio: profileMeta.bio,
          avatarUrl: profileMeta.avatarUrl,
          discoveredFrom: [page.url],
          confidence: 0.55,
        };
        profiles.push(added);
        profileByUrl.set(key, added);
        if (profileMeta.avatarUrl) avatarUrls.push(profileMeta.avatarUrl);
      }
    }

    for (const post of posts) {
      const dedupeKey = `${post.platform}:${post.postUrl}:${post.text.slice(0, 80)}`;
      if (seenPostKeys.has(dedupeKey)) continue;
      seenPostKeys.add(dedupeKey);
      allPosts.push(post);
    }
  }

  for (const post of allPosts) {
    for (const img of post.images) {
      if (!img.isLikelySelfImage) {
        const self = isLikelySelfImage(img.imageUrl, img.altText, post.text, profile, avatarUrls);
        img.isLikelySelfImage = self.isSelf;
        img.selfImageReason = self.reason;
      }
    }
  }

  const originalPosts = allPosts.filter((p) => !p.isRepost);
  const images = originalPosts.flatMap((p) => p.images);

  const persona = analyzePersona(profile, allPosts, profiles, images);
  const platformsFound = [...new Set(profiles.map((p) => p.platform))];

  return {
    profiles: profiles.sort((a, b) => b.confidence - a.confidence),
    posts: allPosts.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "")),
    images,
    persona,
    platformsFound,
    platformsChecked: KNOWN_PLATFORMS,
  };
}

export function formatSocialTrailMarkdown(trail: SocialTrailMap): string {
  const lines: string[] = ["## Social Media Trail", ""];

  lines.push("### Profiles Discovered", "");
  if (!trail.profiles.length) {
    lines.push("_No social profiles confirmed — add direct profile `--seed` URLs (e.g. X, Instagram, GitHub)._", "");
  } else {
    for (const p of trail.profiles.slice(0, 15)) {
      const name = p.displayName ? ` — ${p.displayName}` : "";
      const user = p.username ? ` (@${p.username})` : "";
      lines.push(
        `- **${p.platform}**${user}${name} — [${p.profileUrl}](${p.profileUrl}) (confidence ${(p.confidence * 100).toFixed(0)}%)`,
      );
      if (p.bio) lines.push(`  - Bio: ${p.bio.slice(0, 200)}`);
      if (p.avatarUrl) lines.push(`  - Avatar: [${p.avatarUrl}](${p.avatarUrl})`);
      lines.push(`  - Found via: ${p.discoveredFrom.slice(0, 2).join(", ")}`);
    }
    lines.push("");
  }

  lines.push("### Platforms", "");
  lines.push(`Found: ${trail.platformsFound.length ? trail.platformsFound.join(", ") : "none"}`);
  lines.push(`Checked for: ${trail.platformsChecked.join(", ")}`, "");

  lines.push("### Persona & Content Analysis", "");
  lines.push(`> ${trail.persona.disclaimer}`, "");
  lines.push(trail.persona.summary, "");
  if (trail.persona.themes.length) lines.push(`**Themes:** ${trail.persona.themes.join(", ")}`);
  if (trail.persona.tone.length) lines.push(`**Tone:** ${trail.persona.tone.join(", ")}`);
  if (trail.persona.interests.length) lines.push(`**Interests/hashtags:** ${trail.persona.interests.slice(0, 10).join(", ")}`);
  if (trail.persona.communicationStyle.length) {
    lines.push(`**Communication style:** ${trail.persona.communicationStyle.join(", ")}`);
  }
  const sp = trail.persona.selfPresentation;
  lines.push(
    `**Self-images:** ${sp.postsImagesOfSelf ? "yes" : "no"} — ${sp.selfImageCount}/${sp.totalOriginalImages} original-post images (${sp.selfImagePercentage}%)`,
  );
  if (sp.profilePhotoUrls.length) {
    lines.push("**Profile photos:**");
    for (const u of sp.profilePhotoUrls.slice(0, 5)) lines.push(`- [${u}](${u})`);
  }
  lines.push("");

  if (trail.persona.contentSignals.length) {
    lines.push("**Content signals:**", "");
    for (const s of trail.persona.contentSignals.slice(0, 6)) {
      lines.push(`- ${s.signal} (${(s.confidence * 100).toFixed(0)}%)`);
      for (const e of s.evidence.slice(0, 2)) lines.push(`  - ${e.slice(0, 140)}`);
    }
    lines.push("");
  }

  const originalPosts = trail.posts.filter((p) => !p.isRepost);
  lines.push("### Posts (original only)", "");
  if (!originalPosts.length) {
    lines.push("_No original posts extracted — many platforms require JS rendering (`--js`) or block crawlers._", "");
  } else {
    for (const p of originalPosts.slice(0, 20)) {
      lines.push(`- **[${p.platform}]** [post](${p.postUrl})`);
      lines.push(`  - ${p.text.slice(0, 220)}${p.text.length > 220 ? "…" : ""}`);
      if (p.hashtags.length) lines.push(`  - Tags: ${p.hashtags.map((h) => `#${h}`).join(" ")}`);
    }
    lines.push("");
  }

  lines.push("### Images (original posts, reposts excluded)", "");
  if (!trail.images.length) {
    lines.push("_No images gathered from original posts._", "");
  } else {
    for (const img of trail.images.slice(0, 30)) {
      const self = img.isLikelySelfImage ? " **likely self**" : "";
      const reason = img.selfImageReason ? ` (${img.selfImageReason})` : "";
      lines.push(`- [image](${img.imageUrl}) → [post](${img.postUrl})${self}${reason}`);
      if (img.altText) lines.push(`  - alt: ${img.altText.slice(0, 100)}`);
    }
  }

  return lines.join("\n");
}
