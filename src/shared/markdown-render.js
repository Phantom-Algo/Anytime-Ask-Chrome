(function anytimeAskMarkdown(global) {
  "use strict";

  var md = null;
  var initError = null;
  var katexAvailable = false;

  // ── Initialize markdown-it ─────────────────────────────────────────
  try {
    if (typeof global.markdownit !== "function") {
      throw new Error(
        "markdown-it is not available on globalThis. " +
        "Ensure markdown-it.min.js is loaded before markdown-render.js."
      );
    }

    md = global.markdownit({
      html: false,        // XSS protection
      linkify: true,      // Auto-link bare URLs
      breaks: true,       // GFM: single \n → <br>
      typographer: false  // Leave quotes/dashes as-is
    });

    // ── Link attributes plugin ──────────────────────────────────────
    // Add target="_blank" and rel="noreferrer noopener" to every link
    var defaultLinkOpen = md.renderer.rules.link_open || function(tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.link_open = function(tokens, idx, options, env, self) {
      tokens[idx].attrPush(["target", "_blank"]);
      tokens[idx].attrPush(["rel", "noreferrer noopener"]);
      return defaultLinkOpen(tokens, idx, options, env, self);
    };

    console.debug("[AnytimeAsk] markdown-it initialized successfully (v" +
      (md.version || "?") + ")");
  } catch (err) {
    initError = err;
    console.error("[AnytimeAsk] Failed to initialize markdown-it:", err);
  }

  // ── Check KaTeX availability ──────────────────────────────────────
  if (typeof global.katex !== "undefined" && global.katex) {
    katexAvailable = true;
    console.debug("[AnytimeAsk] KaTeX available for LaTeX rendering");
  } else {
    console.debug("[AnytimeAsk] KaTeX not available, LaTeX will be displayed as raw text");
  }

  // ── LaTeX helpers ──────────────────────────────────────────────────

  // Unique placeholder markers using Unicode Private Use Area to avoid collisions
  var MATH_PREFIX = "MATH";
  var MATH_SUFFIX = "";

  /**
   * HTML-escape a string for safe insertion into HTML.
   */
  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /**
   * Extract LaTeX math blocks from raw markdown text and replace them
   * with unique placeholder tokens.
   *
   * Supported delimiters:
   *   $$...$$  – display math
   *   \[...\]  – display math (LaTeX style)
   *   $...$    – inline math
   *   \(...\)  – inline math (LaTeX style)
   *
   * Returns { text, mathBlocks } where mathBlocks is an array of
   * { formula, display } descriptors.
   */
  function extractMathBlocks(text) {
    var mathBlocks = [];

    // Step 1: Display math $$...$$
    text = text.replace(/\$\$([\s\S]*?)\$\$/g, function(match, formula) {
      mathBlocks.push({ formula: formula.trim(), display: true });
      return MATH_PREFIX + (mathBlocks.length - 1) + MATH_SUFFIX;
    });

    // Step 2: Display math \[...\]
    text = text.replace(/\\\[([\s\S]*?)\\\]/g, function(match, formula) {
      mathBlocks.push({ formula: formula.trim(), display: true });
      return MATH_PREFIX + (mathBlocks.length - 1) + MATH_SUFFIX;
    });

    // Step 3: Inline math \(...\) (before $...$ to avoid conflicts)
    text = text.replace(/\\\(([\s\S]*?)\\\)/g, function(match, formula) {
      mathBlocks.push({ formula: formula.trim(), display: false });
      return MATH_PREFIX + (mathBlocks.length - 1) + MATH_SUFFIX;
    });

    // Step 4: Inline math $...$
    //   Opening $ must NOT be followed by whitespace or a digit
    //     → excludes "$ 100" or "$10.00" (dollar amounts)
    //   Closing $ must NOT be preceded by whitespace
    //     → enforces proper LaTeX delimiter pairing
    //   Content must be non-empty and single-line (no embedded newlines)
    //   Must NOT be preceded or followed by another $
    //     → avoids matching $$ display math fragments
    if (katexAvailable) {
      text = text.replace(/(?<!\$)\$(?!\s|\d)([^$\n]+?)(?<!\s)\$(?!\$)/g, function(match, formula) {
        mathBlocks.push({ formula: formula.trim(), display: false });
        return MATH_PREFIX + (mathBlocks.length - 1) + MATH_SUFFIX;
      });
    }

    return { text: text, mathBlocks: mathBlocks };
  }

  /**
   * Replace math placeholders in rendered HTML with KaTeX output.
   * Falls back to escaped raw LaTeX if KaTeX is unavailable or fails.
   */
  function restoreMathBlocks(html, mathBlocks) {
    if (!mathBlocks.length) return html;

    for (var i = 0; i < mathBlocks.length; i++) {
      var block = mathBlocks[i];
      var placeholder = MATH_PREFIX + i + MATH_SUFFIX;
      var rendered;

      if (katexAvailable) {
        try {
          rendered = global.katex.renderToString(block.formula, {
            throwOnError: false,
            displayMode: block.display,
            trust: false
          });
        } catch (katexErr) {
          console.debug("[AnytimeAsk] KaTeX render failed:", katexErr.message);
          rendered = '<code class="aa-latex-raw">' + escapeHtml(block.formula) + '</code>';
        }
      } else {
        rendered = '<code class="aa-latex-raw">' + escapeHtml(block.formula) + '</code>';
      }

      // Split-and-join is safe for placeholder replacement because
      // the placeholder contains no regex-special characters except
      // the Private Use Area prefix/suffix, which won't appear in
      // the rendered KaTeX HTML.
      html = html.split(placeholder).join(rendered);
    }

    return html;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Render a raw markdown string into a DOM element.
   *
   * Processing pipeline:
   *   1. Extract LaTeX math blocks → safe placeholder tokens
   *   2. Render through markdown-it → HTML
   *   3. Restore math blocks → KaTeX-rendered HTML (or raw fallback)
   *   4. Apply syntax highlighting to code blocks
   *
   * @param {string} markdown  Raw markdown from the LLM
   * @param {Element} target   Container element to fill with rendered HTML
   */
  function renderMarkdown(markdown, target) {
    if (!target) return;

    var raw = String(markdown || "");

    // If markdown-it failed to init, display raw text safely
    if (!md) {
      console.warn("[AnytimeAsk] markdown-it unavailable, rendering as plain text." +
        (initError ? " Init error: " + initError.message : ""));
      target.textContent = raw;
      return;
    }

    try {
      // Step 1: Extract LaTeX math blocks before markdown-it sees them
      var extracted = extractMathBlocks(raw);

      // Step 2: Render markdown to HTML
      target.innerHTML = md.render(extracted.text);

      // Step 3: Replace math placeholders with KaTeX-rendered HTML
      var html = target.innerHTML;
      html = restoreMathBlocks(html, extracted.mathBlocks);
      target.innerHTML = html;

      // Add utility class to tables so they can be styled
      var tables = target.querySelectorAll("table");
      for (var i = 0; i < tables.length; i++) {
        tables[i].classList.add("md-table");
      }

      // Apply syntax highlighting to code blocks (if highlight.js is loaded)
      if (typeof global.hljs !== "undefined" && global.hljs) {
        var blocks = target.querySelectorAll("pre code");
        for (var j = 0; j < blocks.length; j++) {
          try {
            global.hljs.highlightElement(blocks[j]);
          } catch (hlErr) {
            // highlight.js may fail on unknown languages — that's fine
            console.debug("[AnytimeAsk] highlight.js skipped a block:", hlErr.message);
          }
        }
      }
    } catch (renderErr) {
      console.error("[AnytimeAsk] markdown-it render failed:", renderErr);
      // Fallback: display raw text
      target.textContent = raw;
    }
  }

  global.AnytimeAskMarkdown = {
    renderMarkdown: renderMarkdown
  };
})(globalThis);
