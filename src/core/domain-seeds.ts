import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export interface DomainSeedEntry {
  seeds: string[];
}

export type DomainSeedsConfig = Record<string, DomainSeedEntry>;

let cached: DomainSeedsConfig | null = null;

function configPath(): string {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  return join(root, "config", "domain-seeds.yaml");
}

export function loadDomainSeeds(force = false): DomainSeedsConfig {
  if (cached && !force) return cached;
  const path = configPath();
  if (!existsSync(path)) {
    cached = {};
    return cached;
  }
  const raw = yaml.load(readFileSync(path, "utf8")) as DomainSeedsConfig;
  cached = raw ?? {};
  return cached;
}

/** Resolve Aureon domain slug or dotted path to whitelisted seed URLs. */
export function resolveDomainSeeds(domain: string): string[] {
  const config = loadDomainSeeds();
  const normalized = domain.trim().toLowerCase();
  if (!normalized) return config.default?.seeds ?? [];

  if (config[normalized]?.seeds?.length) {
    return config[normalized].seeds;
  }

  const parts = normalized.split(".").filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const key = parts[i];
    if (config[key]?.seeds?.length) {
      return config[key].seeds;
    }
  }

  return config.default?.seeds ?? [];
}

/** Hostnames derived from seed URLs — used as crawl allowlist. */
export function allowedDomainsFromSeeds(seeds: string[]): string[] {
  const hosts = new Set<string>();
  for (const seed of seeds) {
    try {
      hosts.add(new URL(seed).hostname.replace(/^www\./, ""));
    } catch {
      /* skip invalid */
    }
  }
  return [...hosts];
}
