require('dotenv').config();
const https = require('https');

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY is missing in env!");
  process.exit(1);
}

const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

https.get(url, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    try {
      const data = JSON.parse(body);
      if (data.models) {
        console.log("Supported Models:");
        data.models.forEach(m => console.log(`  - ${m.name}`));
      } else {
        console.log("No models array found. Response body:", body);
      }
    } catch (e) {
      console.error("Failed to parse response JSON. Raw body:", body);
    }
  });
}).on('error', (err) => {
  console.error("HTTP request error:", err);
});
