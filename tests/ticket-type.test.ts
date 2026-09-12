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
  // Events must be deleted before venues: an event's ticket types cascade
  // away with it, whereas a ticket type -> venue section link is Restrict,
  // so a lingering ticket type would block the venue/section cascade below.
  if (createdEventIds.length > 0) {
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
  return `ticket-test-${randomUUID()}@example.com`;
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

async function createEventAs(token: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/events")
    .set("Authorization", `Bearer ${token}`)
    .send({
      title: `Test Event ${randomUUID()}`,
      startDateTime: "2026-11-15T10:00:00Z",
      endDateTime: "2026-11-15T18:00:00Z",
      ...overrides,
    });
  if (res.body?.data?.event?.id) {
    createdEventIds.push(res.body.data.event.id);
  }
  return res;
}

async function createVenueAs(token: string, overrides: Record<string, unknown> = {}) {
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
      ...overrides,
    });
  if (res.body?.data?.venue?.id) {
    createdVenueIds.push(res.body.data.venue.id);
  }
  return res;
}

async function publishEvent(token: string, eventId: string) {
  return request(app).patch(`/api/events/${eventId}`).set("Authorization", `Bearer ${token}`).send({ status: "PUBLISHED" });
}

function ticketTypePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: `General Admission ${randomUUID()}`,
    price: 1000,
    quantity: 100,
    ...overrides,
  };
}

async function createTicketTypeAs(token: string, eventId: string, overrides: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/events/${eventId}/ticket-types`)
    .set("Authorization", `Bearer ${token}`)
    .send(ticketTypePayload(overrides));
}

const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

describe("Creation", () => {
  it("rejects an unauthenticated request (401)", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);

    const res = await request(app)
      .post(`/api/events/${event.body.data.event.id}/ticket-types`)
      .send(ticketTypePayload());
    expect(res.status).toBe(401);
  });

  it("lets the event organizer create a ticket type (201)", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);

    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id);
    expect(res.status).toBe(201);
    expect(res.body.data.ticketType.eventId).toBe(event.body.data.event.id);
    expect(res.body.data.ticketType.currency).toBe("INR");
    expect(res.body.data.ticketType.status).toBe("DRAFT");
  });

  it("forbids another user from creating a ticket type for someone else's event (403)", async () => {
    const owner = await registerUser("Organizer");
    const attacker = await registerUser("Attacker");
    const event = await createEventAs(owner.accessToken);

    const res = await createTicketTypeAs(attacker.accessToken, event.body.data.event.id);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("lets an admin create a ticket type for another user's event", async () => {
    const owner = await registerUser("Organizer");
    const admin = await registerAdmin("Admin");
    const event = await createEventAs(owner.accessToken);

    const res = await createTicketTypeAs(admin.accessToken, event.body.data.event.id);
    expect(res.status).toBe(201);
  });
});

describe("Relationships", () => {
  it("scopes the ticket type to the event it was created under", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);

    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id);
    expect(res.body.data.ticketType.eventId).toBe(event.body.data.event.id);
  });

  it("returns 404 when a ticket type is accessed through a different event's path", async () => {
    const owner = await registerUser("Organizer");
    const eventA = await createEventAs(owner.accessToken);
    const eventB = await createEventAs(owner.accessToken);
    const ticketType = await createTicketTypeAs(owner.accessToken, eventA.body.data.event.id);

    const res = await request(app)
      .get(`/api/events/${eventB.body.data.event.id}/ticket-types/${ticketType.body.data.ticketType.id}`)
      .set("Authorization", `Bearer ${owner.accessToken}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("TICKET_TYPE_NOT_FOUND");
  });

  it("returns 404 for a non-existent event id", async () => {
    const owner = await registerUser("Organizer");
    const res = await createTicketTypeAs(owner.accessToken, NON_EXISTENT_ID);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("EVENT_NOT_FOUND");
  });

  it("rejects a venueSectionId that does not exist", async () => {
    const owner = await registerUser("Organizer");
    const venue = await createVenueAs(owner.accessToken);
    const event = await createEventAs(owner.accessToken, { venueId: venue.body.data.venue.id });

    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, {
      venueSectionId: NON_EXISTENT_ID,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VENUE_SECTION");
  });

  it("rejects a section that belongs to a different venue than the event's", async () => {
    const owner = await registerUser("Organizer");
    const venueA = await createVenueAs(owner.accessToken);
    const venueB = await createVenueAs(owner.accessToken);
    const event = await createEventAs(owner.accessToken, { venueId: venueA.body.data.venue.id });

    const sectionOfB = await request(app)
      .post(`/api/venues/${venueB.body.data.venue.id}/sections`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: `Section of B ${randomUUID()}`, capacity: 50 });

    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, {
      venueSectionId: sectionOfB.body.data.section.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VENUE_SECTION");
  });

  it("rejects a section assignment when the event has no venue", async () => {
    const owner = await registerUser("Organizer");
    const venue = await createVenueAs(owner.accessToken);
    const event = await createEventAs(owner.accessToken); // no venueId

    const section = await request(app)
      .post(`/api/venues/${venue.body.data.venue.id}/sections`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: `Section ${randomUUID()}`, capacity: 50 });

    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, {
      venueSectionId: section.body.data.section.id,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VENUE_SECTION");
  });
});

