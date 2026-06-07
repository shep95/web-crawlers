export type EngineType =
  | "http"
  | "playwright"
  | "mechanical"
  | "archive"
  | "katana"
  | "splash"
  | "scrapy"
  | "auto";

export type PageSource = "live" | "wayback" | "common_crawl" | "sitemap" | "seed";

export type CrawlStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type Role = "viewer" | "operator" | "admin" | "sovereign";

export interface CrawlJobSpec {
  seeds: string[];
  engine?: EngineType;
  maxDepth?: number;
  /** 0 = use orchestrator max_pages_per_job cap (exhaust frontier) */
  maxPages?: number;
  includeArchive?: boolean;
  includeSitemaps?: boolean;
  jsRendering?: boolean;
  allowedDomains?: string[] | null;
  metadata?: Record<string, unknown>;
  topic?: string | null;
  topicMinLinkScore?: number;
  topicMinRelevance?: number;
  topicFollowRelated?: boolean;
  /** Wait longer for frontier drain on intelligence jobs */
  exhaustive?: boolean;
  /** Pre-built frontier rows (e.g. Wayback snapshots) */
  extraFrontier?: FrontierEntry[];
}

export interface CrawlJob extends CrawlJobSpec {
  id: string;
  status: CrawlStatus;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  pagesCrawled: number;
  pagesFailed: number;
  error?: string | null;
}

export interface PageRecord {
  url: string;
  finalUrl?: string | null;
  statusCode?: number | null;
  contentType?: string | null;
  title?: string | null;
  depth: number;
  source: PageSource;
  engine: EngineType;
  fetchedAt: string;
  contentPath?: string | null;
  contentHash?: string | null;
  linksFound: number;
  archiveTimestamp?: string | null;
  metadata: Record<string, unknown>;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  contentType?: string | null;
  engine: EngineType;
  source: PageSource;
  archiveTimestamp?: string | null;
  error?: string | null;
}

export function fetchOk(result: FetchResult): boolean {
  return result.statusCode >= 200 && result.statusCode < 400 && !result.error;
}

export interface FrontierEntry {
  url: string;
  depth: number;
  source: PageSource;
  priority: number;
  archiveTimestamp?: string | null;
}

export interface Principal {
  subject: string;
  roles: Role[];
}

export interface TopicPageIntel {
  url: string;
  title?: string | null;
  relevance: number;
  metaDescription?: string | null;
  headings: string[];
  socialLinks: string[];
  locations: string[];
  pastLocations: string[];
  origins: string[];
  emails: string[];
  phones: string[];
  family: Array<{ relation: string; name: string }>;
  connections: Array<{ type: string; name: string; url?: string }>;
  knowledgeDomains: string[];
  employment: Array<{ role: string; company: string; period?: string }>;
  pastEmployment: Array<{ role: string; company: string; period?: string }>;
  businesses: Array<{ name: string; type?: string }>;
  government: string[];
  workplaces: Array<{ name: string; address?: string; phone?: string }>;
  coworkers: Array<{ name: string; context?: string }>;
  compensation: string[];
  githubName?: string | null;
  githubBio?: string | null;
  profileItems: string[];
  snippets: string[];
}

export interface TopicReport {
  topic: string;
  jobId: string;
  pagesCrawled: number;
  relevantPages: number;
  pages: TopicPageIntel[];
  aggregatedSocialLinks: string[];
  aggregatedLocations: string[];
  aggregatedSnippets: string[];
  relatedUrls: string[];
}

export interface IntelligenceEntity {
  type:
    | "name"
    | "alias"
    | "handle"
    | "email"
    | "phone"
    | "location"
    | "past_location"
    | "origin"
    | "organization"
    | "connection"
    | "family"
    | "knowledge_domain"
    | "employment"
    | "past_employment"
    | "business"
    | "government"
    | "workplace"
    | "coworker"
    | "compensation"
    | "url";
  value: string;
  confidence: number;
  sources: string[];
  context?: string;
  period?: "present" | "past" | "unknown";
}

export interface HistoricalSnapshot {
  url: string;
  timestamp: string;
  title?: string | null;
  relevance: number;
  snippets: string[];
}

export interface IntelligenceTimelineEvent {
  date: string;
  label: string;
  source: string;
  detail?: string;
}

export interface IntelligenceNetworkEdge {
  from: string;
  to: string;
  relation: string;
}

export interface IntelligenceCrawlStats {
  totalPages: number;
  livePages: number;
  archivePages: number;
  wavesCompleted: number;
  uniqueUrls: number;
  durationMs: number;
  saturated: boolean;
}

