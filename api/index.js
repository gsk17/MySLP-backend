import app from '../src/app.js';

/**
 * Vercel serverless entry point.
 *
 * The Express app is exported directly — there is deliberately NO app.listen()
 * here. vercel.json rewrites every path to this function, so Express owns the
 * routing and `/rest/council_tax_check` resolves exactly as the coursework
 * specification requires.
 */
export default app;
