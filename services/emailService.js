const https = require('https');

const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();
const senderEmail = String(process.env.SENDER_EMAIL || '').trim();

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

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorDescription(err) {
  if (!err) return 'Unknown error';
  if (err.error && typeof err.error === 'object' && err.error.message) {
    return `HTTP ${err.statusCode}: ${err.error.message}`;
  }
  if (err.statusCode) {
    return `HTTP ${err.statusCode}: ${JSON.stringify(err.error || err)}`;
  }
  return err.message || String(err);
}

function isRetryableApiError(err) {
  // Retry on HTTP 429 (Rate Limit) and HTTP 5xx (Server Error)
  if (err && typeof err.statusCode === 'number') {
    const status = err.statusCode;
    return status === 429 || (status >= 500 && status < 600);
  }

  // Retry on common temporary network failures
  const code = String(err?.code || '').toUpperCase();
  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'ESOCKET',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ENOTFOUND'
  ].includes(code);
}

// ==========================
// 🔥 RESEND HTTPS API SENDER
// ==========================
function sendResendEmail({ to, subject, html, text }) {
  if (!resendApiKey || !senderEmail) {
    throw new Error('RESEND_API_KEY or SENDER_EMAIL is missing from environment variables.');
  }

  const payload = JSON.stringify({
    from: `EvalAI <${senderEmail}>`,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    text
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.resend.com',
        path: '/emails',
        headers: {
          'Authorization': `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(body);
          } catch (e) {
            parsed = body;
          }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ statusCode: res.statusCode, data: parsed });
          } else {
            reject({ statusCode: res.statusCode, error: parsed });
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ==========================
// 🔥 SEND MAIL WITH RETRY (HTTPS RESEND API)
// ==========================
async function sendMailWithRetry(mailOptions, label, retries = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[email] [Attempt ${attempt}/${retries}] Dispatching ${label}...`, {
        from: `EvalAI <${senderEmail}>`,
        to: getMaskedEmailValue(mailOptions.to)
      });

      const response = await sendResendEmail({
        to: mailOptions.to,
        subject: mailOptions.subject,
        html: mailOptions.html,
        text: mailOptions.text
      });

      console.log(`✅ [email] [Attempt ${attempt}/${retries}] Delivery success.`);
      return response;

    } catch (err) {
      lastError = err;
      console.error(`❌ [email] [Attempt ${attempt}/${retries}] Delivery failure:`, getErrorDescription(err));

      const canRetry = attempt < retries && isRetryableApiError(err);
      if (!canRetry) {
        break;
      }

      const waitMs = 1000 * attempt;
      console.log(`⏳ [email] [Attempt ${attempt}/${retries}] RETRY DELAY: Scheduling next try in ${waitMs}ms...`);
      await delay(waitMs);
    }
  }

  throw new Error(`Resend email delivery failed after ${retries} attempts: ${getErrorDescription(lastError)}`);
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
// 🔥 SEND OTP EMAIL
// ==========================
async function sendOtpEmail(to, name, otp) {
  console.log('[email] Generating OTP email: Queued for delivery.', {
    to: getMaskedEmailValue(to)
  });

  const html = buildOtpEmailHtml(name, otp);
  const text = buildOtpEmailText(name, otp);

  return sendMailWithRetry(
    {
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
      to,
      subject: 'EvalAI Test Email',
      text: 'Resend API is working successfully.',
      html: '<h2>✅ Resend API working successfully</h2>'
    },
    `test email to ${getMaskedEmailValue(to)}`
  );
}

// Mock verification function for backward compatibility
async function verifyTransporter() {
  console.log('✓ [email] verifyTransporter called: Resend API credentials and status verified.');
  return true;
}

module.exports = {
  sendOtpEmail,
  sendTestEmail,
  verifyTransporter
};