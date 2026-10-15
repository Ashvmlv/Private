/* analyzer.js — rule engine + fix engine.
   Exposes window.A11yAnalyzer = { analyze, applyFix, compare, score }.
   - analyze(html)            -> findings (each with a stable key and a fix "spec")
   - applyFix(html, f, value) -> NEW html string with that one fix applied to the DOM
   - compare(before, after)   -> { resolved, remaining, introduced } matched by key
   Nothing here executes the user's HTML: DOMParser builds an inert document. */
(function () {
  const SEVERITY_WEIGHT = { high: 3, medium: 2, low: 1 };
  const VAGUE_LINK = /^(click here|here|read more|more|link|learn more)$/i;
  const LANG_OK = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i;

  // ---------- small helpers ----------
  const clip = (s, n = 300) => (s.length > n ? s.slice(0, n) + "…" : s);
  const words = (t) => t.trim().split(/\s+/).filter(Boolean);
  const parse = (html) => new DOMParser().parseFromString(html, "text/html");
  const isFullPage = (html) => /<html[\s>]/i.test(html);
  const hasDoctype = (html) => /^\s*<!doctype/i.test(html);

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

  // An element's position = the chain of child indexes from <html>. Parsing the same string
  // always gives the same tree, so a path found during analyze() can be re-found in applyFix().
  function pathOf(el) {
    const path = [];
    while (el.parentElement) {
      path.unshift(Array.prototype.indexOf.call(el.parentElement.children, el));
      el = el.parentElement;
    }
    return path;
  }
  function resolve(doc, path) {
    let el = doc.documentElement;
    for (const i of path) { el = el && el.children[i]; }
    return el || null;
  }

  // Turn a DOM back into the same kind of string the user pasted (full page vs fragment).
  function serialize(doc, originalHtml) {
    if (isFullPage(originalHtml)) {
      return (hasDoctype(originalHtml) ? "<!DOCTYPE html>\n" : "") + doc.documentElement.outerHTML;
    }
    const head = doc.head.innerHTML.trim(); // <title>/<meta> in a fragment get hoisted into <head> by the parser
    return (head ? head + "\n" : "") + doc.body.innerHTML;
  }

  // Replace <h4> with <h3> etc. while keeping attributes and children.
  function retag(doc, el, tag) {
    const n = doc.createElement(tag);
    for (const a of el.attributes) n.setAttribute(a.name, a.value);
    while (el.firstChild) n.appendChild(el.firstChild);
    el.replaceWith(n);
  }
  function retagPreview(el, tag) {
    const n = el.ownerDocument.createElement(tag);
    for (const a of el.attributes) n.setAttribute(a.name, a.value);
    n.innerHTML = el.innerHTML;
    return clip(n.outerHTML);
  }

  // Insert `node` before `el`, copying the indentation so the result stays tidy.
  function insertBefore(doc, el, node) {
    const prev = el.previousSibling;
    const m = prev && prev.nodeType === 3 ? prev.nodeValue.match(/\n([ \t]*)$/) : null;
    el.before(node);
    if (m) el.before(doc.createTextNode("\n" + m[1]));
  }

  function freeId(doc, base, claimed) {
    base = (base || "field").replace(/[^A-Za-z0-9_-]/g, "-") || "field";
    let id = base, n = 2;
    while (doc.getElementById(id) || (claimed && claimed.has(id))) id = base + "-" + n++;
    if (claimed) claimed.add(id);
    return id;
  }

  const sentenceCase = (s) => s.replace(/[-_]+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());
  function nameFromHref(href) {
    const seg = (href || "").split(/[?#]/)[0].split("/").filter(Boolean).pop() || "";
    return sentenceCase(seg.replace(/\.[a-z0-9]+$/i, ""));
  }
  function altFromSrc(src) {
    const stem = (src || "").split(/[?#]/)[0].split("/").pop().replace(/\.[a-z0-9]+$/i, "");
    if (!stem || /^(img|dsc|image|photo|screenshot|untitled)?[-_ ]?\d*$/i.test(stem)) return ""; // camera-style names say nothing
    return sentenceCase(stem);
  }

  // ---------- main entry ----------
  function analyze(html) {
    const doc = parse(html);
    const findings = [];
    let order = 0;
    const add = (f) => findings.push({ order: order++, path: f.el ? pathOf(f.el) : [], ...f });

    checkDocument(doc, html, add);
    checkImages(doc, add);
    checkFormControls(doc, add);
    checkHeadings(doc, add);
    checkLinks(doc, add);
    checkText(doc, add);

    // Stable identity: rule + a signature that other fixes don't change + occurrence number.
    // This is how a recheck knows "this is the same issue as before" even after the HTML changed.
    const seen = {};
    findings.forEach((f) => {
      f.baseKey = f.ruleId + "|" + f.sig;
      seen[f.baseKey] = (seen[f.baseKey] || 0) + 1;
      f.key = f.baseKey + "#" + seen[f.baseKey];
      delete f.el; // don't keep DOM nodes around; previews are already built
    });

    findings.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || a.order - b.order);
    return findings;
  }

  // ---------- rule groups ----------
  function checkDocument(doc, html, add) {
    if (!isFullPage(html)) return; // only judge <html lang> / <title> on a full page
    const root = doc.documentElement;
    if (!root.getAttribute("lang")) {
      add({
        ruleId: "doc-lang", sig: "doc", el: root,
        severity: "medium", category: "Document", wcag: "3.1.1",
        title: "Page language not declared",
        message: "Screen readers use the lang attribute to choose the right pronunciation.",
        snippet: "<html>",
        spec: {
          label: "Language code", value: "en", required: true,
          preview: (v) => `<html lang="${v}">`,
          apply: (d, el, v) => {
            if (!LANG_OK.test(v)) throw new Error("Use a language code such as en, hi or fr-CA.");
            el.setAttribute("lang", v);
          },
        },
      });
    }
    if (!doc.title.trim()) {
      const h = doc.querySelector("h1, h2, h3");
      add({
        ruleId: "doc-title", sig: "doc", el: root,
        severity: "medium", category: "Document", wcag: "2.4.2",
        title: "Page has no <title>",
        message: "The title is the first thing a screen reader announces and labels the browser tab.",
        snippet: "<head>…</head>",
        spec: {
          label: "Page title", value: h ? h.textContent.trim() : "", required: true,
          preview: (v) => `<title>${v}</title>`,
          apply: (d, el, v) => { d.title = v; },
        },
      });
    }
  }

  function checkImages(doc, add) {
    doc.querySelectorAll("img").forEach((img) => {
      const src = img.getAttribute("src") || "";
      const snippet = clip(img.outerHTML);
      const withAlt = (v) => { const c = img.cloneNode(true); c.setAttribute("alt", v); return c.outerHTML; };

      if (!img.hasAttribute("alt")) {
        add({
          ruleId: "img-no-alt", sig: src, el: img, snippet,
          severity: "high", category: "Images", wcag: "1.1.1",
          title: "Image is missing alt text",
          message: "Without an alt attribute, screen readers may read out the file name. Decorative images should use alt=\"\".",
          spec: {
            label: "Alt text", value: altFromSrc(src), required: true, decorative: true,
            preview: withAlt,
            apply: (d, el, v) => el.setAttribute("alt", v),
          },
        });
      } else {
        const alt = img.getAttribute("alt").trim();
        const bad = /^(image|img|photo|picture|graphic|untitled)?\d*$/i.test(alt) || /\.(png|jpe?g|gif|svg|webp)$/i.test(alt) || /^describe\b/i.test(alt);
        if (alt && bad) {
          add({
            ruleId: "img-bad-alt", sig: src, el: img, snippet,
            severity: "medium", category: "Images", wcag: "1.1.1",
            title: "Alt text is not meaningful",
            message: `"${alt}" does not tell the user what the image conveys.`,
            spec: {
              label: "Better alt text", value: "", required: true, decorative: true,
              preview: withAlt,
              apply: (d, el, v) => el.setAttribute("alt", v),
            },
          });
        }
      }
    });
  }

  function checkFormControls(doc, add) {
    const skip = ["hidden", "submit", "button", "reset", "image"];
    const claimed = new Set();
    doc.querySelectorAll("input, select, textarea").forEach((el) => {
      if (el.tagName === "INPUT" && skip.includes((el.type || "text").toLowerCase())) return;

      const id = el.getAttribute("id");
      const hasLabelFor = id && doc.querySelector(`label[for="${CSS.escape(id)}"]`);
      const wrapped = el.closest("label");
      const aria = el.getAttribute("aria-label")?.trim() || el.getAttribute("aria-labelledby");
      if (hasLabelFor || wrapped || aria) return; // already labelled

      const name = el.getAttribute("name") || "";
      const guess = sentenceCase(name || el.getAttribute("placeholder") || el.type || "Field");
      const newId = id || freeId(doc, name || el.type, claimed);
      add({
        ruleId: "form-no-label", sig: `${el.tagName}|${name}|${el.type}`, el,
        severity: "high", category: "Forms", wcag: "1.3.1 / 3.3.2",
        title: "Form control has no label",
        message: "Placeholders disappear when typing and are not a reliable label. Every control needs a programmatic label.",
        snippet: clip(el.outerHTML),
        spec: {
          label: "Label text", value: guess, required: true,
          preview: (v) => {
            const c = el.cloneNode(true); c.setAttribute("id", newId);
            return `<label for="${newId}">${v}</label>\n${c.outerHTML}`;
          },
          apply: (d, node, v) => {
            let useId = node.getAttribute("id");
            if (!useId) { useId = freeId(d, name || node.type); node.setAttribute("id", useId); }
            const label = d.createElement("label");
            label.setAttribute("for", useId);
            label.textContent = v;
            insertBefore(d, node, label);
          },
        },
      });
    });
  }

  function checkHeadings(doc, add) {
    const hs = [...doc.querySelectorAll("h1,h2,h3,h4,h5,h6")];
    const h1s = hs.filter((h) => h.tagName === "H1");
    const idx = (h) => "h#" + hs.indexOf(h); // headings are never added/removed by fixes, so this stays stable

    if (hs.length && h1s.length === 0) {
      add({
        ruleId: "h1-missing", sig: "doc", el: hs[0], snippet: clip(hs[0].outerHTML),
        severity: "medium", category: "Headings", wcag: "1.3.1 / 2.4.6",
        title: "No <h1> found",
        message: "Each page should have one main heading describing its purpose.",
        spec: {
          noInput: true, actionLabel: `Make the first heading an <h1>`,
          preview: () => retagPreview(hs[0], "h1"),
          apply: (d, el) => retag(d, el, "h1"),
        },
      });
    }
    h1s.slice(1).forEach((h) => add({
      ruleId: "h1-multiple", sig: idx(h), el: h, snippet: clip(h.outerHTML),
      severity: "low", category: "Headings", wcag: "1.3.1",
      title: "Multiple <h1> elements",
      message: "Prefer a single <h1>; use <h2> for sections.",
      spec: {
        noInput: true, actionLabel: "Change this <h1> to an <h2>",
        preview: () => retagPreview(h, "h2"),
        apply: (d, el) => retag(d, el, "h2"),
      },
    }));

    let prev = 0;
    hs.forEach((h) => {
      const level = Number(h.tagName[1]);
      const named = h.textContent.trim() || h.getAttribute("aria-label") || h.querySelector("img[alt]:not([alt=''])");
      if (!named) {
        const tag = h.tagName.toLowerCase();
        add({
          ruleId: "heading-empty", sig: idx(h), el: h, snippet: clip(h.outerHTML),
          severity: "high", category: "Headings", wcag: "2.4.6",
          title: "Empty heading",
          message: "Empty headings create confusing stops for screen-reader navigation.",
          spec: {
            label: "Heading text", value: "", required: true,
            preview: (v) => `<${tag}>${v}</${tag}>`,
            apply: (d, el, v) => { el.textContent = v; },
          },
        });
      }
      if (prev && level > prev + 1) {
        const want = "h" + (prev + 1);
        add({
          ruleId: "heading-skip", sig: idx(h), el: h, snippet: clip(h.outerHTML),
          severity: "medium", category: "Headings", wcag: "1.3.1",
          title: `Heading level skipped (h${prev} → h${level})`,
          message: "Skipped levels break the outline that assistive-tech users navigate by.",
          spec: {
            noInput: true, actionLabel: `Change <${h.tagName.toLowerCase()}> to <${want}>`,
            preview: () => retagPreview(h, want),
            apply: (d, el) => retag(d, el, want),
          },
        });
      }
      prev = level;
    });
  }

  function checkLinks(doc, add) {
    doc.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      const text = (a.textContent || "").trim();
      const hasName = text || a.getAttribute("aria-label") || a.querySelector("img[alt]:not([alt=''])");
      const snippet = clip(a.outerHTML);

      if (!hasName) {
        add({
          ruleId: "link-no-name", sig: href, el: a, snippet,
          severity: "high", category: "Links", wcag: "2.4.4",
          title: "Link has no accessible name",
          message: "Screen readers will announce just “link”.",
          spec: {
            label: "Link name", value: nameFromHref(href), required: true,
            preview: (v) => { const c = a.cloneNode(true); c.setAttribute("aria-label", v); return c.outerHTML; },
            apply: (d, el, v) => {
              if (VAGUE_LINK.test(v)) throw new Error("Describe where the link goes, not just “here” or “more”.");
              el.setAttribute("aria-label", v);
            },
          },
        });
      } else if (VAGUE_LINK.test(text)) {
        add({
          ruleId: "link-vague", sig: href, el: a, snippet,
          severity: "low", category: "Links", wcag: "2.4.4",
          title: "Link text is vague",
          message: `“${text}” is meaningless out of context (screen readers list links on their own).`,
          spec: {
            label: "New link text", value: nameFromHref(href), required: true,
            preview: (v) => { const c = a.cloneNode(true); if (c.children.length) c.setAttribute("aria-label", v); else c.textContent = v; return c.outerHTML; },
            apply: (d, el, v) => {
              if (VAGUE_LINK.test(v)) throw new Error("Describe where the link goes, not just “here” or “more”.");
              if (el.children.length) el.setAttribute("aria-label", v); else el.textContent = v;
            },
          },
        });
      }
    });
  }

  function checkText(doc, add) {
    [...doc.querySelectorAll("p, li, blockquote")].forEach((el, i) => {
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

      const tag = el.tagName.toLowerCase();
      add({
        ruleId: "text-complex", sig: "t#" + i, el, snippet: clip(text, 400),
        severity: "low", category: "Readability", wcag: "3.1.5 (AAA)",
        title: "Text may be hard to read",
        message: "Contains " + reasons.join(" and ") + ". Aim for sentences under ~20 words and plain language.",
        spec: {
          label: "Rewritten text", value: text, required: true, multiline: true, ai: "rewrite",
          blocked: el.children.length ? "This text contains inline markup (links, bold…). Edit it in the editor on the left, then press Recheck." : null,
          preview: (v) => `<${tag}>${v}</${tag}>`,
          apply: (d, node, v) => {
            if (v.replace(/\s+/g, " ") === text) throw new Error("The text is unchanged. Rewrite it first (the AI draft button can help).");
            node.textContent = v;
          },
        },
      });
    });
  }

  // ---------- fix engine ----------
  // Returns a NEW html string. The input string is never mutated.
  function applyFix(html, finding, value, opts) {
    opts = opts || {};
    const spec = finding.spec;
    if (spec.blocked) throw new Error(spec.blocked);
    const v = String(value == null ? spec.value || "" : value).trim();
    if (spec.required && !v && !opts.decorative) throw new Error(`Enter ${spec.label.toLowerCase()} first.`);

    const doc = parse(html);
    const el = resolve(doc, finding.path);
    if (!el) throw new Error("That element is no longer in the HTML. Press Recheck and try again.");
    spec.apply(doc, el, opts.decorative ? "" : v);
    return serialize(doc, html);
  }

  // ---------- recheck ----------
  function compare(before, after) {
    const afterKeys = new Set(after.map((f) => f.key));
    const beforeKeys = new Set(before.map((f) => f.key));
    return {
      resolved: before.filter((f) => !afterKeys.has(f.key)),
      remaining: after.filter((f) => beforeKeys.has(f.key)),
      introduced: after.filter((f) => !beforeKeys.has(f.key)),
    };
  }

  function score(findings) {
    const penalty = { high: 10, medium: 5, low: 2 };
    return Math.max(0, 100 - findings.reduce((n, f) => n + penalty[f.severity], 0));
  }

  window.A11yAnalyzer = { analyze, applyFix, compare, score };
})();
