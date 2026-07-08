/**
 * Community-places import CLI — F-048. Populates `community_places` (co-ops,
 * health-food stores, farmers markets shown as Home map pins) from
 * OpenStreetMap (Overpass API, keyless) and the USDA local-food directory.
 *
 * HOW IT TALKS TO THE DATABASE — this is an OPERATOR TOOL, run wherever
 * DATABASE_URL is available (local `.env`, or a Cloud SQL proxy/tunnel for
 * prod). It connects DIRECTLY to Postgres via the server's own drizzle
 * client config (`../src/db/parse-database-url`, `../src/db/schema`) — it
 * does NOT go through the HTTP tRPC API (there is no write procedure on the
 * `places` router; `places.nearby` is read-only and public). It intentionally
 * does NOT import `../src/env.ts` (which validates five unrelated runtime
 * secrets — JWT, Stripe, Geocoding, …) — mirrors `src/db/migrate.ts`, which
 * only needs DATABASE_URL.
 *
 * Every DB WRITE lands rows with status='pending'. Devin reviews the
 * imported list (`review`/`approve`/`reject`) before anything is served —
 * `places.nearby` only ever returns status='approved' rows.
 *
 * ATTRIBUTION — OSM data is ODbL-licensed; the mobile Home map shows
 * "© OpenStreetMap contributors" wherever these pins render. Nothing here
 * strips or omits that attribution requirement.
 *
 * USAGE (run from apps/server, or via `pnpm --filter @homegrown/server import-places …`):
 *
 *   pnpm import-places fetch --lat=33.749 --lng=-84.388 --radius-km=20
 *   pnpm import-places commit
 *   pnpm import-places review
 *   pnpm import-places approve --ids=1,2,3      (or --all)
 *   pnpm import-places reject  --ids=4
 *
 *   NOTE: negative numbers must use the `=` form (--lng=-84.388) — Node's
 *   parseArgs treats a bare `-84.388` after `--lng` as ambiguous.
 *
 * `fetch` does NO database writes — it only queries Overpass/USDA, prints a
 * numbered preview, and writes candidates to the gitignored
 * `scripts/.places-import.json`. `commit` is the only command that writes,
 * and it upserts idempotently on (source, source_ref): re-running `fetch` +
 * `commit` after edits refreshes name/address/location/website/hours but
 * NEVER resets an already-reviewed row's status back to 'pending' — a
 * re-import must not silently undo Devin's approve/reject decision. `type`
 * gets the same treatment once a row is 'approved': re-imports keep
 * refreshing `type` for 'pending'/'rejected' rows, but an approved row's
 * `type` is frozen — a re-import must not silently flip a human-vetted
 * classification (e.g. co-op vs. plain supermarket) out from under Devin.
 *
 * USDA — https://www.usdalocalfoodportal.com/api/farmersmarket/ requires a
 * registered `apikey` query param (confirmed live: an unregistered/demo key
 * gets back the JSON string "apikey error", not a 4xx). This CLI reads
 * USDA_API_KEY from the environment; when unset, USDA is skipped with a
 * clear notice and the import proceeds OSM-only — OSM's `amenity=marketplace`
 * tag already covers most farmers markets. The USDA field-name mapping in
 * `mapUsdaRecord` below is written from public API docs but is UNVERIFIED
 * against a real key (none was available while building this); if
 * candidates come back empty for a key known to have matches, check the
 * field names against a live response first.
 *
 * Ways/relations (OSM polygons, e.g. a market square) use their Overpass
 * `out center` centroid rather than a boundary — `community_places.location`
 * is a single Point.
 */

import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql, eq, asc } from "drizzle-orm";
import { communityPlace, communityPlaceType, type CommunityPlaceType } from "@homegrown/shared";
import { dbConnection } from "../src/db/parse-database-url.js";
import * as schema from "../src/db/schema.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OVERPASS_USER_AGENT = "tilth-places-import-cli/1.0 (dev tooling; one-shot)";

