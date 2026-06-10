/**
 * store/schema.ts — Drizzle ORM table definitions for Alchemy v2.
 */

import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const stubs = sqliteTable("stubs", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
});

export const tokens = sqliteTable("tokens", {
  token: text("token").primaryKey(),
  name: text("name").notNull(),
  created_at: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  stub_id: text("stub_id"),
  priority: integer("priority").notNull().default(0),
  seq: integer("seq").notNull().default(0),
  created_at: text("created_at").notNull(),
  location: text("location").notNull().default("archive"),
  data: text("data").notNull(),
}, (table) => [
  index("idx_tasks_status").on(table.status),
  index("idx_tasks_stub_id").on(table.stub_id),
  index("idx_tasks_location").on(table.location),
]);

export const grids = sqliteTable("grids", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
});

export const experiments = sqliteTable("experiments", {
  id: text("id").primaryKey(),
  data: text("data").notNull(),
});

export const webhookSubscriptions = sqliteTable("webhook_subscriptions", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  enabled: integer("enabled").notNull().default(1),
  data: text("data").notNull(),
}, (table) => [
  index("idx_webhook_subscriptions_name").on(table.name),
]);

export const webhookDeliveries = sqliteTable("webhook_deliveries", {
  id: text("id").primaryKey(),
  subscription_id: text("subscription_id").notNull(),
  event: text("event").notNull(),
  task_id: text("task_id"),
  status: text("status").notNull(),
  delivered_at: text("delivered_at").notNull(),
  data: text("data").notNull(),
}, (table) => [
  index("idx_webhook_deliveries_subscription_time").on(table.subscription_id, table.delivered_at),
]);

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const experimentEvents = sqliteTable("experiment_events", {
  id: text("id").primaryKey(),
  experiment_id: text("experiment_id").notNull(),
  task_id: text("task_id"),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  actor: text("actor"),
  data_json: text("data_json"),
  created_at: text("created_at").notNull(),
  deleted_at: text("deleted_at"),
}, (table) => [
  index("idx_experiment_events_experiment_time").on(table.experiment_id, table.created_at),
]);
