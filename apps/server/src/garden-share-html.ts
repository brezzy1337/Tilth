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
 *
 * The page shell (doctype/viewport meta/base body+main CSS) is
 * `html-shell.ts`'s `renderHtmlPageShell`, shared with the legal pages
 * (`legal-html.ts`) — only the share-page-specific CSS/content live here.
 *
 * `handleGardenShareRequest`'s DB hit sits behind a small in-process TTL
 * cache (`fetchGardenPostForShareCached`, below) — see its doc comment for
 * the single-instance/pilot-scale rationale.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Db } from "./context";
import { escapeHtml } from "./legal-html";
import { renderHtmlPageShell, NOSNIFF_HEADERS } from "./html-shell";
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

  const extraHead = `<meta property="og:type" content="website" />
<meta property="og:title" content="${title}" />
<meta property="og:description" content="${description}" />
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}" />\n` : ""}<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${title}" />
<meta name="twitter:description" content="${description}" />
${ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />\n` : ""}<style>
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
`;

  const bodyHtml = `<h1>${storeName}</h1>
${mediaHtml}
<p class="caption">${caption}</p>
<p class="footer">🌱 Get Tilth — Coming soon to the App Store</p>`;

  return renderHtmlPageShell({ title, extraHead, bodyHtml });
}

/** Renders a minimal 404 page for a missing/invisible post id. */
export function renderGardenShareNotFoundHtml(): string {
  return renderHtmlPageShell({
    title: "Post not found — Tilth",
    bodyHtml: `<h1>Post not found</h1>
<p>This garden post doesn't exist, or is no longer available.</p>`,
  });
}

// ---------------------------------------------------------------------------
// In-process TTL cache in front of the share page's DB hit — postId-keyed,
// bounded, negative-caching. Single-instance/pilot-scale rationale: this
// service runs a handful of Cloud Run instances at most for the pilot, so a
// per-instance in-memory cache (no Redis / extra infra) is good enough to
// absorb an unauthenticated hammering loop on one popular (or one broken/
// scanning-for-ids) share link — most repeat requests hit memory instead of
// Postgres. A 404 (missing/invisible post) is cached too: that's exactly the
// case an abusive loop produces, and it's cheap to negative-cache since the
// DB round-trip already ran once. Bounded to CACHE_MAX_ENTRIES with FIFO
// eviction — a `Map` preserves insertion order, so its first key is always
// the oldest entry.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

interface ShareCacheEntry {
  value: GardenSharePost | null;
  expiresAt: number;
}

const sharePostCache = new Map<string, ShareCacheEntry>();

/** Clears the module-level share cache. Exported for test isolation only. */
export function resetGardenShareCacheForTest(): void {
  sharePostCache.clear();
}

/** Cache-then-DB fetch wrapping `fetchGardenPostForShare` — see the cache section doc comment above. */
async function fetchGardenPostForShareCached(
  db: Db,
  postId: string,
): Promise<GardenSharePost | null> {
  const cached = sharePostCache.get(postId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const value = await fetchGardenPostForShare(db, postId);

  if (sharePostCache.size >= CACHE_MAX_ENTRIES && !sharePostCache.has(postId)) {
    const oldestKey = sharePostCache.keys().next().value;
    if (oldestKey !== undefined) sharePostCache.delete(oldestKey);
  }
  sharePostCache.set(postId, { value, expiresAt: Date.now() + CACHE_TTL_MS });

  return value;
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
 * status rather than a hung connection). Every response carries
 * `X-Content-Type-Options: nosniff` (`html-shell.ts`'s `NOSNIFF_HEADERS`).
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
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", ...NOSNIFF_HEADERS });
        res.end(renderGardenShareNotFoundHtml());
        return;
      }

      const post = await fetchGardenPostForShareCached(opts.db, parsedId.data);
      if (!post) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", ...NOSNIFF_HEADERS });
        res.end(renderGardenShareNotFoundHtml());
        return;
      }

      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        ...NOSNIFF_HEADERS,
      });
      res.end(renderGardenShareHtml(post));
    } catch (err) {
      console.error(
        "[garden-share] request failed",
        err instanceof Error ? err.message : String(err),
      );
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8", ...NOSNIFF_HEADERS });
      res.end("Internal Server Error");
    }
  })();
}
