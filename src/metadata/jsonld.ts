/** Helpers for reading schema.org JSON-LD without a full RDF processor. */
export type LdNode = Record<string, unknown>;

export function parseJsonLdBlocks(blocks: string[]): { nodes: LdNode[]; errors: number; contexts: string[] } {
  const nodes: LdNode[] = [];
  const contexts = new Set<string>();
  let errors = 0;
  const visit = (v: unknown, depth: number) => {
    if (depth > 8 || nodes.length > 300) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    if (!v || typeof v !== "object") return;
    const obj = v as LdNode;
    const ctx = obj["@context"];
    if (typeof ctx === "string") contexts.add(ctx);
    else if (ctx && typeof ctx === "object" && !Array.isArray(ctx)) {
      const vocab = (ctx as LdNode)["@vocab"];
      if (typeof vocab === "string") contexts.add(vocab);
    }
    if (obj["@type"]) nodes.push(obj);
    for (const [k, child] of Object.entries(obj)) {
      if (k === "@context") continue;
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  for (const raw of blocks) {
    try {
      // Some sites emit control characters or trailing semicolons; be lenient.
      visit(JSON.parse(raw.trim().replace(/;\s*$/, "").replace(/[\u0000-\u001f]+/g, " ")), 0);
    } catch {
      errors++;
    }
  }
  return { nodes, errors, contexts: [...contexts] };
}

export function ldTypes(node: LdNode): string[] {
  const t = node["@type"];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === "string").map((x) => x.replace(/^.*[/#]/, ""));
}

export function isType(node: LdNode, ...types: string[]): boolean {
  const ts = ldTypes(node);
  return types.some((t) => ts.includes(t));
}

/** Coerce a JSON-LD value to display strings: handles {name}, {@value}, {@id}, {url}, arrays. */
export function ldStrings(v: unknown, limit = 20): string[] {
  const out: string[] = [];
  const push = (x: unknown) => {
    if (out.length >= limit || x === null || x === undefined) return;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
      const s = String(x).trim();
      if (s) out.push(s);
    } else if (Array.isArray(x)) x.forEach(push);
    else if (typeof x === "object") {
      const o = x as LdNode;
      push(o.name ?? o["@value"] ?? o.url ?? o["@id"] ?? o.value ?? null);
    }
  };
  push(v);
  return [...new Set(out)];
}

export function ldString(v: unknown): string | null {
  return ldStrings(v, 1)[0] ?? null;
}

export function ldUrl(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as LdNode;
    return (typeof o.url === "string" && o.url) || (typeof o["@id"] === "string" && o["@id"]) || null;
  }
  if (Array.isArray(v)) return ldUrl(v[0]);
  return null;
}
