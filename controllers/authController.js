const Otp = require('../models/Otp');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Faculty = require('../models/Faculty');
const TokenTransaction = require('../models/TokenTransaction');
const { sendOtpEmail, sendTestEmail } = require('../services/emailService');

const OTP_TTL_MS = 15 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function clearOtpRecord(email) {
  try {
    if (!email) return;

    await Otp.deleteOne({ email });
  } catch (error) {
    console.error('Error clearing OTP:', error.message);
  }
}

function issueToken(res, faculty, rememberMe = false) {
  const token = jwt.sign(
    { id: faculty._id, email: faculty.email, employeeId: faculty.employeeId },
    process.env.JWT_SECRET,
    { expiresIn: rememberMe ? '30d' : '7d' }
  );

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: (rememberMe ? 30 : 7) * 24 * 60 * 60 * 1000
  });

  return token;
}

exports.sendOtp = async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = normalizeEmail(req.body?.email);

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    const existing = await Faculty.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'This email is already registered. Please log in.' });
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    await Otp.deleteMany({ email });
    await Otp.create({
      email,
      otp,
      attempts: 0,
      verified: false,
      expiresAt: new Date(Date.now() + OTP_TTL_MS)
    });

    try {
      await sendOtpEmail(email, name, otp);
    } catch (emailError) {
      await clearOtpRecord(email);
      throw emailError;
    }

    res.json({ success: true, message: 'OTP sent to your email.' });
  } catch (err) {
    console.error('sendOtp error:', {
      message: err.message,
      code: err.code,
      command: err.command,
      response: err.response,
      responseCode: err.responseCode,
      stack: err.stack
    });
    clearOtpRecord(normalizeEmail(req.body?.email));
    res.status(500).json({ error: 'Failed to send OTP. Check email configuration.' });
  }
};

exports.testEmail = async (req, res) => {
  try {
    const to = normalizeEmail(req.body?.email || process.env.EMAIL_USER);
    if (!to || !isValidEmail(to)) {
      return res.status(400).json({ error: 'Valid email is required.' });
    }

    const info = await sendTestEmail(to);
    res.json({
      success: true,
      message: 'Test email sent.',
      messageId: info.messageId,
      response: info.response
    });
  } catch (err) {
    console.error('testEmail error:', {
      message: err.message,
      code: err.code,
      command: err.command,
      response: err.response,
      responseCode: err.responseCode,
      stack: err.stack
    });
    res.status(500).json({
      error: 'Failed to send test email.',
      reason: err.message,
      code: err.code || null,
      responseCode: err.responseCode || null
    });
  }
};

exports.verifyOtp = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || '').trim();

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and OTP required.' });
    }

    const record = await Otp.findOne({ email });

    if (!record) {
      return res.status(400).json({
        success: false,
        message: 'OTP expired or not found'
      });
    }

    if (Date.now() > new Date(record.expiresAt).getTime()) {
      await clearOtpRecord(email);
      return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    }

    if (record.attempts >= OTP_MAX_ATTEMPTS) {
      await clearOtpRecord(email);
      return res.status(429).json({ error: 'Too many incorrect OTP attempts. Request a new code.' });
    }

    if (record.otp !== otp) {
      record.attempts += 1;

      if (record.attempts >= OTP_MAX_ATTEMPTS) {
        await clearOtpRecord(email);
        return res.status(429).json({ error: 'Too many incorrect OTP attempts. Request a new code.' });
      }

      await record.save();
      return res.status(400).json({ error: 'Incorrect OTP. Please try again.' });
    }

    record.verified = true;
    record.attempts = 0;
    await record.save();

    res.json({ success: true, message: 'Email verified.' });
  } catch (err) {
    console.error('verifyOtp error:', err);
    res.status(500).json({ error: 'OTP verification failed.' });
  }
};

exports.register = async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = normalizeEmail(req.body?.email);
    const department = String(req.body?.department || '').trim();
    const employeeId = String(req.body?.employeeId || '').trim();
    const password = String(req.body?.password || '');

    if (!name || !email || !department || !employeeId || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }

    const record = await Otp.findOne({ email });
    if (!record || !record.verified) {
      return res.status(403).json({ error: 'Email not verified. Complete OTP step first.' });
    }

    if (Date.now() > new Date(record.expiresAt).getTime()) {
      await clearOtpRecord(email);
      return res.status(403).json({ error: 'OTP expired. Request a new one.' });
    }

    const existing = await Faculty.findOne({
      $or: [{ email }, { employeeId }]
    });

    if (existing) {
      return res.status(409).json({ error: 'Email or Employee ID already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const faculty = await Faculty.create({
      name,
      email,
      department,
      employeeId,
      passwordHash
    });

    await clearOtpRecord(email);
    issueToken(res, faculty);

    res.status(201).json({
      success: true,
      message: 'Account created!',
      faculty: {
        id: faculty._id,
        name: faculty.name,
        email: faculty.email,
        department: faculty.department,
        employeeId: faculty.employeeId
      }
    });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
};

exports.login = async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const employeeId = String(req.body?.employeeId || '').trim();
    const password = String(req.body?.password || '');
    const rememberMe = Boolean(req.body?.rememberMe);

    if (!email || !employeeId || !password) {
      return res.status(400).json({ error: 'Email, Employee ID, and password are required.' });
    }

    const faculty = await Faculty.findOne({ email, employeeId }).select('+passwordHash');
    if (!faculty) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const match = await bcrypt.compare(password, faculty.passwordHash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    issueToken(res, faculty, rememberMe);

    res.json({
      success: true,
      faculty: {
        id: faculty._id,
        name: faculty.name,
        email: faculty.email,
        department: faculty.department,
        employeeId: faculty.employeeId
      }
    });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Login failed.' });
  }
};

exports.logout = (_req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
  res.json({ success: true });
};

exports.me = async (req, res) => {
  try {
    const faculty = await Faculty.findById(req.faculty.id).populate({
      path: 'transactionHistory',
      options: { sort: { createdAt: -1 } }
    });
    if (!faculty) {
      return res.status(404).json({ error: 'Faculty not found.' });
    }
    res.json({ faculty });
  } catch (err) {
    console.error('me fetch error:', err);
    res.status(500).json({ error: 'Server error.' });
  }
};
