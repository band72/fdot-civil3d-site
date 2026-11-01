/**
 * Plugin: tables (Civil 3D Tables/Styles Drawing Auditor)
 * plugins/tables/tables.js
 *
 * Audits a DXF's LAYER table with no requirement that it also have entities —
 * for a Civil 3D "tables" drawing that carries only LAYER/LINETYPE/STYLE
 * definitions plus block/dictionary bookkeeping, or one converted from a DWG
 * whose real geometry didn't make it across (see below), that's the only
 * content there is to check. That doesn't fit the DXF Project Auditor's
 * geometry checks (bow-tie, zero-length, closure: all need entities) or a
 * full Standards Compare run (which wants a reference drawing to diff
 * geometry against). What it DOES have is a real layer table to check, which
 * is exactly what both of those plugins' shared engines already do without
 * needing any entities:
 *   - window.FDOTDXFInspector (plugins/dxf-auditor/dxf-parser.js) — layer
 *     naming/CADD-standards issues (non-FDOT prefixes, Defpoints usage, ...)
 *   - window.StdnEngine.orchestrateCompare (plugins/stdn-compare/stdn-engine.js)
 *     — a formal layer-by-layer diff against the built-in FDOT 2026 standard
 * This plugin doesn't reimplement either — it's a thin front end that feeds
 * a tables-only DXF to both and presents the combined result, the same way
 * plugins/batchprocess/batchprocess.js runs a file through more than one
 * existing engine rather than being a third one.
 *
 * The bundled sample is a real Civil 3D "Tables.dwg" as-built utility layer
 * set (22 layers: __As-Built Water/Text, TEXTM, V-NODE-* survey-verification
 * nodes, -AS BUILT WM, __ASB FORCEMAIN, ...) — converted with
 * scripts/dwg2dxf.sh, then reduced to just its LAYER table. Worth knowing:
 * that source file is NOT actually entity-free — it's a 29-block utility
 * symbol library (Wire Box, Benchmark, Catch Basin, Gas Valve, ...) with 300+
 * real LINE/CIRCLE/TEXT/etc. entities nested inside those blocks. LibreDWG's
 * own `dwg2dxf` silently dropped all of them (fixed in
 * scripts/dwg_json_to_dxf.py, which scripts/dwg2dxf.sh now runs as a
 * recovery pass) — but even with that fixed, this app's shared DXF parsers
 * (FDOTDXFInspector, StdnEngine) only read the top-level ENTITIES section,
 * not BLOCKS, so block-nested geometry still won't surface as "entities"
 * here. This plugin's layer-table audit is accurate either way; it just
 * isn't the tool for auditing what's drawn *inside* a block definition.
 *
 * Registers via window.PluginRegistry. Depends on nothing at load time —
 * FDOTDXFInspector and StdnEngine are checked for at call time, same
 * defensive pattern as plugins/batchprocess/batchprocess.js.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "tables",
        version: "1.0.0",
        description: "Audits a Civil 3D tables/styles-only drawing (layer/linetype/style definitions, no entities) against FDOT CADD layer standards.",
        tab: "tab-tables",
        icon: "fa-table-list",
        tier: "Free",
        dependencies: []
    };

    const clean = window.cleanText; // core/safe-dom.js

    function notify(ctx, msg, isWarn = false) {
        if (ctx && typeof ctx.showToast === "function") ctx.showToast(msg, isWarn);
    }

    // ── Bundled sample: the real layer table from Tables.dwg -> Tables.dxf ──
    // (scripts/dwg2dxf.sh), reduced to just the LAYER table entries actually
    // present in that file — names, ACI colors, and linetypes are real, not
    // invented. See the header comment above for what this drawing actually is.
    const SAMPLE_TABLES_DXF = [
        "  0", "SECTION", "  2", "HEADER", "  9", "$ACADVER", "  1", "AC1015",
        "  9", "$INSUNITS", " 70", "2", "  0", "ENDSEC",
        "  0", "SECTION", "  2", "TABLES", "  0", "TABLE", "  2", "LAYER", " 70", "22",
        ...[
            ["0", 0, 7, "Continuous"],
            ["__As-Built Water", 0, 5, "Continuous"],
            ["__As-Built Text", 0, 4, "Continuous"],
            ["Defpoints", 1, 7, "Continuous"],
            ["TEXTM", 0, 2, "Continuous"],
            ["V-NODE", 0, 252, "Continuous"],
            ["V-NODE-TEXT", 0, 252, "Continuous"],
            ["V-CTRL-BMRK", 0, 252, "Continuous"],
            ["V-NODE-BNDY", 0, 252, "Continuous"],
            ["V-NODE-STRM", 0, 252, "Continuous"],
            ["V-NODE-BORE", 0, 252, "Continuous"],
            ["V-NODE-NGAS", 0, 252, "Continuous"],
            ["V-NODE-POLE", 0, 252, "Continuous"],
            ["V-CTRL-HCPT", 0, 252, "Continuous"],
            ["-AS BUILT WM", 0, 5, "Continuous"],
            ["V-NODE-WATR", 0, 252, "Continuous"],
            ["V-NODE-SSWR", 0, 252, "Continuous"],
            ["V-NODE-TREE", 0, 252, "Continuous"],
            ["V-NODE-SIGN", 0, 252, "Continuous"],
            ["V-CTRL-VCPT", 0, 252, "Continuous"],
            ["__ASB UNUSED", 0, 4, "Continuous"],
            ["__ASB FORCEMAIN", 0, 4, "Continuous"],
        ].flatMap(([name, flag, color, ltype]) =>
            ["  0", "LAYER", "  2", name, " 70", String(flag), " 62", String(color), "  6", ltype]),
        "  0", "ENDTAB", "  0", "ENDSEC",
        "  0", "SECTION", "  2", "ENTITIES", "  0", "ENDSEC",
        "  0", "EOF"
    ].join("\n") + "\n";

    // ── Audit ─────────────────────────────────────────────────────────────

    /**
     * Run a tables-only DXF through both shared engines and combine the result.
     * @param {string} dxfText
     * @returns {{ inspector: object|null, standards: object|null, layerCount: number, entityCount: number, errors: string[] }}
     */
    function auditTables(dxfText) {
        const result = { inspector: null, standards: null, layerCount: 0, entityCount: 0, errors: [] };

        if (window.FDOTDXFInspector && window.FDOT_DATA) {
            try {
                const insp = new window.FDOTDXFInspector(window.FDOT_DATA);
                const parsed = insp.parseDXF(dxfText);
                result.inspector = insp.inspectProject(parsed);
                result.layerCount = (parsed.layers || []).length;
                result.entityCount = (parsed.entities || []).length;
            } catch (e) {
                result.errors.push(`DXF Project Auditor: ${e.message}`);
            }
        } else {
            result.errors.push("FDOTDXFInspector is not loaded.");
        }

        if (window.StdnEngine && typeof window.StdnEngine.orchestrateCompare === "function") {
            try {
                result.standards = window.StdnEngine.orchestrateCompare({
                    targetText: dxfText,
                    targetFileName: "tables.dxf",
                    standardId: "fdot-2026"
                });
            } catch (e) {
                result.errors.push(`Standards Compare: ${e.message}`);
            }
        } else {
            result.errors.push("StdnEngine is not loaded.");
        }

        return result;
    }

    function getSampleTablesDxf() { return SAMPLE_TABLES_DXF; }

    /** Register the combined result with the Reports Hub, if it's loaded. */
    function exportToReports(result, filename) {
        if (!window.Reports || typeof window.Reports.addReport !== "function" || !result) return null;

        const insp = result.inspector;
        const std = result.standards && result.standards.standardsCheck;
        const lines = [
            `# Tables Drawing Audit${filename ? ` — ${filename}` : ""}`,
            `Generated: ${new Date().toISOString()}`,
            `Layers: ${result.layerCount}  ·  Entities: ${result.entityCount}`,
            ""
        ];
        if (insp) {
            lines.push(`## CADD Standards (DXF Project Auditor) — score ${insp.score}%`);
            (insp.issues || []).forEach(i => lines.push(`- [${i.severity}] **${i.title}** (\`${i.layer || "—"}\`): ${i.description}`));
            if (!insp.issues || !insp.issues.length) lines.push("- No issues found.");
            lines.push("");
        }
        if (std) {
            lines.push(`## FDOT 2026 Layer Standard — ${std.summary.passed ? "PASSED" : "FAILED"}`);
            (std.violations || []).forEach(v => lines.push(`- [${v.severity}] **${v.code}**: ${v.message}`));
            if (!std.violations || !std.violations.length) lines.push("- No violations found.");
        }

        return window.Reports.addReport({
            title: `Tables Drawing Audit${filename ? ` — ${filename}` : ""}`,
            type: "tables-audit",
            category: "dxf",
            format: "markdown",
            content: lines.join("\n"),
            metadata: {
                score: insp ? insp.score : null,
                standardsPassed: std ? std.summary.passed : null,
                layerCount: result.layerCount,
                entityCount: result.entityCount
            }
        });
    }

    // ── UI ────────────────────────────────────────────────────────────────

    let _lastResult = null;
    let _lastFilename = null;

    function severityColor(sev) {
        const s = String(sev || "").toUpperCase();
        if (s === "CRITICAL" || s === "ERROR") return "var(--danger, #dc2626)";
        if (s === "HIGH" || s === "WARNING") return "var(--warning, #b45309)";
        return "var(--text-secondary)";
    }

    function renderUI(ctx) {
        const root = document.getElementById("tables-controls");
        if (!root) return;

        window.setSafeHTML(root, `
            <div class="glass-panel" style="padding:1.25rem; margin-top:1rem;">
                <h3 style="font-size:1.1rem; margin-bottom:0.25rem;"><i class="fa-solid fa-table-list" style="color:var(--primary);"></i> Tables / Styles Drawing Auditor</h3>
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:1rem;">
                    For a Civil 3D drawing that carries only layer/linetype/style/table definitions and
                    no drawn geometry — the bow-tie and closure checks elsewhere in this app need
                    entities, but the layer table can still be audited against FDOT CADD standards on
                    its own.
                </p>
                <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:0.75rem;">
                    <button class="btn btn-secondary btn-sm" id="tables-btn-sample"><i class="fa-solid fa-vial"></i> Load Sample (Tables.dwg)</button>
                    <label class="btn btn-secondary btn-sm" style="cursor:pointer; margin:0;">
                        <i class="fa-solid fa-file-arrow-up"></i> Upload DXF
                        <input type="file" id="tables-file-input" accept=".dxf" style="display:none;">
                    </label>
                    <button class="btn btn-primary btn-sm" id="tables-btn-audit"><i class="fa-solid fa-play"></i> Run Audit</button>
                    <button class="btn btn-secondary btn-sm" id="tables-btn-report" disabled><i class="fa-solid fa-clipboard-check"></i> Send to Reports Hub</button>
                </div>
                <textarea id="tables-input" aria-label="Tables-only DXF text" rows="8" placeholder="Paste a tables-only DXF, or load the sample / upload a file..." style="width:100%; box-sizing:border-box; font-family:var(--font-mono); font-size:0.78rem; padding:0.65rem; background:var(--bg-secondary); border:1px solid var(--glass-border); border-radius:var(--radius-sm); color:var(--text-primary);"></textarea>
            </div>

            <div id="tables-results" class="glass-panel hidden" style="padding:1.25rem; margin-top:1rem;"></div>
        `);

        bindEvents(ctx);
    }

    function bindEvents(ctx) {
        const root = document.getElementById("tables-controls");
        if (!root) return;
        const input = () => document.getElementById("tables-input");

        root.querySelector("#tables-btn-sample")?.addEventListener("click", () => {
            const ta = input();
            if (ta) ta.value = SAMPLE_TABLES_DXF;
            notify(ctx, "Loaded the Tables.dwg sample layer table.");
        });

        root.querySelector("#tables-file-input")?.addEventListener("change", async e => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const text = await file.text();
            const ta = input();
            if (ta) ta.value = text;
            _lastFilename = file.name;
            notify(ctx, `Loaded ${file.name}.`);
        });

        root.querySelector("#tables-btn-audit")?.addEventListener("click", () => {
            const text = (input()?.value || "").trim();
            if (!text) { notify(ctx, "Paste, upload, or load the sample DXF first.", true); return; }
            _lastResult = auditTables(text);
            renderResults(_lastResult);
            const reportBtn = document.getElementById("tables-btn-report");
            if (reportBtn) reportBtn.disabled = false;
            if (_lastResult.errors.length) notify(ctx, _lastResult.errors.join(" "), true);
            else notify(ctx, "Audit complete.");
        });

        document.getElementById("tables-btn-report")?.addEventListener("click", () => {
            if (!_lastResult) return;
            const rep = exportToReports(_lastResult, _lastFilename);
            notify(ctx, rep ? "Sent to Reports Hub." : "Reports Hub is not loaded.", !rep);
        });
    }

    function renderResults(result) {
        const box = document.getElementById("tables-results");
        if (!box) return;
        box.classList.remove("hidden");

        const insp = result.inspector;
        const std = result.standards && result.standards.standardsCheck;

        let html = `<div style="display:flex; gap:1.5rem; flex-wrap:wrap; margin-bottom:1rem; font-size:0.85rem;">
            <div><strong>${result.layerCount}</strong> layers</div>
            <div><strong>${result.entityCount}</strong> entities</div>
            ${insp ? `<div>CADD score: <strong style="color:${insp.score >= 85 ? 'var(--success,#059669)' : insp.score >= 60 ? 'var(--warning,#b45309)' : 'var(--danger,#dc2626)'};">${insp.score}%</strong></div>` : ""}
            ${std ? `<div>FDOT 2026 standard: <strong style="color:${std.summary.passed ? 'var(--success,#059669)' : 'var(--danger,#dc2626)'};">${std.summary.passed ? "PASSED" : "FAILED"}</strong></div>` : ""}
        </div>`;

        if (result.errors.length) {
            html += `<div style="color:var(--danger,#dc2626); font-size:0.82rem; margin-bottom:0.75rem;">${result.errors.map(clean).join("<br>")}</div>`;
        }

        if (insp && insp.issues && insp.issues.length) {
            html += `<h4 style="font-size:0.9rem; margin:0.5rem 0;">CADD Standards Issues</h4>
                <table style="width:100%; border-collapse:collapse; font-size:0.78rem; margin-bottom:1rem;"><tbody>
                ${insp.issues.map(i => `
                    <tr style="border-bottom:1px solid var(--glass-border);">
                        <td style="padding:0.35rem 0.5rem; color:${severityColor(i.severity)}; white-space:nowrap;">${clean(i.severity)}</td>
                        <td style="padding:0.35rem 0.5rem; font-family:var(--font-mono); white-space:nowrap;">${clean(i.layer || "—")}</td>
                        <td style="padding:0.35rem 0.5rem;">${clean(i.title)} — ${clean(i.description)}</td>
                    </tr>
                `).join("")}
                </tbody></table>`;
        } else if (insp) {
            html += `<p style="font-size:0.82rem; color:var(--success,#059669);">No CADD-standards issues found.</p>`;
        }

        if (std && std.violations && std.violations.length) {
            html += `<h4 style="font-size:0.9rem; margin:0.5rem 0;">FDOT 2026 Layer Standard Violations</h4>
                <table style="width:100%; border-collapse:collapse; font-size:0.78rem;"><tbody>
                ${std.violations.map(v => `
                    <tr style="border-bottom:1px solid var(--glass-border);">
                        <td style="padding:0.35rem 0.5rem; color:${severityColor(v.severity)}; white-space:nowrap;">${clean(v.severity)}</td>
                        <td style="padding:0.35rem 0.5rem; font-family:var(--font-mono); white-space:nowrap;">${clean(v.code)}</td>
                        <td style="padding:0.35rem 0.5rem;">${clean(v.message)}</td>
                    </tr>
                `).join("")}
                </tbody></table>`;
        } else if (std) {
            html += `<p style="font-size:0.82rem; color:var(--success,#059669);">No layer-standard violations found.</p>`;
        }

        window.setSafeHTML(box, html);
    }

    // ── Plugin Object & Public API ───────────────────────────────────────

    const Plugin = {
        init(ctx) { renderUI(ctx); },
        onTabActivate(ctx) { renderUI(ctx); }
    };

    window.Tables = {
        auditTables,
        getSampleTablesDxf,
        exportToReports,
        getLastResult: () => _lastResult
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);
})();
