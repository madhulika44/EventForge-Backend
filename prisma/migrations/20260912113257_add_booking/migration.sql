-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "bookingReference" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING',
    "currency" TEXT NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_items" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "ticketTypeId" UUID NOT NULL,
    "seatId" UUID,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "totalPrice" DECIMAL(10,2) NOT NULL,
    "status" "BookingStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_bookingReference_key" ON "bookings"("bookingReference");

-- CreateIndex
CREATE INDEX "bookings_userId_idx" ON "bookings"("userId");

-- CreateIndex
CREATE INDEX "bookings_eventId_idx" ON "bookings"("eventId");

-- CreateIndex
CREATE INDEX "bookings_status_expiresAt_idx" ON "bookings"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_userId_idempotencyKey_key" ON "bookings"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "booking_items_bookingId_idx" ON "booking_items"("bookingId");

-- CreateIndex
CREATE INDEX "booking_items_ticketTypeId_status_idx" ON "booking_items"("ticketTypeId", "status");

-- CreateIndex
CREATE INDEX "booking_items_seatId_idx" ON "booking_items"("seatId");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_ticketTypeId_fkey" FOREIGN KEY ("ticketTypeId") REFERENCES "ticket_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_seatId_fkey" FOREIGN KEY ("seatId") REFERENCES "seats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hand-authored additions below: the Prisma schema DSL has no declarative
-- syntax for partial (filtered) unique indexes or CHECK constraints, so
-- these are added directly here rather than expressed in schema.prisma.

-- A physical seat may have at most one PENDING/CONFIRMED booking item at a
-- time — this is the actual database-level guarantee against double-booking
-- a seat. CANCELLED/EXPIRED rows are excluded, so a seat becomes bookable
-- again once its holding booking is released, without ever deleting history.
CREATE UNIQUE INDEX "booking_items_active_seat_unique"
  ON "booking_items" ("seatId")
  WHERE "seatId" IS NOT NULL AND "status" IN ('PENDING', 'CONFIRMED');

-- A seat-linked booking item must represent exactly one physical seat.
ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_seat_quantity_check"
  CHECK ("seatId" IS NULL OR "quantity" = 1);

-- Defense in depth beyond Zod validation.
ALTER TABLE "booking_items"
  ADD CONSTRAINT "booking_items_quantity_positive_check"
  CHECK ("quantity" > 0);
