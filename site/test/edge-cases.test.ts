import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inlineMarkdown, parseEdgeCases } from "../src/lib/edge-cases";

const catalog = readFileSync(new URL("../../docs/05-edge-cases.md", import.meta.url), "utf8");

describe("the edge case page reads docs/05-edge-cases.md", () => {
  const sections = parseEdgeCases(catalog);
  const cases = sections.flatMap((s) => s.cases);

  it("reads every row of the catalog, once", () => {
    const rows = catalog.split("\n").filter((line) => /^\| EC-\d+ \|/.test(line));
    expect(cases.map((c) => c.id)).toEqual(rows.map((r) => /EC-\d+/.exec(r)?.[0]));
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  it("finds a situation, a behavior and a tier in every row", () => {
    for (const c of cases) {
      expect(c.situation, c.id).not.toBe("");
      expect(c.behavior, c.id).not.toBe("");
      expect(c.tier, c.id).toMatch(/^(Core|Pro)/);
    }
  });

  it("keeps escaped pipes inside a cell", () => {
    const [section] = parseEdgeCases('## X\n\n| EC-99 | s | `"a" \\| "b"` | — | Core |\n');
    expect(section?.cases[0]).toMatchObject({ behavior: '`"a" | "b"`', config: "" });
  });

  it("refuses a row it cannot read instead of dropping it", () => {
    expect(() => parseEdgeCases("## X\n\n| EC-99 | only | three |\n")).toThrow(/EC-99/);
  });

  it("renders code, bold and emphasis, and escapes HTML", () => {
    expect(inlineMarkdown("**Pro**: `a < b` and *x* <script>")).toBe(
      "<strong>Pro</strong>: <code>a &lt; b</code> and <em>x</em> &lt;script&gt;",
    );
  });

  it("links a mention of another case, but not inside code", () => {
    expect(inlineMarkdown("see EC-43 and `EC-01`")).toBe(
      'see <a href="#ec-43">EC-43</a> and <code>EC-01</code>',
    );
    const ids = new Set(cases.map((c) => c.id));
    const mentioned = cases.flatMap((c) =>
      [...`${c.situation} ${c.behavior} ${c.config}`.matchAll(/\bEC-\d+\b/g)].map((m) => m[0]),
    );
    expect(mentioned.filter((id) => !ids.has(id))).toEqual([]);
  });

  it("every link to a case on the site names a case that exists", () => {
    const ids = new Set(cases.map((c) => c.id.toLowerCase()));
    const dir = fileURLToPath(new URL("../src/content/docs", import.meta.url));
    const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
      /\.mdx?$/.test(f),
    );
    const broken: string[] = [];
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const [, id] of text.matchAll(/#(ec-\d+)/g)) {
        if (id !== undefined && !ids.has(id)) broken.push(`${file}: #${id}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
