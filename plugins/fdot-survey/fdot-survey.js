/**
 * Plugin: fdot-survey — FDOT survey deliverable checks, from FDOT's own published documents:
 *
 *  - the FDOT Survey Feature Codes (4/24/2025; plugins/fdot-survey/fdot-feature-codes.js):
 *      lookup, a point file's codes (unknown codes, line codes with one shot), and a drawing's
 *      survey levels (layers named like FDOT survey levels that aren't on the list)
 *  - the survey report format of the FDOT Surveying and Mapping Handbook (Feb 28, 2025), Appendix E,
 *      and its §1.3 rule that elevations are referenced to NAVD 88
 *
 * Shown on the Survey & Desckeys tab, below the (illustrative) description-key table. Pure functions
 * are on window.FdotSurvey for the test suite.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "fdot-survey",
        version: "1.0.0",
        description: "FDOT survey checks from FDOT's published Survey Feature Codes (2025) and Surveying and Mapping Handbook (2025): point-file codes, drawing survey levels, survey report contents.",
        tab: "tab-survey",
        icon: "fa-location-crosshairs",
        tier: "Free",
        dependencies: []
    };

    const clean = window.cleanText;
    const FC = window.FdotFeatureCodes;
    const HANDBOOK = "FDOT Surveying and Mapping Handbook (Feb 28, 2025)";
    const $ = id => document.getElementById(id);

    const byCode = new Map((FC ? FC.rows : []).map(r => [r.code.toUpperCase(), r]));
    const byLevel = new Map((FC ? FC.rows : []).map(r => [r.level.toUpperCase(), r]));

    function lookup(code) { return byCode.get(String(code == null ? "" : code).trim().toUpperCase()) || null; }

    function search(q) {
        const s = String(q || "").trim().toUpperCase();
        if (!FC) return [];
        if (!s) return FC.rows.slice();
        return FC.rows.filter(r => r.code.toUpperCase().includes(s) || r.level.toUpperCase().includes(s) || r.description.toUpperCase().includes(s));
    }

    // ── Point file ───────────────────────────────────────────────────────

    /**
     * P,N,E,Z,D lines (comma, tab or space separated). The code is the description's first word.
     * @returns {{ points, codes: [{code, count, known, type, level, description, samples}], findings }}
     */
    function checkPointCodes(text) {
        const findings = [];
        const flag = (severity, rule, id, where, message) => findings.push({ severity, rule, id, where, message });
        const stats = new Map();
        let points = 0, skipped = 0;
        String(text || "").split(/\r?\n/).forEach((line, i) => {
            const raw = line.trim();
            if (!raw || /^[#;]/.test(raw)) return;
            const f = raw.includes(",") ? raw.split(",").map(x => x.trim()) : raw.split(/\s+/);
            if (f.length < 5 || !isFinite(Number(f[1])) || !isFinite(Number(f[2]))) { skipped++; return; }
            points++;
            const desc = f.slice(4).join(" ").trim();
            const code = (desc.split(/\s+/)[0] || "").toUpperCase();
            if (!code) { flag("warning", "Point without a code", f[0], `line ${i + 1}`, "this point has no description, so it has no feature code."); return; }
            const s = stats.get(code) || { code, count: 0, samples: [] };
            s.count++;
            if (s.samples.length < 5) s.samples.push(f[0]);
            stats.set(code, s);
        });
        const codes = Array.from(stats.values()).map(s => {
            let r = lookup(s.code), note = "";
            if (!r) {
                const m = /^([A-Z]+?)[-_]?\d+$/.exec(s.code); // "AP2" / "AP-2": a figure number on the code
                if (m && lookup(m[1])) { r = lookup(m[1]); note = `read as ${m[1]} with a number suffix`; }
            }
            return Object.assign(s, { known: !!r, type: r ? r.type : null, level: r ? r.level : null, description: r ? r.description : null, note });
        }).sort((a, b) => b.count - a.count);
        codes.forEach(c => {
            if (!c.known) flag("warning", "Not an FDOT feature code", c.code, `points ${c.samples.join(", ")}${c.count > c.samples.length ? ", …" : ""}`,
                `${c.count} point(s) use ${c.code}, which is not in the FDOT Survey Feature Codes (4/24/2025).`);
            else if (c.type === "L" && c.count === 1) flag("info", "Line code with one shot", c.code, `point ${c.samples[0]}`,
                `${c.code} (${c.description}) is a line feature but has a single shot — a line needs two or more.`);
        });
        if (skipped) flag("info", "Lines skipped", "", "", `${skipped} line(s) were not P,N,E,Z,D points and were skipped.`);
        return { points, codes, findings };
    }

    // ── Drawing levels ───────────────────────────────────────────────────

    /**
     * @param {Array<{name, count}>} layers  a drawing's layers with entity counts
     * Layers named like FDOT survey levels (…_ep / …_ex endings) that are not on the list are reported;
     * other layers (design, sheets) are counted only.
     */
    function checkSurveyLevels(layers) {
        const findings = [];
        const known = [], unknown = [], other = [];
        (layers || []).forEach(l => {
            const r = byLevel.get(String(l.name).toUpperCase());
            if (r) known.push(Object.assign({ row: r }, l));
            else if (/_e[px]$/i.test(l.name)) unknown.push(l);
            else other.push(l);
        });
        // A level whose case differs from FDOT's spelling still reads as known, but is noted.
        known.forEach(l => {
            if (l.name !== l.row.level) findings.push({ severity: "info", rule: "Level spelled differently", id: "", where: l.name, message: `FDOT spells this level ${l.row.level}.` });
        });
        unknown.forEach(l => findings.push({ severity: "warning", rule: "Not an FDOT survey level", id: "", where: l.name,
            message: `${l.count} entit${l.count === 1 ? "y is" : "ies are"} on ${l.name}, which looks like a survey level but is not in the FDOT Survey Feature Codes (4/24/2025).` }));
        findings.push({ severity: "info", rule: "Survey levels", id: "", where: "Drawing",
            message: `${known.length} layer(s) are FDOT survey levels, ${unknown.length} look like survey levels but aren't on the list, ${other.length} other layer(s) were not checked.` });
        return { known, unknown, other, findings };
    }

    // ── FDOT layer naming (CADD Manual 2025 §5.10.1.1) ───────────────────

    const CADD_MANUAL = "FDOT CADD Manual 2025 (Topic 625-050-001)";
    /**
     * "General CADD Level/Layer Name convention format: object_sv (maximum of 18 characters)", where s =
     * p (Proposed), d (Drafting element), e (Existing) and v = p (Plan), r (Profile), x (Cross Section),
     * m (Model); a name with no _sv suffix is taken as _pp. Layer 0 "is not QC compliant and is not to be
     * used for drawing elements" (§5.10.1.3, said there for Structures). FDOT's full level list ships in its
     * state-kit templates, not as a download, so names are checked against the convention, not the list.
     */
    function checkFdotLayerNames(layers) {
        const findings = [];
        (layers || []).forEach(l => {
            const name = String(l.name);
            if (name === "0" || name.toUpperCase() === "DEFAULT") {
                if (l.count) findings.push({ severity: "info", rule: "Layer 0 / Default", id: "", where: name, message: `${l.count} entit${l.count === 1 ? "y is" : "ies are"} on layer ${name}; FDOT calls Layer 0 (Default) "not QC compliant … not to be used for drawing elements" (${CADD_MANUAL} §5.10.1.3).` });
                return;
            }
            if (name.length > 18) findings.push({ severity: "warning", rule: "Layer name over 18 characters", id: "", where: name, message: `${name.length} characters; FDOT layer names are at most 18 (${CADD_MANUAL} §5.10.1.1).` });
            const m = /_([A-Za-z])([A-Za-z])$/.exec(name);
            if (m && !(/^[pde]$/i.test(m[1]) && /^[prxm]$/i.test(m[2]))) {
                findings.push({ severity: "warning", rule: "Layer state/view suffix", id: "", where: name, message: `suffix "_${m[1]}${m[2]}" isn't an FDOT state (p, d, e) + view (p, r, x, m) designation (${CADD_MANUAL} §5.10.1.1).` });
            }
        });
        findings.push({ severity: "info", rule: "FDOT layer names", id: "", where: "Drawing", message: `${(layers || []).length} layer(s) checked against the FDOT naming convention (object_sv, ≤ 18 characters — ${CADD_MANUAL} §5.10.1.1). FDOT's full level list isn't published as a download, so names aren't checked against it.` });
        return { findings };
    }

    // ── Survey report (Appendix E) ───────────────────────────────────────

    const REPORT_ITEMS = [
        { id: "1.1", label: "Firm", re: /\bFIRM\b|\bPREPARED\s+BY\b|\bCONSULTANT\b/i },
        { id: "1.2", label: "Financial Project Number", re: /FINANCIAL\s+PROJECT|\bF\.?P\.?(?:I\.?D\.?|N\.?)\b|\b\d{6}-\d-\d{2}-\d{2}\b/i },
        { id: "1.3", label: "Project name", re: /PROJECT\s+NAME|PROJECT\s+TITLE/i },
        { id: "1.4", label: "State Road Number", re: /\bSTATE\s+ROAD\b|\bS\.?R\.?\s*-?\s*\d+/i },
        { id: "1.5", label: "Roadway Section Identification Number", re: /ROADWAY\s+(?:SECTION\s+)?(?:ID|IDENTIFICATION)|\bR\.?S\.?I\.?D\.?\b|ROADWAY\s+ID/i },
        { id: "1.6", label: "Project limits", re: /PROJECT\s+LIMITS|\bLIMITS\b|\bBETWEEN\b[^.\n]{3,80}\bAND\b/i },
        { id: "1.7", label: "Survey dates (start and end)", re: /SURVEY\s+DATES?|DATES?\s+OF\s+(?:FIELD\s+)?SURVEY|FIELD\s*WORK/i },
        { id: "1.8", label: "Units of measure", re: /U\.?S\.?\s+SURVEY\s+F(?:OO|EE)T|INTERNATIONAL\s+F(?:OO|EE)T|UNITS?\s+OF\s+MEASURE|\bMETERS?\b/i },
        { id: "2", label: "Type of survey (Rule 5J-17.050)", re: /TYPE\s+OF\s+SURVEY|5J-17\.050|SPECIFIC\s+PURPOSE\s+SURVEY|(?:TOPOGRAPHIC|CONTROL|BOUNDARY|DESIGN|RIGHT\s+OF\s+WAY)\s+SURVEY/i },
        { id: "3", label: "Methodology", re: /METHODOLOGY|\bMETHODS?\b|PROCEDURES?\s+USED/i },
        { id: "4.1", label: "Horizontal datum", re: /HORIZONTAL\s+DATUM|\bNAD\s*-?\s*(?:19)?83\b|\bNAD\s*-?\s*(?:19)?27\b/i },
        { id: "4.2", label: "Horizontal control points", re: /HORIZONTAL\s+CONTROL|CONTROL\s+POINTS?|CONTROL\s+STATIONS?/i },
        { id: "4.3", label: "Vertical datum", re: /VERTICAL\s+DATUM|\bNAVD\s*-?\s*(?:19)?88\b|\bNGVD\s*-?\s*(?:19)?29\b/i },
        { id: "4.4", label: "Vertical control points (benchmarks)", re: /VERTICAL\s+CONTROL|BENCH\s*MARKS?|\bB\.?M\.?\s*#?\s*\d/i },
        { id: "5", label: "Sources", re: /\bSOURCES?\b|RIGHT\s+OF\s+WAY\s+MAPS?|\bPLATS?\b|ABSTRACTS?\s+OF\s+TITLE|AERIAL\s+IMAGERY/i },
        { id: "6", label: "General notes", re: /GENERAL\s+NOTES|SURVEY\s+NOTES|\bNOTES:/i },
        { id: "7", label: "Legend and abbreviations", re: /\bLEGEND\b|ABBREVIATIONS/i },
        { id: "9", label: "Files list", re: /FILES?\s+LIST|LIST\s+OF\s+(?:ALL\s+)?FILES|DELIVERABLES?\b/i },
        { id: "10", label: "Certification", re: /I\s+HEREBY\s+CERTIFY/i },
        { id: "10a", label: "Certification cites Rule 5J-17", re: /5J-17/i },
        { id: "10b", label: "Surveyor's licence number", re: /(?:LICEN[CS]E\s+(?:NO\.?|NUMBER)?|\bPSM|\bL\.?S\.?)\s*#?\s*:?\s*\d{4,5}\b/i }
    ];

    /**
     * @returns {{ items: [{id, label, found, evidence}], findings, basis }}
     */
    function checkSurveyReport(text) {
        const t = String(text || "");
        const findings = [];
        const items = REPORT_ITEMS.map(it => {
            const m = it.re.exec(t);
            return { id: it.id, label: it.label, found: !!m, evidence: m ? t.slice(Math.max(0, m.index - 20), m.index + m[0].length + 40).replace(/\s+/g, " ").trim() : null };
        });
        items.filter(i => !i.found).forEach(i => findings.push({ severity: "warning", rule: "Report item not found", id: i.id, where: "Survey report",
            message: `no ${i.label} found (${HANDBOOK}, Appendix E, item ${i.id.replace(/[ab]$/, "")}).` }));
        // §1.3: elevations are referenced to NAVD 88; another datum needs the DSMO's written authorization
        const navd = /\bNAVD\s*-?\s*(?:19)?88\b/i.test(t), other = /\bNGVD\s*-?\s*(?:19)?29\b|LOCAL\s+DATUM|ASSUMED\s+(?:DATUM|ELEVATION)/i.test(t);
        if (other && !navd) findings.push({ severity: "warning", rule: "Vertical datum", id: "4.3", where: "Survey report",
            message: `elevations are not on NAVD 88; FDOT references elevations to NAVD 88, and a local or assumed datum needs the DSMO's written authorization (${HANDBOOK} §1.3).` });
        // Multi-firm projects need a lead surveyor's comprehensive report (item 8)
        if (/\bSUBCONSULTANT|\bSUB-?CONSULTANT|LEAD\s+SURVEYOR|SURVEYS?\s+BY\s+OTHERS/i.test(t) && !/COMPILATION|LEAD\s+SURVEYOR/i.test(t)) {
            findings.push({ severity: "info", rule: "Compilation of surveys", id: "8", where: "Survey report",
                message: `the report mentions other surveyors; a multi-firm project needs the lead surveyor's comprehensive report naming each firm's role (${HANDBOOK}, Appendix E, item 8).` });
        }
        return { items, findings, basis: `${HANDBOOK}, Appendix E. A missing item may be on the map instead (the handbook allows notes on the map, the report, or a text report delivered with it).` };
    }

    /** Text of a .docx (word/document.xml), paragraph per line. */
    async function docxText(buf) {
        if (!window.JeaXlsx) throw new Error("The zip reader (jea-xlsx.js) is not loaded.");
        const zip = window.JeaXlsx.openZip(buf);
        if (!zip["word/document.xml"]) throw new Error("Not a Word document (word/document.xml missing).");
        const xml = await zip["word/document.xml"]();
        return xml.replace(/<w:tab\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "")
            .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
    }

    // ── Render ───────────────────────────────────────────────────────────

    const color = { error: "var(--danger)", warning: "var(--warning)", info: "var(--text-secondary)" };
    const list = findings => findings.length ? `<ul style="margin:0.35rem 0 0 1rem; max-height:240px; overflow-y:auto;">${findings.slice(0, 80).map(f =>
        `<li style="color:${color[f.severity]};">${f.id ? `<strong>${clean(f.id)}</strong> ` : ""}${f.where ? `<code>${clean(f.where)}</code> — ` : ""}${clean(f.rule)}: ${clean(f.message)}</li>`).join("")}</ul>` : `<p style="color:var(--success);">Nothing to report.</p>`;

    function renderCodes() {
        const box = $("fdot-fc-results");
        if (!box) return;
        const rows = search(($("fdot-fc-search") || {}).value);
        window.setSafeHTML(box, `<p style="font-size:0.78rem; color:var(--text-secondary); margin:0.25rem 0;">${rows.length} of ${FC ? FC.rows.length : 0} codes${rows.length > 100 ? " — first 100 shown" : ""}.</p>
          <div class="table-container" style="max-height:320px; overflow-y:auto;"><table class="data-table" style="width:100%; font-size:0.78rem;">
            <thead><tr><th>Code</th><th>Level</th><th>Description</th><th>Point / Line</th><th>Zone</th></tr></thead>
            <tbody>${rows.slice(0, 100).map(r => `<tr><td><code>${clean(r.code)}</code></td><td><code>${clean(r.level)}</code></td><td>${clean(r.description)}</td><td>${r.type === "L" ? "Line" : "Point"}</td><td>${r.zone == null ? "" : r.zone}</td></tr>`).join("")}</tbody>
          </table></div>`);
    }

    function renderPanel() {
        const root = $("fdot-survey-panel");
        if (!root || !FC) return;
        window.setSafeHTML(root, `
          <div class="glass-panel" style="padding:1.25rem; margin-top:1rem;">
            <h3 style="margin:0 0 0.25rem 0;"><i class="fa-solid fa-clipboard-check" style="color:var(--primary);"></i> FDOT survey checks</h3>
            <p style="font-size:0.8rem; color:var(--text-secondary); margin:0 0 0.75rem 0;">From FDOT's published <a href="${clean(FC.url)}" rel="noopener">Survey Feature Codes (4/24/2025)</a> and the Surveying and Mapping Handbook (February 28, 2025). The description keys above are illustrative; these codes are FDOT's.</p>

            <h4 style="margin:0.5rem 0 0.25rem 0;">Feature codes</h4>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
              <input type="text" id="fdot-fc-search" aria-label="Search FDOT feature codes" placeholder="Code, level or description" style="min-width:240px;">
              <button class="btn btn-secondary btn-sm" id="fdot-fc-csv"><i class="fa-solid fa-file-csv"></i> Download all codes (CSV)</button>
            </div>
            <div id="fdot-fc-results"></div>

            <h4 style="margin:1rem 0 0.25rem 0;">Check a point file or a drawing</h4>
            <div style="display:flex; gap:0.75rem; flex-wrap:wrap; align-items:center;">
              <label for="fdot-points-file" style="font-size:0.8rem;">Point file (P,N,E,Z,D)</label>
              <input type="file" id="fdot-points-file" accept=".csv,.txt,.pnezd,.xyz" style="font-size:0.8rem;">
              <label for="fdot-dxf-file" style="font-size:0.8rem;">Survey drawing (.dxf)</label>
              <input type="file" id="fdot-dxf-file" accept=".dxf" style="font-size:0.8rem;">
            </div>
            <div id="fdot-check-results" role="status" style="font-size:0.78rem; margin-top:0.5rem;"></div>

            <h4 style="margin:1rem 0 0.25rem 0;">Check a survey report (Appendix E)</h4>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center;">
              <label for="fdot-report-file" style="font-size:0.8rem;">Report (.docx or .txt)</label>
              <input type="file" id="fdot-report-file" accept=".docx,.txt" style="font-size:0.8rem;">
              <button class="btn btn-secondary btn-sm" id="fdot-report-check">Check pasted text</button>
            </div>
            <textarea id="fdot-report-text" rows="5" aria-label="Survey report text" placeholder="…or paste the survey report text here" style="width:100%; margin-top:0.5rem; font-size:0.78rem;"></textarea>
            <div id="fdot-report-results" role="status" style="font-size:0.78rem; margin-top:0.5rem;"></div>
          </div>`);
        renderCodes();
    }

    function showReport(text) {
        const r = checkSurveyReport(text);
        const found = r.items.filter(i => i.found).length;
        window.setSafeHTML($("fdot-report-results"), `<strong>${found} of ${r.items.length}</strong> Appendix E items found.
          <div class="table-container" style="max-height:280px; overflow-y:auto; margin-top:0.35rem;"><table class="data-table" style="width:100%; font-size:0.75rem;">
            <thead><tr><th>Item</th><th>What</th><th>Found</th><th>Where</th></tr></thead>
            <tbody>${r.items.map(i => `<tr><td>${clean(i.id)}</td><td>${clean(i.label)}</td><td style="color:${i.found ? "var(--success)" : "var(--warning)"};">${i.found ? "yes" : "no"}</td><td>${i.evidence ? clean(i.evidence.slice(0, 90)) : ""}</td></tr>`).join("")}</tbody></table></div>
          ${list(r.findings.filter(f => f.rule !== "Report item not found"))}
          <p style="color:var(--text-secondary);">${clean(r.basis)}</p>`);
    }

    const Plugin = {
        init() { renderPanel(); },
        setupEvents(ctx) {
            const root = $("fdot-survey-panel");
            if (!root) return;
            root.addEventListener("input", e => { if (e.target && e.target.id === "fdot-fc-search") renderCodes(); });
            root.addEventListener("click", e => {
                const b = e.target.closest("button");
                if (!b) return;
                if (b.id === "fdot-fc-csv") {
                    const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
                    const csv = [["Feature Code", "Level Name", "Level Description", "Point / Line", "Zone"].map(q).join(",")]
                        .concat(FC.rows.map(r => [r.code, r.level, r.description, r.type, r.zone].map(q).join(","))).join("\r\n");
                    window.COGO.downloadText("fdot-survey-feature-codes-2025-04-24.csv", csv, "text/csv");
                } else if (b.id === "fdot-report-check") {
                    const t = ($("fdot-report-text") || {}).value || "";
                    if (!t.trim()) { ctx.showToast("Paste the report text, or pick a .docx / .txt.", true); return; }
                    showReport(t);
                }
            });
            root.addEventListener("change", async e => {
                const el = e.target, file = el && el.files && el.files[0];
                if (!file) return;
                try {
                    if (el.id === "fdot-points-file") {
                        const r = checkPointCodes(await file.text());
                        const known = r.codes.filter(c => c.known).length;
                        window.setSafeHTML($("fdot-check-results"), `<strong>${clean(file.name)}</strong>: ${r.points} point(s), ${r.codes.length} code(s) — ${known} FDOT, ${r.codes.length - known} not on the list.${list(r.findings)}`);
                    } else if (el.id === "fdot-dxf-file") {
                        const parsed = window.Jea24 ? window.Jea24.parseDxf(await file.text()) : null;
                        if (!parsed || parsed.error) throw new Error(parsed ? parsed.error : "The DXF reader is not loaded.");
                        const counts = new Map();
                        parsed.allEntities.forEach(en => counts.set(en.layer, (counts.get(en.layer) || 0) + 1));
                        const layers = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
                        const r = checkSurveyLevels(layers), nm = checkFdotLayerNames(layers);
                        window.setSafeHTML($("fdot-check-results"), `<strong>${clean(file.name)}</strong>:${list(r.findings.concat(nm.findings))}`);
                    } else if (el.id === "fdot-report-file") {
                        const text = /\.docx$/i.test(file.name) ? await docxText(await file.arrayBuffer()) : await file.text();
                        const area = $("fdot-report-text");
                        if (area) area.value = text;
                        showReport(text);
                    }
                } catch (err) {
                    ctx.showToast(`${file.name}: ${err.message}`, true);
                }
            });
        },
        onTabActivate() { if ($("fdot-survey-panel") && !$("fdot-fc-results")) renderPanel(); }
    };

    window.FdotSurvey = { lookup, search, checkPointCodes, checkSurveyLevels, checkFdotLayerNames, checkSurveyReport, docxText, REPORT_ITEMS };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);
})();
