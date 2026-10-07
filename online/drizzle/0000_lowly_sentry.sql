CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`organization` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_customers_owner` ON `customers` (`owner_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`customer_id` integer NOT NULL,
	`translator_id` integer,
	`language` text NOT NULL,
	`scheduled_at` text DEFAULT '' NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`amount` integer DEFAULT 0 NOT NULL,
	`commission_percent` integer DEFAULT 30 NOT NULL,
	`commission_paid` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`translator_id`) REFERENCES `translators`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "nonnegative_amount" CHECK("orders"."amount" >= 0),
	CONSTRAINT "nonnegative_paid" CHECK("orders"."commission_paid" >= 0),
	CONSTRAINT "fixed_commission" CHECK("orders"."commission_percent" = 30),
	CONSTRAINT "valid_status" CHECK("orders"."status" IN ('new','assigned','in_progress','completed','cancelled'))
);
--> statement-breakpoint
CREATE INDEX `idx_orders_owner` ON `orders` (`owner_id`);--> statement-breakpoint
CREATE INDEX `idx_orders_translator_status` ON `orders` (`translator_id`,`status`);--> statement-breakpoint
CREATE TABLE `translators` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`languages` text NOT NULL,
	`language_keys` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "active_boolean" CHECK("translators"."active" IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `idx_translators_owner` ON `translators` (`owner_id`);