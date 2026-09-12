-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'CLOSED');

-- CreateTable
CREATE TABLE "ticket_types" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "venueSectionId" UUID,
    "saleStartAt" TIMESTAMP(3),
    "saleEndAt" TIMESTAMP(3),
    "status" "TicketStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_types_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_types_eventId_status_idx" ON "ticket_types"("eventId", "status");

-- CreateIndex
CREATE INDEX "ticket_types_venueSectionId_idx" ON "ticket_types"("venueSectionId");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_types_eventId_name_key" ON "ticket_types"("eventId", "name");

-- AddForeignKey
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_types" ADD CONSTRAINT "ticket_types_venueSectionId_fkey" FOREIGN KEY ("venueSectionId") REFERENCES "venue_sections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
