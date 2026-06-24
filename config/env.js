const fs = require('fs');
const path = require('path');

/**
 * Environment validation
 * Fail fast if critical environment variables are missing
 */

function validateEnv() {
  const errors = [];
  const warnings = [];

  const requiredVars = [
    'MONGO_URI',
    'JWT_SECRET',
    'CLIENT_URL',
    'GEMINI_API_KEY',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET',
    'RESEND_API_KEY',
    'SENDER_EMAIL'
  ];

  const optionalVars = [];

  const hasVisionEnvVars = Boolean(
    String(process.env.GOOGLE_PROJECT_ID || '').trim() &&
    String(process.env.GOOGLE_CLIENT_EMAIL || '').trim() &&
    String(process.env.GOOGLE_PRIVATE_KEY || '').trim()
  );

  if (hasVisionEnvVars) {
    console.log('[env] Google Vision configured via environment variables.');
  } else {
    if (!process.env.GOOGLE_PROJECT_ID || !process.env.GOOGLE_PROJECT_ID.trim()) {
      errors.push('GOOGLE_PROJECT_ID is missing');
    }
    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_CLIENT_EMAIL.trim()) {
      errors.push('GOOGLE_CLIENT_EMAIL is missing');
    }
    if (!process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_PRIVATE_KEY.trim()) {
      errors.push('GOOGLE_PRIVATE_KEY is missing');
    }
  }

  for (const key of requiredVars) {
    const value = process.env[key];

    if (!value || !value.trim()) {
      errors.push(`${key} is missing`);
    }
  }

  for (const key of optionalVars) {
    const value = process.env[key];
    if (!value || !value.trim()) {
      warnings.push(`${key}`);
    }
  }

  // Validate CLIENT_URL format
  if (process.env.CLIENT_URL) {
    const urls = process.env.CLIENT_URL
      .split(',')
      .map(url => url.trim());

    for (const url of urls) {
      try {
        new URL(url);
      } catch {
        errors.push(`Invalid CLIENT_URL: ${url}`);
      }
    }
  }

  if (warnings.length > 0) {
    console.warn('\n⚠️ ENV VALIDATION WARNING:');
    warnings.forEach(warn => {
      console.warn(`- ${warn} is missing (optional services like email/OTP will be disabled)`);
    });
    console.log('');
  }

  if (errors.length > 0) {
    console.error('\n❌ ENV VALIDATION FAILED\n');

    errors.forEach(err => {
      console.error(`- ${err}`);
    });

    console.error('\nFix your .env file and restart server.\n');

    process.exit(1);
  }

  console.log('Environment variables validated');
}

module.exports = {
  validateEnv
};
