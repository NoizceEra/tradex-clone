import { getDb, closeDb } from './client.ts';
import { migrate } from './migrate.ts';

/** Drop everything and re-apply the schema. Dev only. */
export async function reset(): Promise<void> {
  const db = await getDb();
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
}

if (process.argv[1]?.endsWith('reset.ts')) {
  reset()
    .then(() => {
      console.log('db reset');
      return closeDb();
    })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
