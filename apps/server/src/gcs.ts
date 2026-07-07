/**
 * GCS media client wrapper — server-only.
 *
 * This file is the ONLY place in the router tree's dependency graph that
 * imports `@google-cloud/storage`. Routers interact with GCS through the
 * `MediaClient` interface defined in `context.ts`, so they stay SDK-free and
 * mobile-typecheck-safe (mirrors `stripe.ts`).
 *
 * Authenticates via Application Default Credentials (ADC) — never a
 * hardcoded key file or credential. The bucket itself is NOT created here;
 * infra owns bucket provisioning (see F-047 brief). This module only signs
 * upload URLs against a bucket name read from env (`GCS_MEDIA_BUCKET`).
 */

import { Storage } from "@google-cloud/storage";
import type { MediaClient } from "./context";

/** V4 signed upload URLs are valid for 15 minutes. */
const UPLOAD_URL_EXPIRY_MS = 15 * 60 * 1000;

/**
 * Build a concrete `MediaClient` backed by the `@google-cloud/storage` SDK.
 *
 * @param bucketName - GCS bucket name (from env, never hardcoded). The bucket
 *   must already exist — infra provisions it, this module never creates one.
 */
export function createGcsMediaClient(bucketName: string): MediaClient {
  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  return {
    bucket: bucketName,

    async createUploadUrl(input) {
      const [uploadUrl] = await bucket.file(input.key).getSignedUrl({
        version: "v4",
        action: "write",
        expires: Date.now() + UPLOAD_URL_EXPIRY_MS,
        contentType: input.contentType,
      });

      // GCS's standard public object URL — reachable once the client PUTs the
      // file and the object is public (or served via a CDN in front of it).
      const publicUrl = `https://storage.googleapis.com/${bucketName}/${input.key}`;

      return { uploadUrl, publicUrl };
    },
  };
}
