/**
 * Renders a `LegalDocument` (from `@homegrown/shared`) into a small,
 * self-contained HTML page.
 *
 * These pages are served publicly (no auth) at `GET /legal/terms` and
 * `GET /legal/privacy` — see `request-listener.ts` — so that App Store
 * Connect / Play Console metadata can link to real, working URLs. The
 * document content is static (defined in `packages/shared/src/legal.ts`),
 * but every interpolated string is still escaped defensively: nothing here
 * should ever assume "it's static, so it's safe."
 */

import type { LegalDocument } from "@homegrown/shared";

/**
 * Escapes the five HTML-significant characters. Order matters — `&` must be
 * escaped first, otherwise the entities inserted for the other characters
 * would themselves get re-escaped.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderSection(section: LegalDocument["sections"][number]): string {
  const heading = `<h2>${escapeHtml(section.heading)}</h2>`;

  const paragraphs = section.paragraphs
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("\n");

  const bullets =
    section.bullets && section.bullets.length > 0
      ? `<ul>\n${section.bullets
          .map((bullet) => `<li>${escapeHtml(bullet)}</li>`)
          .join("\n")}\n</ul>`
      : "";

  return [heading, paragraphs, bullets].filter(Boolean).join("\n");
}

/** Renders a full `LegalDocument` to a self-contained HTML document (no external assets). */
export function renderLegalHtml(doc: LegalDocument): string {
  const title = escapeHtml(doc.title);
  const lastUpdated = escapeHtml(doc.lastUpdated);
  const sections = doc.sections.map(renderSection).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} — Tilth</title>
<style>
  body {
    margin: 0;
    padding: 2rem 1.25rem 4rem;
    background: #fbfaf7;
    color: #2a2a26;
    font-family: Georgia, "Times New Roman", ui-serif, serif;
    line-height: 1.6;
  }
  main {
    max-width: 42rem;
    margin: 0 auto;
  }
  h1 {
    font-size: 1.75rem;
    margin-bottom: 0.25rem;
  }
  .last-updated {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #6b6b62;
    font-size: 0.9rem;
    margin-top: 0;
    margin-bottom: 2rem;
  }
  h2 {
    font-size: 1.2rem;
    margin-top: 2rem;
    margin-bottom: 0.5rem;
  }
  p {
    margin: 0 0 1rem;
  }
  ul {
    margin: 0 0 1rem;
    padding-left: 1.25rem;
  }
  li {
    margin-bottom: 0.5rem;
  }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p class="last-updated">Last updated: ${lastUpdated}</p>
${sections}
</main>
</body>
</html>
`;
}
