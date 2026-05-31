require('dotenv').config();
const { validateEnv } = require('./config/env');
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { checkPdftoppm } = require('./utils/checkPdftoppm');
const authRoutes = require('./routes/auth');
const evalRoutes = require('./routes/evaluation');
const paymentRoutes = require('./routes/payment');
const { requeueIncompleteJobs } = require('./queue/evaluationQueue');

const app = express();
const PORT = process.env.PORT || 3001;
const mongoUri = process.env.MONGO_URI;
const isProd = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);

console.log('[env] RESEND_API_KEY present:', Boolean(process.env.RESEND_API_KEY));
console.log('[env] SENDER_EMAIL:', process.env.SENDER_EMAIL || 'onboarding@resend.dev (default)');
checkPdftoppm();
validateEnv();
app.disable('x-powered-by');
const uploadDir = path.join(__dirname, 'uploads');
const resultsDir = path.join(__dirname, 'results');
[uploadDir, resultsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.puter.com', 'https://checkout.razorpay.com'],
      imgSrc: ["'self'", 'data:', 'https://*.razorpay.com'],
      objectSrc: ["'none'"],
      connectSrc: [
        "'self'",
        'https://js.puter.com',
        'https://api.puter.com',
        'https://puter.com',
        'https://*.puter.com',
        'https://*.puter.site',
        'https://api.razorpay.com',
        'https://*.razorpay.com'
      ],
      frameSrc: ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com', 'https://*.razorpay.com'],
      formAction: ["'self'"]
    }
  }
}));

const allowedOrigins = String(process.env.CLIENT_URL || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : false,
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use('/api/auth/send-otp', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests.' }
}));

app.use('/api/auth/verify-otp', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many OTP verification attempts.' }
}));

app.use('/api/auth/register', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts.' }
}));

app.use('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts.' }
}));

app.use('/api/eval/upload', rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many upload requests.' }
}));

app.use('/api/eval/save-result', rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many save requests.' }
}));

app.use('/api/auth', authRoutes);
app.use('/api/eval', evalRoutes);
app.use('/api/payment', paymentRoutes);
app.get('/api/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const clientDir = path.join(__dirname, '../client/dist');
const hasClientBuild = fs.existsSync(clientDir) && fs.existsSync(path.join(clientDir, 'index.html'));

if (hasClientBuild) {
  app.use(express.static(clientDir));

  app.get('/login', (_req, res) => res.sendFile(path.join(clientDir, 'login.html')));
  app.get('/register', (_req, res) => res.sendFile(path.join(clientDir, 'register.html')));
  app.get('/', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
}

app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Route not found.' });
  }

  if (hasClientBuild) {
    return res.sendFile(path.join(clientDir, 'index.html'));
  }

  return res.status(404).json({ error: 'Route not found.' });
});

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

if (!mongoUri) {
  console.error('MONGO_URI is missing. Database-backed APIs will fail until it is set.');
} else {
  mongoose.connect(mongoUri)
    .then(async () => {
      console.log('MongoDB connected');
      
      // Migration: Initialize tokens for legacy accounts
      try {
        const Faculty = require('./models/Faculty');
        const count = await Faculty.updateMany(
          { availableTokens: { $exists: false } },
          { 
            $set: { 
              availableTokens: 20, 
              totalUsedTokens: 0, 
              totalEvaluatedPdfs: 0, 
              transactionHistory: [] 
            } 
          }
        );
        if (count.modifiedCount > 0) {
          console.log(`[Migration] Initialized token fields for ${count.modifiedCount} faculty profiles.`);
        }
      } catch (err) {
        console.error('[Migration] Token migration failed:', err.message);
      }

      // Backfill: Pre-populate analytics for all faculties with completed jobs on startup
      try {
        const EvalJob = require('./models/EvaluationJob');
        const { enqueueAnalytics } = require('./services/analyticsService');
        const uniqueFacultyIds = await EvalJob.distinct('facultyId', { status: 'completed' });
        console.log(`[Analytics Startup Backfill] Found ${uniqueFacultyIds.length} faculties with completed jobs. Queuing updates.`);
        for (const facultyId of uniqueFacultyIds) {
          enqueueAnalytics(facultyId);
        }
      } catch (err) {
        console.error('[Analytics Startup Backfill] Error:', err.message);
      }

      try {
        await requeueIncompleteJobs();
      } catch (err) {
        console.error('Failed to restore queued jobs:', err.message);
      }
    })
    .catch(err => console.error('MongoDB error:', err.message));
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  if (!isProd) {
    console.log('[debug] Email test route enabled: POST /api/auth/test-email');
  }
}).on('error', err => {
  console.error('Server failed to start:', err);
  process.exit(1);
});
