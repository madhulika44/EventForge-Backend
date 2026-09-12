import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { Role } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { processRefund } from "../src/services/refund.service";
import { signFakeWebhookPayload, forceNextFakeRefundFailure } from "../src/providers/fake-payment-provider";

const app = createApp();

interface TestUser {
  id: string;
  accessToken: string;
}

const createdUserIds: string[] = [];
const createdEventIds: string[] = [];

afterAll(async () => {
  if (createdEventIds.length > 0) {
    const bookings = await prisma.booking.findMany({ where: { eventId: { in: createdEventIds } }, select: { id: true } });
    const bookingIds = bookings.map((b) => b.id);
    if (bookingIds.length > 0) {
      const payments = await prisma.payment.findMany({ where: { bookingId: { in: bookingIds } }, select: { id: true } });
      const paymentIds = payments.map((p) => p.id);
      if (paymentIds.length > 0) {
        await prisma.refund.deleteMany({ where: { paymentId: { in: paymentIds } } });
      }
      await prisma.payment.deleteMany({ where: { bookingId: { in: bookingIds } } });
    }
    await prisma.booking.deleteMany({ where: { eventId: { in: createdEventIds } } });
    await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

function uniqueEmail(): string {
  return `refund-test-${randomUUID()}@example.com`;
}

async function registerUser(name: string): Promise<TestUser> {
  const res = await request(app).post("/api/auth/register").send({ name, email: uniqueEmail(), password: "password123" });
  createdUserIds.push(res.body.data.user.id);
  return { id: res.body.data.user.id, accessToken: res.body.data.accessToken };
}

async function registerAdmin(name: string): Promise<TestUser> {
  const user = await registerUser(name);
  await prisma.user.update({ where: { id: user.id }, data: { role: Role.ADMIN } });
  const email = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email;
  const loginRes = await request(app).post("/api/auth/login").send({ email, password: "password123" });
  return { id: user.id, accessToken: loginRes.body.data.accessToken };
}

async function createEventAs(token: string) {
  const res = await request(app)
    .post("/api/events")
    .set("Authorization", `Bearer ${token}`)
    .send({ title: `Test Event ${randomUUID()}`, startDateTime: "2026-12-15T10:00:00Z", endDateTime: "2026-12-15T18:00:00Z" });
  createdEventIds.push(res.body.data.event.id);
  return res;
}

async function publishEvent(token: string, eventId: string) {
  return request(app).patch(`/api/events/${eventId}`).set("Authorization", `Bearer ${token}`).send({ status: "PUBLISHED" });
}

async function createTicketTypeAs(token: string, eventId: string) {
  return request(app)
    .post(`/api/events/${eventId}/ticket-types`)
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Tier ${randomUUID()}`, price: 1000, quantity: 100, status: "ACTIVE" });
}

async function sendWebhook(payload: Record<string, unknown>, signatureOverride?: string) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = signatureOverride ?? signFakeWebhookPayload(rawBody);
  // See tests/payment.test.ts: must send the string form, not the Buffer,
  // or supertest JSON-stringifies the Buffer object itself.
  return request(app)
    .post("/api/payments/webhook/stripe")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", signature)
    .send(rawBody.toString("utf-8"));
}

function succeededPaymentPayload(payment: { providerPaymentId: string; amount: unknown; currency: string }) {
  return {
    id: `evt_${randomUUID()}`,
    type: "payment_intent.succeeded",
    providerPaymentId: payment.providerPaymentId,
    amount: Number(payment.amount).toFixed(2),
    currency: payment.currency,
    providerRefundId: "",
    refundStatus: "",
  };
}

function refundWebhookPayload(refund: { providerRefundId: string | null }, refundStatus: "succeeded" | "failed") {
  return {
    id: `evt_${randomUUID()}`,
    type: "refund.updated",
    providerPaymentId: "",
    amount: "0.00",
    currency: "",
    providerRefundId: refund.providerRefundId,
    refundStatus,
  };
}

/** Registers organizer + customer, creates & publishes an event with one
 * ACTIVE GA ticket type, books it, pays for it, and confirms via webhook.
 * Returns everything needed to then cancel/refund it. */
async function setupConfirmedBooking(): Promise<{
  organizer: TestUser;
  customer: TestUser;
  eventId: string;
  bookingId: string;
  paymentId: string;
}> {
  const organizer = await registerUser("Organizer");
  const customer = await registerUser("Customer");
  const event = await createEventAs(organizer.accessToken);
  const eventId = event.body.data.event.id;
  await publishEvent(organizer.accessToken, eventId);
  const ticketType = await createTicketTypeAs(organizer.accessToken, eventId);

  const booking = await request(app)
    .post("/api/bookings")
    .set("Authorization", `Bearer ${customer.accessToken}`)
    .send({ eventId, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 2 }] });
  const bookingId = booking.body.data.booking.id;

  const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });

  await sendWebhook(succeededPaymentPayload(payment));

  return { organizer, customer, eventId, bookingId, paymentId: payment.id };
}

describe("Automatic refund on cancellation", () => {
  it("creates a refund workflow when a CONFIRMED (paid) booking is cancelled", async () => {
    const { customer, bookingId, paymentId } = await setupConfirmedBooking();

    const cancelRes = await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.booking.status).toBe("CANCELLED");

    const refund = await prisma.refund.findFirst({ where: { paymentId } });
    expect(refund).not.toBeNull();
    expect(refund?.status).toBe("PENDING");
  });

  it("creates no refund when a PENDING (unpaid) booking is cancelled", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const event = await createEventAs(organizer.accessToken);
    await publishEvent(organizer.accessToken, event.body.data.event.id);
    const ticketType = await createTicketTypeAs(organizer.accessToken, event.body.data.event.id);

    const booking = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: event.body.data.event.id, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 1 }] });

    const cancelRes = await request(app)
      .post(`/api/bookings/${booking.body.data.booking.id}/cancel`)
      .set("Authorization", `Bearer ${customer.accessToken}`);
    expect(cancelRes.status).toBe(200);

    const refundCount = await prisma.refund.count({
      where: { payment: { bookingId: booking.body.data.booking.id } },
    });
    expect(refundCount).toBe(0);
  });
});

describe("Refund processing", () => {
  it("succeeds via processRefund and records the provider refund id", async () => {
    const { customer, bookingId, paymentId } = await setupConfirmedBooking();
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);

    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId } });
    await processRefund(refund.id);

    const updated = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(updated.status).toBe("SUCCEEDED");
    expect(updated.providerRefundId).not.toBeNull();
  });

  it("marks the refund FAILED when the provider call fails, with a recorded reason", async () => {
    const { customer, bookingId, paymentId } = await setupConfirmedBooking();
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);

    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId } });
    forceNextFakeRefundFailure();
    await processRefund(refund.id);

    const updated = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.failureReason).toEqual(expect.any(String));
  });

  it("lets a FAILED refund be retried successfully by an admin", async () => {
    const { customer, bookingId, paymentId } = await setupConfirmedBooking();
    const admin = await registerAdmin("Admin");
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);

    const firstRefund = await prisma.refund.findFirstOrThrow({ where: { paymentId } });
    forceNextFakeRefundFailure();
    await processRefund(firstRefund.id);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: firstRefund.id } })).status).toBe("FAILED");

    const retryRes = await request(app).post(`/api/bookings/${bookingId}/refund`).set("Authorization", `Bearer ${admin.accessToken}`);
    expect(retryRes.status).toBe(200);
    const newRefundId = retryRes.body.data.refund.id;
    expect(newRefundId).not.toBe(firstRefund.id); // a fresh attempt, not the failed one

    await processRefund(newRefundId);
    const finalRefund = await prisma.refund.findUniqueOrThrow({ where: { id: newRefundId } });
    expect(finalRefund.status).toBe("SUCCEEDED");
  });

  it("does not duplicate a refund on a repeated attempt (idempotent)", async () => {
    const { customer, bookingId, paymentId } = await setupConfirmedBooking();

    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);
    // Cancelling again is itself idempotent (existing Phase 5 behavior) and
    // must not trigger a second refund trigger either.
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);

    const count = await prisma.refund.count({ where: { paymentId } });
    expect(count).toBe(1);
  });

  it("handles concurrent refund-trigger attempts without creating two active refunds", async () => {
    const { customer, bookingId, paymentId } = await setupConfirmedBooking();
    const admin = await registerAdmin("Admin");

    // Cancel (which triggers a refund) and an admin manual retry racing at
    // essentially the same time.
    await Promise.all([
      request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`),
      (async () => {
        // Give cancel a head start so the booking is actually CANCELLED by
        // the time retry checks it, without eliminating the real race on
        // refund creation itself (both still hit ensureRefundForPayment
        // close together).
        await new Promise((r) => setTimeout(r, 10));
        return request(app).post(`/api/bookings/${bookingId}/refund`).set("Authorization", `Bearer ${admin.accessToken}`);
      })(),
    ]);

    const activeCount = await prisma.refund.count({
      where: { paymentId, status: { in: ["PENDING", "SUCCEEDED"] } },
    });
    expect(activeCount).toBe(1);
  });
});

