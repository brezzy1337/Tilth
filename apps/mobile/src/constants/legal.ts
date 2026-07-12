/**
 * legal — URLs and contact info surfaced from Settings > About (F-051).
 *
 * Single source of truth so every screen that needs a ToS/privacy link (or
 * support contact) points at the same place instead of hardcoding a string
 * inline.
 *
 * IMPORTANT: these pages do NOT exist yet as of F-051. `TERMS_OF_SERVICE_URL`
 * and `PRIVACY_POLICY_URL` must resolve to real, published pages before this
 * app is submitted to the App Store / Play Store — both stores require a
 * reachable privacy policy (and, practically, terms) at review time.
 */

export const TERMS_OF_SERVICE_URL = "https://tilth.market/terms";
export const PRIVACY_POLICY_URL = "https://tilth.market/privacy";

/** mailto: target for "Contact support" — no support ticketing system yet, just email. */
export const SUPPORT_EMAIL = "support@tilth.market";

/** Required attribution for map/place data sourced from OpenStreetMap (F-048, ODbL). */
export const OSM_ATTRIBUTION = "Map data © OpenStreetMap contributors";
