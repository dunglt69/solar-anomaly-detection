ALTER TABLE `users` ADD `personal_email` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` ADD `dob` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `status`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `suspended_until`;
--> statement-breakpoint
ALTER TABLE `users` DROP COLUMN `suspension_reason`;
