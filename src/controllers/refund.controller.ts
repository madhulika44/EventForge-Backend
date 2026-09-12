import type { Request, Response } from "express";
import * as refundService from "../services/refund.service";

export async function retryRefundHandler(req: Request, res: Response): Promise<void> {
  const refund = await refundService.retryRefundForBooking(req.params.id as string, req.user!);
  // Never expose provider ids, the idempotency key, or the webhook audit
  // trail (providerEventId) — only what's useful to see the refund's state.
  res.status(200).json({
    success: true,
    data: {
      refund: {
        id: refund.id,
        status: refund.status,
        amount: refund.amount,
        currency: refund.currency,
        failureReason: refund.failureReason,
        createdAt: refund.createdAt,
        updatedAt: refund.updatedAt,
      },
    },
  });
}
