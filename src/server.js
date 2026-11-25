import app from './app.js';
import { config } from './config.js';
import { connectDB } from './db.js';
//local entry point
async function main() {
  await connectDB();
  app.listen(config.port, () => {
    console.log(`\n  MySLP API running on http://localhost:${config.port}`);
    console.log(`  Health:     http://localhost:${config.port}/health`);
    console.log(
      `  Council tax: http://localhost:${config.port}/rest/council_tax_check?postcode=LE17RH&fulladdress=20%20University%20Road,%20Shangri-La`,
    );
    console.log(`  Statistics:  http://localhost:${config.port}/rest/statistics/A/LE2\n`);
  });
}
main().catch((err) => {
  console.error('Failed to start the MySLP API:', err);
  process.exit(1);
});
