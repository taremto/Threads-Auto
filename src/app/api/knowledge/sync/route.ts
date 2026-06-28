import { prisma } from "@/lib/prisma";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const KNOWLEDGE_DIR = path.join(
  /* turbopackIgnore: true */ process.cwd(),
  "knowledge"
);
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

type KnowledgeFile = {
  id: string | null;
  title: string;
  type: string;
  accountId: string | null;
  enabled: boolean;
  content: string;
  relativePath: string;
};

type SyncChange = {
  id: string;
  title: string;
  relativePath: string;
  titleChanged: boolean;
  contentChanged: boolean;
};

type SyncCreation = {
  id: string | null;
  title: string;
  type: string;
  accountId: string | null;
  enabled: boolean;
  content: string;
  relativePath: string;
};

type SkipCounts = {
  noFrontmatter: number;
  missingMetadata: number;
  duplicateId: number;
  notFoundInDatabase: number;
  ambiguousTitle: number;
  invalidAccount: number;
};

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const apply = body?.apply === true;
    const scan = await scanKnowledgeFiles();

    const databaseRows = await prisma.knowledge.findMany({
      select: {
        id: true,
        title: true,
        content: true,
        accountId: true,
        type: true,
        enabled: true,
        sortOrder: true,
      },
    });
    const accountRows = await prisma.account.findMany({
      select: { id: true },
    });
    const validAccountIds = new Set(accountRows.map((account) => account.id));
    const rowById = new Map(databaseRows.map((row) => [row.id, row]));
    const titleAccountKey = (title: string, accountId: string | null) =>
      `${accountId || "common"}\u0000${title.trim()}`;
    const rowsByTitleAccount = new Map<
      string,
      typeof databaseRows
    >();
    for (const row of databaseRows) {
      const key = titleAccountKey(row.title, row.accountId);
      const rows = rowsByTitleAccount.get(key) || [];
      rows.push(row);
      rowsByTitleAccount.set(key, rows);
    }

    const changes: Array<SyncChange & { content: string }> = [];
    const creations: SyncCreation[] = [];
    let unchanged = 0;
    const notFoundInDatabase = 0;
    let ambiguousTitle = 0;
    let invalidAccount = 0;

    for (const file of scan.files) {
      if (file.accountId && !validAccountIds.has(file.accountId)) {
        invalidAccount += 1;
        continue;
      }

      let row = file.id ? rowById.get(file.id) : undefined;
      if (!row) {
        const sameTitle = rowsByTitleAccount.get(
          titleAccountKey(file.title, file.accountId)
        ) || [];
        if (sameTitle.length === 1) {
          row = sameTitle[0];
        } else if (sameTitle.length > 1) {
          ambiguousTitle += 1;
          continue;
        }
      }

      if (!row) {
        creations.push(file);
        continue;
      }

      const titleChanged = row.title !== file.title;
      const contentChanged = row.content !== file.content;
      if (!titleChanged && !contentChanged) {
        unchanged += 1;
        continue;
      }

      changes.push({
        id: row.id,
        title: file.title,
        content: file.content,
        relativePath: file.relativePath,
        titleChanged,
        contentChanged,
      });
    }

    if (apply && (changes.length > 0 || creations.length > 0)) {
      const maxSortByAccount = new Map<string, number>();
      for (const row of databaseRows) {
        const key = row.accountId || "common";
        maxSortByAccount.set(
          key,
          Math.max(maxSortByAccount.get(key) ?? 0, row.sortOrder)
        );
      }

      await prisma.$transaction(async (tx) => {
        for (const change of changes) {
          await tx.knowledge.update({
            where: { id: change.id },
            data: {
              title: change.title,
              content: change.content,
            },
          });
        }
        for (const creation of creations) {
          const key = creation.accountId || "common";
          const sortOrder = (maxSortByAccount.get(key) ?? 0) + 1;
          maxSortByAccount.set(key, sortOrder);
          await tx.knowledge.create({
            data: {
              ...(creation.id ? { id: creation.id } : {}),
              accountId: creation.accountId,
              type: creation.type,
              title: creation.title,
              content: creation.content,
              enabled: creation.enabled,
              isDefault: false,
              sortOrder,
            },
          });
        }
      });
    }

    const skipped: SkipCounts = {
      ...scan.skipped,
      notFoundInDatabase,
      ambiguousTitle,
      invalidAccount,
    };
    const skippedTotal = Object.values(skipped).reduce(
      (sum, count) => sum + count,
      0
    );

    return NextResponse.json({
      ok: true,
      mode: apply ? "applied" : "preview",
      scanned: scan.scanned,
      updated: changes.length,
      created: creations.length,
      unchanged,
      skipped: skippedTotal,
      skipDetails: skipped,
      updates: changes.slice(0, 100).map((change) => ({
        id: change.id,
        title: change.title,
        relativePath: change.relativePath,
        titleChanged: change.titleChanged,
        contentChanged: change.contentChanged,
      })),
      updatesTruncated: changes.length > 100,
      creations: creations.slice(0, 100).map((creation) => ({
        id: creation.id,
        title: creation.title,
        relativePath: creation.relativePath,
      })),
      creationsTruncated: creations.length > 100,
    });
  } catch (error) {
    console.error("knowledge file sync error:", error);
    return NextResponse.json(
      {
        error:
          "Markdownナレッジの更新確認に失敗しました: " +
          (error instanceof Error ? error.message : String(error)),
      },
      { status: 500 }
    );
  }
}

