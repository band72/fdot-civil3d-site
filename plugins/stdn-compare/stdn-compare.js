/**
 * Plugin: stdn-compare (Standards Compare — refined DXF comparer + auto-correct)
 * plugins/stdn-compare/stdn-compare.js
 *
 * The tab UI over window.StdnEngine (see stdn-engine.js). Two modes:
 *
 *   Check        — validate a drawing against a JSON standard and/or a master
 *                  template DXF (its LAYER/LTYPE/STYLE tables + BLOCKS become the
 *                  rules), and/or geometry-diff it against a reference drawing.
 *                  Renders a severity-filtered violations table, an added/removed/
 *                  modified geometry breakdown, and an SVG diff overlay.
 *
 *   Auto-correct — given a target + a master template, fix the deficiencies
 *                  that are safe to fix (layer colours/linetypes/lineweights,
 *                  missing layers/linetypes/styles, stray colour overrides →
 *                  ByLayer) and hand back a corrected .dxf, flagging renames /
 *                  deletions / unit changes / (opt-in) blocks for manual review.
 *
 * Ported from the `standardcompare-plugin` React + Express project. The server
 * half (HTTP router, multer, CORS, rate limiter, filesystem standards dir) is
 * dropped — everything runs client-side. Registers via window.PluginRegistry.
 * Depends on stdn-engine.js and core/cogo.js (window.COGO.downloadText).
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "stdn-compare",
        version: "1.0.0",
        description: "Refined DXF standards comparer: JSON-standard + master-template checks, tolerance geometry diff with SVG overlay, and safe auto-correction to a corrected .dxf.",
        tab: "tab-stdn-compare",
        icon: "fa-code-branch",
        tier: "Pro",
        dependencies: ["cms-engine"],
    };

    const E = () => window.StdnEngine;
    const clean = window.cleanText; // core/safe-dom.js — shared across every plugin that sanitizes text before interpolation
    const MAX_DXF_CHARS = 8 * 1024 * 1024;

    // ── Bundled samples (the standardcompare-plugin test fixtures) ────────────
    const SAMPLES = {
        reference: `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n0\nLAYER\n2\n0\n62\n7\n6\nCONTINUOUS\n70\n0\n0\nLAYER\n2\nWALLS\n62\n1\n6\nCONTINUOUS\n370\n25\n0\nLAYER\n2\nDIMS\n62\n3\n6\nCONTINUOUS\n0\nENDTAB\n0\nTABLE\n2\nSTYLE\n0\nSTYLE\n2\nSTANDARD\n3\narial.ttf\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nWALLS\n10\n0.0\n20\n0.0\n30\n0.0\n11\n100.0\n21\n0.0\n31\n0.0\n0\nLINE\n8\nWALLS\n10\n100.0\n20\n0.0\n30\n0.0\n11\n100.0\n21\n50.0\n31\n0.0\n0\nCIRCLE\n8\n0\n10\n50.0\n20\n25.0\n30\n0.0\n40\n5.0\n0\nTEXT\n8\nDIMS\n10\n10.0\n20\n60.0\n30\n0.0\n40\n2.5\n1\nROOM A\n7\nSTANDARD\n0\nENDSEC\n0\nEOF\n`,
        target: `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n0\nLAYER\n2\n0\n62\n7\n6\nCONTINUOUS\n70\n0\n0\nLAYER\n2\nWALLS\n62\n5\n6\nCONTINUOUS\n370\n25\n0\nLAYER\n2\nDIMS\n62\n3\n6\nCONTINUOUS\n0\nENDTAB\n0\nTABLE\n2\nSTYLE\n0\nSTYLE\n2\nSTANDARD\n3\narial.ttf\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nWALLS\n10\n0.0\n20\n0.0\n30\n0.0\n11\n100.0\n21\n0.0\n31\n0.0\n0\nLINE\n8\nWALLS\n10\n100.0\n20\n0.0\n30\n0.0\n11\n100.0\n21\n60.0\n31\n0.0\n0\nCIRCLE\n8\n0\n10\n50.0\n20\n25.0\n30\n0.0\n40\n8.0\n0\nTEXT\n8\nDIMS\n10\n10.0\n20\n60.0\n30\n0.0\n40\n2.5\n1\nROOM A\n7\nSTANDARD\n0\nLINE\n8\ntemp_layer\n10\n20.0\n20\n20.0\n30\n0.0\n11\n40.0\n21\n40.0\n31\n0.0\n0\nENDSEC\n0\nEOF\n`,
        master: `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n0\nLAYER\n2\n0\n62\n7\n6\nCONTINUOUS\n70\n0\n0\nLAYER\n2\nWALLS\n62\n1\n6\nCONTINUOUS\n370\n25\n0\nLAYER\n2\nDOORS\n62\n2\n6\nCONTINUOUS\n370\n18\n0\nLAYER\n2\nDIMS\n62\n3\n6\nCONTINUOUS\n0\nENDTAB\n0\nTABLE\n2\nLTYPE\n0\nLTYPE\n2\nCONTINUOUS\n3\nSolid line\n0\nLTYPE\n2\nHIDDEN\n3\nHidden ____ ____ ____\n0\nENDTAB\n0\nTABLE\n2\nSTYLE\n0\nSTYLE\n2\nSTANDARD\n3\narial.ttf\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nBLOCKS\n0\nBLOCK\n8\n0\n2\nWINDOW-TAG\n70\n0\n10\n0.0\n20\n0.0\n30\n0.0\n0\nLINE\n8\n0\n10\n0.0\n20\n0.0\n30\n0.0\n11\n5.0\n21\n0.0\n31\n0.0\n0\nENDBLK\n8\n0\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nWALLS\n10\n0.0\n20\n0.0\n30\n0.0\n11\n100.0\n21\n0.0\n31\n0.0\n0\nENDSEC\n0\nEOF\n`,
        messy: `0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n0\nLAYER\n2\n0\n62\n7\n6\nCONTINUOUS\n70\n0\n0\nLAYER\n2\nWALLS\n62\n5\n6\nCONTINUOUS\n370\n25\n0\nLAYER\n2\nDIMS\n62\n3\n6\nCONTINUOUS\n0\nENDTAB\n0\nTABLE\n2\nLTYPE\n0\nLTYPE\n2\nCONTINUOUS\n3\nSolid line\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nBLOCKS\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nWALLS\n62\n2\n10\n0.0\n20\n0.0\n30\n0.0\n11\n100.0\n21\n0.0\n31\n0.0\n0\nLINE\n8\nDIMS\n6\nHIDDEN\n10\n0.0\n20\n10.0\n30\n0.0\n11\n50.0\n21\n10.0\n31\n0.0\n0\nTEXT\n8\nDIMS\n10\n5.0\n20\n15.0\n30\n0.0\n40\n2.5\n1\nNOTE\n7\nSTANDARD\n0\nENDSEC\n0\nEOF\n`,
    };

    // ── State ───────────────────────────────────────────────────────────────
    const state = {
        mode: "check",              // "check" | "heal"
        files: { target: null, reference: null, master: null, standard: null }, // { name, text }
        standardId: "fdot-2026",       // this is the FDOT app's landing tab — default to the FDOT layer standard
        useCustomStandard: false,
        healBlocks: false,
        lastReport: null,           // { source:"compare", data }
        lastHeal: null,             // { source:"heal", data, targetName }
    };

    const $ = id => document.getElementById(id);

    // ── File slots ──────────────────────────────────────────────────────────

    const SLOTS = {
        target:    { label: "Drawing to check", accept: ".dxf" },
        reference: { label: "Reference drawing (optional)", accept: ".dxf" },
        master:    { label: "Master template", accept: ".dxf" },
        standard:  { label: "Custom JSON standard", accept: ".json" },
    };

    function slotHtml(key) {
        const f = state.files[key];
        const s = SLOTS[key];
        return `
        <div class="glass-panel" style="padding:0.9rem 1rem; border:1px solid var(--border-subtle);">
          <div style="font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:var(--text-muted);">${s.label}</div>
          <div id="stdn-slot-${key}" data-slot="${key}"
               style="margin-top:0.5rem; border:1.5px dashed var(--border-accent); border-radius:var(--radius-md); padding:0.9rem; text-align:center; cursor:pointer; background:var(--primary-light); transition:border-color var(--transition), background var(--transition);">
            ${f
                ? `<div style="font-family:var(--font-mono); font-size:0.8rem; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;"><i class="fa-solid fa-file-lines" style="color:var(--success);"></i> ${clean(f.name)}</div>
                   <button class="btn btn-secondary btn-sm" data-slot-clear="${key}" style="margin-top:0.4rem; color:var(--danger); border-color:var(--danger-light);">Remove</button>`
                : `<i class="fa-solid fa-arrow-up-from-bracket" style="font-size:1.1rem; color:var(--primary);"></i>
                   <div style="font-size:0.78rem; color:var(--text-secondary); margin-top:0.3rem;">Drop a <code>${s.accept}</code> or click to browse</div>`
            }
          </div>
          <input type="file" accept="${s.accept}" data-slot-input="${key}" style="display:none;">
        </div>`;
    }

    function renderControls() {
        const box = $("stdn-controls");
        if (!box) return;
        const heal = state.mode === "heal";

        const slots = ["target"]
            .concat(heal ? ["master"] : ["reference", "master", "standard"])
            .map(slotHtml).join("");

        const stdRow = heal ? "" : `
          <div class="form-group" style="margin-top:0.5rem;">
            <label>Built-in JSON standard <span style="color:var(--text-muted); font-weight:400;">(merged under a master template if one is supplied)</span></label>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
              <label style="font-size:0.78rem; color:var(--text-secondary); display:flex; align-items:center; gap:0.3rem;">
                <input type="checkbox" id="stdn-use-custom" ${state.useCustomStandard ? "checked" : ""} style="width:auto;"> use uploaded JSON instead
              </label>
              <select id="stdn-std-select" aria-label="Built-in standard" style="min-width:260px;" ${state.useCustomStandard ? "disabled" : ""}>
                <option value="" ${state.standardId === "" ? "selected" : ""}>(none — geometry / master only)</option>
                ${Object.keys(E().BUILTIN_STANDARDS).map(id => `<option value="${id}" ${id === state.standardId ? "selected" : ""}>${clean(E().BUILTIN_STANDARDS[id].name)}</option>`).join("")}
              </select>
            </div>
          </div>`;

        const healRow = heal ? `
          <label style="font-size:0.8rem; color:var(--text-secondary); display:flex; align-items:center; gap:0.4rem; margin-top:0.6rem;">
            <input type="checkbox" id="stdn-heal-blocks" ${state.healBlocks ? "checked" : ""} style="width:auto;">
            Also copy missing block definitions from the master
            <span style="color:var(--warning); font-size:0.72rem;">— verify BLOCK_RECORD refs in your CAD app afterward</span>
          </label>` : "";

        window.setSafeHTML(box, `
          <div class="hero-demo-card">
            <div style="font-size:0.85rem; font-weight:600; color:var(--text-primary); margin-bottom:0.3rem;">
              <i class="fa-solid fa-flask" style="color:var(--text-muted);"></i> Try it with a bundled sample
            </div>
            <p style="font-size:0.8rem; color:var(--text-secondary); margin:0 0 0.7rem; line-height:1.4;">
              Run the standards check, geometry diff and auto-correct against a sample FDOT drawing — no upload needed.
            </p>
            <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
              <button class="btn btn-secondary btn-sm" id="stdn-hero-drainage-demo">
                <i class="fa-solid fa-play"></i> Non-compliant drainage sample
              </button>
              <button class="btn btn-secondary btn-sm" id="stdn-hero-sr50-demo">
                <i class="fa-solid fa-road"></i> SR-50 roadway sample
              </button>
            </div>
          </div>
          <div style="display:inline-flex; border:1px solid var(--border-subtle); border-radius:var(--radius-md); overflow:hidden; margin-bottom:0.9rem;">
            <button class="btn btn-sm ${heal ? "btn-secondary" : "btn-primary"}" id="stdn-mode-check" style="border-radius:0;">Check</button>
            <button class="btn btn-sm ${heal ? "btn-primary" : "btn-secondary"}" id="stdn-mode-heal" style="border-radius:0;">Auto-correct</button>
          </div>
          <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:0.85rem;">${slots}</div>
          ${stdRow}
          ${healRow}
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; margin-top:0.9rem;">
            <button class="btn btn-primary" id="stdn-run">${heal ? "Auto-correct drawing" : "Run comparison"}</button>
            <button class="btn btn-secondary btn-sm" id="stdn-clear">Clear</button>
            <span style="width:1px; height:22px; background:var(--border-subtle); margin:0 0.25rem;"></span>
            <span style="font-size:0.75rem; color:var(--text-muted);">Samples:</span>
            <button class="btn btn-secondary btn-sm" id="stdn-sample-check">Load check sample</button>
            <button class="btn btn-secondary btn-sm" id="stdn-sample-heal">Load auto-correct sample</button>
          </div>`);
    }

    // ── File I/O ────────────────────────────────────────────────────────────

    function acceptFile(key, file, ctx) {
        const rdr = new FileReader();
        rdr.onload = ev => {
            const text = String(ev.target.result || "");
            if (text.length > MAX_DXF_CHARS) { ctx.showToast(`${file.name} is larger than ${MAX_DXF_CHARS / 1048576} MB.`, true); return; }
            state.files[key] = { name: file.name, text };
            renderControls();
        };
        rdr.readAsText(file);
    }

    // ── Run: Check ──────────────────────────────────────────────────────────

    /** → { spec } (may be null for "no JSON standard") or { err }. */
    function resolveJsonStandard() {
        if (state.useCustomStandard) {
            const f = state.files.standard;
            if (!f) return { spec: null };                          // no file yet — rely on master/reference
            try { return { spec: JSON.parse(f.text) }; }
            catch (e) { return { err: `${f.name} is not valid JSON.` }; }
        }
        if (!state.standardId) return { spec: null };               // "(none)" picked
        try { return { spec: E().defaultResolveBuiltInStandard(state.standardId) }; }
        catch (e) { return { err: e.message }; }
    }

    /**
     * Record this run — whether `target` came from a live upload or from
     * clicking a bundled sample — into the CMS Submittal Vault (see
     * plugins/cms-engine/cms-engine.js), so real usage shows up next to the
     * seeded demo project/submittal records instead of only that one frozen
     * seed row ever appearing. No-op when signed out; never invents a
     * submitter. The score is a rough client-side heuristic for the CMS list,
     * not an engine output — StdnEngine itself reports pass/fail, not a score.
     */
    async function recordSubmittal({ filename, dxfText, score, status }) {
        if (!window.BoundaryQCCMS || !window.BoundaryQCCMS.isAuthenticated()) return;
        const sha256 = window.BoundaryQCSecurity ? await window.BoundaryQCSecurity.computeTextSHA256(dxfText) : "";
        window.BoundaryQCCMS.addSubmittal(
            null, filename, status, score,
            "n/a — no traverse closure computed", false, sha256
        );
    }

    function deriveCheckScore(report) {
        if (report.standardsCheck) {
            const s = report.standardsCheck.summary;
            return Math.max(0, 100 - s.errors * 8 - s.warnings * 3);
        }
        // Geometry-only comparison: identical is a clean 100; any difference has no defined score.
        return report.overall.geometryIdentical === true ? 100 : null;
    }

    function deriveHealScore(result) {
        const s = result.summary;
        return s.fullyHealed ? 100 : Math.max(0, 100 - s.violationsAfter * 8);
    }

    async function runCheck(ctx) {
        const { target, reference, master } = state.files;
        if (!target) { ctx.showToast("Add a drawing to check.", true); return; }

        const std = resolveJsonStandard();
        if (std.err) { ctx.showToast(std.err, true); return; }
        const jsonStandardSpec = std.spec;

        if (!reference && !master && !jsonStandardSpec) {
            ctx.showToast("Add a reference drawing, a master template, or pick a standard.", true); return;
        }

        let report;
        try {
            report = E().orchestrateCompare({
                targetText: target.text, targetFileName: target.name,
                referenceText: reference ? reference.text : null, referenceFileName: reference ? reference.name : null,
                masterText: master ? master.text : null, masterFileName: master ? master.name : null,
                jsonStandardSpec,
            });
        } catch (err) {
            ctx.showToast(err.message || "Comparison failed.", true);
            return;
        }
        state.lastReport = { source: "compare", data: report };
        state.lastHeal = null;
        renderResults(ctx);
        ctx.showToast(report.overall.passed ? "Passed — conforms to the standard." : "Comparison complete — see the results below.", report.overall.passed === false);
        await recordSubmittal({
            filename: target.name, dxfText: target.text,
            score: deriveCheckScore(report), status: report.overall.passed ? "PASSED" : "NEEDS REVIEW",
        });
    }

    // ── Run: Heal ───────────────────────────────────────────────────────────

    async function runHeal(ctx) {
        const { target, master } = state.files;
        if (!target || !master) { ctx.showToast("Auto-correct needs both a target drawing and a master template.", true); return; }
        let result;
        try {
            result = E().healDxf(master.text, target.text, { healBlocks: state.healBlocks });
        } catch (err) {
            ctx.showToast(err.message || "Auto-correct failed.", true);
            return;
        }
        state.lastHeal = { source: "heal", data: result, targetName: target.name };
        state.lastReport = null;
        renderResults(ctx);
        ctx.showToast(result.summary.fullyHealed ? "Fully corrected." : `${result.summary.actionsApplied} fix(es) applied, ${result.summary.unresolved} for manual review.`, !result.summary.fullyHealed);
        await recordSubmittal({
            filename: target.name, dxfText: target.text,
            score: deriveHealScore(result), status: result.summary.fullyHealed ? "CORRECTED" : "PARTIALLY CORRECTED",
        });
    }

    // ── Results rendering ───────────────────────────────────────────────────

    const sevColor = s => s === "error" ? "var(--danger)" : (s === "warning" ? "var(--warning)" : "var(--accent)");

    function violationsTable(list, opts) {
        opts = opts || {};
        if (!list || !list.length) return `<div style="color:var(--success); font-size:0.85rem; padding:0.5rem 0;"><i class="fa-solid fa-circle-check"></i> None.</div>`;
        const order = { error: 0, warning: 1, info: 2 };
        const rows = [...list].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9)).map(v => `
          <tr>
            <td><span class="badge" style="background:${sevColor(v.severity)}; font-size:0.62rem;">${clean(v.severity)}</span></td>
            <td style="font-family:var(--font-mono); font-size:0.72rem; color:var(--primary);">${clean(v.code)}</td>
            <td style="font-family:var(--font-mono); font-size:0.75rem;">${clean(v.layer || v.linetype || v.style || v.block || "—")}</td>
            <td style="font-size:0.8rem; color:var(--text-secondary);">${clean(v.message)}${opts.withReason && v.reason ? `<div style="color:var(--warning); font-size:0.72rem; margin-top:0.2rem;">${clean(v.reason)}</div>` : ""}</td>
          </tr>`).join("");
        return `<div style="overflow-x:auto;"><table class="data-table" style="width:100%;"><thead><tr><th>Sev</th><th>Code</th><th>Item</th><th>Description${opts.withReason ? " / why manual" : ""}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    function statGrid(pairs) {
        return `<div style="display:grid; grid-template-columns:repeat(${pairs.length},1fr); gap:1px; background:var(--border-subtle); border:1px solid var(--border-subtle); border-radius:var(--radius-md); overflow:hidden; margin:0.6rem 0;">
          ${pairs.map(([v, l, c]) => `<div style="background:var(--bg-surface); padding:0.85rem; text-align:center;">
            <div style="font-family:var(--font-mono); font-size:1.35rem; font-weight:800; color:${c || "var(--text-primary)"};">${v}</div>
            <div style="font-size:0.68rem; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em;">${l}</div>
          </div>`).join("")}
        </div>`;
    }

    function geometrySection(gd) {
        if (!gd) return "";
        const s = gd.summary;
        const entRows = arr => arr.length
            ? arr.slice(0, 100).map(e => `<tr><td style="font-family:var(--font-mono); font-size:0.75rem;">${clean(e.type)}</td><td style="font-family:var(--font-mono); font-size:0.75rem;">${clean(e.layer)}</td></tr>`).join("")
              + (arr.length > 100 ? `<tr><td colspan="2" style="color:var(--text-muted);">… ${arr.length - 100} more</td></tr>` : "")
            : `<tr><td colspan="2" style="color:var(--text-muted);">none</td></tr>`;
        const modRows = gd.modified.length
            ? gd.modified.slice(0, 100).map(m => `<tr>
                <td style="font-family:var(--font-mono); font-size:0.75rem;">${clean(m.type)}</td>
                <td style="font-family:var(--font-mono); font-size:0.75rem;">${clean(m.layer)}</td>
                <td style="font-size:0.75rem;">${m.changes.map(c => `<div><strong>${clean(c.label)}:</strong> ${typeof c.from === "number" ? c.from.toFixed(3) : clean(c.from)} → ${typeof c.to === "number" ? c.to.toFixed(3) : clean(c.to)}${Number.isFinite(c.delta) ? ` <span style="color:var(--text-muted);">(Δ ${c.delta.toFixed(3)})</span>` : ""}</div>`).join("")}</td>
              </tr>`).join("")
            : `<tr><td colspan="3" style="color:var(--text-muted);">none</td></tr>`;
        return `
          <details open style="margin-top:0.75rem;"><summary style="cursor:pointer; font-weight:700;">Geometry differences</summary>
            ${statGrid([[s.unchanged, "Unchanged"], [s.added, "Added", "var(--primary)"], [s.removed, "Removed", "var(--danger)"], [s.modified, "Modified", "var(--warning)"]])}
            <div style="overflow-x:auto;"><table class="data-table" style="width:100%;"><thead><tr><th>Modified — type</th><th>Layer</th><th>Field changes</th></tr></thead><tbody>${modRows}</tbody></table></div>
            <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin-top:0.6rem;">
              <div><div style="font-size:0.72rem; font-weight:700; color:var(--primary); text-transform:uppercase;">Added (${s.added})</div><table class="data-table" style="width:100%; font-size:0.8rem;"><thead><tr><th>Type</th><th>Layer</th></tr></thead><tbody>${entRows(gd.added)}</tbody></table></div>
              <div><div style="font-size:0.72rem; font-weight:700; color:var(--danger); text-transform:uppercase;">Removed (${s.removed})</div><table class="data-table" style="width:100%; font-size:0.8rem;"><thead><tr><th>Type</th><th>Layer</th></tr></thead><tbody>${entRows(gd.removed)}</tbody></table></div>
            </div>
          </details>`;
    }

    function overlaySection(svgString, container) {
        if (!svgString || !container) return;
        try {
            const doc = new DOMParser().parseFromString(svgString, "image/svg+xml");
            const svg = doc.documentElement;
            if (!svg || svg.nodeName.toLowerCase() !== "svg") return;
            svg.setAttribute("style", "width:100%; height:auto; max-height:440px; display:block; cursor:grab; touch-action:none;");
            container.replaceChildren(svg);
            wireOverlayPanZoom(svg, container);
        } catch (e) { /* overlay is optional */ }
    }

    /** Wheel-zoom (about the cursor), drag-pan, double-click-to-reset on the diff SVG. */
    function wireOverlayPanZoom(svg, container) {
        const parts = (svg.getAttribute("viewBox") || "0 0 100 100").trim().split(/[\s,]+/).map(Number);
        if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return;
        const home = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
        const vb = { ...home };
        const apply = () => svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);

        svg.addEventListener("wheel", e => {
            e.preventDefault();
            const r = svg.getBoundingClientRect();
            const fx = (e.clientX - r.left) / (r.width || 1);
            const fy = (e.clientY - r.top) / (r.height || 1);
            const k = e.deltaY < 0 ? 0.85 : 1.18;                    // in / out
            const nw = Math.min(home.w * 40, Math.max(home.w / 200, vb.w * k));
            const nh = nw * (vb.h / vb.w);
            vb.x += (vb.w - nw) * fx;
            vb.y += (vb.h - nh) * fy;
            vb.w = nw; vb.h = nh;
            apply();
        }, { passive: false });

        let drag = null;
        svg.addEventListener("pointerdown", e => {
            drag = { cx: e.clientX, cy: e.clientY, x: vb.x, y: vb.y };
            svg.style.cursor = "grabbing";
            try { svg.setPointerCapture(e.pointerId); } catch (x) {}
        });
        svg.addEventListener("pointermove", e => {
            if (!drag) return;
            const r = svg.getBoundingClientRect();
            vb.x = drag.x - (e.clientX - drag.cx) * (vb.w / (r.width || 1));
            vb.y = drag.y - (e.clientY - drag.cy) * (vb.h / (r.height || 1));
            apply();
        });
        const end = e => { drag = null; svg.style.cursor = "grab"; try { svg.releasePointerCapture(e.pointerId); } catch (x) {} };
        svg.addEventListener("pointerup", end);
        svg.addEventListener("pointercancel", end);
        svg.addEventListener("dblclick", e => { e.preventDefault(); Object.assign(vb, home); apply(); });
    }

    function renderResults(ctx) {
        const box = $("stdn-results");
        if (!box) return;
        box.classList.remove("hidden");

        // ── Check result ────────────────────────────────────────────────────
        if (state.lastReport) {
            const r = state.lastReport.data;
            const passed = r.overall.passed;
            const legend = `
              <div style="display:flex; gap:1rem; flex-wrap:wrap; font-size:0.72rem; color:var(--text-muted); margin-bottom:0.4rem;">
                <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#9AA0A6;"></span> unchanged</span>
                <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#2E7BE0;"></span> added</span>
                <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#D0342C;"></span> removed</span>
                <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:#E08A00;"></span> modified</span>
                <span style="margin-left:auto; opacity:0.8;">scroll to zoom · drag to pan · double-click to reset</span>
              </div>`;

            window.setSafeHTML(box, `
              <div class="results-box" style="border-left-color:${passed ? "var(--success)" : "var(--warning)"};">
                <strong style="font-size:1rem; color:${passed ? "var(--success)" : "var(--warning)"};">${passed ? "Passed" : "Needs attention"}</strong>
                <div style="font-size:0.82rem; color:var(--text-secondary); margin-top:0.2rem;">
                  ${r.standardsCheck ? (r.overall.standardsPassed ? "Conforms to the standard. " : `${r.standardsCheck.summary.errors} standards error(s). `) : ""}
                  ${r.geometryDiff ? (r.overall.geometryIdentical ? "Geometry matches the reference drawing." : `${r.geometryDiff.summary.added + r.geometryDiff.summary.removed + r.geometryDiff.summary.modified} geometry difference(s).`) : ""}
                </div>
              </div>
              ${r.overlaySvg ? `<div style="margin-top:0.75rem;">${legend}<div id="stdn-overlay" style="background:#0B1220; border:1px solid var(--border-subtle); border-radius:var(--radius-md); overflow:hidden;"></div></div>` : ""}
              ${r.standardsCheck ? `
                <details open style="margin-top:0.75rem;"><summary style="cursor:pointer; font-weight:700;">Standards violations (${r.standardsCheck.summary.total})</summary>
                  ${statGrid([[r.standardsCheck.summary.errors, "Errors", "var(--danger)"], [r.standardsCheck.summary.warnings, "Warnings", "var(--warning)"], [r.standardsCheck.summary.info, "Info", "var(--accent)"], [r.standardsCheck.summary.total, "Total"]])}
                  <div id="stdn-viol-filter" style="display:flex; gap:0.4rem; flex-wrap:wrap; margin-bottom:0.5rem;">
                    ${["all", "error", "warning", "info"].map(s => `<button class="pill-btn ${s === "all" ? "active" : ""}" data-sev="${s}">${s === "all" ? `All (${r.standardsCheck.violations.length})` : `${s[0].toUpperCase()}${s.slice(1)} (${r.standardsCheck.violations.filter(v => v.severity === s).length})`}</button>`).join("")}
                  </div>
                  <div id="stdn-viol-body">${violationsTable(r.standardsCheck.violations)}</div>
                </details>` : ""}
              ${geometrySection(r.geometryDiff)}
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.85rem;">
                <button class="btn btn-primary btn-sm" id="stdn-cert-btn"><i class="fa-solid fa-clipboard-check"></i> Generate self-check summary</button>
                <button class="btn btn-secondary btn-sm" id="stdn-report-html"><i class="fa-solid fa-file-code"></i> Export HTML report</button>
                <button class="btn btn-secondary btn-sm" id="stdn-report-md"><i class="fa-solid fa-file-lines"></i> Export Markdown report</button>
                ${r.standardsCheck && !r.overall.standardsPassed ? `<span style="font-size:0.75rem; color:var(--text-muted); align-self:center;">Tip: switch to Auto-correct with a master template to fix these.</span>` : ""}
              </div>`);

            overlaySection(r.overlaySvg, $("stdn-overlay"));
            return;
        }

        // ── Auto-correct result ─────────────────────────────────────────────
        if (state.lastHeal) {
            const h = state.lastHeal.data;
            const s = h.summary;
            const actRows = h.actions.length
                ? h.actions.map(a => `<tr>
                    <td style="font-family:var(--font-mono); font-size:0.72rem; color:var(--primary);">${clean(a.code)}</td>
                    <td style="font-family:var(--font-mono); font-size:0.75rem;">${clean(a.layer || a.linetype || a.style || a.block || "—")}</td>
                    <td style="font-size:0.8rem;">${clean(a.action)}${a.to !== undefined ? ` → ${clean(a.to)}` : ""}${a.caveat ? `<div style="color:var(--warning); font-size:0.72rem; margin-top:0.2rem;">${clean(a.caveat)}</div>` : ""}</td>
                  </tr>`).join("")
                : `<tr><td colspan="3" style="color:var(--text-muted);">No automatic fixes were applied.</td></tr>`;

            window.setSafeHTML(box, `
              <div class="results-box" style="border-left-color:${s.fullyHealed ? "var(--success)" : "var(--warning)"};">
                <strong style="font-size:1rem; color:${s.fullyHealed ? "var(--success)" : "var(--warning)"};">${s.fullyHealed ? "Fully corrected" : "Partially corrected"}</strong>
                <div style="font-size:0.82rem; color:var(--text-secondary); margin-top:0.2rem;">
                  ${s.actionsApplied} fix${s.actionsApplied === 1 ? "" : "es"} applied automatically.${s.unresolved > 0 ? ` ${s.unresolved} item${s.unresolved === 1 ? "" : "s"} need${s.unresolved === 1 ? "s" : ""} manual review.` : ""}
                </div>
              </div>
              ${statGrid([[s.violationsBefore, "Deficiencies", "var(--danger)"], [s.actionsApplied, "Auto-fixed", "var(--success)"], [s.unresolved, "Needs review", "var(--warning)"], [s.violationsAfter, "Remaining"]])}
              <button class="btn btn-primary" id="stdn-download-healed"><i class="fa-solid fa-download"></i> Download corrected DXF</button>
              <details open style="margin-top:0.75rem;"><summary style="cursor:pointer; font-weight:700;">Applied automatically (${h.actions.length})</summary>
                <div style="overflow-x:auto;"><table class="data-table" style="width:100%;"><thead><tr><th>Code</th><th>Item</th><th>Action taken</th></tr></thead><tbody>${actRows}</tbody></table></div>
              </details>
              <details ${h.unresolved.length ? "open" : ""} style="margin-top:0.5rem;"><summary style="cursor:pointer; font-weight:700; color:var(--warning);">Needs manual review (${h.unresolved.length})</summary>
                ${violationsTable(h.unresolved, { withReason: true })}
              </details>
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.85rem;">
                <button class="btn btn-accent btn-sm" id="stdn-cert-btn"><i class="fa-solid fa-clipboard-check"></i> Generate self-check summary</button>
                <button class="btn btn-secondary btn-sm" id="stdn-report-html"><i class="fa-solid fa-file-code"></i> Export HTML report</button>
                <button class="btn btn-secondary btn-sm" id="stdn-report-md"><i class="fa-solid fa-file-lines"></i> Export Markdown report</button>
              </div>`);
            return;
        }

        box.classList.add("hidden");
    }

    // ── Exports ─────────────────────────────────────────────────────────────

    function exportReport(format, ctx) {
        const src = state.lastReport || state.lastHeal;
        if (!src) { ctx.showToast("Run a comparison or auto-correct first.", true); return; }
        const meta = src.source === "heal"
            ? { targetFile: state.lastHeal.targetName, masterFile: state.files.master && state.files.master.name }
            : {};
        const model = E().buildReportModel({ source: src.source, data: src.data, meta });
        const content = format === "markdown" ? E().renderMarkdown(model) : E().renderHtml(model);
        const filename = E().suggestFilename(model, format);
        if (window.Reports?.addReport) {
            window.Reports.addReport({
                title: model.source === "heal" ? "DXF Auto-Correct Report" : "DXF Standards Compliance Report",
                type: "standards-compare",
                category: "standards",
                format: format === "markdown" ? "markdown" : "html",
                filename,
                content
            });
        }
        window.COGO.downloadText(filename, content, format === "markdown" ? "text/markdown" : "text/html");
        ctx.showToast(`Exported ${filename} & stored in Reports Hub.`);
    }

    // ── Target & Template Grid Comparison Engine ───────────────────────────

    const gridState = {
        targetFile: null,      // { name, text, size }
        templateFile: null,    // { name, text, size }
        results: [],           // items evaluated: { id, category, name, status, targetVal, templateVal, severity, details }
        activeFilter: "all",   // "all" | "mismatch" | "missing" | "match"
        searchTerm: "",
        lastHealedDxf: null,
    };

    function formatFileSize(bytes) {
        if (!bytes || bytes <= 0) return "0 B";
        const k = 1024;
        const units = ["B", "KB", "MB", "GB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + units[i];
    }

    function setTargetFile(name, text, size) {
        const byteSize = size || (text ? text.length : 0);
        gridState.targetFile = { name, text, size: byteSize };
        state.files.target = { name, text };

        const textInput = $("target-file-text");
        if (textInput) textInput.value = `${name} (${formatFileSize(byteSize)})`;

        const meta = $("target-file-meta");
        if (meta) {
            let info = `Loaded • ${formatFileSize(byteSize)}`;
            const lower = name.toLowerCase();
            if (lower.endsWith(".dxf") || lower.endsWith(".dwt")) {
                try {
                    const p = E().parseDxf(text);
                    info = `DXF • ${Object.keys(p.layers || {}).length} layers, ${(p.entities || []).length} entities, ${p.units || "units unspec"}`;
                } catch (_) {}
            } else if (lower.endsWith(".json")) {
                info = `JSON Standard • ${formatFileSize(byteSize)}`;
            } else if (lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".pts")) {
                const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0).length;
                info = `Point/Text file • ${lines} lines`;
            }
            meta.textContent = info;
        }

        const statusMsg = $("compare-status-msg");
        if (statusMsg && !gridState.templateFile) {
            statusMsg.textContent = "Target file loaded. Now select or drop a Template file.";
        }
    }

    function setTemplateFile(name, text, size) {
        const byteSize = size || (text ? text.length : 0);
        gridState.templateFile = { name, text, size: byteSize };
        state.files.master = { name, text };

        const textInput = $("template-file-text");
        if (textInput) textInput.value = `${name} (${formatFileSize(byteSize)})`;

        const meta = $("template-file-meta");
        if (meta) {
            let info = `Loaded • ${formatFileSize(byteSize)}`;
            const lower = name.toLowerCase();
            if (lower.endsWith(".dxf") || lower.endsWith(".dwt")) {
                try {
                    const p = E().parseDxf(text);
                    info = `DXF Template • ${Object.keys(p.layers || {}).length} layers, ${Object.keys(p.linetypes || {}).length} linetypes, ${Object.keys(p.styles || {}).length} styles`;
                } catch (_) {}
            } else if (lower.endsWith(".json")) {
                try {
                    const js = JSON.parse(text);
                    info = `JSON Standard • ${js.name || "Custom Spec"} (${(js.layers || []).length} layer rules)`;
                } catch (_) {
                    info = `JSON Standard • ${formatFileSize(byteSize)}`;
                }
            }
            meta.textContent = info;
        }

        const statusMsg = $("compare-status-msg");
        if (statusMsg) {
            if (gridState.targetFile) {
                statusMsg.textContent = "Both Target and Template files loaded. Click Execute to compare.";
            } else {
                statusMsg.textContent = "Template file loaded. Now select or drop a Target file.";
            }
        }
    }

    function handleFileInput(type, file, ctx) {
        if (!file) return;
        if (file.size > MAX_DXF_CHARS) {
            ctx.showToast(`${file.name} is larger than ${MAX_DXF_CHARS / 1048576} MB limit.`, true);
            return;
        }
        const rdr = new FileReader();
        rdr.onload = ev => {
            const text = String(ev.target.result || "");
            if (type === "target") {
                setTargetFile(file.name, text, file.size);
            } else {
                setTemplateFile(file.name, text, file.size);
            }
        };
        rdr.readAsText(file);
    }

    function statusBadgeHtml(status) {
        const st = String(status || "MATCH").toUpperCase();
        if (st === "MATCH") {
            return `<span class="badge" style="background:rgba(40,167,69,0.18); color:var(--success, #28a745); font-weight:700; border:1px solid rgba(40,167,69,0.35);"><i class="fa-solid fa-check"></i> MATCH</span>`;
        }
        if (st === "MISMATCH") {
            return `<span class="badge" style="background:rgba(255,193,7,0.18); color:var(--warning, #ffc107); font-weight:700; border:1px solid rgba(255,193,7,0.35);"><i class="fa-solid fa-triangle-exclamation"></i> MISMATCH</span>`;
        }
        if (st === "MISSING") {
            return `<span class="badge" style="background:rgba(220,53,69,0.18); color:var(--danger, #dc3545); font-weight:700; border:1px solid rgba(220,53,69,0.35);"><i class="fa-solid fa-xmark"></i> MISSING</span>`;
        }
        return `<span class="badge" style="background:rgba(23,162,184,0.18); color:var(--info, #17a2b8); font-weight:700; border:1px solid rgba(23,162,184,0.35);"><i class="fa-solid fa-circle-info"></i> ${clean(st)}</span>`;
    }

    function severityHtml(sev) {
        const s = String(sev || "pass").toLowerCase();
        if (s === "pass") return `<span style="color:var(--success, #28a745); font-weight:600;"><i class="fa-solid fa-circle-check"></i> Pass</span>`;
        if (s === "warning") return `<span style="color:var(--warning, #ffc107); font-weight:600;"><i class="fa-solid fa-triangle-exclamation"></i> Warning</span>`;
        if (s === "error") return `<span style="color:var(--danger, #dc3545); font-weight:600;"><i class="fa-solid fa-circle-xmark"></i> Error</span>`;
        return `<span style="color:var(--info, #17a2b8); font-weight:600;"><i class="fa-solid fa-circle-info"></i> Info</span>`;
    }

    function renderResultsGrid() {
        const tbody = $("compare-results-tbody");
        if (!tbody) return;

        const all = gridState.results || [];
        const matches = all.filter(r => r.status === "MATCH").length;
        const mismatches = all.filter(r => r.status === "MISMATCH").length;
        const missing = all.filter(r => r.status === "MISSING").length;
        const score = all.length > 0 ? Math.round((matches / all.length) * 100) : 100;

        // Update stats
        const totalEl = $("grid-stat-total");
        if (totalEl) totalEl.textContent = String(all.length);
        const matchEl = $("grid-stat-matches");
        if (matchEl) matchEl.textContent = String(matches);
        const mismatchEl = $("grid-stat-mismatches");
        if (mismatchEl) mismatchEl.textContent = String(mismatches);
        const missingEl = $("grid-stat-missing");
        if (missingEl) missingEl.textContent = String(missing);
        const scoreEl = $("grid-stat-score");
        if (scoreEl) scoreEl.textContent = `${score}%`;

        // Update pill counts
        const pillAll = $("pill-cnt-all");
        if (pillAll) pillAll.textContent = String(all.length);
        const pillMis = $("pill-cnt-mismatch");
        if (pillMis) pillMis.textContent = String(mismatches);
        const pillMiss = $("pill-cnt-missing");
        if (pillMiss) pillMiss.textContent = String(missing);
        const pillMatch = $("pill-cnt-match");
        if (pillMatch) pillMatch.textContent = String(matches);

        // Filter items
        let filtered = all;
        if (gridState.activeFilter === "mismatch") {
            filtered = all.filter(r => r.status === "MISMATCH");
        } else if (gridState.activeFilter === "missing") {
            filtered = all.filter(r => r.status === "MISSING");
        } else if (gridState.activeFilter === "match") {
            filtered = all.filter(r => r.status === "MATCH");
        }

        if (gridState.searchTerm && gridState.searchTerm.trim() !== "") {
            const q = gridState.searchTerm.toLowerCase().trim();
            filtered = filtered.filter(r =>
                r.category.toLowerCase().includes(q) ||
                r.name.toLowerCase().includes(q) ||
                r.details.toLowerCase().includes(q) ||
                r.targetVal.toLowerCase().includes(q) ||
                r.templateVal.toLowerCase().includes(q)
            );
        }

        const counterEl = $("grid-row-counter");
        if (counterEl) {
            counterEl.textContent = `Showing ${filtered.length} of ${all.length} records`;
        }

        if (filtered.length === 0) {
            const emptyHtml = `<tr><td colspan="8" style="text-align:center; padding:2rem; color:var(--text-muted); font-size:0.9rem;"><i class="fa-solid fa-filter-circle-xmark" style="font-size:1.5rem; display:block; margin-bottom:0.5rem;"></i> No records match the current filter or search criteria.</td></tr>`;
            window.setSafeRows(tbody, emptyHtml);
            return;
        }

        const rowsHtml = filtered.map((r, idx) => `
            <tr style="border-bottom:1px solid rgba(255,255,255,0.05); transition:background var(--transition);">
                <td style="padding:0.5rem 0.6rem; color:var(--text-muted); font-family:var(--font-mono); font-size:0.75rem;">${idx + 1}</td>
                <td style="padding:0.5rem 0.6rem;"><span class="badge" style="background:rgba(255,255,255,0.07); font-size:0.7rem; font-weight:600;">${clean(r.category)}</span></td>
                <td style="padding:0.5rem 0.6rem; font-family:var(--font-mono); font-weight:700; font-size:0.8rem; color:var(--text-primary);">${clean(r.name)}</td>
                <td style="padding:0.5rem 0.6rem;">${statusBadgeHtml(r.status)}</td>
                <td style="padding:0.5rem 0.6rem; font-family:var(--font-mono); font-size:0.75rem; color:var(--text-secondary); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${clean(r.targetVal)}">${clean(r.targetVal)}</td>
                <td style="padding:0.5rem 0.6rem; font-family:var(--font-mono); font-size:0.75rem; color:var(--text-secondary); max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${clean(r.templateVal)}">${clean(r.templateVal)}</td>
                <td style="padding:0.5rem 0.6rem;">${severityHtml(r.severity)}</td>
                <td style="padding:0.5rem 0.6rem; font-size:0.75rem; color:var(--text-primary); line-height:1.35;">${clean(r.details)}</td>
            </tr>
        `).join("");

        window.setSafeRows(tbody, rowsHtml);
    }

    function executeGridComparison(ctx) {
        ctx = ctx || { showToast() {} };
        const statusMsg = $("compare-status-msg");

        // Sync fallback from state.files if gridState has not been populated
        if (!gridState.targetFile && state.files.target) {
            setTargetFile(state.files.target.name, state.files.target.text);
        }
        if (!gridState.templateFile && (state.files.master || state.files.standard)) {
            const tpl = state.files.master || state.files.standard;
            setTemplateFile(tpl.name, tpl.text);
        }

        if (!gridState.targetFile || !gridState.targetFile.text) {
            const msg = "Please upload or select a Target file.";
            if (statusMsg) statusMsg.textContent = msg;
            ctx.showToast(msg, true);
            return;
        }
        if (!gridState.templateFile || !gridState.templateFile.text) {
            const msg = "Please upload or select a Template file.";
            if (statusMsg) statusMsg.textContent = msg;
            ctx.showToast(msg, true);
            return;
        }

        if (statusMsg) statusMsg.textContent = "Analyzing Target and Template standards...";

        const items = [];
        let idCounter = 1;
        const addRow = (category, name, status, targetVal, templateVal, severity, details) => {
            items.push({
                id: idCounter++,
                category: String(category || "General"),
                name: String(name || "—"),
                status: String(status || "MATCH").toUpperCase(),
                targetVal: String(targetVal ?? "—"),
                templateVal: String(templateVal ?? "—"),
                severity: String(severity || "pass").toLowerCase(),
                details: String(details || "")
            });
        };

        const targetText = gridState.targetFile.text;
        const templateText = gridState.templateFile.text;

        let targetParsed = null;
        let templateParsed = null;
        let isTargetDxf = false;
        let isTemplateDxf = false;

        try {
            targetParsed = E().parseDxf(targetText);
            isTargetDxf = true;
        } catch (_) {}

        try {
            templateParsed = E().parseDxf(templateText);
            isTemplateDxf = true;
        } catch (_) {}

        if (isTargetDxf && isTemplateDxf) {
            // 1. Drawing Units / Header comparison
            const tgtUnits = targetParsed.units || (targetParsed.header && targetParsed.header.$INSUNITS) || "Unspecified";
            const tplUnits = templateParsed.units || (templateParsed.header && templateParsed.header.$INSUNITS) || "Unspecified";
            const unitsMatch = String(tgtUnits).toLowerCase() === String(tplUnits).toLowerCase();
            addRow(
                "Header",
                "$INSUNITS (Units)",
                unitsMatch ? "MATCH" : "MISMATCH",
                tgtUnits,
                tplUnits,
                unitsMatch ? "pass" : "warning",
                unitsMatch ? "Drawing units match template specification." : "Drawing units differ from template standard."
            );

            // 2. Layer Table comparison
            const tplLayers = templateParsed.layers || {};
            const tgtLayers = targetParsed.layers || {};

            for (const [layerName, l] of Object.entries(tplLayers)) {
                const tgtL = tgtLayers[layerName];
                if (!tgtL) {
                    addRow(
                        "Layer",
                        layerName,
                        "MISSING",
                        "— (Missing in Target)",
                        `Color: ${l.color}, Ltype: ${l.linetype || "CONTINUOUS"}, Lw: ${l.lineweight ?? "ByLayer"}`,
                        "error",
                        `Required template layer "${layerName}" is missing from target drawing.`
                    );
                } else {
                    const colorMatch = tgtL.color === l.color;
                    const ltypeMatch = (tgtL.linetype || "CONTINUOUS").toUpperCase() === (l.linetype || "CONTINUOUS").toUpperCase();
                    const lwMatch = l.lineweight == null || tgtL.lineweight === l.lineweight;

                    if (colorMatch && ltypeMatch && lwMatch) {
                        addRow(
                            "Layer",
                            layerName,
                            "MATCH",
                            `Color: ${tgtL.color}, Ltype: ${tgtL.linetype || "CONTINUOUS"}, Lw: ${tgtL.lineweight ?? "ByLayer"}`,
                            `Color: ${l.color}, Ltype: ${l.linetype || "CONTINUOUS"}, Lw: ${l.lineweight ?? "ByLayer"}`,
                            "pass",
                            "Layer properties fully conform to template standard."
                        );
                    } else {
                        const diffs = [];
                        if (!colorMatch) diffs.push(`Color: Target has ${tgtL.color}, Template has ${l.color}`);
                        if (!ltypeMatch) diffs.push(`Linetype: Target has ${tgtL.linetype}, Template has ${l.linetype}`);
                        if (!lwMatch) diffs.push(`Lineweight: Target has ${tgtL.lineweight}, Template has ${l.lineweight}`);
                        addRow(
                            "Layer",
                            layerName,
                            "MISMATCH",
                            `Color: ${tgtL.color}, Ltype: ${tgtL.linetype || "CONTINUOUS"}, Lw: ${tgtL.lineweight ?? "ByLayer"}`,
                            `Color: ${l.color}, Ltype: ${l.linetype || "CONTINUOUS"}, Lw: ${l.lineweight ?? "ByLayer"}`,
                            "warning",
                            `${diffs.join("; ")}. Safe to auto-correct.`
                        );
                    }
                }
            }

            for (const [layerName, tgtL] of Object.entries(tgtLayers)) {
                if (!tplLayers[layerName]) {
                    addRow(
                        "Layer",
                        layerName,
                        "MISMATCH",
                        `Color: ${tgtL.color}, Ltype: ${tgtL.linetype || "CONTINUOUS"}, Lw: ${tgtL.lineweight ?? "ByLayer"}`,
                        "— (Not in Template)",
                        "info",
                        `Unrecognized or custom layer "${layerName}" present in target submittal.`
                    );
                }
            }

            // 3. Linetypes comparison
            const tplLtypes = templateParsed.linetypes || {};
            const tgtLtypes = targetParsed.linetypes || {};
            for (const [ltypeName, lt] of Object.entries(tplLtypes)) {
                const hasLt = !!tgtLtypes[ltypeName];
                addRow(
                    "Linetype",
                    ltypeName,
                    hasLt ? "MATCH" : "MISSING",
                    hasLt ? `Defined (${tgtLtypes[ltypeName]?.description || "Solid"})` : "— (Missing in Target)",
                    `Defined (${lt.description || "Solid"})`,
                    hasLt ? "pass" : "warning",
                    hasLt ? "Standard linetype definition exists in target." : `Template linetype "${ltypeName}" definition missing.`
                );
            }

            // 4. Text Styles comparison
            const tplStyles = templateParsed.styles || {};
            const tgtStyles = targetParsed.styles || {};
            for (const [styleName, st] of Object.entries(tplStyles)) {
                const tgtSt = tgtStyles[styleName];
                if (!tgtSt) {
                    addRow(
                        "Text Style",
                        styleName,
                        "MISSING",
                        "— (Missing in Target)",
                        `Font: ${st.font || "Standard"}`,
                        "warning",
                        `Template text style "${styleName}" is missing from target drawing.`
                    );
                } else {
                    const fontMatch = !st.font || (tgtSt.font || "").toLowerCase() === (st.font || "").toLowerCase();
                    addRow(
                        "Text Style",
                        styleName,
                        fontMatch ? "MATCH" : "MISMATCH",
                        `Font: ${tgtSt.font || "Standard"}`,
                        `Font: ${st.font || "Standard"}`,
                        fontMatch ? "pass" : "warning",
                        fontMatch ? "Text style font and properties conform." : `Font difference (Target: ${tgtSt.font}, Template: ${st.font}).`
                    );
                }
            }

            // 5. Blocks comparison
            const tplBlocks = templateParsed.blocks || {};
            const tgtBlocks = targetParsed.blocks || {};
            for (const blockName of Object.keys(tplBlocks)) {
                const hasBlk = !!tgtBlocks[blockName];
                addRow(
                    "Block",
                    blockName,
                    hasBlk ? "MATCH" : "MISSING",
                    hasBlk ? "Defined in Target" : "— (Missing in Target)",
                    "Defined in Template",
                    hasBlk ? "pass" : "info",
                    hasBlk ? "Template block definition present in target." : `Template block definition "${blockName}" missing.`
                );
            }

            // 6. Geometry diff check
            if ((targetParsed.entities || []).length > 0 && (templateParsed.entities || []).length > 0) {
                try {
                    const gdiff = E().diffGeometry(templateParsed, targetParsed);
                    if (gdiff.modified && gdiff.modified.length > 0) {
                        gdiff.modified.slice(0, 15).forEach(m => {
                            const changeDetails = m.changes.map(c => `${c.field}: ${c.from} -> ${c.to}`).join("; ");
                            addRow(
                                "Geometry",
                                `${m.type} on ${m.layer}`,
                                "MISMATCH",
                                "Modified Entity",
                                "Reference Geometry",
                                "warning",
                                changeDetails || "Entity coordinates or geometry parameters shifted."
                            );
                        });
                    }
                    if (gdiff.added && gdiff.added.length > 0) {
                        gdiff.added.slice(0, 15).forEach(a => {
                            addRow(
                                "Geometry",
                                `${a.type} on ${a.layer}`,
                                "MISMATCH",
                                "Added entity",
                                "—",
                                "info",
                                `New entity found on layer "${a.layer}".`
                            );
                        });
                    }
                    if (gdiff.summary && gdiff.summary.identical) {
                        addRow(
                            "Geometry",
                            "All Entities",
                            "MATCH",
                            `${(targetParsed.entities || []).length} entities`,
                            `${(templateParsed.entities || []).length} entities`,
                            "pass",
                            "Drawing geometry matches template reference identically."
                        );
                    }
                } catch (_) {}
            }

            // 7. Auto-correct check
            try {
                const healed = E().healDxf(targetText, templateText);
                if (healed && healed.healedDxf) {
                    gridState.lastHealedDxf = healed.healedDxf;
                    const autoFixBtn = $("btn-grid-auto-fix");
                    if (autoFixBtn) {
                        autoFixBtn.style.display = "inline-flex";
                        window.setSafeHTML(autoFixBtn, `<i class="fa-solid fa-wand-magic-sparkles"></i> Download Auto-Corrected DXF (${healed.summary.healed} fixed)`);
                    }
                }
            } catch (_) {}

        } else {
            let isJsonTemplate = false;
            let jsonStd = null;
            try {
                jsonStd = JSON.parse(templateText);
                if (jsonStd && (jsonStd.layers || jsonStd.name)) isJsonTemplate = true;
            } catch (_) {}

            if (isTargetDxf && isJsonTemplate) {
                try {
                    const checkResult = E().checkStandards(targetParsed, jsonStd);
                    (checkResult.violations || []).forEach(v => {
                        const isMissing = v.code.includes("MISSING");
                        addRow(
                            "Standard Check",
                            v.layer || v.rule || v.code,
                            isMissing ? "MISSING" : "MISMATCH",
                            v.actual != null ? String(v.actual) : "Violated",
                            v.expected != null ? String(v.expected) : "Standard Spec",
                            v.severity || (isMissing ? "error" : "warning"),
                            v.message || `Standard check violation: ${v.code}`
                        );
                    });
                    if (checkResult.summary?.passed) {
                        addRow("Standard Check", jsonStd.name || "JSON Standard", "MATCH", "Passed", "Standard Spec", "pass", "Drawing passed all standard checks.");
                    }
                } catch (e) {
                    addRow("Standard Check", "JSON Validation", "MISMATCH", "Error", "Standard Spec", "error", e.message);
                }
            } else {
                const tgtLines = targetText.split(/\r?\n/).filter(l => l.trim().length > 0);
                const tplLines = templateText.split(/\r?\n/).filter(l => l.trim().length > 0);
                const lineCountMatch = tgtLines.length === tplLines.length;
                addRow(
                    "Text Structure",
                    "Line Count",
                    lineCountMatch ? "MATCH" : "MISMATCH",
                    `${tgtLines.length} lines`,
                    `${tplLines.length} lines`,
                    lineCountMatch ? "pass" : "warning",
                    lineCountMatch ? "Line count matches." : "Target line count differs from Template standard."
                );

                const sampleLimit = Math.min(10, Math.max(tgtLines.length, tplLines.length));
                for (let i = 0; i < sampleLimit; i++) {
                    const tl = tgtLines[i] || "";
                    const pl = tplLines[i] || "";
                    const m = tl === pl;
                    addRow(
                        "Line Record",
                        `Line #${i + 1}`,
                        m ? "MATCH" : "MISMATCH",
                        tl || "— (Missing)",
                        pl || "— (Missing)",
                        m ? "pass" : "warning",
                        m ? "Line matches template." : "Content difference at line."
                    );
                }
            }
        }

        gridState.results = items;
        renderResultsGrid();

        const gridCard = $("compare-grid-card");
        if (gridCard) {
            gridCard.style.display = "block";
            gridCard.scrollIntoView?.({ behavior: "smooth" });
        }

        const matches = items.filter(r => r.status === "MATCH").length;
        const mismatches = items.filter(r => r.status === "MISMATCH").length;
        const missing = items.filter(r => r.status === "MISSING").length;

        if (statusMsg) {
            statusMsg.textContent = `Comparison complete: ${items.length} items evaluated (${matches} matches, ${mismatches} mismatches, ${missing} missing).`;
        }
        ctx.showToast(`Comparison complete: ${items.length} items evaluated.`);
    }

    function loadDemoPair(ctx) {
        ctx = ctx || { showToast() {} };
        setTargetFile("Demo_Target_Corridor.dxf", SAMPLES.target);
        setTemplateFile("Demo_FDOT_Master_Template.dxf", SAMPLES.master);
        const statusMsg = $("compare-status-msg");
        if (statusMsg) statusMsg.textContent = "Demo Target and Template files loaded. Click Execute to compare.";
        ctx.showToast("Demo Target and Template loaded. Click Execute.");
    }

    function resetGridUI(ctx) {
        ctx = ctx || { showToast() {} };
        gridState.targetFile = null;
        gridState.templateFile = null;
        gridState.results = [];
        gridState.activeFilter = "all";
        gridState.searchTerm = "";
        gridState.lastHealedDxf = null;

        const targetText = $("target-file-text");
        if (targetText) targetText.value = "";
        const targetInput = $("target-file-input");
        if (targetInput) targetInput.value = "";
        const targetMeta = $("target-file-meta");
        if (targetMeta) targetMeta.textContent = "";

        const templateText = $("template-file-text");
        if (templateText) templateText.value = "";
        const templateInput = $("template-file-input");
        if (templateInput) templateInput.value = "";
        const templateMeta = $("template-file-meta");
        if (templateMeta) templateMeta.textContent = "";

        const statusMsg = $("compare-status-msg");
        if (statusMsg) statusMsg.textContent = "Ready. Select Target and Template files, then click Execute.";

        const gridCard = $("compare-grid-card");
        if (gridCard) gridCard.style.display = "none";

        const autoFixBtn = $("btn-grid-auto-fix");
        if (autoFixBtn) autoFixBtn.style.display = "none";

        ctx.showToast("Comparison inputs reset.");
    }

    function exportGridCsv(ctx) {
        ctx = ctx || { showToast() {} };
        if (!gridState.results || gridState.results.length === 0) {
            ctx.showToast("No comparison records to export.", true);
            return;
        }
        const headers = ["Index", "Category", "Item_Name", "Status", "Target_Value", "Template_Value", "Severity", "Diagnostic_Details"];
        const escapeCsv = val => `"${String(val ?? "").replace(/"/g, '""')}"`;
        const rows = [headers.join(",")];
        gridState.results.forEach((r, idx) => {
            rows.push([
                idx + 1,
                escapeCsv(r.category),
                escapeCsv(r.name),
                escapeCsv(r.status),
                escapeCsv(r.targetVal),
                escapeCsv(r.templateVal),
                escapeCsv(r.severity),
                escapeCsv(r.details)
            ].join(","));
        });
        const csvData = rows.join("\r\n");
        const filename = `Comparison_${(gridState.targetFile?.name || "target").replace(/\.[^.]+$/, "")}_vs_${(gridState.templateFile?.name || "template").replace(/\.[^.]+$/, "")}.csv`;
        if (window.COGO && window.COGO.downloadText) {
            window.COGO.downloadText(filename, csvData, "text/csv");
        } else {
            const blob = new Blob([csvData], { type: "text/csv;charset=utf-8;" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
        }
        ctx.showToast(`Exported ${gridState.results.length} rows to ${filename}.`);
    }

    function sendGridToReports(ctx) {
        ctx = ctx || { showToast() {} };
        if (!gridState.results || gridState.results.length === 0) {
            ctx.showToast("No comparison results to send.", true);
            return;
        }
        const summary = {
            total: gridState.results.length,
            matches: gridState.results.filter(r => r.status === "MATCH").length,
            mismatches: gridState.results.filter(r => r.status === "MISMATCH").length,
            missing: gridState.results.filter(r => r.status === "MISSING").length,
            score: $("grid-stat-score")?.textContent || "100%",
        };
        const repName = `Comparison: ${gridState.targetFile?.name || "Target"} vs ${gridState.templateFile?.name || "Template"}`;
        if (window.Reports && typeof window.Reports.addReport === "function") {
            window.Reports.addReport({
                id: "cmp-" + Date.now(),
                type: "standards-compare",
                category: "standards",
                title: repName,
                date: new Date().toISOString(),
                status: summary.mismatches > 0 || summary.missing > 0 ? "Flagged" : "Compliant",
                score: summary.score,
                details: `Evaluated ${summary.total} items (${summary.matches} matches, ${summary.mismatches} mismatches, ${summary.missing} missing).`,
                items: gridState.results
            });
            ctx.showToast("Comparison report saved to Reports Hub.");
        } else {
            ctx.showToast("Comparison report captured.");
        }
    }

    function downloadAutoCorrectedDxf(ctx) {
        ctx = ctx || { showToast() {} };
        if (!gridState.lastHealedDxf) {
            if (gridState.targetFile?.text && gridState.templateFile?.text) {
                try {
                    const healed = E().healDxf(gridState.targetFile.text, gridState.templateFile.text);
                    gridState.lastHealedDxf = healed.healedDxf;
                } catch (err) {
                    ctx.showToast("Auto-correct failed: " + err.message, true);
                    return;
                }
            }
        }
        if (gridState.lastHealedDxf) {
            const outName = (gridState.targetFile?.name || "drawing").replace(/\.dxf$/i, "") + ".corrected.dxf";
            if (window.COGO && window.COGO.downloadText) {
                window.COGO.downloadText(outName, gridState.lastHealedDxf, "application/dxf");
            }
            ctx.showToast(`Downloaded auto-corrected drawing: ${outName}.`);
        } else {
            ctx.showToast("No corrected drawing available.", true);
        }
    }

    // ── Plugin ──────────────────────────────────────────────────────────────

    const Plugin = {
        init() {
            renderControls();
            if ($("target-file-text") && !gridState.targetFile && state.files.target) {
                setTargetFile(state.files.target.name, state.files.target.text);
            }
            if ($("template-file-text") && !gridState.templateFile && (state.files.master || state.files.standard)) {
                const tpl = state.files.master || state.files.standard;
                setTemplateFile(tpl.name, tpl.text);
            }
        },
        onTabActivate() {
            renderControls();
            if (state.lastReport || state.lastHeal) renderResults({ showToast() {} });
            if (gridState.results && gridState.results.length > 0) renderResultsGrid();
        },

        setupEvents(ctx) {
            const root = $("tab-stdn-compare");
            if (!root) return;

            // Delegated clicks for the dynamically-rendered controls + results + grid.
            root.addEventListener("click", e => {
                if (e.target.id === "target-file-text") { $("target-file-input")?.click(); return; }
                if (e.target.id === "template-file-text") { $("template-file-input")?.click(); return; }

                const filterBtn = e.target.closest("[data-grid-filter]");
                if (filterBtn) {
                    const f = filterBtn.getAttribute("data-grid-filter");
                    gridState.activeFilter = f;
                    root.querySelectorAll("#grid-filter-pills .pill-btn").forEach(b => b.classList.toggle("active", b === filterBtn));
                    renderResultsGrid();
                    return;
                }

                const t = e.target.closest("button, [data-slot]");
                if (!t) return;
                const id = t.id;

                // Home Page Target & Template Execute & Grid actions
                if (id === "btn-compare-demo") { loadDemoPair(ctx); return; }
                if (id === "btn-compare-clear") { resetGridUI(ctx); return; }
                if (id === "btn-compare-execute") { executeGridComparison(ctx); return; }
                if (id === "btn-browse-target") { $("target-file-input")?.click(); return; }
                if (id === "btn-browse-template") { $("template-file-input")?.click(); return; }
                if (id === "btn-grid-export-csv") { exportGridCsv(ctx); return; }
                if (id === "btn-grid-to-reports") { sendGridToReports(ctx); return; }
                if (id === "btn-grid-auto-fix") { downloadAutoCorrectedDxf(ctx); return; }

                // Existing engine actions
                if (id === "stdn-mode-check" && state.mode !== "check") { state.mode = "check"; renderControls(); return; }
                if (id === "stdn-mode-heal" && state.mode !== "heal") { state.mode = "heal"; renderControls(); return; }
                if (id === "stdn-run") { state.mode === "heal" ? runHeal(ctx) : runCheck(ctx); return; }
                if (id === "stdn-clear") {
                    state.files = { target: null, reference: null, master: null, standard: null };
                    state.lastReport = state.lastHeal = null;
                    renderControls();
                    const rb = $("stdn-results"); if (rb) { rb.classList.add("hidden"); window.setSafeHTML(rb, ""); }
                    return;
                }
                if (id === "stdn-sample-check") {
                    state.mode = "check";
                    state.files.target = { name: "target.dxf", text: SAMPLES.target };
                    state.files.reference = { name: "reference.dxf", text: SAMPLES.reference };
                    state.files.master = { name: "master.dxf", text: SAMPLES.master };
                    state.files.standard = null; state.useCustomStandard = false;
                    state.standardId = "example-standard";
                    renderControls(); ctx.showToast("Loaded the check sample (target + reference + master).");
                    return;
                }
                if (id === "stdn-sample-heal") {
                    state.mode = "heal";
                    state.files.target = { name: "messy.dxf", text: SAMPLES.messy };
                    state.files.master = { name: "master.dxf", text: SAMPLES.master };
                    renderControls(); ctx.showToast("Loaded the auto-correct sample (messy target + master template).");
                    return;
                }
                if (id === "stdn-hero-drainage-demo") {
                    const samples = window.__dxfSamples || {};
                    const nonCompliant = samples.NONCOMPLIANT_DXF || SAMPLES.messy;
                    state.mode = "check";
                    state.files.target = { name: "fdot_drain.dxf", text: nonCompliant };
                    state.files.reference = null;
                    state.files.master = null;
                    state.files.standard = null;
                    state.useCustomStandard = false;
                    state.standardId = "fdot-2026";
                    renderControls();
                    runCheck(ctx);
                    $("stdn-results")?.scrollIntoView?.({ behavior: "smooth" });
                    return;
                }
                if (id === "stdn-hero-sr50-demo") {
                    const samples = window.__dxfSamples || {};
                    const sr50 = samples.SR50_DXF || SAMPLES.target;
                    state.mode = "check";
                    state.files.target = { name: "fdot_sr50.dxf", text: sr50 };
                    state.files.reference = null;
                    state.files.master = null;
                    state.files.standard = null;
                    state.useCustomStandard = false;
                    state.standardId = "fdot-2026";
                    renderControls();
                    runCheck(ctx);
                    $("stdn-results")?.scrollIntoView?.({ behavior: "smooth" });
                    return;
                }
                if (id === "stdn-cert-btn") {
                    const rep = state.lastReport?.data;
                    const heal = state.lastHeal?.data;
                    const target = state.files.target;
                    const filename = target ? target.name : "FDOT_Submittal_Drawing.dxf";
                    const content = target ? target.text : "";
                    const violationsCount = rep?.standardsCheck?.violations?.length ?? (heal ? heal.summary.unresolved : 0);
                    // A stated, reproducible rule (100 − 10/error − 2/warning) from the standards check
                    // that actually ran — or "not scored" when none ran. No synthesized 90/100/60 fallback.
                    const sc = rep?.standardsCheck?.summary;
                    const score = sc ? Math.max(0, 100 - 10 * sc.errors - 2 * sc.warnings) : null;
                    
                    if (window.BoundaryQCSecurity) {
                        window.BoundaryQCSecurity.generateSubmittalCertificate({
                            filename,
                            content,
                            score,
                            violationsCount,
                            scoreBasis: sc ? "100 − 10 per error − 2 per warning (standards check)" : null,
                            layersCount: null,
                            entitiesCount: rep?.meta?.targetEntityCount ?? null,
                            standardName: "FDOT 2026 CADD State Kit Standard",
                            autoHealReady: Boolean(heal || (rep && !rep.overall.passed))
                        }).then(cert => {
                            if (ctx.showSubmittalCertificateModal) {
                                ctx.showSubmittalCertificateModal(cert);
                            } else if (window.showSubmittalCertificateModal) {
                                window.showSubmittalCertificateModal(cert);
                            }
                        });
                    }
                    return;
                }
                if (id === "stdn-report-html") { exportReport("html", ctx); return; }
                if (id === "stdn-report-md") { exportReport("markdown", ctx); return; }
                if (id === "stdn-download-healed" && state.lastHeal) {
                    const out = (state.lastHeal.targetName || "drawing").replace(/\.dxf$/i, "") + ".corrected.dxf";
                    window.COGO.downloadText(out, state.lastHeal.data.healedDxf, "application/dxf");
                    ctx.showToast(`Downloaded ${out}.`);
                    return;
                }

                const clearKey = t.getAttribute("data-slot-clear");
                if (clearKey) { state.files[clearKey] = null; renderControls(); return; }

                const slotDiv = t.matches("[data-slot]") ? t : t.closest("[data-slot]");
                if (slotDiv) {
                    const key = slotDiv.getAttribute("data-slot");
                    root.querySelector(`[data-slot-input="${key}"]`)?.click();
                    return;
                }

                const sev = t.getAttribute("data-sev");
                if (sev && state.lastReport && state.lastReport.data.standardsCheck) {
                    root.querySelectorAll("#stdn-viol-filter .pill-btn").forEach(b => b.classList.toggle("active", b === t));
                    const all = state.lastReport.data.standardsCheck.violations;
                    const list = sev === "all" ? all : all.filter(v => v.severity === sev);
                    window.setSafeHTML($("stdn-viol-body"), violationsTable(list));
                    return;
                }
            });

            root.addEventListener("change", e => {
                const fi = e.target.closest("[data-slot-input]");
                if (fi) {
                    const key = fi.getAttribute("data-slot-input");
                    const f = fi.files && fi.files[0];
                    if (f) acceptFile(key, f, ctx);
                    fi.value = "";
                    return;
                }
                if (e.target.id === "target-file-input") {
                    const f = e.target.files && e.target.files[0];
                    if (f) handleFileInput("target", f, ctx);
                    e.target.value = "";
                    return;
                }
                if (e.target.id === "template-file-input") {
                    const f = e.target.files && e.target.files[0];
                    if (f) handleFileInput("template", f, ctx);
                    e.target.value = "";
                    return;
                }
                if (e.target.id === "stdn-use-custom") { state.useCustomStandard = e.target.checked; renderControls(); return; }
                if (e.target.id === "stdn-std-select") { state.standardId = e.target.value; return; }
                if (e.target.id === "stdn-heal-blocks") { state.healBlocks = e.target.checked; return; }
            });

            // Search filter input for grid
            const searchInp = $("grid-search-input");
            if (searchInp) {
                searchInp.addEventListener("input", e => {
                    gridState.searchTerm = e.target.value;
                    renderResultsGrid();
                });
            }

            // Drag & drop onto a slot or Target/Template textboxes.
            const setupDrop = (el, type) => {
                if (!el) return;
                el.addEventListener("dragover", e => {
                    e.preventDefault();
                    el.style.borderColor = "var(--primary)";
                });
                el.addEventListener("dragleave", () => {
                    el.style.borderColor = "var(--border-subtle)";
                });
                el.addEventListener("drop", e => {
                    e.preventDefault();
                    el.style.borderColor = "var(--border-subtle)";
                    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                    if (f) handleFileInput(type, f, ctx);
                });
            };
            setupDrop($("target-file-text"), "target");
            setupDrop($("template-file-text"), "template");

            root.addEventListener("dragover", e => { const s = e.target.closest("[data-slot]"); if (s) { e.preventDefault(); s.style.borderColor = "var(--primary)"; } });
            root.addEventListener("dragleave", e => { const s = e.target.closest("[data-slot]"); if (s) s.style.borderColor = "var(--border-accent)"; });
            root.addEventListener("drop", e => {
                const s = e.target.closest("[data-slot]");
                if (!s) return;
                e.preventDefault();
                s.style.borderColor = "var(--border-accent)";
                const f = e.dataTransfer.files && e.dataTransfer.files[0];
                if (f) acceptFile(s.getAttribute("data-slot"), f, ctx);
            });
        },
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);

    // Exposed for console debugging / tests.
    window.StdnCompare = {
        state,
        gridState,
        SAMPLES,
        runCheck,
        runHeal,
        executeGridComparison,
        renderResultsGrid,
        loadDemoPair,
        resetGridUI,
        setTargetFile,
        setTemplateFile,
    };
})();
