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
    "cloudOffloadEnabled" BOOLEAN NOT NULL DEFAULT false,
    "gasWebAppUrl" TEXT,
    "gasWebAppKey" TEXT,
    "gasSpreadsheetId" TEXT,
    "lastSyncedAt" DATETIME,
    "tokenFingerprint" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Account" ("accessToken", "autoGenerate", "conceptSheet", "createdAt", "id", "name", "postingHours", "postsPerDay", "threadsUserId", "threadsUsername", "tokenExpiresAt", "updatedAt") SELECT "accessToken", "autoGenerate", "conceptSheet", "createdAt", "id", "name", "postingHours", "postsPerDay", "threadsUserId", "threadsUsername", "tokenExpiresAt", "updatedAt" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE TABLE "new_Post" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "groupNo" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "postType" TEXT NOT NULL DEFAULT 'standalone',
    "scheduledDate" DATETIME,
    "scheduledHour" INTEGER,
    "scheduledMin" INTEGER,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "score" REAL,
    "threadsPostId" TEXT,
    "postedAt" DATETIME,
    "postUrl" TEXT,
    "memo" TEXT,
    "error" TEXT,
    "batchFile" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "publishAt" DATETIME,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "executor" TEXT NOT NULL DEFAULT 'local',
    "remoteRowId" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Post_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Post" ("accountId", "batchFile", "body", "charCount", "createdAt", "error", "groupNo", "id", "memo", "postType", "postUrl", "postedAt", "publishAt", "retryCount", "scheduledDate", "scheduledHour", "scheduledMin", "score", "sortOrder", "status", "threadsPostId", "updatedAt") SELECT "accountId", "batchFile", "body", "charCount", "createdAt", "error", "groupNo", "id", "memo", "postType", "postUrl", "postedAt", "publishAt", "retryCount", "scheduledDate", "scheduledHour", "scheduledMin", "score", "sortOrder", "status", "threadsPostId", "updatedAt" FROM "Post";
DROP TABLE "Post";
ALTER TABLE "new_Post" RENAME TO "Post";
CREATE INDEX "Post_accountId_status_idx" ON "Post"("accountId", "status");
CREATE INDEX "Post_accountId_scheduledDate_idx" ON "Post"("accountId", "scheduledDate");
CREATE INDEX "Post_status_publishAt_idx" ON "Post"("status", "publishAt");
CREATE INDEX "Post_status_executor_publishAt_idx" ON "Post"("status", "executor", "publishAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
