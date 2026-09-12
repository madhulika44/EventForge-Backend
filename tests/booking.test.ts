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
const createdVenueIds: string[] = [];
const createdEventIds: string[] = [];

afterAll(async () => {
  // Bookings must go before events (Booking -> Event is Restrict, not
  // Cascade — a booking is purchase history, so deleting an event must
  // never silently take bookings with it in production; test cleanup has
  // to do this deletion explicitly and in the right order instead).
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
  return `booking-test-${randomUUID()}@example.com`;
}

async function registerUser(name: string): Promise<TestUser> {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ name, email: uniqueEmail(), password: "password123" });
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

async function createVenueAs(token: string) {
  const res = await request(app)
    .post("/api/venues")
    .set("Authorization", `Bearer ${token}`)
    .send({
      name: `Test Venue ${randomUUID()}`,
      addressLine1: "1 Road",
      city: "Bangalore",
      state: "Karnataka",
      country: "India",
      postalCode: "560001",
      capacity: 5000,
    });
  if (res.body?.data?.venue?.id) {
    createdVenueIds.push(res.body.data.venue.id);
  }
  return res;
}

async function createEventAs(token: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/events")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title: `Test Event ${randomUUID()}`,
      startDateTime: "2026-12-15T10:00:00Z",
      endDateTime: "2026-12-15T18:00:00Z",
      ...overrides,
    });
  if (res.body?.data?.event?.id) {
    createdEventIds.push(res.body.data.event.id);
  }
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

interface BookableSetup {
  venueId: string;
  sectionId: string;
  seatIds: string[];
  eventId: string;
  gaTicketTypeId: string;
  vipTicketTypeId: string;
}

async function setupBookableEvent(
  organizer: TestUser,
  opts: { gaQuantity?: number; vipQuantity?: number; seatCount?: number } = {},
): Promise<BookableSetup> {
  const { gaQuantity = 10, vipQuantity = 10, seatCount = 5 } = opts;

  const venue = await createVenueAs(organizer.accessToken);
  const venueId = venue.body.data.venue.id;

  const section = await request(app)
    .post(`/api/venues/${venueId}/sections`)
    .set("Authorization", `Bearer ${organizer.accessToken}`)
    .send({ name: `Section ${randomUUID()}`, capacity: Math.max(vipQuantity, seatCount) });
  const sectionId = section.body.data.section.id;

  const seatIds: string[] = [];
  for (let i = 0; i < seatCount; i++) {
    const seat = await request(app)
      .post(`/api/venues/${venueId}/sections/${sectionId}/seats`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ rowLabel: "A", seatNumber: i + 1 });
    seatIds.push(seat.body.data.seat.id);
  }

  const event = await createEventAs(organizer.accessToken, { venueId });
  const eventId = event.body.data.event.id;
  await publishEvent(organizer.accessToken, eventId);

  const gaTicketType = await createTicketTypeAs(organizer.accessToken, eventId, { name: `GA ${randomUUID()}`, quantity: gaQuantity });
  const vipTicketType = await createTicketTypeAs(organizer.accessToken, eventId, {
    name: `VIP ${randomUUID()}`,
    price: 5000,
    quantity: vipQuantity,
    venueSectionId: sectionId,
  });

  return {
    venueId,
    sectionId,
    seatIds,
    eventId,
    gaTicketTypeId: gaTicketType.body.data.ticketType.id,
    vipTicketTypeId: vipTicketType.body.data.ticketType.id,
  };
}

const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

describe("Authentication", () => {
  it("rejects an unauthenticated booking request (401)", async () => {
    const organizer = await registerUser("Organizer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });

    expect(res.status).toBe(401);
  });

  it("lets an authenticated user create a booking", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 2 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.booking.userId).toBe(customer.id);
    expect(res.body.data.booking.status).toBe("PENDING");
  });
});

describe("Event validation", () => {
  it("rejects booking a DRAFT event", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const event = await createEventAs(organizer.accessToken); // stays DRAFT
    const ticketType = await createTicketTypeAs(organizer.accessToken, event.body.data.event.id);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: event.body.data.event.id, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EVENT_NOT_BOOKABLE");
  });

  it("rejects booking a CANCELLED event", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const event = await createEventAs(organizer.accessToken);
    const ticketType = await createTicketTypeAs(organizer.accessToken, event.body.data.event.id);
    await publishEvent(organizer.accessToken, event.body.data.event.id);
    await request(app).delete(`/api/events/${event.body.data.event.id}`).set("Authorization", `Bearer ${organizer.accessToken}`);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: event.body.data.event.id, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 1 }] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EVENT_NOT_BOOKABLE");
  });

  it("allows booking a PUBLISHED event", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });

    expect(res.status).toBe(201);
  });

  it("returns 404 for a non-existent event", async () => {
    const customer = await registerUser("Customer");
    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: NON_EXISTENT_ID, items: [{ ticketTypeId: NON_EXISTENT_ID, quantity: 1 }] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("EVENT_NOT_FOUND");
  });
});

