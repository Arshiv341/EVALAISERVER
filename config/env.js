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
    'GEMINI_API_KEY'
  ];

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
    console.error('\n❌ ENV VALIDATION FAILED\n');

    errors.forEach(err => {
      console.error(`- ${err}`);
    });

    console.error('\nFix your .env file and restart server.\n');

    process.exit(1);
  }

  console.log('✅ Environment variables validated');
}

module.exports = {
  validateEnv
};
