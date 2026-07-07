import { resolve } from './selectors.js';
/**
 * Re-resolve a failed selector against the live page using the SAME locator
 * ladder, but by the semantic intent only (the brittle hint that failed is
 * dropped). Polls briefly so a slow element still gets a second chance. Returns
 * the healed locator, or null when the element truly is not there.
 */
export async function healResolve(page, input) {
    const relaxed = { intent: input.intent };
    let r = await resolve(page, relaxed);
    for (let i = 0; i < 3 && !r; i++) {
        await new Promise((res) => setTimeout(res, 200));
        r = await resolve(page, relaxed);
    }
    return r;
}
