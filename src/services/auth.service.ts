import type { User } from "@prisma/client";
import { createUser, findUserByEmail, findUserById } from "../repositories/user.repository";
import {
  createRefreshToken,
  findRefreshTokenByHash,
  revokeRefreshToken,
} from "../repositories/refresh-token.repository";
import { hashPassword, verifyPassword } from "../utils/password";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { hashToken } from "../utils/hash";
import { AppError } from "../utils/app-error";
import type { AuthResult, PublicUser } from "../types/auth.types";
import type { RegisterInput, LoginInput } from "../schemas/auth.schema";

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isVerified: user.isVerified,
    createdAt: user.createdAt,
  };
}

async function issueTokens(user: User): Promise<AuthResult> {
  const accessToken = signAccessToken({ sub: user.id, role: user.role });
  const { token: refreshToken, expiresAt } = signRefreshToken(user.id);

  await createRefreshToken({
    userId: user.id,
    tokenHash: hashToken(refreshToken),
    expiresAt,
  });

  return {
    user: toPublicUser(user),
    accessToken,
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
  };
}

export async function register(input: RegisterInput): Promise<AuthResult> {
  const existing = await findUserByEmail(input.email);
  if (existing) {
    throw new AppError(409, "EMAIL_ALREADY_EXISTS", "An account with this email already exists");
  }

  const passwordHash = await hashPassword(input.password);
  const user = await createUser({ name: input.name, email: input.email, passwordHash });

  return issueTokens(user);
}

export async function login(input: LoginInput): Promise<AuthResult> {
  const user = await findUserByEmail(input.email);

  // Generic error for "no such user" and "wrong password" alike, so a
  // login attempt can't be used to enumerate registered email addresses.
  if (!user || !user.passwordHash) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  const isValid = await verifyPassword(user.passwordHash, input.password);
  if (!isValid) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password");
  }

  return issueTokens(user);
}

export async function refreshSession(refreshToken: string): Promise<AuthResult> {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Invalid or expired refresh token");
  }

  const tokenHash = hashToken(refreshToken);
  const stored = await findRefreshTokenByHash(tokenHash);

  if (!stored || stored.revokedAt || stored.expiresAt < new Date() || stored.userId !== payload.sub) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Invalid or expired refresh token");
  }

  // Rotate: the presented token is single-use.
  await revokeRefreshToken(stored.id);

  const user = await findUserById(payload.sub);
  if (!user) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "Invalid or expired refresh token");
  }

  return issueTokens(user);
}

export async function logout(refreshToken: string): Promise<void> {
  try {
    const tokenHash = hashToken(refreshToken);
    const stored = await findRefreshTokenByHash(tokenHash);
    if (stored && !stored.revokedAt) {
      await revokeRefreshToken(stored.id);
    }
  } catch {
    // Logout is best-effort and idempotent: an already-invalid or
    // missing refresh token should not prevent the client from logging out.
  }
}

export async function getCurrentUser(userId: string): Promise<PublicUser> {
  const user = await findUserById(userId);
  if (!user) {
    throw new AppError(404, "USER_NOT_FOUND", "User not found");
  }
  return toPublicUser(user);
}
