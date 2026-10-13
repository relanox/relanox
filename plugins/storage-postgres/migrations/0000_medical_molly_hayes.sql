CREATE TABLE IF NOT EXISTS "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"active" boolean NOT NULL,
	"record" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "inbound" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"account" text NOT NULL,
	"event" text NOT NULL,
	"endpoint" text NOT NULL,
	"accepted_at" bigint NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "inbound_channel_account_event_unique" UNIQUE("channel","account","event")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"reference" jsonb NOT NULL,
	"data" "bytea",
	"digest" text NOT NULL,
	"staged" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "media_channel_id_conversations_id_fk" FOREIGN KEY ("channel_id") REFERENCES "conversations"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "outbound" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"sequence" bigint GENERATED ALWAYS AS IDENTITY (sequence name "outbound_sequence_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"channel_id" text NOT NULL,
	"message_id" text NOT NULL,
	"digest" text NOT NULL,
	"status" text NOT NULL,
	"version" integer NOT NULL,
	"record" jsonb NOT NULL,
	CONSTRAINT "outbound_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "outbound_channel_id_message_id_unique" UNIQUE("channel_id","message_id"),
	CONSTRAINT "outbound_channel_id_conversations_id_fk" FOREIGN KEY ("channel_id") REFERENCES "conversations"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plugin_state" (
	"plugin" text NOT NULL,
	"owner" text NOT NULL,
	"key" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"expires_at" bigint,
	"record" jsonb NOT NULL,
	CONSTRAINT "plugin_state_plugin_owner_key_pk" PRIMARY KEY("plugin","owner","key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_fifo" ON "inbound" USING btree ("endpoint","accepted_at","id") WHERE "inbound"."status"='due';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_due" ON "inbound" USING btree ((("record"#>>'{dispatch,dueAt}')::bigint),"accepted_at","id") WHERE "inbound"."status"='due';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbound_lease" ON "inbound" USING btree ((("record"#>>'{dispatch,lease,expiresAt}')::bigint)) WHERE "inbound"."status"='due';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_channel" ON "media" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_channel_order" ON "outbound" USING btree ("channel_id","sequence") WHERE "outbound"."status" IN ('pending','unknown');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_due" ON "outbound" USING btree ((("record"->>'dueAt')::bigint),"id") WHERE "outbound"."status"='pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_lease" ON "outbound" USING btree ((("record"#>>'{lease,expiresAt}')::bigint)) WHERE "outbound"."status"='pending';