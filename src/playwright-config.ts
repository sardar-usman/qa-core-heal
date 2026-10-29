/**
 * Re-export. Playwright config loading lives in the Playwright adapter.
 */
export {
  findPlaywrightConfig,
  supportsTypeStripping,
  needsStripFlag,
  typeStrippingGateMessage,
  HOOK_URL,
  resolvePlaywrightConfig,
  resolvePlaywrightBaseUrl,
  type PlaywrightConfigResolution,
} from './adapters/playwright-js/config.js';
