/* app.js — UI: analyze, apply fix, recheck, compare with original, optional AI help. */
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
const ARC_LENGTH = 169.65;

// Everything the app "remembers". `original` is never modified after Analyze.
const state = {
  original: null,   // the HTML exactly as analyzed (kept for comparison and restore)
  working: null,    // the HTML as it is now, after any applied fixes
  baseline: [],     // findings for `original`
  current: [],      // findings for `working`  (this is what the list shows)
  touched: false,   // has a fix been applied or a recheck run?
  note: null,       // { kind, text } shown in the Fix and recheck panel
  filter: "all",
};
let uid = 0;

$("sample").addEventListener("click", () => { $("html-input").value = SAMPLE; $("html-input").focus(); });
$("clear").addEventListener("click", () => {
  $("html-input").value = "";
  state.original = null;
  $("results").hidden = true;
  $("empty").hidden = false;
  $("status").textContent = "Cleared.";
  $("html-input").focus();
});
$("analyze").addEventListener("click", run);
$("recheck").addEventListener("click", recheck);
$("reset").addEventListener("click", resetToOriginal);
$("copy-mod").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try { await navigator.clipboard.writeText($("html-input").value); btn.textContent = "Copied"; }
  catch { btn.textContent = "Select the editor text and copy"; }
  setTimeout(() => (btn.textContent = "Copy modified HTML"), 1800);
});
document.querySelectorAll(".chip").forEach((chip) => chip.addEventListener("click", () => setFilter(chip.dataset.sev)));

// ---------- the three actions that change state ----------
function run() { // Analyze page: starts a brand-new session
  const html = $("html-input").value;
  if (!html.trim()) { $("status").textContent = "Paste some HTML or load the sample page first."; $("html-input").focus(); return; }
  state.original = html;
  state.working = html;
  state.baseline = A11yAnalyzer.analyze(html);
  state.current = state.baseline;
  state.touched = false;
  state.note = null;
  state.filter = "all";
  render(true);
  $("report").scrollIntoView({ behavior: "smooth" });
}

function recheck() { // re-analyze whatever is in the editor right now
  if (state.original === null) return run();
  const html = $("html-input").value;
  state.working = html;
  state.current = A11yAnalyzer.analyze(html);
  state.touched = true;
  const c = A11yAnalyzer.compare(state.baseline, state.current);
  state.note = { kind: "", text: `Rechecked the editor HTML: ${c.resolved.length} resolved, ${c.remaining.length} remaining${c.introduced.length ? `, ${c.introduced.length} new` : ""}.` };
  render();
}

function resetToOriginal() {
  if (state.original === null) return;
  $("html-input").value = state.original;
  state.working = state.original;
  state.current = A11yAnalyzer.analyze(state.original);
  state.touched = false;
  state.note = null;
  render();
}

