// Reads the edge case catalog (docs/05-edge-cases.md) so the site renders it instead of copying
// it. The catalog is the specification; this only parses its tables.

export interface EdgeCase {
  readonly id: string;
  readonly situation: string;
  readonly behavior: string;
  /** "—" in the catalog when nothing configures it; empty here. */
  readonly config: string;
  readonly tier: string;
}

export interface EdgeCaseSection {
  readonly title: string;
  readonly cases: EdgeCase[];
}

/** Splits a table row on pipes that are not escaped (`\|` stays inside a cell). */
export function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));
}

export function parseEdgeCases(markdown: string): EdgeCaseSection[] {
  const sections: EdgeCaseSection[] = [];
  let current: EdgeCaseSection | undefined;
  for (const line of markdown.replaceAll("\r\n", "\n").split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading?.[1] !== undefined) {
      current = { title: heading[1].trim(), cases: [] };
      sections.push(current);
      continue;
    }
    if (!/^\| EC-\d+ \|/.test(line)) continue;
    const row = cells(line);
    const [id, situation, behavior, config, tier] = row;
    if (
      current === undefined ||
      row.length !== 5 ||
      id === undefined ||
      situation === undefined ||
      behavior === undefined ||
      config === undefined ||
      tier === undefined
    ) {
      throw new Error(`docs/05-edge-cases.md: cannot read the row "${line.slice(0, 60)}…"`);
    }
    current.cases.push({ id, situation, behavior, config: config === "—" ? "" : config, tier });
  }
  return sections.filter((section) => section.cases.length > 0);
}

const escapeHtml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The inline Markdown the docs use: `code`, **bold** and *emphasis*. A mention of a case (EC-43)
 * becomes a link to it: `ecBase` is "" on the catalog page, the catalog's path elsewhere.
 */
export function inlineMarkdown(text: string, ecBase = ""): string {
  return text
    .split(/(`[^`]*`)/)
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 1
        ? `<code>${escapeHtml(part.slice(1, -1))}</code>`
        : escapeHtml(part)
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/\*([^*]+)\*/g, "<em>$1</em>")
            .replace(/\bEC-(\d+)\b/g, `<a href="${ecBase}#ec-$1">EC-$1</a>`),
    )
    .join("");
}

/** `EC-42` → `ec-42`, the anchor of a case on the catalog page. */
export const anchor = (id: string) => id.toLowerCase();