describe("Ticket type validation", () => {
  it("rejects a DRAFT ticket type", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const event = await createEventAs(organizer.accessToken);
    await publishEvent(organizer.accessToken, event.body.data.event.id);
    const ticketType = await createTicketTypeAs(organizer.accessToken, event.body.data.event.id, { status: "DRAFT" });

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: event.body.data.event.id, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TICKET_TYPE_NOT_BOOKABLE");
  });

  it("rejects a PAUSED ticket type", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const event = await createEventAs(organizer.accessToken);
    await publishEvent(organizer.accessToken, event.body.data.event.id);
    const ticketType = await createTicketTypeAs(organizer.accessToken, event.body.data.event.id, { status: "PAUSED" });

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: event.body.data.event.id, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TICKET_TYPE_NOT_BOOKABLE");
  });

  it("rejects a CLOSED ticket type", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const event = await createEventAs(organizer.accessToken);
    await publishEvent(organizer.accessToken, event.body.data.event.id);
    const ticketType = await createTicketTypeAs(organizer.accessToken, event.body.data.event.id, { status: "ACTIVE" });
    await request(app)
      .delete(`/api/events/${event.body.data.event.id}/ticket-types/${ticketType.body.data.ticketType.id}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: event.body.data.event.id, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TICKET_TYPE_NOT_BOOKABLE");
  });

  it("rejects booking before saleStartAt", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const event = await createEventAs(organizer.accessToken);
    await publishEvent(organizer.accessToken, event.body.data.event.id);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const ticketType = await createTicketTypeAs(organizer.accessToken, event.body.data.event.id, { saleStartAt: future });

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: event.body.data.event.id, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SALE_NOT_STARTED");
  });

  it("rejects booking after saleEndAt", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const event = await createEventAs(organizer.accessToken);
    await publishEvent(organizer.accessToken, event.body.data.event.id);
    const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const wayPast = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const ticketType = await createTicketTypeAs(organizer.accessToken, event.body.data.event.id, {
      saleStartAt: wayPast,
      saleEndAt: past,
    });

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: event.body.data.event.id, items: [{ ticketTypeId: ticketType.body.data.ticketType.id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SALE_ENDED");
  });

  it("returns 404 for a non-existent ticket type", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: NON_EXISTENT_ID, quantity: 1 }] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TICKET_TYPE_NOT_FOUND");
  });

  it("rejects a ticket type that belongs to a different event", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setupA = await setupBookableEvent(organizer);
    const setupB = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setupA.eventId, items: [{ ticketTypeId: setupB.gaTicketTypeId, quantity: 1 }] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TICKET_TYPE_NOT_FOUND");
  });
});

describe("Ownership / privacy", () => {
  it("lets a user see their own booking", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);
    const created = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });

    const res = await request(app)
      .get(`/api/bookings/${created.body.data.booking.id}`)
      .set("Authorization", `Bearer ${customer.accessToken}`);
    expect(res.status).toBe(200);
  });

  it("forbids a user from seeing another user's booking (403)", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const other = await registerUser("Other");
    const setup = await setupBookableEvent(organizer);
    const created = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });

    const res = await request(app)
      .get(`/api/bookings/${created.body.data.booking.id}`)
      .set("Authorization", `Bearer ${other.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("lets an ADMIN access another user's booking", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const admin = await registerAdmin("Admin");
    const setup = await setupBookableEvent(organizer);
    const created = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });

    const res = await request(app)
      .get(`/api/bookings/${created.body.data.booking.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
  });
});

describe("Pricing", () => {
  it("snapshots the current ticket type price onto the booking item", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 3 }] });

    const item = res.body.data.booking.items[0];
    expect(Number(item.unitPrice)).toBe(1000);
    expect(Number(item.totalPrice)).toBe(3000);
  });

  it("keeps a historical booking item price unchanged after the ticket type price changes", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const booked = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });

    await request(app)
      .patch(`/api/events/${setup.eventId}/ticket-types/${setup.gaTicketTypeId}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ price: 9999 });

    const res = await request(app)
      .get(`/api/bookings/${booked.body.data.booking.id}`)
      .set("Authorization", `Bearer ${customer.accessToken}`);

    expect(Number(res.body.data.booking.items[0].unitPrice)).toBe(1000);
  });

  it("ignores a client-supplied unitPrice", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1, unitPrice: 1 }] });

    expect(res.status).toBe(201);
    expect(Number(res.body.data.booking.items[0].unitPrice)).toBe(1000);
  });

  it("ignores a client-supplied totalPrice", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1, totalPrice: 1 }] });

    expect(res.status).toBe(201);
    expect(Number(res.body.data.booking.items[0].totalPrice)).toBe(1000);
  });

  it("ignores a client-supplied userId", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, userId: NON_EXISTENT_ID, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });

    expect(res.status).toBe(201);
    expect(res.body.data.booking.userId).toBe(customer.id);
  });
});