function applyFinding(f, value, opts, errEl) {
  errEl.textContent = "";
  if ($("html-input").value !== state.working) {
    errEl.textContent = "The editor was changed after the last check. Press “Recheck editor HTML” first.";
    return;
  }
  try {
    const before = state.current;
    const newHtml = A11yAnalyzer.applyFix(state.working, f, value, opts); // 1. change the HTML
    if (newHtml === state.working) throw new Error("That fix didn't change the HTML.");
    state.working = newHtml;
    $("html-input").value = newHtml;                                      // 2. the editor now holds the modified HTML
    state.current = A11yAnalyzer.analyze(newHtml);                        // 3. re-run the real checks on it
    state.touched = true;

    const countOf = (list) => list.filter((x) => x.baseKey === f.baseKey).length;
    const gone = countOf(state.current) < countOf(before);
    const intro = A11yAnalyzer.compare(before, state.current).introduced.length;
    const extra = intro ? ` The change introduced ${intro} new issue${intro === 1 ? "" : "s"}.` : "";
    state.note = gone
      ? { kind: "good", text: `Fixed “${f.title}”. The recheck of the modified HTML confirms it is resolved.${extra}` }
      : { kind: "bad", text: `Applied, but the recheck still flags “${f.title}”.${extra}` };
    render();
    $("fixpanel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    errEl.textContent = e.message;
  }
}

// ---------- rendering ----------
function render(first) {
  const { baseline, current } = state;
  const cmp = A11yAnalyzer.compare(baseline, current);
  const score = A11yAnalyzer.score(current);
  const count = (s) => current.filter((f) => f.severity === s).length;
  const newKeys = new Set(cmp.introduced.map((f) => f.key));
  const wasHidden = $("results").hidden;

  $("empty").hidden = true;
  $("results").hidden = false;

  // Gauge
  $("score").textContent = score;
  const arc = $("arc");
  arc.setAttribute("stroke", score >= 80 ? "#17694b" : score >= 50 ? "#b26a00" : "#b3261e");
  if (first || wasHidden) arc.style.strokeDashoffset = ARC_LENGTH;
  requestAnimationFrame(() => requestAnimationFrame(() => { arc.style.strokeDashoffset = ARC_LENGTH * (1 - score / 100); }));

  $("verdict-h").textContent = current.length === 0 ? "All automated checks passed" : score >= 80 ? "Looking good" : score >= 50 ? "Needs some work" : "Needs significant work";
  $("summary").textContent = current.length
    ? `${current.length} issue${current.length === 1 ? "" : "s"} to fix. Start with the high-priority ones.`
    : "No issues found by the automated checks.";
  ["high", "medium", "low"].forEach((s) => ($("n-" + s).textContent = `(${count(s)})`));
  $("status").textContent = `${current.length} issues in the HTML being analyzed. Score ${score} out of 100.`;

  // Fix and recheck panel
  const changed = state.working !== state.original;
  $("stats").hidden = !state.touched;
  $("p-resolved").textContent = cmp.resolved.length;
  $("p-remaining").textContent = cmp.remaining.length;
  $("p-new").textContent = cmp.introduced.length;
  $("stat-new").hidden = cmp.introduced.length === 0;
  $("p-score").textContent = `${A11yAnalyzer.score(baseline)} → ${score}`;
  const note = $("p-note");
  note.hidden = !state.note;
  if (state.note) { note.textContent = state.note.text; note.className = "note " + state.note.kind; }
  $("resolved-box").hidden = !state.touched || cmp.resolved.length === 0;
  $("resolved-sum").textContent = `Resolved issues (${cmp.resolved.length})`;
  $("resolved-list").replaceChildren(...cmp.resolved.map((f) =>
    el("li", {}, `${f.title}: ${f.snippet.replace(/\s+/g, " ").slice(0, 70)}`)));
  $("reset").disabled = !changed;
  $("compare").hidden = !changed;
  if (changed) renderCompare();

  // Findings list: these are the issues that remain in the modified HTML
  $("findings").replaceChildren(...current.map((f) => renderFinding(f, newKeys.has(f.key))));
  $("allclear").hidden = current.length > 0;
  $("list-head").hidden = current.length === 0;
  setFilter(state.filter);
}

function setFilter(sev) {
  state.filter = sev;
  document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.sev === sev)));
  document.querySelectorAll("#findings .finding").forEach((li) => (li.hidden = sev !== "all" && li.dataset.sev !== sev));
}

// ---------- original vs modified ----------
function lineDiff(a, b) {
  const A = a.split("\n").map((s) => s.replace(/\s+$/, ""));
  const B = b.split("\n").map((s) => s.replace(/\s+$/, ""));
  const n = A.length, m = B.length;
  const aChanged = new Array(n).fill(true), bChanged = new Array(m).fill(true);
  if (n * m > 4000000) return { A, B, aChanged, bChanged }; // too big for the simple method: mark everything
  const w = m + 1, t = new Uint32Array((n + 1) * w); // longest-common-subsequence table
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] = A[i] === B[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { aChanged[i] = bChanged[j] = false; i++; j++; }
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
    else j++;
  }
  return { A, B, aChanged, bChanged };
}

function renderCompare() {
  const d = lineDiff(state.original, state.working);
  const lines = (arr, flags, cls) => arr.map((text, i) => el("span", { className: "ln" + (flags[i] ? " " + cls : "") }, text));
  $("cmp-orig").replaceChildren(...lines(d.A, d.aChanged, "del"));
  $("cmp-mod").replaceChildren(...lines(d.B, d.bChanged, "add"));
}

// ---------- one finding card ----------
// Element factory. Using textContent (never innerHTML) means pasted HTML can't inject script into our UI.
function el(tag, props = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), props);
  kids.forEach((k) => n.append(k));
  return n;
}

