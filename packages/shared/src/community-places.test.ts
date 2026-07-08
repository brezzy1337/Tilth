import { describe, it, expect } from "vitest";
import {
  communityPlaceType,
  communityPlace,
  placesNearbyInput,
  placesNearbyOutput,
} from "./index.js";

const uuid1 = "11111111-1111-4111-8111-111111111111";

describe("communityPlaceType enum", () => {
  it("accepts each known place type", () => {
    for (const type of ["farmers_market", "coop", "health_food"]) {
      const result = communityPlaceType.safeParse(type);
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown place type", () => {
    const result = communityPlaceType.safeParse("grocery_store");
    expect(result.success).toBe(false);
  });
});

describe("communityPlace schema", () => {
  const valid = {
    id: uuid1,
    type: "coop",
    name: "Riverside Food Co-op",
    lat: 45.5,
    lng: -122.6,
    address: "123 Main St, Portland, OR",
    website: "https://riversidecoop.example",
    hoursText: "Mon-Sat 8am-8pm, Sun 10am-6pm",
    distanceKm: 3.2,
  };

  it("parses a valid full object", () => {
    const result = communityPlace.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid id", () => {
    const result = communityPlace.safeParse({ ...valid, id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown type", () => {
    const result = communityPlace.safeParse({ ...valid, type: "supermarket" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty name", () => {
    const result = communityPlace.safeParse({ ...valid, name: "" });
    expect(result.success).toBe(false);
  });

  it("accepts a name at the 200-character maximum", () => {
    const result = communityPlace.safeParse({ ...valid, name: "x".repeat(200) });
    expect(result.success).toBe(true);
  });

  it("rejects a name over the 200-character maximum", () => {
    const result = communityPlace.safeParse({ ...valid, name: "x".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("rejects a lat above 90", () => {
    const result = communityPlace.safeParse({ ...valid, lat: 90.1 });
    expect(result.success).toBe(false);
  });

  it("rejects a lat below -90", () => {
    const result = communityPlace.safeParse({ ...valid, lat: -90.1 });
    expect(result.success).toBe(false);
  });

  it("accepts lat at the -90/90 boundaries", () => {
    expect(communityPlace.safeParse({ ...valid, lat: 90 }).success).toBe(true);
    expect(communityPlace.safeParse({ ...valid, lat: -90 }).success).toBe(true);
  });

  it("rejects a lng above 180", () => {
    const result = communityPlace.safeParse({ ...valid, lng: 180.1 });
    expect(result.success).toBe(false);
  });

  it("rejects a lng below -180", () => {
    const result = communityPlace.safeParse({ ...valid, lng: -180.1 });
    expect(result.success).toBe(false);
  });

  it("accepts lng at the -180/180 boundaries", () => {
    expect(communityPlace.safeParse({ ...valid, lng: 180 }).success).toBe(true);
    expect(communityPlace.safeParse({ ...valid, lng: -180 }).success).toBe(true);
  });

  it("accepts null address, website, and hoursText", () => {
    const result = communityPlace.safeParse({
      ...valid,
      address: null,
      website: null,
      hoursText: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-string, non-null address", () => {
    const result = communityPlace.safeParse({ ...valid, address: 123 });
    expect(result.success).toBe(false);
  });

  it("rejects an address over the 300-character maximum", () => {
    const result = communityPlace.safeParse({ ...valid, address: "x".repeat(301) });
    expect(result.success).toBe(false);
  });

  it("rejects a website that is not a valid URL", () => {
    const result = communityPlace.safeParse({ ...valid, website: "not-a-url" });
    expect(result.success).toBe(false);
  });

  // Scheme guarantee — website may be rendered as a tappable link, so only
  // http(s) URLs are allowed; javascript:/data: URIs must never get through.
  it("rejects a javascript: URI website", () => {
    const result = communityPlace.safeParse({ ...valid, website: "javascript:alert(1)" });
    expect(result.success).toBe(false);
  });

  it("rejects a data: URI website", () => {
    const result = communityPlace.safeParse({
      ...valid,
      website: "data:text/html,<script>alert(1)</script>",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an http:// website", () => {
    const result = communityPlace.safeParse({ ...valid, website: "http://coop.example.org" });
    expect(result.success).toBe(true);
  });

  it("accepts an https:// website", () => {
    const result = communityPlace.safeParse({ ...valid, website: "https://coop.example.org" });
    expect(result.success).toBe(true);
  });

  it("rejects hoursText over the 500-character maximum", () => {
    const result = communityPlace.safeParse({ ...valid, hoursText: "x".repeat(501) });
    expect(result.success).toBe(false);
  });

  it("accepts hoursText at the 500-character maximum", () => {
    const result = communityPlace.safeParse({ ...valid, hoursText: "x".repeat(500) });
    expect(result.success).toBe(true);
  });

  it("accepts a distanceKm of zero", () => {
    const result = communityPlace.safeParse({ ...valid, distanceKm: 0 });
    expect(result.success).toBe(true);
  });

  it("rejects a negative distanceKm", () => {
    const result = communityPlace.safeParse({ ...valid, distanceKm: -0.1 });
    expect(result.success).toBe(false);
  });
});

describe("placesNearbyInput schema", () => {
  const valid = { lat: 45.5, lng: -122.6 };

  it("applies the default radiusKm of 25", () => {
    const result = placesNearbyInput.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.radiusKm).toBe(25);
      expect(result.data.type).toBeUndefined();
    }
  });

  it("accepts radiusKm at the 100 upper bound", () => {
    const result = placesNearbyInput.safeParse({ ...valid, radiusKm: 100 });
    expect(result.success).toBe(true);
  });

  it("rejects radiusKm above the 100 upper bound", () => {
    const result = placesNearbyInput.safeParse({ ...valid, radiusKm: 100.1 });
    expect(result.success).toBe(false);
  });

  it("rejects a zero radiusKm (must be positive)", () => {
    const result = placesNearbyInput.safeParse({ ...valid, radiusKm: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a negative radiusKm", () => {
    const result = placesNearbyInput.safeParse({ ...valid, radiusKm: -5 });
    expect(result.success).toBe(false);
  });

  it("rejects a lat above 90", () => {
    const result = placesNearbyInput.safeParse({ ...valid, lat: 91 });
    expect(result.success).toBe(false);
  });

  it("rejects a lng below -180", () => {
    const result = placesNearbyInput.safeParse({ ...valid, lng: -181 });
    expect(result.success).toBe(false);
  });

  it("accepts an optional type filter", () => {
    const result = placesNearbyInput.safeParse({ ...valid, type: "farmers_market" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("farmers_market");
    }
  });

  it("rejects an unknown type filter", () => {
    const result = placesNearbyInput.safeParse({ ...valid, type: "grocery_store" });
    expect(result.success).toBe(false);
  });
});

describe("placesNearbyOutput schema", () => {
  const place = {
    id: uuid1,
    type: "farmers_market",
    name: "Saturday Market",
    lat: 45.5,
    lng: -122.6,
    address: null,
    website: null,
    hoursText: "Sat 8am-1pm, May-Oct",
    distanceKm: 1.1,
  };

  it("parses an empty array", () => {
    const result = placesNearbyOutput.safeParse([]);
    expect(result.success).toBe(true);
  });

  it("parses an array of valid places", () => {
    const result = placesNearbyOutput.safeParse([place, { ...place, id: uuid1 }]);
    expect(result.success).toBe(true);
  });

  it("accepts exactly 200 places", () => {
    const result = placesNearbyOutput.safeParse(Array(200).fill(place));
    expect(result.success).toBe(true);
  });

  it("rejects more than 200 places", () => {
    const result = placesNearbyOutput.safeParse(Array(201).fill(place));
    expect(result.success).toBe(false);
  });

  it("rejects an array containing an invalid place", () => {
    const result = placesNearbyOutput.safeParse([{ ...place, lat: 999 }]);
    expect(result.success).toBe(false);
  });
});
