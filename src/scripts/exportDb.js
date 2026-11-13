import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../db.js';

/**
 * Exports every collection to exports/myslp.json for the coursework
 * submission. The brief asks for "your database schema and all data" — for a
 * MongoDB project this JSON dump plus the Mongoose schemas in src/models is
 * the equivalent of the .sql file a relational submission would provide.
 */
async function exportDb() {
  await connectDB();
  const dir = path.resolve(process.cwd(), 'exports');
  await fs.mkdir(dir, {
    recursive: true,
  });
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection.');
  const collections = await db.listCollections().toArray();
  const dump = {};
  for (const info of collections) {
    const docs = await db.collection(info.name).find({}).toArray();
    dump[info.name] = docs;
    console.log(`  ✓ ${info.name}: ${docs.length} documents`);
  }
  const outFile = path.join(dir, 'myslp.json');
  await fs.writeFile(
    outFile,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        database: db.databaseName,
        note: 'MongoDB export for CO3102/CO7102 CW2. Restore with: mongoimport --uri "<MONGODB_URI>" --collection <name> --jsonArray --file <name>.json, or run `npm run seed` to recreate this data from scratch.',
        collections: dump,
      },
      null,
      2,
    ),
    'utf8',
  );

  // Also write one file per collection, ready for mongoimport.
  for (const [name, docs] of Object.entries(dump)) {
    await fs.writeFile(path.join(dir, `${name}.json`), JSON.stringify(docs, null, 2), 'utf8');
  }
  console.log(`\n  Export written to ${outFile}\n`);
  await disconnectDB();
}
exportDb().catch(async (err) => {
  console.error('Export failed:', err);
  await disconnectDB().catch(() => undefined);
  process.exit(1);
});
