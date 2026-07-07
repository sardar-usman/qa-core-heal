import { type CascadeLevel } from './selectors.js';
/**
 * Standalone selector healing for an existing Playwright spec.
 *
 * Given a spec whose selectors no longer match the live page, this:
 *
 *   1. Loads the spec and, if it uses POM, the page-object files it imports
 *      (the locators live there, not in the spec).
 *   2. Opens the live page the spec targets (from a page.goto or the page
 *      object's `url`, or an explicit --base-url).
 *   3. Probes every locator against the live page. One that still resolves is
 *      left untouched.
 *   4. A locator that no longer resolves is re-resolved with the SAME locator
 *      ladder and healResolve logic the Explorer uses (semantic intent, a
 *      different stable locator), NOT an LLM guess.
 *   5. Confirms the re-resolved element is the SAME intended element (its
 *      accessible name / text / label still matches the original intent). A
 *      heal to the wrong element is worse than no heal, so an unconfirmed or
 *      ambiguous match is refused.
 *   6. Writes the repaired files back and reports every heal and every locator
 *      it could not heal. An unhealable selector is reported, never silently
 *      left or wrongly changed.
 *
 * This is fully deterministic: no spec run, no model call. It reuses
 * `healResolve` and the cascade from selectors.ts, and `emitLocatorCall` to
 * write the new locator, so there is one locator ladder in the codebase.
 */
export interface HealOptions {
    specPath: string;
    /** Target URL override. When absent, taken from a goto / page-object url in the spec. */
    baseUrl?: string;
    /** Write repaired files to disk. Default true; false previews without writing. */
    write?: boolean;
    /** Accepted for back-compat with older callers; unused (healing is model-free). */
    model?: string;
    onEvent?: (event: HealEvent) => void;
    /** Cap on heals recorded per run; heals beyond the cap are refused. */
    maxHeals?: number;
    /** When set, a heal landing on a cascade level not in this list is refused. */
    allowedLevels?: CascadeLevel[];
    /** Follow relative imports to page objects. Default true. */
    followImports?: boolean;
    /** Extra directories whose .ts/.js files are also scanned for locators. */
    pageObjectDirs?: string[];
    /** Playwright storage state file for authenticated pages. */
    storageState?: string;
}
export type HealEvent = {
    type: 'scanned';
    total: number;
    files: number;
} | {
    type: 'opened_page';
    url: string;
} | {
    type: 'intact';
    selector: string;
} | {
    type: 'healing';
    selector: string;
} | {
    type: 'healed';
    old: string;
    new: string;
    level: CascadeLevel;
    file: string;
} | {
    type: 'unhealed';
    selector: string;
    reason: string;
    file: string;
} | {
    type: 'done';
    healed: number;
    unhealed: number;
    intact: number;
    total: number;
    files: string[];
};
export interface HealDetail {
    file: string;
    line: number;
    old: string;
    new: string;
    level: CascadeLevel;
}
export interface UnhealDetail {
    file: string;
    selector: string;
    reason: string;
}
/** One entry per scanned locator, in scan order. Powers the machine-readable report. */
export interface LocatorReport {
    /** Relative to the working directory, forward slashes. */
    file: string;
    /** 1-indexed source line. */
    line: number;
    old: string;
    /** The proposed replacement call; null unless healed. */
    new: string | null;
    /** Healed: the new locator's cascade level. Otherwise the original locator's. */
    level: CascadeLevel;
    ambiguous: boolean;
    status: 'healed' | 'intact' | 'refused';
    /** Present only when status is refused. */
    reason?: string;
}
export interface HealResult {
    /** The spec path when it (or a POM file) was written; null when nothing changed. */
    healedPath: string | null;
    filesWritten: string[];
    scanned: number;
    intact: number;
    healed: HealDetail[];
    unhealable: UnhealDetail[];
    /** Total locators scanned. Kept for back-compat with `${healed}/${total}` callers. */
    total: number;
    /** One entry per scanned locator, in scan order. */
    locators: LocatorReport[];
}
export declare function heal(opts: HealOptions): Promise<HealResult>;