describe("Refund webhook", () => {
  it("transitions a PENDING refund to SUCCEEDED", async () => {
    const { customer, bookingId, paymentId } = await setupConfirmedBooking();
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);
    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId } });
    await processRefund(refund.id); // sets providerRefundId (fake provider succeeds synchronously already, but exercise the webhook path too)

    const withProviderId = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    const res = await sendWebhook(refundWebhookPayload(withProviderId, "succeeded"));
    expect(res.status).toBe(200);

    const finalRefund = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(finalRefund.status).toBe("SUCCEEDED");
  });

  it("is safe/idempotent when the same refund webhook is delivered twice", async () => {
    const { customer, bookingId, paymentId } = await setupConfirmedBooking();
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);
    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId } });

    // Simulate: our own worker call to the provider hasn't happened yet,
    // but a providerRefundId already exists (as if createRefund succeeded)
    // so the webhook alone can be exercised deterministically.
    const fakeProviderId = `fake_re_${randomUUID()}`;
    await prisma.refund.update({ where: { id: refund.id }, data: { providerRefundId: fakeProviderId } });
    const withProviderId = { providerRefundId: fakeProviderId };

    const payload = refundWebhookPayload(withProviderId, "succeeded");
    const first = await sendWebhook(payload);
    const second = await sendWebhook(payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const finalRefund = await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(finalRefund.status).toBe("SUCCEEDED");
  });

  it("handles a webhook for an unknown refund safely", async () => {
    const res = await sendWebhook(refundWebhookPayload({ providerRefundId: "fake_re_does_not_exist" }, "succeeded"));
    expect(res.status).toBe(200);
  });

  it("handles a webhook for an unknown payment safely (existing payment behavior unaffected)", async () => {
    const res = await sendWebhook({
      id: `evt_${randomUUID()}`,
      type: "payment_intent.succeeded",
      providerPaymentId: "fake_pi_does_not_exist",
      amount: "10.00",
      currency: "INR",
      providerRefundId: "",
      refundStatus: "",
    });
    expect(res.status).toBe(200);
  });
});

