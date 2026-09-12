import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { ZodError, z } from "zod";
import { createApp } from "../src/app";
import { prisma } from "../src/config/database";
import { env } from "../src/config/env";
import { errorHandler } from "../src/middleware/error.middleware";
import { createRateLimiter } from "../src/middleware/rate-limit.middleware";
import { AppError } from "../src/utils/app-error";

const app = createApp();

describe("Request ID (Section 1)", () => {
  it("attaches a unique X-Request-Id header to every response", async () => {
    const first = await request(app).get("/health");
    const second = await request(app).get("/health");

    expect(first.headers["x-request-id"]).toEqual(expect.any(String));
    expect(second.headers["x-request-id"]).toEqual(expect.any(String));
    expect(first.headers["x-request-id"]).not.toBe(second.headers["x-request-id"]);
  });

  it("ignores a client-supplied request id rather than trusting it", async () => {
    const res = await request(app).get("/health").set("X-Request-Id", "client-supplied-id");
    expect(res.headers["x-request-id"]).not.toBe("client-supplied-id");
  });
});

describe("Security headers (Section 2)", () => {
  it("sets the standard hardening headers", async () => {
    const res = await request(app).get("/health");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["referrer-policy"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["permissions-policy"]).toContain("camera=()");
  });

  it("does not set HSTS outside production", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("sets HSTS when running in production", async () => {
    const originalEnv = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = "production";
    try {
      const prodApp = createApp();
      const res = await request(prodApp).get("/health");
      expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = originalEnv;
    }
  });
});

describe("CORS (Section 4)", () => {
  afterEach(() => {
    (env as { NODE_ENV: string }).NODE_ENV = "test";
  });

  it("reflects any origin outside production", async () => {
    const res = await request(app).get("/health").set("Origin", "https://anything.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://anything.example.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("rejects an unlisted origin in production", async () => {
    (env as { NODE_ENV: string }).NODE_ENV = "production";
    (env as { CORS_ALLOWED_ORIGINS?: string }).CORS_ALLOWED_ORIGINS = "https://allowed.example.com";
    const prodApp = createApp();

    const res = await request(prodApp).get("/health").set("Origin", "https://not-allowed.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows a listed origin in production", async () => {
    (env as { NODE_ENV: string }).NODE_ENV = "production";
    (env as { CORS_ALLOWED_ORIGINS?: string }).CORS_ALLOWED_ORIGINS = "https://allowed.example.com";
    const prodApp = createApp();

    const res = await request(prodApp).get("/health").set("Origin", "https://allowed.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");
  });

  it("always passes through requests with no Origin header (non-browser clients)", async () => {
    (env as { NODE_ENV: string }).NODE_ENV = "production";
    (env as { CORS_ALLOWED_ORIGINS?: string }).CORS_ALLOWED_ORIGINS = "";
    const prodApp = createApp();

    const res = await request(prodApp).get("/health");
    expect(res.status).toBe(200);
  });
});

describe("Request body limits (Section 5)", () => {
  it("rejects a JSON body larger than REQUEST_BODY_LIMIT with 413", async () => {
    const oversized = "a".repeat(200 * 1024); // REQUEST_BODY_LIMIT default is 100kb
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ email: "x@example.com", password: oversized }));

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("rejects malformed JSON with a clean 400 instead of a raw parser error", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Content-Type", "application/json")
      .send("{not valid json");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });
});

describe("Health and readiness (Section 6)", () => {
  it("GET /health responds 200 with no auth required", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ok");
  });

  it("GET /ready responds 200 when the database is reachable", async () => {
    const res = await request(app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ready");
  });

  it("GET /ready responds 503 without leaking error detail when the database is unreachable", async () => {
    const spy = vi.spyOn(prisma, "$queryRaw").mockRejectedValueOnce(new Error("connection refused: secret-internal-detail"));
    try {
      const res = await request(app).get("/ready");
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("NOT_READY");
      expect(JSON.stringify(res.body)).not.toContain("secret-internal-detail");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("Rate limiting (Section 3)", () => {
  it("is skipped under NODE_ENV=test (so the rest of the suite isn't throttled)", async () => {
    const limiter = createRateLimiter({ windowMs: 60_000, limit: 1, message: "too many" });
    const testApp = express();
    testApp.get("/limited", limiter, (_req, res) => res.status(200).json({ ok: true }));

    const first = await request(testApp).get("/limited");
    const second = await request(testApp).get("/limited");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // would be 429 if the limiter were active
  });

  it("enforces the configured limit outside test mode", async () => {
    const originalEnv = env.NODE_ENV;
    (env as { NODE_ENV: string }).NODE_ENV = "development";
    try {
      const limiter = createRateLimiter({ windowMs: 60_000, limit: 2, message: "too many attempts" });
      const testApp = express();
      testApp.get("/limited", limiter, (_req, res) => res.status(200).json({ ok: true }));

      const first = await request(testApp).get("/limited");
      const second = await request(testApp).get("/limited");
      const third = await request(testApp).get("/limited");

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe("TOO_MANY_REQUESTS");
      expect(third.body.error.message).toBe("too many attempts");
    } finally {
      (env as { NODE_ENV: string }).NODE_ENV = originalEnv;
    }
  });
});

describe("Error handler (Section 8)", () => {
  function mockReqRes(overrides: Partial<{ id: string; path: string; method: string }> = {}) {
    const req = {
      id: overrides.id ?? "req-123",
      path: overrides.path ?? "/api/test",
      method: overrides.method ?? "GET",
      log: { error: vi.fn() },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    return { req, res };
  }

  afterEach(() => {
    (env as { NODE_ENV: string }).NODE_ENV = "test";
  });

  it("maps a known AppError to its own status/code", () => {
    const { req, res } = mockReqRes();
    errorHandler(new AppError(403, "FORBIDDEN", "no way"), req as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: { code: "FORBIDDEN", message: "no way" } });
  });

  it("maps a ZodError to 400 VALIDATION_ERROR", () => {
    const { req, res } = mockReqRes();
    const result = z.object({ name: z.string() }).safeParse({});
    errorHandler(result.error as ZodError, req as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json.mock.calls[0]?.[0] as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("maps a body-parser oversized-entity error to 413", () => {
    const { req, res } = mockReqRes();
    errorHandler({ status: 413, type: "entity.too.large", message: "too big" }, req as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(413);
    expect((res.json.mock.calls[0]?.[0] as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("maps a body-parser malformed-JSON error to 400", () => {
    const { req, res } = mockReqRes();
    errorHandler({ status: 400, type: "entity.parse.failed", message: "bad json" }, req as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect((res.json.mock.calls[0]?.[0] as { error: { code: string } }).error.code).toBe("INVALID_JSON");
  });

  it("maps a Prisma P2002 unique-constraint error to 409", () => {
    const { req, res } = mockReqRes();
    const err = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.3" });
    errorHandler(err, req as never, res as never, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect((res.json.mock.calls[0]?.[0] as { error: { code: string } }).error.code).toBe("DUPLICATE_RESOURCE");
  });

  it("hides the real error message behind a generic one in production", () => {
    (env as { NODE_ENV: string }).NODE_ENV = "production";
    const { req, res } = mockReqRes();
    errorHandler(new Error("raw internal detail: password hash mismatch"), req as never, res as never, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    const body = res.json.mock.calls[0]?.[0] as { error: { message: string } };
    expect(body.error.message).toBe("Something went wrong");
    expect(body.error.message).not.toContain("password hash");
  });

  it("logs unexpected errors through the request-scoped logger, carrying the request id", () => {
    const { req, res } = mockReqRes({ id: "abc-123" });
    errorHandler(new Error("boom"), req as never, res as never, vi.fn());

    expect(req.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "abc-123" }),
      "Unhandled error",
    );
  });
});
