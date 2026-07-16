import { describe, it, expect } from "vitest";
import {
  toggleGardenLikeInput,
  toggleGardenLikeOutput,
  gardenCommentBody,
  createGardenCommentInput,
  createGardenCommentOutput,
  gardenComment,
  listGardenCommentsInput,
  listGardenCommentsOutput,
  deleteGardenCommentInput,
  reportGardenCommentInput,
  gardenFeedItem,
} from "./index.js";

const uuid1 = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";
const uuid3 = "33333333-3333-4333-8333-333333333333";

describe("toggleGardenLikeInput schema", () => {
  it("parses a valid input", () => {
    expect(toggleGardenLikeInput.safeParse({ postId: uuid1 }).success).toBe(true);
  });

  it("rejects a non-uuid postId", () => {
    expect(toggleGardenLikeInput.safeParse({ postId: "nope" }).success).toBe(false);
  });
});

describe("toggleGardenLikeOutput schema", () => {
  it("parses a valid output", () => {
    const result = toggleGardenLikeOutput.safeParse({ liked: true, likeCount: 5 });
    expect(result.success).toBe(true);
  });

  it("accepts likeCount of zero", () => {
    expect(toggleGardenLikeOutput.safeParse({ liked: false, likeCount: 0 }).success).toBe(true);
  });

  it("rejects a negative likeCount", () => {
    expect(toggleGardenLikeOutput.safeParse({ liked: false, likeCount: -1 }).success).toBe(false);
  });

  it("rejects a non-integer likeCount", () => {
    expect(toggleGardenLikeOutput.safeParse({ liked: true, likeCount: 1.5 }).success).toBe(false);
  });

  it("rejects a missing liked field", () => {
    expect(toggleGardenLikeOutput.safeParse({ likeCount: 1 }).success).toBe(false);
  });
});

describe("gardenCommentBody schema", () => {
  it("rejects an empty string", () => {
    expect(gardenCommentBody.safeParse("").success).toBe(false);
  });

  it("rejects a string that is only whitespace (trimmed to empty)", () => {
    expect(gardenCommentBody.safeParse("   ").success).toBe(false);
  });

  it("accepts a single character", () => {
    expect(gardenCommentBody.safeParse("h").success).toBe(true);
  });

  it("accepts a body at the 500-character maximum", () => {
    expect(gardenCommentBody.safeParse("x".repeat(500)).success).toBe(true);
  });

  it("rejects a body over the 500-character maximum", () => {
    expect(gardenCommentBody.safeParse("x".repeat(501)).success).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    const result = gardenCommentBody.safeParse("  nice basil!  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("nice basil!");
    }
  });
});

