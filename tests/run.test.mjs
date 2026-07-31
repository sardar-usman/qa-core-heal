import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * 0.2.0 run-first mode primitives: failure classification (locator vs not),
 * selector extraction from Playwright error messages, consent parsing with
 * re-prompt, and failure-URL extraction from a trace zip.
 */

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { stripAnsi, classifyFailure, parseConsent, traceFailureUrl, collectTests, parseJsonReport } = await import(
  path.join(repoRoot, 'dist', 'run.js')
);
const { selectorSignature } = await import(path.join(repoRoot, 'dist', 'heal.js'));

// Real message shapes captured from Playwright 1.60's JSON reporter.
const ACTION_TIMEOUT = "TimeoutError: locator.click: Timeout 2500ms exceeded.\nCall log:\n  - waiting for locator('#confirm-orderr')\n";
const ASSERT_VALUE_MISMATCH = 'Error: \x1b[2mexpect(\x1b[22m\x1b[31mlocator\x1b[39m\x1b[2m).\x1b[22mtoHaveText\x1b[2m(\x1b[22m\x1b[32mexpected\x1b[39m\x1b[2m)\x1b[22m failed\n\nLocator:  locator(\'#status\')\nExpected: "Done"\nReceived: "Ready"\nTimeout:  2500ms\n\nCall log:\n  - Expect "toHaveText" with timeout 2500ms\n  - waiting for locator(\'#status\')\n    9 × locator resolved to <p id="status">Ready</p>\n';
const ASSERT_NOT_FOUND = 'Error: expect(locator).toHaveValue(expected) failed\n\nLocator:  locator(\'#Email_1\')\nExpected string: "a@b.dev"\nReceived: <element(s) not found>\nTimeout:  2500ms\n\nCall log:\n  - waiting for locator(\'#Email_1\')\n';
const STRICT_VIOLATION = "Error: locator.click: Error: strict mode violation: locator('.ico-cart') resolved to 2 elements:\n    1) <a href=\"/cart\">…</a>\n    2) <a href=\"/cart\">…</a>\n";
const NAV_ERROR = 'Error: page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:9/\nCall log:\n  - navigating to "http://127.0.0.1:9/", waiting until "load"\n';
const APP_THROW = "Error: boom\n    at tests/a.spec.ts:7:9\n";
const GETBY_TIMEOUT = "TimeoutError: locator.fill: Timeout 2500ms exceeded.\nCall log:\n  - waiting for getByRole('textbox', { name: 'Ema_il_2' })\n";

test('stripAnsi removes color escapes', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[39m plain'), 'red plain');
});

test('action timeout on a missing element is a locator failure with its selector', () => {
  const c = classifyFailure(ACTION_TIMEOUT);
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('#confirm-orderr')");
});

test('assertion value mismatch on a FOUND element is not a locator failure', () => {
  const c = classifyFailure(ASSERT_VALUE_MISMATCH);
  assert.equal(c.kind, 'other');
});

test('assertion timeout on a MISSING element is a locator failure', () => {
  const c = classifyFailure(ASSERT_NOT_FOUND);
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('#Email_1')");
});

test('strict mode violation is a locator failure and carries the strict flag', () => {
  const c = classifyFailure(STRICT_VIOLATION);
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('.ico-cart')");
  // 0.2.1 ITEM 7: strict evidence must survive classification so the probe
  // knows a multi-match is the FAILURE, not an intact locator.
  assert.equal(c.strict, true);
});

test('non-strict locator failures do not carry the strict flag', () => {
  assert.notEqual(classifyFailure(ACTION_TIMEOUT).strict, true);
  assert.notEqual(classifyFailure(ASSERT_NOT_FOUND).strict, true);
});

test('navigation and app errors are not locator failures', () => {
  assert.equal(classifyFailure(NAV_ERROR).kind, 'other');
  assert.equal(classifyFailure(APP_THROW).kind, 'other');
});

test('getBy-style selectors extract with their options intact', () => {
  const c = classifyFailure(GETBY_TIMEOUT);
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "getByRole('textbox', { name: 'Ema_il_2' })");
  assert.notEqual(c.chained, true);
});

// 0.3.1: chained locators. Matching just the chain's BASE would probe the
// wrong thing and report a false intact while the test stays red.
test('a chained locator extracts as the full chain and carries the chained flag', () => {
  const c = classifyFailure("TimeoutError: locator.click: Timeout 2500ms exceeded.\nCall log:\n  - waiting for locator('#country').locator('optionx').first()\n");
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('#country').locator('optionx').first()");
  assert.equal(c.chained, true);
});

