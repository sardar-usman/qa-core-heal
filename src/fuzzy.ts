/**
 * Fuzzy identifier matching for typo'd selectors.
 *
 * "#Emai_l" never matches "#Email" through the semantic ladder: its tokens
 * ("Emai", "l") are not words the page knows. But normalized to bare
 * lowercase alphanumerics the two identifiers are an edit apart, and that
 * is measurable. This module scores candidate identifiers (ids, name
 * attributes, accessible-name sources) against the broken one by
 * edit-distance ratio.
 *
 * Fuzzy sits BELOW exact and suffix-stripped matching: it only runs after
 * both have failed, and its verdicts stay refusal-first —
 *   exactly one candidate at or above the heal threshold  → heal candidate
 *     (still subject to the kind guard and same-element confirmation)
 *   two or more candidates in the band                     → ambiguous
 *   best candidate below the threshold but above the floor → near-miss,
 *     named in the refusal so the user sees what was considered
 *   nothing above the floor                                → none
 */

import { stripAutoSuffixes } from './routes.js';

/** Similarity at or above this heals (tuned against the eval harness). */
export const FUZZY_HEAL_THRESHOLD = 0.8;
/** Similarity at or above this is worth naming in a refusal. */
export const FUZZY_NEAR_MISS_FLOOR = 0.5;
/** Normalized tokens shorter than this only match exactly (too little signal). */
const MIN_FUZZY_LENGTH = 4;

/** Lowercase alphanumerics only: "Emai_l" → "email", "Email:" → "email". */
export function normalizeIdentifier(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Render-random identifiers carry NO identity: React useId patterns
 * (":r1a:", "_r_17_-form-item") and values whose every word is a bare
 * number or hash. They contribute nothing to matching, and naming one as
 * a "closest candidate" is noise — it changes every render.
 */
export function isGeneratedIdentifier(v: string): boolean {
  if (/^[_:]?r[_:]?(?=[0-9a-z]*\d)[0-9a-z]+[_:.-]/i.test(v)) return true;
  const words = v.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return true;
  const generated = (w: string): boolean => /^\d+$/.test(w) || (/^[0-9a-f]{4,}$/i.test(w) && /\d/.test(w));
  return words.every(generated);
}

/** Word tokens of an identifier: separators and camelCase split, glued
 *  trailing digits detached ("search1" → ["search", "1"]). */
function wordTokens(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .flatMap((w) => {
      const m = w.match(/^([a-z]{3,})(\d+)$/);
      return m ? [m[1]!, m[2]!] : [w];
    });
}

const GENERATED_WORD = (w: string): boolean => /^\d+$/.test(w) || (/^[0-9a-f]{4,}$/i.test(w) && /\d/.test(w));

/** Attribute kinds whose values ARE human identity (accessible names). */
const NAME_ISH = new Set(['aria-label', 'label', 'placeholder', 'text']);

/** Strong-match score for token containment: above the fuzzy band, below exact. */
const CONTAINMENT_SCORE = 0.9;

/** Prefix completion ("search_f" → "search_field"): above the fuzzy band,
 *  below token containment — a strong signal, weaker than whole-word identity. */
const PREFIX_SCORE = 0.85;
/** Normalized prefixes shorter than this carry too little signal. */
const MIN_PREFIX_LENGTH = 4;

/**
 * Token containment: the stripped identifier's words appearing as a
 * CONTIGUOUS whole-word run of the candidate value. "search1" (stripped to
 * "search") is a whole word of the accessible name "Search by account or
 * login" — a strong match even though whole-string edit distance is poor.
 * For id/name/testid values the identifier must also cover at least half
 * of the value's non-generated words: "result" inside
 * "newsletter-result-block" is NOT identity, "search" inside
 * "search-accounts" is.
 */
function containmentScore(sourceTokens: string[], value: string, attr: string | undefined): number {
  if (sourceTokens.length === 0) return 0;
  const vt = wordTokens(value);
  let found = false;
  for (let i = 0; !found && i + sourceTokens.length <= vt.length; i++) {
    found = sourceTokens.every((t, j) => vt[i + j] === t);
  }
  if (!found) return 0;
  if (attr !== undefined && NAME_ISH.has(attr)) return CONTAINMENT_SCORE;
  const meaningful = vt.filter((w) => !GENERATED_WORD(w));
  return sourceTokens.length >= Math.ceil(meaningful.length / 2) ? CONTAINMENT_SCORE : 0;
}

/**
 * Optimal-string-alignment edit distance: substitutions, insertions,
 * deletions, and adjacent transpositions each count one. Transpositions
 * matter because "emial" for "email" is THE canonical typo.
 */
function osaDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i]![0] = i;
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[m]![n]!;
}

/** Edit-distance ratio in [0, 1] over the normalized forms. */
export function similarity(a: string, b: string): number {
  const na = normalizeIdentifier(a);
  const nb = normalizeIdentifier(b);
  if (na === nb) return na.length === 0 ? 0 : 1;
  const max = Math.max(na.length, nb.length);
  if (max === 0) return 0;
  return 1 - osaDistance(na, nb) / max;
}

export interface FuzzyCandidate {
  /** How the element is shown in messages: "#id", '[name="..."]', or the value. */
  display: string;
  /** Identifier strings the element carries (id, name, aria-label, label text...). */
  values: string[];
  /** value -> attribute kind it came from (id, name, aria-label, label, text...). */
  attrOf?: Record<string, string>;
}

