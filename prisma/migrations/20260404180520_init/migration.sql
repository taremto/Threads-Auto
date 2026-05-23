-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "threadsUserId" TEXT,
    "threadsUsername" TEXT,
    "accessToken" TEXT,
    "tokenExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Post" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Post_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Post_accountId_status_idx" ON "Post"("accountId", "status");

-- CreateIndex
CREATE INDEX "Post_accountId_scheduledDate_idx" ON "Post"("accountId", "scheduledDate");
