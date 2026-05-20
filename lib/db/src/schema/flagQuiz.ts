import { pgTable, text, integer, timestamp, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const flagQuizPlayersTable = pgTable("flag_quiz_players", {
  id: serial("id").primaryKey(),
  discordId: text("discord_id").notNull().unique(),
  username: text("username").notNull(),
  totalScore: integer("total_score").notNull().default(0),
  totalWins: integer("total_wins").notNull().default(0),
  totalRounds: integer("total_rounds").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertFlagQuizPlayerSchema = createInsertSchema(flagQuizPlayersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFlagQuizPlayer = z.infer<typeof insertFlagQuizPlayerSchema>;
export type FlagQuizPlayer = typeof flagQuizPlayersTable.$inferSelect;
