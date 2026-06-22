CREATE TABLE `blocked_devices` (
	`fingerprint` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`blocked_by` text NOT NULL,
	`blocked_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`blocked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `blocked_ips` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `status` text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `suspended_until` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `suspension_reason` text;