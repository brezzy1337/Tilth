/**
 * Mux video API client — server-only, plain `fetch` (NO Mux SDK, per F-047 brief).
 *
 * This file is the ONLY place in the router tree's dependency graph that talks
 * to the Mux HTTP API. Routers interact with Mux through the `MuxClient`
 * interface defined in `context.ts`, so they stay fetch/Buffer-free and
 * mobile-typecheck-safe (mirrors `stripe.ts` / `gcs.ts`).
 *
 * Never log the token secret. Never expose it in error messages.
 */

import type { MuxClient } from "./context";

const MUX_UPLOADS_URL = "https://api.mux.com/video/v1/uploads";

interface MuxCreateUploadResponse {
  data: {
    id: string;
    url: string;
  };
}

/**
 * Build a concrete `MuxClient` authenticated with HTTP Basic auth
 * (tokenId:tokenSecret), matching Mux's REST API convention.
 *
 * @param tokenId     - Mux access token id (from env, never hardcoded).
 * @param tokenSecret - Mux access token secret (from env, never hardcoded, never logged).
 */
export function createMuxClient(tokenId: string, tokenSecret: string): MuxClient {
  const basicAuth = Buffer.from(`${tokenId}:${tokenSecret}`).toString("base64");

  return {
    async createUpload(input) {
      const response = await fetch(MUX_UPLOADS_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          new_asset_settings: {
            playback_policy: ["public"],
            passthrough: input.passthrough,
          },
          cors_origin: "*",
        }),
      });

      if (!response.ok) {
        // Never include the auth header / secret in the thrown error.
        throw new Error(`Mux upload creation failed with status ${response.status}`);
      }

      const body = (await response.json()) as MuxCreateUploadResponse;
      return { uploadId: body.data.id, uploadUrl: body.data.url };
    },
  };
}