export type SocialPlatform =
  | "twitter"
  | "facebook"
  | "instagram"
  | "linkedin"
  | "tiktok"
  | "youtube"
  | "github"
  | "threads"
  | "mastodon"
  | "other";

export interface SocialPlatformProfile {
  platform: SocialPlatform;
  profileUrl: string;
  username?: string;
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
  verified?: boolean;
  discoveredFrom: string[];
  confidence: number;
}

export interface SocialPostImage {
  imageUrl: string;
  postUrl: string;
  altText?: string;
  isLikelySelfImage: boolean;
  selfImageReason?: string;
  platform: SocialPlatform;
}

export interface SocialPost {
  platform: SocialPlatform;
  postUrl: string;
  text: string;
  publishedAt?: string;
  isRepost: boolean;
  repostReason?: string;
  images: SocialPostImage[];
  hashtags: string[];
  mentions: string[];
  sourcePage: string;
}

export interface PersonaContentSignal {
  signal: string;
  evidence: string[];
  confidence: number;
}

/** Content-based public-post analysis — not a clinical psychological assessment. */
export interface PersonaAnalysis {
  summary: string;
  themes: string[];
  tone: string[];
  interests: string[];
  communicationStyle: string[];
  selfPresentation: {
    postsImagesOfSelf: boolean;
    selfImageCount: number;
    totalOriginalImages: number;
    selfImagePercentage: number;
    profilePhotoUrls: string[];
  };
  contentSignals: PersonaContentSignal[];
  disclaimer: string;
}

export interface SocialTrailMap {
  profiles: SocialPlatformProfile[];
  posts: SocialPost[];
  /** Original-post images only (reposts excluded). */
  images: SocialPostImage[];
  persona: PersonaAnalysis;
  platformsFound: SocialPlatform[];
  platformsChecked: SocialPlatform[];
}

export type OrganizationEntityType =
  | "employer"
  | "owned_business"
  | "registered_entity"
  | "affiliation"
  | "unknown";

export interface OrganizationAddressLink {
  address: string;
  addressType: "registered" | "business" | "residential" | "unknown";
  linkedToSubjectHome: boolean;
  linkReason?: string;
  source: string;
}

export interface OrganizationSubjectLink {
  linkType: "employee" | "founder" | "owner" | "executive" | "address_match" | "name_match" | "affiliate";
  detail: string;
  confidence: number;
  source: string;
}

export interface OrganizationIntel {
  name: string;
  normalizedName: string;
  legalForm?: string;
  entityType: OrganizationEntityType;
  isLikelyOwnedBySubject: boolean;
  ownershipReason?: string;
  isRegisteredEntity: boolean;
  addresses: OrganizationAddressLink[];
  phones: Array<{ value: string; source: string }>;
  subjectLinks: OrganizationSubjectLink[];
  relatedPages: string[];
  sources: string[];
  confidence: number;
}

export type DatedEventCategory =
  | "employment_start"
  | "employment_end"
  | "employment_current"
  | "job_post"
  | "business"
  | "location"
  | "social"
  | "general";

export interface DatedEvidence {
  date: string;
  datePrecision: "day" | "month" | "year";
  label: string;
  category: DatedEventCategory;
  detail: string;
  entity?: string;
  role?: string;
  source: string;
  confidence: number;
}

export interface EmploymentTimelineEntry {
  company: string;
  role?: string;
  startDate?: string;
  endDate?: string;
  status: "current" | "past" | "inferred_current" | "inferred_past";
  evidence: DatedEvidence[];
  transitions: string[];
}

export interface TemporalIntelligenceMap {
  datedEvents: DatedEvidence[];
  employmentTimeline: EmploymentTimelineEntry[];
  /** All dated events sorted newest → oldest */
  chronology: DatedEvidence[];
  inferences: string[];
}

export interface HomeAddress {
  address: string;
  normalizedAddress: string;
  city?: string;
  state?: string;
  zip?: string;
  status: "current" | "past";
  sources: string[];
  confidence: number;
}

export type HouseholdMemberStatus = "current_resident" | "former_resident" | "family" | "unknown";

export interface HouseholdMember {
  name: string;
  relation?: string;
  status: HouseholdMemberStatus;
  homeAddress?: string;
  movedInDate?: string;
  movedOutDate?: string;
  movedTo?: string;
  phones: Array<{ value: string; source: string }>;
  socialProfiles: Array<{ platform: string; url: string; source: string }>;
  sources: string[];
  confidence: number;
  lookupQuery?: string;
}

export interface HouseholdMoveEvent {
  member: string;
  fromAddress?: string;
  toAddress?: string;
  date?: string;
  detail: string;
  source: string;
}

