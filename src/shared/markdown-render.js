(function anytimeAskMarkdown(global) {
  "use strict";

  var md = null;
  var initError = null;

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

  // ── Public API ─────────────────────────────────────────────────────

  /**
   * Render a raw markdown string into a DOM element.
   * The markdown content is passed straight to markdown-it with NO
   * pre-processing, normalisation, or modification.
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
      // Render raw markdown directly — never modify model output
      target.innerHTML = md.render(raw);

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
