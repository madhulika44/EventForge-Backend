import type { OAuthAccount, OAuthProvider } from "@prisma/client";
import { prisma } from "../config/database";

export function findOAuthAccount(
  provider: OAuthProvider,
  providerAccountId: string,
): Promise<OAuthAccount | null> {
  return prisma.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId } },
  });
}

export function createOAuthAccount(data: {
  userId: string;
  provider: OAuthProvider;
  providerAccountId: string;
}): Promise<OAuthAccount> {
  return prisma.oAuthAccount.create({ data });
}