describe("General Admission", () => {
  it("succeeds for a valid GA booking", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer, { gaQuantity: 10 });

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 3 }] });
    expect(res.status).toBe(201);
  });

  it("rejects a zero/negative quantity", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 0 }] });
    expect(res.status).toBe(400);
  });

  it("rejects a quantity exceeding available inventory", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer, { gaQuantity: 5 });

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 6 }] });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_INVENTORY");
  });
});

describe("Reserved seating", () => {
  it("succeeds for a valid seat booking", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId: setup.seatIds[0] }] });
    expect(res.status).toBe(201);
    expect(res.body.data.booking.items[0].seatId).toBe(setup.seatIds[0]);
  });

  it("rejects a non-existent seat", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId: NON_EXISTENT_ID }] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SEAT_NOT_FOUND");
  });

  it("rejects a seat that belongs to a different section than the ticket type", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setupA = await setupBookableEvent(organizer);
    const setupB = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({
        eventId: setupA.eventId,
        items: [{ ticketTypeId: setupA.vipTicketTypeId, quantity: 1, seatId: setupB.seatIds[0] }],
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SEAT_NOT_FOUND");
  });

  it("rejects booking the same seat twice", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const other = await registerUser("Other");
    const setup = await setupBookableEvent(organizer);

    await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId: setup.seatIds[0] }] });

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${other.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId: setup.seatIds[0] }] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SEAT_UNAVAILABLE");
  });

  it("requires a seatId for a reserved-section ticket type", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.vipTicketTypeId, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SEAT_REQUIRED");
  });

  it("rejects a seatId on a general-admission ticket type", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1, seatId: setup.seatIds[0] }] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SEAT_NOT_ALLOWED");
  });

  it("frees the seat again once the holding booking is cancelled", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const other = await registerUser("Other");
    const setup = await setupBookableEvent(organizer);

    const first = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId: setup.seatIds[0] }] });

    await request(app)
      .post(`/api/bookings/${first.body.data.booking.id}/cancel`)
      .set("Authorization", `Bearer ${customer.accessToken}`);

    const second = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${other.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId: setup.seatIds[0] }] });

    expect(second.status).toBe(201);
  });
});

describe("Mixed booking", () => {
  it("allows one booking to contain multiple ticket types for the same event", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({
        eventId: setup.eventId,
        items: [
          { ticketTypeId: setup.gaTicketTypeId, quantity: 2 },
          { ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId: setup.seatIds[0] },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.booking.items).toHaveLength(2);
    expect(Number(res.body.data.booking.total)).toBe(2000 + 5000);
  });

  it("rejects combining ticket types from different events in one booking", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setupA = await setupBookableEvent(organizer);
    const setupB = await setupBookableEvent(organizer);

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({
        eventId: setupA.eventId,
        items: [
          { ticketTypeId: setupA.gaTicketTypeId, quantity: 1 },
          { ticketTypeId: setupB.gaTicketTypeId, quantity: 1 },
        ],
      });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TICKET_TYPE_NOT_FOUND");
  });

  it("rolls back the entire booking if one item fails (no partial BookingItems)", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const blocker = await registerUser("Blocker");
    const setup = await setupBookableEvent(organizer, { gaQuantity: 10 });

    // Someone else takes the seat first.
    await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${blocker.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId: setup.seatIds[0] }] });

    const res = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({
        eventId: setup.eventId,
        items: [
          { ticketTypeId: setup.gaTicketTypeId, quantity: 3 },
          { ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId: setup.seatIds[0] }, // already taken
        ],
      });

    expect(res.status).toBe(409);

    // The GA portion must not have been persisted despite being valid on its own.
    const heldGa = await prisma.bookingItem.aggregate({
      where: { ticketTypeId: setup.gaTicketTypeId, status: { in: ["PENDING", "CONFIRMED"] } },
      _sum: { quantity: true },
    });
    expect(heldGa._sum.quantity ?? 0).toBe(0);
  });
});

