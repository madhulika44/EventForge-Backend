import type { RefreshToken } from "@prisma/client";
import { prisma } from "../config/database";

export interface CreateRefreshTokenData {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export function createRefreshToken(data: CreateRefreshTokenData): Promise<RefreshToken> {
  return prisma.refreshToken.create({ data });
}

export function findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null> {
  return prisma.refreshToken.findUnique({ where: { tokenHash } });
}

export function revokeRefreshToken(id: string): Promise<RefreshToken> {
  return prisma.refreshToken.update({ where: { id }, data: { revokedAt: new Date() } });
}