test('positional wrappers alone are NOT chains — the base stays matchable', () => {
  const c = classifyFailure("TimeoutError: locator.click: Timeout 2500ms exceeded.\nCall log:\n  - waiting for locator('#one-of-many').first()\n");
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('#one-of-many')");
  assert.notEqual(c.chained, true);
});

// 0.3.2 field bug: .and()/.or() combinators were not in the chain-link
// set, so the chain truncated to its base — for .and() a HEALTHY base
// that matched the source literal and probed intact: "1 intact · 0
// healed", exit 0, all tests red. The exact false-clean-bill trap the
// chain fix exists to close.
test('an .and() combinator is a chain link — full chain text, chained flag (the field shape)', () => {
  const c = classifyFailure("TimeoutError: locator.click: Timeout 2500ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Button', exact: true }).and(locator('.btnprimary-zz'))\n");
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "getByRole('button', { name: 'Button', exact: true }).and(locator('.btnprimary-zz'))");
  assert.equal(c.chained, true);
});

test('an .or() combinator is a chain link — never probe just the first arm', () => {
  const c = classifyFailure("TimeoutError: locator.click: Timeout 2500ms exceeded.\nCall log:\n  - waiting for locator('.btnprimary-zz').or(getByLabel('Nope'))\n");
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('.btnprimary-zz').or(getByLabel('Nope'))");
  assert.equal(c.chained, true);
});

// Empirical (Playwright 1.60): frame chains render as
// .locator(sel).contentFrame().locator(...) — .frameLocator() itself is
// normalized to that form and never appears. Matching the iframe base
// would be the same false-intact trap.
test('a .contentFrame() frame chain is a chain — the iframe base is not the target', () => {
  const c = classifyFailure("TimeoutError: locator.click: Timeout 2500ms exceeded.\nCall log:\n  - waiting for locator('#fr').contentFrame().locator('.btnprimary-zz')\n");
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('#fr').contentFrame().locator('.btnprimary-zz')");
  assert.equal(c.chained, true);
});

// Empirical: .describe() is dropped from renderings entirely (the message
// shows the bare base). If a future Playwright ever rendered it, it is a
// pass-through like the positional wrappers: same selector, not a chain.
test('.describe() is a pass-through, never a chain link', () => {
  const c = classifyFailure("TimeoutError: locator.click: Timeout 2500ms exceeded.\nCall log:\n  - waiting for locator('.btnprimary-zz').describe('primary button')\n");
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('.btnprimary-zz')");
  assert.notEqual(c.chained, true);
});

test('selector matching is structural, not textual', () => {
  // The real-project bug: source AST style vs Playwright's error rendering.
  assert.equal(
    selectorSignature('getByRole("textbox", {"name":"Emails"})'),
    selectorSignature("getByRole('textbox', { name: 'Emails' })"),
  );
  assert.notEqual(
    selectorSignature("getByRole('textbox', { name: 'Emails' })"),
    selectorSignature("getByRole('textbox', { name: 'Email' })"),
  );
  // exact: true is part of the identity.
  assert.equal(
    selectorSignature('getByRole("button", {"name":"Go","exact":true})'),
    selectorSignature("getByRole('button', { name: 'Go', exact: true })"),
  );
  assert.notEqual(
    selectorSignature("getByRole('button', { name: 'Go', exact: true })"),
    selectorSignature("getByRole('button', { name: 'Go' })"),
  );
  // Quote style never matters; method always does.
  assert.equal(selectorSignature('locator("#x")'), selectorSignature("locator('#x')"));
  assert.notEqual(selectorSignature("getByLabel('Q')"), selectorSignature("getByText('Q')"));
  assert.equal(selectorSignature('not a selector'), null);
});

