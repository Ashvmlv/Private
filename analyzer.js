/* analyzer.js — rule-based accessibility + readability engine.
   Exposes one global: A11yAnalyzer.analyze(htmlString) -> array of findings.
   Nothing here executes the user's HTML: DOMParser builds an inert document. */
(function () {
  const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };

  // ---------- helpers ----------
  const clip = (s, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);
  const words = (t) => t.trim().split(/\s+/).filter(Boolean);

  // Rough English syllable counter (good enough for a Flesch estimate).
  function syllables(word) {
    word = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!word) return 0;
    if (word.length <= 3) return 1;
    word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
    const groups = word.match(/[aeiouy]{1,2}/g);
    return groups ? groups.length : 1;
  }

  // Flesch Reading Ease: higher = easier. 60-70 is plain English, <30 is very hard.
  function fleschScore(text) {
    const w = words(text);
    const sentences = Math.max(1, (text.match(/[.!?]+(\s|$)/g) || []).length);
    const syl = w.reduce((n, x) => n + syllables(x), 0);
    return 206.835 - 1.015 * (w.length / sentences) - 84.6 * (syl / Math.max(1, w.length));
  }

  // ---------- main entry ----------
  function analyze(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const findings = [];
    let order = 0;
    const add = (f) => findings.push({ id: "f" + findings.length, order: order++, ...f });

    checkDocument(doc, html, add);
    checkImages(doc, add);
    checkFormControls(doc, add);
    checkHeadings(doc, add);
    checkLinks(doc, add);
    checkText(doc, add);

    // Prioritise: severity first, then position in the document.
    findings.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || a.order - b.order);
    return findings;
  }

  // ---------- rule groups ----------
  function checkDocument(doc, html, add) {
    // Only complain about <html lang> / <title> if the user pasted a full page.
    if (!/<html[\s>]/i.test(html)) return;
    if (!doc.documentElement.getAttribute("lang")) {
      add({
        severity: "medium", category: "Document", wcag: "3.1.1",
        title: "Page language not declared",
        message: "Screen readers use the lang attribute to choose the right pronunciation.",
        snippet: "<html>", fix: '<html lang="en">',
      });
    }
    if (!doc.title.trim()) {
      add({
        severity: "medium", category: "Document", wcag: "2.4.2",
        title: "Page has no <title>",
        message: "The title is the first thing a screen reader announces and labels the browser tab.",
        snippet: "<head>…</head>", fix: "<title>Descriptive page name – Site name</title>",
      });
    }
  }

  function checkImages(doc, add) {
    doc.querySelectorAll("img").forEach((img) => {
      const snippet = clip(img.outerHTML);
      if (!img.hasAttribute("alt")) {
        const fixed = img.cloneNode(true);
        fixed.setAttribute("alt", "Describe what this image shows or what it is for");
        add({
          severity: "high", category: "Images", wcag: "1.1.1",
          title: "Image is missing alt text",
          message: "Without an alt attribute, screen readers may read out the file name. Decorative images should use alt=\"\".",
          snippet, fix: fixed.outerHTML,
        });
      } else {
        const alt = img.getAttribute("alt").trim();
        const bad = /^(image|img|photo|picture|graphic|untitled)?\d*$/i.test(alt) || /\.(png|jpe?g|gif|svg|webp)$/i.test(alt);
        if (alt && bad) {
          const fixed = img.cloneNode(true);
          fixed.setAttribute("alt", "Describe the content, not the file type");
          add({
            severity: "medium", category: "Images", wcag: "1.1.1",
            title: "Alt text is not meaningful",
            message: `"${alt}" does not tell the user what the image conveys.`,
            snippet, fix: fixed.outerHTML,
          });
        }
      }
    });
  }

  function checkFormControls(doc, add) {
    const skip = ["hidden", "submit", "button", "reset", "image"];
    let uid = 0;
    doc.querySelectorAll("input, select, textarea").forEach((el) => {
      if (el.tagName === "INPUT" && skip.includes((el.type || "text").toLowerCase())) return;

      const id = el.getAttribute("id");
      const hasLabelFor = id && doc.querySelector(`label[for="${CSS.escape(id)}"]`);
      const wrapped = el.closest("label");
      const aria = el.getAttribute("aria-label")?.trim() || el.getAttribute("aria-labelledby");
      if (hasLabelFor || wrapped || aria) return; // labelled OK

      const guess = el.getAttribute("name") || el.getAttribute("placeholder") || el.type || "Field";
      const label = guess.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
      const fixed = el.cloneNode(true);
      const newId = id || `field-${++uid}`;
      fixed.setAttribute("id", newId);

      add({
        severity: "high", category: "Forms", wcag: "1.3.1 / 3.3.2",
        title: "Form control has no label",
        message: "Placeholders disappear when typing and are not a reliable label. Every control needs a programmatic label.",
        snippet: clip(el.outerHTML),
        fix: `<label for="${newId}">${label}</label>\n${fixed.outerHTML}`,
      });
    });
  }

  function checkHeadings(doc, add) {
    const hs = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")];
    const h1s = hs.filter((h) => h.tagName === "H1");

    if (hs.length && h1s.length === 0) {
      add({
        severity: "medium", category: "Headings", wcag: "1.3.1 / 2.4.6",
        title: "No <h1> found",
        message: "Each page should have one main heading describing its purpose.",
        snippet: clip(hs[0].outerHTML), fix: "<h1>Main page topic</h1>",
      });
    }
    if (h1s.length > 1) {
      h1s.slice(1).forEach((h) => add({
        severity: "low", category: "Headings", wcag: "1.3.1",
        title: "Multiple <h1> elements",
        message: "Prefer a single <h1>; use <h2> for sections.",
        snippet: clip(h.outerHTML), fix: `<h2>${h.textContent.trim()}</h2>`,
      }));
    }

    let prev = 0;
    hs.forEach((h) => {
      const level = Number(h.tagName[1]);
      if (!h.textContent.trim()) {
        add({
          severity: "high", category: "Headings", wcag: "2.4.6",
          title: "Empty heading",
          message: "Empty headings create confusing stops for screen-reader navigation.",
          snippet: clip(h.outerHTML), fix: `<${h.tagName.toLowerCase()}>Meaningful heading text</${h.tagName.toLowerCase()}>`,
        });
      }
      if (prev && level > prev + 1) {
        const want = prev + 1;
        add({
          severity: "medium", category: "Headings", wcag: "1.3.1",
          title: `Heading level skipped (h${prev} → h${level})`,
          message: "Skipped levels break the outline that assistive-tech users navigate by.",
          snippet: clip(h.outerHTML), fix: `<h${want}>${h.textContent.trim()}</h${want}>`,
        });
      }
      prev = level;
    });
  }

  function checkLinks(doc, add) {
    const vague = /^(click here|here|read more|more|link|learn more)$/i;
    doc.querySelectorAll("a[href]").forEach((a) => {
      const text = (a.textContent || "").trim();
      const hasName = text || a.getAttribute("aria-label") || a.querySelector("img[alt]:not([alt=''])");
      if (!hasName) {
        add({
          severity: "high", category: "Links", wcag: "2.4.4",
          title: "Link has no accessible name",
          message: "Screen readers will announce just “link”.",
          snippet: clip(a.outerHTML), fix: `<a href="${a.getAttribute("href")}">Describe the destination</a>`,
        });
      } else if (vague.test(text)) {
        add({
          severity: "low", category: "Links", wcag: "2.4.4",
          title: "Link text is vague",
          message: `“${text}” is meaningless out of context (screen readers list links on their own).`,
          snippet: clip(a.outerHTML), fix: `<a href="${a.getAttribute("href")}">Read the full accessibility guide</a>`,
        });
      }
    });
  }

  function checkText(doc, add) {
    doc.querySelectorAll("p, li, blockquote").forEach((el) => {
      const text = el.textContent.replace(/\s+/g, " ").trim();
      const w = words(text);
      if (w.length < 8) return;

      const sentences = text.split(/(?<=[.!?])\s+/);
      const longest = sentences.reduce((m, s) => Math.max(m, words(s).length), 0);
      const flesch = fleschScore(text);
      const reasons = [];
      if (longest > 30) reasons.push(`a ${longest}-word sentence`);
      if (w.length >= 25 && flesch < 40) reasons.push(`a low reading-ease score (${Math.round(flesch)}/100)`);
      if (!reasons.length) return;

      add({
        severity: "low", category: "Readability", wcag: "3.1.5 (AAA)",
        title: "Text may be hard to read",
        message: "Contains " + reasons.join(" and ") + ". Aim for sentences under ~20 words and plain language.",
        snippet: clip(text, 400),
        fix: null, // rule engine can't rewrite prose well → use "Ask AI"
        needsAI: true,
      });
    });
  }

  // Score: start at 100, subtract per-issue penalty.
  function score(findings) {
    const penalty = { high: 10, medium: 5, low: 2 };
    return Math.max(0, 100 - findings.reduce((n, f) => n + penalty[f.severity], 0));
  }

  window.A11yAnalyzer = { analyze, score };
})();
