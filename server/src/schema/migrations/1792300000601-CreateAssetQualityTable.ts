import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_quality" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "assetId" uuid NOT NULL,
  "blur" double precision NOT NULL,
  "exposure" double precision NOT NULL,
  "subject" double precision NOT NULL,
  "eyesOpen" double precision,
  "overall" double precision NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL,
  CONSTRAINT "asset_quality_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_quality_pkey" PRIMARY KEY ("id")
);`.execute(db);
  await sql`CREATE INDEX "asset_quality_assetId_idx" ON "asset_quality" ("assetId");`.execute(db);
  await sql`CREATE UNIQUE INDEX "asset_quality_assetId_key" ON "asset_quality" ("assetId");`.execute(db);
  await sql`COMMENT ON COLUMN "asset_quality"."blur" IS 'Sharpness (normalized Laplacian variance), 0..1';`.execute(db);
  await sql`COMMENT ON COLUMN "asset_quality"."exposure" IS 'Exposure quality (clipping penalty), 0..1';`.execute(db);
  await sql`COMMENT ON COLUMN "asset_quality"."subject" IS 'Subject presence (face-based), 0..1';`.execute(db);
  await sql`COMMENT ON COLUMN "asset_quality"."eyesOpen" IS 'Eyes-open signal, 0..1 — null until a dedicated model exists';`.execute(db);
  await sql`COMMENT ON COLUMN "asset_quality"."overall" IS 'Weighted overall score used for ranking, 0..1';`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_quality";`.execute(db);
}
