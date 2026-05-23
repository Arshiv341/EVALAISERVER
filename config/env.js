const fs = require('fs');
const path = require('path');

/**
 * Environment validation
 * Fail fast if critical environment variables are missing
 */

function validateEnv() {
  const errors = [];

  const requiredVars = [
    'MONGO_URI',
    'JWT_SECRET',
    'CLIENT_URL',
    'EMAIL_USER',
    'EMAIL_PASS',
    'GEMINI_API_KEY',
    'RAZORPAY_KEY_ID',
    'RAZORPAY_KEY_SECRET'
  ];

  const hasGoogleApplicationCredentials = Boolean(
    String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim()
  );

  if (!hasGoogleApplicationCredentials) {
    requiredVars.push('GOOGLE_PROJECT_ID');
    requiredVars.push('GOOGLE_CLIENT_EMAIL');
    requiredVars.push('GOOGLE_PRIVATE_KEY');
  } else {
    const credentialPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
    const resolvedCredentialPath = path.isAbsolute(credentialPath)
      ? credentialPath
      : path.resolve(__dirname, '..', credentialPath);

    if (!fs.existsSync(resolvedCredentialPath)) {
      errors.push(`GOOGLE_APPLICATION_CREDENTIALS file not found: ${credentialPath}`);
    }
  }

  for (const key of requiredVars) {
    const value = process.env[key];

    if (!value || !value.trim()) {
      errors.push(`${key} is missing`);
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

  if (errors.length > 0) {
    console.error('\nENV VALIDATION FAILED\n');

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
