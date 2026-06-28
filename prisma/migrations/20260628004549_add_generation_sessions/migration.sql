-- CreateTable
CREATE TABLE "GenerationSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "layer" TEXT,
    "category" TEXT,
    "hookType" TEXT,
    "templateName" TEXT,
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "finalPostBody" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GenerationStep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "stepLabel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "summary" TEXT,
    "output" TEXT,
    "knowledgeRefs" TEXT,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GenerationStep_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "GenerationSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GenerationSession_accountId_createdAt_idx" ON "GenerationSession"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationStep_sessionId_idx" ON "GenerationStep"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationStep_sessionId_stepNumber_key" ON "GenerationStep"("sessionId", "stepNumber");
