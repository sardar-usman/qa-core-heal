import type { SeleniumQuote } from './parse.js';

/** https://www.selenium.dev/documentation/webdriver/elements/locators/ */
export function emitBy(strategy: 'id' | 'name' | 'css' | 'linkText' | 'xpath', value: string, quote: SeleniumQuote): string {
  return `By.${strategy}(${quote}${escape(value, quote)}${quote})`;
}

function escape(value: string, quote: SeleniumQuote): string {
  return value.replace(/\\/g, '\\\\').replaceAll(quote, `\\${quote}`);
}
