/**
 * legal — URLs and contact info surfaced from Settings > About (F-051).
 *
 * Single source of truth so every screen that needs a ToS/privacy link (or
 * support contact) points at the same place instead of hardcoding a string
 * inline.
 *
 * As of F-052, Settings > About's "Terms of Service" / "Privacy Policy" rows
 * push the native `LegalScreen` in-app (see src/screens/LegalScreen.tsx),
 * not these URLs. `TERMS_OF_SERVICE_URL` and `PRIVACY_POLICY_URL` are the
 * public web twins of that same `packages/shared` `LegalDocument` content,
 * server-rendered as HTML at api.tilth.market/legal/{terms,privacy} — kept
 * here for anything that needs a shareable web link (e.g. App Store Connect /
 * Play Console metadata's required privacy-policy URL field).
 */

export const TERMS_OF_SERVICE_URL = "https://api.tilth.market/legal/terms";
export const PRIVACY_POLICY_URL = "https://api.tilth.market/legal/privacy";

/** mailto: target for "Contact support" — no support ticketing system yet, just email. */
export const SUPPORT_EMAIL = "support@tilth.market";

/** Required attribution for map/place data sourced from OpenStreetMap (F-048, ODbL). */
export const OSM_ATTRIBUTION = "Map data © OpenStreetMap contributors";