// 0.2.1 ITEM 6: the canonical structure must cover ALL getByRole options,
// insensitive to property order, quote style, and boolean representation.
test('getByRole signatures cover every option property, order-insensitively', () => {
  const sig = selectorSignature;
  // Property order never matters.
  assert.equal(
    sig("getByRole('button', { exact: true, name: 'Go' })"),
    sig('getByRole("button", {"name":"Go","exact":true})'),
  );
  // Multi-option objects, reordered and re-quoted.
  assert.equal(
    sig("getByRole('button', { name: 'Go', pressed: true, exact: true })"),
    sig('getByRole("button", {"exact":true,"pressed":true,"name":"Go"})'),
  );
  // checked:false is MEANINGFUL (an unchecked checkbox), never dropped.
  assert.notEqual(sig("getByRole('checkbox', { checked: false })"), sig("getByRole('checkbox')"));
  assert.notEqual(
    sig("getByRole('checkbox', { checked: true })"),
    sig("getByRole('checkbox', { checked: false })"),
  );
  // exact:false IS the default: canonically equal to leaving it out.
  assert.equal(
    sig("getByRole('button', { name: 'Go', exact: false })"),
    sig("getByRole('button', { name: 'Go' })"),
  );
  // level is part of the identity.
  assert.equal(sig("getByRole('heading', { level: 2 })"), sig('getByRole("heading", {"level":2})'));
  assert.notEqual(sig("getByRole('heading', { level: 2 })"), sig("getByRole('heading', { level: 3 })"));
  // The real-world 0.2.1 shape matches itself across renderings.
  assert.equal(
    sig("getByRole('link', { name: 'Button Triggering AJAX Request', exact: true })"),
    sig('getByRole("link", {\n      name: "Button Triggering AJAX Request",\n      exact: true,\n    })'),
  );
});

test('collectTests extracts failure locations from error.location and the stack', () => {
  const report = {
    suites: [{
      specs: [{
        title: 'fills the login email',
        ok: false,
        file: 'login.spec.ts',
        tests: [{
          results: [{
            status: 'failed',
            error: {
              message: 'TimeoutError: locator.fill: Timeout 2500ms exceeded.',
              location: { file: '/proj/tests/login.spec.ts', line: 7, column: 30 },
              stack: [
                'TimeoutError: locator.fill: Timeout 2500ms exceeded.',
                '    at LoginPage.fillEmail (/proj/pages/login.ts:12:34)',
                '    at /proj/tests/login.spec.ts:7:30',
                '    at run (node:internal/foo:1:1)',
              ].join('\n'),
            },
            attachments: [],
          }],
        }],
      }],
    }],
  };
  const [t] = collectTests(report);
  assert.deepEqual(t.locations, [
    { file: '/proj/tests/login.spec.ts', line: 7 },
    { file: '/proj/pages/login.ts', line: 12 },
  ]);
});

// 0.3.0: pointer interception. The target RESOLVED and is actionable —
// the locator is healthy — but another element sits on top of it. Real
// shape captured from Playwright 1.60.
const INTERCEPT_TIMEOUT = 'TimeoutError: locator.click: Timeout 1500ms exceeded.\nCall log:\n  - waiting for locator(\'#pay-now\')\n    - locator resolved to <button id="pay-now" type="button">Pay now</button>\n  - attempting click action\n    2 × waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <div class="promo-overlay"></div> intercepts pointer events\n    - retrying click action\n    - waiting 20ms\n    2 × waiting for element to be visible, enabled and stable\n      - element is visible, enabled and stable\n      - scrolling into view if needed\n      - done scrolling\n      - <div class="promo-overlay"></div> intercepts pointer events\n    - retrying click action\n      - waiting 500ms\n';

test('a pointer-interception timeout is non-locator with the UX-defect verdict', () => {
  const c = classifyFailure(INTERCEPT_TIMEOUT);
  assert.equal(c.kind, 'other');
  assert.equal(
    c.summary,
    'not a locator problem: another element (<div class="promo-overlay"></div>) is '
    + 'intercepting pointer events on the target. The selector is fine; this may be '
    + 'a real defect - an overlay blocking users.',
  );
});

test('interception without a namable interceptor still gets the verdict, no parens', () => {
  const c = classifyFailure('TimeoutError: locator.click: Timeout 1500ms exceeded.\nCall log:\n  - waiting for locator(\'#x\')\n    - locator resolved to <button id="x">Go</button>\n  - attempting click action\n      - intercepts pointer events\n');
  assert.equal(c.kind, 'other');
  assert.match(c.summary, /^not a locator problem: another element is intercepting pointer events/);
});

// GAP 1: evidence-based classification. Real second-repo shape: the wait
// consumed the TEST timeout, teardown closed the browser, and the pending
// action died with a "closed" message — the locator evidence lives in the
// call log of a secondary error, not the top-level message.
const TIMEOUT_CLOSED = [
  'Test timeout of 30000ms exceeded.',
  'Error: locator.fill: Target page, context or browser has been closed',
  'Call log:',
  "  - waiting for locator('[name=\"search_field_1\"]')",
  '    at pages/Accounts/accountDetailsPO.ts:257',
].join('\n');

