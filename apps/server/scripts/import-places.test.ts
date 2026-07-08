/**
 * Unit tests for the import-places CLI's pure OSM→candidate mapping,
 * co-op classification heuristic, and the USDA/OSM dedupe helper.
 *
 * NO network access — fixture Overpass-shaped JSON only. Importing
 * `import-places.ts` here never triggers the CLI (guarded by the
 * `isMainModule` check at the bottom of that file) or a DB connection
 * (the drizzle client is created lazily inside `getDb`, only called from
 * the command handlers).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { migrateForTest } from "../src/db/migrate-for-test";
import * as schema from "../src/db/schema";
import {
  classifyOsmElement,
  isCoopSignal,
  buildAddress,
  normalizeWebsite,
  osmElementToCandidate,
  mapUsdaRecord,
  buildOverpassQuery,
  parseTypesArg,
  namesSimilar,
  normalizeName,
  haversineMeters,
  dedupeUsdaOsm,
  validateCommitableCandidate,
  upsertCandidate,
  commitCandidate,
  sanitizeForDisplay,
  type OverpassElement,
  type PlaceCandidate,
} from "./import-places";

describe("classifyOsmElement", () => {
  it("classifies shop=health_food as health_food", () => {
    expect(classifyOsmElement({ shop: "health_food" })).toBe("health_food");
  });

  it("classifies amenity=marketplace as farmers_market", () => {
    expect(classifyOsmElement({ amenity: "marketplace" })).toBe("farmers_market");
  });

  it("classifies a co-op-named supermarket as coop", () => {
    expect(classifyOsmElement({ shop: "supermarket", name: "Sunflower Co-op" })).toBe("coop");
  });

  it("classifies operator:type=cooperative as coop", () => {
    expect(
      classifyOsmElement({
        shop: "greengrocer",
        name: "Green Grocer",
        "operator:type": "cooperative",
      }),
    ).toBe("coop");
  });

  it("classifies cooperative=yes as coop", () => {
    expect(
      classifyOsmElement({ shop: "convenience", name: "Corner Store", cooperative: "yes" }),
    ).toBe("coop");
  });

  it("does not classify a plain supermarket without any co-op signal", () => {
    expect(classifyOsmElement({ shop: "supermarket", name: "Big Mart" })).toBeNull();
  });

  it("does not classify a co-op-named shop outside the eligible shop types", () => {
    // shop=bakery is not in the co-op-eligible set, even with a co-op-looking name.
    expect(classifyOsmElement({ shop: "bakery", name: "Bread Co-op" })).toBeNull();
  });

  it("returns null for unrelated tags", () => {
    expect(classifyOsmElement({ shop: "clothes", name: "Fashion Store" })).toBeNull();
  });

  it("prefers health_food over a co-op name when both are present", () => {
    expect(classifyOsmElement({ shop: "health_food", name: "Herbal Co-op" })).toBe("health_food");
  });
});

describe("isCoopSignal", () => {
  it("matches 'coop' (no hyphen) case-insensitively", () => {
    expect(isCoopSignal({ shop: "supermarket", name: "COMMUNITY COOP MARKET" })).toBe(true);
  });

  it("matches 'co-op' (hyphenated)", () => {
    expect(isCoopSignal({ shop: "supermarket", name: "Weaver Street Co-op" })).toBe(true);
  });

  it("is false without shop tag", () => {
    expect(isCoopSignal({ name: "Some Co-op", amenity: "marketplace" })).toBe(false);
  });

  it("is false for shop types outside the eligible set", () => {
    expect(isCoopSignal({ shop: "hardware", name: "Tool Co-op" })).toBe(false);
  });

  // Regression: /co-?op/i (no word boundary) false-positived on names that
  // merely CONTAIN "coop" as a substring, not as the standalone word.
  it("does not classify 'Cooper's Grocery' as a co-op (substring, not word)", () => {
    expect(isCoopSignal({ shop: "supermarket", name: "Cooper's Grocery" })).toBe(false);
  });

  it("does not classify 'Scoop Ice Cream' as a co-op (substring, not word)", () => {
    expect(isCoopSignal({ shop: "convenience", name: "Scoop Ice Cream" })).toBe(false);
  });

  it("still matches 'Park Slope Food Coop'", () => {
    expect(isCoopSignal({ shop: "supermarket", name: "Park Slope Food Coop" })).toBe(true);
  });

  it("still matches 'Co-op Market'", () => {
    expect(isCoopSignal({ shop: "supermarket", name: "Co-op Market" })).toBe(true);
  });

  it("still matches 'The Coop'", () => {
    expect(isCoopSignal({ shop: "supermarket", name: "The Coop" })).toBe(true);
  });

  it("matches the plural 'Willy Street Co-ops'", () => {
    expect(isCoopSignal({ shop: "supermarket", name: "Willy Street Co-ops" })).toBe(true);
  });
});

describe("buildAddress", () => {
  it("builds a full address from addr:* tags", () => {
    expect(
      buildAddress({
        "addr:housenumber": "123",
        "addr:street": "Main St",
        "addr:city": "Springfield",
        "addr:state": "IL",
        "addr:postcode": "62701",
      }),
    ).toBe("123 Main St, Springfield, IL 62701");
  });

  it("returns null when no addr:* tags are present", () => {
    expect(buildAddress({ name: "No Address Market" })).toBeNull();
  });

  it("handles a partial address (street only)", () => {
    expect(buildAddress({ "addr:street": "Main St" })).toBe("Main St");
  });
});

describe("normalizeWebsite", () => {
  it("adds https:// to a bare domain", () => {
    expect(normalizeWebsite("coop.example.org")).toBe("https://coop.example.org/");
  });

  it("preserves an existing https:// URL", () => {
    expect(normalizeWebsite("https://coop.example.org/hours")).toBe(
      "https://coop.example.org/hours",
    );
  });

  it("preserves an existing http:// URL", () => {
    expect(normalizeWebsite("http://coop.example.org")).toBe("http://coop.example.org/");
  });

  it("returns null for undefined", () => {
    expect(normalizeWebsite(undefined)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(normalizeWebsite("")).toBeNull();
  });

  it("returns null for an unparseable value", () => {
    expect(normalizeWebsite("not a url at all!!")).toBeNull();
  });
});

describe("osmElementToCandidate", () => {
  const nodeHealthFood: OverpassElement = {
    type: "node",
    id: 111,
    lat: 33.749,
    lon: -84.388,
    tags: {
      shop: "health_food",
      name: "Sunny Herbs & Roots",
      "addr:housenumber": "45",
      "addr:street": "Peachtree St",
      "addr:city": "Atlanta",
      "addr:state": "GA",
      "addr:postcode": "30303",
      website: "sunnyherbs.example.com",
      opening_hours: "Mo-Sa 09:00-18:00",
    },
  };

  const wayMarketplace: OverpassElement = {
    type: "way",
    id: 39448667,
    center: { lat: 33.7539279, lon: -84.3799682 },
    tags: {
      amenity: "marketplace",
      name: "Atlanta Municipal Market",
      building: "retail",
    },
  };

  it("maps a node with tags into a health_food candidate", () => {
    const candidate = osmElementToCandidate(nodeHealthFood);
    expect(candidate).toEqual<PlaceCandidate>({
      type: "health_food",
      name: "Sunny Herbs & Roots",
      lat: 33.749,
      lng: -84.388,
      address: "45 Peachtree St, Atlanta, GA 30303",
      website: "https://sunnyherbs.example.com/",
      hoursText: "Mo-Sa 09:00-18:00",
      source: "osm",
      sourceRef: "node/111",
    });
  });

  it("maps a way using its Overpass `center` as the point (farmers_market)", () => {
    const candidate = osmElementToCandidate(wayMarketplace);
    expect(candidate).toEqual<PlaceCandidate>({
      type: "farmers_market",
      name: "Atlanta Municipal Market",
      lat: 33.7539279,
      lng: -84.3799682,
      address: null,
      website: null,
      hoursText: null,
      source: "osm",
      sourceRef: "way/39448667",
    });
  });

  it("skips an element with no name", () => {
    expect(
      osmElementToCandidate({ type: "node", id: 1, lat: 1, lon: 1, tags: { shop: "health_food" } }),
    ).toBeNull();
  });

  it("skips an element that doesn't classify into any community place type", () => {
    expect(
      osmElementToCandidate({
        type: "node",
        id: 2,
        lat: 1,
        lon: 1,
        tags: { shop: "clothes", name: "Fashion" },
      }),
    ).toBeNull();
  });

  it("skips a way with no Overpass center", () => {
    expect(
      osmElementToCandidate({
        type: "way",
        id: 3,
        tags: { amenity: "marketplace", name: "No Center Market" },
      }),
    ).toBeNull();
  });

  it("truncates an over-long name to 200 chars", () => {
    const longName = "M".repeat(250);
    const candidate = osmElementToCandidate({
      type: "node",
      id: 4,
      lat: 1,
      lon: 1,
      tags: { amenity: "marketplace", name: longName },
    });
    expect(candidate?.name.length).toBe(200);
  });
});

describe("mapUsdaRecord", () => {
  it("maps a well-formed USDA record to a farmers_market candidate", () => {
    const candidate = mapUsdaRecord({
      listing_id: 42,
      listing_name: "Grant Park Farmers Market",
      location_address: "600 Cherokee Ave SE",
      location_city: "Atlanta",
      location_state: "GA",
      location_zipcode: "30312",
      location_x: -84.3699,
      location_y: 33.7412,
      Website: "grantparkmarket.example.org",
    });
    expect(candidate).toEqual<PlaceCandidate>({
      type: "farmers_market",
      name: "Grant Park Farmers Market",
      lat: 33.7412,
      lng: -84.3699,
      address: "600 Cherokee Ave SE, Atlanta, GA, 30312",
      website: "https://grantparkmarket.example.org/",
      hoursText: null,
      source: "usda",
      sourceRef: "usda:42",
    });
  });

  it("returns null when name is missing", () => {
    expect(mapUsdaRecord({ listing_id: 1, location_x: 1, location_y: 1 })).toBeNull();
  });

  it("returns null when the coordinates aren't numeric", () => {
    expect(
      mapUsdaRecord({
        listing_id: 1,
        listing_name: "Bad Coords Market",
        location_x: "n/a",
        location_y: "n/a",
      }),
    ).toBeNull();
  });

  it("returns null when listing_id is missing", () => {
    expect(
      mapUsdaRecord({ listing_name: "No Id Market", location_x: 1, location_y: 1 }),
    ).toBeNull();
  });

  it("accepts string-typed numeric coordinates", () => {
    const candidate = mapUsdaRecord({
      listing_id: "7",
      listing_name: "String Coords Market",
      location_x: "-84.1",
      location_y: "33.1",
    });
    expect(candidate?.lat).toBe(33.1);
    expect(candidate?.lng).toBe(-84.1);
    expect(candidate?.sourceRef).toBe("usda:7");
  });
});

describe("buildOverpassQuery", () => {
  // Regression (Twin Cities, 30km): regex filters in the Overpass query are
  // pathological at metro scale — a shop-key regex can't use the tag index
  // (timeout at line 7), and even a single case-insensitive name regex took
  // ~28s for 3 rows vs ~4s to fetch all 324 candidate shops plainly. The
  // query must be equality-only; co-op selection happens client-side via
  // isCoopSignal.
  it("is equality-only: literal shop values, no regex filters at all", () => {
    const query = buildOverpassQuery(44.9635, -93.1775, 30000);
    expect(query).not.toContain("~");
    expect(query).toContain('"shop"="supermarket"');
    expect(query).toContain('"shop"="greengrocer"');
    expect(query).toContain('"shop"="convenience"');
    expect(query).toContain("[timeout:60]");
  });

  it("includes all three tag families and the given radius/lat/lng", () => {
    const query = buildOverpassQuery(33.749, -84.388, 20000);
    expect(query).toContain('shop"="health_food"');
    expect(query).toContain('amenity"="marketplace"');
    expect(query).toContain('shop"="supermarket"');
    expect(query).toContain("around:20000,33.749000,-84.388000");
    expect(query).toContain("out center tags;");
  });

  // Regression: JS stringifies very-small-magnitude numbers in exponent
  // notation ("1e-7"), which Overpass QL rejects. Coords near the equator
  // or prime meridian must render as fixed-decimal, and the radius as a
  // plain integer.
  it("formats near-zero coordinates as fixed decimals, never exponent notation", () => {
    const query = buildOverpassQuery(1e-7, -1e-7, 20000.7);
    expect(query).toContain("around:20001,0.000000,-0.000000");
    expect(query).not.toMatch(/e-/i);
  });

  it("subsets clauses by types — coop+farmers_market excludes health_food", () => {
    const query = buildOverpassQuery(44.9635, -93.1775, 30000, ["coop", "farmers_market"]);
    expect(query).not.toContain("health_food");
    expect(query).toContain('amenity"="marketplace"');
    expect(query).toContain('"shop"="supermarket"');
  });

  it("subsets clauses by types — farmers_market only has no shop clauses", () => {
    const query = buildOverpassQuery(44.9635, -93.1775, 30000, ["farmers_market"]);
    expect(query).not.toContain('"shop"=');
    expect(query).toContain('amenity"="marketplace"');
  });
});

describe("parseTypesArg", () => {
  it("defaults to all types when absent or empty", () => {
    expect(parseTypesArg(undefined).sort()).toEqual(["coop", "farmers_market", "health_food"]);
    expect(parseTypesArg("  ").sort()).toEqual(["coop", "farmers_market", "health_food"]);
  });

  it("parses and dedupes a comma list", () => {
    expect(parseTypesArg("coop, farmers_market,coop").sort()).toEqual(["coop", "farmers_market"]);
  });

  it("throws on unknown types with the valid list in the message", () => {
    expect(() => parseTypesArg("coop,grocery")).toThrow(/unknown type "grocery".*farmers_market/);
  });
});

describe("USDA/OSM dedupe", () => {
  it("normalizeName strips punctuation/case", () => {
    expect(normalizeName("Grant Park Farmers Market (Saturdays)")).toBe(
      "grant park farmers market saturdays",
    );
  });

  it("namesSimilar matches an exact normalized match", () => {
    expect(namesSimilar("Grant Park Farmers Market", "grant park farmers market")).toBe(true);
  });

  it("namesSimilar matches when one name contains the other", () => {
    expect(namesSimilar("Grant Park Farmers Market", "Grant Park Farmers Market (Saturdays)")).toBe(
      true,
    );
  });

  it("namesSimilar is false for unrelated names", () => {
    expect(namesSimilar("Grant Park Farmers Market", "Sunny Herbs & Roots")).toBe(false);
  });

  it("haversineMeters returns ~0 for identical points and a positive distance otherwise", () => {
    expect(haversineMeters(33.7412, -84.3699, 33.7412, -84.3699)).toBeCloseTo(0, 3);
    // ~111km per degree of latitude at the equator-ish; 0.01 deg ≈ 1.1km
    expect(haversineMeters(33.7412, -84.3699, 33.7512, -84.3699)).toBeGreaterThan(1000);
  });

  it("drops the OSM farmers_market candidate when a USDA one name+distance matches", () => {
    const osm: PlaceCandidate[] = [
      {
        type: "farmers_market",
        name: "Grant Park Farmers Market",
        lat: 33.7412,
        lng: -84.3699,
        address: null,
        website: null,
        hoursText: "Sa 09:00-13:00",
        source: "osm",
        sourceRef: "way/1",
      },
    ];
    const usda: PlaceCandidate[] = [
      {
        type: "farmers_market",
        name: "Grant Park Farmers Market",
        lat: 33.74125, // ~5m away
        lng: -84.36991,
        address: "600 Cherokee Ave SE, Atlanta, GA",
        website: null,
        hoursText: null,
        source: "usda",
        sourceRef: "usda:42",
      },
    ];
    const merged = dedupeUsdaOsm(osm, usda);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.source).toBe("usda");
  });

  it("keeps both when far apart despite a name match", () => {
    const osm: PlaceCandidate[] = [
      {
        type: "farmers_market",
        name: "Community Farmers Market",
        lat: 33.7412,
        lng: -84.3699,
        address: null,
        website: null,
        hoursText: null,
        source: "osm",
        sourceRef: "way/1",
      },
    ];
    const usda: PlaceCandidate[] = [
      {
        type: "farmers_market",
        name: "Community Farmers Market",
        lat: 34.0, // far away — different market with a common name
        lng: -84.0,
        address: null,
        website: null,
        hoursText: null,
        source: "usda",
        sourceRef: "usda:99",
      },
    ];
    expect(dedupeUsdaOsm(osm, usda)).toHaveLength(2);
  });

  it("keeps non-market OSM candidates (coop/health_food) untouched regardless of USDA overlap", () => {
    const osm: PlaceCandidate[] = [
      {
        type: "coop",
        name: "Weaver Street Co-op",
        lat: 33.7412,
        lng: -84.3699,
        address: null,
        website: null,
        hoursText: null,
        source: "osm",
        sourceRef: "node/5",
      },
    ];
    const usda: PlaceCandidate[] = [
      {
        type: "farmers_market",
        name: "Weaver Street Co-op",
        lat: 33.7412,
        lng: -84.3699,
        address: null,
        website: null,
        hoursText: null,
        source: "usda",
        sourceRef: "usda:5",
      },
    ];
    const merged = dedupeUsdaOsm(osm, usda);
    expect(merged).toHaveLength(2);
  });
});

// -----------------------------------------------------------------------
// validateCommitableCandidate — mirrors the shared `communityPlace` schema
// (minus id/distanceKm) so a hand-edited "manual" candidate can never insert
// a row that would later break `placesNearbyOutput`'s zod parse once served.
// -----------------------------------------------------------------------

describe("validateCommitableCandidate", () => {
  const validManualCandidate: PlaceCandidate = {
    type: "coop",
    name: "Neighborhood Co-op",
    lat: 33.75,
    lng: -84.39,
    address: "123 Main St, Atlanta, GA",
    website: "https://example.org",
    hoursText: "Mon-Fri 9am-6pm",
    source: "manual",
    sourceRef: "manual:neighborhood-coop",
  };

  it("accepts a valid manual candidate", () => {
    expect(validateCommitableCandidate(validManualCandidate)).toEqual({ ok: true });
  });

  it("rejects an over-long address (>300 chars) with a clear per-field error", () => {
    const result = validateCommitableCandidate({
      ...validManualCandidate,
      address: "A".repeat(301),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.some((e) => e.startsWith("address"))).toBe(true);
  });

  it("rejects an invalid website URL with a clear per-field error", () => {
    const result = validateCommitableCandidate({
      ...validManualCandidate,
      website: "not a url at all!!",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.some((e) => e.startsWith("website"))).toBe(true);
  });

  it("rejects over-long hoursText (>500 chars) with a clear per-field error", () => {
    const result = validateCommitableCandidate({
      ...validManualCandidate,
      hoursText: "H".repeat(501),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.some((e) => e.startsWith("hoursText"))).toBe(true);
  });

  // Inherited from the shared communityPlace schema's http(s)-scheme refine:
  // a hand-edited manual candidate must not be able to land a javascript:/data:
  // website that the mobile app could later render as a tappable link.
  it("rejects a javascript: URI website on a manual candidate", () => {
    const result = validateCommitableCandidate({
      ...validManualCandidate,
      website: "javascript:alert(1)",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.some((e) => e.startsWith("website"))).toBe(true);
  });

  it("rejects a data: URI website on a manual candidate", () => {
    const result = validateCommitableCandidate({
      ...validManualCandidate,
      website: "data:text/html,<script>alert(1)</script>",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected rejection");
    expect(result.errors.some((e) => e.startsWith("website"))).toBe(true);
  });
});

// -----------------------------------------------------------------------
// sanitizeForDisplay — OSM text is publicly editable; the preview table and
// `review` listing must not pass raw control characters (ANSI escapes,
// cursor movement, screen clears) to the operator's terminal.
// -----------------------------------------------------------------------

describe("sanitizeForDisplay", () => {
  it("strips ANSI escape sequences from a crafted OSM name", () => {
    // ESC (0x1b) is stripped; the now-inert printable remainder stays visible.
    expect(sanitizeForDisplay("Totally \x1b[32mAPPROVED\x1b[0m Market")).toBe(
      "Totally [32mAPPROVED[0m Market",
    );
  });

  it("strips other C0 control chars and DEL", () => {
    expect(sanitizeForDisplay("A\x00B\x07C\rD\nE\x7fF")).toBe("ABCDEF");
  });

  it("leaves ordinary unicode text untouched", () => {
    expect(sanitizeForDisplay("Café Co-op — 100% organic 🧺")).toBe("Café Co-op — 100% organic 🧺");
  });
});

// -----------------------------------------------------------------------
// upsertCandidate — PostGIS integration (F-048 review follow-up).
//
// GUARDED — only runs when TEST_DATABASE_URL is set (mirrors
// places.nearby.integration.test.ts). To run locally:
//
//   docker compose up -d db
//   TEST_DATABASE_URL=postgresql://homegrown:homegrown@localhost:5432/homegrown \
//     pnpm --filter @homegrown/server test scripts/import-places.test.ts
// -----------------------------------------------------------------------

const TEST_DB_URL = process.env["TEST_DATABASE_URL"];
const describeWithDb = TEST_DB_URL ? describe : describe.skip;

describeWithDb("upsertCandidate — type preserved on approved rows (PostGIS integration)", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;
  const seededIds: string[] = [];

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrateForTest(client, db);
  });

  afterAll(async () => {
    for (const id of seededIds) {
      await db.delete(schema.communityPlaces).where(eq(schema.communityPlaces.id, id));
    }
    await client.end();
  });

  async function readTypeAndStatus(id: string) {
    const [row] = await db
      .select({ type: schema.communityPlaces.type, status: schema.communityPlaces.status })
      .from(schema.communityPlaces)
      .where(eq(schema.communityPlaces.id, id));
    return row;
  }

  it("does NOT drift `type` on a re-commit once the row has been approved", async () => {
    const candidate: PlaceCandidate = {
      type: "coop",
      name: "Import Test Co-op (approved-freeze)",
      lat: 40.001,
      lng: -75.001,
      address: null,
      website: null,
      hoursText: null,
      source: "osm",
      sourceRef: "node/990001",
    };

    const first = await upsertCandidate(db, candidate);
    expect(first).toBeDefined();
    expect(first!.inserted).toBe(true);
    seededIds.push(first!.id);

    // Devin approves the vetted classification.
    await db
      .update(schema.communityPlaces)
      .set({ status: "approved" })
      .where(eq(schema.communityPlaces.id, first!.id));

    // A re-import (e.g. upstream OSM tag drift) tries to reclassify it.
    const recommit = await upsertCandidate(db, { ...candidate, type: "health_food" });
    expect(recommit).toBeDefined();
    expect(recommit!.id).toBe(first!.id);
    expect(recommit!.inserted).toBe(false);

    const row = await readTypeAndStatus(first!.id);
    expect(row?.status).toBe("approved");
    expect(row?.type).toBe("coop"); // unchanged despite the re-commit's "health_food"
  });

  it("still refreshes `type` on a re-commit while the row is pending", async () => {
    const candidate: PlaceCandidate = {
      type: "coop",
      name: "Import Test Co-op (pending-refresh)",
      lat: 40.002,
      lng: -75.002,
      address: null,
      website: null,
      hoursText: null,
      source: "osm",
      sourceRef: "node/990002",
    };

    const first = await upsertCandidate(db, candidate);
    expect(first).toBeDefined();
    seededIds.push(first!.id);

    const recommit = await upsertCandidate(db, { ...candidate, type: "health_food" });
    expect(recommit!.id).toBe(first!.id);

    const row = await readTypeAndStatus(first!.id);
    expect(row?.status).toBe("pending");
    expect(row?.type).toBe("health_food");
  });
});

describeWithDb("commitCandidate — cross-source proximity dedupe (PostGIS integration)", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let client: ReturnType<typeof postgres>;
  const seededIds: string[] = [];

  // Isolated corner of the map — nothing else in these suites seeds near here.
  const baseLat = 41.101;
  const baseLng = -73.501;

  const manualCandidate: PlaceCandidate = {
    type: "farmers_market",
    name: "Dedupe Test Farmers Market",
    lat: baseLat,
    lng: baseLng,
    address: "1 Test Sq",
    website: null,
    hoursText: null,
    source: "manual",
    sourceRef: "manual:dedupe-test-market",
  };

  beforeAll(async () => {
    client = postgres(TEST_DB_URL!, { max: 1 });
    db = drizzle(client, { schema });
    await migrateForTest(client, db);

    const seeded = await commitCandidate(db, manualCandidate);
    expect(seeded).toEqual({ action: "inserted", id: expect.any(String) });
    if (seeded && seeded.action === "inserted") seededIds.push(seeded.id);
  });

  afterAll(async () => {
    for (const id of seededIds) {
      await db.delete(schema.communityPlaces).where(eq(schema.communityPlaces.id, id));
    }
    await client.end();
  });

  it("SKIPs an OSM candidate for the same physical place (~50m, similar name), naming the existing row", async () => {
    const osmSameSpot: PlaceCandidate = {
      ...manualCandidate,
      name: "Dedupe Test Farmers Market (Saturdays)", // namesSimilar: containment match
      lat: baseLat + 0.0004, // ~45m north
      source: "osm",
      sourceRef: "node/991001",
    };

    const outcome = await commitCandidate(db, osmSameSpot);
    expect(outcome).toEqual({
      action: "skipped_nearby_duplicate",
      existing: { id: seededIds[0]!, name: manualCandidate.name, source: "manual" },
    });

    // No second identity was created for the physical place.
    const [osmRow] = await db
      .select({ id: schema.communityPlaces.id })
      .from(schema.communityPlaces)
      .where(eq(schema.communityPlaces.sourceRef, "node/991001"));
    expect(osmRow).toBeUndefined();
  });

  it("still INSERTs a genuinely different place at the same distance", async () => {
    const differentPlace: PlaceCandidate = {
      ...manualCandidate,
      name: "Riverbend Health Foods", // no name similarity
      type: "health_food",
      lat: baseLat + 0.0004, // same ~45m offset as the skipped candidate
      source: "osm",
      sourceRef: "node/991002",
    };

    const outcome = await commitCandidate(db, differentPlace);
    expect(outcome).toEqual({ action: "inserted", id: expect.any(String) });
    if (outcome && outcome.action === "inserted") seededIds.push(outcome.id);
  });

  it("does NOT treat the same (source, source_ref) re-commit as a duplicate (refresh path intact)", async () => {
    const outcome = await commitCandidate(db, { ...manualCandidate, address: "2 Test Sq" });
    expect(outcome).toEqual({ action: "updated", id: seededIds[0]! });
  });
});
