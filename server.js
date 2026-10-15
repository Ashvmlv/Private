// server.js — static file server + /api/suggest LLM proxy (Gemini). No npm dependencies (Node 18+).
// Run (PowerShell):  $env:GEMINI_API_KEY="your-key"; node server.js   then open http://localhost:3000
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const FILES = { "/": "index.html", "/index.html": "index.html", "/analyzer.js": "analyzer.js", "/app.js": "app.js" };
const TYPES = { ".html": "text/html", ".js": "text/javascript" };

const SYSTEM = `You are a web accessibility and plain-language expert.
Given an issue found in an HTML page, reply concisely (max ~120 words):
1) why it matters to users, 2) the fix, 3) a corrected HTML snippet or rewritten text.
For text-readability issues, rewrite the passage in plain English with short sentences.`;

async function askLLM(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1500 },
    }),
  });
  if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  if (!parts.length) throw new Error("The model returned no text (it may have been blocked or cut off).");
  return parts.map((p) => p.text || "").join("");
}

http.createServer(async (req, res) => {
  // --- API route ---
  if (req.method === "POST" && req.url === "/api/suggest") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 20000) req.destroy(); }); // cap request size
    req.on("end", async () => {
      res.setHeader("content-type", "application/json");
      try {
        if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set on the server.");
        const { title, message, snippet, category } = JSON.parse(body);
        const prompt = `Category: ${category}\nIssue: ${title}\nDetail: ${message}\nOriginal:\n${snippet}`;
        res.end(JSON.stringify({ suggestion: await askLLM(prompt) }));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // --- static files (whitelist only, so no path traversal) ---
  const file = FILES[req.url.split("?")[0]];
  if (!file) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("content-type", TYPES[path.extname(file)] + "; charset=utf-8");
  fs.createReadStream(path.join(__dirname, file)).pipe(res);
}).listen(PORT, () => console.log(`Accessible Web Page Assistant → http://localhost:${PORT}`));