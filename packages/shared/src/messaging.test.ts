import { describe, it, expect } from "vitest";
import {
  messageBody,
  chatMessage,
  conversationSummary,
  startConversationInput,
  messagesListInput,
  sendMessageInput,
  markConversationReadInput,
  blockUserInput,
  reportMessageInput,
  registerPushTokenInput,
} from "./index.js";

const uuid1 = "11111111-1111-4111-8111-111111111111";
const uuid2 = "22222222-2222-4222-8222-222222222222";

describe("messageBody schema", () => {
  it("rejects an empty string", () => {
    const result = messageBody.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects a string that is only whitespace (trimmed to empty)", () => {
    const result = messageBody.safeParse("   ");
    expect(result.success).toBe(false);
  });

  it("accepts a single character", () => {
    const result = messageBody.safeParse("h");
    expect(result.success).toBe(true);
  });

  it("accepts a body at the 2000-character maximum", () => {
    const result = messageBody.safeParse("x".repeat(2000));
    expect(result.success).toBe(true);
  });

  it("rejects a body over the 2000-character maximum", () => {
    const result = messageBody.safeParse("x".repeat(2001));
    expect(result.success).toBe(false);
  });

  it("trims surrounding whitespace", () => {
    const result = messageBody.safeParse("  hello  ");
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("hello");
    }
  });
});

