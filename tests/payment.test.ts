import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { expireDueBookings } from "../src/services/booking.service";
import { handleStripeWebhook } from "../src/services/payment.service";
import { signFakeWebhookPayload } from "../src/providers/fake-payment-provider";

const app = createApp();

interface TestUser {
  id: string;
  accessToken: string;
}

const createdUserIds: string[] = [];
const createdEventIds: string[] = [];

afterAll(async () => {
  if (createdEventIds.length > 0) {
    // Payments -> Bookings -> Events, in that order (all Restrict relations).
    const bookings = await prisma.booking.findMany({ where: { eventId: { in: createdEventIds } }, select: { id: true } });
    const bookingIds = bookings.map((b) => b.id);
    if (bookingIds.length > 0) {
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
  return `payment-test-${randomUUID()}@example.com`;
}

async function registerUser(name: string): Promise<TestUser> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name, email: uniqueEmail(), password: "password123" });
  createdUserIds.push(res.body.data.user.id);
  return { id: res.body.data.user.id, accessToken: res.body.data.accessToken };
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

async function createTicketTypeAs(token: string, eventId: string, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/events/${eventId}/ticket-types`)
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Tier ${randomUUID()}`, price: 1000, quantity: 100, status: "ACTIVE", ...overrides });
}

async function setupPendingBooking(): Promise<{ organizer: TestUser; customer: TestUser; eventId: string; bookingId: string }> {
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

  return { organizer, customer, eventId, bookingId: booking.body.data.booking.id };
}

async function backdateExpiry(bookingId: string, msAgo: number): Promise<void> {
  await prisma.booking.update({ where: { id: bookingId }, data: { expiresAt: new Date(Date.now() - msAgo) } });
}

async function sendWebhook(payload: Record<string, unknown>, signatureOverride?: string) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = signatureOverride ?? signFakeWebhookPayload(rawBody);
  // Sending the string form (not the Buffer itself) matters here: supertest
  // only skips its own JSON.stringify step when the body is already a
  // string — handing it a Buffer with Content-Type "application/json" gets
  // the Buffer object itself serialized as {"type":"Buffer","data":[...]}
  // instead of transmitting its raw bytes, which silently breaks signature
  // verification (found while writing this test).
  return request(app)
    .post("/api/payments/webhook/stripe")
    .set("Content-Type", "application/json")
    .set("Stripe-Signature", signature)
    .send(rawBody.toString("utf-8"));
}

function succeededPayload(payment: { providerPaymentId: string; amount: unknown; currency: string }, overrides: Record<string, unknown> = {}) {
  return {
    id: `evt_${randomUUID()}`,
    type: "payment_intent.succeeded",
    providerPaymentId: payment.providerPaymentId,
    amount: Number(payment.amount).toFixed(2),
    currency: payment.currency,
    ...overrides,
  };
}

describe("Payment creation", () => {
  it("creates a payment for a valid PENDING booking", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const res = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    expect(res.status).toBe(201);
    expect(res.body.data.payment.status).toBe("PENDING");
    expect(res.body.data.clientSecret).toEqual(expect.any(String));
  });

  it("rejects payment creation for an unauthenticated request", async () => {
    const { bookingId } = await setupPendingBooking();
    const res = await request(app).post(`/api/bookings/${bookingId}/payment`);
    expect(res.status).toBe(401);
  });

  it("rejects payment creation for another user's booking", async () => {
    const { bookingId } = await setupPendingBooking();
    const other = await registerUser("Other");
    const res = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${other.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("rejects payment creation for a CANCELLED booking", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);

    const res = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BOOKING_NOT_PAYABLE");
  });

  it("rejects payment creation for an EXPIRED booking", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    await backdateExpiry(bookingId, 60_000);

    const res = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BOOKING_NOT_PAYABLE");
  });

  it("derives the payment amount from Booking.total, not the client", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

    const res = await request(app)
      .post(`/api/bookings/${bookingId}/payment`)
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ amount: "1.00" }); // ignored — no such field is even read

    expect(Number(res.body.data.payment.amount)).toBe(Number(booking.total));
  });

  it("uses Booking.currency for the payment", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });

    const res = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    expect(res.body.data.payment.currency).toBe(booking.currency);
  });
});

