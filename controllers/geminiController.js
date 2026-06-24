const fs = require('fs');
const path = require('path');
const { forwardGeminiGenerateContent } = require('../services/geminiService');

exports.generateContent = async (req, res) => {
  try {
    const upstream = await forwardGeminiGenerateContent(req.body);
    const contentType = upstream.headers?.['content-type'];

    if (contentType) {
      res.set('Content-Type', contentType);
    }

    // Save the raw response to logs/gemini_raw_response.txt and logs/raw_gemini_response.txt
    try {
      const logsDir = path.join(__dirname, '..', 'logs');
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
      fs.writeFileSync(path.join(logsDir, 'gemini_raw_response.txt'), upstream.body || '', 'utf8');
      fs.writeFileSync(path.join(logsDir, 'raw_gemini_response.txt'), upstream.body || '', 'utf8');
      console.log(`[Gemini Proxy] Saved raw response to logs (${Buffer.byteLength(upstream.body || '')} bytes)`);
    } catch (fsErr) {
      console.error('[Gemini Proxy] Failed to save raw response to logs:', fsErr);
    }

    res.status(upstream.statusCode || 502).send(upstream.body);
  } catch (err) {
    console.error('[Gemini] Proxy request failed:', err);
    res.status(502).json({ error: 'Gemini proxy request failed.' });
  }
};
