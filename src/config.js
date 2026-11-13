import dotenv from 'dotenv';
dotenv.config();
function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}
export const config = {
  env: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT ?? 3000),
  mongoUri: required('MONGODB_URI', 'mongodb://127.0.0.1:27017/myslp'),
  jwtSecret: required('JWT_SECRET', 'dev-only-insecure-secret-change-me'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  adminSeedEmail: process.env.ADMIN_SEED_EMAIL ?? 'admin@myslp.sl',
  adminSeedPassword: process.env.ADMIN_SEED_PASSWORD ?? 'Admin@123',
  demoSeedPassword: process.env.DEMO_SEED_PASSWORD ?? 'Demo@1234',
  /**
   * The `currency` value returned by GET /rest/statistics.
   *
   * The coursework specification prints this literally as "sld", but the module
   * leader confirmed that "Shangri-La dollars" was a typo and the currency is
   * pounds — so this returns "gbp" to match the rest of the app. Override with
   * REST_CURRENCY if the automated harness turns out to expect something else.
   */
  restCurrency: process.env.REST_CURRENCY ?? 'gbp',
  // Optional: reading meter photographs. Without it the app falls back to
  // manual entry and says so, rather than failing.
  ocrSpaceKey: process.env.OCR_SPACE_KEY ?? '',
  /** SMTP. Leave SMTP_HOST empty to print verification emails to the log. */
  /**
   * The wordmark shown at the top of every email, as a hosted URL.
   *
   * Hosted rather than attached: an inline `cid:` attachment is the more
   * reliable way to render a logo in theory, but in practice a Gmail account
   * sending image attachments to another Gmail account had its mail dropped
   * silently. A plain remote image carries no attachment for a filter to
   * weigh. Gmail proxies it through googleusercontent, so nothing leaks about
   * who opened it.
   *
   * The master artwork is src/assets/wordmark.png — re-upload that if the
   * hosted copy ever needs replacing.
   */
  mailLogo: {
    url:
      process.env.MAIL_LOGO_URL ||
      'https://res.cloudinary.com/dlo18vcfk/image/upload/v1794562461/Screenshot_2026-11-13_091245_koia2c.png',
    width: Number(process.env.MAIL_LOGO_WIDTH || 87),
    height: Number(process.env.MAIL_LOGO_HEIGHT || 44),
  },
  smtp: {
    /**
     * The hostname announced in the SMTP EHLO greeting.
     *
     * Left unset, nodemailer sends the machine's own hostname, which on a
     * laptop is not a resolvable FQDN. Some strict relays care; Gmail does
     * not — it authorises by credentials. Set SMTP_NAME to override.
     */
    name: process.env.SMTP_NAME || undefined,
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? 'MySLP <no-reply@myslp.sl>',
  },
  /** One-time email verification codes. */
  otp: {
    ttlMinutes: Number(process.env.OTP_TTL_MINUTES ?? 10),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 5),
    resendSeconds: Number(process.env.OTP_RESEND_SECONDS ?? 60),
  },
  bcryptRounds: 12,
  /** New accounts start with this much energy credit, in pounds. */
  startingEnergyCredit: 500,
  /**
   * The Shangri-La Council's cost-of-living payment for homes in Council Tax
   * bands A to D. The brief writes it as "200 Shangri-La dollars"; the module
   * leader confirmed the currency is pounds, as everywhere else in the app.
   */
  councilPayment: {
    amount: 200,
    eligibleBands: ['A', 'B', 'C', 'D'],
  },
};