describe("Manual admin refund retry — authorization", () => {
  it("rejects a non-admin (booking owner)", async () => {
    const { customer, bookingId } = await setupConfirmedBooking();
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);

    const res = await request(app).post(`/api/bookings/${bookingId}/refund`).set("Authorization", `Bearer ${customer.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const { customer, bookingId } = await setupConfirmedBooking();
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);

    const res = await request(app).post(`/api/bookings/${bookingId}/refund`);
    expect(res.status).toBe(401);
  });

  it("rejects retrying a refund for a booking that isn't cancelled", async () => {
    const { bookingId } = await setupConfirmedBooking(); // still CONFIRMED, not cancelled
    const admin = await registerAdmin("Admin");

    const res = await request(app).post(`/api/bookings/${bookingId}/refund`).set("Authorization", `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BOOKING_NOT_REFUNDABLE");
  });

  it("never accepts a client-supplied refund amount", async () => {
    const { customer, bookingId, paymentId } = await setupConfirmedBooking();
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);
    const admin = await registerAdmin("Admin");

    const res = await request(app)
      .post(`/api/bookings/${bookingId}/refund`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ amount: "1.00" }); // ignored — the endpoint never reads a body

    expect(res.status).toBe(200);
    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId } });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(refund.amount.toString()).toBe(payment.amount.toString());
  });

  it("never exposes provider ids or the idempotency key in the response", async () => {
    const { customer, bookingId } = await setupConfirmedBooking();
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);
    const admin = await registerAdmin("Admin");

    const res = await request(app).post(`/api/bookings/${bookingId}/refund`).set("Authorization", `Bearer ${admin.accessToken}`);
    expect(res.body.data.refund).not.toHaveProperty("providerRefundId");
    expect(res.body.data.refund).not.toHaveProperty("idempotencyKey");
    expect(res.body.data.refund).not.toHaveProperty("providerEventId");
  });
});
