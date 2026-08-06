/**
 * Unit tests for email.ts — the Resend `EmailClient`.
 *
 * `global.fetch` is stubbed so these tests never hit the network. No DB, no
 * env — `createResendEmailClient` takes its API key/from-address as
 * parameters.
 *
 * F-054 review fix #6 (carried through the provider swap to Resend): a failed
 * send must never log the RAW response body, which can echo the recipient
 * address back on a validation error — contradicting this file's own "never
 * log the recipient" rule. The tests below assert the failure-path log is
 * redacted: it must carry the response status and at most the error `name`,
 * and must NEVER contain the recipient address or a raw `message` field from
 * Resend's error body.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { emailEnabled, createResendEmailClient } from "./email";

describe("emailEnabled", () => {
  it("is false for undefined", () => {
    expect(emailEnabled(undefined)).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(emailEnabled("")).toBe(false);
  });

  it("is true for a non-empty key", () => {
    expect(emailEnabled("re_fake-key")).toBe(true);
  });
});

describe("createResendEmailClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a POST to the Resend emails endpoint with the expected shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const client = createResendEmailClient("re_fake-key", "noreply@tilth.market");
    await client.sendEmail({
      to: "buyer@example.com",
      subject: "Your Tilth restore code",
      text: "Your code is 042137.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer re_fake-key");

    const body = JSON.parse(init.body as string) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
    };
    expect(body.from).toBe("Tilth <noreply@tilth.market>");
    expect(body.to).toEqual(["buyer@example.com"]);
    expect(body.subject).toBe("Your Tilth restore code");
    expect(body.text).toBe("Your code is 042137.");
  });

  it("on failure: logs status + redacted error name only — never the raw body, message, or recipient address", async () => {
    const rawBody = JSON.stringify({
      statusCode: 422,
      name: "validation_error",
      message: "Invalid `to` field. The email address buyer@example.com is not valid.",
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 422, text: async () => rawBody });
    vi.stubGlobal("fetch", fetchMock);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = createResendEmailClient("re_fake-key", "noreply@tilth.market");
    await expect(
      client.sendEmail({ to: "buyer@example.com", subject: "s", text: "t" }),
    ).rejects.toThrow("Resend send failed with status 422");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0]!.join(" ");
    expect(logged).toContain("422");
    expect(logged).toContain("validation_error");
    // Never the recipient address, and never the raw `message` field.
    expect(logged).not.toContain("buyer@example.com");
    expect(logged).not.toContain("is not valid");
    expect(logged).not.toContain("message");
  });

  it("on failure with an unparseable body: logs status + a fixed redacted placeholder, never the raw body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => "<html>secret@example.com</html>" });
    vi.stubGlobal("fetch", fetchMock);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = createResendEmailClient("re_fake-key", "noreply@tilth.market");
    await expect(
      client.sendEmail({ to: "secret@example.com", subject: "s", text: "t" }),
    ).rejects.toThrow("Resend send failed with status 500");

    const logged = errorSpy.mock.calls[0]!.join(" ");
    expect(logged).toContain("500");
    expect(logged).not.toContain("secret@example.com");
    expect(logged).not.toContain("<html>");
  });
});
