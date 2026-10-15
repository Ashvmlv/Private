# Accessible Web Page Assistant

A web app that checks HTML for common accessibility and readability problems, ranks them by priority, shows corrected code examples, and uses an LLM (Google Gemini) to explain fixes and rewrite hard-to-read text.

Paste a page's HTML (or load the built-in sample), click **Analyze page**, and get a scored, prioritised report.

## Features

- **HTML input:** paste your own source or load a sample page with deliberate problems.
- **Accessibility checks:**
  - Images with missing or meaningless alt text
  - Form fields (`input`, `select`, `textarea`) with no label
  - Heading problems: no `<h1>`, multiple `<h1>`s, skipped levels, empty headings
  - Links with no text or vague text such as "click here"
  - Missing page language and `<title>` (when a full page is pasted)
- **Readability checks:** flags very long sentences and dense text using the Flesch Reading Ease score.
- **Prioritised report:** issues are sorted High, Medium, Low, with a score out of 100 and filter buttons.
- **Corrected examples:** each issue shows "Your code" beside a "Corrected example", with a Copy button.
- **AI suggestions:** click a button on any issue for an explanation and fix from Gemini, or a plain-English rewrite of complex text.
- **Accessible interface:** keyboard focus rings, screen-reader announcements, severity shown by shape as well as colour, reduced-motion support.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, vanilla JavaScript (no framework) |
| HTML parsing | Browser `DOMParser` API (never executes pasted scripts) |
| Backend | Node.js 18+ using only built-in modules (`http`, `fs`, `path`) |
| AI | Google Gemini API (`generateContent` REST endpoint) |

There are no npm dependencies and no build step.

## Project structure

```
a11y-assistant/
├── index.html     # Page layout and styles
├── analyzer.js    # Rule engine: finds issues, builds fixes, scores the page
├── app.js         # UI logic: runs analysis, renders results, filters, calls the AI
├── server.js      # Serves the files and proxies AI requests to Gemini
├── package.json   # Start script and Node version
└── README.md
```

## How it works

```
Browser                                         Server (Node)
───────                                         ─────────────
paste HTML
   │
analyzer.js  → list of issues (rules, in browser)
   │
app.js       → ranked report, score, filters
   │  click "Get AI suggestion"
   └──── POST /api/suggest (one issue only) ──→  server.js adds the API key,
                                                  calls Gemini
   ◄──────────── { suggestion } ────────────────  returns the text
```

- **Detection is rule-based.** It is fast, free, and works offline.
- **The AI only improves the advice,** and only when you click. If it fails, the rule-based fix is still shown.
- **The API key stays on the server.** The browser never sees it.

## Getting started

### Requirements

- [Node.js](https://nodejs.org) 18 or newer (LTS recommended)
- A Gemini API key from [Google AI Studio](https://aistudio.google.com)

### Run locally

1. Clone or download this project and open the folder in a terminal.
2. Set your API key and start the server.

   **Windows (PowerShell):**
   ```powershell
   $env:GEMINI_API_KEY="your-key-here"
   node server.js
   ```

   **Windows (Command Prompt):**
   ```cmd
   set GEMINI_API_KEY=your-key-here
   node server.js
   ```

   **macOS / Linux:**
   ```bash
   GEMINI_API_KEY=your-key-here node server.js
   ```

3. Open http://localhost:3000.
4. Click **Load sample page**, then **Analyze page**.

The checker works without a key. Only the AI buttons need it, and they show a fallback message if it is missing.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | For AI features | none | Your Gemini API key |
| `GEMINI_MODEL` | No | `gemini-2.5-flash` | Model name. Change it if your account uses a different one |
| `PORT` | No | `3000` | Port the server listens on (hosting services set this automatically) |

Never commit your API key. Set it as an environment variable only.

## What the checks look for

| Category | Issue | Priority |
|---|---|---|
| Images | No `alt` attribute | High |
| Images | Alt text like "image" or "photo.png" | Medium |
| Forms | Control with no label, `aria-label`, or `aria-labelledby` | High |
| Headings | Empty heading | High |
| Headings | Skipped level (for example h2 to h4), or no `<h1>` | Medium |
| Headings | More than one `<h1>` | Low |
| Links | Link with no accessible name | High |
| Links | Vague text such as "click here" | Low |
| Document | Missing `lang` or `<title>` | Medium |
| Readability | Sentence over 30 words, or Flesch score below 40 on 25+ words | Low |

**Score:** starts at 100 and loses 10 points per High issue, 5 per Medium, and 2 per Low (minimum 0).

Rules reference WCAG 2.x success criteria, shown on each finding.

## API

### `POST /api/suggest`

Request body (JSON):

```json
{
  "title": "Image is missing alt text",
  "message": "Without an alt attribute, screen readers may read out the file name.",
  "snippet": "<img src=\"hero.jpg\">",
  "category": "Images"
}
```

Response: `{ "suggestion": "..." }`, or `{ "error": "..." }` with status 500.

Request bodies are capped at 20 KB, and only the four project files are served.

## Deployment

The app is a small Node server, so it can run on any host that supports Node (for example Render, Railway, or Replit).

1. Push the project to a GitHub repository.
2. Create a new **Web Service** on your host and connect the repository.
3. Set the start command to `node server.js`.
4. Add `GEMINI_API_KEY` in the host's environment settings.
5. Deploy and open the public link.

Because a public deployment lets anyone trigger AI requests with your key, add a simple rate limit to `server.js` and set a usage cap on your Gemini account.

## Limitations

- Checks look at the markup only. They cannot judge colour contrast, whether alt text is accurate, or content added by scripts after load.
- The readability score is an estimate and works for English only.
- Automated checks find only a portion of accessibility problems. Also test with a keyboard and a screen reader.

## Possible improvements

- "Fix all" button that applies every suggested fix and shows a before and after
- Highlight problem lines inside the editor
- Colour-contrast checks
- Fetch and analyze a page from a URL
- Saved reports and history (would add a database such as MongoDB)
- Rate limiting and caching of AI responses

## Tests

Quick manual test: load the sample page. It should report 11 issues (5 High, 4 Medium, 2 Low) and a score of 26.

## License

Add a license of your choice (for example MIT) before sharing publicly.