describe("chatMessage schema", () => {
  const valid = {
    id: uuid1,
    conversationId: uuid2,
    senderUserId: uuid1,
    body: "hey there",
    sourcingRequest: null,
    createdAt: "2026-07-07T12:00:00.000Z",
  };

  it("parses a valid message", () => {
    const result = chatMessage.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects a message missing sourcingRequest", () => {
    const { sourcingRequest: _omitted, ...withoutSourcingRequest } = valid;
    const result = chatMessage.safeParse(withoutSourcingRequest);
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid id", () => {
    const result = chatMessage.safeParse({ ...valid, id: "not-a-uuid" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-datetime createdAt", () => {
    const result = chatMessage.safeParse({ ...valid, createdAt: "2026-07-07" });
    expect(result.success).toBe(false);
  });

  it("rejects an empty body", () => {
    const result = chatMessage.safeParse({ ...valid, body: "" });
    expect(result.success).toBe(false);
  });
});

describe("conversationSummary schema", () => {
  const valid = {
    id: uuid1,
    storeId: uuid2,
    storeName: "Sunny Acres",
    storeUserId: uuid2,
    buyerId: uuid1,
    buyerName: "Jane Buyer",
    lastMessageBody: "See you Saturday!",
    lastMessageAt: "2026-07-07T12:00:00.000Z",
    unreadCount: 2,
  };

  it("parses a valid summary", () => {
    const result = conversationSummary.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects a summary missing storeUserId (buyers need it to block/report the seller)", () => {
    const { storeUserId: _omitted, ...withoutStoreUserId } = valid;
    const result = conversationSummary.safeParse(withoutStoreUserId);
    expect(result.success).toBe(false);
  });

  it("accepts null lastMessageBody/lastMessageAt for a conversation with no messages", () => {
    const result = conversationSummary.safeParse({
      ...valid,
      lastMessageBody: null,
      lastMessageAt: null,
    });
    expect(result.success).toBe(true);
  });

  it("accepts unreadCount of zero", () => {
    const result = conversationSummary.safeParse({ ...valid, unreadCount: 0 });
    expect(result.success).toBe(true);
  });

  it("rejects a negative unreadCount", () => {
    const result = conversationSummary.safeParse({ ...valid, unreadCount: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer unreadCount", () => {
    const result = conversationSummary.safeParse({ ...valid, unreadCount: 1.5 });
    expect(result.success).toBe(false);
  });
});

describe("startConversationInput schema", () => {
  it("parses a valid input", () => {
    const result = startConversationInput.safeParse({ storeId: uuid1 });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid storeId", () => {
    const result = startConversationInput.safeParse({ storeId: "nope" });
    expect(result.success).toBe(false);
  });
});

describe("messagesListInput schema", () => {
  const valid = { conversationId: uuid1 };

  it("applies the default limit of 30", () => {
    const result = messagesListInput.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(30);
      expect(result.data.cursor).toBeUndefined();
    }
  });

  it("accepts limit at the 1 lower bound", () => {
    const result = messagesListInput.safeParse({ ...valid, limit: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts limit at the 100 upper bound", () => {
    const result = messagesListInput.safeParse({ ...valid, limit: 100 });
    expect(result.success).toBe(true);
  });

  it("rejects limit above 100", () => {
    const result = messagesListInput.safeParse({ ...valid, limit: 101 });
    expect(result.success).toBe(false);
  });

  it("rejects limit below 1", () => {
    const result = messagesListInput.safeParse({ ...valid, limit: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer limit", () => {
    const result = messagesListInput.safeParse({ ...valid, limit: 10.5 });
    expect(result.success).toBe(false);
  });

  it("accepts an optional cursor string", () => {
    const result = messagesListInput.safeParse({ ...valid, cursor: "abc123" });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid conversationId", () => {
    const result = messagesListInput.safeParse({ conversationId: "nope" });
    expect(result.success).toBe(false);
  });
});

describe("sendMessageInput schema", () => {
  it("parses a valid input", () => {
    const result = sendMessageInput.safeParse({ conversationId: uuid1, body: "hi!" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty body", () => {
    const result = sendMessageInput.safeParse({ conversationId: uuid1, body: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a body over 2000 characters", () => {
    const result = sendMessageInput.safeParse({
      conversationId: uuid1,
      body: "x".repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

describe("markConversationReadInput schema", () => {
  it("parses a valid input", () => {
    const result = markConversationReadInput.safeParse({ conversationId: uuid1 });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid conversationId", () => {
    const result = markConversationReadInput.safeParse({ conversationId: "nope" });
    expect(result.success).toBe(false);
  });
});

describe("blockUserInput schema", () => {
  it("parses a valid input", () => {
    const result = blockUserInput.safeParse({ userId: uuid1 });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid userId", () => {
    const result = blockUserInput.safeParse({ userId: "nope" });
    expect(result.success).toBe(false);
  });
});

describe("reportMessageInput schema", () => {
  it("parses a valid input", () => {
    const result = reportMessageInput.safeParse({
      messageId: uuid1,
      reason: "Harassing language",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty reason", () => {
    const result = reportMessageInput.safeParse({ messageId: uuid1, reason: "" });
    expect(result.success).toBe(false);
  });

  it("accepts a reason at the 500-character maximum", () => {
    const result = reportMessageInput.safeParse({
      messageId: uuid1,
      reason: "x".repeat(500),
    });
    expect(result.success).toBe(true);
  });

  it("rejects a reason over the 500-character maximum", () => {
    const result = reportMessageInput.safeParse({
      messageId: uuid1,
      reason: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-uuid messageId", () => {
    const result = reportMessageInput.safeParse({ messageId: "nope", reason: "spam" });
    expect(result.success).toBe(false);
  });
});

describe("registerPushTokenInput schema", () => {
  it("parses a valid ios input", () => {
    const result = registerPushTokenInput.safeParse({
      token: "ExponentPushToken[abc123]",
      platform: "ios",
    });
    expect(result.success).toBe(true);
  });

  it("parses a valid android input", () => {
    const result = registerPushTokenInput.safeParse({
      token: "ExponentPushToken[abc123]",
      platform: "android",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown platform", () => {
    const result = registerPushTokenInput.safeParse({
      token: "ExponentPushToken[abc123]",
      platform: "web",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty token", () => {
    const result = registerPushTokenInput.safeParse({ token: "", platform: "ios" });
    expect(result.success).toBe(false);
  });

  it("accepts a token at the 200-character maximum", () => {
    const result = registerPushTokenInput.safeParse({
      token: "x".repeat(200),
      platform: "ios",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a token over the 200-character maximum", () => {
    const result = registerPushTokenInput.safeParse({
      token: "x".repeat(201),
      platform: "ios",
    });
    expect(result.success).toBe(false);
  });
});
