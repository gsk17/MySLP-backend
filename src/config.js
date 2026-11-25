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
 
  //currency
  restCurrency: process.env.REST_CURRENCY ?? 'gbp',
  //reading meter photographs
  ocrSpaceKey: process.env.OCR_SPACE_KEY ?? '',
  //smtp-mail
  mailLogo: {
    url:
      process.env.MAIL_LOGO_URL ||
      'https://res.cloudinary.com/dlo18vcfk/image/upload/v1794562461/Screenshot_2026-11-13_091245_koia2c.png',
    width: Number(process.env.MAIL_LOGO_WIDTH || 87),
    height: Number(process.env.MAIL_LOGO_HEIGHT || 44),
  },
  smtp: {
    name: process.env.SMTP_NAME || undefined,
    host: process.env.SMTP_HOST ?? '',
    port: Number(process.env.SMTP_PORT ?? 587),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.MAIL_FROM ?? 'MySLP <no-reply@myslp.sl>',
  },
  //otp-rules
  otp: {
    ttlMinutes: Number(process.env.OTP_TTL_MINUTES ?? 10),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 5),
    resendSeconds: Number(process.env.OTP_RESEND_SECONDS ?? 60),
  },
  bcryptRounds: 12,
  startingEnergyCredit: 500,
  //check-band and pay
  councilPayment: {
    amount: 200,
    eligibleBands: ['A', 'B', 'C', 'D'],
  },
};
