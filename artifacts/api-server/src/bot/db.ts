import { db, flagQuizPlayersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

export async function upsertPlayer(discordId: string, username: string) {
  const existing = await db
    .select()
    .from(flagQuizPlayersTable)
    .where(eq(flagQuizPlayersTable.discordId, discordId))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(flagQuizPlayersTable).values({
      discordId,
      username,
      totalScore: 0,
      totalWins: 0,
      totalRounds: 0,
    });
  } else {
    await db
      .update(flagQuizPlayersTable)
      .set({ username })
      .where(eq(flagQuizPlayersTable.discordId, discordId));
  }
}

export async function addWin(
  discordId: string,
  username: string,
  points: number,
) {
  await upsertPlayer(discordId, username);
  const player = await db
    .select()
    .from(flagQuizPlayersTable)
    .where(eq(flagQuizPlayersTable.discordId, discordId))
    .limit(1);

  if (player[0]) {
    await db
      .update(flagQuizPlayersTable)
      .set({
        totalScore: player[0].totalScore + points,
        totalWins: player[0].totalWins + 1,
        totalRounds: player[0].totalRounds + 1,
        updatedAt: new Date(),
      })
      .where(eq(flagQuizPlayersTable.discordId, discordId));
  }
}

export async function addParticipation(discordId: string, username: string) {
  await upsertPlayer(discordId, username);
  const player = await db
    .select()
    .from(flagQuizPlayersTable)
    .where(eq(flagQuizPlayersTable.discordId, discordId))
    .limit(1);

  if (player[0]) {
    await db
      .update(flagQuizPlayersTable)
      .set({
        totalRounds: player[0].totalRounds + 1,
        updatedAt: new Date(),
      })
      .where(eq(flagQuizPlayersTable.discordId, discordId));
  }
}

export async function getTopPlayers(limit = 10) {
  return db
    .select()
    .from(flagQuizPlayersTable)
    .orderBy(desc(flagQuizPlayersTable.totalScore))
    .limit(limit);
}

export async function getPlayer(discordId: string) {
  const rows = await db
    .select()
    .from(flagQuizPlayersTable)
    .where(eq(flagQuizPlayersTable.discordId, discordId))
    .limit(1);
  return rows[0] ?? null;
}
