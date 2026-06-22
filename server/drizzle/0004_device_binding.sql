DROP TABLE IF EXISTS `blocked_ips`;
--> statement-breakpoint
DROP TABLE IF EXISTS `blocked_devices`;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `employee_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_employee_id_unique` ON `users` (`employee_id`);
--> statement-breakpoint
CREATE TABLE `registered_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`device_token` text NOT NULL,
	`hw_signature` text NOT NULL,
	`browser` text,
	`os` text,
	`registered_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`is_active` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `registered_devices_user_id_unique` ON `registered_devices` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `registered_devices_device_token_unique` ON `registered_devices` (`device_token`);