export interface HouseholdFamilyPhone {
  value: string;
  member?: string;
  relation?: string;
  source: string;
}

export interface HouseholdFamilySocial {
  member: string;
  relation?: string;
  platform: string;
  url: string;
  source: string;
}

export interface HouseholdMap {
  homeAddresses: HomeAddress[];
  members: HouseholdMember[];
  familyPhones: HouseholdFamilyPhone[];
  familySocial: HouseholdFamilySocial[];
  moveHistory: HouseholdMoveEvent[];
}

/** Intelligence gathered by a spawned agent for a household member / co-resident */
export interface LinkedPersonIntelligence {
  name: string;
  query: string;
  discoveredFrom: string;
  relationToSubject?: string;
  confidence: number;
  /** True when all intelligence dimensions stopped producing new person-related data */
  saturated: boolean;
  stoppedReason: string;
  crawlStats: IntelligenceCrawlStats;
  executiveSummary: string;
  keyFindings: string[];
  peopleMap: PeopleIntelligenceMap;
  /** Nested agents for co-residents discovered on this person (same algorithm, depth-limited) */
  linkedPersons: LinkedPersonIntelligence[];
}

export interface PeopleIntelligenceMap {
  locations: { current: IntelligenceEntity[]; past: IntelligenceEntity[]; origins: IntelligenceEntity[] };
  connections: IntelligenceEntity[];
  family: IntelligenceEntity[];
  phones: IntelligenceEntity[];
  emails: IntelligenceEntity[];
  organizations: IntelligenceEntity[];
  /** Expertise niches: AI, prompt engineering, cybersecurity, etc. */
  knowledgeDomains: IntelligenceEntity[];
  employment: { current: IntelligenceEntity[]; past: IntelligenceEntity[]; compensation: IntelligenceEntity[] };
  businesses: IntelligenceEntity[];
  government: IntelligenceEntity[];
  workplaces: IntelligenceEntity[];
  coworkers: IntelligenceEntity[];
  history: IntelligenceTimelineEvent[];
  historicData: Array<{ period: string; url: string; findings: string[]; sources: string[] }>;
  /** Social media trail: profiles, posts, images, persona signals */
  socialTrail: SocialTrailMap;
  /** Deep mapping of companies/orgs mentioned (LLC, ownership, address links) */
  organizationMap: OrganizationIntel[];
  /** Date-ordered intelligence: employment timeline, job transitions */
  temporal: TemporalIntelligenceMap;
  /** Home address, co-residents, family at residence, move history */
  household: HouseholdMap;
}

export interface RegionalPerspective {
  region: string;
  regionCode: string;
  language?: string;
  themes: string[];
  keyClaims: string[];
  sources: IntelligenceEntity[];
  pageCount: number;
  representativeSnippets: string[];
}

export interface GlobalKnowledgeCoverage {
  regionsRepresented: string[];
  underrepresentedRegions: string[];
  totalRegionalSources: number;
}

export interface KnowledgeIntelligenceMap {
  topic: string;
  primaryDomains: string[];
  subtopics: IntelligenceEntity[];
  keyConcepts: IntelligenceEntity[];
  authoritativeSources: IntelligenceEntity[];
  relatedDomains: IntelligenceEntity[];
  timeline: IntelligenceTimelineEvent[];
  /** How different regions/countries frame the topic */
  regionalPerspectives: RegionalPerspective[];
  globalCoverage: GlobalKnowledgeCoverage;
}

export type SearchMode = "people" | "knowledge";

export interface IntelligenceReport extends TopicReport {
  generatedAt: string;
  searchMode: SearchMode;
  searchModeReason: string;
  mode: "standard" | "exhaustive";
  crawlStats: IntelligenceCrawlStats;
  executiveSummary: string;
  keyFindings: string[];
  entities: IntelligenceEntity[];
  timeline: IntelligenceTimelineEvent[];
  historicalSnapshots: HistoricalSnapshot[];
  networkGraph: IntelligenceNetworkEdge[];
  /** Every URL crawled with relevance — the raw evidence index */
  sourceLinks: IntelligenceSourceLink[];
  /** Structured people-search map (people mode) */
  peopleMap: PeopleIntelligenceMap;
  /** Recursive agent lookups for co-residents / household members discovered */
  linkedPersons: LinkedPersonIntelligence[];
  /** Structured knowledge map (knowledge mode) */
  knowledgeMap: KnowledgeIntelligenceMap;
}

export interface IntelligenceSourceLink {
  url: string;
  title?: string | null;
  relevance: number;
  fetchedAt: string;
  source: PageSource;
  hasExtractedData: boolean;
}