const USDA_BASE_URL = "https://www.usdalocalfoodportal.com/api/farmersmarket/";
const USDA_USER_AGENT = "tilth-places-import-cli/1.0 (dev tooling; one-shot)";

/** Only these shop= values are eligible for the co-op heuristic (never a bare "shop=yes"). */
const COOP_ELIGIBLE_SHOP_TYPES = new Set(["supermarket", "greengrocer", "convenience"]);

const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), ".places-import.json");

// ---------------------------------------------------------------------------
// Shared candidate shape — produced by both the OSM and USDA mappers,
// deduped together, written to the candidates file, and committed as-is.
// ---------------------------------------------------------------------------

export interface PlaceCandidate {
  type: CommunityPlaceType;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  website: string | null;
  hoursText: string | null;
  source: "osm" | "usda" | "manual";
  /** OSM: "<node|way|relation>/<id>". USDA: "<listing_id>". */
  sourceRef: string;
}

interface CandidatesFile {
  fetchedAt: string;
  lat: number;
  lng: number;
  radiusKm: number;
  candidates: PlaceCandidate[];
}

// ---------------------------------------------------------------------------
// Overpass — query builder + OSM element → candidate mapping (pure).
// ---------------------------------------------------------------------------

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
  /** Set on runtime failures (timeout/memory) — HTTP stays 200. */
  remark?: string;
}

/**
 * Overpass QL for: shop=health_food, amenity=marketplace, and the co-op
 * heuristic (shop∈{supermarket,greengrocer,convenience} AND (name matches
 * /co-?op/i OR operator:type=cooperative OR cooperative=yes)) within
 * `radiusM` metres of (lat, lng). `out center tags` gives ways/relations a
 * centroid so every result has a single point. Live-verified against
 * overpass-api.de (one smoke call, tiny radius, during development).
 */
/**
 * Parses a `--types=coop,farmers_market` argument into a validated type list.
 * Defaults to all types when the flag is absent. Throws (rather than exiting)
 * on unknown values so the dispatcher can render a proper usage failure and
 * tests can assert the message.
 */
export function parseTypesArg(raw?: string): CommunityPlaceType[] {
  if (raw === undefined || raw.trim() === "") return [...communityPlaceType.options];
  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return [...communityPlaceType.options];
  const seen = new Set<CommunityPlaceType>();
  for (const part of parts) {
    const parsed = communityPlaceType.safeParse(part);
    if (!parsed.success) {
      throw new Error(
        `--types: unknown type "${part}" (valid: ${communityPlaceType.options.join(", ")})`,
      );
    }
    seen.add(parsed.data);
  }
  return [...seen];
}

export function buildOverpassQuery(
  lat: number,
  lng: number,
  radiusM: number,
  types: CommunityPlaceType[] = [...communityPlaceType.options],
): string {
  // Overpass QL rejects exponent notation (e.g. "1e-7"), which is how JS
  // stringifies very-small-magnitude numbers (coords near the equator/prime
  // meridian). Fix to 6 decimal places (~11cm precision, plenty for this
  // radius search) and round the radius to an integer metre count.
  const radius = Math.round(radiusM);
  const latStr = lat.toFixed(6);
  const lngStr = lng.toFixed(6);
  const around = `around:${radius},${latStr},${lngStr}`;
  // Equality-only clauses — NO regex filters in the query at all. Both regex
  // forms proved pathological on the public Overpass instance at metro scale
  // (Twin Cities, 30km): a regex on the shop key can't use the tag index
  // ("Query timed out at line 7"), and even index-assisted, a single
  // case-insensitive name regex took ~28s to return 3 rows while fetching
  // ALL 324 candidate shops plainly took ~4s. So we download the whole
  // supermarket/greengrocer/convenience set for the radius and let the
  // client-side classifier (isCoopSignal — which already implements the
  // co-op name/tag heuristics) pick the co-ops; non-matches are skipped by
  // classifyOsmElement exactly as before.
  const clauses: string[] = [];
  if (types.includes("health_food")) {
    clauses.push(`  node["shop"="health_food"](${around});`, `  way["shop"="health_food"](${around});`);
  }
  if (types.includes("farmers_market")) {
    clauses.push(`  node["amenity"="marketplace"](${around});`, `  way["amenity"="marketplace"](${around});`);
  }
  if (types.includes("coop")) {
    for (const shop of ["supermarket", "greengrocer", "convenience"]) {
      clauses.push(`  node["shop"="${shop}"](${around});`, `  way["shop"="${shop}"](${around});`);
    }
  }
  return `[out:json][timeout:60];
(
${clauses.join("\n")}
);
out center tags;`;
}

