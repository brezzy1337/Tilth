/**
 * Public per-post garden share page — F-053.
 *
 * Mounted at `GET /garden/{postId}` in `request-listener.ts`, following the
 * same DI shape as the Stripe/Mux webhook handlers (`opts` carries `db`, the
 * only real dependency — no env, no SDKs). UNLIKE `/legal/*` (statically
 * rendered once at module load from static `packages/shared` content), this
 * handler hits the DB on every request — it renders a single dynamic garden
 * post, keyed by the `postId` path segment.
 *
 * Renders a small, self-contained HTML page with Open Graph / Twitter Card
 * metadata (so sharing a link to iMessage/Slack/Twitter/etc. shows a rich
 * preview), the post's photos or video thumbnail inline, the stall (store)
 * name, caption, and a plain-text "Get Tilth" footer. No JS video player in
 * v1 — a video post shows the Mux thumbnail plus a "Watch in the Tilth app"
 * note.
 *
 * Visibility: reuses `garden.ts`'s `fetchGardenPostForShare`, which applies
 * the SAME predicate as `garden.feed`/`toggleLike`/comments (status='ready',
 * owner not deactivated) — a "processing"/"errored" post or one owned by a
 * deactivated seller 404s here exactly like a nonexistent postId.
 *
 * Every interpolated string (caption, store name) is escaped via
 * `legal-html.ts`'s `escapeHtml` — imported, never duplicated — defensively,
 * even though the fields come from our own DB: this is a public,
 * unauthenticated page, and captions are free-text user-generated content.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Db } from "./context";
import { escapeHtml } from "./legal-html";
import { fetchGardenPostForShare, type GardenSharePost } from "./routers/garden";

/** `og:description` / `twitter:description` are truncated to this length. */
const OG_DESCRIPTION_MAX_CHARS = 200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Mux thumbnail image URL for a video post's poster frame (used as og:image + inline preview). */
function muxThumbnailUrl(playbackId: string): string {
  return `https://image.mux.com/${playbackId}/thumbnail.jpg`;
}

// ---------------------------------------------------------------------------
// Pure rendering — no I/O, unit-testable in isolation from the DB fetch.
// ---------------------------------------------------------------------------

/** Renders the OG-tagged share page for a visible garden post. */
export function renderGardenShareHtml(post: GardenSharePost): string {
  const title = escapeHtml(`${post.storeName} on Tilth`);
  const storeName = escapeHtml(post.storeName);
  const caption = escapeHtml(post.caption);
  const description = escapeHtml(truncate(post.caption, OG_DESCRIPTION_MAX_CHARS));

  const ogImage =
    post.type === "photo_set"
      ? (post.photos[0]?.url ?? null)
      : post.muxPlaybackId
        ? muxThumbnailUrl(post.muxPlaybackId)
        : null;

  const mediaHtml =
    post.type === "photo_set"
      ? post.photos
          .map(
            (photo) =>
              `<img src="${escapeHtml(photo.url)}" alt="${caption || storeName}" style="max-width:100%;height:auto;border-radius:8px;margin-bottom:0.75rem;" />`,
          )
          .join("\n")
      : post.muxPlaybackId
        ? `<img src="${escapeHtml(muxThumbnailUrl(post.muxPlaybackId))}" alt="${caption || storeName}" style="max-width:100%;height:auto;border-radius:8px;margin-bottom:0.75rem;" />
<p class="video-note">🎥 Watch in the Tilth app</p>`
        : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<meta property="og:type" content="website" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}" />\n` : ""}<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
${ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />\n` : ""}<style>
  body {
    margin: 0;
    padding: 2rem 1.25rem 4rem;
    background: #fbfaf7;
    color: #2a2a26;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    line-height: 1.6;
  }
  main {
    max-width: 32rem;
    margin: 0 auto;
  }
  h1 {
    font-size: 1.4rem;
    margin-bottom: 0.25rem;
  }
  .caption {
    margin: 0 0 1rem;
  }
  .video-note {
    color: #6b6b62;
    font-size: 0.9rem;
  }
  .footer {
    margin-top: 2.5rem;
    padding-top: 1rem;
    border-top: 1px solid #e4e1d8;
    color: #6b6b62;
    font-size: 0.9rem;
  }
</style>
</head>
<body>
<main>
<h1>${storeName}</h1>
${mediaHtml}
<p class="caption">${caption}</p>
<p class="footer">🌱 Get Tilth — Coming soon to the App Store</p>
</main>
</body>
</html>
`;
}

/** Renders a minimal 404 page for a missing/invisible post id. */
export function renderGardenShareNotFoundHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Post not found — Tilth</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 2rem 1.25rem; background: #fbfaf7; color: #2a2a26;">
<main style="max-width: 32rem; margin: 0 auto;">
<h1>Post not found</h1>
<p>This garden post doesn't exist, or is no longer available.</p>
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// HTTP-level handler — DB fetch + response, DI'd via opts.db (mirrors the
// webhook handlers' opts shape; see request-listener.ts).
// ---------------------------------------------------------------------------

const postIdSchema = z.string().uuid();

export interface GardenShareRequestOpts {
  db: Db;
  postId: string;
}

/**
 * Handle `GET /garden/{postId}`. Never throws — a malformed postId or a
 * missing/invisible post both resolve to a 404 HTML page; a lookup error
 * resolves to a 500 (so an upstream retry/observability tool sees a proper
 * status rather than a hung connection).
 */
export function handleGardenShareRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: GardenShareRequestOpts,
): void {
  void (async () => {
    try {
      const parsedId = postIdSchema.safeParse(opts.postId);
      if (!parsedId.success) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderGardenShareNotFoundHtml());
        return;
      }

      const post = await fetchGardenPostForShare(opts.db, parsedId.data);
      if (!post) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderGardenShareNotFoundHtml());
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      });
      res.end(renderGardenShareHtml(post));
    } catch (err) {
      console.error(
        "[garden-share] request failed",
        err instanceof Error ? err.message : String(err),
      );
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    }
  })();
}
