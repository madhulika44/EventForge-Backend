import { Role } from "@prisma/client";
import { AppError } from "./app-error";
import type { AuthenticatedUser } from "../types/auth.types";

/**
 * Shared owner-or-admin check for the Venue/Section/Seat domain. Event's
 * service has its own equivalent inline check; left untouched rather than
 * refactored onto this helper, so this phase doesn't risk working code.
 */
export function assertOwnerOrAdmin(
  ownerId: string,
  requester: AuthenticatedUser,
  message = "You do not have permission to perform this action",
): void {
  const isOwner = ownerId === requester.id;
  const isAdmin = requester.role === Role.ADMIN;

  if (!isOwner && !isAdmin) {
    throw new AppError(403, "FORBIDDEN", message);
  }
}
