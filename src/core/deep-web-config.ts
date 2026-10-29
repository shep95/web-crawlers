export interface DeepWebConfig {
  autoSync: boolean;
  syncIntervalHours: number;
  /** Skip social/drift host blocks for deep-web corpus delivery. */
  uncensored: boolean;
  /** Push full document text to frontend webhook (not just manifest). */
  publishFullText: boolean;
  webhookUrl: string;
  webhookSecret: string;
  frontendDeployHook: string;
  corsOrigins: string[];
}

const DEFAULT: DeepWebConfig = {
  autoSync: false,
  syncIntervalHours: 6,
  uncensored: false,
  publishFullText: false,
  webhookUrl: "",
  webhookSecret: "",
  frontendDeployHook: "",
  corsOrigins: [],
};

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return !/^(0|false|no|off)$/i.test(raw);
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function envString(...names: string[]): string {
  for (const name of names) {
    const v = process.env[name];
    if (v?.trim()) return v.trim();
  }
  return "";
}

let yamlOverlay: Partial<DeepWebConfig> = {};

export function setDeepWebYamlConfig(cfg: Partial<DeepWebConfig> | undefined): void {
  yamlOverlay = cfg ?? {};
}

export function resolveDeepWebConfig(): DeepWebConfig {
  const y = yamlOverlay;
  return {
    autoSync: envBool("DEEP_WEB_AUTO_SYNC", y.autoSync ?? DEFAULT.autoSync),
    syncIntervalHours: envNumber(
      "DEEP_WEB_SYNC_INTERVAL_HOURS",
      y.syncIntervalHours ?? DEFAULT.syncIntervalHours,
    ),
    uncensored: envBool("DEEP_WEB_UNCENSORED", y.uncensored ?? DEFAULT.uncensored),
    publishFullText: envBool(
      "DEEP_WEB_PUBLISH_FULL_TEXT",
      y.publishFullText ?? DEFAULT.publishFullText,
    ),
    webhookUrl: envString("CORPUS_WEBHOOK_URL", "FRONTEND_WEBHOOK_URL", "DEEP_WEB_WEBHOOK_URL") ||
      (y.webhookUrl ?? DEFAULT.webhookUrl),
    webhookSecret: envString("CORPUS_WEBHOOK_SECRET", "DEEP_WEB_WEBHOOK_SECRET") ||
      (y.webhookSecret ?? DEFAULT.webhookSecret),
    frontendDeployHook: envString("FRONTEND_DEPLOY_HOOK_URL", "VERCEL_DEPLOY_HOOK_URL") ||
      (y.frontendDeployHook ?? DEFAULT.frontendDeployHook),
    corsOrigins: (() => {
      const fromEnv = envString("CORS_ORIGIN", "CORS_ORIGINS");
      if (fromEnv) return fromEnv.split(",").map((s) => s.trim()).filter(Boolean);
      return y.corsOrigins ?? DEFAULT.corsOrigins;
    })(),
  };
}

export function isDeepWebUncensored(): boolean {
  return resolveDeepWebConfig().uncensored;
}
