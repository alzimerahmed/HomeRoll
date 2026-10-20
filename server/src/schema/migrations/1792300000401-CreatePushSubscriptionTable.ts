import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "push_subscription" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "userId" uuid NOT NULL,
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "userAgent" text,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "push_subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "push_subscription_endpoint_uq" UNIQUE ("endpoint"),
  CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "push_subscription_userId_idx" ON "push_subscription" ("userId");`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "push_subscription";`.execute(db);
}
