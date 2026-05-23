const nodemailer = require('nodemailer');

const smtpUser = String(process.env.EMAIL_USER || '').trim();
const smtpPass = String(process.env.EMAIL_PASS || '').replace(/\s+/g, '');

function getMaskedEmailValue(value) {
  if (!value) return '(missing)';

  const [name, domain] = String(value).split('@');

  if (!domain) return '***';

  const safeName =
    name.length <= 2
      ? `${name[0] || '*'}*`
      : `${name.slice(0, 2)}***`;

  return `${safeName}@${domain}`;
}

function isAppPassword(pass) {
  return /^[A-Za-z0-9]{16}$/.test(
    String(pass || '').replace(/\s+/g, '')
  );
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ==========================
// 🔥 SIMPLE & STABLE GMAIL TRANSPORTER
// ==========================
function createTransporter() {
  if (!smtpUser || !smtpPass) {
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });
}

let transporter = createTransporter();
let transporterVerified = false;

function ensureTransporter() {
  if (!transporter) {
    transporter = createTransporter();
  }

  if (!transporter) {
    throw new Error('Email credentials are not configured.');
  }

  return transporter;
}

function refreshTransporter() {
  transporter = createTransporter();
  transporterVerified = false;
  return ensureTransporter();
}

function logTransportConfig(label) {
  console.log(`[email] SMTP ${label}:`, {
    user: getMaskedEmailValue(smtpUser),
    service: 'gmail',
    appPasswordRawLength: smtpPass.length
  });
}

// ==========================
// 🔥 VERIFY TRANSPORTER
// ==========================
async function verifyTransporter({ force = false } = {}) {
  if (force) {
    refreshTransporter();
  }

  const current = ensureTransporter();

  if (transporterVerified) {
    return current;
  }

  logTransportConfig('verify');

  try {
    await current.verify();

    transporterVerified = true;

    console.log('✅ SMTP transporter verified successfully.');

    return current;

  } catch (err) {
    transporterVerified = false;

    console.error('❌ SMTP VERIFY FAILED:', {
      message: err.message,
      code: err.code,
      responseCode: err.responseCode,
      response: err.response,
      command: err.command
    });

    throw err;
  }
}

// ==========================
// 🔥 RETRYABLE SMTP ERRORS
// ==========================
function isRetryableSmtpError(err) {
  const code = String(err?.code || '').toUpperCase();

  return [
    'ECONNECTION',
    'ETIMEDOUT',
    'ESOCKET',
    'EAI_AGAIN',
    'ECONNRESET'
  ].includes(code);
}

// ==========================
// 🔥 OTP EMAIL HTML
// ==========================
function buildOtpEmailHtml(name, otp) {
  return `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8" />
  </head>
  <body style="font-family: Arial; background:#111; color:#fff; padding:40px;">

    <div style="max-width:500px; margin:auto; background:#1e1e1e; padding:30px; border-radius:12px;">

      <h2 style="margin-top:0;">EvalAI Verification</h2>

      <p>Hello ${name},</p>

      <p>Your OTP for registration is:</p>

      <div style="
        font-size:32px;
        font-weight:bold;
        letter-spacing:8px;
        text-align:center;
        padding:20px;
        background:#2a2a2a;
        border-radius:10px;
        color:#8b5cf6;
        margin:20px 0;
      ">
        ${otp}
      </div>

      <p>This OTP expires in 15 minutes.</p>

      <p style="font-size:12px;color:#999;">
        If you did not request this email, ignore it safely.
      </p>

    </div>

  </body>
  </html>
  `;
}

function buildOtpEmailText(name, otp) {
  return `Hi ${name}, your EvalAI OTP is: ${otp}`;
}

// ==========================
// 🔥 SEND MAIL WITH RETRY
// ==========================
async function sendMailWithRetry(mailOptions, label, retries = 3) {

  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {

    try {

      const current = await verifyTransporter({
        force: attempt > 1
      });

      console.log(`[email] Sending ${label} (${attempt}/${retries})`);

      const info = await current.sendMail(mailOptions);

      console.log('✅ EMAIL SENT:', {
        to: mailOptions.to,
        messageId: info.messageId,
        response: info.response
      });

      return info;

    } catch (err) {

      lastError = err;

      transporterVerified = false;

      console.error(`❌ EMAIL SEND FAILED (${attempt}/${retries})`, {
        message: err.message,
        code: err.code,
        responseCode: err.responseCode,
        response: err.response,
        command: err.command
      });

      const shouldRetry =
        attempt < retries &&
        isRetryableSmtpError(err);

      if (!shouldRetry) {
        break;
      }

      const waitMs = 500 * attempt;

      console.log(`⏳ Retrying in ${waitMs}ms`);

      await delay(waitMs);
    }
  }

  throw lastError;
}

// ==========================
// 🔥 SEND OTP EMAIL
// ==========================
async function sendOtpEmail(to, name, otp) {

  if (!smtpUser || !smtpPass) {
    throw new Error('EMAIL_USER or EMAIL_PASS missing');
  }

  console.log('[email] Using EMAIL_USER:', getMaskedEmailValue(smtpUser));

  console.log('[email] EMAIL_PASS present:', Boolean(smtpPass));

  if (!isAppPassword(smtpPass)) {
    console.warn('⚠️ EMAIL_PASS may not be a valid Gmail App Password');
  }

  const html = buildOtpEmailHtml(name, otp);

  const text = buildOtpEmailText(name, otp);

  return sendMailWithRetry(
    {
      from: `"EvalAI" <${smtpUser}>`,
      to,
      subject: `${otp} - EvalAI Verification Code`,
      text,
      html
    },
    `OTP email to ${getMaskedEmailValue(to)}`
  );
}

// ==========================
// 🔥 TEST EMAIL
// ==========================
async function sendTestEmail(to) {

  if (!to) {
    throw new Error('Recipient email missing');
  }

  return sendMailWithRetry(
    {
      from: `"EvalAI" <${smtpUser}>`,
      to,
      subject: 'EvalAI Test Email',
      text: 'SMTP is working successfully.',
      html: '<h2>✅ SMTP working successfully</h2>'
    },
    `test email to ${getMaskedEmailValue(to)}`
  );
}

module.exports = {
  sendOtpEmail,
  sendTestEmail,
  verifyTransporter
};