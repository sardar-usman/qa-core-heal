/**
 * Keep the quote style of the line a heal rewrites.
 *
 * The emitter builds calls with JSON.stringify, which always uses double
 * quotes. A line that was written with single quotes or backticks should
 * stay that way. Only the quotes change. The call text is otherwise the
 * same.
 */

/** The quote of the first string literal in a source span. Double quotes when the span has none. */
export function quoteStyleOf(raw: string): '"' | "'" | '`' {
  const m = raw.match(/['"`]/);
  if (m?.[0] === "'" || m?.[0] === '`') return m[0];
  return '"';
}

function escapeFor(value: string, quote: "'" | '`'): string {
  let out = '';
  for (const c of value) {
    if (c === '\\' || c === quote) out += `\\${c}`;
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else out += c;
  }
  if (quote === '`') out = out.replace(/\$\{/g, '\\${');
  return out;
}

/**
 * Rewrite the double-quoted string literals in an emitted call so they use
 * the quote style of `originalRaw`. A double-quoted original is unchanged.
 */
export function applyQuoteStyle(emitted: string, originalRaw: string): string {
  const style = quoteStyleOf(originalRaw);
  if (style === '"') return emitted;
  let out = '';
  for (let i = 0; i < emitted.length; i++) {
    if (emitted[i] !== '"') { out += emitted[i]; continue; }
    let j = i + 1;
    let raw = '';
    while (j < emitted.length) {
      const c = emitted[j]!;
      if (c === '\\') { raw += c + (emitted[j + 1] ?? ''); j += 2; continue; }
      if (c === '"') break;
      raw += c;
      j++;
    }
    let value: string;
    try { value = JSON.parse(`"${raw}"`) as string; }
    catch { out += emitted.slice(i, Math.min(emitted.length, j + 1)); i = j; continue; }
    out += style + escapeFor(value, style) + style;
    i = j;
  }
  return out;
}
