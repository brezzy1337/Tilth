/**
 * Unit tests for createStripeClient (the concrete Stripe SDK wrapper).
 *
 * The `stripe` package is mocked so these tests run with no network access and
 * no real API key — we only assert the SHAPE of the calls made to the SDK.
 *
 * Coverage (F-026 manual-capture):
 *   - createPaymentIntent passes `capture_method: "manual"` (funds are only
 *     AUTHORIZED at checkout; capture is deferred to fulfillment).
 *   - capturePaymentIntent calls `stripe.paymentIntents.capture(id)` and
 *     returns `{ status }` from the response.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const paymentIntentsCreate = vi.fn();
const paymentIntentsCapture = vi.fn();
const paymentIntentsRetrieve = vi.fn();
const paymentIntentsCancel = vi.fn();

vi.mock("stripe", () => {
  class FakeStripe {
    paymentIntents = {
      create: paymentIntentsCreate,
      capture: paymentIntentsCapture,
      retrieve: paymentIntentsRetrieve,
      cancel: paymentIntentsCancel,
    };
  }
  return { default: FakeStripe };
});

// Imported AFTER vi.mock so the mocked "stripe" module is in effect.
const { createStripeClient } = await import("./stripe");

describe("createStripeClient — createPaymentIntent (manual capture, F-026)", () => {
  beforeEach(() => {
    paymentIntentsCreate.mockReset();
    paymentIntentsCapture.mockReset();
  });

  it("passes capture_method: 'manual' to stripe.paymentIntents.create", async () => {
    paymentIntentsCreate.mockResolvedValue({
      id: "pi_test_manual",
      client_secret: "pi_test_manual_secret",
    });

    const client = createStripeClient("sk_test_fake", {
      refreshUrl: "https://example.com/refresh",
      returnUrl: "https://example.com/return",
    });

    const result = await client.createPaymentIntent({
      amountCents: 1000,
      applicationFeeCents: 100,
      destinationAccountId: "acct_test123",
      metadata: { orderId: "order_1" },
      idempotencyKey: "idem_1",
    });

    expect(result).toEqual({ id: "pi_test_manual", clientSecret: "pi_test_manual_secret" });

    expect(paymentIntentsCreate).toHaveBeenCalledOnce();
    const [params, options] = paymentIntentsCreate.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];

    // The core money-path assertion: manual capture, not automatic.
    expect(params.capture_method).toBe("manual");

    // Existing destination-charge shape must be preserved unchanged.
    expect(params.amount).toBe(1000);
    expect(params.currency).toBe("usd");
    expect(params.application_fee_amount).toBe(100);
    expect(params.transfer_data).toEqual({ destination: "acct_test123" });
    expect(params.metadata).toEqual({ orderId: "order_1" });
    expect(options).toEqual({ idempotencyKey: "idem_1" });
  });

  it("throws if Stripe does not return a client_secret", async () => {
    paymentIntentsCreate.mockResolvedValue({ id: "pi_no_secret", client_secret: null });

    const client = createStripeClient("sk_test_fake", {
      refreshUrl: "https://example.com/refresh",
      returnUrl: "https://example.com/return",
    });

    await expect(
      client.createPaymentIntent({
        amountCents: 500,
        applicationFeeCents: 50,
        destinationAccountId: "acct_test456",
        metadata: {},
        idempotencyKey: "idem_2",
      }),
    ).rejects.toThrow(/client_secret/);
  });
});

describe("createStripeClient — capturePaymentIntent (F-026)", () => {
  beforeEach(() => {
    paymentIntentsCreate.mockReset();
    paymentIntentsCapture.mockReset();
  });

  it("calls stripe.paymentIntents.capture(id) and returns the resulting status", async () => {
    paymentIntentsCapture.mockResolvedValue({ id: "pi_test_capture", status: "succeeded" });

    const client = createStripeClient("sk_test_fake", {
      refreshUrl: "https://example.com/refresh",
      returnUrl: "https://example.com/return",
    });

    const result = await client.capturePaymentIntent("pi_test_capture");

    expect(paymentIntentsCapture).toHaveBeenCalledOnce();
    expect(paymentIntentsCapture).toHaveBeenCalledWith("pi_test_capture");
    expect(result).toEqual({ status: "succeeded" });
  });
});
