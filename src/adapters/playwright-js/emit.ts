import type { CascadeLevel, ResolvedLocator } from '../../selectors.js';

/**
 * Playwright JS syntax for a resolved cascade level.
 */

/**
 * Build the root scope expression for the emitted spec. With no frame chain it
 * is just `page`; with a chain it is
 * `page.frameLocator("iframe#a").frameLocator("iframe#b")`.
 */
export function frameScopeExpr(frameChain?: string[]): string {
  if (!frameChain || frameChain.length === 0) return 'page';
  return 'page' + frameChain.map((f) => `.frameLocator(${JSON.stringify(f)})`).join('');
}

/**
 * Emit a Playwright call expression for the resolved cascade level.
 * When `ambiguous`, the emitter appends `.first()` so the runtime spec
 * survives strict-mode. When `frameChain` is set, the call scopes into the
 * frame first via frameLocator so it works under real `playwright test`.
 */
export function emitLocatorCall(
  level: CascadeLevel,
  arg: ResolvedLocator['arg'],
  ambiguous = false,
  frameChain?: string[],
): string {
  const tail = ambiguous ? '.first()' : '';
  const root = frameScopeExpr(frameChain);
  switch (level) {
    case 'role': {
      const a = arg as { role: string; name?: string; exact?: boolean };
      if (!a.name) return `${root}.getByRole(${JSON.stringify(a.role)})${tail}`;
      const opts: Record<string, unknown> = { name: a.name };
      if (a.exact) opts.exact = true;
      return `${root}.getByRole(${JSON.stringify(a.role)}, ${JSON.stringify(opts)})${tail}`;
    }
    case 'label': {
      if (typeof arg === 'object' && 'label' in arg) {
        return `${root}.getByLabel(${JSON.stringify(arg.label)}, { exact: true })${tail}`;
      }
      return `${root}.getByLabel(${JSON.stringify(arg as string)})${tail}`;
    }
    case 'placeholder': {
      if (typeof arg === 'object' && 'placeholder' in arg) {
        return `${root}.getByPlaceholder(${JSON.stringify(arg.placeholder)}, { exact: true })${tail}`;
      }
      return `${root}.getByPlaceholder(${JSON.stringify(arg as string)})${tail}`;
    }
    case 'text': {
      // The exact form exists for pages where the text is unique as a
      // whole string but a SUBSTRING of some longer caption: the plain
      // getByText would be ambiguous at runtime (0.3.2 field case).
      if (typeof arg === 'object' && 'text' in arg) {
        return `${root}.getByText(${JSON.stringify(arg.text)}, { exact: true })${tail}`;
      }
      return `${root}.getByText(${JSON.stringify(arg as string)})${tail}`;
    }
    case 'alt':
      return `${root}.getByAltText(${JSON.stringify(arg as string)})${tail}`;
    case 'title': {
      if (typeof arg === 'object' && 'title' in arg) {
        return `${root}.getByTitle(${JSON.stringify(arg.title)}, { exact: true })${tail}`;
      }
      return `${root}.getByTitle(${JSON.stringify(arg as string)})${tail}`;
    }
    case 'testid':
      return `${root}.getByTestId(${JSON.stringify(arg as string)})${tail}`;
    case 'css':
    case 'css-tag-fix':
      return `${root}.locator(${JSON.stringify(arg as string)})${tail}`;
    case 'xpath':
      return `${root}.locator(${JSON.stringify(`xpath=${arg as string}`)})${tail}`;
  }
}

