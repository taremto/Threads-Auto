CREATE TABLE "KnowledgeRevisionSuggestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "postId" TEXT,
    "instruction" TEXT NOT NULL,
    "beforeBody" TEXT,
    "afterBody" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "targetKnowledgeId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "KnowledgeRevisionSuggestion_accountId_status_createdAt_idx"
ON "KnowledgeRevisionSuggestion"("accountId", "status", "createdAt");

CREATE INDEX "KnowledgeRevisionSuggestion_postId_status_idx"
ON "KnowledgeRevisionSuggestion"("postId", "status");
