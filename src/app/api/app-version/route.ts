import { readFile } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";

function parseVersion(text: string) {
  const [versionLine, releaseLine] = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    version: versionLine || "unknown",
    releaseDate: releaseLine?.replace(/^Release date:\s*/i, "") || null,
  };
}

export async function GET() {
  try {
    const text = await readFile(path.join(process.cwd(), "VERSION.txt"), "utf-8");
    return NextResponse.json(parseVersion(text));
  } catch {
    return NextResponse.json({ version: "unknown", releaseDate: null });
  }
}