async function scanKnowledgeFiles(): Promise<{
  files: KnowledgeFile[];
  scanned: number;
  skipped: Omit<
    SkipCounts,
    "notFoundInDatabase" | "ambiguousTitle" | "invalidAccount"
  >;
}> {
  const filePaths: string[] = [];

  async function walk(directory: string) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".md") &&
        entry.name.toLowerCase() !== "readme.md"
      ) {
        filePaths.push(fullPath);
        if (filePaths.length > MAX_FILES) {
          throw new Error(`Markdownファイルが${MAX_FILES}件を超えています`);
        }
      }
    }
  }

  await walk(KNOWLEDGE_DIR);

  const parsedFiles: KnowledgeFile[] = [];
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  let totalBytes = 0;
  let noFrontmatter = 0;
  let missingMetadata = 0;

  for (const filePath of filePaths) {
    const fileStat = await stat(filePath);
    if (fileStat.size > MAX_FILE_BYTES) {
      throw new Error(
        `${path.relative(KNOWLEDGE_DIR, filePath)} が4MBを超えています`
      );
    }
    totalBytes += fileStat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("Markdownファイルの合計サイズが50MBを超えています");
    }

    const raw = await readFile(filePath, "utf8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      noFrontmatter += 1;
      continue;
    }
    if (!parsed.title) {
      missingMetadata += 1;
      continue;
    }
    if (parsed.id) {
      if (seenIds.has(parsed.id)) {
        duplicateIds.add(parsed.id);
        continue;
      }
      seenIds.add(parsed.id);
    }
    parsedFiles.push({
      id: parsed.id,
      title: parsed.title,
      type: parsed.type,
      accountId: parsed.accountId,
      enabled: parsed.enabled,
      content: parsed.content,
      relativePath: path.relative(KNOWLEDGE_DIR, filePath),
    });
  }

  return {
    files: parsedFiles.filter(
      (file) => !file.id || !duplicateIds.has(file.id)
    ),
    scanned: filePaths.length,
    skipped: {
      noFrontmatter,
      missingMetadata,
      duplicateId: duplicateIds.size,
    },
  };
}

function parseFrontmatter(text: string): {
  id: string | null;
  title: string;
  type: string;
  accountId: string | null;
  enabled: boolean;
  content: string;
} | null {
  const normalized = text.replace(/^\uFEFF/, "");
  const match = normalized.match(
    /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/
  );
  if (!match) return null;

  const metadata = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) metadata.set(key, value);
  }

  const rawType = metadata.get("type") || "custom";
  const type = ["rules", "structures", "custom"].includes(rawType)
    ? rawType
    : "custom";
  const rawAccountId = metadata.get("accountId")?.trim() || "";
  const rawEnabled = metadata.get("enabled")?.trim().toLowerCase();
  return {
    id: metadata.get("id")?.trim() || null,
    title: metadata.get("title") || "",
    type,
    accountId:
      rawAccountId && rawAccountId !== "null" ? rawAccountId : null,
    enabled: rawEnabled !== "false",
    content: match[2].trimStart(),
  };
}
