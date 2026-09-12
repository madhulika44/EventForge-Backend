import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { Role } from "@prisma/client";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";

const app = createApp();

interface TestUser {
  id: string;
  accessToken: string;
}

const createdUserIds: string[] = [];
const createdEventIds: string[] = [];
const createdVenueIds: string[] = [];

afterAll(async () => {
  if (createdEventIds.length > 0) {
    await prisma.booking.deleteMany({ where: { eventId: { in: createdEventIds } } });
    await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
  }
  if (createdVenueIds.length > 0) {
    await prisma.venue.deleteMany({ where: { id: { in: createdVenueIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

function uniqueEmail(): string {
  return `event-booking-test-${randomUUID()}@example.com`;
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

async function createTicketTypeAs(token: string, eventId: string, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/events/${eventId}/ticket-types`)
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Tier ${randomUUID()}`, price: 1000, quantity: 100, status: "ACTIVE", ...overrides });
}

async function setupEventWithBooking(customerName = "Attendee") {
  const organizer = await registerUser("Organizer");
  const customer = await registerUser(customerName);
  const event = await createEventAs(organizer.accessToken);
  const eventId = event.body.data.event.id;
  await publishEvent(organizer.accessToken, eventId);
  const ticketType = await createTicketTypeAs(organizer.accessToken, eventId);

  const booking = await request(app)
    .post("/api/bookings")
    .set("Authorization", `Bearer ${customer.accessToken}`)
    .send({ eventId, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 2 }] });

  return { organizer, customer, eventId, bookingId: booking.body.data.booking.id, ticketTypeId: ticketType.body.data.ticketType.id };
}

const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

describe("GET /api/events/:eventId/bookings", () => {
  it("lets the organizer list their own event's bookings", async () => {
    const { organizer, customer, eventId } = await setupEventWithBooking("Alice Attendee");

    const res = await request(app).get(`/api/events/${eventId}/bookings`).set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].attendee.name).toBe("Alice Attendee");
    expect(res.body.data[0].attendee.email).toBeDefined();
    void customer;
  });

  it("rejects another organizer (403)", async () => {
    const { eventId } = await setupEventWithBooking();
    const otherOrganizer = await registerUser("Other Organizer");

    const res = await request(app).get(`/api/events/${eventId}/bookings`).set("Authorization", `Bearer ${otherOrganizer.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("lets ADMIN access any event's bookings", async () => {
    const { eventId } = await setupEventWithBooking();
    const admin = await registerAdmin("Admin");

    const res = await request(app).get(`/api/events/${eventId}/bookings`).set("Authorization", `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
  });

  it("rejects an unauthenticated request", async () => {
    const { eventId } = await setupEventWithBooking();
    const res = await request(app).get(`/api/events/${eventId}/bookings`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-existent event", async () => {
    const organizer = await registerUser("Organizer");
    const res = await request(app).get(`/api/events/${NON_EXISTENT_ID}/bookings`).set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(res.status).toBe(404);
  });

  it("paginates correctly across multiple bookings", async () => {
    const organizer = await registerUser("Organizer");
    const event = await createEventAs(organizer.accessToken);
    const eventId = event.body.data.event.id;
    await publishEvent(organizer.accessToken, eventId);
    const ticketType = await createTicketTypeAs(organizer.accessToken, eventId, { quantity: 100 });

    const bookingIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const customer = await registerUser(`Buyer ${i}`);
      const booking = await request(app)
        .post("/api/bookings")
        .set("Authorization", `Bearer ${customer.accessToken}`)
        .send({ eventId, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 1 }] });
      bookingIds.push(booking.body.data.booking.id);
    }

    const firstPage = await request(app)
      .get(`/api/events/${eventId}/bookings?page=1&limit=2`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.length).toBeLessThanOrEqual(2);
    expect(firstPage.body.pagination).toMatchObject({ page: 1, limit: 2, total: 3 });

    const seenIds = new Set<string>();
    for (let page = 1; page <= firstPage.body.pagination.totalPages; page++) {
      const res = await request(app)
        .get(`/api/events/${eventId}/bookings?page=${page}&limit=2`)
        .set("Authorization", `Bearer ${organizer.accessToken}`);
      for (const b of res.body.data) {
        seenIds.add(b.bookingId);
      }
    }
    for (const id of bookingIds) {
      expect(seenIds.has(id)).toBe(true);
    }
  });

  it("filters by status", async () => {
    const { organizer, eventId, bookingId } = await setupEventWithBooking();

    const pendingOnly = await request(app)
      .get(`/api/events/${eventId}/bookings?status=PENDING`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(pendingOnly.body.data.map((b: { bookingId: string }) => b.bookingId)).toContain(bookingId);

    const confirmedOnly = await request(app)
      .get(`/api/events/${eventId}/bookings?status=CONFIRMED`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(confirmedOnly.body.data.map((b: { bookingId: string }) => b.bookingId)).not.toContain(bookingId);
  });

  it("never exposes attendee privacy-sensitive fields", async () => {
    const { organizer, eventId } = await setupEventWithBooking();

    const res = await request(app).get(`/api/events/${eventId}/bookings`).set("Authorization", `Bearer ${organizer.accessToken}`);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain("passwordHash");
    expect(res.body.data[0]).not.toHaveProperty("userId");
    expect(res.body.data[0].attendee).not.toHaveProperty("role");
    expect(res.body.data[0].attendee).not.toHaveProperty("passwordHash");
    expect(res.body.data[0].attendee).not.toHaveProperty("isVerified");
  });
});

describe("GET /api/events/:eventId/bookings/:bookingId", () => {
  it("lets the organizer view a booking for their own event", async () => {
    const { organizer, eventId, bookingId } = await setupEventWithBooking();
    const res = await request(app)
      .get(`/api/events/${eventId}/bookings/${bookingId}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.booking.bookingId).toBe(bookingId);
  });

  it("rejects another organizer (403)", async () => {
    const { eventId, bookingId } = await setupEventWithBooking();
    const otherOrganizer = await registerUser("Other Organizer");
    const res = await request(app)
      .get(`/api/events/${eventId}/bookings/${bookingId}`)
      .set("Authorization", `Bearer ${otherOrganizer.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("lets ADMIN view any event's booking", async () => {
    const { eventId, bookingId } = await setupEventWithBooking();
    const admin = await registerAdmin("Admin");
    const res = await request(app)
      .get(`/api/events/${eventId}/bookings/${bookingId}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
  });

  it("rejects an unauthenticated request", async () => {
    const { eventId, bookingId } = await setupEventWithBooking();
    const res = await request(app).get(`/api/events/${eventId}/bookings/${bookingId}`);
    expect(res.status).toBe(401);
  });

  it("returns 404 when the booking belongs to a different event (no cross-event leak)", async () => {
    const { organizer, bookingId } = await setupEventWithBooking();
    const otherEvent = await createEventAs(organizer.accessToken);

    const res = await request(app)
      .get(`/api/events/${otherEvent.body.data.event.id}/bookings/${bookingId}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a non-existent booking id", async () => {
    const { organizer, eventId } = await setupEventWithBooking();
    const res = await request(app)
      .get(`/api/events/${eventId}/bookings/${NON_EXISTENT_ID}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);
    expect(res.status).toBe(404);
  });

  it("represents a reserved seat item distinctly from a GA item", async () => {
    // Reuses the venue/section/seat domain to build one reserved-seat booking.
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const venue = await request(app)
      .post("/api/venues")
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ name: `Venue ${randomUUID()}`, addressLine1: "1 Road", city: "Bangalore", state: "Karnataka", country: "India", postalCode: "560001", capacity: 100 });
    createdVenueIds.push(venue.body.data.venue.id);
    const section = await request(app)
      .post(`/api/venues/${venue.body.data.venue.id}/sections`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ name: `Section ${randomUUID()}`, capacity: 10 });
    const seat = await request(app)
      .post(`/api/venues/${venue.body.data.venue.id}/sections/${section.body.data.section.id}/seats`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ rowLabel: "A", seatNumber: 1 });

    const event = await createEventAs(organizer.accessToken);
    const eventId = event.body.data.event.id;
    await request(app)
      .patch(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ venueId: venue.body.data.venue.id });
    await publishEvent(organizer.accessToken, eventId);

    const ticketType = await request(app)
      .post(`/api/events/${eventId}/ticket-types`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ name: "VIP", price: 5000, quantity: 10, venueSectionId: section.body.data.section.id, status: "ACTIVE" });

    const booking = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 1, seatId: seat.body.data.seat.id }] });

    const res = await request(app)
      .get(`/api/events/${eventId}/bookings/${booking.body.data.booking.id}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);

    expect(res.status).toBe(200);
    const item = res.body.data.booking.items[0];
    expect(item.type).toBe("RESERVED");
    expect(item.seatLabel).toBe("A1");
    expect(item).not.toHaveProperty("quantity");

    createdEventIds.push(eventId);
  });
});
