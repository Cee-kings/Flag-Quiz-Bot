import { type TextChannel, type Message } from "discord.js";
import { db, flagQuizPlayersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { FlagEntry, getRandomFlag, getShuffledFlags, isCorrectAnswer } from "./flags.js";
import { addWin, upsertPlayer } from "./db.js";
import { logger } from "../lib/logger.js";

const ROUND_TIMEOUT_MS = 15_000;
const MAX_POINTS = 100;
const MIN_POINTS = 10;

export interface ChallengeSession {
  channelId: string;
  flags: FlagEntry[];
  currentIndex: number;
  scores: Map<string, { name: string; points: number; wins: number }>;
  active: boolean;
  roundTimer: ReturnType<typeof setTimeout> | null;
  roundStartTime: number;
  participants: Set<string>;
}

// Active single-round channels
const activeRounds = new Map<
  string,
  {
    flag: FlagEntry;
    timer: ReturnType<typeof setTimeout>;
    startTime: number;
    participants: Set<string>;
  }
>();

// Active challenge sessions
const activeChallenges = new Map<string, ChallengeSession>();

export function isRoundActive(channelId: string): boolean {
  return activeRounds.has(channelId) || activeChallenges.has(channelId);
}

export function isChallengeActive(channelId: string): boolean {
  return activeChallenges.has(channelId);
}

function calcPoints(elapsedMs: number): number {
  const frac = Math.min(elapsedMs / ROUND_TIMEOUT_MS, 1);
  const pts = Math.round(MAX_POINTS - (MAX_POINTS - MIN_POINTS) * frac);
  return Math.max(pts, MIN_POINTS);
}

export async function startSingleRound(
  channel: TextChannel,
  startedBy: string,
): Promise<void> {
  if (isRoundActive(channel.id)) {
    await channel.send("⚠️ A round is already in progress! Type the country name to answer.");
    return;
  }

  const flag = getRandomFlag();
  const startTime = Date.now();
  const participants = new Set<string>();

  const timer = setTimeout(async () => {
    activeRounds.delete(channel.id);
    try {
      await channel.send(
        `⏱️ Time's up! Nobody guessed it. The answer was **${flag.country}** ${flag.flag}`,
      );
    } catch (e) {
      logger.warn({ err: e }, "Failed to send timeout message");
    }
  }, ROUND_TIMEOUT_MS);

  activeRounds.set(channel.id, { flag, timer, startTime, participants });

  await channel.send(
    `🌍 **Flag Quiz!** What country does this flag belong to?\n\n${flag.flag}\n\n*You have 15 seconds! Type your answer in chat.*`,
  );
}

export async function handleGuess(message: Message): Promise<void> {
  const channelId = message.channel.id;
  const userId = message.author.id;
  const username = message.author.username;
  const answer = message.content.trim();

  // Single round guess
  const round = activeRounds.get(channelId);
  if (round) {
    round.participants.add(userId);

    if (isCorrectAnswer(round.flag, answer)) {
      clearTimeout(round.timer);
      activeRounds.delete(channelId);

      const elapsed = Date.now() - round.startTime;
      const points = calcPoints(elapsed);

      try {
        await addWin(userId, username, points);
      } catch (e) {
        logger.error({ err: e }, "DB error saving win");
      }

      const elapsedSec = (elapsed / 1000).toFixed(1);
      const ch = message.channel as TextChannel;
      await ch.send(
        `🎉 **${username}** got it in **${elapsedSec}s** and earned **${points} points**!\nThe answer was **${round.flag.country}** ${round.flag.flag}`,
      );
    }
    return;
  }

  // Challenge guess
  const session = activeChallenges.get(channelId);
  if (session && session.active) {
    const currentFlag = session.flags[session.currentIndex];
    if (!currentFlag) return;

    session.participants.add(userId);

    if (isCorrectAnswer(currentFlag, answer)) {
      if (session.roundTimer) {
        clearTimeout(session.roundTimer);
        session.roundTimer = null;
      }

      const elapsed = Date.now() - session.roundStartTime;
      const points = calcPoints(elapsed);
      const elapsedSec = (elapsed / 1000).toFixed(1);

      const existing = session.scores.get(userId);
      if (existing) {
        existing.points += points;
        existing.wins += 1;
      } else {
        session.scores.set(userId, { name: username, points, wins: 1 });
      }

      const progress = `${session.currentIndex + 1}/${session.flags.length}`;
      const ch2 = message.channel as TextChannel;
      await ch2.send(
        `✅ **${username}** got it in **${elapsedSec}s** — **+${points} pts**! *(Round ${progress})* The answer was **${currentFlag.country}** ${currentFlag.flag}`,
      );

      session.currentIndex++;

      if (session.currentIndex >= session.flags.length) {
        await endChallenge(message.channel as TextChannel, session);
      } else {
        await sendChallengeRound(message.channel as TextChannel, session);
      }
    }
  }
}

async function sendChallengeRound(
  channel: TextChannel,
  session: ChallengeSession,
): Promise<void> {
  const flag = session.flags[session.currentIndex];
  if (!flag) return;

  session.roundStartTime = Date.now();
  session.participants = new Set();

  await channel.send(
    `🌍 **Round ${session.currentIndex + 1}/${session.flags.length}** — What country is this?\n\n${flag.flag}\n\n*15 seconds!*`,
  );

  session.roundTimer = setTimeout(async () => {
    if (!session.active) return;

    try {
      await channel.send(
        `⏱️ Time's up! The answer was **${flag.country}** ${flag.flag}`,
      );
    } catch (e) {
      logger.warn({ err: e }, "Failed to send challenge timeout");
    }

    session.currentIndex++;
    if (session.currentIndex >= session.flags.length) {
      await endChallenge(channel, session);
    } else {
      await sendChallengeRound(channel, session);
    }
  }, ROUND_TIMEOUT_MS);
}

async function endChallenge(
  channel: TextChannel,
  session: ChallengeSession,
): Promise<void> {
  session.active = false;
  if (session.roundTimer) {
    clearTimeout(session.roundTimer);
    session.roundTimer = null;
  }
  activeChallenges.delete(session.channelId);

  // Persist scores to DB
  for (const [uid, data] of session.scores) {
    try {
      await upsertPlayer(uid, data.name);
      const rows = await db
        .select()
        .from(flagQuizPlayersTable)
        .where(eq(flagQuizPlayersTable.discordId, uid))
        .limit(1);
      if (rows[0]) {
        await db
          .update(flagQuizPlayersTable)
          .set({
            totalScore: rows[0].totalScore + data.points,
            totalWins: rows[0].totalWins + data.wins,
            totalRounds: rows[0].totalRounds + session.flags.length,
            updatedAt: new Date(),
          })
          .where(eq(flagQuizPlayersTable.discordId, uid));
      }
    } catch (e) {
      logger.error({ err: e }, "DB error saving challenge scores");
    }
  }

  const sorted = [...session.scores.entries()].sort(
    (a, b) => b[1].points - a[1].points,
  );

  if (sorted.length === 0) {
    await channel.send(
      `🏁 **Challenge over!** Nobody got any flags right. Better luck next time!`,
    );
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const lines = sorted.map(([, data], i) => {
    const medal = medals[i] ?? `**${i + 1}.**`;
    return `${medal} **${data.name}** — ${data.points} pts (${data.wins} wins)`;
  });

  await channel.send(
    `🏁 **Challenge Complete! Final Standings:**\n\n${lines.join("\n")}\n\nCongratulations to **${sorted[0]![1].name}**! 🎊`,
  );
}

export async function startChallenge(channel: TextChannel): Promise<void> {
  if (isRoundActive(channel.id)) {
    await channel.send("⚠️ A round is already in progress in this channel!");
    return;
  }

  const flags = getShuffledFlags(20);
  const session: ChallengeSession = {
    channelId: channel.id,
    flags,
    currentIndex: 0,
    scores: new Map(),
    active: true,
    roundTimer: null,
    roundStartTime: Date.now(),
    participants: new Set(),
  };

  activeChallenges.set(channel.id, session);

  await channel.send(
    `🎯 **Flag Challenge Starting!** 20 flags, speed scoring — faster answers earn more points!\n\nGet ready...`,
  );

  await new Promise((r) => setTimeout(r, 2000));
  await sendChallengeRound(channel, session);
}

export async function endActiveRound(channel: TextChannel): Promise<void> {
  const round = activeRounds.get(channel.id);
  if (round) {
    clearTimeout(round.timer);
    activeRounds.delete(channel.id);
    await channel.send(
      `🛑 Round ended by a moderator. The answer was **${round.flag.country}** ${round.flag.flag}`,
    );
    return;
  }

  const session = activeChallenges.get(channel.id);
  if (session) {
    session.active = false;
    if (session.roundTimer) clearTimeout(session.roundTimer);
    activeChallenges.delete(channel.id);
    await channel.send(`🛑 Challenge ended by a moderator.`);
    return;
  }

  await channel.send("ℹ️ There's no active round or challenge to end.");
}