describe("Cancellation", () => {
  it("lets the owner cancel their booking", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);
    const created = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });

    const res = await request(app)
      .post(`/api/bookings/${created.body.data.booking.id}/cancel`)
      .set("Authorization", `Bearer ${customer.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.booking.status).toBe("CANCELLED");
  });

  it("forbids another user from cancelling the booking", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const other = await registerUser("Other");
    const setup = await setupBookableEvent(organizer);
    const created = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });

    const res = await request(app)
      .post(`/api/bookings/${created.body.data.booking.id}/cancel`)
      .set("Authorization", `Bearer ${other.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("changes status to CANCELLED rather than deleting the booking history", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);
    const created = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });

    await request(app)
      .post(`/api/bookings/${created.body.data.booking.id}/cancel`)
      .set("Authorization", `Bearer ${customer.accessToken}`);

    const stillExists = await prisma.booking.findUnique({
      where: { id: created.body.data.booking.id },
      include: { items: true },
    });
    expect(stillExists).not.toBeNull();
    expect(stillExists?.status).toBe("CANCELLED");
    expect(stillExists?.items).toHaveLength(1);
    expect(stillExists?.items[0]?.status).toBe("CANCELLED");
  });
});

describe("Idempotency", () => {
  it("returns the same booking when the same Idempotency-Key is reused", async () => {
    const organizer = await registerUser("Organizer");
    const customer = await registerUser("Customer");
    const setup = await setupBookableEvent(organizer);
    const key = randomUUID();

    const first = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .set("Idempotency-Key", key)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/bookings")
      .set("Authorization", `Bearer ${customer.accessToken}`)
      .set("Idempotency-Key", key)
      .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 1 }] });
    expect(second.status).toBe(200);
    expect(second.body.data.booking.id).toBe(first.body.data.booking.id);

    const count = await prisma.booking.count({ where: { id: first.body.data.booking.id } });
    expect(count).toBe(1);
  });
});

describe("Concurrency", () => {
  it("allows exactly one of two simultaneous requests for the same seat to succeed", async () => {
    const organizer = await registerUser("Organizer");
    const customerA = await registerUser("Customer A");
    const customerB = await registerUser("Customer B");
    const setup = await setupBookableEvent(organizer);
    const seatId = setup.seatIds[0]!;

    const [resA, resB] = await Promise.all([
      request(app)
        .post("/api/bookings")
        .set("Authorization", `Bearer ${customerA.accessToken}`)
        .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId }] }),
      request(app)
        .post("/api/bookings")
        .set("Authorization", `Bearer ${customerB.accessToken}`)
        .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.vipTicketTypeId, quantity: 1, seatId }] }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    expect(statuses).toEqual([201, 409]);

    const activeCount = await prisma.bookingItem.count({
      where: { seatId, status: { in: ["PENDING", "CONFIRMED"] } },
    });
    expect(activeCount).toBe(1);
  });

  it("never allows concurrent GA requests to oversell beyond the ticket type's quantity", async () => {
    const organizer = await registerUser("Organizer");
    const customerA = await registerUser("Customer A");
    const customerB = await registerUser("Customer B");
    const setup = await setupBookableEvent(organizer, { gaQuantity: 10 });

    const [resA, resB] = await Promise.all([
      request(app)
        .post("/api/bookings")
        .set("Authorization", `Bearer ${customerA.accessToken}`)
        .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 7 }] }),
      request(app)
        .post("/api/bookings")
        .set("Authorization", `Bearer ${customerB.accessToken}`)
        .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 5 }] }),
    ]);

    const succeeded = [resA, resB].filter((r) => r.status === 201);
    const failed = [resA, resB].filter((r) => r.status === 409);
    // 7 + 5 = 12 > 10, so exactly one of the two must succeed and the other fail.
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.body.error.code).toBe("INSUFFICIENT_INVENTORY");

    const held = await prisma.bookingItem.aggregate({
      where: { ticketTypeId: setup.gaTicketTypeId, status: { in: ["PENDING", "CONFIRMED"] } },
      _sum: { quantity: true },
    });
    expect(held._sum.quantity ?? 0).toBeLessThanOrEqual(10);
  });

  it("allows both concurrent GA requests to succeed when they jointly fit within quantity", async () => {
    const organizer = await registerUser("Organizer");
    const customerA = await registerUser("Customer A");
    const customerB = await registerUser("Customer B");
    const setup = await setupBookableEvent(organizer, { gaQuantity: 10 });

    const [resA, resB] = await Promise.all([
      request(app)
        .post("/api/bookings")
        .set("Authorization", `Bearer ${customerA.accessToken}`)
        .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 6 }] }),
      request(app)
        .post("/api/bookings")
        .set("Authorization", `Bearer ${customerB.accessToken}`)
        .send({ eventId: setup.eventId, items: [{ ticketTypeId: setup.gaTicketTypeId, quantity: 4 }] }),
    ]);

    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);

    const held = await prisma.bookingItem.aggregate({
      where: { ticketTypeId: setup.gaTicketTypeId, status: { in: ["PENDING", "CONFIRMED"] } },
      _sum: { quantity: true },
    });
    expect(held._sum.quantity).toBe(10);
  });
});