test('a timed-out action on a closed page is still a locator failure', () => {
  const c = classifyFailure(TIMEOUT_CLOSED);
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('[name=\"search_field_1\"]')");
});

test('a locator./expect. action prefix is locator evidence regardless of the top message', () => {
  const c = classifyFailure('Test timeout of 5000ms exceeded.\nError: expect.toBeVisible: Target closed');
  assert.equal(c.kind, 'locator');
});

test('a bare test timeout with no locator evidence gets the specific wording', () => {
  const c = classifyFailure('Test timeout of 30000ms exceeded.');
  assert.equal(c.kind, 'other');
  assert.equal(c.summary, 'timed out with no pending locator action');
});

test('collectTests joins evidence from ALL errors of a result', () => {
  const report = {
    suites: [{
      specs: [{
        title: 'sets the quantity before the deadline',
        ok: false,
        file: 'timeout-shape.spec.ts',
        tests: [{
          results: [{
            status: 'failed',
            error: { message: 'Test timeout of 3000ms exceeded.' },
            errors: [
              { message: 'Test timeout of 3000ms exceeded.' },
              {
                message: "Error: locator.fill: Test timeout of 3000ms exceeded.\nCall log:\n  - waiting for locator('#quantiy')",
                location: { file: '/proj/tests/timeout-shape.spec.ts', line: 12, column: 34 },
              },
            ],
            attachments: [],
          }],
        }],
      }],
    }],
  };
  const [t] = collectTests(report);
  // The joined message carries the call-log evidence...
  const c = classifyFailure(t.message);
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('#quantiy')");
  // ...and the secondary error's location is captured.
  assert.deepEqual(t.locations, [{ file: '/proj/tests/timeout-shape.spec.ts', line: 12 }]);
});

// 0.2.1 ITEM 1: count/existence matchers failing because ZERO elements
// matched are locator evidence — nothing matched, which is the definition
// of a broken locator. Real shapes captured from Playwright 1.60.
const COUNT_ZERO = 'Error: expect(locator).toHaveCount(expected) failed\n\nLocator:  locator(\'buttons.btn.btn-primary\')\nExpected: 1\nReceived: 0\nTimeout:  1500ms\n\nCall log:\n  - Expect "toHaveCount" with timeout 1500ms\n  - waiting for locator(\'buttons.btn.btn-primary\')\n    16 × locator resolved to 0 elements\n       - unexpected value "0"\n';
const COUNT_TWO = 'Error: expect(locator).toHaveCount(expected) failed\n\nLocator:  locator(\'.info-chip\')\nExpected: 1\nReceived: 2\nTimeout:  1500ms\n\nCall log:\n  - Expect "toHaveCount" with timeout 1500ms\n  - waiting for locator(\'.info-chip\')\n    16 × locator resolved to 2 elements\n       - unexpected value "2"\n';
const VISIBLE_MISSING = 'Error: expect(locator).toBeVisible() failed\n\nLocator: locator(\'#nope\')\nExpected: visible\nTimeout: 1500ms\nError: element(s) not found\n\nCall log:\n  - Expect "toBeVisible" with timeout 1500ms\n  - waiting for locator(\'#nope\')\n';
const ATTACHED_MISSING = 'Error: expect(locator).toBeAttached() failed\n\nLocator: locator(\'#nope\')\nExpected: attached\nTimeout: 1500ms\nError: element(s) not found\n\nCall log:\n  - Expect "toBeAttached" with timeout 1500ms\n  - waiting for locator(\'#nope\')\n';
const INVIEWPORT_MISSING = 'Error: expect(locator).toBeInViewport() failed\n\nLocator: locator(\'#nope\')\nExpected: in viewport\nTimeout: 1500ms\nError: element(s) not found\n\nCall log:\n  - Expect "toBeInViewport" with timeout 1500ms\n  - waiting for locator(\'#nope\')\n';
const TEXT_MISMATCH_FOUND = 'Error: expect(locator).toHaveText(expected) failed\n\nLocator:  locator(\'#status\')\nExpected: "Done"\nReceived: "Ready"\nTimeout:  1500ms\n\nCall log:\n  - Expect "toHaveText" with timeout 1500ms\n  - waiting for locator(\'#status\')\n    16 × locator resolved to <p id="status">Ready</p>\n       - unexpected value "Ready"\n';

