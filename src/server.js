import app from './app.js';
import { config } from './config.js';
import { connectDB } from './db.js';
//local entry point
async function main() {
  await connectDB();
  app.listen(config.port, () => {
    console.log(`\n  MySLP API running on http://localhost:${config.port}`);});
}
main().catch((err) => {
  console.error('Failed to start the MySLP API:', err);
  process.exit(1);
});