describe("Webhook processing", () => {
  it("confirms the Booking on a successful webhook", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });

    const webhookRes = await sendWebhook(succeededPayload(payment));
    expect(webhookRes.status).toBe(200);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("CONFIRMED");
  });

  it("confirms all BookingItems alongside the Booking", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });

    await sendWebhook(succeededPayload(payment));

    const items = await prisma.bookingItem.findMany({ where: { bookingId } });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.status).toBe("CONFIRMED");
    }
  });

  it("is safe/idempotent when the same webhook is delivered twice", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });
    const payload = succeededPayload(payment);

    const first = await sendWebhook(payload);
    const second = await sendWebhook(payload);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("CONFIRMED");
    // updatedAt should reflect only one real transition, not two.
    const finalPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(finalPayment.status).toBe("SUCCEEDED");
  });

  it("rejects a webhook with an invalid signature", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });

    const res = await sendWebhook(succeededPayload(payment), "clearly-wrong-signature");
    expect(res.status).toBe(400);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("PENDING"); // unaffected
  });

  it("handles a webhook for an unknown payment id safely", async () => {
    const res = await sendWebhook({
      id: `evt_${randomUUID()}`,
      type: "payment_intent.succeeded",
      providerPaymentId: "fake_pi_does_not_exist",
      amount: "10.00",
      currency: "INR",
    });
    expect(res.status).toBe(200); // acknowledged, safely ignored
  });

  it("rejects (without confirming) a webhook reporting the wrong amount", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });

    const res = await sendWebhook(succeededPayload(payment, { amount: "1.00" }));
    expect(res.status).toBe(200); // acknowledged to the provider, but...

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("PENDING"); // ...never confirmed
  });

  it("rejects (without confirming) a webhook reporting the wrong currency", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });

    const res = await sendWebhook(succeededPayload(payment, { currency: "USD" }));
    expect(res.status).toBe(200);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("PENDING");
  });

  it("does not confirm a booking that was already CANCELLED before the webhook arrived", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });

    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);
    await sendWebhook(succeededPayload(payment));

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { items: true } });
    expect(booking.status).toBe("CANCELLED");
    for (const item of booking.items) {
      expect(item.status).toBe("CANCELLED");
    }
    // The payment is still recorded as succeeded — the money moved — even
    // though the booking couldn't be confirmed; see the Phase 6 report.
    const finalPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(finalPayment.status).toBe("SUCCEEDED");
  });

  it("does not confirm a booking that had already EXPIRED before the webhook arrived", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });

    await backdateExpiry(bookingId, 60_000);
    await expireDueBookings();
    await sendWebhook(succeededPayload(payment));

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { items: true } });
    expect(booking.status).toBe("EXPIRED");
    for (const item of booking.items) {
      expect(item.status).toBe("EXPIRED");
    }
  });
});

describe("Expiry worker logic", () => {
  it("expires a stale PENDING booking", async () => {
    const { bookingId } = await setupPendingBooking();
    await backdateExpiry(bookingId, 60_000);

    const { expiredCount } = await expireDueBookings();
    expect(expiredCount).toBeGreaterThanOrEqual(1);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("EXPIRED");
  });

  it("updates BookingItems transactionally alongside the Booking", async () => {
    const { bookingId } = await setupPendingBooking();
    await backdateExpiry(bookingId, 60_000);
    await expireDueBookings();

    const items = await prisma.bookingItem.findMany({ where: { bookingId } });
    for (const item of items) {
      expect(item.status).toBe("EXPIRED");
    }
  });

  it("is safe to run twice in a row", async () => {
    const { bookingId } = await setupPendingBooking();
    await backdateExpiry(bookingId, 60_000);

    await expireDueBookings();
    const second = await expireDueBookings();

    // The booking was already expired by the first run, so the second
    // finds nothing due for it specifically — no error, no double-processing.
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("EXPIRED");
    expect(second.expiredCount).toBe(0);
  });

  it("does not expire an already-CANCELLED booking", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    await request(app).post(`/api/bookings/${bookingId}/cancel`).set("Authorization", `Bearer ${customer.accessToken}`);
    await backdateExpiry(bookingId, 60_000);

    await expireDueBookings();

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("CANCELLED");
  });

  it("does not expire an already-CONFIRMED booking", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });
    await sendWebhook(succeededPayload(payment));

    await backdateExpiry(bookingId, 60_000);
    await expireDueBookings();

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe("CONFIRMED");
  });

  it("makes inventory available again after expiry", async () => {
    const { organizer, eventId } = await setupPendingBooking();
    const ticketType = await createTicketTypeAs(organizer.accessToken, eventId, { quantity: 2 });
    const ticketTypeId = ticketType.body.data.ticketType.id;
    const buyer = await registerUser("Buyer");

    const first = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${buyer.accessToken}`)
      .send({ eventId, items: [{ ticketTypeId, quantity: 2 }] });
    expect(first.status).toBe(201);
    await backdateExpiry(first.body.data.booking.id, 60_000);
    await expireDueBookings();

    const second = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${buyer.accessToken}`)
      .send({ eventId, items: [{ ticketTypeId, quantity: 2 }] });
    expect(second.status).toBe(201);
  });
});

describe("Payment-vs-expiry race", () => {
  it("leaves the booking in exactly one valid, internally-consistent terminal state", async () => {
    const { customer, bookingId } = await setupPendingBooking();
    const paymentRes = await request(app).post(`/api/bookings/${bookingId}/payment`).set("Authorization", `Bearer ${customer.accessToken}`);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentRes.body.data.payment.id } });

    await backdateExpiry(bookingId, 60_000);

    const rawBody = Buffer.from(JSON.stringify(succeededPayload(payment)));
    const signature = signFakeWebhookPayload(rawBody);

    // Genuinely concurrent: the expiry sweep and the webhook confirmation
    // race for the same already-due booking.
    await Promise.all([expireDueBookings(), handleStripeWebhook(rawBody, signature)]);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId }, include: { items: true } });
    expect(["CONFIRMED", "EXPIRED"]).toContain(booking.status);
    // Whichever won, Booking and every BookingItem must agree — never a
    // mix of CONFIRMED items under an EXPIRED booking or vice versa.
    for (const item of booking.items) {
      expect(item.status).toBe(booking.status);
    }

    // The payment succeeded regardless of which side of the race it landed on.
    const finalPayment = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(finalPayment.status).toBe("SUCCEEDED");
  });
});
