/**
 * Unit tests for legal-html.ts — rendering + HTML escaping.
 *
 * The source LegalDocument content is static (packages/shared/src/legal.ts),
 * but renderLegalHtml must still escape everything it interpolates. These
 * tests feed it a document containing a `<script>` tag to prove that.
 */

import { describe, it, expect } from "vitest";
import type { LegalDocument } from "@homegrown/shared";
import { escapeHtml, renderLegalHtml } from "./legal-html";

describe("escapeHtml", () => {
  it("escapes &, <, >, \", and '", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes & before other entities are introduced (no double-escaping)", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("leaves plain text untouched", () => {
    expect(escapeHtml("Tilth is a local food marketplace.")).toBe(
      "Tilth is a local food marketplace.",
    );
  });
});

describe("renderLegalHtml", () => {
  const maliciousDoc: LegalDocument = {
    title: `<script>alert('title')</script>`,
    lastUpdated: `<img src=x onerror=alert(1)>`,
    sections: [
      {
        heading: `<script>alert('heading')</script>`,
        paragraphs: [`Click here" onclick="alert('xss')`, `<script>alert('paragraph')</script>`],
        bullets: [`<script>alert('bullet')</script>`],
      },
    ],
  };

  it("escapes a <script> tag in title/heading/paragraph/bullets — no raw tag reaches the output", () => {
    const html = renderLegalHtml(maliciousDoc);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&#39;title&#39;)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;alert(&#39;heading&#39;)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;alert(&#39;paragraph&#39;)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;alert(&#39;bullet&#39;)&lt;/script&gt;");
  });

  it("escapes lastUpdated and quote characters inside a paragraph", () => {
    const html = renderLegalHtml(maliciousDoc);

    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Click here&quot; onclick=&quot;alert(&#39;xss&#39;)");
  });

  it("renders a well-formed document: title, last-updated, headings, paragraphs, and bullets all present", () => {
    const doc: LegalDocument = {
      title: "Terms of Service",
      lastUpdated: "July 13, 2026",
      sections: [
        { heading: "Section A", paragraphs: ["Paragraph one."] },
        { heading: "Section B", paragraphs: [], bullets: ["Bullet one", "Bullet two"] },
      ],
    };
    const html = renderLegalHtml(doc);

    expect(html).toContain("<title>Terms of Service — Tilth</title>");
    expect(html).toContain("<h1>Terms of Service</h1>");
    expect(html).toContain("Last updated: July 13, 2026");
    expect(html).toContain("<h2>Section A</h2>");
    expect(html).toContain("<p>Paragraph one.</p>");
    expect(html).toContain("<h2>Section B</h2>");
    expect(html).toContain("<li>Bullet one</li>");
    expect(html).toContain("<li>Bullet two</li>");
    expect(html).toContain('<meta charset="utf-8" />');
  });
});
