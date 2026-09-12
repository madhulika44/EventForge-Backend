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
  if (createdEventIds.length > 0) {
    await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
  }
  if (createdVenueIds.length > 0) {
    // Cascades to venue_sections and seats.
    await prisma.venue.deleteMany({ where: { id: { in: createdVenueIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

function uniqueEmail(): string {
  return `venue-test-${randomUUID()}@example.com`;
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

function venuePayload(overrides: Record<string, unknown> = {}) {
  return {
    name: "Bangalore International Convention Centre",
    description: "Large convention venue",
    addressLine1: "Example Road",
    city: "Bangalore",
    state: "Karnataka",
    country: "India",
    postalCode: "560001",
    capacity: 5000,
    ...overrides,
  };
}

async function createVenueAs(token: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/venues")
    .set("Authorization", `Bearer ${token}`)
    .send(venuePayload(overrides));
  if (res.body?.data?.venue?.id) {
    createdVenueIds.push(res.body.data.venue.id);
  }
  return res;
}

const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

describe("POST /api/venues", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await request(app).post("/api/venues").send(venuePayload());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("creates a venue for the authenticated user", async () => {
    const user = await registerUser("Venue Owner");
    const res = await createVenueAs(user.accessToken);

    expect(res.status).toBe(201);
    expect(res.body.data.venue.ownerId).toBe(user.id);
    expect(res.body.data.venue.archivedAt).toBeNull();
  });

  it("ignores a client-supplied ownerId and uses the authenticated user instead", async () => {
    const user = await registerUser("Venue Owner");
    const res = await createVenueAs(user.accessToken, { ownerId: NON_EXISTENT_ID });

    expect(res.status).toBe(201);
    expect(res.body.data.venue.ownerId).toBe(user.id);
    expect(res.body.data.venue.ownerId).not.toBe(NON_EXISTENT_ID);
  });

  it("rejects a non-positive capacity", async () => {
    const user = await registerUser("Venue Owner");
    const res = await createVenueAs(user.accessToken, { capacity: -5 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a missing required field", async () => {
    const user = await registerUser("Venue Owner");
    const res = await createVenueAs(user.accessToken, { city: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/venues (list)", () => {
  it("rejects invalid pagination parameters", async () => {
    const zeroPage = await request(app).get("/api/venues?page=0&limit=20");
    expect(zeroPage.status).toBe(400);

    const hugeLimit = await request(app).get("/api/venues?page=1&limit=99999");
    expect(hugeLimit.status).toBe(400);
  });

  it("lists venues publicly with correct pagination across pages", async () => {
    const user = await registerUser("Venue Owner");
    const venueIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const res = await createVenueAs(user.accessToken, { name: `Paginated Venue ${i} ${randomUUID()}` });
      venueIds.push(res.body.data.venue.id);
    }

    const firstPage = await request(app).get("/api/venues?page=1&limit=2");
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.length).toBeLessThanOrEqual(2);
    expect(firstPage.body.pagination).toMatchObject({ page: 1, limit: 2 });
    expect(firstPage.body.pagination.total).toBeGreaterThanOrEqual(3);

    const totalPages = firstPage.body.pagination.totalPages;
    const seenIds = new Set<string>();
    for (let page = 1; page <= totalPages; page++) {
      const res = await request(app).get(`/api/venues?page=${page}&limit=2`);
      for (const venue of res.body.data) {
        seenIds.add(venue.id);
      }
    }

    for (const id of venueIds) {
      expect(seenIds.has(id)).toBe(true);
    }
  });

  it("does not return an archived venue in the public listing", async () => {
    const user = await registerUser("Venue Owner");
    const created = await createVenueAs(user.accessToken, { name: `Archived Venue ${randomUUID()}` });
    const venueId = created.body.data.venue.id;

    await request(app).delete(`/api/venues/${venueId}`).set("Authorization", `Bearer ${user.accessToken}`);

    const res = await request(app).get("/api/venues?page=1&limit=100");
    const ids = res.body.data.map((venue: { id: string }) => venue.id);
    expect(ids).not.toContain(venueId);
  });
});

describe("GET /api/venues/:id", () => {
  it("returns 404 for a non-existent venue", async () => {
    const res = await request(app).get(`/api/venues/${NON_EXISTENT_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("VENUE_NOT_FOUND");
  });

  it("returns venue details publicly", async () => {
    const user = await registerUser("Venue Owner");
    const created = await createVenueAs(user.accessToken);

    const res = await request(app).get(`/api/venues/${created.body.data.venue.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.venue.name).toBe("Bangalore International Convention Centre");
  });
});

describe("PATCH /api/venues/:id", () => {
  it("lets the owner update their own venue", async () => {
    const user = await registerUser("Venue Owner");
    const created = await createVenueAs(user.accessToken);

    const res = await request(app)
      .patch(`/api/venues/${created.body.data.venue.id}`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ name: "Updated Venue Name" });

    expect(res.status).toBe(200);
    expect(res.body.data.venue.name).toBe("Updated Venue Name");
  });

  it("forbids another normal user from updating someone else's venue (403)", async () => {
    const owner = await registerUser("Venue Owner");
    const attacker = await registerUser("Attacker");
    const created = await createVenueAs(owner.accessToken);

    const res = await request(app)
      .patch(`/api/venues/${created.body.data.venue.id}`)
      .set("Authorization", `Bearer ${attacker.accessToken}`)
      .send({ name: "Hacked Name" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("lets an admin update another user's venue", async () => {
    const owner = await registerUser("Venue Owner");
    const admin = await registerAdmin("Admin");
    const created = await createVenueAs(owner.accessToken);

    const res = await request(app)
      .patch(`/api/venues/${created.body.data.venue.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ name: "Admin Edited Name" });

    expect(res.status).toBe(200);
    expect(res.body.data.venue.name).toBe("Admin Edited Name");
  });
});

describe("DELETE /api/venues/:id (soft archive)", () => {
  it("forbids another normal user from deleting someone else's venue (403)", async () => {
    const owner = await registerUser("Venue Owner");
    const attacker = await registerUser("Attacker");
    const created = await createVenueAs(owner.accessToken);

    const res = await request(app)
      .delete(`/api/venues/${created.body.data.venue.id}`)
      .set("Authorization", `Bearer ${attacker.accessToken}`);

    expect(res.status).toBe(403);
  });

  it("archives (soft-deletes) the venue: row survives, hidden from public, visible to owner", async () => {
    const user = await registerUser("Venue Owner");
    const created = await createVenueAs(user.accessToken);
    const venueId = created.body.data.venue.id;

    const res = await request(app)
      .delete(`/api/venues/${venueId}`)
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.venue.archivedAt).not.toBeNull();

    const stillExists = await prisma.venue.findUnique({ where: { id: venueId } });
    expect(stillExists).not.toBeNull();

    const anonRes = await request(app).get(`/api/venues/${venueId}`);
    expect(anonRes.status).toBe(404);

    const ownerRes = await request(app).get(`/api/venues/${venueId}`).set("Authorization", `Bearer ${user.accessToken}`);
    expect(ownerRes.status).toBe(200);
  });

  it("lets an admin archive another user's venue", async () => {
    const owner = await registerUser("Venue Owner");
    const admin = await registerAdmin("Admin");
    const created = await createVenueAs(owner.accessToken);

    const res = await request(app)
      .delete(`/api/venues/${created.body.data.venue.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.venue.archivedAt).not.toBeNull();
  });
});

describe("Venue sections", () => {
  it("lets the owner create a section", async () => {
    const user = await registerUser("Venue Owner");
    const venue = await createVenueAs(user.accessToken);

    const res = await request(app)
      .post(`/api/venues/${venue.body.data.venue.id}/sections`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ name: "VIP", capacity: 100, sortOrder: 1 });

    expect(res.status).toBe(201);
    expect(res.body.data.section.venueId).toBe(venue.body.data.venue.id);
  });

  it("forbids another user from creating a section in someone else's venue (403)", async () => {
    const owner = await registerUser("Venue Owner");
    const attacker = await registerUser("Attacker");
    const venue = await createVenueAs(owner.accessToken);

    const res = await request(app)
      .post(`/api/venues/${venue.body.data.venue.id}/sections`)
      .set("Authorization", `Bearer ${attacker.accessToken}`)
      .send({ name: "VIP", capacity: 100 });

    expect(res.status).toBe(403);
  });

  it("rejects invalid section input (non-positive capacity)", async () => {
    const user = await registerUser("Venue Owner");
    const venue = await createVenueAs(user.accessToken);

    const res = await request(app)
      .post(`/api/venues/${venue.body.data.venue.id}/sections`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ name: "VIP", capacity: 0 });

    expect(res.status).toBe(400);
  });

  it("lists sections for a venue", async () => {
    const user = await registerUser("Venue Owner");
    const venue = await createVenueAs(user.accessToken);
    const venueId = venue.body.data.venue.id;

    await request(app)
      .post(`/api/venues/${venueId}/sections`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ name: "Section A", capacity: 50 });

    const res = await request(app).get(`/api/venues/${venueId}/sections`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("enforces update authorization: owner ok, other user forbidden, admin ok", async () => {
    const owner = await registerUser("Venue Owner");
    const other = await registerUser("Other User");
    const admin = await registerAdmin("Admin");
    const venue = await createVenueAs(owner.accessToken);
    const venueId = venue.body.data.venue.id;

    const section = await request(app)
      .post(`/api/venues/${venueId}/sections`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: "Section A", capacity: 50 });
    const sectionId = section.body.data.section.id;

    const forbidden = await request(app)
      .patch(`/api/venues/${venueId}/sections/${sectionId}`)
      .set("Authorization", `Bearer ${other.accessToken}`)
      .send({ name: "Hacked" });
    expect(forbidden.status).toBe(403);

    const ownerUpdate = await request(app)
      .patch(`/api/venues/${venueId}/sections/${sectionId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: "Owner Renamed" });
    expect(ownerUpdate.status).toBe(200);
    expect(ownerUpdate.body.data.section.name).toBe("Owner Renamed");

    const adminUpdate = await request(app)
      .patch(`/api/venues/${venueId}/sections/${sectionId}`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ name: "Admin Renamed" });
    expect(adminUpdate.status).toBe(200);
    expect(adminUpdate.body.data.section.name).toBe("Admin Renamed");
  });

  it("enforces delete authorization: other user forbidden, owner allowed", async () => {
    const owner = await registerUser("Venue Owner");
    const other = await registerUser("Other User");
    const venue = await createVenueAs(owner.accessToken);
    const venueId = venue.body.data.venue.id;

    const section = await request(app)
      .post(`/api/venues/${venueId}/sections`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: "Section A", capacity: 50 });
    const sectionId = section.body.data.section.id;

    const forbidden = await request(app)
      .delete(`/api/venues/${venueId}/sections/${sectionId}`)
      .set("Authorization", `Bearer ${other.accessToken}`);
    expect(forbidden.status).toBe(403);

    const allowed = await request(app)
      .delete(`/api/venues/${venueId}/sections/${sectionId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(allowed.status).toBe(200);
  });

  it("returns 404 when a section id belongs to a different venue", async () => {
    const owner = await registerUser("Venue Owner");
    const venueA = await createVenueAs(owner.accessToken, { name: `Venue A ${randomUUID()}` });
    const venueB = await createVenueAs(owner.accessToken, { name: `Venue B ${randomUUID()}` });

    const sectionOfB = await request(app)
      .post(`/api/venues/${venueB.body.data.venue.id}/sections`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: "Section of B", capacity: 50 });
    const sectionOfBId = sectionOfB.body.data.section.id;

    // Same owner, but reached through venue A's path — must not succeed.
    const res = await request(app)
      .patch(`/api/venues/${venueA.body.data.venue.id}/sections/${sectionOfBId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: "Cross Venue Hack" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SECTION_NOT_FOUND");
  });
});

describe("Seats", () => {
  async function setupVenueWithSection(owner: TestUser) {
    const venue = await createVenueAs(owner.accessToken, { name: `Seat Venue ${randomUUID()}` });
    const venueId = venue.body.data.venue.id;
    const section = await request(app)
      .post(`/api/venues/${venueId}/sections`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: "Section A", capacity: 50 });
    return { venueId, sectionId: section.body.data.section.id };
  }

  it("lets the owner create a seat with an auto-generated label", async () => {
    const owner = await registerUser("Venue Owner");
    const { venueId, sectionId } = await setupVenueWithSection(owner);

    const res = await request(app)
      .post(`/api/venues/${venueId}/sections/${sectionId}/seats`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ rowLabel: "A", seatNumber: 1 });

    expect(res.status).toBe(201);
    expect(res.body.data.seat.label).toBe("A1");
  });

  it("forbids another user from creating a seat in someone else's section (403)", async () => {
    const owner = await registerUser("Venue Owner");
    const attacker = await registerUser("Attacker");
    const { venueId, sectionId } = await setupVenueWithSection(owner);

    const res = await request(app)
      .post(`/api/venues/${venueId}/sections/${sectionId}/seats`)
      .set("Authorization", `Bearer ${attacker.accessToken}`)
      .send({ rowLabel: "A", seatNumber: 1 });

    expect(res.status).toBe(403);
  });

  it("rejects invalid seat input", async () => {
    const owner = await registerUser("Venue Owner");
    const { venueId, sectionId } = await setupVenueWithSection(owner);

    const res = await request(app)
      .post(`/api/venues/${venueId}/sections/${sectionId}/seats`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ rowLabel: "", seatNumber: -1 });

    expect(res.status).toBe(400);
  });

  it("enforces the duplicate-seat constraint", async () => {
    const owner = await registerUser("Venue Owner");
    const { venueId, sectionId } = await setupVenueWithSection(owner);

    await request(app)
      .post(`/api/venues/${venueId}/sections/${sectionId}/seats`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ rowLabel: "A", seatNumber: 1 });

    const dup = await request(app)
      .post(`/api/venues/${venueId}/sections/${sectionId}/seats`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ rowLabel: "A", seatNumber: 1 });

    expect(dup.status).toBe(409);
  });

  it("lists seats in a section", async () => {
    const owner = await registerUser("Venue Owner");
    const { venueId, sectionId } = await setupVenueWithSection(owner);

    await request(app)
      .post(`/api/venues/${venueId}/sections/${sectionId}/seats`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ rowLabel: "A", seatNumber: 1 });

    const res = await request(app).get(`/api/venues/${venueId}/sections/${sectionId}/seats`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("enforces update authorization: other user forbidden, owner allowed", async () => {
    const owner = await registerUser("Venue Owner");
    const other = await registerUser("Other User");
    const { venueId, sectionId } = await setupVenueWithSection(owner);

    const seat = await request(app)
      .post(`/api/venues/${venueId}/sections/${sectionId}/seats`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ rowLabel: "A", seatNumber: 1 });
    const seatId = seat.body.data.seat.id;

    const forbidden = await request(app)
      .patch(`/api/venues/${venueId}/sections/${sectionId}/seats/${seatId}`)
      .set("Authorization", `Bearer ${other.accessToken}`)
      .send({ label: "Hacked" });
    expect(forbidden.status).toBe(403);

    const allowed = await request(app)
      .patch(`/api/venues/${venueId}/sections/${sectionId}/seats/${seatId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ label: "A1-Renamed" });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.seat.label).toBe("A1-Renamed");
  });

  it("enforces delete authorization: other user forbidden, owner allowed", async () => {
    const owner = await registerUser("Venue Owner");
    const other = await registerUser("Other User");
    const { venueId, sectionId } = await setupVenueWithSection(owner);

    const seat = await request(app)
      .post(`/api/venues/${venueId}/sections/${sectionId}/seats`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ rowLabel: "A", seatNumber: 1 });
    const seatId = seat.body.data.seat.id;

    const forbidden = await request(app)
      .delete(`/api/venues/${venueId}/sections/${sectionId}/seats/${seatId}`)
      .set("Authorization", `Bearer ${other.accessToken}`);
    expect(forbidden.status).toBe(403);

    const allowed = await request(app)
      .delete(`/api/venues/${venueId}/sections/${sectionId}/seats/${seatId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`);
    expect(allowed.status).toBe(200);
  });

  it("returns 404 when a seat id belongs to a different section", async () => {
    const owner = await registerUser("Venue Owner");
    const { venueId, sectionId: sectionAId } = await setupVenueWithSection(owner);
    const sectionB = await request(app)
      .post(`/api/venues/${venueId}/sections`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ name: "Section B", capacity: 50 });
    const sectionBId = sectionB.body.data.section.id;

    const seat = await request(app)
      .post(`/api/venues/${venueId}/sections/${sectionAId}/seats`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ rowLabel: "A", seatNumber: 1 });
    const seatId = seat.body.data.seat.id;

    const res = await request(app)
      .patch(`/api/venues/${venueId}/sections/${sectionBId}/seats/${seatId}`)
      .set("Authorization", `Bearer ${owner.accessToken}`)
      .send({ label: "Cross Section Hack" });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("SEAT_NOT_FOUND");
  });
});

describe("Event / Venue relationship", () => {
  function eventPayload(overrides: Record<string, unknown> = {}) {
    return {
      title: "Concert Night",
      startDateTime: "2026-12-01T18:00:00Z",
      endDateTime: "2026-12-01T22:00:00Z",
      ...overrides,
    };
  }

  it("creates an event without a venue", async () => {
    const user = await registerUser("Organizer");
    const res = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send(eventPayload());

    expect(res.status).toBe(201);
    expect(res.body.data.event.venueId).toBeNull();
    createdEventIds.push(res.body.data.event.id);
  });

  it("creates an event that references a valid venue", async () => {
    const user = await registerUser("Organizer");
    const venue = await createVenueAs(user.accessToken);

    const res = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send(eventPayload({ venueId: venue.body.data.venue.id }));

    expect(res.status).toBe(201);
    expect(res.body.data.event.venueId).toBe(venue.body.data.venue.id);
    createdEventIds.push(res.body.data.event.id);
  });

  it("rejects a venueId that does not correspond to any venue", async () => {
    const user = await registerUser("Organizer");
    const res = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send(eventPayload({ venueId: "11111111-2222-4333-8444-555555555555" }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_VENUE_ID");
  });

  it("rejects a malformed venueId", async () => {
    const user = await registerUser("Organizer");
    const res = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send(eventPayload({ venueId: "not-a-uuid" }));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("keeps the event intact and its venue link resolvable after the venue is archived", async () => {
    const user = await registerUser("Organizer");
    const venue = await createVenueAs(user.accessToken);
    const venueId = venue.body.data.venue.id;

    const eventRes = await request(app)
      .post("/api/events")
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send(eventPayload({ venueId }));
    const eventId = eventRes.body.data.event.id;
    createdEventIds.push(eventId);

    const archiveRes = await request(app)
      .delete(`/api/venues/${venueId}`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(archiveRes.status).toBe(200);

    const eventAfter = await request(app)
      .get(`/api/events/${eventId}`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(eventAfter.status).toBe(200);
    expect(eventAfter.body.data.event.venueId).toBe(venueId);

    // The venue row itself must still exist (soft-delete), not be gone.
    const venueRow = await prisma.venue.findUnique({ where: { id: venueId } });
    expect(venueRow).not.toBeNull();
    expect(venueRow?.archivedAt).not.toBeNull();
  });
});
