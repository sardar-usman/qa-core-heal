import type { FrameLocator, Locator, Page } from '@playwright/test';
/**
 * Selector cascade: role (nameless) → role+name → label → placeholder →
 * text → alt → title → testid → CSS → xpath.
 *
 * The agent describes targets in terms of intent ("the email field",
 * "the submit button"). This module resolves that intent to a Locator
 * by trying levels in order of Playwright's recommended robustness.
 *
 * Key invariant: only pass an accessible name to getByRole when the
 * element actually has one. Try getByRole(role) nameless first; this
 * correctly resolves elements like role="progressbar" that have no
 * aria-label or aria-labelledby.
 *
 * Iframes: the cascade runs against a "scope" that is either the top Page
 * or a FrameLocator. If nothing resolves in the main frame, resolve() scans
 * iframes (and nested iframes) and re-runs the SAME cascade inside each frame
 * via page.frameLocator(<iframe>). A hit inside a frame records the chain of
 * iframe selectors on `frameChain` so replay and the emitted spec scope into
 * the frame the same way. Playwright reaches frame content with frameLocator,
 * never a ">>>" piercing selector.
 */
export type CascadeLevel = 'role' | 'label' | 'placeholder' | 'text' | 'alt' | 'title' | 'testid' | 'css' | 'xpath';
/**
 * A cascade scope: the top page or a frame. FrameLocator exposes the same
 * getBy and locator builders as Page, so the cascade body works against either.
 */
export type Scope = Page | FrameLocator;
export interface ResolvedLocator {
    locator: Locator;
    level: CascadeLevel;
    /** The argument used to construct the winning locator, emitted into the spec. */
    arg: string | {
        role: string;
        name?: string;
        exact?: boolean;
    };
    /** True when the cascade had to take `.first()` of multiple matches. */
    ambiguous: boolean;
    /**
     * Chain of iframe selectors (outer→inner) the element lives behind. Empty /
     * undefined means the element is in the top frame. When set, replay and the
     * emitted spec scope in with page.frameLocator(chain[0]).frameLocator(...)
     * before applying the cascade level.
     */
    frameChain?: string[];
}
export interface ResolveSpec {
    intent: string;
    role?: string;
    label?: string;
    testid?: string;
    css?: string;
    /**
     * Assertion text. Forwarded by the assert tool (toHaveText/toContainText)
     * so the cascade has a hint to find elements whose only stable identifier
     * IS their visible copy: error messages, toast notifications, headings.
     * Treated as substring (Playwright `getByText` default).
     */
    text?: string;
    /**
     * Explicit XPath expression (without the `xpath=` prefix). Used as a
     * last-resort hint when nothing else resolves. Also auto-detected when
     * the `css` field starts with `//` or `./`.
     */
    xpath?: string;
}
export declare function stripGenericSuffixes(intent: string): string | null;
/**
 * Public resolver. Tries the top frame first, then iframes.
 *
 * Order:
 *  1. If a ">>>" piercing selector slipped into the css hint, split it into a
 *     frame chain plus the inner selector and resolve the inner inside the
 *     frame (the model sometimes emits "iframe#frame1 >>> #el", which is not
 *     how Playwright reaches frames; we convert it to frameLocator).
 *  2. Resolve in the main frame.
 *  3. If nothing resolved, scan iframes (depth-limited) and run the SAME
 *     cascade inside each frame. The winning frame's selector chain is
 *     recorded on `frameChain`.
 *
 * Frame scanning only runs when the main frame fails, so the common path pays
 * no extra cost.
 */
export declare function resolve(page: Page, spec: ResolveSpec): Promise<ResolvedLocator | null>;
/** Build a FrameLocator by chaining frameLocator() through the selector chain. */
export declare function frameLocatorForChain(page: Page, chain: string[]): FrameLocator;
/**
 * Split a ">>>" piercing selector into a frame-selector chain plus the inner
 * element selector. "iframe#a >>> iframe#b >>> #el" → { frameChain:
 * ['iframe#a','iframe#b'], innerCss: '#el' }. Returns null when there is no
 * ">>>" (the normal case). Playwright does not support ">>>" for frames; this
 * converts the model's mistake into a real frameLocator chain.
 */
export declare function parsePiercingSelector(css?: string): {
    frameChain: string[];
    innerCss: string;
} | null;
/**
 * Strip over-escaped quotes from CSS attribute selectors. Models occasionally
 * emit `[data-test=\"foo\"]` when they should emit `[data-test="foo"]`. Only
 * normalises ASCII single + double quotes; everything else is left alone.
 */
export declare function normalizeCssQuotes(css: string): string;
/**
 * Build the root scope expression for the emitted spec. With no frame chain it
 * is just `page`; with a chain it is
 * `page.frameLocator("iframe#a").frameLocator("iframe#b")`.
 */
export declare function frameScopeExpr(frameChain?: string[]): string;
/**
 * Emit a Playwright call expression for the resolved cascade level.
 * When `ambiguous`, the emitter appends `.first()` so the runtime spec
 * survives strict-mode. When `frameChain` is set, the call scopes into the
 * frame first via frameLocator so it works under real `playwright test`.
 */
export declare function emitLocatorCall(level: CascadeLevel, arg: ResolvedLocator['arg'], ambiguous?: boolean, frameChain?: string[]): string;
/** Escape a string for safe use inside a `new RegExp(...)` pattern. */
export declare function escapeRegex(s: string): string;
