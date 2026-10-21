// Pulls one table or code block out of a section of a design document (docs/04-api-design.md),
// so reference pages render the documented contract instead of a copy of it.
import { cells } from "./edge-cases";

/** The lines of the section under `## heading` (or `### heading`), up to the next heading. */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((l) => /^#{2,3} /.test(l) && l.replace(/^#+ /, "") === heading);
  if (start === -1) throw new Error(`docs: no section "${heading}"`);
  const end = lines.findIndex((l, i) => i > start && /^#{2,3} /.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** The first table of a section: its header and rows, cells as written. */
export function sectionTable(markdown: string, heading: string) {
  const rows = section(markdown, heading).filter((l) => l.startsWith("|"));
  const [header, divider, ...body] = rows;
  if (header === undefined || divider === undefined || body.length === 0) {
    throw new Error(`docs: no table in section "${heading}"`);
  }
  return { header: cells(header), rows: body.map(cells) };
}

/** The first fenced code block of a section, and its language. */
export function sectionCode(markdown: string, heading: string) {
  const lines = section(markdown, heading);
  const start = lines.findIndex((l) => l.startsWith("```"));
  const end = lines.findIndex((l, i) => i > start && l.startsWith("```"));
  if (start === -1 || end === -1) throw new Error(`docs: no code block in section "${heading}"`);
  return {
    lang: lines[start]?.slice(3).trim() || "txt",
    code: lines.slice(start + 1, end).join("\n"),
  };
}
