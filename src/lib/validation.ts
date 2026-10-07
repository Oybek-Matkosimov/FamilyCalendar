import { z } from 'zod';
import { isValidTimezone } from './time';
import { AppError } from './errors';

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const cleanText = (s: string): string => s.normalize('NFC').replace(CTRL, '').trim();
export const nameKey = (s: string): string => cleanText(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');

const text = (max: number, min = 1) => z.string().transform(cleanText).pipe(z.string().min(min, 'Required').max(max));
const optText = (max: number) => z.string().transform(cleanText).pipe(z.string().max(max)).optional();

export const passwordSchema = z.string().min(8, 'At least 8 characters').max(128, 'At most 128 characters');
export const timezoneSchema = z.string().refine(isValidTimezone, 'Unknown timezone');
export const codeSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{4}-\d{4}$/, 'Invalid calendar ID'));

export const createCalendarSchema = z.object({
  familyName: text(60),
  memberName: text(40),
  password: passwordSchema,
  timezone: timezoneSchema,
});
export type CreateCalendarInput = z.infer<typeof createCalendarSchema>;

export const joinSchema = z.object({
  code: codeSchema,
  memberName: text(40),
  // Join accepts any 1-128 char password so a legacy short password never locks someone out; creation enforces >= 8.
  password: z.string().min(1).max(128),
  confirmExisting: z.boolean().optional(),
  inviteToken: z.string().max(200).optional(),
});
export type JoinInput = z.infer<typeof joinSchema>;

const localDt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:mm');
const DAYS = z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);

export const recurrenceInputSchema = z.object({
  freq: z.enum(['daily', 'weekdays', 'weekly', 'monthly', 'custom']),
  interval: z.number().int().min(1).max(52).optional(),
  byDay: z.array(DAYS).max(7).optional(),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  count: z.number().int().min(1).max(1000).optional(),
});
export type RecurrenceInput = z.infer<typeof recurrenceInputSchema>;

export const eventInputSchema = z.object({
  title: text(120),
  memberId: z.string().uuid(),
  description: optText(2000),
  location: optText(200),
  allDay: z.boolean(),
  start: localDt,
  end: localDt,
  recurrence: recurrenceInputSchema.optional(),
});
export type EventInput = z.infer<typeof eventInputSchema>;

export const eventPatchSchema = eventInputSchema.partial().extend({
  version: z.number().int().min(1),
  scope: z.enum(['this', 'series']).default('series'),
  occurrenceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type EventPatch = z.infer<typeof eventPatchSchema>;

export const rangeSchema = z
  .object({ from: z.coerce.date(), to: z.coerce.date() })
  .refine((r) => r.from < r.to && r.to.getTime() - r.from.getTime() <= 366 * 86400000, 'Invalid range (max 366 days)');

export const updateCalendarSchema = z.object({
  name: text(60).optional(),
  timezone: timezoneSchema.optional(),
  settings: z.object({ membersCanEditAll: z.boolean().optional() }).optional(),
});
export type UpdateCalendarInput = z.infer<typeof updateCalendarSchema>;

export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });
export const recoverSchema = z.object({
  code: codeSchema,
  recoveryCode: z.string().transform((s) => s.trim().toUpperCase()).pipe(z.string().min(8).max(32)),
  newPassword: passwordSchema,
});
export const deleteCalendarSchema = z.object({ confirmName: z.string().max(200) });

/** Parse unknown input with a zod schema, converting failures to AppError('VALIDATION'). */
export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new AppError('VALIDATION', r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  return r.data;
}

export const createInviteSchema = z.object({
  expiresInHours: z.number().int().min(1).max(720).optional(),
  maxUses: z.number().int().min(1).max(100).nullable().optional(),
});
export type CreateInviteInput = z.infer<typeof createInviteSchema>;

export const removeMemberQuerySchema = z
  .object({ events: z.enum(['keep', 'delete', 'reassign']).default('keep'), to: z.string().uuid().optional() })
  .refine((q) => q.events !== 'reassign' || !!q.to, { message: 'to is required when events=reassign', path: ['to'] });

export const joinInfoQuerySchema = z.object({ token: z.string().min(1).max(200) });
