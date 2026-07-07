# Locator strategy: the resolve cascade

Healing re-finds an element by its semantic intent (the human token the old
locator carried) using one fixed-order cascade, implemented in
`src/selectors.ts` (`resolveInScope`). There is no scoring, no randomness, and
no model call. The first level that matches exactly one element wins. That is
the whole algorithm.

## The cascade, in true order

1. **role, named variants.** The intent is mapped to an ARIA role by a small
   regex table (`ROLE_PATTERNS`): button words (button, submit, sign in, log
   in, continue, next, cancel), checkbox, radio, combobox (select, dropdown),
   link, and textbox (input, field, email, password, username). The guessed
   role is tried first, then a fixed fallback list: link, button, textbox,
   checkbox, combobox. Each role is tried with four name variants, in order:
   exact full name, fuzzy full name, exact shortened name, fuzzy shortened
   name. "Shortened" strips trailing generic words (input, field, button,
   box, dropdown, and so on) so "password input" can match a field whose
   accessible name is just "Password".
2. **role, nameless.** Only for the guessed role, only after every named
   variant failed. Catches elements that have a role but no accessible name,
   like a bare progressbar, or a lone textbox on the page.
3. **label** (`getByLabel`): the explicit label hint exact, then fuzzy, then
   the intent string.
4. **placeholder** (`getByPlaceholder`): label hint, intent, and their
   generic-suffix-stripped forms, each exact then fuzzy.
5. **text** (`getByText`): only the text and label hints, minimum 3
   characters, exact then fuzzy. The intent is deliberately not tried here;
   it gets one last chance at step 9.
6. **alt** (`getByAltText`): label hint, then intent.
7. **title** (`getByTitle`): label hint, then intent.
8. **testid**: `getByTestId` (data-testid), then the common `data-test`
   attribute as a CSS selector.
9. **css**: the explicit CSS hint (XPath is auto-detected by its `//` or `./`
   prefix), then a "smart CSS" fallback built from unambiguous intent
   keywords (password, email, search, phone, url, submit). After that, the
   intent is tried as visible text, at least 4 characters, only when no text
   or label hint exists.
10. **xpath**: an explicit XPath hint, the absolute last resort.

During healing the intent token is the only input (the stale hint that failed
is dropped on purpose), so in practice a heal lands on the role, label,
placeholder, or text levels, in that preference order.

## The unique-match rule

A level claims the element only when its locator resolves to exactly one
match on the live page. Zero matches: the cascade moves on. More than one
match: the candidate is remembered but the cascade still moves on, hoping a
later level resolves uniquely.

## How the ambiguous flag gets set

Only when the entire cascade finishes with no unique match does the resolver
fall back to the remembered multi-match candidates. They are sorted by a
fixed level preference:

    role, label, placeholder, text, alt, title, testid, css, xpath

The best-ranked candidate is taken with `.first()` and marked
`ambiguous: true`. This is the single ranking step in the whole resolver, and
the ranking key is just the position of the level in that list, nothing else.

Healing treats the flag as a stop sign: an ambiguous re-resolution is always
refused, because when several elements match the intent, the resolver cannot
know which one the original locator meant, and a wrong heal is worse than no
heal.

## Frames

The cascade first runs against the top document. Only if nothing resolves
does it enumerate child frames (both `iframe` and frameset `frame`
elements, id or name selectors preferred, positional as fallback) and re-run
the same cascade inside each, nesting up to 3 levels. A hit inside a frame
records the frame selector chain so the emitted locator scopes through
`frameLocator(...)`. A `>>>` piercing selector in a CSS hint is split into a
frame chain plus inner selector and resolved properly; it is never passed
through.

## Why the fixed order makes heal deterministic

Every step above is a pure function of the live DOM and the intent string:
the level order is hardcoded, the role table and fallback list are
hardcoded, the name variants are derived mechanically, the unique-match rule
is a count, and the ambiguity tie-break is a fixed list position. Given the
same page and the same intent, the resolver always walks the same path and
returns the same locator, which is why two consecutive dry runs of the CLI
produce byte-identical output. It also means a heal is explainable after the
fact: the chosen level plus the emitted argument tell you exactly which rung
of the ladder matched.
