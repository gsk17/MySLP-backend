/**
 * A second API instance, run as its own process.
 *
 * The rate-limit test needs two instances that share a database but NOT
 * memory — what Vercel does when it routes the same deployment to two
 * serverless instances. Importing the app twice in one process does not
 * achieve that: Node resolves `../src/app.js?x=1` to a fresh module, but its
 * dependencies keep their original specifiers and are reused, so the limiter
 * closure is shared and the test would pass against a purely in-memory
 * counter.
 *
 * Spawned by the test with MONGODB_URI in the environment; prints the port it
 * is listening on so the parent can address it.
 */
import { connectDB } from '../../src/db.js';
import app from '../../src/app.js';

await connectDB(process.env.MONGODB_URI);

const server = app.listen(0, () => {
  process.stdout.write(`PORT=${server.address().port}\n`);
});
