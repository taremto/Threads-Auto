-- AlterTable
ALTER TABLE "Post" ADD COLUMN "publishAt" DATETIME;

-- CreateTable
CREATE TABLE "Knowledge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Knowledge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "threadsUserId" TEXT,
    "threadsUsername" TEXT,
    "accessToken" TEXT,
    "tokenExpiresAt" DATETIME,
    "postingHours" TEXT NOT NULL DEFAULT '[6,12,18,21]',
    "postsPerDay" INTEGER NOT NULL DEFAULT 4,
    "conceptSheet" TEXT,
    "autoGenerate" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Account" ("accessToken", "createdAt", "id", "name", "threadsUserId", "threadsUsername", "tokenExpiresAt", "updatedAt") SELECT "accessToken", "createdAt", "id", "name", "threadsUserId", "threadsUsername", "tokenExpiresAt", "updatedAt" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Knowledge_accountId_type_idx" ON "Knowledge"("accountId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "AppSetting_key_key" ON "AppSetting"("key");

-- CreateIndex
CREATE INDEX "Post_status_publishAt_idx" ON "Post"("status", "publishAt");
