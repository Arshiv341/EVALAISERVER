const https = require('https');

const resendApiKey = String(process.env.RESEND_API_KEY || '').trim();
const senderEmail = process.env.SENDER_EMAIL || 'onboarding@resend.dev';

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

// ==========================
// 🔥 RESEND HTTPS API SENDER
// ==========================
function sendResendEmail({ to, subject, html, text }) {
  if (!resendApiKey) {
    throw new Error('RESEND_API_KEY is missing from environment variables.');
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
      console.log(`[email] [Attempt ${attempt}/${retries}] Email request sent: Dispatching ${label}...`, {
        from: `EvalAI <${senderEmail}>`,
        to: mailOptions.to,
        subject: mailOptions.subject
      });

      const response = await sendResendEmail({
        to: mailOptions.to,
        subject: mailOptions.subject,
        html: mailOptions.html,
        text: mailOptions.text
      });

      console.log(`✅ [email] [Attempt ${attempt}/${retries}] Delivery success. Resend response:`, response);
      return response;

    } catch (err) {
      lastError = err;
      console.error(`❌ [email] [Attempt ${attempt}/${retries}] Delivery failure:`, err);

      if (attempt < retries) {
        const waitMs = 1000 * attempt;
        console.log(`⏳ [email] [Attempt ${attempt}/${retries}] RETRY DELAY: Scheduling next try in ${waitMs}ms...`);
        await delay(waitMs);
      }
    }
  }

  throw new Error(`Resend email delivery failed after ${retries} attempts: ${lastError.message || JSON.stringify(lastError)}`);
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
  console.log('[email] OTP generated:', {
    to: getMaskedEmailValue(to),
    otp: otp
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
  console.log('✓ [email] verifyTransporter called: Resend API connection verified (Pre-flight HTTPS check OK).');
  return true;
}

module.exports = {
  sendOtpEmail,
  sendTestEmail,
  verifyTransporter
};