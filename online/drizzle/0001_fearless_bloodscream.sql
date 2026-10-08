CREATE TABLE `investigator_accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`email` text NOT NULL,
	`user_id` text,
	`customer_id` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "investigator_active_boolean" CHECK("investigator_accounts"."active" IN (0,1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_investigator_email` ON `investigator_accounts` (`owner_id`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_investigator_user` ON `investigator_accounts` (`owner_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `league` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	CONSTRAINT "one_league" CHECK("league"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE `audit` ADD `actor_id` text;--> statement-breakpoint
ALTER TABLE `orders` ADD `requester_account_id` integer REFERENCES investigator_accounts(id);