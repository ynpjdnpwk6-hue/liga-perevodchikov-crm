CREATE TABLE `auth_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`attempts` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `phone_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`customer_id` integer NOT NULL,
	`phone` text NOT NULL,
	`password_hash` text NOT NULL,
	`recovery_hash` text NOT NULL,
	`role` text DEFAULT 'investigator' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "phone_role" CHECK("phone_accounts"."role" IN ('admin','investigator')),
	CONSTRAINT "phone_active" CHECK("phone_accounts"."active" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_phone_number` ON `phone_accounts` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_phone_owner` ON `phone_accounts` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_owner_phone_admin` ON `phone_accounts` (`owner_id`) WHERE "phone_accounts"."role" = 'admin';--> statement-breakpoint
CREATE TABLE `phone_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `phone_accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_session_account` ON `phone_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_session_expiry` ON `phone_sessions` (`expires_at`);--> statement-breakpoint
ALTER TABLE `orders` ADD `requester_phone_id` text REFERENCES phone_accounts(id);