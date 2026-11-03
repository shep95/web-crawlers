import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";

// The production image runs `npm prune --omit=dev`; a package imported by src/ but listed only
// (or also) under devDependencies is removed and the service crashes at start (ERR_MODULE_NOT_FOUND).
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));
const imported = new Set<string>();
for (const f of files("src")) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|require\(\s*)["']([^"'./][^"']*)["']/g)) {
    const spec = m[1];
    if (spec.startsWith("node:") || builtinModules.includes(spec)) continue;
    imported.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);
  }
}

describe("runtime dependencies", () => {
  it("every package imported by src/ is a production dependency", () => {
    const missing = [...imported].filter((p) => !(p in pkg.dependencies));
    expect(missing).toEqual([]);
  });
  it("no package is listed in both dependencies and devDependencies", () => {
    expect(Object.keys(pkg.devDependencies).filter((p) => p in pkg.dependencies)).toEqual([]);
  });
});