test('toHaveCount with actual count 0 is a locator failure (nothing matched)', () => {
  const c = classifyFailure(COUNT_ZERO);
  assert.equal(c.kind, 'locator');
  assert.equal(c.selector, "locator('buttons.btn.btn-primary')");
});

test('toHaveCount with actual count > 0 stays non-locator (found some, wrong number)', () => {
  const c = classifyFailure(COUNT_TWO);
  assert.equal(c.kind, 'other');
});

test('existence matchers on a missing element are locator failures', () => {
  for (const msg of [VISIBLE_MISSING, ATTACHED_MISSING, INVIEWPORT_MISSING]) {
    const c = classifyFailure(msg);
    assert.equal(c.kind, 'locator');
    assert.equal(c.selector, "locator('#nope')");
  }
});

test('value matcher mismatch on a FOUND element stays non-locator (regression)', () => {
  assert.equal(classifyFailure(TEXT_MISMATCH_FOUND).kind, 'other');
});

test('parseJsonReport survives config noise containing braces (dotenv tip line)', () => {
  const stdout = "◇ injected env (1) from .env // tip: ⌘ custom filepath { path: '/custom/path/.env' }\n"
    + JSON.stringify({ config: { rootDir: '/proj/tests' }, suites: [] }, null, 2);
  const report = parseJsonReport(stdout);
  assert.ok(report);
  assert.deepEqual(report.suites, []);
  assert.equal(parseJsonReport('no json here at all'), null);
});

test('consent parsing accepts y/Y/yes, rejects n/no/empty, retries otherwise', () => {
  for (const yes of ['y', 'Y', 'yes', 'YES', ' y ']) assert.equal(parseConsent(yes), 'yes');
  for (const no of ['n', 'N', 'no', '']) assert.equal(parseConsent(no), 'no');
  for (const retry of ['ok', 'sure', 'q', '1']) assert.equal(parseConsent(retry), 'retry');
});

/** Build a minimal in-memory zip (stored entries, zeroed CRCs). */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0, 8);                 // method: stored
    local.writeUInt32LE(data.length, 18);      // compressed size
    local.writeUInt32LE(data.length, 22);      // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    const localFull = Buffer.concat([local, nameBuf, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0, 10);              // method
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    locals.push(localFull);
    offset += localFull.length;
  }
  const centralBlob = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlob.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBlob, eocd]);
}

test('traceFailureUrl returns the last MAIN-frame url, never a child iframe', () => {
  // Real shape from a Vercel-hosted app: the last snapshot belongs to the
  // vercel.live feedback iframe; about:blank precedes the first navigation.
  const trace = [
    JSON.stringify({ type: 'frame-snapshot', snapshot: { frameUrl: 'about:blank', isMainFrame: true } }),
    JSON.stringify({ type: 'frame-snapshot', snapshot: { frameUrl: 'http://127.0.0.1:4188/', isMainFrame: true } }),
    JSON.stringify({ type: 'frame-snapshot', snapshot: { frameUrl: 'http://127.0.0.1:4188/details.html', isMainFrame: true } }),
    JSON.stringify({ type: 'log', message: 'noise' }),
    JSON.stringify({ type: 'frame-snapshot', snapshot: { frameUrl: 'https://vercel.live/_next-live/feedback/feedback.html?dpl=x', isMainFrame: false } }),
  ].join('\n');
  const zip = makeZip([['0-trace.trace', trace], ['test.trace', '{"type":"log"}']]);
  const p = path.join(repoRoot, '.tmp-test-trace.zip');
  fs.writeFileSync(p, zip);
  try {
    assert.equal(traceFailureUrl(p), 'http://127.0.0.1:4188/details.html');
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('traceFailureUrl yields null when only about:blank main-frame snapshots exist', () => {
  const trace = [
    JSON.stringify({ type: 'frame-snapshot', snapshot: { frameUrl: 'about:blank', isMainFrame: true } }),
    JSON.stringify({ type: 'frame-snapshot', snapshot: { frameUrl: 'https://third.example/w.html', isMainFrame: false } }),
  ].join('\n');
  const zip = makeZip([['0-trace.trace', trace]]);
  const p = path.join(repoRoot, '.tmp-test-trace2.zip');
  fs.writeFileSync(p, zip);
  try {
    assert.equal(traceFailureUrl(p), null);
  } finally {
    fs.rmSync(p, { force: true });
  }
});

test('traceFailureUrl tolerates a missing or unreadable zip', () => {
  assert.equal(traceFailureUrl(path.join(repoRoot, 'does-not-exist.zip')), null);
});
