CREATE TABLE IF NOT EXISTS `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`active` integer NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `inbound` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`account` text NOT NULL,
	`event` text NOT NULL,
	`endpoint` text NOT NULL,
	`accepted_at` integer NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `inbound_fifo` ON `inbound` (`endpoint`,`accepted_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `inbound_channel_account_event_unique` ON `inbound` (`channel`,`account`,`event`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `media` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`reference` text NOT NULL,
	`data` blob,
	`digest` text NOT NULL,
	`staged` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_channel` ON `media` (`channel_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `outbound` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`digest` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`record` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `outbound_channel_order` ON `outbound` (`channel_id`) WHERE "outbound"."status" in ('pending','unknown');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `outbound_channel_id_message_id_unique` ON `outbound` (`channel_id`,`message_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `plugin_state` (
	`plugin` text NOT NULL,
	`owner` text NOT NULL,
	`key` text NOT NULL,
	`version` integer NOT NULL,
	`expires_at` integer,
	`record` text NOT NULL,
	PRIMARY KEY(`plugin`, `owner`, `key`)
);
