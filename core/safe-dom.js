/**
 * BoundaryQC / FDOT Civil3D Standards — Safe DOM helper
 * core/safe-dom.js
 *
 * Every dynamic HTML write in this app goes through setSafeHTML(), which runs the
 * markup through DOMPurify before it touches the DOM. DOMPurify is loaded in <head>
 * (see index.html) so window.DOMPurify is available before any plugin script runs.
 *
 * If DOMPurify somehow failed to load, setSafeHTML falls back to textContent — it
 * will never inject unsanitized markup.
 */
(function () {
    "use strict";

    const PURIFY_CONFIG = {
        USE_PROFILES: { html: true },
        ALLOW_DATA_ATTR: true,
        // Form controls are used by the modal helpers in core/app.js
        ADD_TAGS: ["input", "button", "textarea", "select", "option"],
        ADD_ATTR: ["target", "data-plan", "data-price", "data-tab", "data-layer",
                   "data-email", "data-id", "data-discipline", "data-lw", "data-fig", "data-idx", "data-prop",
                   "value", "readonly", "rows", "type", "step", "placeholder", "title", "colspan", "aria-label", "aria-hidden"],
        FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover", "onfocus", "onanimationstart"]
    };

    /**
     * Sanitize an HTML string. Returns a string safe to assign to innerHTML.
     * @param {string} html
     * @returns {string}
     */
    function safeHTML(html) {
        const str = html == null ? "" : String(html);
        if (window.DOMPurify && typeof window.DOMPurify.sanitize === "function") {
            return window.DOMPurify.sanitize(str, PURIFY_CONFIG);
        }
        // Fallback: no HTML at all rather than an XSS hole.
        const d = document.createElement("div");
        d.textContent = str;
        return d.innerHTML;
    }

    /**
     * Sanitize `html` and assign it to `el.innerHTML`. No-op if `el` is null.
     * @param {Element|null} el
     * @param {string} html
     */
    function setSafeHTML(el, html) {
        if (!el) return;
        el.innerHTML = safeHTML(html);
    }

    /**
     * Replace the rows of a <tbody> (or <thead>/<table>) with sanitized <tr> markup.
     * A bare "<tr><td>…" string can't be sanitized on its own — the HTML parser drops
     * table tags that aren't inside a <table>, collapsing every cell into one. So we
     * sanitize the rows wrapped in a real table, then transplant the <tr> nodes.
     * @param {Element|null} el   the <tbody> to fill
     * @param {string} rowsHtml   one or more "<tr>…</tr>" strings
     */
    function setSafeRows(el, rowsHtml) {
        if (!el) return;
        const clean = safeHTML("<table><tbody>" + (rowsHtml || "") + "</tbody></table>");
        const tpl = document.createElement("template");
        tpl.innerHTML = clean; // already sanitized; parsed here in valid table context
        const tb = tpl.content && typeof tpl.content.querySelector === "function" ? tpl.content.querySelector("tbody") : null;
        const rows = tb ? Array.prototype.filter.call(tb.childNodes, function (n) { return n.nodeType === 1; }) : [];
        if (tb) {
            // Real DOM. Zero surviving rows means the input held no valid <tr> (or only content
            // the sanitizer removed) — render nothing. NEVER fall back to the raw input here:
            // that used to re-insert exactly the markup DOMPurify had just stripped.
            if (el.replaceChildren) el.replaceChildren.apply(el, rows);
            else { el.innerHTML = ""; rows.forEach(function (n) { el.appendChild(n); }); }
        } else if (window.DOMPurify && typeof window.DOMPurify.sanitize === "function") {
            // Headless mock DOM (tests) where <template> has no real tree: still sanitized.
            el.innerHTML = window.DOMPurify.sanitize(rowsHtml || "", PURIFY_CONFIG);
        } else {
            // No DOM tree and no sanitizer: text only, same contract as safeHTML()'s fallback.
            el.textContent = rowsHtml || "";
        }
    }

    /**
     * Sanitize a plain-text value for safe interpolation into an HTML template string (before it
     * ever reaches setSafeHTML/setSafeRows — DOMPurify is a second, independent layer, not a
     * reason to skip this). Delegates to security-pki's entity-escaper when that plugin has
     * loaded; degrades to a plain string otherwise, same as every call site's own fallback used
     * to. Was copy-pasted verbatim as a local `clean` const in 8+ plugin files — kept the same
     * name and behavior at each call site, just pointed at one shared implementation.
     * @param {*} s
     * @returns {string}
     */
    function cleanText(s) {
        return window.BoundaryQCSecurity ? window.BoundaryQCSecurity.sanitizeString(String(s ?? "")) : String(s ?? "");
    }

    window.safeHTML = safeHTML;
    window.setSafeHTML = setSafeHTML;
    window.setSafeRows = setSafeRows;
    window.cleanText = cleanText;
})();
