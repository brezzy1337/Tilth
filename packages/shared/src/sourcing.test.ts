import { describe, it, expect } from "vitest";
import {
  sourcingRequestStatus,
  sourcingRequestDirection,
  sourcingProduce,
  sourcingQuantity,
  sourcingNote,
  createSourcingRequestInput,
  createSourcingOfferInput,
  respondSourcingRequestInput,
  withdrawSourcingRequestInput,
  sourcingRequest,
  createSourcingRequestOutput,
  sourcingListMineOutput,
  sourcingGrowerSummary,
  sourcingGrowersOutput,
  myPlaceOutput,
  chatMessage,
} from "./index.js";

const uuid1 = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";
const uuid3 = "33333333-3333-4333-8333-333333333333";
const uuid4 = "44444444-4444-4444-8444-444444444444";

describe("sourcingRequestStatus enum", () => {
  it("accepts each known status", () => {
    for (const status of ["pending", "accepted", "declined", "withdrawn"]) {
      expect(sourcingRequestStatus.safeParse(status).success).toBe(true);
    }
  });

  it("rejects an unknown status", () => {
    const result = sourcingRequestStatus.safeParse("cancelled");
    expect(result.success).toBe(false);
  });
});

describe("sourcingRequestDirection enum", () => {
  it("accepts each known direction", () => {
    for (const direction of ["place_to_grower", "grower_to_place"]) {
      expect(sourcingRequestDirection.safeParse(direction).success).toBe(true);
    }
  });

  it("rejects an unknown direction", () => {
    const result = sourcingRequestDirection.safeParse("grower_to_grower");
    expect(result.success).toBe(false);
  });
});

describe("sourcingProduce schema", () => {
  it("rejects an empty string", () => {
    expect(sourcingProduce.safeParse("").success).toBe(false);
  });

  it("rejects a string that is only whitespace (trimmed to empty)", () => {
    expect(sourcingProduce.safeParse("   ").success).toBe(false);
  });

  it("accepts a value at the 120-character maximum", () => {
    expect(sourcingProduce.safeParse("x".repeat(120)).success).toBe(true);
  });

  it("rejects a value over the 120-character maximum", () => {
    expect(sourcingProduce.safeParse("x".repeat(121)).success).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    const result = sourcingProduce.safeParse("  heirloom tomatoes  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("heirloom tomatoes");
    }
  });
});

describe("sourcingQuantity schema", () => {
  it("rejects an empty string", () => {
    expect(sourcingQuantity.safeParse("").success).toBe(false);
  });

  it("accepts a value at the 80-character maximum", () => {
    expect(sourcingQuantity.safeParse("x".repeat(80)).success).toBe(true);
  });

  it("rejects a value over the 80-character maximum", () => {
    expect(sourcingQuantity.safeParse("x".repeat(81)).success).toBe(false);
  });

  it("accepts free-text quantities", () => {
    expect(sourcingQuantity.safeParse("20 lb").success).toBe(true);
    expect(sourcingQuantity.safeParse("a few cases").success).toBe(true);
  });
});

describe("sourcingNote schema", () => {
  it("accepts an empty string (note is required-but-empty, optional at the input level)", () => {
    expect(sourcingNote.safeParse("").success).toBe(true);
  });

  it("accepts a note at the 500-character maximum", () => {
    expect(sourcingNote.safeParse("x".repeat(500)).success).toBe(true);
  });

  it("rejects a note over the 500-character maximum", () => {
    expect(sourcingNote.safeParse("x".repeat(501)).success).toBe(false);
  });
});

