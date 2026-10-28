import type { CypressQuote } from './parse.js';

export function quoteValue(value: string, quote: CypressQuote): string {
  if (quote === '`') return `\`${value.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``;
  const escaped = value.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

export function emitGet(selector: string, quote: CypressQuote): string {
  return `cy.get(${quoteValue(selector, quote)})`;
}

export function emitContains(selector: string, text: string, quote: CypressQuote): string {
  const body = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `cy.contains(${quoteValue(selector, quote)}, /^\\s*${body}\\s*$/)`;
}

export function emitRole(role: string, name: string, quote: CypressQuote): string {
  return `cy.getByRole(${quoteValue(role, quote)}, { name: ${quoteValue(name, quote)} })`;
}
