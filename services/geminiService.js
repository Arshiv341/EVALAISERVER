const https = require('https');

const GEMINI_HOST = 'generativelanguage.googleapis.com';
const GEMINI_PATH = '/v1beta/models/gemini-2.5-flash:generateContent';

function forwardGeminiGenerateContent(payload) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('GEMINI_API_KEY is missing.');
  }

  const body = JSON.stringify(payload || {});

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method: 'POST',
        hostname: GEMINI_HOST,
        path: GEMINI_PATH,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-goog-api-key': apiKey
        }
      },
      response => {
        let responseBody = '';
        response.setEncoding('utf8');

        response.on('data', chunk => {
          responseBody += chunk;
        });

        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 502,
            headers: response.headers || {},
            body: responseBody
          });
        });
      }
    );

    request.setTimeout(120000, () => {
      request.destroy(new Error('Gemini API request timeout after 120 seconds'));
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

module.exports = {
  forwardGeminiGenerateContent
};