/**
 * Word-bounded so "Cooper's Grocery" / "Scoop Ice Cream" (which contain the
 * literal substring "coop") don't false-positive — only a standalone
 * "coop"/"co-op" token matches. Trailing "s" is allowed ("Co-ops", plural)
 * since that's still unambiguously the co-op word, not a substring hit.
 */
const COOP_NAME_RE = /\bco-?ops?\b/i;

/** True when an OSM element's tags satisfy the co-op heuristic (see module header). */
export function isCoopSignal(tags: Record<string, string>): boolean {
  const shop = tags["shop"];
  if (!shop || !COOP_ELIGIBLE_SHOP_TYPES.has(shop)) return false;
  if (tags["name"] && COOP_NAME_RE.test(tags["name"])) return true;
  if (tags["operator:type"] === "cooperative") return true;
  if (tags["cooperative"] === "yes") return true;
  return false;
}

/**
 * Classify an OSM element's tags into a `CommunityPlaceType`, or null if it
 * matches none of the three kinds (shouldn't happen given the Overpass query
 * above is already scoped to these tags, but a hand-edited fixture/response
 * could still slip through). Precedence: an explicit `shop=health_food` tag
 * wins over the co-op heuristic, which wins over `amenity=marketplace`.
 */
export function classifyOsmElement(tags: Record<string, string>): CommunityPlaceType | null {
  if (tags["shop"] === "health_food") return "health_food";
  if (isCoopSignal(tags)) return "coop";
  if (tags["amenity"] === "marketplace") return "farmers_market";
  return null;
}

/** Single-line address from OSM's addr:* tags, or null when none are present. */
export function buildAddress(tags: Record<string, string>): string | null {
  const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
  const cityState = [tags["addr:city"], tags["addr:state"]].filter(Boolean).join(", ");
  const tail = [cityState, tags["addr:postcode"]].filter(Boolean).join(" ");
  const parts = [street, tail].filter(Boolean);
  return parts.length ? parts.join(", ").slice(0, 300) : null;
}

/**
 * Normalizes a raw website value into an absolute https(s) URL string, or
 * null if it can't be parsed as one. OSM `website`/`contact:website` values
 * are frequently missing the scheme (e.g. "coop.example.org").
 */
export function normalizeWebsite(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

/**
 * Maps one Overpass element to a `PlaceCandidate`, or null when it should be
 * skipped: unclassifiable tags, no name, or no resolvable point (a node
 * without lat/lon, or a way/relation without an Overpass `center`).
 */
export function osmElementToCandidate(el: OverpassElement): PlaceCandidate | null {
  const tags = el.tags ?? {};
  const type = classifyOsmElement(tags);
  if (!type) return null;

  const name = tags["name"]?.trim();
  if (!name) return null;

  const lat = el.type === "node" ? el.lat : el.center?.lat;
  const lng = el.type === "node" ? el.lon : el.center?.lon;
  if (typeof lat !== "number" || typeof lng !== "number") return null;

  return {
    type,
    name: name.slice(0, 200),
    lat,
    lng,
    address: buildAddress(tags),
    website: normalizeWebsite(tags["website"] ?? tags["contact:website"]),
    hoursText: tags["opening_hours"] ? tags["opening_hours"].slice(0, 500) : null,
    source: "osm",
    sourceRef: `${el.type}/${el.id}`,
  };
}

async function fetchOverpass(
  lat: number,
  lng: number,
  radiusKm: number,
  types: CommunityPlaceType[],
): Promise<OverpassElement[]> {
  const query = buildOverpassQuery(lat, lng, radiusKm * 1000, types);
  const response = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: { "user-agent": OVERPASS_USER_AGENT },
    body: new URLSearchParams({ data: query }),
  });
  if (!response.ok) {
    throw new Error(`Overpass request failed (HTTP ${response.status})`);
  }
  const body = (await response.json()) as OverpassResponse;
  // Overpass reports runtime failures (timeouts, memory limits) as a `remark`
  // in an HTTP-200 response with whatever partial elements it got — which
  // silently looked like "0 results" before this check. Fail loudly instead:
  // a partial import that reads as complete is worse than no import.
  if (body.remark && /error/i.test(body.remark)) {
    throw new Error(`Overpass runtime failure: ${body.remark}`);
  }
  return body.elements ?? [];
}

