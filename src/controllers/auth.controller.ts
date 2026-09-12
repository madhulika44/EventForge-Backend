import type { Request, Response } from "express";
import * as authService from "../services/auth.service";
import { AppError } from "../utils/app-error";
import { env } from "../config/env";
import type { AuthResult } from "../types/auth.types";

const REFRESH_COOKIE_NAME = "refreshToken";
const REFRESH_COOKIE_PATH = "/api/auth";

function setRefreshCookie(res: Response, result: AuthResult): void {
  res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: REFRESH_COOKIE_PATH,
    expires: result.refreshTokenExpiresAt,
  });
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: REFRESH_COOKIE_PATH,
  });
}

function sendAuthResponse(res: Response, status: number, result: AuthResult): void {
  setRefreshCookie(res, result);
  res.status(status).json({
    success: true,
    data: { user: result.user, accessToken: result.accessToken },
  });
}

export async function registerHandler(req: Request, res: Response): Promise<void> {
  const result = await authService.register(req.body);
  sendAuthResponse(res, 201, result);
}

export async function loginHandler(req: Request, res: Response): Promise<void> {
  const result = await authService.login(req.body);
  sendAuthResponse(res, 200, result);
}

export async function refreshHandler(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!token) {
    throw new AppError(401, "INVALID_REFRESH_TOKEN", "No refresh token provided");
  }

  const result = await authService.refreshSession(token);
  sendAuthResponse(res, 200, result);
}

export async function logoutHandler(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE_NAME];
  if (token) {
    await authService.logout(token);
  }
  clearRefreshCookie(res);
  res.status(200).json({ success: true, data: null });
}

export async function meHandler(req: Request, res: Response): Promise<void> {
  // req.user is guaranteed by the requireAuth middleware that guards this route.
  const user = await authService.getCurrentUser(req.user!.id);
  res.status(200).json({ success: true, data: { user } });
}
