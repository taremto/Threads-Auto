-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Knowledge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Knowledge_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Knowledge" ("accountId", "content", "createdAt", "id", "isDefault", "sortOrder", "title", "type", "updatedAt") SELECT "accountId", "content", "createdAt", "id", "isDefault", "sortOrder", "title", "type", "updatedAt" FROM "Knowledge";
DROP TABLE "Knowledge";
ALTER TABLE "new_Knowledge" RENAME TO "Knowledge";
CREATE INDEX "Knowledge_accountId_type_idx" ON "Knowledge"("accountId", "type");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
