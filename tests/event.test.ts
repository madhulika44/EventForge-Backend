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

afterAll(async () => {
  if (createdEventIds.length > 0) {
    await prisma.event.deleteMany({ where: { id: { in: createdEventIds } } });
  }
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
});

function uniqueEmail(): string {
  return `event-test-${randomUUID()}@example.com`;
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
  // The role in an already-issued access token is stale; log in again to get
  // a fresh token that reflects the ADMIN role for authorization checks.
  const email = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email;
  const loginRes = await request(app).post("/api/auth/login").send({ email, password: "password123" });
  return { id: user.id, accessToken: loginRes.body.data.accessToken };
}

function eventPayload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Bangalore Tech Conference",
    description: "A technology conference for developers and startups.",
    startDateTime: "2026-11-15T10:00:00Z",
    endDateTime: "2026-11-15T18:00:00Z",
    ...overrides,
  };
}

async function createEventAs(token: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post("/api/events")
    .set("Authorization", `Bearer ${token}`)
    .send(eventPayload(overrides));
  if (res.body?.data?.event?.id) {
    createdEventIds.push(res.body.data.event.id);
  }
  return res;
}

async function publish(token: string, eventId: string) {
  return request(app)
    .patch(`/api/events/${eventId}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status: "PUBLISHED" });
}

const NON_EXISTENT_ID = "00000000-0000-0000-0000-000000000000";

describe("POST /api/events", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await request(app).post("/api/events").send(eventPayload());
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("creates an event for the authenticated user", async () => {
    const user = await registerUser("Organizer");
    const res = await createEventAs(user.accessToken);

    expect(res.status).toBe(201);
    expect(res.body.data.event.organizerId).toBe(user.id);
    expect(res.body.data.event.status).toBe("DRAFT");
    expect(res.body.data.event.title).toBe("Bangalore Tech Conference");
  });

  it("ignores a client-supplied organizerId and uses the authenticated user instead", async () => {
    const user = await registerUser("Organizer");
    const res = await createEventAs(user.accessToken, { organizerId: NON_EXISTENT_ID });

    expect(res.status).toBe(201);
    expect(res.body.data.event.organizerId).toBe(user.id);
    expect(res.body.data.event.organizerId).not.toBe(NON_EXISTENT_ID);
  });

  it("rejects a missing title", async () => {
    const user = await registerUser("Organizer");
    const res = await createEventAs(user.accessToken, { title: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an invalid date string", async () => {
    const user = await registerUser("Organizer");
    const res = await createEventAs(user.accessToken, { startDateTime: "not-a-date" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects endDateTime before startDateTime", async () => {
    const user = await registerUser("Organizer");
    const res = await createEventAs(user.accessToken, {
      startDateTime: "2026-11-15T18:00:00Z",
      endDateTime: "2026-11-15T10:00:00Z",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/events (list)", () => {
  it("rejects invalid pagination parameters", async () => {
    const zeroPage = await request(app).get("/api/events?page=0&limit=20");
    expect(zeroPage.status).toBe(400);
    expect(zeroPage.body.error.code).toBe("VALIDATION_ERROR");

    const hugeLimit = await request(app).get("/api/events?page=1&limit=99999");
    expect(hugeLimit.status).toBe(400);
    expect(hugeLimit.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("does not return a draft event in the public listing", async () => {
    const user = await registerUser("Organizer");
    const draft = await createEventAs(user.accessToken, { title: `Hidden Draft ${randomUUID()}` });
    const draftId = draft.body.data.event.id;

    const res = await request(app).get("/api/events?page=1&limit=100");
    expect(res.status).toBe(200);
    const ids = res.body.data.map((event: { id: string }) => event.id);
    expect(ids).not.toContain(draftId);
  });

  it("returns published events with correct pagination across pages", async () => {
    const user = await registerUser("Organizer");
    const publishedIds: string[] = [];

    for (let i = 0; i < 3; i++) {
      const created = await createEventAs(user.accessToken, { title: `Paginated Event ${i} ${randomUUID()}` });
      await publish(user.accessToken, created.body.data.event.id);
      publishedIds.push(created.body.data.event.id);
    }

    const firstPage = await request(app).get("/api/events?page=1&limit=2");
    expect(firstPage.status).toBe(200);
    expect(firstPage.body.data.length).toBeLessThanOrEqual(2);
    expect(firstPage.body.pagination).toMatchObject({ page: 1, limit: 2 });
    expect(firstPage.body.pagination.total).toBeGreaterThanOrEqual(3);

    const totalPages = firstPage.body.pagination.totalPages;
    const seenIds = new Set<string>();
    for (let page = 1; page <= totalPages; page++) {
      const res = await request(app).get(`/api/events?page=${page}&limit=2`);
      for (const event of res.body.data) {
        seenIds.add(event.id);
      }
    }

    for (const id of publishedIds) {
      expect(seenIds.has(id)).toBe(true);
    }
  });
});

describe("GET /api/events/:id", () => {
  it("returns 404 for a non-existent event", async () => {
    const res = await request(app).get(`/api/events/${NON_EXISTENT_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("EVENT_NOT_FOUND");
  });

  it("returns a published event to an anonymous caller", async () => {
    const user = await registerUser("Organizer");
    const created = await createEventAs(user.accessToken);
    await publish(user.accessToken, created.body.data.event.id);

    const res = await request(app).get(`/api/events/${created.body.data.event.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.event.status).toBe("PUBLISHED");
  });

  it("hides a draft event from an anonymous caller and from an unrelated user (404)", async () => {
    const owner = await registerUser("Organizer");
    const otherUser = await registerUser("Other User");
    const created = await createEventAs(owner.accessToken);
    const eventId = created.body.data.event.id;

    const anonRes = await request(app).get(`/api/events/${eventId}`);
    expect(anonRes.status).toBe(404);

    const otherRes = await request(app).get(`/api/events/${eventId}`).set("Authorization", `Bearer ${otherUser.accessToken}`);
    expect(otherRes.status).toBe(404);
  });

  it("lets the owner and an admin preview their own draft event", async () => {
    const owner = await registerUser("Organizer");
    const admin = await registerAdmin("Admin");
    const created = await createEventAs(owner.accessToken);
    const eventId = created.body.data.event.id;

    const ownerRes = await request(app).get(`/api/events/${eventId}`).set("Authorization", `Bearer ${owner.accessToken}`);
    expect(ownerRes.status).toBe(200);

    const adminRes = await request(app).get(`/api/events/${eventId}`).set("Authorization", `Bearer ${admin.accessToken}`);
    expect(adminRes.status).toBe(200);
  });
});

describe("PATCH /api/events/:id", () => {
  it("rejects an unauthenticated request", async () => {
    const user = await registerUser("Organizer");
    const created = await createEventAs(user.accessToken);

    const res = await request(app).patch(`/api/events/${created.body.data.event.id}`).send({ title: "New Title" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-existent event", async () => {
    const user = await registerUser("Organizer");
    const res = await request(app)
      .patch(`/api/events/${NON_EXISTENT_ID}`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ title: "New Title" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("EVENT_NOT_FOUND");
  });

  it("lets the owner update their own event", async () => {
    const user = await registerUser("Organizer");
    const created = await createEventAs(user.accessToken);

    const res = await request(app)
      .patch(`/api/events/${created.body.data.event.id}`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ title: "Updated Title" });

    expect(res.status).toBe(200);
    expect(res.body.data.event.title).toBe("Updated Title");
  });

  it("forbids another normal user from updating someone else's event (403)", async () => {
    const owner = await registerUser("Organizer");
    const attacker = await registerUser("Attacker");
    const created = await createEventAs(owner.accessToken);

    const res = await request(app)
      .patch(`/api/events/${created.body.data.event.id}`)
      .set("Authorization", `Bearer ${attacker.accessToken}`)
      .send({ title: "Hacked Title" });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("lets an admin update another user's event", async () => {
    const owner = await registerUser("Organizer");
    const admin = await registerAdmin("Admin");
    const created = await createEventAs(owner.accessToken);

    const res = await request(app)
      .patch(`/api/events/${created.body.data.event.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`)
      .send({ title: "Admin Edited Title" });

    expect(res.status).toBe(200);
    expect(res.body.data.event.title).toBe("Admin Edited Title");
  });

  it("rejects endDateTime before startDateTime when both are supplied", async () => {
    const user = await registerUser("Organizer");
    const created = await createEventAs(user.accessToken);

    const res = await request(app)
      .patch(`/api/events/${created.body.data.event.id}`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ startDateTime: "2026-11-15T18:00:00Z", endDateTime: "2026-11-15T10:00:00Z" });

    expect(res.status).toBe(400);
  });

  it("rejects a partial update that would put endDateTime before the existing startDateTime", async () => {
    const user = await registerUser("Organizer");
    const created = await createEventAs(user.accessToken, {
      startDateTime: "2026-11-15T10:00:00Z",
      endDateTime: "2026-11-15T18:00:00Z",
    });

    // Only moving startDateTime later than the existing (unchanged) endDateTime.
    const res = await request(app)
      .patch(`/api/events/${created.body.data.event.id}`)
      .set("Authorization", `Bearer ${user.accessToken}`)
      .send({ startDateTime: "2026-11-16T00:00:00Z" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_EVENT_DATES");
  });
});

describe("DELETE /api/events/:id", () => {
  it("rejects an unauthenticated request", async () => {
    const user = await registerUser("Organizer");
    const created = await createEventAs(user.accessToken);

    const res = await request(app).delete(`/api/events/${created.body.data.event.id}`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for a non-existent event", async () => {
    const user = await registerUser("Organizer");
    const res = await request(app)
      .delete(`/api/events/${NON_EXISTENT_ID}`)
      .set("Authorization", `Bearer ${user.accessToken}`);
    expect(res.status).toBe(404);
  });

  it("lets the owner cancel (soft-delete) their own event", async () => {
    const user = await registerUser("Organizer");
    const created = await createEventAs(user.accessToken);

    const res = await request(app)
      .delete(`/api/events/${created.body.data.event.id}`)
      .set("Authorization", `Bearer ${user.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.event.status).toBe("CANCELLED");

    // The row must still exist (soft-delete), not be physically removed.
    const stillExists = await prisma.event.findUnique({ where: { id: created.body.data.event.id } });
    expect(stillExists).not.toBeNull();
    expect(stillExists?.status).toBe("CANCELLED");
  });

  it("forbids another normal user from cancelling someone else's event (403)", async () => {
    const owner = await registerUser("Organizer");
    const attacker = await registerUser("Attacker");
    const created = await createEventAs(owner.accessToken);

    const res = await request(app)
      .delete(`/api/events/${created.body.data.event.id}`)
      .set("Authorization", `Bearer ${attacker.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
  });

  it("lets an admin cancel another user's event", async () => {
    const owner = await registerUser("Organizer");
    const admin = await registerAdmin("Admin");
    const created = await createEventAs(owner.accessToken);

    const res = await request(app)
      .delete(`/api/events/${created.body.data.event.id}`)
      .set("Authorization", `Bearer ${admin.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.event.status).toBe("CANCELLED");
  });
});
