import { type TextChannel, type Message } from "discord.js";
import { db, flagQuizPlayersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { FlagEntry, getRandomFlag, getShuffledFlags, isCorrectAnswer, generateHint } from "./flags.js";
import { addWin, upsertPlayer } from "./db.js";
import { logger } from "../lib/logger.js";

const ROUND_TIMEOUT_MS = 15_000;
const CHALLENGE_TIMEOUT_MS = 25_000;
const MAX_POINTS = 100;
const MIN_POINTS = 10;

export interface ChallengeSession {
  channelId: string;
  flags: FlagEntry[];
  currentIndex: number;
  scores: Map<string, { name: string; points: number; wins: number }>;
  active: boolean;
  roundTimer: ReturnType<typeof setTimeout> | null;
  hintTimer: ReturnType<typeof setTimeout> | null;
  roundStartTime: number;
  participants: Set<string>;
}

// Shape of a single-round entry — the timer closes over the reference
// so it can check identity before firing.
interface SingleRound {
  flag: FlagEntry;
  timer: ReturnType<typeof setTimeout>;
  hintTimer: ReturnType<typeof setTimeout>;
  startTime: number;
  participants: Set<string>;
}

// Active single-round channels
const activeRounds = new Map<string, SingleRound>();

// Active challenge sessions
const activeChallenges = new Map<string, ChallengeSession>();

export function isRoundActive(channelId: string): boolean {
  return activeRounds.has(channelId) || activeChallenges.has(channelId);
}

export function isChallengeActive(channelId: string): boolean {
  return activeChallenges.has(channelId);
}

function calcPoints(elapsedMs: number, timeoutMs = ROUND_TIMEOUT_MS): number {
  const frac = Math.min(elapsedMs / timeoutMs, 1);
  const pts = Math.round(MAX_POINTS - (MAX_POINTS - MIN_POINTS) * frac);
  return Math.max(pts, MIN_POINTS);
}

// ---------------------------------------------------------------------------
// Single round
// ---------------------------------------------------------------------------

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

  // We build the round object first so the timer closure can reference it.
  // TypeScript needs the cast because timer is assigned just below.
  const roundRef = {
    flag,
    timer: null as unknown as ReturnType<typeof setTimeout>,
    hintTimer: null as unknown as ReturnType<typeof setTimeout>,
    startTime,
    participants,
  } satisfies Omit<SingleRound, "timer" | "hintTimer"> & {
    timer: ReturnType<typeof setTimeout> | null;
    hintTimer: ReturnType<typeof setTimeout> | null;
  };

  const hintTimer = setTimeout(async () => {
    // Only send hint if this exact round is still active
    if (activeRounds.get(channel.id) !== (roundRef as SingleRound)) return;
    try {
      await channel.send(`💡 **Hint:** ${generateHint(flag.country)}`);
    } catch (e) {
      logger.warn({ err: e }, "Failed to send hint");
    }
  }, 8_000);

  const timer = setTimeout(async () => {
    // -----------------------------------------------------------------------
    // RACE-CONDITION GUARD (single round / timeout path)
    // Check identity synchronously BEFORE any await.  If handleGuess already
    // removed this round from the map, current will be undefined or a newer
    // round object — either way we bail out without sending anything.
    // -----------------------------------------------------------------------
    const current = activeRounds.get(channel.id);
    if (current !== (roundRef as SingleRound)) {
      logger.debug(
        { channelId: channel.id, trigger: "timeout", roundCountry: flag.country, ts: new Date().toISOString() },
        "[ROUND-ADVANCE] timeout guard rejected — round already advanced",
      );
      return;
    }

    // We own this advance: remove from map before first await so concurrent
    // handleGuess calls see no round.
    activeRounds.delete(channel.id);
    clearTimeout(roundRef.hintTimer);

    logger.debug(
      { channelId: channel.id, trigger: "timeout", roundCountry: flag.country, ts: new Date().toISOString() },
      "[ROUND-ADVANCE] single-round timeout advancing",
    );

    try {
      await channel.send(
        `⏱️ Time's up! Nobody guessed it. The answer was **${flag.country}** ${flag.flag}`,
      );
    } catch (e) {
      logger.warn({ err: e }, "Failed to send timeout message");
    }
  }, ROUND_TIMEOUT_MS);

  roundRef.timer = timer;
  roundRef.hintTimer = hintTimer;

  activeRounds.set(channel.id, roundRef as SingleRound);

  await channel.send(
    `🌍 **Flag Quiz!** What country does this flag belong to?\n\n${flag.flag}\n\n*You have 15 seconds! Type your answer in chat.*`,
  );
}