// ---------------------------------------------------------------------------
// USDA local-food directory — farmers markets. apikey-gated (see header).
// ---------------------------------------------------------------------------

/**
 * Best-effort shape from public USDA Local Food Portal docs — UNVERIFIED
 * against a live key (see header). Aliases cover the field-name variants
 * seen across USDA's local-food-directory APIs historically.
 */
interface UsdaMarketRecord {
  listing_id?: string | number;
  listing_name?: string;
  marketname?: string;
  location_address?: string;
  location_city?: string;
  location_state?: string;
  location_zipcode?: string;
  location_x?: string | number;
  location_y?: string | number;
  x?: string | number;
  y?: string | number;
  Website?: string;
  website?: string;
  [key: string]: unknown;
}

/** Maps one USDA record to a `PlaceCandidate`, or null when required fields are missing/unparseable. */
export function mapUsdaRecord(record: UsdaMarketRecord): PlaceCandidate | null {
  const name = (record.listing_name ?? record.marketname)?.toString().trim();
  const id = record.listing_id;
  const lat = Number(record.location_y ?? record.y);
  const lng = Number(record.location_x ?? record.x);
  if (!name || id === undefined || id === null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const addressParts = [
    record.location_address,
    record.location_city,
    record.location_state,
    record.location_zipcode,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  return {
    type: "farmers_market",
    name: name.slice(0, 200),
    lat,
    lng,
    address: addressParts.length ? addressParts.join(", ").slice(0, 300) : null,
    website: normalizeWebsite(record.Website ?? record.website),
    // USDA hours fields (Season1Date/Time, …) are too inconsistent to fold
    // into one string with confidence without a live key to inspect — left
    // null; OSM's opening_hours is used when available instead.
    hoursText: null,
    source: "usda",
    sourceRef: `usda:${String(id)}`,
  };
}

/**
 * Fetches USDA farmers markets within `radiusKm` of (lat, lng). Throws on
 * transport failure or an API-level error response (e.g. a bad apikey) —
 * callers should catch and degrade to OSM-only, per the module header.
 */
async function fetchUsda(
  lat: number,
  lng: number,
  radiusKm: number,
  apiKey: string,
): Promise<PlaceCandidate[]> {
  const radiusMiles = Math.max(1, Math.round(radiusKm * 0.621371));
  const url =
    `${USDA_BASE_URL}?apikey=${encodeURIComponent(apiKey)}` +
    `&x=${lng}&y=${lat}&radius=${radiusMiles}`;
  const response = await fetch(url, { headers: { "user-agent": USDA_USER_AGENT } });
  if (!response.ok) {
    throw new Error(`USDA request failed (HTTP ${response.status})`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("USDA API returned a non-JSON response");
  }

  if (!Array.isArray(body)) {
    // Confirmed live: a bad apikey returns the JSON string "apikey error".
    const message = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`USDA API returned an error response: ${message}`);
  }

  const records = body as UsdaMarketRecord[];
  const candidates = records.map(mapUsdaRecord).filter((c): c is PlaceCandidate => c !== null);
  if (candidates.length === 0 && records.length > 0) {
    console.warn(
      `  ⚠ USDA returned ${records.length} record(s) but none mapped cleanly — ` +
        `field names may need re-verifying against a live key (see script header).`,
    );
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// Dedupe — USDA vs OSM farmers-market candidates (pure, in-memory only).
//
// NOT a marketplace geo query: `places.nearby` (routers/places.ts) is the
// only place distance/radius logic touches real users, and it goes through
// PostGIS ST_DWithin/ST_Distance. This haversine helper runs ONCE, offline,
// over two small in-memory JSON candidate lists before either ever reaches
// the database — it never runs against `community_places` rows.
// ---------------------------------------------------------------------------

export function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function namesSimilar(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Drops an OSM farmers_market candidate when a USDA candidate names-match
 * (see `namesSimilar`) and sits within 200m of it — USDA metadata is kept
 * (address/hours tend to be more reliable there for markets). Everything
 * else (non-market OSM candidates, all USDA candidates) passes through.
 */
export function dedupeUsdaOsm(
  osmCandidates: PlaceCandidate[],
  usdaCandidates: PlaceCandidate[],
): PlaceCandidate[] {
  const dropOsmRefs = new Set<string>();
  for (const usda of usdaCandidates) {
    for (const osm of osmCandidates) {
      if (osm.type !== "farmers_market" || dropOsmRefs.has(osm.sourceRef)) continue;
      if (namesSimilar(usda.name, osm.name) && haversineMeters(usda.lat, usda.lng, osm.lat, osm.lng) < 200) {
        dropOsmRefs.add(osm.sourceRef);
      }
    }
  }
  return [...osmCandidates.filter((c) => !dropOsmRefs.has(c.sourceRef)), ...usdaCandidates];
}

// ---------------------------------------------------------------------------
// Candidates file — gitignored `scripts/.places-import.json`.
// ---------------------------------------------------------------------------

function loadCandidatesFile(): CandidatesFile | null {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, "utf8")) as CandidatesFile;
}

function saveCandidatesFile(file: CandidatesFile): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(file, null, 2)}\n`);
}

function printCandidatesTable(candidates: PlaceCandidate[]): void {
  candidates.forEach((c, i) => {
    console.log(
      `${String(i + 1).padStart(3)}. [${c.source.padEnd(6)}] ${c.type.padEnd(15)} ` +
        `${c.name.padEnd(40)} ${c.address ?? "—"}`,
    );
  });
}

// ---------------------------------------------------------------------------
// Database — lazy connection so importing this module (e.g. from a unit
// test) never opens a DB connection or requires DATABASE_URL.
// ---------------------------------------------------------------------------

let pgClient: ReturnType<typeof postgres> | undefined;

function getDb() {
  if (!pgClient) {
    const databaseUrl = process.env["DATABASE_URL"];
    if (!databaseUrl) {
      fail(
        "DATABASE_URL is not set. This CLI talks directly to Postgres (operator tool), " +
          "not the HTTP API — export DATABASE_URL (e.g. from apps/server/.env) first.",
      );
    }
    const conn = dbConnection(databaseUrl);
    pgClient =
      typeof conn === "string"
        ? postgres(conn, { max: 1 })
        : postgres({ ...conn, max: 1 } as postgres.Options<Record<string, postgres.PostgresType>>);
  }
  return drizzle(pgClient, { schema });
}

async function closeDb(): Promise<void> {
  if (pgClient) await pgClient.end();
}

/**
 * Runtime defense-in-depth: `community_places.type`/`.status` are plain text
 * columns (no DB CHECK), and `source: "manual"` candidates are human-edited
 * in the gitignored candidates file — not shaped by `osmElementToCandidate`
 * or `mapUsdaRecord`'s truncation/validation at all. Validated against the
 * SAME shared `communityPlace` schema that `places.nearby` output must
 * satisfy (minus the server-computed `id`/`distanceKm` fields): a candidate
 * that inserts fine (plain text columns accept anything) but violates those
 * bounds — address > 300 chars, an unparseable `website`, hoursText > 500
 * chars — would fail `placesNearbyOutput`'s zod parse for the WHOLE response
 * once approved, not just that row.
 */
const commitableCandidateSchema = communityPlace.omit({ id: true, distanceKm: true });

export function validateCommitableCandidate(
  c: PlaceCandidate,
): { ok: true } | { ok: false; errors: string[] } {
  const result = commitableCandidateSchema.safeParse(c);
  if (result.success) return { ok: true };
  const errors = result.error.issues.map(
    (issue) => `${issue.path.join(".") || "(value)"}: ${issue.message}`,
  );
  return { ok: false, errors };
}

async function getPendingOrdered(db: ReturnType<typeof getDb>) {
  return db
    .select({
      id: schema.communityPlaces.id,
      type: schema.communityPlaces.type,
      name: schema.communityPlaces.name,
      source: schema.communityPlaces.source,
      sourceRef: schema.communityPlaces.sourceRef,
      address: schema.communityPlaces.address,
      createdAt: schema.communityPlaces.createdAt,
    })
    .from(schema.communityPlaces)
    .where(eq(schema.communityPlaces.status, "pending"))
    .orderBy(asc(schema.communityPlaces.createdAt), asc(schema.communityPlaces.id));
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdFetch(
  lat: number,
  lng: number,
  radiusKm: number,
  types: CommunityPlaceType[],
): Promise<void> {
  console.log(
    `Fetching community places within ${radiusKm} km of (${lat}, ${lng}) — types: ${types.join(", ")}…\n`,
  );

  console.log("  querying Overpass (OSM) …");
  const elements = await fetchOverpass(lat, lng, radiusKm, types);
  const osmCandidates = elements
    .map(osmElementToCandidate)
    // Query subsetting already narrows the download; this post-filter is the
    // guarantee (e.g. a health_food-tagged shop that classifies as coop).
    .filter((c): c is PlaceCandidate => c !== null && types.includes(c.type));
  console.log(
    `  Overpass: ${elements.length} element(s) → ${osmCandidates.length} candidate(s) after classification`,
  );

  const usdaKey = process.env["USDA_API_KEY"];
  let usdaCandidates: PlaceCandidate[] = [];
  if (!types.includes("farmers_market")) {
    console.log("  USDA: skipped — farmers_market not in --types.");
  } else if (!usdaKey) {
    console.log(
      "  USDA: skipped — USDA_API_KEY is not set. OSM's amenity=marketplace tag already " +
        "covers most farmers markets; set USDA_API_KEY to also pull the USDA directory.",
    );
  } else {
    try {
      usdaCandidates = await fetchUsda(lat, lng, radiusKm, usdaKey);
      console.log(`  USDA: ${usdaCandidates.length} candidate(s)`);
    } catch (err) {
      console.warn(
        `  ⚠ USDA fetch failed (${err instanceof Error ? err.message : String(err)}) — ` +
          "continuing with OSM only.",
      );
    }
  }

  const merged = dedupeUsdaOsm(osmCandidates, usdaCandidates);
  const droppedDupes = osmCandidates.length + usdaCandidates.length - merged.length;
  if (droppedDupes > 0) {
    console.log(
      `  deduped ${droppedDupes} OSM/USDA overlap(s) (name similarity + <200m) — USDA metadata kept`,
    );
  }

  if (merged.length === 0) {
    console.log("\nNo candidates found. Nothing written.");
    return;
  }

  console.log(`\n${merged.length} candidate(s):\n`);
  printCandidatesTable(merged);

  saveCandidatesFile({ fetchedAt: new Date().toISOString(), lat, lng, radiusKm, candidates: merged });
  console.log(`\nWritten to ${STATE_FILE} — NO database writes yet.`);
  console.log(`Review the list above, then run: pnpm import-places commit`);
}

/**
 * Upserts one already-validated candidate into `community_places`, keyed on
 * (source, source_ref). Extracted from `cmdCommit` so integration tests can
 * exercise the real upsert (in particular the type-preservation-on-approved
 * CASE below) against a live Postgres without going through the CLI's
 * file/env plumbing. Returns undefined only if the DB driver returns no row
 * (shouldn't happen for an insert/upsert).
 */
export async function upsertCandidate(
  db: ReturnType<typeof getDb>,
  c: PlaceCandidate,
): Promise<{ id: string; inserted: boolean } | undefined> {
  const point = sql`ST_SetSRID(ST_MakePoint(${c.lng}, ${c.lat}), 4326)::geography`;
  const [row] = await db
    .insert(schema.communityPlaces)
    .values({
      type: c.type,
      name: c.name,
      location: point,
      address: c.address,
      website: c.website,
      hoursText: c.hoursText,
      source: c.source,
      sourceRef: c.sourceRef,
    })
    .onConflictDoUpdate({
      target: [schema.communityPlaces.source, schema.communityPlaces.sourceRef],
      set: {
        // `type` only refreshes while the row hasn't been human-approved —
        // once Devin approves a classification, a re-import must not
        // silently flip it back (e.g. an upstream OSM tag edit re-tagging
        // a co-op as a plain supermarket). Pending/rejected rows still get
        // the latest classification on every re-import. See module header.
        type: sql`CASE WHEN ${schema.communityPlaces.status} = 'approved' THEN ${schema.communityPlaces.type} ELSE ${c.type} END`,
        name: c.name,
        location: point,
        address: c.address,
        website: c.website,
        hoursText: c.hoursText,
        updatedAt: sql`now()`,
        // status intentionally NOT touched — see module header.
      },
    })
    .returning({ id: schema.communityPlaces.id, inserted: sql<boolean>`(xmax = 0)` });

  return row;
}

async function cmdCommit(): Promise<void> {
  const file = loadCandidatesFile();
  if (!file || file.candidates.length === 0) {
    fail(
      `No candidates at ${STATE_FILE}. Run ` +
        "`pnpm import-places fetch --lat=<n> --lng=<n> --radius-km=<n>` first.",
    );
  }

  const db = getDb();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const c of file.candidates) {
    const validation = validateCommitableCandidate(c);
    if (!validation.ok) {
      console.warn(
        `  ⚠ skipping invalid candidate "${c.name}" (${c.source}:${c.sourceRef}): ` +
          validation.errors.join("; "),
      );
      skipped++;
      continue;
    }

    const row = await upsertCandidate(db, c);
    if (!row) continue;
    if (row.inserted) inserted++;
    else updated++;
  }

  await closeDb();
  console.log(
    `\n✓ committed ${inserted + updated} of ${file.candidates.length} candidate(s): ` +
      `${inserted} inserted (pending), ${updated} updated (status preserved)` +
      (skipped > 0 ? `, ${skipped} skipped (invalid)` : ""),
  );
  console.log(`Run \`pnpm import-places review\` to see what needs approval.`);
}

