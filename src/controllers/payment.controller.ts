import type { Request, Response } from "express";
import * as paymentService from "../services/payment.service";
import { AppError } from "../utils/app-error";
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
  // provider, not our own generic AppError-to-status-code mapping — but it
  // still matters WHICH error this is. A bad signature (AppError from
  // handleStripeWebhook) must return 400: Stripe should not retry a
  // request that can never succeed. Anything else (a transient DB/infra
  // failure while processing an otherwise-valid, verified event) must
  // return 500, so Stripe's own retry policy gives us another chance —
  // that retry is part of this design's reconciliation story.
  try {
    await paymentService.handleStripeWebhook(req.body as Buffer, signature);
    res.status(200).json({ received: true });
  } catch (err) {
    if (err instanceof AppError) {
      logger.warn({ err: err.message }, "Stripe webhook rejected");
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    logger.error({ err }, "Stripe webhook processing failed unexpectedly");
    res.status(500).json({ success: false, error: { code: "INTERNAL_SERVER_ERROR", message: "Webhook processing failed" } });
  }
}
