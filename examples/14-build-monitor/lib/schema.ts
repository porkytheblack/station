import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const builds = sqliteTable("builds", {
  id: text("id").primaryKey(),
  repo: text("repo").notNull(),
  branch: text("branch").notNull(),
  commit: text("commit").notNull(),
  status: text("status", { enum: ["pending", "running", "success", "failure"] }).notNull().default("pending"),
  startedAt: integer("started_at", { mode: "timestamp" }),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
  duration: integer("duration"),
  triggeredBy: text("triggered_by").notNull(),
});

export const testResults = sqliteTable("test_results", {
  id: text("id").primaryKey(),
  buildId: text("build_id").notNull().references(() => builds.id),
  suite: text("suite").notNull(),
  passed: integer("passed").notNull().default(0),
  failed: integer("failed").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  duration: integer("duration"),
});

export const deployments = sqliteTable("deployments", {
  id: text("id").primaryKey(),
  buildId: text("build_id").notNull().references(() => builds.id),
  environment: text("environment", { enum: ["staging", "production"] }).notNull(),
  status: text("status", { enum: ["pending", "deploying", "live", "failed", "rolled_back"] }).notNull().default("pending"),
  url: text("url"),
  deployedAt: integer("deployed_at", { mode: "timestamp" }),
});

export type Build = typeof builds.$inferSelect;
export type TestResult = typeof testResults.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
