/* app.js — UI wiring: read input, run analyzer, render prioritised findings, filter, copy, call LLM. */
const $ = (id) => document.getElementById(id);

// Sample page with deliberate problems so the tool can be demoed instantly.
const SAMPLE = `<!DOCTYPE html>
<html>
<head></head>
<body>
  <h2>Welcome to Sunrise Bakery</h2>
  <img src="hero.jpg">
  <img src="IMG_2041.png" alt="image">
  <h4>Our Story</h4>
  <p>Notwithstanding the aforementioned considerations regarding the commencement of our establishment, the proprietors, having accumulated substantial experience in artisanal fermentation methodologies, subsequently determined that the implementation of a community-oriented distribution infrastructure would be advantageous.</p>
  <h1>Order Online</h1>
  <form>
    <input type="text" name="full-name" placeholder="Your name">
    <input type="email" name="email">
    <select name="size"><option>Small</option><option>Large</option></select>
    <label for="note">Note</label><textarea id="note"></textarea>
    <button type="submit">Send</button>
  </form>
  <a href="/menu">Click here</a>
  <a href="/cart"><i class="icon"></i></a>
</body>
</html>`;

const SYMBOL = { high: "●", medium: "▲", low: "■" }; // shape + word, so severity never relies on colour alone
const LABEL = { high: "High", medium: "Medium", low: "Low" };
const ARC_LENGTH = 169.65; // length of the gauge's half-circle path

$("sample").addEventListener("click", () => { $("html-input").value = SAMPLE; $("html-input").focus(); });
$("clear").addEventListener("click", () => {
  $("html-input").value = "";
  $("results").hidden = true;
  $("empty").hidden = false;
  $("status").textContent = "Cleared.";
  $("html-input").focus();
});
$("analyze").addEventListener("click", run);
document.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => setFilter(chip.dataset.sev)));

function run() {
  const html = $("html-input").value.trim();
  const status = $("status");
  if (!html) { status.textContent = "Paste some HTML or load the sample page first."; $("html-input").focus(); return; }

  const findings = A11yAnalyzer.analyze(html);
  const score = A11yAnalyzer.score(findings);
  const count = (s) => findings.filter((f) => f.severity === s).length;

  $("empty").hidden = true;
  $("results").hidden = false;

  // Gauge: colour by score, then animate the arc on the next frame so the transition plays.
  $("score").textContent = score;
  const arc = $("arc");
  arc.setAttribute("stroke", score >= 80 ? "#17694b" : score >= 50 ? "#b26a00" : "#b3261e");
  arc.style.strokeDashoffset = ARC_LENGTH;
  requestAnimationFrame(() => requestAnimationFrame(() => { arc.style.strokeDashoffset = ARC_LENGTH * (1 - score / 100); }));

  $("verdict-h").textContent = score >= 80 ? "Looking good" : score >= 50 ? "Needs some work" : "Needs significant work";
  $("summary").textContent = findings.length
    ? `${findings.length} issue${findings.length === 1 ? "" : "s"} found. Fix the high-priority ones first.`
    : "No issues found by the automated checks.";
  ["high", "medium", "low"].forEach((s) => ($("n-" + s).textContent = `(${count(s)})`));
  status.textContent = `Analysis complete. ${findings.length} issues found, score ${score} out of 100.`;

  $("findings").replaceChildren(...findings.map(renderFinding));
  $("allclear").hidden = findings.length > 0;
  $("list-head").hidden = findings.length === 0;
  setFilter("all");
  $("report").scrollIntoView({ behavior: "smooth" });
}

// Show only findings of one severity (or all). aria-pressed tells screen readers which chip is active.
function setFilter(sev) {
  document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.sev === sev)));
  document.querySelectorAll("#findings .finding").forEach((li) => (li.hidden = sev !== "all" && li.dataset.sev !== sev));
}

// Element factory. Using textContent (never innerHTML) means pasted HTML can't inject script into our UI.
function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => n.append(k));
  return n;
}

function codePane(kind, title, code, withCopy) {
  const head = el("header", {}, el("span", {}, title));
  if (withCopy) {
    const btn = el("button", { type: "button", className: "copy" }, "Copy");
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(code); btn.textContent = "Copied"; }
      catch { btn.textContent = "Select and copy"; }
      setTimeout(() => (btn.textContent = "Copy"), 1800);
    });
    head.append(btn);
  }
  return el("div", { className: "pane " + kind }, head, el("pre", {}, el("code", {}, code)));
}

function renderFinding(f) {
  const li = el("li", { className: "finding " + f.severity });
  li.dataset.sev = f.severity;

  li.append(
    el("div", { className: "f-top" },
      el("span", { className: "badge " + f.severity }, `${SYMBOL[f.severity]} ${LABEL[f.severity]}`),
      el("span", { className: "cat" }, `${f.category} · WCAG ${f.wcag}`)
    ),
    el("h3", {}, f.title),
    el("p", {}, f.message)
  );

  // Before / after: your code next to the corrected example.
  const diff = el("div", { className: "diff" }, codePane("before", "Your code", f.snippet, false));
  if (f.fix) diff.append(codePane("after", "Corrected example", f.fix, true));
  else diff.style.gridTemplateColumns = "1fr";
  li.append(diff);

  const out = el("div", { className: "ai-out", hidden: true, role: "status" });
  const btn = el("button", { type: "button", className: "btn-ai" }, f.needsAI ? "Rewrite in plain English" : "Get AI suggestion");
  btn.addEventListener("click", () => askAI(f, btn, out));
  li.append(btn, out);
  return li;
}

async function askAI(f, btn, out) {
  btn.disabled = true; btn.textContent = "Thinking…";
  out.hidden = false; out.textContent = "";
  try {
    const res = await fetch("/api/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: f.title, message: f.message, snippet: f.snippet, category: f.category }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Request failed");
    out.textContent = data.suggestion;
  } catch (e) {
    // Graceful fallback: the rule-based fix still works without an LLM.
    out.textContent = `Couldn't get an AI suggestion: ${e.message}. ` + (f.fix ? "Use the corrected example above." : "Try shorter sentences and everyday words.");
  } finally {
    btn.disabled = false; btn.textContent = "Ask again";
  }
}