async function cmdReview(): Promise<void> {
  const db = getDb();
  const pending = await getPendingOrdered(db);
  await closeDb();

  if (pending.length === 0) {
    console.log("No pending places to review.");
    return;
  }

  console.log(
    `${pending.length} pending place(s) — indices below are for this run's ` +
      "approve/reject --ids=; re-run `review` before reusing them if anything else may have changed:\n",
  );
  pending.forEach((p, i) => {
    console.log(
      `${String(i + 1).padStart(3)}. [${p.source.padEnd(6)}] ${p.type.padEnd(15)} ` +
        `${p.name.padEnd(40)} ${p.address ?? "—"}`,
    );
    console.log(`      id=${p.id}  sourceRef=${p.sourceRef}`);
  });
  console.log(`\nApprove: pnpm import-places approve --ids=1,2,3   (or --all)`);
  console.log(`Reject:  pnpm import-places reject --ids=1,2,3`);
}

function parseIndices(idsArg: string): number[] {
  const indices = idsArg
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  if (indices.length === 0 || indices.some((n) => !Number.isInteger(n) || n < 1)) {
    fail(`--ids must be a comma-separated list of positive integers (got "${idsArg}").`);
  }
  return indices;
}

async function cmdReviewDecision(
  status: "approved" | "rejected",
  idsArg: string | undefined,
  all: boolean,
): Promise<void> {
  const verb = status === "approved" ? "approve" : "reject";
  if (!all && !idsArg) fail(`${verb} requires --ids=1,2,3 or --all.`);

  const db = getDb();
  const pending = await getPendingOrdered(db);
  if (pending.length === 0) {
    await closeDb();
    console.log("No pending places to review.");
    return;
  }

  const targets = all ? pending : parseIndices(idsArg!).map((i) => pending[i - 1]);
  if (targets.some((t) => t === undefined)) {
    await closeDb();
    fail(
      `One or more --ids are out of range for the current ${pending.length} pending place(s). ` +
        "Re-run `review` first.",
    );
  }

  for (const t of targets) {
    await db
      .update(schema.communityPlaces)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(schema.communityPlaces.id, t!.id));
  }
  await closeDb();
  console.log(`✓ ${status} ${targets.length} place(s)`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

const USAGE = `Community-places import CLI (F-048) — talks directly to Postgres (operator tool).

Commands:
  fetch --lat=<n> --lng=<n> --radius-km=<n≤80>
        [--types=coop,farmers_market]
                             Query Overpass (OSM) + USDA (if USDA_API_KEY set)
                             for community places; dedupe; print a numbered
                             preview; write candidates to
                             scripts/.places-import.json. NO database writes.
                             --types restricts which kinds are fetched
                             (default: all of coop, farmers_market,
                             health_food). Pilot policy (Devin, 2026-07-09):
                             only markets + co-ops — future buy-side accounts
                             for stall order fulfilment — so pass
                             --types=coop,farmers_market.
  commit                     Upsert scripts/.places-import.json into
                             community_places as 'pending'. Idempotent on
                             (source, source_ref) — re-imports refresh data
                             but never reset an already-reviewed row's status,
                             and never change 'type' once a row is 'approved'.
  review                     List pending rows with ids.
  approve --ids=1,2,3        Flip the given pending rows (by review's
        (or --all)           1-based index) to 'approved'.
  reject  --ids=1,2,3        Flip the given pending rows to 'rejected'.
        (or --all)

Options:
  --radius-km=<n>            Capped at 80 for fetch.
                             Use the = form for negative coords: --lng=-84.388

Env:
  DATABASE_URL               Required — this tool writes directly to Postgres.
  USDA_API_KEY                Optional — omit to skip the USDA directory and
                             import OSM-only (amenity=marketplace covers most
                             farmers markets already).

State: scripts/.places-import.json (gitignored).
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      lat: { type: "string" },
      lng: { type: "string" },
      "radius-km": { type: "string" },
      types: { type: "string" },
      ids: { type: "string" },
      all: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    process.exit(command ? 0 : 1);
  }

  switch (command) {
    case "fetch": {
      const lat = Number(values.lat);
      const lng = Number(values.lng);
      const radiusKm = Number(values["radius-km"]);
      if (
        values.lat === undefined ||
        values.lng === undefined ||
        values["radius-km"] === undefined ||
        isNaN(lat) ||
        isNaN(lng) ||
        isNaN(radiusKm)
      ) {
        fail(
          "fetch requires numeric --lat, --lng, and --radius-km (use --lng=-84.388 for negatives).",
        );
      }
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        fail("--lat must be within ±90 and --lng within ±180.");
      }
      if (radiusKm <= 0 || radiusKm > 80) {
        fail("--radius-km must be > 0 and <= 80.");
      }
      let types: CommunityPlaceType[];
      try {
        types = parseTypesArg(values.types);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
      await cmdFetch(lat, lng, radiusKm, types);
      break;
    }
    case "commit":
      await cmdCommit();
      break;
    case "review":
      await cmdReview();
      break;
    case "approve":
      await cmdReviewDecision("approved", values.ids, values.all === true);
      break;
    case "reject":
      await cmdReviewDecision("rejected", values.ids, values.all === true);
      break;
    default:
      console.log(USAGE);
      fail(`Unknown command "${command}".`);
  }
}

// Only run the CLI when this file is executed directly (`tsx scripts/import-places.ts …`),
// never when a test imports it for the pure helper functions above.
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err: unknown) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