export type FuzzyVerdict =
  | { kind: 'match'; candidate: FuzzyCandidate; value: string; score: number }
  | { kind: 'ambiguous'; displays: string[] }
  | { kind: 'near-miss'; closest: Array<{ display: string; score: number }> }
  | { kind: 'none' };

/**
 * Score every candidate's best value against the broken identifier and
 * apply the band rules above. Short tokens (normalized length < 4) carry
 * too little signal for edit distance: they match only at similarity 1
 * (i.e. differing in case/separators alone) and never near-miss.
 *
 * Per value, the score is the better of whole-string edit distance and
 * token containment; render-random values (React useId ids, hashes) score
 * ZERO and are excluded from near-miss naming unless nothing else exists.
 */
export function matchFuzzy(source: string, candidates: FuzzyCandidate[]): FuzzyVerdict {
  const shortToken = normalizeIdentifier(source).length < MIN_FUZZY_LENGTH;
  const sourceTokens = shortToken
    ? []
    : wordTokens(stripAutoSuffixes(humanizeIdentifier(source)) ?? source).filter((w) => !GENERATED_WORD(w));
  // Prefix completion, token-anchored: every word of the identifier
  // except the last must EQUAL the candidate's corresponding word, and
  // the last — the truncated fragment — must be a proper prefix of the
  // candidate's word in that position, nothing left over
  // ("search_f" → "search_field"). A single-word identifier gets no
  // prefix signal: "email" completing to "emailz9" is the hash-suffix
  // trap, not a truncation.
  const prefixScore = (v: string): number => {
    if (sourceTokens.length < 2 || sourceTokens.join('').length < MIN_PREFIX_LENGTH) return 0;
    const vt = wordTokens(v);
    if (vt.length !== sourceTokens.length) return 0;
    for (let i = 0; i < sourceTokens.length - 1; i++) {
      if (vt[i] !== sourceTokens[i]) return 0;
    }
    const frag = sourceTokens[sourceTokens.length - 1]!;
    const target = vt[vt.length - 1]!;
    return target.length > frag.length && target.startsWith(frag) ? PREFIX_SCORE : 0;
  };
  const scored: Array<{ candidate: FuzzyCandidate; value: string; score: number }> = [];
  const generatedOnly: Array<{ candidate: FuzzyCandidate; value: string; score: number }> = [];
  for (const c of candidates) {
    let best: { value: string; score: number } | null = null;
    let bestGenerated: { value: string; score: number } | null = null;
    for (const v of c.values) {
      if (isGeneratedIdentifier(v)) {
        const g = similarity(source, v);
        if (!bestGenerated || g > bestGenerated.score) bestGenerated = { value: v, score: g };
        continue;
      }
      const s = Math.max(similarity(source, v), containmentScore(sourceTokens, v, c.attrOf?.[v]), prefixScore(v));
      if (!best || s > best.score) best = { value: v, score: s };
    }
    if (best) scored.push({ candidate: c, value: best.value, score: best.score });
    else if (bestGenerated) generatedOnly.push({ candidate: c, value: bestGenerated.value, score: bestGenerated.score });
  }
  const bar = shortToken ? 1 : FUZZY_HEAL_THRESHOLD;
  const band = scored.filter((s) => s.score >= bar);
  if (band.length === 1) {
    const m = band[0]!;
    return { kind: 'match', candidate: m.candidate, value: m.value, score: m.score };
  }
  if (band.length > 1) {
    // Exact stripped-identifier equality on an identity attribute (id /
    // name / data-testid) outranks token containment: "content" IS
    // #content and only a sub-token of #footer-content — that is not a
    // tie. Two candidates BOTH exact-equal after stripping remain a
    // genuine tie, refused with exactly those named.
    const IDENTITY_ATTRS = new Set(['id', 'name', 'data-testid', 'data-test']);
    const exactForms = new Set([normalizeIdentifier(source)]);
    const strippedSource = stripAutoSuffixes(humanizeIdentifier(source));
    if (strippedSource) exactForms.add(normalizeIdentifier(strippedSource));
    const exact = band.filter((s) => {
      const attr = s.candidate.attrOf?.[s.value];
      return attr !== undefined && IDENTITY_ATTRS.has(attr)
        && exactForms.has(normalizeIdentifier(s.value));
    });
    if (exact.length === 1) {
      const m = exact[0]!;
      return { kind: 'match', candidate: m.candidate, value: m.value, score: m.score };
    }
    const pool = exact.length > 1 ? exact : band;
    return { kind: 'ambiguous', displays: pool.map((m) => m.candidate.display) };
  }
  if (!shortToken) {
    const top = (list: typeof scored): Array<{ display: string; score: number }> =>
      list.filter((s) => s.score >= FUZZY_NEAR_MISS_FLOOR)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map((s) => ({ display: s.candidate.display, score: s.score }));
    const closest = top(scored);
    if (closest.length > 0) return { kind: 'near-miss', closest };
    // Only render-random ids came close: name them as a last resort, so
    // the refusal is at least debuggable.
    const generatedClosest = top(generatedOnly);
    if (generatedClosest.length > 0) return { kind: 'near-miss', closest: generatedClosest };
  }
  return { kind: 'none' };
}

/** "search_field-1" → "search field 1", so word-level stripping applies. */
function humanizeIdentifier(s: string): string {
  return s.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
}
