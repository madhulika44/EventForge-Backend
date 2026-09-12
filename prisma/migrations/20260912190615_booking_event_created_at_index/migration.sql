-- DropIndex
DROP INDEX "bookings_eventId_idx";

-- CreateIndex
CREATE INDEX "bookings_eventId_createdAt_idx" ON "bookings"("eventId", "createdAt");
