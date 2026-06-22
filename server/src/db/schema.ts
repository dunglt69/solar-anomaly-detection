import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

// ─── Users ──────────────────────────────────────────────────────────
export const users = sqliteTable('users', {
  id: text('id').primaryKey(), // nanoid
  employeeId: text('employee_id').notNull().unique(), // EM-XXXX
  username: text('username').notNull().unique(),
  email: text('email').notNull().unique(),
  personalEmail: text('personal_email').notNull().default(''),
  dob: text('dob').notNull().default(''),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['admin', 'solar_operator', 'security_engineer'] }).notNull().default('solar_operator'),
  avatarUrl: text('avatar_url'),
  failedAttempts: integer('failed_attempts').notNull().default(0),
  lockedUntil: integer('locked_until', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});

// ─── Registered Devices (1:1 employee-device binding) ───────────────
export const registeredDevices = sqliteTable('registered_devices', {
  id: text('id').primaryKey(), // nanoid
  userId: text('user_id').notNull().unique().references(() => users.id, { onDelete: 'cascade' }),
  deviceToken: text('device_token').notNull().unique(), // UUID stored in httpOnly cookie
  hwSignature: text('hw_signature', { mode: 'json' }).$type<{
    cpuCores: number;
    ram: number | null;
    screen: string;
    platform: string;
    timezone: string;
    gpu: string;
    colorDepth: number;
    touchPoints: number;
  }>().notNull(),
  browser: text('browser'), // informational only
  os: text('os'), // informational only
  registeredAt: integer('registered_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
});

// ─── Sessions (Refresh tokens) ─────────────────────────────────────
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  refreshToken: text('refresh_token').notNull().unique(),
  tokenFamily: text('token_family').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  revoked: integer('revoked', { mode: 'boolean' }).notNull().default(false),
}, (table) => [
  index('sessions_user_id_idx').on(table.userId),
  index('sessions_token_family_idx').on(table.tokenFamily),
]);

// ─── Telemetry ──────────────────────────────────────────────────────
export const telemetry = sqliteTable('telemetry', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  // Dual-string PV system (2 strings × 8 panels)
  vdc1: real('vdc1').notNull(),    // Voltage String 1
  vdc2: real('vdc2').notNull(),    // Voltage String 2
  idc1: real('idc1').notNull(),    // Current String 1
  idc2: real('idc2').notNull(),    // Current String 2
  irr: real('irr').notNull(),      // Irradiance (W/m²)
  pvt: real('pvt').notNull(),      // PV Module Temperature (°C)
  // Derived power metrics
  pdc1: real('pdc1').notNull(),    // Power String 1 (vdc1 × idc1)
  pdc2: real('pdc2').notNull(),    // Power String 2 (vdc2 × idc2)
  pdcTotal: real('pdc_total').notNull(), // Total power (pdc1 + pdc2)
  // Fault label (from AI inference)
  faultLabel: integer('fault_label'),
}, (table) => [
  index('telemetry_timestamp_idx').on(table.timestamp),
  index('telemetry_fault_label_idx').on(table.faultLabel),
]);

// ─── Alerts ─────────────────────────────────────────────────────────
export const alerts = sqliteTable('alerts', {
  id: text('id').primaryKey(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  severity: text('severity', { enum: ['info', 'warning', 'critical', 'emergency'] }).notNull(),
  faultType: integer('fault_type').notNull(), // 0-4 from taxonomy
  confidence: real('confidence').notNull(),
  detectionLayer: text('detection_layer', { enum: ['statistical', 'rule', 'ai'] }).notNull(),
  telemetryId: integer('telemetry_id').references(() => telemetry.id),
  acknowledged: integer('acknowledged', { mode: 'boolean' }).notNull().default(false),
  acknowledgedBy: text('acknowledged_by').references(() => users.id),
  acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }),
  ticketId: text('ticket_id').references(() => tickets.id),
}, (table) => [
  index('alerts_timestamp_idx').on(table.timestamp),
  index('alerts_severity_idx').on(table.severity),
  index('alerts_acknowledged_idx').on(table.acknowledged),
  index('alerts_fault_type_idx').on(table.faultType),
]);

// ─── Tickets ────────────────────────────────────────────────────────
export const tickets = sqliteTable('tickets', {
  id: text('id').primaryKey(), // INC-YYYY-NNNNN
  status: text('status', {
    enum: ['open', 'acknowledged', 'in_progress', 'resolved', 'closed', 'escalated'],
  }).notNull().default('open'),
  severity: text('severity', { enum: ['info', 'warning', 'critical', 'emergency'] }).notNull(),
  faultType: integer('fault_type').notNull(),
  affectedComponent: text('affected_component'),
  title: text('title').notNull(),
  description: text('description'),
  assigneeId: text('assignee_id').references(() => users.id),
  createdBy: text('created_by'), // null = system auto-created
  alertId: text('alert_id'),
  wasEscalated: integer('was_escalated', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  resolvedAt: integer('resolved_at', { mode: 'timestamp' }),
  resolutionSummary: text('resolution_summary'),
}, (table) => [
  index('tickets_status_idx').on(table.status),
  index('tickets_assignee_idx').on(table.assigneeId),
  index('tickets_alert_id_idx').on(table.alertId),
]);

// ─── Ticket Comments ────────────────────────────────────────────────
export const ticketComments = sqliteTable('ticket_comments', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').notNull().references(() => tickets.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => users.id),
  content: text('content').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, (table) => [
  index('comments_ticket_idx').on(table.ticketId),
]);

// ─── Activity Log ───────────────────────────────────────────────────
export const activityLog = sqliteTable('activity_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  actorId: text('actor_id'), // null = SYSTEM
  actorRole: text('actor_role', { enum: ['admin', 'solar_operator', 'security_engineer', 'system'] }).notNull().default('system'),
  action: text('action', {
    enum: ['LOGIN', 'LOGOUT', 'LOGIN_FAILED', 'VIEW', 'CREATE', 'UPDATE', 'DELETE', 'DETECT', 'ALERT', 'DEVICE_REGISTERED', 'DEVICE_RESET', 'DEVICE_REJECTED'],
  }).notNull(),
  target: text('target'), // e.g., "ticket:INC-2026-00042"
  details: text('details', { mode: 'json' }),
  ip: text('ip'),
  userAgent: text('user_agent'),
}, (table) => [
  index('activity_timestamp_idx').on(table.timestamp),
  index('activity_actor_idx').on(table.actorId),
]);

// ─── System Config ──────────────────────────────────────────────────
export const config = sqliteTable('config', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedBy: text('updated_by').references(() => users.id),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
});
