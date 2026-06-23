import { prisma } from "@/lib/prisma";

export type AccountIdentityInput = {
  accountId: string;
  accountName?: string | null;
  currentThreadsUserId?: string | null;
};

export type AccountIdentityCheck =
  | {
      ok: true;
      userId: string;
      shouldBackfill: boolean;
    }
  | {
      ok: false;
      error: string;
      expectedUserId: string | null;
      observedUserId: string | null;
    };

export async function validateObservedThreadsUserId(
  account: AccountIdentityInput,
  observedUserId: string | null | undefined
): Promise<AccountIdentityCheck> {
  const normalizedObserved = observedUserId ? String(observedUserId) : null;
  const expected = account.currentThreadsUserId
    ? String(account.currentThreadsUserId)
    : null;

  if (!normalizedObserved) {
    return {
      ok: false,
      error:
        "Google側からThreadsアカウントIDを確認できませんでした。誤投稿防止のため停止しました。",
      expectedUserId: expected,
      observedUserId: null,
    };
  }

  if (expected && expected !== normalizedObserved) {
    return {
      ok: false,
      error:
        `Google側のThreadsアカウント(${normalizedObserved})が、` +
        `このアカウント(${expected})と違います。取り違え防止のため停止しました。`,
      expectedUserId: expected,
      observedUserId: normalizedObserved,
    };
  }

  const collision = await prisma.account.findFirst({
    where: {
      threadsUserId: normalizedObserved,
      id: { not: account.accountId },
    },
    select: { name: true },
  });
  if (collision) {
    return {
      ok: false,
      error:
        `Google側のThreadsアカウントは「${collision.name}」のものと一致します。` +
        "別アカウントとして登録してください。",
      expectedUserId: expected,
      observedUserId: normalizedObserved,
    };
  }

  return {
    ok: true,
    userId: normalizedObserved,
    shouldBackfill: !expected,
  };
}

export async function ensureThreadsUserIdIsUnique(
  accountId: string,
  threadsUserId: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const collision = await prisma.account.findFirst({
    where: {
      threadsUserId,
      id: { not: accountId },
    },
    select: { name: true },
  });
  if (!collision) return { ok: true };
  return {
    ok: false,
    error:
      `このThreadsアカウントは既に「${collision.name}」として登録されています。` +
      "同じThreadsアカウントを重複登録すると誤投稿の原因になるため、保存を停止しました。",
  };
}
