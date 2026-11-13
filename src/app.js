import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { config } from './config.js';
import { connectDB } from './db.js';
import { errorHandler, notFoundHandler, asyncHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/account.js';
import customerRoutes from './routes/customer.js';
import adminRoutes from './routes/admin.js';
import restRoutes from './routes/rest.js';
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Security + parsing
// ---------------------------------------------------------------------------
app.use(
  helmet({
    // This is a JSON API consumed by a separate SPA and a Capacitor webview.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: {
      policy: 'cross-origin',
    },
  }),
);
const STATIC_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://localhost',
  'capacitor://localhost',
  'ionic://localhost',
  'https://localhost',
];
app.use(
  cors({
    origin(origin, callback) {
      // No Origin header: curl, Postman, server-to-server, the test harness.
      if (!origin) return callback(null, true);
      if (
        STATIC_ALLOWED_ORIGINS.includes(origin) ||
        config.corsOrigins.includes(origin) ||
        /^https:\/\/[a-z0-9-]+\.lovable\.app$/i.test(origin) ||
        /^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin) ||
        /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)
      ) {
        return callback(null, true);
      }

      // Unknown browser origin: refuse the CORS headers rather than the request,
      // so non-browser clients (the marker's test harness) are never blocked.
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  }),
);
// 100kb is the right ceiling for every JSON endpoint except the meter photo,
// which carries a base64 image and mounts its own parser on the route.
const smallJson = express.json({
  limit: '100kb',
  strict: true,
});
app.use((req, res, next) =>
  req.path === '/api/readings/scan' || req.path === '/api/vouchers/scan'
    ? next()
    : smallJson(req, res, next),
);
app.use(
  express.urlencoded({
    extended: false,
    limit: '100kb',
  }),
);
if (!config.isProd) {
  app.use(morgan('dev'));
}

// ---------------------------------------------------------------------------
// Database: connect before any route runs. On Vercel this resolves instantly
// after the first invocation thanks to the cached connection in db.ts.
// ---------------------------------------------------------------------------
app.use(
  asyncHandler(async (_req, _res, next) => {
    await connectDB();
    next();
  }),
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get('/health', (_req, res) => {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  res.json({
    ok: true,
    service: 'myslp-api',
    db: states[mongoose.connection.readyState] ?? 'unknown',
    time: new Date().toISOString(),
  });
});
app.get('/', (_req, res) => {
  res.json({
    service: 'MySLP — My Shangri-La Power REST API',
    endpoints: {
      health: '/health',
      councilTaxCheck:
        '/rest/council_tax_check?postcode=LE17RH&fulladdress=20 University Road, Shangri-La',
      statistics: '/rest/statistics/{band}/{postcode_prefix}',
      auth: '/api/auth/{register,login,check-email,me}',
      customer: '/api/{profile,readings,bills,vouchers/redeem,payments,usage}',
      admin: '/api/admin/{tariffs,customers,statistics,vouchers}',
    },
  });
});

// Task 2 — public, automatically tested.
app.use('/rest', restRoutes);

// Task 1 — the application API.
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', accountRoutes);
app.use('/api', customerRoutes);

// ---------------------------------------------------------------------------
// 404 + the single error handler. These must be last.
// ---------------------------------------------------------------------------
app.use(notFoundHandler);
app.use(errorHandler);
export default app;
