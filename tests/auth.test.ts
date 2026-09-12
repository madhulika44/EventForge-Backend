import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";

const app = createApp();

// Each test run uses a fresh, uniquely-emailed user so tests are
// independent of each other and of any data already in the dev database.
function uniqueEmail(): string {
  return `test-${randomUUID()}@example.com`;
}

const testUserIds: string[] = [];

afterAll(async () => {
  if (testUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
  }
});

describe("POST /api/auth/register", () => {
  it("rejects an invalid payload (validation)", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "A", email: "not-an-email", password: "short" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("registers a new user successfully", async () => {
    const email = uniqueEmail();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Test User", email, password: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.user).not.toHaveProperty("passwordHash");
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.headers["set-cookie"]?.[0]).toMatch(/refreshToken=/);

    testUserIds.push(res.body.data.user.id);
  });

  it("rejects a duplicate email", async () => {
    const email = uniqueEmail();
    await request(app)
      .post("/api/auth/register")
      .send({ name: "Test User", email, password: "password123" })
      .then((res) => testUserIds.push(res.body.data.user.id));

    const res = await request(app)
      .post("/api/auth/register")
      .send({ name: "Another Name", email, password: "differentPassword1" });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("EMAIL_ALREADY_EXISTS");
  });
});

describe("POST /api/auth/login", () => {
  const email = uniqueEmail();
  const password = "password123";

  beforeAll(async () => {
    const res = await request(app).post("/api/auth/register").send({ name: "Login User", email, password });
    testUserIds.push(res.body.data.user.id);
  });

  it("logs in successfully with correct credentials", async () => {
    const res = await request(app).post("/api/auth/login").send({ email, password });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });

  it("rejects an incorrect password without revealing which part was wrong", async () => {
    const res = await request(app).post("/api/auth/login").send({ email, password: "wrongPassword1" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("rejects a non-existent email with the same generic error", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: uniqueEmail(), password: "whatever123" });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });
});

describe("GET /api/auth/me", () => {
  const email = uniqueEmail();
  const password = "password123";
  let accessToken: string;

  beforeAll(async () => {
    const res = await request(app).post("/api/auth/register").send({ name: "Me User", email, password });
    testUserIds.push(res.body.data.user.id);
    accessToken = res.body.data.accessToken;
  });

  it("rejects a request with no access token", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns the current user profile for a valid access token", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(email);
  });
});

describe("Refresh token flow", () => {
  const email = uniqueEmail();
  const password = "password123";

  it("rotates the refresh token on /refresh and rejects reuse of the old one", async () => {
    const agent = request.agent(app);

    const loginRes = await agent.post("/api/auth/register").send({ name: "Refresh User", email, password });
    testUserIds.push(loginRes.body.data.user.id);
    const originalCookie = loginRes.headers["set-cookie"];
    expect(originalCookie).toBeDefined();

    const refreshRes = await agent.post("/api/auth/refresh");
    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.data.accessToken).toEqual(expect.any(String));

    // The agent now holds the rotated cookie; replaying the original
    // (already-consumed) refresh token must be rejected.
    const reuseRes = await request(app).post("/api/auth/refresh").set("Cookie", originalCookie!);
    expect(reuseRes.status).toBe(401);
    expect(reuseRes.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("rejects /refresh with no cookie at all", async () => {
    const res = await request(app).post("/api/auth/refresh");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the refresh token so it can no longer be used", async () => {
    const email = uniqueEmail();
    const agent = request.agent(app);

    const registerRes = await agent
      .post("/api/auth/register")
      .send({ name: "Logout User", email, password: "password123" });
    testUserIds.push(registerRes.body.data.user.id);

    const logoutRes = await agent.post("/api/auth/logout");
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.body.success).toBe(true);

    const refreshRes = await agent.post("/api/auth/refresh");
    expect(refreshRes.status).toBe(401);
    expect(refreshRes.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });
});
