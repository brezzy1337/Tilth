/**
 * Shared HTML page shell for every publicly served HTML page in this
 * service: the legal docs (`legal-html.ts`) and the garden share page + its
 * 404 (`garden-share-html.ts`). Pulls the doctype/viewport-meta/base
 * body+main CSS that all three previously duplicated into ONE place.
 *
 * `title`/`extraHead`/`bodyHtml` are all injected VERBATIM — callers are
 * responsible for escaping anything user-derived (via `legal-html.ts`'s
 * `escapeHtml`) before passing it in. This module has no knowledge of where
 * its inputs came from and does no escaping itself.
 */

export interface HtmlPageShellOptions {
  /** Placed verbatim in `<title>`. */
  title: string;
  /**
   * Extra raw HTML injected into `<head>`, after the base meta tags and
   * before the shared `<style>` block (e.g. OG/Twitter meta tags, or a
   * second `<style>` block with page-specific rules — order doesn't matter
   * since the shared and page-specific selectors never collide).
   */
  extraHead?: string;
  /** Raw HTML injected inside `<main>`. */
  bodyHtml: string;
  /** `<main>`'s max-width (a CSS length, e.g. `"42rem"`). Defaults to `"32rem"`. */
  maxWidth?: string;
  /** `<body>`'s font-family. Defaults to the system sans-serif stack. */
  fontFamily?: string;
}

const DEFAULT_MAX_WIDTH = "32rem";
const DEFAULT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/**
 * Renders the shared self-contained HTML page shell (doctype, viewport meta,
 * base body/main CSS) used by all publicly served HTML pages in this
 * service.
 */
export function renderHtmlPageShell(opts: HtmlPageShellOptions): string {
  const maxWidth = opts.maxWidth ?? DEFAULT_MAX_WIDTH;
  const fontFamily = opts.fontFamily ?? DEFAULT_FONT_FAMILY;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${opts.title}</title>
${opts.extraHead ?? ""}<style>
  body {
    margin: 0;
    padding: 2rem 1.25rem 4rem;
    background: #fbfaf7;
    color: #2a2a26;
    font-family: ${fontFamily};
    line-height: 1.6;
  }
  main {
    max-width: ${maxWidth};
    margin: 0 auto;
  }
</style>
</head>
<body>
<main>
${opts.bodyHtml}
</main>
</body>
</html>
`;
}

/**
 * `X-Content-Type-Options: nosniff` on every response this service serves
 * outside of tRPC (legal pages, garden share page, and their 404/405
 * responses) — these are the only handlers that hand-write `res.writeHead`
 * headers themselves (the tRPC adapter sets its own).
 */
export const NOSNIFF_HEADERS = { "X-Content-Type-Options": "nosniff" } as const;