describe("createGardenCommentInput schema", () => {
  it("parses a valid input", () => {
    const result = createGardenCommentInput.safeParse({ postId: uuid1, body: "love this!" });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid postId", () => {
    const result = createGardenCommentInput.safeParse({ postId: "nope", body: "hi" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty body", () => {
    const result = createGardenCommentInput.safeParse({ postId: uuid1, body: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a body over 500 characters", () => {
    const result = createGardenCommentInput.safeParse({
      postId: uuid1,
      body: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });
});

describe("gardenComment schema", () => {
  const valid = {
    id: uuid1,
    postId: uuid2,
    userId: uuid3,
    username: "jane_gardener",
    body: "So jealous of this harvest!",
    createdAt: "2026-07-14T12:00:00.000Z",
    deleted: false,
  };

  it("parses a valid comment", () => {
    expect(gardenComment.safeParse(valid).success).toBe(true);
  });

  it("rejects a comment missing deleted", () => {
    const { deleted: _omitted, ...withoutDeleted } = valid;
    expect(gardenComment.safeParse(withoutDeleted).success).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    expect(gardenComment.safeParse({ ...valid, id: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects a non-datetime createdAt", () => {
    expect(gardenComment.safeParse({ ...valid, createdAt: "2026-07-14" }).success).toBe(false);
  });

  it("accepts a deleted comment with an empty body (server sends '' when removed)", () => {
    const result = gardenComment.safeParse({ ...valid, deleted: true, body: "" });
    expect(result.success).toBe(true);
  });
});

describe("createGardenCommentOutput", () => {
  it("is the gardenComment schema (output = the created comment)", () => {
    expect(createGardenCommentOutput).toBe(gardenComment);
  });
});

describe("listGardenCommentsInput schema", () => {
  const valid = { postId: uuid1 };

  it("applies the default limit of 30, mirroring messagesListInput", () => {
    const result = listGardenCommentsInput.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(30);
      expect(result.data.cursor).toBeUndefined();
    }
  });

  it("accepts limit at the 1 lower bound", () => {
    expect(listGardenCommentsInput.safeParse({ ...valid, limit: 1 }).success).toBe(true);
  });

  it("accepts limit at the 100 upper bound", () => {
    expect(listGardenCommentsInput.safeParse({ ...valid, limit: 100 }).success).toBe(true);
  });

  it("rejects limit above 100", () => {
    expect(listGardenCommentsInput.safeParse({ ...valid, limit: 101 }).success).toBe(false);
  });

  it("rejects limit below 1", () => {
    expect(listGardenCommentsInput.safeParse({ ...valid, limit: 0 }).success).toBe(false);
  });

  it("rejects a non-integer limit", () => {
    expect(listGardenCommentsInput.safeParse({ ...valid, limit: 10.5 }).success).toBe(false);
  });

  it("accepts an optional cursor string", () => {
    expect(listGardenCommentsInput.safeParse({ ...valid, cursor: "abc123" }).success).toBe(true);
  });

  it("rejects a non-uuid postId", () => {
    expect(listGardenCommentsInput.safeParse({ postId: "nope" }).success).toBe(false);
  });
});

describe("listGardenCommentsOutput schema", () => {
  const comment = {
    id: uuid1,
    postId: uuid2,
    userId: uuid3,
    username: "jane_gardener",
    body: "Beautiful!",
    createdAt: "2026-07-14T12:00:00.000Z",
    deleted: false,
  };

  it("parses a page with comments and a nextCursor", () => {
    const result = listGardenCommentsOutput.safeParse({
      comments: [comment],
      nextCursor: "cursor-abc",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a null nextCursor (last page)", () => {
    const result = listGardenCommentsOutput.safeParse({
      comments: [comment],
      nextCursor: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty comments array", () => {
    const result = listGardenCommentsOutput.safeParse({ comments: [], nextCursor: null });
    expect(result.success).toBe(true);
  });

  it("rejects a missing nextCursor", () => {
    const result = listGardenCommentsOutput.safeParse({ comments: [comment] });
    expect(result.success).toBe(false);
  });
});

describe("deleteGardenCommentInput schema", () => {
  it("parses a valid input", () => {
    expect(deleteGardenCommentInput.safeParse({ commentId: uuid1 }).success).toBe(true);
  });

  it("rejects a non-uuid commentId", () => {
    expect(deleteGardenCommentInput.safeParse({ commentId: "nope" }).success).toBe(false);
  });
});

describe("reportGardenCommentInput schema", () => {
  it("parses a valid input", () => {
    const result = reportGardenCommentInput.safeParse({
      commentId: uuid1,
      reason: "Spam link",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty reason", () => {
    expect(
      reportGardenCommentInput.safeParse({ commentId: uuid1, reason: "" }).success,
    ).toBe(false);
  });

  it("accepts a reason at the 500-character maximum", () => {
    const result = reportGardenCommentInput.safeParse({
      commentId: uuid1,
      reason: "x".repeat(500),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a reason over the 500-character maximum", () => {
    const result = reportGardenCommentInput.safeParse({
      commentId: uuid1,
      reason: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid commentId", () => {
    expect(
      reportGardenCommentInput.safeParse({ commentId: "nope", reason: "spam" }).success,
    ).toBe(false);
  });
});

describe("gardenFeedItem carries F-053 social counts", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    storeId: "22222222-2222-4222-8222-222222222222",
    storeName: "Sunny Acres",
    distanceKm: 3.2,
    caption: "Fresh basil today",
    status: "ready" as const,
    createdAt: "2026-07-01T12:00:00.000Z",
    type: "photo_set" as const,
    photos: [{ url: "https://cdn.example.com/a.jpg" }],
  };

  it("rejects a feed item missing likeCount/likedByMe/commentCount", () => {
    const result = gardenFeedItem.safeParse(base);
    expect(result.success).toBe(false);
  });

  it("parses a feed item with all three social counts present", () => {
    const result = gardenFeedItem.safeParse({
      ...base,
      likeCount: 3,
      likedByMe: true,
      commentCount: 1,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a negative likeCount", () => {
    const result = gardenFeedItem.safeParse({
      ...base,
      likeCount: -1,
      likedByMe: false,
      commentCount: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a negative commentCount", () => {
    const result = gardenFeedItem.safeParse({
      ...base,
      likeCount: 0,
      likedByMe: false,
      commentCount: -1,
    });
    expect(result.success).toBe(false);
  });
});
