import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TYPE "album_type_enum" AS ENUM ('manual','smart');`.execute(db);
  await sql`ALTER TABLE "album" ADD "albumType" album_type_enum NOT NULL DEFAULT 'manual';`.execute(db);
  await sql`ALTER TABLE "album" ADD "rules" jsonb;`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "album" DROP COLUMN "rules";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "albumType";`.execute(db);
  await sql`DROP TYPE "album_type_enum";`.execute(db);
}
