import type { Request, Response } from "express";
import * as paymentService from "../services/payment.service";
import { logger } from "../config/logger";

export async function createPaymentHandler(req: Request, res: Response): Promise<void> {
  const { payment, clientSecret } = await paymentService.createPaymentForBooking(req.params.id as string, req.user!);
  res.status(201).json({
    success: true,
    data: {
      payment: {
        id: payment.id,
        provider: payment.provider,
        amount: payment.amount,
        currency: payment.currency,
        status: payment.status,
      },
      clientSecret,
    },
  });
}

function readStripeSignature(req: Request): string | undefined {
  const header = req.headers["stripe-signature"];
  return Array.isArray(header) ? header[0] : header;
}

export async function stripeWebhookHandler(req: Request, res: Response): Promise<void> {
  const signature = readStripeSignature(req);
  if (!signature) {
    res.status(400).json({ success: false, error: { code: "MISSING_SIGNATURE", message: "Missing webhook signature" } });
    return;
  }

  // Deliberate try/catch (rather than throwing to the shared error
  // middleware): a webhook's error-response contract is dictated by the
  // provider (Stripe expects 400 specifically for a bad signature, 200 for
  // "received" regardless of whether we acted on it), not by our own
  // generic AppError-to-status-code mapping.
  try {
    await paymentService.handleStripeWebhook(req.body as Buffer, signature);
    res.status(200).json({ received: true });
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "Stripe webhook rejected");
    res.status(400).json({ success: false, error: { code: "INVALID_SIGNATURE", message: "Invalid webhook signature" } });
  }
}
