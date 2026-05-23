const { forwardGeminiGenerateContent } = require('../services/geminiService');

exports.generateContent = async (req, res) => {
  try {
    const upstream = await forwardGeminiGenerateContent(req.body);
    const contentType = upstream.headers?.['content-type'];

    if (contentType) {
      res.set('Content-Type', contentType);
    }

    res.status(upstream.statusCode || 502).send(upstream.body);
  } catch (err) {
    console.error('[Gemini] Proxy request failed:', err);
    res.status(502).json({ error: 'Gemini proxy request failed.' });
  }
};