describe("Validation", () => {
  it("rejects an invalid (too short) name", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);
    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, { name: "A" });
    expect(res.status).toBe(400);
  });

  it("rejects a negative price", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);
    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, { price: -5 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-positive quantity", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);
    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, { quantity: 0 });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid currency code", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);
    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, { currency: "US" });
    expect(res.status).toBe(400);
  });

  it("rejects saleEndAt before saleStartAt", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);
    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, {
      saleStartAt: "2026-11-10T00:00:00Z",
      saleEndAt: "2026-11-01T00:00:00Z",
    });
    expect(res.status).toBe(400);
  });
});

describe("Public visibility", () => {
  it("shows an ACTIVE ticket type publicly once the event is published", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);
    await publishEvent(owner.accessToken, event.body.data.event.id);
    const ticketType = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, { status: "ACTIVE" });

    const res = await request(app).get(`/api/events/${event.body.data.event.id}/ticket-types/${ticketType.body.data.ticketType.id}`);
    expect(res.status).toBe(200);

    const listRes = await request(app).get(`/api/events/${event.body.data.event.id}/ticket-types`);
    expect(listRes.body.data.map((t: { id: string }) => t.id)).toContain(ticketType.body.data.ticketType.id);
  });

  it("hides ticket types for a draft event from public users", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken); // stays DRAFT
    await createTicketTypeAs(owner.accessToken, event.body.data.event.id, { status: "ACTIVE" });

    const listRes = await request(app).get(`/api/events/${event.body.data.event.id}/ticket-types`);
    expect(listRes.status).toBe(404);
  });

  it("hides a DRAFT-status ticket type from public users even on a published event", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);
    await publishEvent(owner.accessToken, event.body.data.event.id);
    const draftTicket = await createTicketTypeAs(owner.accessToken, event.body.data.event.id); // default status DRAFT

    const listRes = await request(app).get(`/api/events/${event.body.data.event.id}/ticket-types`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.map((t: { id: string }) => t.id)).not.toContain(draftTicket.body.data.ticketType.id);

    const getRes = await request(app).get(
      `/api/events/${event.body.data.event.id}/ticket-types/${draftTicket.body.data.ticketType.id}`,
    );
    expect(getRes.status).toBe(404);
  });

  it("lets the event owner view ticket types for their own draft event", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);
    await createTicketTypeAs(owner.accessToken, event.body.data.event.id);

    const res = await request(app)
      .get(`/api/events/${event.body.data.event.id}/ticket-types`)
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("lets an admin view ticket types for another user's draft event", async () => {
    const owner = await registerUser("Organizer");
    const admin = await registerAdmin("Admin");
    const event = await createEventAs(owner.accessToken);
    await createTicketTypeAs(owner.accessToken, event.body.data.event.id);

    const res = await request(app)
      .get(`/api/events/${event.body.data.event.id}/ticket-types`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Authorization: update / delete", () => {
  it("lets the owner update their ticket type", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);
    const ticketType = await createTicketTypeAs(owner.accessToken, event.body.data.event.id);

    const res = await request(app)
      .patch(`/api/events/${event.body.data.event.id}/ticket-types/${ticketType.body.data.ticketType.id}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ price: 1500 });

    expect(res.status).toBe(200);
    // Prisma's Decimal renders the canonical form ("1500", not "1500.00") —
    // compare the numeric value, which is what actually matters for money.
    expect(Number(res.body.data.ticketType.price)).toBe(1500);
  });

  it("forbids another user from updating the ticket type (403)", async () => {
    const owner = await registerUser("Organizer");
    const attacker = await registerUser("Attacker");
    const event = await createEventAs(owner.accessToken);
    const ticketType = await createTicketTypeAs(owner.accessToken, event.body.data.event.id);

    const res = await request(app)
      .patch(`/api/events/${event.body.data.event.id}/ticket-types/${ticketType.body.data.ticketType.id}`)
      .set("Authorization", `Bearer ${attacker.accessToken}`)
      .send({ price: 1 });

    expect(res.status).toBe(403);
  });

  it("lets an admin update another user's ticket type", async () => {
    const owner = await registerUser("Organizer");
    const admin = await registerAdmin("Admin");
    const event = await createEventAs(owner.accessToken);
    const ticketType = await createTicketTypeAs(owner.accessToken, event.body.data.event.id);

    const res = await request(app)
      .patch(`/api/events/${event.body.data.event.id}/ticket-types/${ticketType.body.data.ticketType.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ name: `Admin Renamed ${randomUUID()}` });

    expect(res.status).toBe(200);
  });

  it("forbids another user from deleting the ticket type (403)", async () => {
    const owner = await registerUser("Organizer");
    const attacker = await registerUser("Attacker");
    const event = await createEventAs(owner.accessToken);
    const ticketType = await createTicketTypeAs(owner.accessToken, event.body.data.event.id);

    const res = await request(app)
      .delete(`/api/events/${event.body.data.event.id}/ticket-types/${ticketType.body.data.ticketType.id}`)
      .set("Authorization", `Bearer ${attacker.accessToken}`);

    expect(res.status).toBe(403);
  });

  it("DELETE transitions the ticket type to CLOSED rather than removing it (owner and admin)", async () => {
    const owner = await registerUser("Organizer");
    const admin = await registerAdmin("Admin");
    const event = await createEventAs(owner.accessToken);
    const ticketType = await createTicketTypeAs(owner.accessToken, event.body.data.event.id);

    const ownerDelete = await request(app)
      .delete(`/api/events/${event.body.data.event.id}/ticket-types/${ticketType.body.data.ticketType.id}`)
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(ownerDelete.status).toBe(200);
    expect(ownerDelete.body.data.ticketType.status).toBe("CLOSED");

    const stillExists = await prisma.ticketType.findUnique({ where: { id: ticketType.body.data.ticketType.id } });
    expect(stillExists).not.toBeNull();
    expect(stillExists?.status).toBe("CLOSED");

    const ticketType2 = await createTicketTypeAs(owner.accessToken, event.body.data.event.id);
    const adminDelete = await request(app)
      .delete(`/api/events/${event.body.data.event.id}/ticket-types/${ticketType2.body.data.ticketType.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);
    expect(adminDelete.status).toBe(200);
    expect(adminDelete.body.data.ticketType.status).toBe("CLOSED");
  });
});

describe("Business rules", () => {
  it("rejects a section-linked quantity that exceeds the section's capacity", async () => {
    const owner = await registerUser("Organizer");
    const venue = await createVenueAs(owner.accessToken);
    const event = await createEventAs(owner.accessToken, { venueId: venue.body.data.venue.id });
    const section = await request(app)
      .post(`/api/venues/${venue.body.data.venue.id}/sections`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: `Small Section ${randomUUID()}`, capacity: 10 });

    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, {
      venueSectionId: section.body.data.section.id,
      quantity: 500,
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("QUANTITY_EXCEEDS_SECTION_CAPACITY");
  });

  it("accepts a section-linked quantity within the section's capacity", async () => {
    const owner = await registerUser("Organizer");
    const venue = await createVenueAs(owner.accessToken);
    const event = await createEventAs(owner.accessToken, { venueId: venue.body.data.venue.id });
    const section = await request(app)
      .post(`/api/venues/${venue.body.data.venue.id}/sections`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: `VIP Section ${randomUUID()}`, capacity: 50 });

    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, {
      venueSectionId: section.body.data.section.id,
      quantity: 30,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.ticketType.venueSectionId).toBe(section.body.data.section.id);
  });

  it("does not expose any seat-level fields on a ticket type", async () => {
    const owner = await registerUser("Organizer");
    const event = await createEventAs(owner.accessToken);
    const res = await createTicketTypeAs(owner.accessToken, event.body.data.event.id, { seatId: NON_EXISTENT_ID });

    expect(res.status).toBe(201);
    expect(res.body.data.ticketType).not.toHaveProperty("seatId");
    expect(res.body.data.ticketType).not.toHaveProperty("isBooked");
    expect(res.body.data.ticketType).not.toHaveProperty("bookingId");
  });

  it("blocks deleting a venue section that a ticket type still references (no raw DB error leaked)", async () => {
    const owner = await registerUser("Organizer");
    const venue = await createVenueAs(owner.accessToken);
    const event = await createEventAs(owner.accessToken, { venueId: venue.body.data.venue.id });
    const section = await request(app)
      .post(`/api/venues/${venue.body.data.venue.id}/sections`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: `Guarded Section ${randomUUID()}`, capacity: 50 });

    await createTicketTypeAs(owner.accessToken, event.body.data.event.id, {
      venueSectionId: section.body.data.section.id,
      quantity: 10,
    });

    const res = await request(app)
      .delete(`/api/venues/${venue.body.data.venue.id}/sections/${section.body.data.section.id}`)
      .set("Authorization", `Bearer ${owner.accessToken}`);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REFERENCED_RESOURCE");
  });
});
