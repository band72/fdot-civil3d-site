/**
 * Plugin: batchprocess (Multi-Sheet Batch Project Auditor)
 * plugins/batchprocess/batchprocess.js
 *
 * Implements multi-sheet batch processing, compliance matrix grading,
 * master submittal report generation, and consolidated AutoCAD batch-fix
 * script generation (.scr) for DXF and LandXML drawing packages.
 *
 * Registers via window.PluginRegistry.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "batchprocess",
        version: "1.0.0",
        description: "Multi-sheet batch project auditor and submittal compliance matrix for DXF & LandXML drawing packages.",
        tab: "tab-batchprocess",
        icon: "fa-boxes-stacked",
        tier: "Pro",
        dependencies: ["spatial-engine", "dxf-auditor"]
    };

    const clean = window.cleanText; // core/safe-dom.js — shared across every plugin that sanitizes text before interpolation

    // window.App is never defined anywhere in this app — ctx.showToast (always real,
    // threaded through from PluginRegistry.initAll()) is the only path that ever fires.
    function notify(ctx, msg, isWarn = false) {
        if (ctx && typeof ctx.showToast === "function") ctx.showToast(msg, isWarn);
    }

    let _inspector = null;
    let _lastBatchResult = null;

    function getInspector() {
        if (!_inspector && window.FDOTDXFInspector && window.FDOT_DATA) {
            _inspector = new window.FDOTDXFInspector(window.FDOT_DATA);
        }
        return _inspector;
    }

    // ── Single File Audit Core ──────────────────────────────────────────────

    function auditSingleFile(filename, content) {
        const isXml = filename.toLowerCase().endsWith(".xml") || filename.toLowerCase().endsWith(".landxml");
        const lowerName = filename.toLowerCase();

        if (isXml) {
            return auditLandXmlFile(filename, content);
        } else {
            return auditDxfFile(filename, content);
        }
    }

    function auditDxfFile(filename, text) {
        const insp = getInspector();
        if (!insp) {
            return {
                filename,
                type: "DXF",
                score: 0,
                status: "FAIL",
                layersCount: 0,
                entitiesCount: 0,
                issues: [{ severity: "CRITICAL", title: "Inspector Unavailable", description: "FDOTDXFInspector could not be loaded." }]
            };
        }

        try {
            const parsed = insp.parseDXF(text);
            const audit = insp.inspectProject(parsed);

            const critical = audit.issues.filter(i => i.severity === "CRITICAL").length;
            const high = audit.issues.filter(i => i.severity === "HIGH").length;
            const medium = audit.issues.filter(i => i.severity === "MEDIUM").length;
            const low = audit.issues.filter(i => i.severity === "LOW").length;

            let status = "PASS";
            if (critical > 0 || audit.score < 60) status = "FAIL";
            else if (high > 0 || audit.score < 85) status = "WARN";

            return {
                filename,
                type: "DXF",
                score: Math.max(0, audit.score),
                status,
                layersCount: audit.layersCount,
                entitiesCount: audit.entitiesCount,
                issues: audit.issues,
                counts: { critical, high, medium, low },
                parsed,
                rawContent: text
            };
        } catch (err) {
            return {
                filename,
                type: "DXF",
                score: 0,
                status: "FAIL",
                layersCount: 0,
                entitiesCount: 0,
                issues: [{ severity: "CRITICAL", title: "Parse Error", description: err.message }],
                counts: { critical: 1, high: 0, medium: 0, low: 0 }
            };
        }
    }

    function auditLandXmlFile(filename, text) {
        if (!window.LandXML || !window.LandXML.parseLandXML) {
            return {
                filename,
                type: "LandXML",
                score: 0,
                status: "FAIL",
                layersCount: 0,
                entitiesCount: 0,
                issues: [{ severity: "CRITICAL", title: "LandXML Parser Unavailable", description: "LandXML engine not found." }]
            };
        }

        try {
            const parsed = window.LandXML.parseLandXML(text);
            const issues = [];
            let score = 100;

            if (!parsed.parcels.length && !parsed.alignments.length && !parsed.points.length) {
                issues.push({ severity: "CRITICAL", title: "Empty Model", description: "No parcels, alignments, or survey points found in LandXML." });
                score -= 40;
            }

            // Check State Plane bounds on points
            (parsed.points || []).forEach(p => {
                if (p.northing < 50000 || p.northing > 4500000 || p.easting < 50000 || p.easting > 3500000) {
                    issues.push({ severity: "HIGH", title: "Off-Grid Coordinate", description: `Point #${p.name} lies outside Florida State Plane envelope.` });
                    score -= 5;
                }
            });

            // Check parcels for minimum sides and closure
            (parsed.parcels || []).forEach(prc => {
                if (prc.vertices && prc.vertices.length < 3) {
                    issues.push({ severity: "HIGH", title: "Degenerate Parcel", description: `Parcel ${prc.name} has fewer than 3 vertices.` });
                    score -= 10;
                }
            });

            const critical = issues.filter(i => i.severity === "CRITICAL").length;
            const high = issues.filter(i => i.severity === "HIGH").length;
            const medium = issues.filter(i => i.severity === "MEDIUM").length;
            const low = issues.filter(i => i.severity === "LOW").length;

            let status = "PASS";
            if (critical > 0 || score < 60) status = "FAIL";
            else if (high > 0 || score < 85) status = "WARN";

            return {
                filename,
                type: "LandXML",
                score: Math.max(0, score),
                status,
                layersCount: (parsed.parcels.length ? 1 : 0) + (parsed.alignments.length ? 1 : 0),
                entitiesCount: parsed.points.length + parsed.parcels.length + parsed.alignments.length,
                issues,
                counts: { critical, high, medium, low },
                parsed,
                rawContent: text
            };
        } catch (err) {
            return {
                filename,
                type: "LandXML",
                score: 0,
                status: "FAIL",
                layersCount: 0,
                entitiesCount: 0,
                issues: [{ severity: "CRITICAL", title: "XML Parse Error", description: err.message }],
                counts: { critical: 1, high: 0, medium: 0, low: 0 }
            };
        }
    }

    // ── Batch Processing Pipeline ───────────────────────────────────────────

    function auditBatch(filesList) {
        if (!filesList || !filesList.length) {
            return {
                files: [],
                summary: { totalFiles: 0, passed: 0, warned: 0, failed: 0, averageScore: 0, totalIssues: 0, criticalIssues: 0, verdict: "NO_FILES" }
            };
        }

        const results = filesList.map(f => auditSingleFile(f.name || f.filename, f.content || f.text));

        let totalScore = 0;
        let passed = 0, warned = 0, failed = 0;
        let totalIssues = 0, criticalIssues = 0;

        results.forEach(r => {
            totalScore += r.score;
            if (r.status === "PASS") passed++;
            else if (r.status === "WARN") warned++;
            else failed++;

            totalIssues += (r.issues || []).length;
            criticalIssues += (r.counts?.critical || 0);
        });

        const totalFiles = results.length;
        const averageScore = Math.round(totalScore / totalFiles);

        let verdict = "SUBMITTAL_READY";
        if (failed > 0 || criticalIssues > 0) verdict = "SUBMITTAL_BLOCKED";
        else if (warned > 0 || averageScore < 85) verdict = "REVISION_REQUIRED";

        const summary = {
            totalFiles,
            passed,
            warned,
            failed,
            averageScore,
            totalIssues,
            criticalIssues,
            verdict
        };

        return { files: results, summary };
    }

    // ── Batch Auto-Fix Script Generator ─────────────────────────────────────

    function generateBatchFixScript(batchResult) {
        if (!batchResult || !batchResult.files) return "";
        let scr = `; ==========================================================================\n`;
        scr += `; FDOT Civil3D Standards Suite - Master Consolidated Batch Fix Script\n`;
        scr += `; Generated: ${new Date().toISOString()}\n`;
        scr += `; Total Sheets Targeted: ${batchResult.files.length}\n`;
        scr += `; ==========================================================================\n`;
        scr += `FILEDIA 0\n`;
        scr += `CMDDIA 0\n\n`;

        batchResult.files.forEach(f => {
            if (f.type !== "DXF") return;
            scr += `; --------------------------------------------------------------------------\n`;
            scr += `; Sheet: ${f.filename} (Score: ${f.score}%, Issues: ${f.issues.length})\n`;
            scr += `; --------------------------------------------------------------------------\n`;
            scr += `_OPEN "${f.filename}"\n`;
            scr += `_AUDIT _Y\n`;
            scr += `-PURGE _A * _N\n`;
            scr += `-PURGE _R * _N\n`;
            scr += `_OVERKILL _ALL  _D\n`;
            scr += `_QSAVE\n`;
            scr += `_CLOSE\n\n`;
        });

        scr += `FILEDIA 1\n`;
        scr += `CMDDIA 1\n`;
        scr += `; Batch processing completed successfully.\n`;
        return scr;
    }

    // ── Master Submittal Report Generator ───────────────────────────────────

    function generateMasterReport(batchResult, format = "markdown") {
        if (!batchResult || !batchResult.summary) return "";
        const s = batchResult.summary;
        const dateStr = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

        if (format === "html") {
            const rows = batchResult.files.map((f, i) => `
                <tr style="border-bottom:1px solid #334155;">
                    <td style="padding:8px 12px; font-weight:600;">${i + 1}. ${clean(f.filename)}</td>
                    <td style="padding:8px 12px; text-align:center;">${clean(f.type)}</td>
                    <td style="padding:8px 12px; text-align:center; font-weight:700; color:${f.score >= 80 ? '#22c55e' : (f.score >= 60 ? '#f59e0b' : '#ef4444')};">${f.score}%</td>
                    <td style="padding:8px 12px; text-align:center;"><span style="padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700; background:${f.status === 'PASS' ? 'rgba(34,197,94,0.2)' : (f.status === 'WARN' ? 'rgba(245,158,11,0.2)' : 'rgba(239,68,68,0.2)')}; color:${f.status === 'PASS' ? '#22c55e' : (f.status === 'WARN' ? '#f59e0b' : '#ef4444')};">${f.status}</span></td>
                    <td style="padding:8px 12px; text-align:center;">${f.layersCount} / ${f.entitiesCount}</td>
                    <td style="padding:8px 12px; text-align:center;">${f.counts?.critical || 0}</td>
                    <td style="padding:8px 12px; text-align:center;">${f.issues.length}</td>
                </tr>
            `).join("");

            return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>FDOT Project Master Submittal QA/QC Scorecard</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 40px; color: #0f172a; background: #fff; }
h1 { margin-bottom: 4px; }
.meta { color: #64748b; font-size: 14px; margin-bottom: 24px; }
.kpi { display: flex; gap: 20px; margin-bottom: 24px; }
.kpi-card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; min-width: 140px; }
.kpi-title { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; }
.kpi-val { font-size: 24px; font-weight: 700; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; margin-top: 16px; font-size: 13px; }
th { background: #f8fafc; text-align: left; padding: 10px 12px; border-bottom: 2px solid #cbd5e1; }
</style>
</head>
<body>
<h1>FDOT Master Submittal QA/QC Scorecard</h1>
<div class="meta">Evaluation Date: ${dateStr} &bull; FDOT Civil3D Standards Suite v2.6.0</div>
<div class="kpi">
  <div class="kpi-card"><div class="kpi-title">Average Score</div><div class="kpi-val" style="color:${s.averageScore >= 80 ? '#16a34a' : '#ea580c'};">${s.averageScore}%</div></div>
  <div class="kpi-card"><div class="kpi-title">Total Sheets</div><div class="kpi-val">${s.totalFiles}</div></div>
  <div class="kpi-card"><div class="kpi-title">Passed Sheets</div><div class="kpi-val" style="color:#16a34a;">${s.passed}</div></div>
  <div class="kpi-card"><div class="kpi-title">Critical Blockers</div><div class="kpi-val" style="color:${s.criticalIssues > 0 ? '#dc2626' : '#16a34a'};">${s.criticalIssues}</div></div>
  <div class="kpi-card"><div class="kpi-title">Submittal Verdict</div><div class="kpi-val" style="font-size:16px; color:${s.verdict === 'SUBMITTAL_READY' ? '#16a34a' : '#dc2626'};">${s.verdict.replace('_', ' ')}</div></div>
</div>
<table>
<thead><tr><th>Drawing Sheet</th><th style="text-align:center;">Type</th><th style="text-align:center;">Score</th><th style="text-align:center;">Status</th><th style="text-align:center;">Layers / Entities</th><th style="text-align:center;">Critical Issues</th><th style="text-align:center;">Total Issues</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</body></html>`;
        }

        // Markdown format
        let md = `# FDOT Master Submittal QA/QC Scorecard\n\n`;
        md += `**Evaluation Date:** ${dateStr}  \n`;
        md += `**Overall Project Verdict:** ${s.verdict.replace('_', ' ')}  \n`;
        md += `**Average Compliance Score:** ${s.averageScore}%  \n`;
        md += `**Sheets Inspected:** ${s.totalFiles} (${s.passed} Passed, ${s.warned} Warning, ${s.failed} Failed)  \n`;
        md += `**Critical Blockers:** ${s.criticalIssues}  \n\n`;
        md += `| # | Sheet Filename | Type | Score | Status | Layers / Entities | Critical Issues | Total Issues |\n`;
        md += `|---|---|---|---|---|---|---|---|\n`;

        batchResult.files.forEach((f, idx) => {
            md += `| ${idx + 1} | ${f.filename} | ${f.type} | ${f.score}% | ${f.status} | ${f.layersCount} / ${f.entitiesCount} | ${f.counts?.critical || 0} | ${f.issues.length} |\n`;
        });

        md += `\n\n## Itemized Critical Deficiencies\n`;
        let foundCritical = false;
        batchResult.files.forEach(f => {
            const crits = (f.issues || []).filter(i => i.severity === "CRITICAL");
            if (crits.length) {
                foundCritical = true;
                md += `\n### ${f.filename}\n`;
                crits.forEach(c => {
                    md += `- **${c.title}**: ${c.description} (Layer: \`${c.layer || 'N/A'}\`)\n`;
                });
            }
        });
        if (!foundCritical) md += `*No critical submittal blockers found across inspected sheets.*\n`;

        return md;
    }

    // ── Sample Demo Project Batch ───────────────────────────────────────────

    function getDemoProjectBatch() {
        return [
            {
                name: "SR50_Sheet01_Roadway_Plan.dxf",
                content: `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n0\nLAYER\n2\nROAD_PAVE_ASPH\n62\n7\n70\n0\n0\nLAYER\n2\nROAD_CURB_CONC\n62\n3\n70\n0\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nROAD_PAVE_ASPH\n10\n100000.0\n20\n500000.0\n11\n100500.0\n21\n500000.0\n0\nENDSEC\n0\nEOF\n`
            },
            {
                name: "SR50_Sheet02_Drainage.dxf",
                content: `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n0\nLAYER\n2\nDRAIN_PIPE_CONC\n62\n4\n70\n0\n0\nLAYER\n2\nDEFPOINTS\n62\n7\n70\n0\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nDRAIN_PIPE_CONC\n10\n100000.0\n20\n500000.0\n11\n100000.0\n21\n500000.0\n0\nENDSEC\n0\nEOF\n`
            },
            {
                name: "SR50_Sheet03_Survey_Boundary.dxf",
                content: `0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n0\nLAYER\n2\nSURV_BND_PROP\n62\n1\n70\n0\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\nSURV_BND_PROP\n90\n4\n70\n1\n10\n100000.0\n20\n500000.0\n10\n100400.0\n20\n500400.0\n10\n100000.0\n20\n500400.0\n10\n100400.0\n20\n500000.0\n0\nENDSEC\n0\nEOF\n`
            },
            {
                name: "SR50_Sheet04_RightOfWay.xml",
                content: `<?xml version="1.0" encoding="utf-8"?><LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2"><Units><Imperial linearUnit="USSurveyFoot"/></Units><Project name="SR50"/><Parcels><Parcel name="PARCEL_1" area="40000"><CoordGeom><Line><Start>100000 500000</Start><End>100200 500000</End></Line><Line><Start>100200 500000</Start><End>100200 500200</End></Line><Line><Start>100200 500200</Start><End>100000 500200</End></Line><Line><Start>100000 500200</Start><End>100000 500000</End></Line></CoordGeom></Parcel></Parcels></LandXML>`
            }
        ];
    }

    // ── UI Controller ───────────────────────────────────────────────────────

    function renderUI(ctx) {
        const root = document.getElementById("batchprocess-controls");
        if (!root) return;

        window.setSafeHTML(root, `
            <div class="glass-panel" style="padding:1.25rem; margin-top:1rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; margin-bottom:1rem;">
                    <div>
                        <h3 style="font-size:1.1rem; margin-bottom:0.25rem;"><i class="fa-solid fa-boxes-stacked" style="color:var(--primary);"></i> Multi-Sheet Project Batch Auditor</h3>
                        <p style="font-size:0.85rem; color:var(--text-muted);">Audit 10 to 100+ DXF and LandXML drawings simultaneously against FDOT CADD standards. Evaluates layers, zero-length entities, unclosed boundaries, bow-ties, and state plane envelopes.</p>
                    </div>
                    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                        <button class="btn btn-secondary" id="btn-batch-demo"><i class="fa-solid fa-folder-open"></i> Load Demo Project Batch (4 Sheets)</button>
                        <label class="btn btn-primary" style="cursor:pointer; margin:0;">
                            <i class="fa-solid fa-cloud-arrow-up"></i> Select Drawing Files (Multi-Select)
                            <input type="file" id="batch-file-input" multiple accept=".dxf,.xml,.landxml" style="display:none;">
                        </label>
                    </div>
                </div>

                <!-- Dropzone -->
                <div id="batch-dropzone" style="border:2px dashed var(--glass-border); border-radius:var(--radius-sm); padding:2rem; text-align:center; background:var(--bg-secondary); cursor:pointer; transition:all 0.2s;">
                    <i class="fa-solid fa-file-shield" style="font-size:2rem; color:var(--primary); margin-bottom:0.75rem;"></i>
                    <div style="font-weight:600; font-size:0.95rem;">Drag &amp; Drop multiple DXF or LandXML drawings here</div>
                    <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.35rem;">or click to browse your submittal package folder</div>
                </div>

                <!-- Progress bar -->
                <div id="batch-progress-wrap" class="hidden" style="margin-top:1rem;">
                    <div style="display:flex; justify-content:space-between; font-size:0.8rem; margin-bottom:0.35rem;">
                        <span id="batch-progress-label">Auditing sheets...</span>
                        <span id="batch-progress-pct">0%</span>
                    </div>
                    <div style="height:8px; background:var(--bg-secondary); border-radius:4px; overflow:hidden;">
                        <div id="batch-progress-bar" style="width:0%; height:100%; background:var(--primary); transition:width 0.15s;"></div>
                    </div>
                </div>
            </div>

            <!-- Project Dashboard -->
            <div id="batch-dashboard" class="hidden" style="margin-top:1.5rem;">
                <div style="display:grid; grid-template-columns: repeat(5, 1fr); gap:0.75rem; margin-bottom:1.5rem;">
                    <div class="glass-panel" style="padding:1rem; text-align:center;">
                        <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Submittal Score</div>
                        <div id="stat-batch-score" style="font-size:1.8rem; font-weight:800; color:var(--primary);">--</div>
                    </div>
                    <div class="glass-panel" style="padding:1rem; text-align:center;">
                        <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Inspected Sheets</div>
                        <div id="stat-batch-total" style="font-size:1.8rem; font-weight:800; color:var(--text-primary);">--</div>
                    </div>
                    <div class="glass-panel" style="padding:1rem; text-align:center;">
                        <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Compliant (Pass)</div>
                        <div id="stat-batch-passed" style="font-size:1.8rem; font-weight:800; color:var(--success);">--</div>
                    </div>
                    <div class="glass-panel" style="padding:1rem; text-align:center;">
                        <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Warnings</div>
                        <div id="stat-batch-warned" style="font-size:1.8rem; font-weight:800; color:var(--warning);">--</div>
                    </div>
                    <div class="glass-panel" style="padding:1rem; text-align:center;">
                        <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; font-weight:600;">Critical Blockers</div>
                        <div id="stat-batch-critical" style="font-size:1.8rem; font-weight:800; color:var(--danger);">--</div>
                    </div>
                </div>

                <!-- Actions Header -->
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem; flex-wrap:wrap; gap:0.5rem;">
                    <h4 style="font-size:1rem; margin:0;"><i class="fa-solid fa-table-list"></i> Submittal Compliance Matrix</h4>
                    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                        <button class="btn btn-secondary btn-sm" id="btn-batch-export-scr"><i class="fa-solid fa-terminal"></i> Consolidated Batch Fix (.scr)</button>
                        <button class="btn btn-secondary btn-sm" id="btn-batch-export-html"><i class="fa-solid fa-file-code"></i> Master Report (HTML)</button>
                        <button class="btn btn-secondary btn-sm" id="btn-batch-export-md"><i class="fa-solid fa-file-lines"></i> Master Report (MD)</button>
                    </div>
                </div>

                <!-- Table Container -->
                <div class="glass-panel" style="padding:0; overflow-x:auto;">
                    <table style="width:100%; border-collapse:collapse; font-size:0.82rem; text-align:left;">
                        <thead>
                            <tr style="border-bottom:1px solid var(--glass-border); background:rgba(255,255,255,0.03);">
                                <th style="padding:0.75rem 1rem;">Sheet / Drawing</th>
                                <th style="padding:0.75rem 0.5rem; text-align:center;">Format</th>
                                <th style="padding:0.75rem 0.5rem; text-align:center;">Score</th>
                                <th style="padding:0.75rem 0.5rem; text-align:center;">Status</th>
                                <th style="padding:0.75rem 0.5rem; text-align:center;">Layers / Entities</th>
                                <th style="padding:0.75rem 0.5rem; text-align:center;">Critical Issues</th>
                                <th style="padding:0.75rem 0.5rem; text-align:center;">Total Issues</th>
                            </tr>
                        </thead>
                        <tbody id="batch-matrix-tbody">
                            <!-- Injected rows -->
                        </tbody>
                    </table>
                </div>
            </div>
        `);

        bindEvents(ctx);
    }

    function bindEvents(ctx) {
        const root = document.getElementById("batchprocess-controls");
        if (!root) return;

        // Demo Project Batch
        root.querySelector("#btn-batch-demo")?.addEventListener("click", () => {
            const demo = getDemoProjectBatch();
            runBatch(demo, ctx);
        });

        // File input change
        const fileInput = root.querySelector("#batch-file-input");
        fileInput?.addEventListener("change", async e => {
            const files = Array.from(e.target.files || []);
            if (!files.length) return;
            const loaded = await readUploadedFiles(files);
            runBatch(loaded, ctx);
        });

        // Drag & Drop
        const dz = root.querySelector("#batch-dropzone");
        if (dz) {
            dz.addEventListener("click", () => fileInput?.click());
            dz.addEventListener("dragover", e => { e.preventDefault(); dz.style.borderColor = "var(--primary)"; });
            dz.addEventListener("dragleave", () => { dz.style.borderColor = "var(--glass-border)"; });
            dz.addEventListener("drop", async e => {
                e.preventDefault();
                dz.style.borderColor = "var(--glass-border)";
                const files = Array.from(e.dataTransfer.files || []);
                if (!files.length) return;
                const loaded = await readUploadedFiles(files);
                runBatch(loaded, ctx);
            });
        }

        // Export Scripts & Reports
        root.querySelector("#btn-batch-export-scr")?.addEventListener("click", () => {
            if (!_lastBatchResult) return;
            const scr = generateBatchFixScript(_lastBatchResult);
            if (window.COGO?.downloadText) {
                window.COGO.downloadText("fdot_batch_fix.scr", scr, "text/plain");
                notify(ctx, "Downloaded master consolidated batch-fix script.");
            }
        });

        root.querySelector("#btn-batch-export-html")?.addEventListener("click", () => {
            if (!_lastBatchResult) return;
            const html = generateMasterReport(_lastBatchResult, "html");
            if (window.COGO?.downloadText) {
                window.COGO.downloadText("fdot_master_submittal_report.html", html, "text/html");
                notify(ctx, "Downloaded Master Submittal Report (HTML).");
            }
        });

        root.querySelector("#btn-batch-export-md")?.addEventListener("click", () => {
            if (!_lastBatchResult) return;
            const md = generateMasterReport(_lastBatchResult, "markdown");
            if (window.COGO?.downloadText) {
                window.COGO.downloadText("fdot_master_submittal_report.md", md, "text/markdown");
                notify(ctx, "Downloaded Master Submittal Report (Markdown).");
            }
        });
    }

    async function readUploadedFiles(fileArray) {
        const out = [];
        for (const f of fileArray) {
            try {
                const text = await f.text();
                out.push({ name: f.name, content: text });
            } catch (err) {
                console.warn("Error reading batch file:", f.name, err);
            }
        }
        return out;
    }

    function runBatch(files, ctx) {
        if (!files.length) return;
        notify(ctx, `Starting batch audit of ${files.length} drawing(s)...`);

        const pWrap = document.getElementById("batch-progress-wrap");
        const pBar = document.getElementById("batch-progress-bar");
        const pPct = document.getElementById("batch-progress-pct");
        if (pWrap) pWrap.classList.remove("hidden");
        if (pBar) pBar.style.width = "0%";

        setTimeout(() => {
            const batchResult = auditBatch(files);
            _lastBatchResult = batchResult;

            if (window.Reports?.addReport) {
                window.Reports.addReport({
                    id: "batch_report_html",
                    title: `Master Submittal Scorecard (${batchResult.summary.totalFiles} Sheets)`,
                    type: "batch-submittal",
                    category: "dxf",
                    format: "html",
                    filename: "fdot_master_submittal_report.html",
                    content: generateMasterReport(batchResult, "html"),
                    metadata: { files: batchResult.summary.totalFiles, score: batchResult.summary.averageScore, verdict: batchResult.summary.verdict }
                });
                window.Reports.addReport({
                    id: "batch_report_md",
                    title: `Master Submittal Markdown Report (${batchResult.summary.totalFiles} Sheets)`,
                    type: "batch-submittal",
                    category: "dxf",
                    format: "markdown",
                    filename: "fdot_master_submittal_report.md",
                    content: generateMasterReport(batchResult, "markdown"),
                    metadata: { files: batchResult.summary.totalFiles, score: batchResult.summary.averageScore, verdict: batchResult.summary.verdict }
                });
            }

            if (pBar) pBar.style.width = "100%";
            if (pPct) pPct.textContent = "100%";

            setTimeout(() => {
                if (pWrap) pWrap.classList.add("hidden");
                renderResults(batchResult);
                notify(ctx, `Batch audit complete: Average score ${batchResult.summary.averageScore}%. Stored in Reports Hub.`);
            }, 250);
        }, 50);
    }

    function renderResults(batchResult) {
        const dash = document.getElementById("batch-dashboard");
        if (!dash) return;
        dash.classList.remove("hidden");

        const s = batchResult.summary;
        const scoreEl = document.getElementById("stat-batch-score");
        if (scoreEl) {
            scoreEl.textContent = `${s.averageScore}%`;
            scoreEl.style.color = s.averageScore >= 80 ? "var(--success)" : (s.averageScore >= 60 ? "var(--warning)" : "var(--danger)");
        }
        document.getElementById("stat-batch-total").textContent = s.totalFiles;
        document.getElementById("stat-batch-passed").textContent = s.passed;
        document.getElementById("stat-batch-warned").textContent = s.warned;
        const critEl = document.getElementById("stat-batch-critical");
        if (critEl) {
            critEl.textContent = s.criticalIssues;
            critEl.style.color = s.criticalIssues > 0 ? "var(--danger)" : "var(--success)";
        }

        // Render Matrix Table
        const tbody = document.getElementById("batch-matrix-tbody");
        if (!tbody) return;

        const rows = batchResult.files.map((f, idx) => {
            const statusClass = f.status === "PASS" ? "color:var(--success); background:rgba(34,197,94,0.15);" : (f.status === "WARN" ? "color:var(--warning); background:rgba(245,158,11,0.15);" : "color:var(--danger); background:rgba(239,68,68,0.15);");
            const scoreColor = f.score >= 80 ? "var(--success)" : (f.score >= 60 ? "var(--warning)" : "var(--danger)");

            return `
                <tr style="border-bottom:1px solid var(--glass-border);">
                    <td style="padding:0.75rem 1rem;">
                        <strong style="color:var(--text-primary);">${clean(f.filename)}</strong>
                    </td>
                    <td style="padding:0.75rem 0.5rem; text-align:center; font-family:var(--font-mono); font-size:0.75rem;">${clean(f.type)}</td>
                    <td style="padding:0.75rem 0.5rem; text-align:center; font-weight:700; color:${scoreColor};">${f.score}%</td>
                    <td style="padding:0.75rem 0.5rem; text-align:center;">
                        <span style="padding:0.15rem 0.5rem; border-radius:3px; font-size:0.7rem; font-weight:700; ${statusClass}">${f.status}</span>
                    </td>
                    <td style="padding:0.75rem 0.5rem; text-align:center; color:var(--text-muted);">${f.layersCount} / ${f.entitiesCount}</td>
                    <td style="padding:0.75rem 0.5rem; text-align:center; font-weight:700; color:${(f.counts?.critical || 0) > 0 ? 'var(--danger)' : 'var(--text-muted)'};">${f.counts?.critical || 0}</td>
                    <td style="padding:0.75rem 0.5rem; text-align:center; color:var(--text-muted);">${f.issues.length}</td>
                </tr>
            `;
        }).join("");

        window.setSafeRows(tbody, rows);
    }

    // ── Plugin Object & Public API ──────────────────────────────────────────

    const Plugin = {
        init(ctx) {
            renderUI(ctx);
        },
        onTabActivate(ctx) {
            renderUI(ctx);
        }
    };

    window.BatchProcess = {
        auditSingleFile,
        auditBatch,
        generateBatchFixScript,
        generateMasterReport,
        getDemoProjectBatch,
        getLastResult: () => _lastBatchResult
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);
})();
