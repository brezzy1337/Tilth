/**
 * Unit tests for garden-share-html.ts's pure rendering functions
 * (`renderGardenShareHtml` / `renderGardenShareNotFoundHtml`).
 *
 * The DB-backed `handleGardenShareRequest` path (postId validation, 404 on a
 * missing/invisible post, 405 on non-GET, 200 with real DB content) is
 * covered by garden.share.integration.test.ts (guarded on TEST_DATABASE_URL) —
 * mirrors the legal-html.ts (pure) / index.routing.test.ts (HTTP) split.
 */

import { describe, it, expect } from "vitest";
import { renderGardenShareHtml, renderGardenShareNotFoundHtml } from "./garden-share-html";
import type { GardenSharePost } from "./routers/garden";

const photoSetPost: GardenSharePost = {
  id: "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33",
  storeName: "Sunny Acres Farm",
  caption: "Fresh heirloom tomatoes, picked this morning!",
  type: "photo_set",
  photos: [
    { url: "https://storage.googleapis.com/bucket/tomatoes.jpg" },
    { url: "https://storage.googleapis.com/bucket/basket.jpg" },
  ],
  muxPlaybackId: null,
  durationS: null,
  createdAt: "2026-07-14T00:00:00.000Z",
};

const videoPost: GardenSharePost = {
  id: "c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44",
  storeName: "Green Thumb Gardens",
  caption: "A quick tour of the greenhouse.",
  type: "video",
  photos: [],
  muxPlaybackId: "playback_abc123",
  durationS: 42,
  createdAt: "2026-07-14T00:00:00.000Z",
};

describe("renderGardenShareHtml — photo_set post", () => {
  const html = renderGardenShareHtml(photoSetPost);

  it("includes the title, og:title, and twitter:title as '{storeName} on Tilth'", () => {
    expect(html).toContain("<title>Sunny Acres Farm on Tilth</title>");
    expect(html).toContain('<meta property="og:title" content="Sunny Acres Farm on Tilth" />');
    expect(html).toContain('<meta name="twitter:title" content="Sunny Acres Farm on Tilth" />');
  });

  it("includes og:description / twitter:description with the caption", () => {
    expect(html).toContain(
      '<meta property="og:description" content="Fresh heirloom tomatoes, picked this morning!" />',
    );
    expect(html).toContain(
      '<meta name="twitter:description" content="Fresh heirloom tomatoes, picked this morning!" />',
    );
  });

  it("uses the first photo as og:image / twitter:image", () => {
    expect(html).toContain(
      '<meta property="og:image" content="https://storage.googleapis.com/bucket/tomatoes.jpg" />',
    );
    expect(html).toContain(
      '<meta name="twitter:image" content="https://storage.googleapis.com/bucket/tomatoes.jpg" />',
    );
  });

  it("uses twitter:card summary_large_image", () => {
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
  });

  it("renders every photo inline as an <img> with max-width:100%", () => {
    expect(html).toContain('src="https://storage.googleapis.com/bucket/tomatoes.jpg"');
    expect(html).toContain('src="https://storage.googleapis.com/bucket/basket.jpg"');
    expect(html.match(/<img /g)?.length).toBe(2);
    expect(html).toContain("max-width:100%");
  });

  it("shows the stall name, caption, and 'Get Tilth' footer with the App Store copy", () => {
    expect(html).toContain("<h1>Sunny Acres Farm</h1>");
    expect(html).toContain("Fresh heirloom tomatoes, picked this morning!");
    expect(html).toContain("Get Tilth");
    expect(html).toContain("Coming soon to the App Store");
  });

  it("does not show the video-only 'Watch in the app' note", () => {
    expect(html).not.toContain("Watch in the Tilth app");
  });
});

describe("renderGardenShareHtml — video post", () => {
  const html = renderGardenShareHtml(videoPost);

  it("uses the Mux thumbnail.jpg URL as og:image / inline preview", () => {
    expect(html).toContain(
      '<meta property="og:image" content="https://image.mux.com/playback_abc123/thumbnail.jpg" />',
    );
    expect(html).toContain('src="https://image.mux.com/playback_abc123/thumbnail.jpg"');
  });

  it('shows a "Watch in the Tilth app" note (no JS player)', () => {
    expect(html).toContain("Watch in the Tilth app");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("<script");
  });
});

describe("renderGardenShareHtml — XSS / escaping", () => {
  it("escapes a <script> tag injected into the caption", () => {
    const malicious: GardenSharePost = {
      ...photoSetPost,
      caption: `<script>alert('xss')</script>`,
    };

    const html = renderGardenShareHtml(malicious);

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
  });

  it("escapes a <script> tag injected into the store name", () => {
    const malicious: GardenSharePost = {
      ...photoSetPost,
      storeName: `<script>alert('store')</script>`,
    };

    const html = renderGardenShareHtml(malicious);

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&#39;store&#39;)&lt;/script&gt;");
  });

  it("truncates a long caption to ~200 chars in og:description/twitter:description (full caption still shown on-page)", () => {
    const longCaption = "x".repeat(300);
    const post: GardenSharePost = { ...photoSetPost, caption: longCaption };

    const html = renderGardenShareHtml(post);

    expect(html).toContain(`${"x".repeat(200)}…`);
    // The full, untruncated caption is still shown in the on-page <p class="caption">.
    expect(html).toContain(longCaption);
  });
});

describe("renderGardenShareNotFoundHtml", () => {
  it("renders a minimal 404 page", () => {
    const html = renderGardenShareNotFoundHtml();
    expect(html).toContain("Post not found");
    expect(html).not.toContain("<script");
  });
});
