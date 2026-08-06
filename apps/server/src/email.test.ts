/**
 * Unit tests for email.ts — the SendGrid `EmailClient`.
 *
 * `global.fetch` is stubbed so these tests never hit the network. No DB, no
 * env — `createSendGridEmailClient` takes its API key/from-address as
 * parameters.
 *
 * F-054 review fix #6: a failed SendGrid send used to log the RAW response
 * body, which can echo the recipient address back on a validation error —
 * contradicting this file's own "never log the recipient" rule. The tests
 * below assert the failure-path log is redacted: it must carry the response
 * status and at most `field`/`help`, and must NEVER contain the recipient
 * address or a raw `message` field from SendGrid's error body.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { emailEnabled, createSendGridEmailClient } from "./email";

describe("emailEnabled", () => {
  it("is false for undefined", () => {
    expect(emailEnabled(undefined)).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(emailEnabled("")).toBe(false);
  });

  it("is true for a non-empty key", () => {
    expect(emailEnabled("SG.fake-key")).toBe(true);
  });
});

describe("createSendGridEmailClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends a POST to the SendGrid v3 mail/send endpoint with the expected shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    const client = createSendGridEmailClient("sg-fake-key", "noreply@tilth.market");
    await client.sendEmail({
      to: "buyer@example.com",
      subject: "Your Tilth restore code",
      text: "Your code is 042137.",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer sg-fake-key");

    const body = JSON.parse(init.body as string) as {
      personalizations: { to: { email: string }[] }[];
      from: { email: string; name: string };
      subject: string;
    };
    expect(body.personalizations[0]?.to[0]?.email).toBe("buyer@example.com");
    expect(body.from).toEqual({ email: "noreply@tilth.market", name: "Tilth" });
    expect(body.subject).toBe("Your Tilth restore code");
  });

  it("on failure: logs status + redacted field/help only — never the raw body or recipient address", async () => {
    const rawBody = JSON.stringify({
      errors: [
        {
          message: "The to email does not contain a valid address: buyer@example.com",
          field: "personalizations.0.to.0.email",
          help: "http://sendgrid.com/docs/errors.html",
        },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => rawBody });
    vi.stubGlobal("fetch", fetchMock);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = createSendGridEmailClient("sg-fake-key", "noreply@tilth.market");
    await expect(
      client.sendEmail({ to: "buyer@example.com", subject: "s", text: "t" }),
    ).rejects.toThrow("SendGrid send failed with status 400");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = errorSpy.mock.calls[0]!.join(" ");
    expect(logged).toContain("400");
    expect(logged).toContain("personalizations.0.to.0.email");
    expect(logged).toContain("http://sendgrid.com/docs/errors.html");
    // Never the recipient address, and never the raw `message` field.
    expect(logged).not.toContain("buyer@example.com");
    expect(logged).not.toContain("does not contain a valid address");
  });

  it("on failure with an unparseable body: logs status + a fixed redacted placeholder, never the raw body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, text: async () => "<html>secret@example.com</html>" });
    vi.stubGlobal("fetch", fetchMock);

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const client = createSendGridEmailClient("sg-fake-key", "noreply@tilth.market");
    await expect(
      client.sendEmail({ to: "secret@example.com", subject: "s", text: "t" }),
    ).rejects.toThrow("SendGrid send failed with status 500");

    const logged = errorSpy.mock.calls[0]!.join(" ");
    expect(logged).toContain("500");
    expect(logged).not.toContain("secret@example.com");
    expect(logged).not.toContain("<html>");
  });
});
