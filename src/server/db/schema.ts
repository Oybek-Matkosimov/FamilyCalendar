import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, timestamp, integer, boolean, jsonb, date,
  uniqueIndex, index, unique, foreignKey, check, primaryKey,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const calendars = pgTable('calendars', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  recoveryHash: text('recovery_hash').notNull(),
  timezone: text('timezone').notNull(),
  settings: jsonb('settings').$type<{ membersCanEditAll: boolean }>().notNull().default({ membersCanEditAll: true }),
  // FK to members is added in migration 0001 (circular reference, deferrable)
  ownerMemberId: uuid('owner_member_id'),
  createdAt: createdAt(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const members = pgTable('members', {
  id: uuid('id').primaryKey().defaultRandom(),
  calendarId: uuid('calendar_id').notNull().references(() => calendars.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  nameKey: text('name_key').notNull(),
  role: text('role', { enum: ['owner', 'member'] }).notNull().default('member'),
  color: text('color').notNull(),
  createdAt: createdAt(),
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => [
  unique('members_cal_id_uq').on(t.calendarId, t.id),
  uniqueIndex('members_active_name_uq').on(t.calendarId, t.nameKey).where(sql`removed_at is null`),
  index('members_calendar_idx').on(t.calendarId),
  check('members_role_chk', sql`role in ('owner','member')`),
]);

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tokenHash: text('token_hash').notNull().unique(),
  calendarId: uuid('calendar_id').notNull().references(() => calendars.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  userAgent: text('user_agent'),
}, (t) => [
  foreignKey({ columns: [t.calendarId, t.memberId], foreignColumns: [members.calendarId, members.id] }).onDelete('cascade'),
  index('sessions_member_idx').on(t.memberId),
]);

export const events = pgTable('events', {
  id: uuid('id').primaryKey().defaultRandom(),
  calendarId: uuid('calendar_id').notNull().references(() => calendars.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  location: text('location'),
  startUtc: timestamp('start_utc', { withTimezone: true }).notNull(),
  endUtc: timestamp('end_utc', { withTimezone: true }).notNull(),
  allDay: boolean('all_day').notNull().default(false),
  tz: text('tz').notNull(),
  localStart: timestamp('local_start', { mode: 'string' }),
  localEnd: timestamp('local_end', { mode: 'string' }),
  rrule: text('rrule'),
  recurUntil: timestamp('recur_until', { withTimezone: true }),
  exceptions: jsonb('exceptions').$type<string[]>().notNull().default([]),
  seriesId: uuid('series_id'),
  recurrenceDate: date('recurrence_date', { mode: 'string' }),
  version: integer('version').notNull().default(1),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  updatedBy: uuid('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, (t) => [
  foreignKey({ columns: [t.calendarId, t.memberId], foreignColumns: [members.calendarId, members.id] }),
  check('events_end_after_start', sql`end_utc > start_utc`),
  check('events_max_duration', sql`end_utc - start_utc <= interval '7 days'`),
  index('events_range_idx').on(t.calendarId, t.startUtc, t.endUtc).where(sql`deleted_at is null`),
  index('events_member_idx').on(t.calendarId, t.memberId),
  index('events_series_idx').on(t.seriesId),
]);

export const eventAudit = pgTable('event_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  calendarId: uuid('calendar_id').notNull().references(() => calendars.id, { onDelete: 'cascade' }),
  eventId: uuid('event_id').notNull(),
  action: text('action', { enum: ['create', 'update', 'delete', 'restore'] }).notNull(),
  actorMemberId: uuid('actor_member_id').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  before: jsonb('before'),
  after: jsonb('after'),
}, (t) => [index('event_audit_event_idx').on(t.calendarId, t.eventId, t.at)]);

export const invites = pgTable('invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  calendarId: uuid('calendar_id').notNull().references(() => calendars.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  createdBy: uuid('created_by').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  maxUses: integer('max_uses'),
  uses: integer('uses').notNull().default(0),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [index('invites_calendar_idx').on(t.calendarId)]);

export const authAttempts = pgTable('auth_attempts', {
  key: text('key').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull().defaultNow(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

export const idempotencyKeys = pgTable('idempotency_keys', {
  key: text('key').notNull(),
  calendarId: uuid('calendar_id').notNull().references(() => calendars.id, { onDelete: 'cascade' }),
  memberId: uuid('member_id').notNull(),
  requestHash: text('request_hash').notNull(),
  response: jsonb('response'),
  createdAt: createdAt(),
}, (t) => [primaryKey({ columns: [t.key, t.calendarId] })]);
