import type { User } from "@prisma/client";
import { prisma } from "../config/database";

export interface CreateUserData {
  name: string;
  email: string;
  passwordHash: string | null;
}

export function findUserByEmail(email: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { email } });
}

export function findUserById(id: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id } });
}

export function createUser(data: CreateUserData): Promise<User> {
  return prisma.user.create({ data });
}
