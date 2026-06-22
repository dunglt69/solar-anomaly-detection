CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`actor_id` text,
	`actor_role` text DEFAULT 'system' NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`details` text,
	`ip` text,
	`user_agent` text
);
--> statement-breakpoint
CREATE INDEX `activity_timestamp_idx` ON `activity_log` (`timestamp`);--> statement-breakpoint
CREATE INDEX `activity_actor_idx` ON `activity_log` (`actor_id`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` integer NOT NULL,
	`severity` text NOT NULL,
	`fault_type` integer NOT NULL,
	`confidence` real NOT NULL,
	`detection_layer` text NOT NULL,
	`telemetry_id` integer,
	`acknowledged` integer DEFAULT false NOT NULL,
	`acknowledged_by` text,
	`acknowledged_at` integer,
	`ticket_id` text,
	FOREIGN KEY (`telemetry_id`) REFERENCES `telemetry`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`acknowledged_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `alerts_timestamp_idx` ON `alerts` (`timestamp`);--> statement-breakpoint
CREATE INDEX `alerts_severity_idx` ON `alerts` (`severity`);--> statement-breakpoint
CREATE INDEX `alerts_acknowledged_idx` ON `alerts` (`acknowledged`);--> statement-breakpoint
CREATE INDEX `alerts_fault_type_idx` ON `alerts` (`fault_type`);--> statement-breakpoint
CREATE TABLE `blocked_ips` (
	`ip` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`blocked_by` text NOT NULL,
	`blocked_at` integer NOT NULL,
	FOREIGN KEY (`blocked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`refresh_token` text NOT NULL,
	`token_family` text NOT NULL,
	`ip` text,
	`user_agent` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_refresh_token_unique` ON `sessions` (`refresh_token`);--> statement-breakpoint
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_token_family_idx` ON `sessions` (`token_family`);--> statement-breakpoint
CREATE TABLE `telemetry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` integer NOT NULL,
	`vdc1` real NOT NULL,
	`vdc2` real NOT NULL,
	`idc1` real NOT NULL,
	`idc2` real NOT NULL,
	`irr` real NOT NULL,
	`pvt` real NOT NULL,
	`pdc1` real NOT NULL,
	`pdc2` real NOT NULL,
	`pdc_total` real NOT NULL,
	`fault_label` integer
);
--> statement-breakpoint
CREATE INDEX `telemetry_timestamp_idx` ON `telemetry` (`timestamp`);--> statement-breakpoint
CREATE INDEX `telemetry_fault_label_idx` ON `telemetry` (`fault_label`);--> statement-breakpoint
CREATE TABLE `ticket_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `comments_ticket_idx` ON `ticket_comments` (`ticket_id`);--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`severity` text NOT NULL,
	`fault_type` integer NOT NULL,
	`affected_component` text,
	`title` text NOT NULL,
	`description` text,
	`assignee_id` text,
	`created_by` text,
	`alert_id` text,
	`was_escalated` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`resolved_at` integer,
	`resolution_summary` text,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tickets_status_idx` ON `tickets` (`status`);--> statement-breakpoint
CREATE INDEX `tickets_assignee_idx` ON `tickets` (`assignee_id`);--> statement-breakpoint
CREATE INDEX `tickets_alert_id_idx` ON `tickets` (`alert_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'staff' NOT NULL,
	`avatar_url` text,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);