function codePane(kind, title, text, withCopy) {
  const code = el("code", {}, text);
  const head = el("header", {}, el("span", {}, title));
  if (withCopy) {
    const btn = el("button", { type: "button", className: "copy" }, "Copy");
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(code.textContent); btn.textContent = "Copied"; }
      catch { btn.textContent = "Select and copy"; }
      setTimeout(() => (btn.textContent = "Copy"), 1800);
    });
    head.append(btn);
  }
  const pane = el("div", { className: "pane " + kind }, head, el("pre", {}, code));
  pane.codeEl = code;
  return pane;
}

function renderFinding(f, isNew) {
  const spec = f.spec;
  const li = el("li", { className: "finding " + f.severity });
  li.dataset.sev = f.severity;

  const top = el("div", { className: "f-top" }, el("span", { className: "badge " + f.severity }, `${SYMBOL[f.severity]} ${LABEL[f.severity]}`));
  if (isNew) top.append(el("span", { className: "badge new" }, "New after your change"));
  top.append(el("span", { className: "cat" }, `${f.category} · WCAG ${f.wcag}`));
  li.append(top, el("h3", {}, f.title), el("p", {}, f.message));

  // Before / after. The "after" preview is built from the current input value, so it updates as you type.
  const before = codePane("before", "Your code", f.snippet, false);
  const after = codePane("after", "Corrected example", spec.preview(spec.value || ""), true);
  li.append(el("div", { className: "diff" }, before, after));

  const err = el("div", { className: "err", role: "alert" });
  let input = null;

  if (spec.blocked) {
    li.append(el("p", { className: "blocked" }, spec.blocked));
  } else {
    const row = el("div", { className: "fixrow" });
    if (!spec.noInput) {
      const id = "fx-" + ++uid;
      input = spec.multiline ? el("textarea", { id, value: spec.value }) : el("input", { id, type: "text", value: spec.value });
      input.addEventListener("input", () => { after.codeEl.textContent = spec.preview(input.value); err.textContent = ""; });
      row.append(el("div", { className: "field" }, el("label", { htmlFor: id }, spec.label), input));
    }
    const apply = el("button", { type: "button", className: "btn-apply" }, spec.noInput ? spec.actionLabel : "Apply fix");
    apply.addEventListener("click", () => applyFinding(f, input ? input.value : "", {}, err));
    row.append(apply);

    if (spec.decorative) {
      const dec = el("button", { type: "button", className: "btn-alt" }, "Mark as decorative");
      dec.addEventListener("click", () => applyFinding(f, "", { decorative: true }, err));
      row.append(dec);
    }
    if (spec.ai === "rewrite") {
      const draft = el("button", { type: "button", className: "btn-alt" }, "Draft rewrite with AI");
      draft.addEventListener("click", () => draftRewrite(f, input, draft, err, after));
      row.append(draft);
    }
    li.append(row);
  }
  li.append(err);

  const out = el("div", { className: "ai-out", hidden: true, role: "status" });
  const explain = el("button", { type: "button", className: "btn-ai" }, "Explain with AI");
  explain.addEventListener("click", () => askAI(f, explain, out));
  li.append(el("div", { className: "fixrow" }, explain), out);
  return li;
}

// ---------- AI (optional) ----------
async function callSuggest(payload) {
  const res = await fetch("/api/suggest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data.suggestion;
}

async function askAI(f, btn, out) {
  btn.disabled = true; btn.textContent = "Thinking…";
  out.hidden = false; out.textContent = "";
  try {
    out.textContent = await callSuggest({ title: f.title, message: f.message, snippet: f.snippet, category: f.category });
  } catch (e) {
    out.textContent = `Couldn't get an AI explanation: ${e.message}. The corrected example above still works without AI.`;
  } finally {
    btn.disabled = false; btn.textContent = "Ask again";
  }
}

// Fills the "Rewritten text" box with an AI draft. Nothing is applied until you press Apply fix.
async function draftRewrite(f, input, btn, err, after) {
  btn.disabled = true; btn.textContent = "Drafting…"; err.textContent = "";
  try {
    const text = await callSuggest({ mode: "rewrite", title: f.title, message: f.message, snippet: f.spec.value, category: f.category });
    input.value = text.trim();
    after.codeEl.textContent = f.spec.preview(input.value);
  } catch (e) {
    err.textContent = `Couldn't draft a rewrite: ${e.message}. Write it yourself in the box, then press Apply fix.`;
  } finally {
    btn.disabled = false; btn.textContent = "Draft rewrite with AI";
  }
}
