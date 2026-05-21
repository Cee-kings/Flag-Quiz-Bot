import {
  Client,
  GatewayIntentBits,
  type TextChannel,
  type Message,
} from "discord.js";
import { logger } from "../lib/logger.js";
import {
  startSingleRound,
  startChallenge,
  endActiveRound,
  handleGuess,
  isRoundActive,
} from "./game.js";
import { getTopPlayers, getPlayer } from "./db.js";

const MOD_ROLES = ["moderator", "host", "co-host", "staff"];
const PREFIX = "!";

function isMod(message: Message): boolean {
  if (!message.member) return false;
  return message.member.roles.cache.some((role) =>
    MOD_ROLES.includes(role.name.toLowerCase()),
  );
}

function isTextChannel(channel: unknown): channel is TextChannel {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    "isTextBased" in channel &&
    typeof (channel as TextChannel).isTextBased === "function" &&
    (channel as TextChannel).isTextBased()
  );
}

async function handleCommand(message: Message): Promise<void> {
  const content = message.content.trim();
  const channel = message.channel;

  if (!isTextChannel(channel)) return;

  // !flag — start a single round
  if (content.toLowerCase() === `${PREFIX}flag`) {
    await startSingleRound(channel, message.author.id);
    return;
  }

  // !help — show all commands
  if (content.toLowerCase() === `${PREFIX}help`) {
    await channel.send(
      `🌍 **Flag Quiz Bot — Commands**\n\n` +
      `**\`!flag\`** — Start a single flag round (15 seconds to guess)\n` +
      `**\`!flagchallenge\`** — Run 20 unique flags in a row with speed scoring and final standings (25 seconds per flag)\n` +
      `**\`!leaderboard\`** — Show the top 10 players by total score\n` +
      `**\`!score\`** — Show your personal stats (score, wins, rounds, win rate)\n` +
      `**\`!endflag\`** — *(Mods only)* Stop the current round or challenge\n\n` +
      `💡 **Scoring:** 100 pts for an instant answer, dropping to 10 pts at the time limit — speed counts!`,
    );
    return;
  }

  // !flagchallenge — start a 20-flag challenge
  if (content.toLowerCase() === `${PREFIX}flagchallenge`) {
    await startChallenge(channel);
    return;
  }

  // !endflag — mod only, stop the current game
  if (content.toLowerCase() === `${PREFIX}endflag`) {
    if (!isMod(message)) {
      await channel.send(
        "❌ Only moderators (Moderator, Host, Co-Host, Staff) can end a round.",
      );
      return;
    }
    await endActiveRound(channel);
    return;
  }

  // !leaderboard — top 10 players
  if (content.toLowerCase() === `${PREFIX}leaderboard`) {
    try {
      const players = await getTopPlayers(10);
      if (players.length === 0) {
        await channel.send(
          "📊 **Leaderboard** — No games played yet! Use `!flag` to start.",
        );
        return;
      }
      const medals = ["🥇", "🥈", "🥉"];
      const lines = players.map((p, i) => {
        const rank = medals[i] ?? `**${i + 1}.**`;
        const winRate =
          p.totalRounds > 0
            ? ((p.totalWins / p.totalRounds) * 100).toFixed(0)
            : "0";
        return `${rank} **${p.username}** — ${p.totalScore} pts | ${p.totalWins} wins | ${winRate}% win rate`;
      });
      await channel.send(
        `📊 **Flag Quiz Leaderboard**\n\n${lines.join("\n")}`,
      );
    } catch (e) {
      logger.error({ err: e }, "DB error fetching leaderboard");
      await channel.send("⚠️ Could not fetch the leaderboard right now.");
    }
    return;
  }

  // !score — personal stats
  if (content.toLowerCase() === `${PREFIX}score`) {
    try {
      const player = await getPlayer(message.author.id);
      if (!player) {
        await channel.send(
          `📈 **${message.author.username}**, you haven't played any games yet! Use \`!flag\` to start.`,
        );
        return;
      }
      const winRate =
        player.totalRounds > 0
          ? ((player.totalWins / player.totalRounds) * 100).toFixed(0)
          : "0";
      await channel.send(
        `📈 **${player.username}'s Stats**\n` +
          `🏆 Total Score: **${player.totalScore} pts**\n` +
          `✅ Wins: **${player.totalWins}**\n` +
          `🎮 Rounds Played: **${player.totalRounds}**\n` +
          `📊 Win Rate: **${winRate}%**`,
      );
    } catch (e) {
      logger.error({ err: e }, "DB error fetching player score");
      await channel.send("⚠️ Could not fetch your stats right now.");
    }
    return;
  }
}

export function startBot(): void {
  const token = process.env["DISCORD_BOT_TOKEN"];
  if (!token) {
    logger.warn("DISCORD_BOT_TOKEN not set — bot will not start");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.on("ready", () => {
    logger.info({ tag: client.user?.tag }, "Discord bot connected");
  });

  client.on("messageCreate", async (message: Message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    const content = message.content.trim();

    // Handle commands starting with !
    if (content.startsWith(PREFIX)) {
      await handleCommand(message).catch((err) => {
        logger.error({ err }, "Error handling command");
      });
      return;
    }

    // Handle guesses when a round is active
    if (isRoundActive(message.channelId)) {
      await handleGuess(message).catch((err) => {
        logger.error({ err }, "Error handling guess");
      });
    }
  });

  client.login(token).catch((err) => {
    logger.error({ err }, "Failed to log in to Discord");
  });
}
