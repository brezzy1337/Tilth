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

import { describe, it, expect } from "vitest";
import {
  classifyOsmElement,
  isCoopSignal,
  buildAddress,
  normalizeWebsite,
  osmElementToCandidate,
  mapUsdaRecord,
  buildOverpassQuery,
  namesSimilar,
  normalizeName,
  haversineMeters,
  dedupeUsdaOsm,
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
      classifyOsmElement({ shop: "greengrocer", name: "Green Grocer", "operator:type": "cooperative" }),
    ).toBe("coop");
  });

  it("classifies cooperative=yes as coop", () => {
    expect(classifyOsmElement({ shop: "convenience", name: "Corner Store", cooperative: "yes" })).toBe(
      "coop",
    );
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
    expect(osmElementToCandidate({ type: "node", id: 1, lat: 1, lon: 1, tags: { shop: "health_food" } })).toBeNull();
  });

  it("skips an element that doesn't classify into any community place type", () => {
    expect(
      osmElementToCandidate({ type: "node", id: 2, lat: 1, lon: 1, tags: { shop: "clothes", name: "Fashion" } }),
    ).toBeNull();
  });

  it("skips a way with no Overpass center", () => {
    expect(
      osmElementToCandidate({ type: "way", id: 3, tags: { amenity: "marketplace", name: "No Center Market" } }),
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
      mapUsdaRecord({ listing_id: 1, listing_name: "Bad Coords Market", location_x: "n/a", location_y: "n/a" }),
    ).toBeNull();
  });

  it("returns null when listing_id is missing", () => {
    expect(mapUsdaRecord({ listing_name: "No Id Market", location_x: 1, location_y: 1 })).toBeNull();
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
  it("includes all three tag families and the given radius/lat/lng", () => {
    const query = buildOverpassQuery(33.749, -84.388, 20000);
    expect(query).toContain('shop"="health_food"');
    expect(query).toContain('amenity"="marketplace"');
    expect(query).toContain("co-?op");
    expect(query).toContain("operator:type");
    expect(query).toContain("cooperative");
    expect(query).toContain("around:20000,33.749,-84.388");
    expect(query).toContain("out center tags;");
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
