-- CreateTable
CREATE TABLE "venues" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "venue_sections" (
    "id" UUID NOT NULL,
    "venueId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "capacity" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "venue_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seats" (
    "id" UUID NOT NULL,
    "venueSectionId" UUID NOT NULL,
    "rowLabel" TEXT NOT NULL,
    "seatNumber" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "venues_ownerId_idx" ON "venues"("ownerId");

-- CreateIndex
CREATE INDEX "venues_archivedAt_createdAt_idx" ON "venues"("archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "venue_sections_venueId_idx" ON "venue_sections"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "venue_sections_venueId_name_key" ON "venue_sections"("venueId", "name");

-- CreateIndex
CREATE INDEX "seats_venueSectionId_idx" ON "seats"("venueSectionId");

-- CreateIndex
CREATE UNIQUE INDEX "seats_venueSectionId_rowLabel_seatNumber_key" ON "seats"("venueSectionId", "rowLabel", "seatNumber");

-- CreateIndex
CREATE INDEX "events_venueId_idx" ON "events"("venueId");

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venues" ADD CONSTRAINT "venues_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "venue_sections" ADD CONSTRAINT "venue_sections_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_venueSectionId_fkey" FOREIGN KEY ("venueSectionId") REFERENCES "venue_sections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
