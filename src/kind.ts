/**
 * Element-kind guard.
 *
 * A broken selector usually still says what KIND of element it meant:
 * "#register-button" is a button, ".terms-link" is a link, a locator that
 * gets .fill()ed is a text input, one that gets .check()ed is a checkbox.
 * When re-resolution lands on an element whose actual kind conflicts with
 * that expectation, the heal is wrong no matter how well the name matched —
 * the real-world case is a submit button "healed" to a same-named nav link.
 * The guard turns that into a refusal; refusing is correct, guessing is not.
 */

export type ElementKind = 'button' | 'link' | 'textbox' | 'checkbox' | 'radio' | 'combobox';

/** Keyword -> kind, matched against whole word tokens only ("selector" is not "select"). */
const TOKEN_KINDS: Record<string, ElementKind> = {
  button: 'button', btn: 'button', submit: 'button',
  link: 'link', anchor: 'link',
  input: 'textbox', textbox: 'textbox', textarea: 'textbox',
  checkbox: 'checkbox',
  radio: 'radio',
  select: 'combobox', dropdown: 'combobox', combobox: 'combobox',
};

/** ARIA role attribute values the guard understands. */
const ROLE_KINDS: Record<string, ElementKind> = {
  button: 'button',
  link: 'link',
  textbox: 'textbox', searchbox: 'textbox',
  checkbox: 'checkbox',
  radio: 'radio',
  combobox: 'combobox', listbox: 'combobox',
};

/**
 * Kinds implied by the words inside a selector (id, class, attribute values,
 * tag names). Splits on separators and camelCase so "#submitBtn" and
 * "#digest-checkbox-52ba17" both yield their keyword.
 */
export function kindsFromTokens(selectorText: string): ElementKind[] {
  const words = selectorText
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean);
  const out: ElementKind[] = [];
  for (const w of words) {
    const k = TOKEN_KINDS[w.toLowerCase()];
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * Kinds implied by the API chained onto the locator at its call site.
 * .fill() only works on text inputs, .check() on checkables, .selectOption()
 * on selects. .click() implies nothing — anything is clickable.
 */
export function kindsFromTrailingApi(trailing: string): ElementKind[] {
  if (/^\s*\.\s*(fill|pressSequentially)\(/.test(trailing)) return ['textbox'];
  if (/^\s*\.\s*(check|uncheck)\(/.test(trailing)) return ['checkbox', 'radio'];
  if (/^\s*\.\s*selectOption\(/.test(trailing)) return ['combobox'];
  return [];
}

export interface ElementInfo {
  tag: string;
  type: string | null;
  role: string | null;
  href: boolean;
}

/** The candidate element's actual kind; null when it has no clear kind. */
export function kindOfElement(info: ElementInfo): ElementKind | null {
  if (info.role) {
    const k = ROLE_KINDS[info.role.toLowerCase()];
    if (k) return k;
  }
  const tag = info.tag.toLowerCase();
  if (tag === 'a') return info.href ? 'link' : null;
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = (info.type ?? 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'hidden') return null;
    return 'textbox';
  }
  return null;
}

/**
 * True only on a DEFINITE mismatch: something was expected, the candidate's
 * kind is known, and they disagree. No expectation or an unknown candidate
 * kind never conflicts — the guard refuses wrong heals, it does not invent
 * new reasons to block plausible ones.
 */
export function kindConflict(expected: ElementKind[], actual: ElementKind | null): boolean {
  if (expected.length === 0 || actual === null) return false;
  return !expected.includes(actual);
}
