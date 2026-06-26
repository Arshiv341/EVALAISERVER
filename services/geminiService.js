const https = require('https');

const GEMINI_HOST = 'generativelanguage.googleapis.com';
const GEMINI_PATH = '/v1beta/models/gemini-2.5-flash:generateContent';

async function forwardGeminiGenerateContent(payload) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey || !String(apiKey).trim()) {
    throw new Error('GEMINI_API_KEY is missing.');
  }

  const body = JSON.stringify(payload || {});

  let attempt = 0;
  const maxRetries = 5;

  while (true) {
    const requestStartTime = Date.now();
    console.log(`[STAGE] REQUEST SENT: Gemini API call (attempt: ${attempt + 1})`);

    try {
      const result = await new Promise((resolve, reject) => {
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

      const requestDuration = Date.now() - requestStartTime;
      console.log(`[STAGE] RESPONSE RECEIVED: Gemini API returned status ${result.statusCode} in ${requestDuration}ms`);

      const isRetryableStatus = [429, 503, 504, 408, 502].includes(result.statusCode);
      let isRetryableBody = false;
      let errorStatusString = '';

      try {
        const parsed = JSON.parse(result.body);
        errorStatusString = parsed?.error?.status || '';
        if (['RESOURCE_EXHAUSTED', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(errorStatusString)) {
          isRetryableBody = true;
        }
      } catch (e) {}

      if ((isRetryableStatus || isRetryableBody) && attempt < maxRetries) {
        attempt++;
        let waitSeconds = Math.pow(2, attempt); // 2s, 4s, 8s, 16s, 32s

        // Parse the response JSON and detect Retry-After / retryDelay
        try {
          const parsed = JSON.parse(result.body);
          const retryInfo = parsed?.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
          if (retryInfo && retryInfo.retryDelay) {
            const seconds = parseInt(retryInfo.retryDelay, 10);
            if (!isNaN(seconds) && seconds > 0) {
              waitSeconds = seconds;
            }
          }
        } catch (e) {}

        // Fallback check on HTTP headers
        const retryAfterHeader = result.headers?.['retry-after'];
        if (retryAfterHeader) {
          const seconds = parseInt(retryAfterHeader, 10);
          if (!isNaN(seconds) && seconds > 0) {
            waitSeconds = seconds;
          }
        }

        console.log(`[STAGE] FAIL: Gemini API attempt ${attempt} returned status ${result.statusCode} (${errorStatusString || 'N/A'})`);
        console.log(`Attempt ${attempt}`);
        console.log(`wait ${waitSeconds}s`);

        await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
        continue;
      }

      if (result.statusCode >= 400) {
        console.error(`[STAGE] FAIL: Gemini API returned permanent failure ${result.statusCode} (${errorStatusString || 'N/A'})`);
      } else {
        console.log(`[STAGE] SUCCESS: Gemini API finished successfully in ${requestDuration}ms`);
      }

      return result;
    } catch (err) {
      const requestDuration = Date.now() - requestStartTime;
      if (attempt < maxRetries) {
        attempt++;
        const waitSeconds = Math.pow(2, attempt);
        console.log(`[STAGE] FAIL: Gemini API network error: ${err.message}`);
        console.log(`Attempt ${attempt}`);
        console.log(`wait ${waitSeconds}s`);
        await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
        continue;
      }
      console.error(`[STAGE] FAIL: Gemini API network error permanently failed in ${requestDuration}ms: ${err.message}`);
      throw err;
    }
  }
}

module.exports = {
  forwardGeminiGenerateContent
};
