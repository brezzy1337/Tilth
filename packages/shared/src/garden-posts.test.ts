import { describe, it, expect } from "vitest";
import {
  createGardenPostPhotoSetInput,
  gardenFeedInput,
  gardenFeedItem,
} from "./index.js";

describe("gardenFeedInput schema", () => {
  const valid = {
    lat: 45.5,
    lng: -122.6,
  };

  it("parses valid input and applies radiusKm/limit defaults", () => {
    const result = gardenFeedInput.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.radiusKm).toBe(25);
      expect(result.data.limit).toBe(10);
      expect(result.data.cursor).toBeUndefined();
    }
  });

  it("accepts an explicit radiusKm at the 100 km cap", () => {
    const result = gardenFeedInput.safeParse({ ...valid, radiusKm: 100 });
    expect(result.success).toBe(true);
  });

  it("rejects radiusKm above the 100 km cap", () => {
    const result = gardenFeedInput.safeParse({ ...valid, radiusKm: 100.01 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive radiusKm", () => {
    const result = gardenFeedInput.safeParse({ ...valid, radiusKm: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects lat outside [-90, 90]", () => {
    const result = gardenFeedInput.safeParse({ ...valid, lat: 90.1 });
    expect(result.success).toBe(false);
  });

  it("rejects lng outside [-180, 180]", () => {
    const result = gardenFeedInput.safeParse({ ...valid, lng: 180.1 });
    expect(result.success).toBe(false);
  });

  it("accepts limit at the 50 upper bound", () => {
    const result = gardenFeedInput.safeParse({ ...valid, limit: 50 });
    expect(result.success).toBe(true);
  });

  it("rejects limit above 50", () => {
    const result = gardenFeedInput.safeParse({ ...valid, limit: 51 });
    expect(result.success).toBe(false);
  });

  it("rejects limit below 1", () => {
    const result = gardenFeedInput.safeParse({ ...valid, limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer limit", () => {
    const result = gardenFeedInput.safeParse({ ...valid, limit: 10.5 });
    expect(result.success).toBe(false);
  });

  it("accepts an optional cursor string", () => {
    const result = gardenFeedInput.safeParse({ ...valid, cursor: "abc123" });
    expect(result.success).toBe(true);
  });
});

describe("createGardenPostPhotoSetInput schema", () => {
  const photo = { url: "https://cdn.example.com/photo.jpg" };

  it("parses a valid input with an empty caption (captions are optional content)", () => {
    const result = createGardenPostPhotoSetInput.safeParse({
      caption: "",
      photos: [photo],
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid input with 10 photos (the maximum)", () => {
    const result = createGardenPostPhotoSetInput.safeParse({
      caption: "Tomatoes are in!",
      photos: Array.from({ length: 10 }, () => photo),
    });
    expect(result.success).toBe(true);
  });

  it("rejects zero photos", () => {
    const result = createGardenPostPhotoSetInput.safeParse({
      caption: "no photos",
      photos: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than 10 photos", () => {
    const result = createGardenPostPhotoSetInput.safeParse({
      caption: "too many",
      photos: Array.from({ length: 11 }, () => photo),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a caption over 500 characters", () => {
    const result = createGardenPostPhotoSetInput.safeParse({
      caption: "x".repeat(501),
      photos: [photo],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a photo with a non-URL string", () => {
    const result = createGardenPostPhotoSetInput.safeParse({
      caption: "bad photo",
      photos: [{ url: "not-a-url" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts photos with optional width/height", () => {
    const result = createGardenPostPhotoSetInput.safeParse({
      caption: "sized",
      photos: [{ ...photo, width: 1080, height: 1350 }],
    });
    expect(result.success).toBe(true);
  });
});

describe("gardenFeedItem discriminated union", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    storeId: "22222222-2222-4222-8222-222222222222",
    storeName: "Sunny Acres",
    distanceKm: 3.2,
    caption: "Fresh basil today",
    status: "ready" as const,
    createdAt: "2026-07-01T12:00:00.000Z",
  };

  it("parses a valid photo_set item", () => {
    const result = gardenFeedItem.safeParse({
      ...base,
      type: "photo_set",
      photos: [{ url: "https://cdn.example.com/a.jpg" }],
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "photo_set") {
      expect(result.data.photos).toHaveLength(1);
    }
  });

  it("parses a valid video item", () => {
    const result = gardenFeedItem.safeParse({
      ...base,
      type: "video",
      muxPlaybackId: "abc123",
      posterUrl: "https://image.mux.com/abc123/thumbnail.jpg",
      durationS: 42,
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === "video") {
      expect(result.data.muxPlaybackId).toBe("abc123");
    }
  });

  it("parses a video item without the optional durationS", () => {
    const result = gardenFeedItem.safeParse({
      ...base,
      type: "video",
      muxPlaybackId: "abc123",
      posterUrl: "https://image.mux.com/abc123/thumbnail.jpg",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a video item with a processing status but missing muxPlaybackId", () => {
    const result = gardenFeedItem.safeParse({
      ...base,
      status: "processing",
      type: "video",
      posterUrl: "https://image.mux.com/abc123/thumbnail.jpg",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an item with an unknown discriminator value", () => {
    const result = gardenFeedItem.safeParse({
      ...base,
      type: "gif",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a photo_set item that also carries video-only fields but no photos", () => {
    const result = gardenFeedItem.safeParse({
      ...base,
      type: "photo_set",
      muxPlaybackId: "abc123",
    });
    expect(result.success).toBe(false);
  });
});