describe("createSourcingRequestInput schema", () => {
  const valid = {
    storeId: uuid1,
    produce: "heirloom tomatoes",
    quantity: "20 lb",
  };

  it("parses a minimal valid input (neededBy/note omitted)", () => {
    const result = createSourcingRequestInput.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("parses a full valid input", () => {
    const result = createSourcingRequestInput.safeParse({
      ...valid,
      neededBy: "2026-08-01",
      note: "For the Saturday market",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid storeId", () => {
    const result = createSourcingRequestInput.safeParse({ ...valid, storeId: "nope" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty produce", () => {
    const result = createSourcingRequestInput.safeParse({ ...valid, produce: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a produce over the 120-character maximum", () => {
    const result = createSourcingRequestInput.safeParse({
      ...valid,
      produce: "x".repeat(121),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a note over the 500-character maximum", () => {
    const result = createSourcingRequestInput.safeParse({
      ...valid,
      note: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid neededBy date", () => {
    const result = createSourcingRequestInput.safeParse({ ...valid, neededBy: "not-a-date" });
    expect(result.success).toBe(false);
  });

  it("rejects a neededBy that includes a time component", () => {
    const result = createSourcingRequestInput.safeParse({
      ...valid,
      neededBy: "2026-08-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("createSourcingOfferInput schema", () => {
  const valid = {
    placeId: uuid1,
    produce: "sweet corn",
    quantity: "10 dozen",
  };

  it("parses a minimal valid input", () => {
    const result = createSourcingOfferInput.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid placeId", () => {
    const result = createSourcingOfferInput.safeParse({ ...valid, placeId: "nope" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty quantity", () => {
    const result = createSourcingOfferInput.safeParse({ ...valid, quantity: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a quantity over the 80-character maximum", () => {
    const result = createSourcingOfferInput.safeParse({ ...valid, quantity: "x".repeat(81) });
    expect(result.success).toBe(false);
  });
});

describe("respondSourcingRequestInput schema", () => {
  it("parses a valid accepted response", () => {
    const result = respondSourcingRequestInput.safeParse({
      requestId: uuid1,
      response: "accepted",
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid declined response", () => {
    const result = respondSourcingRequestInput.safeParse({
      requestId: uuid1,
      response: "declined",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response of pending (not a valid response value)", () => {
    const result = respondSourcingRequestInput.safeParse({
      requestId: uuid1,
      response: "pending",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid requestId", () => {
    const result = respondSourcingRequestInput.safeParse({
      requestId: "nope",
      response: "accepted",
    });
    expect(result.success).toBe(false);
  });
});

describe("withdrawSourcingRequestInput schema", () => {
  it("parses a valid input", () => {
    const result = withdrawSourcingRequestInput.safeParse({ requestId: uuid1 });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid requestId", () => {
    const result = withdrawSourcingRequestInput.safeParse({ requestId: "nope" });
    expect(result.success).toBe(false);
  });
});

describe("sourcingRequest schema", () => {
  const valid = {
    id: uuid1,
    direction: "place_to_grower" as const,
    status: "pending" as const,
    placeId: uuid2,
    placeName: "Riverside Food Co-op",
    storeId: uuid3,
    storeName: "Sunny Acres",
    conversationId: uuid4,
    produce: "heirloom tomatoes",
    quantity: "20 lb",
    neededBy: "2026-08-01",
    note: "For the Saturday market",
    createdByUserId: uuid2,
    respondedAt: null,
    createdAt: "2026-07-07T12:00:00.000Z",
  };

  it("parses a valid full object", () => {
    const result = sourcingRequest.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("round-trips with neededBy, note, and respondedAt all null", () => {
    const result = sourcingRequest.safeParse({
      ...valid,
      neededBy: null,
      note: null,
      respondedAt: null,
    });
    expect(result.success).toBe(true);
  });

  it("round-trips with respondedAt populated (accepted/declined)", () => {
    const result = sourcingRequest.safeParse({
      ...valid,
      status: "accepted",
      respondedAt: "2026-07-08T09:30:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown direction", () => {
    const result = sourcingRequest.safeParse({ ...valid, direction: "sideways" });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    const result = sourcingRequest.safeParse({ ...valid, status: "cancelled" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    const result = sourcingRequest.safeParse({ ...valid, id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-datetime createdAt", () => {
    const result = sourcingRequest.safeParse({ ...valid, createdAt: "2026-07-07" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-date neededBy", () => {
    const result = sourcingRequest.safeParse({ ...valid, neededBy: "not-a-date" });
    expect(result.success).toBe(false);
  });
});

describe("createSourcingRequestOutput schema", () => {
  const validRequest = {
    id: uuid1,
    direction: "grower_to_place" as const,
    status: "pending" as const,
    placeId: uuid2,
    placeName: "Riverside Food Co-op",
    storeId: uuid3,
    storeName: "Sunny Acres",
    conversationId: uuid4,
    produce: "sweet corn",
    quantity: "10 dozen",
    neededBy: null,
    note: null,
    createdByUserId: uuid3,
    respondedAt: null,
    createdAt: "2026-07-07T12:00:00.000Z",
  };

  it("parses a valid output", () => {
    const result = createSourcingRequestOutput.safeParse({
      request: validRequest,
      conversationId: uuid4,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an output with a non-uuid conversationId", () => {
    const result = createSourcingRequestOutput.safeParse({
      request: validRequest,
      conversationId: "nope",
    });
    expect(result.success).toBe(false);
  });
});

describe("sourcingListMineOutput schema", () => {
  const item = {
    id: uuid1,
    direction: "place_to_grower" as const,
    status: "pending" as const,
    placeId: uuid2,
    placeName: "Riverside Food Co-op",
    storeId: uuid3,
    storeName: "Sunny Acres",
    conversationId: uuid4,
    produce: "kale",
    quantity: "5 lb",
    neededBy: null,
    note: null,
    createdByUserId: uuid2,
    respondedAt: null,
    createdAt: "2026-07-07T12:00:00.000Z",
  };

  it("parses an empty array", () => {
    expect(sourcingListMineOutput.safeParse([]).success).toBe(true);
  });

  it("accepts exactly 50 requests", () => {
    const result = sourcingListMineOutput.safeParse(Array(50).fill(item));
    expect(result.success).toBe(true);
  });

  it("rejects more than 50 requests", () => {
    const result = sourcingListMineOutput.safeParse(Array(51).fill(item));
    expect(result.success).toBe(false);
  });
});

describe("sourcingGrowerSummary / sourcingGrowersOutput schemas", () => {
  const grower = {
    storeId: uuid1,
    name: "Sunny Acres",
    logo: null,
    distanceKm: 4.5,
    listingCount: 12,
    sampleListings: ["Heirloom tomatoes", "Sweet corn", "Zucchini"],
  };

  it("parses a valid grower summary", () => {
    expect(sourcingGrowerSummary.safeParse(grower).success).toBe(true);
  });

  it("accepts a non-null logo URL string", () => {
    const result = sourcingGrowerSummary.safeParse({
      ...grower,
      logo: "https://example.com/logo.png",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative listingCount", () => {
    const result = sourcingGrowerSummary.safeParse({ ...grower, listingCount: -1 });
    expect(result.success).toBe(false);
  });

  it("accepts a listingCount of zero", () => {
    const result = sourcingGrowerSummary.safeParse({ ...grower, listingCount: 0 });
    expect(result.success).toBe(true);
  });

  it("rejects more than 3 sampleListings", () => {
    const result = sourcingGrowerSummary.safeParse({
      ...grower,
      sampleListings: ["a", "b", "c", "d"],
    });
    expect(result.success).toBe(false);
  });

  it("parses an empty sourcingGrowersOutput array", () => {
    expect(sourcingGrowersOutput.safeParse([]).success).toBe(true);
  });

  it("accepts exactly 30 growers", () => {
    const result = sourcingGrowersOutput.safeParse(Array(30).fill(grower));
    expect(result.success).toBe(true);
  });

  it("rejects more than 30 growers", () => {
    const result = sourcingGrowersOutput.safeParse(Array(31).fill(grower));
    expect(result.success).toBe(false);
  });
});

describe("myPlaceOutput schema", () => {
  it("accepts null (caller represents no place)", () => {
    expect(myPlaceOutput.safeParse(null).success).toBe(true);
  });

  it("parses a valid linked place", () => {
    const result = myPlaceOutput.safeParse({
      id: uuid1,
      name: "Riverside Food Co-op",
      type: "coop",
      address: "123 Main St, Portland, OR",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null address", () => {
    const result = myPlaceOutput.safeParse({
      id: uuid1,
      name: "Riverside Food Co-op",
      type: "coop",
      address: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown place type", () => {
    const result = myPlaceOutput.safeParse({
      id: uuid1,
      name: "Riverside Food Co-op",
      type: "supermarket",
      address: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("chatMessage schema with sourcingRequest", () => {
  const baseMessage = {
    id: uuid1,
    conversationId: uuid4,
    senderUserId: uuid2,
    body: "Can you supply 20 lb of tomatoes by Friday?",
    createdAt: "2026-07-07T12:00:00.000Z",
  };

  const attachedRequest = {
    id: uuid1,
    direction: "place_to_grower" as const,
    status: "pending" as const,
    placeId: uuid2,
    placeName: "Riverside Food Co-op",
    storeId: uuid3,
    storeName: "Sunny Acres",
    conversationId: uuid4,
    produce: "heirloom tomatoes",
    quantity: "20 lb",
    neededBy: "2026-08-01",
    note: null,
    createdByUserId: uuid2,
    respondedAt: null,
    createdAt: "2026-07-07T12:00:00.000Z",
  };

  it("accepts a null sourcingRequest (a plain chat message)", () => {
    const result = chatMessage.safeParse({ ...baseMessage, sourcingRequest: null });
    expect(result.success).toBe(true);
  });

  it("accepts a populated sourcingRequest", () => {
    const result = chatMessage.safeParse({
      ...baseMessage,
      sourcingRequest: attachedRequest,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a message with an invalid attached sourcingRequest", () => {
    const result = chatMessage.safeParse({
      ...baseMessage,
      sourcingRequest: { ...attachedRequest, status: "cancelled" },
    });
    expect(result.success).toBe(false);
  });
});
