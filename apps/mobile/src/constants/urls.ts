/**
 * urls — public, non-legal URLs the app links out to.
 *
 * `legal.ts` holds the ToS/privacy/support links (F-051/F-052); this file is
 * for everything else so `legal.ts` doesn't become a catch-all for URLs that
 * have nothing to do with legal content.
 */

/**
 * The public OG share page for a garden post (F-053) — server-rendered HTML
 * at `api.tilth.market/garden/{postId}` with OG tags + a rendered
 * photo/thumbnail preview (see `apps/server/src/garden-share-html.ts`).
 * Used as the `url` passed to the native `Share` sheet from the Gardens feed
 * action rail so recipients without the app still see a preview.
 */
export function gardenShareUrl(postId: string): string {
  return `https://api.tilth.market/garden/${postId}`;
}
