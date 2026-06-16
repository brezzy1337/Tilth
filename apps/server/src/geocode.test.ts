/**
 * Unit tests for geocode.ts.
 *
 * Stubs global `fetch` to avoid any real network calls.
 * No env vars or DB required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { geocodeAddress } from "./geocode";

const INPUT = {
  address: "123 Main St",
  city: "Springfield",
  state: "IL",
  zip: "62701",
};

const FAKE_API_KEY = "fake-api-key-for-testing";

/** Build a minimal Google Geocoding API success response. */
function googleOkResponse(lat: number, lng: number) {
  return {
    status: "OK",
    results: [
      {
        geometry: {
          location: { lat, lng },
        },
      },
    ],
  };
}

/** Build a ZERO_RESULTS response. */
function googleZeroResults() {
  return { status: "ZERO_RESULTS", results: [] };
}

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

describe("geocodeAddress", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", mockFetch(googleOkResponse(40.1, -89.2)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns lat/lng from a successful Google response", async () => {
    vi.stubGlobal("fetch", mockFetch(googleOkResponse(40.1, -89.2)));

    const result = await geocodeAddress(INPUT, FAKE_API_KEY);

    expect(result).not.toBeNull();
    expect(result?.lat).toBe(40.1);
    expect(result?.lng).toBe(-89.2);
  });

  it("encodes the address and passes the key as a header (not in the URL)", async () => {
    const fetchSpy = mockFetch(googleOkResponse(40.1, -89.2));
    vi.stubGlobal("fetch", fetchSpy);

    await geocodeAddress(INPUT, FAKE_API_KEY);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("maps.googleapis.com/maps/api/geocode/json");
    // Key must NOT appear in the URL query string
    expect(url).not.toContain("key=");
    // Address must be URL-encoded and present
    expect(url).toContain("address=");
    expect(url).toContain("Springfield");
    // Key must be sent as a request header instead
    const headers = init?.headers as Record<string, string>;
    expect(headers?.["X-Goog-Api-Key"]).toBe(FAKE_API_KEY);
  });

  it("returns null on ZERO_RESULTS", async () => {
    vi.stubGlobal("fetch", mockFetch(googleZeroResults()));

    const result = await geocodeAddress(INPUT, FAKE_API_KEY);
    expect(result).toBeNull();
  });

  it("returns null on empty results array", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: "OK", results: [] }));

    const result = await geocodeAddress(INPUT, FAKE_API_KEY);
    expect(result).toBeNull();
  });

  it("returns null when fetch responds with non-OK HTTP status", async () => {
    vi.stubGlobal("fetch", mockFetch({}, false, 500));

    const result = await geocodeAddress(INPUT, FAKE_API_KEY);
    expect(result).toBeNull();
  });

  it("returns null when fetch throws a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await geocodeAddress(INPUT, FAKE_API_KEY);
    expect(result).toBeNull();
  });

  it("returns null on REQUEST_DENIED status", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: "REQUEST_DENIED", results: [] }));

    const result = await geocodeAddress(INPUT, FAKE_API_KEY);
    expect(result).toBeNull();
  });

  it("returns null when JSON parsing fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("invalid json");
        },
      } as unknown as Response),
    );

    const result = await geocodeAddress(INPUT, FAKE_API_KEY);
    expect(result).toBeNull();
  });
});