// ---------------------------------------------------------------------------
// Guess handler
// ---------------------------------------------------------------------------

export async function handleGuess(message: Message): Promise<void> {
  const channelId = message.channel.id;
  const userId = message.author.id;
  const username = message.author.username;
  const answer = message.content.trim();

  // --- Single round guess ---------------------------------------------------
  const round = activeRounds.get(channelId);
  if (round) {
    round.participants.add(userId);

    if (isCorrectAnswer(round.flag, answer)) {
      // -----------------------------------------------------------------------
      // RACE-CONDITION GUARD (single round / answer path)
      // Remove from map and clear timers synchronously before any await so the
      // timeout callback (if it fires right now) will fail its identity check
      // and bail out without sending "Time's up".
      // -----------------------------------------------------------------------
      const current = activeRounds.get(channelId);
      if (current !== round) {
        // Another path already advanced this round (shouldn't happen in
        // single-round, but guard anyway).
        return;
      }
      activeRounds.delete(channelId);
      clearTimeout(round.timer);
      clearTimeout(round.hintTimer);

      logger.debug(
        { channelId, trigger: "answer", roundCountry: round.flag.country, userId, ts: new Date().toISOString() },
        "[ROUND-ADVANCE] single-round correct answer advancing",
      );

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

  // --- Challenge guess ------------------------------------------------------
  const session = activeChallenges.get(channelId);
  if (session && session.active) {
    const expectedIndex = session.currentIndex; // capture synchronously
    const currentFlag = session.flags[expectedIndex];
    if (!currentFlag) return;

    session.participants.add(userId);

    if (isCorrectAnswer(currentFlag, answer)) {
      // -----------------------------------------------------------------------
      // RACE-CONDITION GUARD (challenge / answer path)
      // Re-check currentIndex synchronously — if the timeout already advanced
      // it during a prior await, this round is no longer ours.
      // -----------------------------------------------------------------------
      if (session.currentIndex !== expectedIndex) {
        logger.debug(
          { channelId, trigger: "answer", roundIndex: expectedIndex, ts: new Date().toISOString() },
          "[ROUND-ADVANCE] challenge answer guard rejected — round already advanced",
        );
        return;
      }

      // Own this advance: clear timers and bump index before any await.
      if (session.roundTimer) {
        clearTimeout(session.roundTimer);
        session.roundTimer = null;
      }
      if (session.hintTimer) {
        clearTimeout(session.hintTimer);
        session.hintTimer = null;
      }
      session.currentIndex++;

      logger.debug(
        { channelId, trigger: "answer", roundIndex: expectedIndex, userId, ts: new Date().toISOString() },
        "[ROUND-ADVANCE] challenge correct answer advancing",
      );

      const elapsed = Date.now() - session.roundStartTime;
      const points = calcPoints(elapsed, CHALLENGE_TIMEOUT_MS);
      const elapsedSec = (elapsed / 1000).toFixed(1);

      const existing = session.scores.get(userId);
      if (existing) {
        existing.points += points;
        existing.wins += 1;
      } else {
        session.scores.set(userId, { name: username, points, wins: 1 });
      }

      const progress = `${expectedIndex + 1}/${session.flags.length}`;
      const ch2 = message.channel as TextChannel;
      await ch2.send(
        `✅ **${username}** got it in **${elapsedSec}s** — **+${points} pts**! *(Round ${progress})* The answer was **${currentFlag.country}** ${currentFlag.flag}`,
      );

      if (session.currentIndex >= session.flags.length) {
        await endChallenge(message.channel as TextChannel, session);
      } else {
        await sendChallengeRound(message.channel as TextChannel, session);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Challenge rounds
// ---------------------------------------------------------------------------

async function sendChallengeRound(
  channel: TextChannel,
  session: ChallengeSession,
): Promise<void> {
  const roundIndex = session.currentIndex; // capture before any async work
  const flag = session.flags[roundIndex];
  if (!flag) return;

  session.roundStartTime = Date.now();
  session.participants = new Set();

  await channel.send(
    `🌍 **Round ${roundIndex + 1}/${session.flags.length}** — What country is this?\n\n${flag.flag}\n\n*25 seconds!*`,
  );

  // Account for however long Discord's send() took so timers always fire at
  // exactly CHALLENGE_TIMEOUT_MS / 15s from roundStartTime, not from after
  // the network call completes.  On slow connections this can be 2-3 seconds.
  const sendElapsed = Date.now() - session.roundStartTime;
  const hintDelay   = Math.max(0, 15_000 - sendElapsed);
  const roundDelay  = Math.max(0, CHALLENGE_TIMEOUT_MS - sendElapsed);

  session.hintTimer = setTimeout(async () => {
    if (!session.active) return;
    // Guard: only send hint if we're still on this same round
    if (session.currentIndex !== roundIndex) return;
    const current = session.flags[session.currentIndex];
    if (!current || current !== flag) return;
    try {
      await channel.send(`💡 **Hint:** ${generateHint(flag.country)}`);
    } catch (e) {
      logger.warn({ err: e }, "Failed to send challenge hint");
    }
  }, hintDelay);

  session.roundTimer = setTimeout(async () => {
    if (!session.active) return;

    // -----------------------------------------------------------------------
    // RACE-CONDITION GUARD (challenge / timeout path)
    // Check synchronously BEFORE the first await.  If handleGuess already
    // incremented currentIndex during a prior await in this callback, we bail.
    // -----------------------------------------------------------------------
    if (session.currentIndex !== roundIndex) {
      logger.debug(
        { channelId: channel.id, trigger: "timeout", roundIndex, ts: new Date().toISOString() },
        "[ROUND-ADVANCE] challenge timeout guard rejected — round already advanced",
      );
      return;
    }

    // Own this advance: bump index and clear hint timer synchronously before
    // any await so handleGuess cannot also advance this round.
    session.currentIndex++;
    if (session.hintTimer) {
      clearTimeout(session.hintTimer);
      session.hintTimer = null;
    }
    session.roundTimer = null;

    logger.debug(
      { channelId: channel.id, trigger: "timeout", roundIndex, ts: new Date().toISOString() },
      "[ROUND-ADVANCE] challenge timeout advancing",
    );

    try {
      await channel.send(
        `⏱️ Time's up! The answer was **${flag.country}** ${flag.flag}`,
      );
    } catch (e) {
      logger.warn({ err: e }, "Failed to send challenge timeout");
    }

    if (session.currentIndex >= session.flags.length) {
      await endChallenge(channel, session);
    } else {
      await sendChallengeRound(channel, session);
    }
  }, roundDelay);
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
  if (session.hintTimer) {
    clearTimeout(session.hintTimer);
    session.hintTimer = null;
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

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

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
    hintTimer: null,
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
    // Remove state and clear timers synchronously so no timer fires after this.
    clearTimeout(round.timer);
    clearTimeout(round.hintTimer);
    activeRounds.delete(channel.id);
    try {
      await channel.send(
        `🛑 Round ended by a moderator. The answer was **${round.flag.country}** ${round.flag.flag}`,
      );
    } catch (e) {
      logger.warn({ err: e }, "Failed to send endActiveRound message (single)");
    }
    return;
  }

  const session = activeChallenges.get(channel.id);
  if (session) {
    // Mark inactive and remove before any await so concurrent timer callbacks
    // see session.active = false and bail out immediately.
    session.active = false;
    if (session.roundTimer) {
      clearTimeout(session.roundTimer);
      session.roundTimer = null;
    }
    if (session.hintTimer) {
      clearTimeout(session.hintTimer);
      session.hintTimer = null;
    }
    activeChallenges.delete(channel.id);

    // Wait one tick so any sendChallengeRound call currently awaiting a
    // channel.send() has a chance to finish before we send our own message.
    // Without this the two concurrent sends can collide and ours gets dropped.
    await new Promise((r) => setTimeout(r, 0));

    try {
      await channel.send(`🛑 Challenge ended by a moderator.`);
    } catch (e) {
      logger.warn({ err: e }, "Failed to send endActiveRound message (challenge)");
    }
    return;
  }

  try {
    await channel.send("ℹ️ There's no active round or challenge to end.");
  } catch (e) {
    logger.warn({ err: e }, "Failed to send endActiveRound message (none)");
  }
}
