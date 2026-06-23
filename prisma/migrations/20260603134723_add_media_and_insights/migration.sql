-- AlterTable
ALTER TABLE "Account" ADD COLUMN "insightsEnabled" BOOLEAN;
ALTER TABLE "Account" ADD COLUMN "insightsLastFetchedAt" DATETIME;

-- AlterTable
ALTER TABLE "Post" ADD COLUMN "insightsFetchedAt" DATETIME;
ALTER TABLE "Post" ADD COLUMN "lastEr" REAL;
ALTER TABLE "Post" ADD COLUMN "lastLikes" INTEGER;
ALTER TABLE "Post" ADD COLUMN "lastQuotes" INTEGER;
ALTER TABLE "Post" ADD COLUMN "lastReplies" INTEGER;
ALTER TABLE "Post" ADD COLUMN "lastReposts" INTEGER;
ALTER TABLE "Post" ADD COLUMN "lastViews" INTEGER;
ALTER TABLE "Post" ADD COLUMN "perfLabel" TEXT;

-- CreateTable
CREATE TABLE "PostMedia" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL DEFAULT 'image',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "driveFileId" TEXT,
    "publicUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PostInsight" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "postId" TEXT,
    "accountId" TEXT NOT NULL,
    "threadsPostId" TEXT NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "replies" INTEGER NOT NULL DEFAULT 0,
    "reposts" INTEGER NOT NULL DEFAULT 0,
    "quotes" INTEGER NOT NULL DEFAULT 0,
    "er" REAL NOT NULL DEFAULT 0,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PostInsight_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HistoricalPost" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "threadsPostId" TEXT,
    "postedAt" DATETIME,
    "text" TEXT NOT NULL DEFAULT '',
    "postUrl" TEXT,
    "views" INTEGER,
    "likes" INTEGER,
    "replies" INTEGER,
    "reposts" INTEGER,
    "quotes" INTEGER,
    "er" REAL,
    "treeBody" TEXT,
    "treeCount" INTEGER,
    "tag" TEXT,
    "perfLabel" TEXT,
    "source" TEXT NOT NULL DEFAULT 'csv',
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "PostMedia_postId_sortOrder_idx" ON "PostMedia"("postId", "sortOrder");

-- CreateIndex
CREATE INDEX "PostInsight_accountId_threadsPostId_fetchedAt_idx" ON "PostInsight"("accountId", "threadsPostId", "fetchedAt");

-- CreateIndex
CREATE INDEX "PostInsight_accountId_fetchedAt_idx" ON "PostInsight"("accountId", "fetchedAt");

-- CreateIndex
CREATE INDEX "HistoricalPost_accountId_postedAt_idx" ON "HistoricalPost"("accountId", "postedAt");

-- CreateIndex
CREATE UNIQUE INDEX "HistoricalPost_accountId_threadsPostId_key" ON "HistoricalPost"("accountId", "threadsPostId");
