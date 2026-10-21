// Cuts a named region out of a snippet file, the way the site shows it: the lines between
// `// #region name` and `// #endregion name`, without other region markers or surrounding blank
// lines, dedented. The site (Snippet.astro) and scripts/check-readme.mjs both import this.

export function region(source: string, name: string): string {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === `// #region ${name}`);
  const end = lines.findIndex((l, i) => i > start && l.trim() === `// #endregion ${name}`);
  if (start === -1 || end === -1) throw new Error(`No region "${name}"`);
  const body = lines.slice(start + 1, end).filter((l) => !/^\s*\/\/ #(end)?region\b/.test(l));
  while (body[0]?.trim() === "") body.shift();
  while (body.at(-1)?.trim() === "") body.pop();
  const indent = Math.min(
    ...body.filter((l) => l.trim() !== "").map((l) => /^ */.exec(l)?.[0].length ?? 0),
  );
  return body.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join("\n");
}

export function regionNames(source: string): string[] {
  return [...source.matchAll(/\/\/ #region ([\w-]+)/g)].map((m) => m[1] as string);
}
