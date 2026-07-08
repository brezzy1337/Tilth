/**
 * Unit tests for createExpoPushClient (the concrete expo-server-sdk wrapper).
 *
 * `expo-server-sdk` is mocked so these tests run with no network access.
 *
 * Coverage (F-037/F-038):
 *   - Filters out invalid Expo push tokens before sending.
 *   - No-ops (never calls the SDK) when every token is invalid / the list is empty.
 *   - Passes title/body/data through to sendPushNotificationsAsync.
 *   - A rejected sendPushNotificationsAsync call is swallowed — `send` never throws.
 *   - Constructing with/without an access token doesn't throw.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const isExpoPushToken = vi.fn();
const sendPushNotificationsAsync = vi.fn();
const chunkPushNotifications = vi.fn();

vi.mock("expo-server-sdk", () => {
  class FakeExpo {
    static isExpoPushToken = isExpoPushToken;
    sendPushNotificationsAsync = sendPushNotificationsAsync;
    chunkPushNotifications = chunkPushNotifications;
  }
  return { Expo: FakeExpo };
});

// Imported AFTER vi.mock so the mocked "expo-server-sdk" module is in effect.
const { createExpoPushClient } = await import("./push");

describe("createExpoPushClient", () => {
  beforeEach(() => {
    isExpoPushToken.mockReset();
    sendPushNotificationsAsync.mockReset();
    chunkPushNotifications.mockReset();
    // Default: single chunk containing everything passed in.
    chunkPushNotifications.mockImplementation((messages: unknown[]) => [messages]);
  });

  it("filters out invalid Expo push tokens before sending", async () => {
    isExpoPushToken.mockImplementation((t: string) => t === "ExponentPushToken[valid]");
    sendPushNotificationsAsync.mockResolvedValue([{ status: "ok", id: "receipt_1" }]);

    const client = createExpoPushClient();
    await client.send({
      tokens: ["ExponentPushToken[valid]", "not-a-real-token"],
      title: "New message",
      body: "hello",
    });

    expect(chunkPushNotifications).toHaveBeenCalledOnce();
    const [messages] = chunkPushNotifications.mock.calls[0] as [Array<{ to: string }>];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.to).toBe("ExponentPushToken[valid]");
  });

  it("no-ops (never calls the SDK) when every token is invalid", async () => {
    isExpoPushToken.mockReturnValue(false);

    const client = createExpoPushClient();
    await client.send({ tokens: ["garbage"], title: "t", body: "b" });

    expect(chunkPushNotifications).not.toHaveBeenCalled();
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it("no-ops when the token list is empty", async () => {
    isExpoPushToken.mockReturnValue(true);

    const client = createExpoPushClient();
    await client.send({ tokens: [], title: "t", body: "b" });

    expect(chunkPushNotifications).not.toHaveBeenCalled();
    expect(sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it("passes title/body/data through to sendPushNotificationsAsync", async () => {
    isExpoPushToken.mockReturnValue(true);
    sendPushNotificationsAsync.mockResolvedValue([{ status: "ok", id: "receipt_1" }]);

    const client = createExpoPushClient();
    await client.send({
      tokens: ["ExponentPushToken[a]"],
      title: "Jane's Farm",
      body: "Are the eggs still available?",
      data: { conversationId: "conv-1" },
    });

    expect(sendPushNotificationsAsync).toHaveBeenCalledOnce();
    const [chunk] = sendPushNotificationsAsync.mock.calls[0] as [
      Array<{ to: string; title: string; body: string; data?: Record<string, unknown> }>,
    ];
    expect(chunk[0]).toEqual({
      to: "ExponentPushToken[a]",
      title: "Jane's Farm",
      body: "Are the eggs still available?",
      data: { conversationId: "conv-1" },
    });
  });

  it("a rejected sendPushNotificationsAsync call is swallowed — send never throws", async () => {
    isExpoPushToken.mockReturnValue(true);
    sendPushNotificationsAsync.mockRejectedValue(new Error("Expo API down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = createExpoPushClient();
    await expect(
      client.send({ tokens: ["ExponentPushToken[a]"], title: "t", body: "b" }),
    ).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("constructing without an access token doesn't throw", () => {
    expect(() => createExpoPushClient()).not.toThrow();
  });

  it("constructing with an access token doesn't throw", () => {
    expect(() => createExpoPushClient("dummy-token")).not.toThrow();
  });
});
