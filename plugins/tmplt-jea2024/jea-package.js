/**
 * JEA As-Built package checks: reads the text of a drawing and checks it against itself and
 * against the As-Built workbook.
 *
 *  - collectDrawingText()  every TEXT / MTEXT / ATTRIB in model space, in each layout (paper space)
 *                          and in anonymous blocks (leaders and labels), with MTEXT codes removed
 *  - checkSheets()         per layout: AS-BUILT label, surveyor's and contractor's certification,
 *                          PSM number, JEA Availability / Project numbers, datum notes, SHEET x OF y,
 *                          and whether those agree across layouts. The fields are the ones OBSERVED
 *                          in sample JEA as-built packages, not a list taken from JEA's checklist.
 *  - georeference()        compares "N=… E=…" labels, and workbook IDs labelled in the drawing, with
 *                          where they sit — a drawing can be inside the FL East bounds and still be
 *                          shifted off State Plane.
 *  - reconcile()           every workbook ID vs. the drawing: in both / workbook only / drawing only /
 *                          ID variant (WWS10 ≈ WW10), and drawing table rows whose coordinates or
 *                          description disagree with the workbook.
 *
 * Pure functions (no DOM). Uses the shared resilient DXF tokenizer (plugins/dxf-auditor/dxf-parser.js).
 */
(function () {
    "use strict";

    // ── Text collection ──────────────────────────────────────────────────

    /** MTEXT inline codes → plain text ("\P" breaks, "\pxqc;" paragraphs, "{\fArial|b1;…}" fonts…). */
    function cleanMText(s) {
        return String(s == null ? "" : s)
            .replace(/\\[Pp](?![a-z0-9.,;-]*;)/g, " ")          // \P (and bare \p) = line break
            .replace(/\\[pfFHhCcTtQqWwAa][^;\\{}]*;/g, "")      // codes that run to a ';'
            .replace(/\\S([^;]*)[\^#/]([^;]*);/g, "$1/$2")      // stacked fractions
            .replace(/\\U\+([0-9A-Fa-f]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\[LlOoKkNX~]/g, " ")
            .replace(/\\\\/g, "\\")
            .replace(/[{}]/g, "")
            .replace(/%%[dD]/g, "°").replace(/%%[pP]/g, "±").replace(/%%[cC]/g, "Ø").replace(/%%%/g, "%")
            .replace(/\^[IJM]/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    /**
     * @returns {{ texts: Array<{type,text,e,n,height,layer,space,block,handle,placed}>, layouts: string[], xrefs: [{name, path}] }}
     *   space: "model" | "paper" (a layout — block names *Paper_Space…, or code 67 in ENTITIES)
     *        | "anon" (anonymous *U/*D… blocks — labels, leaders, dimensions)
     *        | "block" (named block definitions — title blocks and symbols; positions are local).
     *   Text in an anonymous block is placed where its block is used: through the INSERT's point,
     *   scale and rotation (relative to the block's base point), or as-is for a DIMENSION's block.
     *   An anonymous block used inside a layout makes its text part of that layout. If its use
     *   can't be found, placed is false and e/n are left unset rather than guessed.
     */
    function collectDrawingText(dxfString, prePairs) {
        if (typeof dxfString !== "string") throw new Error("collectDrawingText: DXF text expected.");
        const pairs = prePairs || window.FDOTDXFInspector.prototype.tokenizeDXF.call(null, dxfString);
        const raw = [];
        const xrefs = [];          // { name, path } — BLOCK records flagged as external references
        const bases = new Map();   // block name → { e, n }
        const uses = new Map();    // block name → first { kind, owner, e, n, sx, sy, rot }
        let section = null, sectionStart = false, block = null, cur = null;
        const owner = () => section === "BLOCKS" ? (/^\*Paper_Space/i.test(block || "") ? "paper:" + block : "block:" + block)
            : (cur && cur.paper ? "paper:*Paper_Space" : "model");
        const flush = () => {
            if (!cur) return;
            if (cur.type === "BLOCK" && cur.name) {
                bases.set(cur.name, { e: cur.e || 0, n: cur.n || 0 });
                if ((cur.flags || 0) & 4) xrefs.push({ name: cur.name, path: String(cur.raw || "").trim() });
            }
            else if ((cur.type === "INSERT" || cur.type === "DIMENSION") && cur.name && !uses.has(cur.name)) {
                uses.set(cur.name, { kind: cur.type, owner: owner(), e: cur.e || 0, n: cur.n || 0, sx: cur.sx || 1, sy: cur.sy || 1, rot: cur.rot || 0 });
            } else if (/^(TEXT|MTEXT|ATTRIB)$/.test(cur.type)) {
                const text = cur.type === "MTEXT" ? cleanMText(cur.raw) : String(cur.raw || "").replace(/%%[dD]/g, "°").trim();
                if (text) raw.push({ type: cur.type, text, e: cur.e, n: cur.n, height: cur.height, layer: cur.layer || "0", owner: owner(), handle: cur.handle || null });
            } else if (cur.type === "MULTILEADER" && cur.ml && cur.ml.text) {
                // A multileader's text points at something: its position is the arrowhead (first leader-line
                // vertex), else the landing, else where the text sits.
                const m = cur.ml, at = m.arrow || m.landing || m.textAt || {};
                const text = cleanMText(m.text);
                if (text) raw.push({ type: "MULTILEADER", text, e: at.e, n: at.n, height: m.height, layer: cur.layer || "0", owner: owner(), handle: cur.handle || null, textE: m.textAt && m.textAt.e, textN: m.textAt && m.textAt.n });
            }
        };
        for (const [code, val] of pairs) {
            if (code === 0 && val === "SECTION") { sectionStart = true; continue; }
            if (sectionStart) { sectionStart = false; if (code === 2) { flush(); cur = null; section = val; continue; } }
            if (code === 0) {
                flush();
                if (val === "ENDBLK") block = null;
                cur = { type: val, raw: "" };
                continue;
            }
            if (!cur) continue;
            if (cur.type === "MULTILEADER") {
                const m = cur.ml || (cur.ml = { where: "top" });
                if (code === 302 && /LEADER\{/.test(val)) m.where = "leader";
                else if (code === 304 && /LEADER_LINE\{/.test(val)) { m.where = "line"; m.lineStarted = false; }
                else if (code === 305) m.where = "leader";
                else if (code === 303) m.where = "context";
                else if (code === 300) m.where = "context";
                else if (code === 304 && m.text == null) m.text = val;
                else if (code === 41 && m.where === "context" && m.height == null) m.height = parseFloat(val);
                else if (code === 10 || code === 20) {
                    const k = code === 10 ? "e" : "n";
                    if (m.where === "line") { if (code === 10 && !m.arrow) m.arrow = {}; if (m.arrow && m.arrow[k] == null) m.arrow[k] = parseFloat(val); }
                    else if (m.where === "leader") { m.landing = m.landing || {}; if (m.landing[k] == null) m.landing[k] = parseFloat(val); }
                } else if ((code === 12 || code === 22) && m.where === "context") {
                    m.textAt = m.textAt || {}; m.textAt[code === 12 ? "e" : "n"] = parseFloat(val);
                } else if (code === 8) cur.layer = val;
                else if (code === 5) cur.handle = String(val).trim();
                else if (code === 67) cur.paper = String(val).trim() === "1";
                continue;
            }
            if (code === 2 && cur.type === "BLOCK") { block = val; cur.name = val; }
            else if (code === 70 && cur.type === "BLOCK") cur.flags = parseInt(val, 10) || 0;
            else if (code === 2 && (cur.type === "INSERT" || cur.type === "DIMENSION")) cur.name = val;
            else if (code === 8) cur.layer = val;
            else if (code === 5) cur.handle = String(val).trim();
            else if (code === 67) cur.paper = String(val).trim() === "1";
            else if (code === 1) cur.raw = cur.type === "MTEXT" ? cur.raw + val : val;
            else if (code === 3 && cur.type === "MTEXT") cur.raw += val;   // MTEXT continuation chunks
            else if (code === 10) cur.e = parseFloat(val);
            else if (code === 20) cur.n = parseFloat(val);
            else if (code === 40) cur.height = parseFloat(val);
            else if (code === 41 && cur.type === "INSERT") cur.sx = parseFloat(val);
            else if (code === 42 && cur.type === "INSERT") cur.sy = parseFloat(val);
            else if (code === 50 && cur.type === "INSERT") cur.rot = parseFloat(val);
        }
        flush();

        const texts = [];
        const layouts = new Set();
        raw.forEach(t => {
            let space, blk = null, e = t.e, n = t.n, placed = true;
            if (t.owner === "model") space = "model";
            else if (t.owner.startsWith("paper:")) { space = "paper"; blk = t.owner.slice(6); }
            else {
                blk = t.owner.slice(6);
                if (blk.charAt(0) !== "*") space = "block";
                else {
                    space = "anon";
                    const use = uses.get(blk);
                    if (use && use.owner.startsWith("paper:")) { space = "paper"; blk = use.owner.slice(6); }
                    else if (use && use.owner === "model" && use.kind === "INSERT" && isFinite(e) && isFinite(n)) {
                        const base = bases.get(t.owner.slice(6)) || { e: 0, n: 0 };
                        const r = use.rot * Math.PI / 180;
                        const lx = (e - base.e) * use.sx, ly = (n - base.n) * use.sy;
                        e = use.e + lx * Math.cos(r) - ly * Math.sin(r);
                        n = use.n + lx * Math.sin(r) + ly * Math.cos(r);
                    } else if (!(use && use.owner === "model" && use.kind === "DIMENSION")) {
                        placed = false; e = undefined; n = undefined;
                    }
                }
            }
            if (space === "paper") layouts.add(blk);
            const out = { type: t.type, text: t.text, e, n, height: t.height, layer: t.layer, space, block: blk, handle: t.handle, placed };
            if (t.textE != null && (space === "model" || space === "paper")) { out.textE = t.textE; out.textN = t.textN; }
            texts.push(out);
        });
        return { texts, layouts: Array.from(layouts), xrefs };
    }

    // ── Sheet / certification check ──────────────────────────────────────

    // What JEA requires on as-built sheets — JEA Water and Wastewater Standards (rev. Jan 1, 2026),
    // Vol. 1 Section 501 II.1.1–II.1.19 and the V.3 As-Built Submittal Requirements Check List.
    const SHEET_RULE_SOURCE = "JEA Water and Wastewater Standards (rev. Jan 1, 2026), §501 II.1 and the V.3 As-Built Submittal Check List";
    const SHEET_FIELDS = [
        { key: "asBuilt", label: "\"AS-BUILT\" or \"RECORD DRAWING\" label (§501 II.1.1)", re: /\bAS[- ]?BUILT\b|\bRECORD DRAWINGS?\b/i },
        { key: "surveyorCert", label: "surveyor's certification (5J-17.051/.052, §501 V.1)", re: /5J-17|472\.027|STANDARDS\s+OF\s+PRACTICE|MINIMUM\s+TECHNICAL\s+STANDARDS/i },
        { key: "psm", label: "PSM / LS licence number", re: /\b(?:PSM|P\.S\.M\.|PLS|L\.?S\.?)\s*(?:NO\.?|#|NUMBER)?\s*:?\s*(\d{4,5})\b/i, value: 1 },
        { key: "fieldDate", label: "date of field survey (§501 V.1)", re: /DATE\s+OF\s+(?:FIELD\s+)?SURVEY|FIELD\s+SURVEY\s+DATE/i },
        { key: "contractorCert", label: "contractor's certification and State Utilities License number (§501 V.1.3)", re: /CONTRACTOR'?S?\s+(?:STATE\s+(?:UTILITIES\s+)?)?(?:LICEN[CS]E|SIGNATURE|CERTIFICATION)/i },
        { key: "jeaNumber", label: "JEA Availability or Capital Project Number (§501 II.1.19)", re: /AVAILABILITY\s*(?:NO\.?|NUMBER|#)|(?:CAPITAL\s+)?PROJECT\s*(?:NO\.?|NUMBER|#)\s*:?\s*\d/i },
        { key: "graphicScale", label: "graphic scale (§501 II.1.2)", re: /GRAPHIC\s+SCALE|\bSCALE\s*:?\s*1\s*(?:"|IN(?:CH)?)?\s*=\s*\d+/i },
        { key: "availability", label: "JEA Availability number", re: /AVAILABILITY\s*(?:NO\.?|NUMBER|#)\s*:?\s*([0-9][0-9-]{3,})/i, value: 1 },
        { key: "jeaProject", label: "JEA Capital Project number", re: /JEA\s+(?:CAPITAL\s+)?PROJECT\s*(?:NO\.?|NUMBER|#)\s*:?\s*([0-9][0-9-]{3,})/i, value: 1 },
        { key: "datumH", label: "horizontal datum NAD 83 (§501 II.1.4)", re: /\bNAD\s*-?\s*(?:19)?83\b/i },
        { key: "datumV", label: "vertical datum NAVD 88 (§501 II.1.4)", re: /\bNAVD\s*-?\s*(?:19)?88\b/i },
        { key: "eastZone", label: "Florida East Zone (§501 II.1.4)", re: /FLORIDA\s+EAST|EAST\s+ZONE|\bFL\s+EAST\b|FIPS\s*0?901/i },
        { key: "vicinity", label: "vicinity map marked \"Project Location\" (§501 II.1.10)", re: /PROJECT\s+LOCATION|VICINITY\s+MAP/i },
        { key: "completionDate", label: "date of utility installation completion (§501 II.1.19)", re: /COMPLETION\s+DATE|DATE\s+OF\s+(?:UTILITY\s+)?(?:INSTALLATION\s+)?COMPLETION|INSTALLATION\s+COMPLET|UTILITY\s+COMPLETION/i },
        { key: "legend", label: "legend (§501 II.1.19)", re: /\bLEGEND\b/i },
        { key: "surveyorNotes", label: "surveyor notes (§501 II.1.19)", re: /SURVEYOR'?S?\s+(?:NOTES|REPORT)/i },
        { key: "generalNotes", label: "general notes (§501 II.1.19)", re: /GENERAL\s+NOTES/i }
    ];
    // On EVERY sheet (§501 II.1.1, II.1.2, II.1.19; V.3 "on each page").
    const SHEET_REQUIRED = ["asBuilt", "surveyorCert", "psm", "contractorCert", "jeaNumber", "graphicScale"];
    // On the cover sheet — so at least once in the drawing (§501 II.1.4, II.1.10, II.1.19; V.3 "As Built Cover Page").
    const PACKAGE_REQUIRED = ["datumH", "datumV", "eastZone", "vicinity", "completionDate", "legend", "surveyorNotes", "generalNotes", "fieldDate"];
    // Required, but drawn as symbols rather than text — reported as needing a visual check.
    const VISUAL_ONLY = ["north arrow (§501 II.1.3)", "title block (§501 II.1.19)", "match lines (§501 II.1.13)", "1-inch-high AS-BUILT lettering and 24\" × 36\" sheets (§501 II.1.1)"];

    function lev(a, b) {
        const m = a.length, n = b.length;
        const d = Array.from({ length: m + 1 }, (_, i) => [i].concat(new Array(n).fill(0)));
        for (let j = 1; j <= n; j++) d[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
        }
        return d[m][n];
    }

    /**
     * @param {{texts}} info  from collectDrawingText()
     * @returns {{ sheets: [{ layout, found: {key: [values]}, missing: [key] }], findings, basis }}
     */
    function checkSheets(info) {
        const findings = [];
        const flag = (severity, rule, where, message) => findings.push({ severity, rule, id: "", where, message });
        const groups = new Map();
        info.texts.forEach(t => {
            // A layout is a sheet; with no layouts at all, model space stands in for the one sheet.
            const key = t.space === "paper" ? t.block : null;
            if (key) (groups.get(key) || groups.set(key, []).get(key)).push(t);
        });
        if (!groups.size) groups.set("Model space", info.texts.filter(t => t.space === "model"));
        // Title-block text drawn inside a named block counts for every sheet that uses it.
        const blockText = info.texts.filter(t => t.space === "block").map(t => t.text).join(" \n ");

        const sheets = [];
        const sheetNos = [];
        const certifyTo = new Map();
        const names = new Map();
        groups.forEach((list, layout) => {
            if (!list.length) return;
            const all = list.map(t => t.text).join(" \n ");
            const hay = all + " \n " + blockText;
            const found = {};
            SHEET_FIELDS.forEach(f => {
                const vals = [];
                const re = new RegExp(f.re.source, "gi");
                let m;
                while ((m = re.exec(hay))) { vals.push(f.value ? m[f.value] : m[0]); if (m.index === re.lastIndex) re.lastIndex++; }
                if (vals.length) found[f.key] = Array.from(new Set(vals.map(v => String(v).toUpperCase())));
            });
            const missing = SHEET_REQUIRED.filter(k => !found[k]);
            const sheetRe = /\bSHEET\s+(\d+)\s+OF\s+(\d+)\b/gi;
            let m;
            const nums = [];
            while ((m = sheetRe.exec(all))) nums.push({ x: +m[1], y: +m[2] });
            if (nums.length) sheetNos.push({ layout, nums });
            const ct = /I\s+HEREBY\s+CERTIFY\s+TO:?\s*([^.;\n]{3,80}?)(?:\s+THAT\b|[.;\n]|$)/i.exec(all);
            if (ct) {
                const who = ct[1].replace(/\s+/g, " ").trim().toUpperCase();
                (certifyTo.get(who) || certifyTo.set(who, []).get(who)).push(layout);
            }
            const nameRe = /\b([A-Z][A-Z.'-]+(?:\s+[A-Z]\.?)?(?:\s+[A-Z][A-Z.'-]+){1,2}),?\s+(?:PSM|P\.S\.M\.)\b/g;
            const upper = hay.toUpperCase();
            while ((m = nameRe.exec(upper))) {
                const nm = m[1].replace(/^(?:BY|SURVEYOR|SIGNED|SEALED)\s+/, "").trim();
                (names.get(nm) || names.set(nm, new Set()).get(nm)).add(layout);
            }
            sheets.push({ layout, found, missing, textCount: list.length });
            if (missing.length) {
                flag("warning", "Sheet: missing field", layout, `no ${missing.map(k => SHEET_FIELDS.find(f => f.key === k).label).join(", ")} found on this layout.`);
            }
        });

        // Across the package — every text in the drawing (labels and notes in model space count too)
        const everything = info.texts.map(t => t.text).join(" \n ");
        PACKAGE_REQUIRED.forEach(k => {
            if (!sheets.some(s => s.found[k]) && !SHEET_FIELDS.find(f => f.key === k).re.test(everything)) {
                flag("warning", "Package: missing field", "All layouts", `no ${SHEET_FIELDS.find(f => f.key === k).label} found anywhere in the drawing.`);
            }
        });
        ["psm", "availability", "jeaProject"].forEach(k => {
            const vals = new Map();
            sheets.forEach(s => (s.found[k] || []).forEach(v => (vals.get(v) || vals.set(v, []).get(v)).push(s.layout)));
            if (vals.size > 1) {
                flag("warning", "Package: values disagree", "All layouts",
                    `${SHEET_FIELDS.find(f => f.key === k).label} differs between layouts: ${Array.from(vals.entries()).map(([v, l]) => `${v} (${l.length} layout${l.length === 1 ? "" : "s"})`).join(", ")}.`);
            }
        });
        if (certifyTo.size > 1) {
            flag("warning", "Package: certified to different parties", "All layouts",
                `layouts certify to ${certifyTo.size} different parties (${Array.from(certifyTo.keys()).slice(0, 4).join("; ")}${certifyTo.size > 4 ? "; …" : ""}) — the drawing may hold layouts from other jobs.`);
        }
        const nameList = Array.from(names.keys());
        for (let i = 0; i < nameList.length; i++) {
            for (let j = i + 1; j < nameList.length; j++) {
                const a = nameList[i], b = nameList[j];
                if (a !== b && lev(a, b) <= 2 && Math.min(a.length, b.length) >= 8) {
                    const [rare, common] = names.get(a).size <= names.get(b).size ? [a, b] : [b, a];
                    flag("warning", "Package: name spelled differently", Array.from(names.get(rare)).slice(0, 3).join(", "),
                        `"${rare}" here, "${common}" on ${names.get(common).size} layout(s).`);
                }
            }
        }
        const totals = new Set();
        sheetNos.forEach(s => s.nums.forEach(x => {
            totals.add(x.y);
            if (x.x > x.y || x.x < 1) flag("warning", "Sheet numbering", s.layout, `"SHEET ${x.x} OF ${x.y}" is not a valid sheet number.`);
        }));
        if (totals.size > 1) {
            flag("warning", "Sheet numbering", "All layouts", `sheet totals disagree: ${Array.from(totals).sort((a, b) => a - b).map(y => `"OF ${y}"`).join(", ")}.`);
        }
        const seen = new Map();
        sheetNos.forEach(s => s.nums.forEach(x => { const k = `${x.x}/${x.y}`; (seen.get(k) || seen.set(k, new Set()).get(k)).add(s.layout); }));
        seen.forEach((ls, k) => {
            if (ls.size > 1) flag("info", "Sheet numbering", Array.from(ls).slice(0, 3).join(", "), `"SHEET ${k.replace("/", " OF ")}" appears on ${ls.size} layouts.`);
        });
        return {
            sheets,
            findings,
            totals: Array.from(totals).sort((a, b) => a - b),
            visualOnly: VISUAL_ONLY,
            basis: `${SHEET_RULE_SOURCE}. Text is read from each layout; a record drawing (minor maintenance work) carries the JEA project manager's certification instead of the surveyor's and contractor's (§501 I.5.2, V.1.4).`
        };
    }

    // ── Georeference ─────────────────────────────────────────────────────

    const NE_RE = /\bN\s*[=:]\s*(\d{6,7}(?:\.\d+)?)\D{1,12}?E\s*[=:]\s*(\d{5,6}(?:\.\d+)?)/i;
    const EN_RE = /\bE\s*[=:]\s*(\d{5,6}(?:\.\d+)?)\D{1,12}?N\s*[=:]\s*(\d{6,7}(?:\.\d+)?)/i;

    function median(arr) {
        const v = arr.slice().sort((a, b) => a - b);
        const m = v.length >> 1;
        return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
    }

    /** Groups offsets that agree within tol, largest group first: [{ dE, dN, support }]. */
    function clusters(offsets, tol) {
        let left = offsets.slice();
        const out = [];
        while (left.length) {
            const c = consensus(left, tol);
            const members = left.filter(p => Math.hypot(p.dE - c.dE, p.dN - c.dN) <= tol);
            if (!members.length) break;
            out.push({ dE: c.dE, dN: c.dN, support: members.length });
            left = left.filter(p => !members.includes(p));
        }
        return out;
    }

    /** True when the text has two or more same-layer texts beside it on its line — a table cell. */
    function isTableCell(t, all) {
        const h = isFinite(t.height) && t.height > 0 ? t.height : 1;
        let k = 0;
        for (const o of all) {
            if (o !== t && o.layer === t.layer && Math.abs(o.n - t.n) <= 0.6 * h && Math.abs(o.e - t.e) <= 60 * h && ++k >= 2) return true;
        }
        return false;
    }

    /** The offset most other offsets agree with (within tol), with its support. */
    function consensus(offsets, tol) {
        let best = null;
        offsets.forEach(o => {
            const near = offsets.filter(p => Math.hypot(p.dE - o.dE, p.dN - o.dN) <= tol);
            if (!best || near.length > best.near.length) best = { near };
        });
        if (!best) return null;
        return { dE: median(best.near.map(p => p.dE)), dN: median(best.near.map(p => p.dN)), support: best.near.length, of: offsets.length };
    }

    /**
     * @param {{texts}} info  from collectDrawingText()
     * @param {Array} [structures]  workbook structures ({ id, e, n }) — optional
     * @returns {{ shift: {dE,dN,distance,support,of,source}|null, findings }}
     */
    function georeference(info, structures, opts) {
        const tolFt = (opts && opts.tolFt) || 1.0;
        const findings = [];
        const flag = (severity, rule, id, where, message) => findings.push({ severity, rule, id, where, message });
        const placed = info.texts.filter(t => (t.space === "model" || t.space === "anon") && isFinite(t.e) && isFinite(t.n));

        // 1. Coordinate labels: the text says where it is.
        const labels = [];
        placed.forEach(t => {
            let m = NE_RE.exec(t.text), N, E;
            if (m) { N = +m[1]; E = +m[2]; } else if ((m = EN_RE.exec(t.text))) { E = +m[1]; N = +m[2]; }
            if (N != null) labels.push({ t, dE: E - t.e, dN: N - t.n, E, N });
        });
        // 2. Workbook IDs labelled in the drawing — callouts only; a table cell sits nowhere near its point.
        const idOffsets = [];
        if (structures && structures.length) {
            const byId = new Map(structures.map(s => [normId(s.id), s]));
            const near = placed.filter(t => byId.has(normId(t.text)));
            near.forEach(t => {
                if (isTableCell(t, placed)) return;
                const s = byId.get(normId(t.text));
                idOffsets.push({ t, s, dE: s.e - t.e, dN: s.n - t.n });
            });
        }

        // Each source is grouped into offsets that agree: coordinate labels within 5 ft, callouts within
        // 25 ft (a leader's length). Several groups mean the plan is drawn more than once at different
        // positions (e.g. once per sheet) — each group is reported.
        const groups = [];
        [[labels, 5, "coordinate labels"], [idOffsets, 25, "labelled workbook IDs"]].forEach(([list, tol, source]) => {
            clusters(list, tol).filter(c => c.support >= 3).forEach(c => groups.push(Object.assign(c, { of: list.length, source, distance: Math.hypot(c.dE, c.dN) })));
        });
        groups.sort((a, b) => b.support - a.support);
        const shift = groups[0] || null;
        const fmt = g => `ΔE ${g.dE.toFixed(2)} ft, ΔN ${g.dN.toFixed(2)} ft (${Math.round(g.distance).toLocaleString("en-US")} ft) — ${g.support} of ${g.of} ${g.source}`;
        if (shift) {
            const onSpc = groups.filter(g => g.distance <= tolFt), off = groups.filter(g => g.distance > tolFt);
            if (!off.length) {
                flag("info", "Drawing on State Plane", "", "Model space", `${onSpc.map(g => `${g.support} of ${g.of} ${g.source}`).join(" and ")} agree with their position within ${tolFt} ft.`);
            } else if (!onSpc.length) {
                flag("error", "Drawing not on State Plane", "", "Model space",
                    `the plan is shifted from FL East State Plane: ${fmt(off[0])}.${off.length > 1 ? ` ${off.length - 1} more group(s) of labels sit at other offsets (${off.slice(1, 3).map(fmt).join("; ")}) — the plan seems to be drawn more than once (e.g. per sheet).` : ""} Move it onto State Plane, or confirm the shift is intended, before submitting.`);
            } else {
                flag("warning", "Drawing partly on State Plane", "", "Model space",
                    `${onSpc.map(g => `${g.support} ${g.source}`).join(", ")} sit on State Plane, but ${off.map(fmt).join("; ")}.`);
            }
            const stray = labels.length - groups.filter(g => g.source === "coordinate labels").reduce((n, g) => n + g.support, 0);
            if (stray > 0) {
                flag("info", "Coordinate labels away from their point", "", "Model space",
                    `${stray} of ${labels.length} coordinate label(s) don't agree with any group of 3 or more — details or insets drawn out of place, or labels with the wrong numbers.`);
            }
        } else if (labels.length || idOffsets.length) {
            flag("info", "Georeference not determined", "", "Model space",
                `${labels.length} coordinate label(s) and ${idOffsets.length} labelled ID callout(s) found, but no 3 of them agree on one position.`);
        } else {
            flag("info", "Georeference not determined", "", "Model space", "no coordinate labels or labelled workbook IDs to check the drawing's position against.");
        }
        if (shift) shift.groups = groups;
        return { shift, findings };
    }

    // ── Workbook ↔ drawing reconciliation ────────────────────────────────

    const normId = s => String(s == null ? "" : s).toUpperCase().replace(/[\s_-]+/g, "");
    const splitId = id => { const m = /^([A-Z]+)(\d+[A-Z]?)$/.exec(normId(id)); return m ? { prefix: m[1], num: m[2] } : null; };

    // Words that name what a structure IS (abbreviations mapped to one form). A drawing table row and
    // the workbook are only compared on these — manufacturer, direction and notes columns would
    // otherwise always "disagree".
    const TYPE_WORDS = {
        VALVE: "VALVE", VLV: "VALVE", GATE: "GATE", BUTTERFLY: "BUTTERFLY", CHECK: "CHECK", PLUG: "PLUG",
        TEE: "TEE", CROSS: "CROSS", BEND: "BEND", ELBOW: "BEND", ELL: "BEND", REDUCER: "REDUCER", RED: "REDUCER",
        SLEEVE: "SLEEVE", COUPLING: "COUPLING", CAP: "CAP", TAP: "TAP", WYE: "WYE",
        HYDRANT: "HYDRANT", HYD: "HYDRANT", FH: "HYDRANT", MANHOLE: "MANHOLE", MH: "MANHOLE",
        WIRE: "WIRE", METER: "METER", PUMP: "PUMP", FLUSH: "FLUSH", FLUSHING: "FLUSH", BLOWOFF: "BLOWOFF",
        ARV: "AIR", AIR: "AIR", BACKFLOW: "BACKFLOW", RPZ: "BACKFLOW", FDC: "FDC", STUB: "STUB", CLEANOUT: "CLEANOUT"
    };
    const typeWords = str => new Set(String(str).toUpperCase().split(/[^A-Z]+/).map(w => TYPE_WORDS[w]).filter(Boolean));

    /**
     * @param {{model:{structures}}} wb  from JeaXlsx.importWorkbook / workbookToModel
     * @param {{texts}} info  from collectDrawingText()
     * @param {object} [opts]  { coordTolFt (default 0.05) }
     * @returns {{ rows: [{ id, status, drawingId?, where? }], counts, findings }}
     */
    function reconcile(wb, info, opts) {
        opts = opts || {};
        const tol = opts.coordTolFt || 0.05;
        const findings = [];
        const flag = (severity, rule, id, where, message) => findings.push({ severity, rule, id, where, message });
        const structures = (wb && wb.model && wb.model.structures) || [];
        // Two workbook IDs can normalise alike ("SS MH" and "SSMH"): keep every structure per key.
        const wbIds = new Map();
        structures.forEach(s => { const k = normId(s.id); (wbIds.get(k) || wbIds.set(k, []).get(k)).push(s); });
        const prefixes = new Set();
        structures.forEach(s => { const p = splitId(s.id); if (p) prefixes.add(p.prefix); });
        const cellOf = s => `${s.source.sheet}!A${s.source.row}`;

        // IDs in the drawing: any token whose prefix is a workbook prefix, or one letter longer (WWS ← WW).
        const texts = info.texts.filter(t => t.space !== "block");
        const tokenRe = /\b([A-Z]{1,5})\s?-?(\d{1,4}[A-Z]?)\b/g;
        const dwg = new Map(); // normalised drawing id → [texts]
        const prefixOk = p => prefixes.has(p) || Array.from(prefixes).some(q => p.length === q.length + 1 && p.startsWith(q));
        const multiWord = structures.filter(s => !splitId(s.id) && /\s/.test(String(s.id)));
        texts.forEach(t => {
            const up = t.text.toUpperCase();
            let m;
            tokenRe.lastIndex = 0;
            while ((m = tokenRe.exec(up))) {
                if (!prefixOk(m[1])) continue;
                const id = m[1] + m[2];
                (dwg.get(id) || dwg.set(id, []).get(id)).push(t);
            }
            multiWord.forEach(s => { if (up.includes(String(s.id).toUpperCase())) { const k = normId(s.id); (dwg.get(k) || dwg.set(k, []).get(k)).push(t); } });
            const whole = normId(up); // an ID cell written without a recognisable prefix/number split ("SSMH")
            if (wbIds.has(whole) && !dwg.has(whole)) dwg.set(whole, [t]);
        });

        const rows = [];
        const usedDwg = new Set();
        const variantOf = new Map(); // drawing id → workbook key
        wbIds.forEach((list, k) => {
            list.forEach(s => {
                if (dwg.has(k)) { rows.push({ id: s.id, status: "both" }); usedDwg.add(k); return; }
                const p = splitId(s.id);
                const variant = p && Array.from(dwg.keys()).find(d => {
                    const q = splitId(d);
                    return q && q.num === p.num && q.prefix.length === p.prefix.length + 1 && q.prefix.startsWith(p.prefix) && !wbIds.has(d);
                });
                if (variant) {
                    rows.push({ id: s.id, status: "variant", drawingId: variant });
                    usedDwg.add(variant); variantOf.set(variant, k);
                    flag("warning", "ID written differently", s.id, cellOf(s), `the drawing calls it ${variant}.`);
                } else {
                    rows.push({ id: s.id, status: "workbook only" });
                    flag("warning", "In workbook, not in drawing", s.id, cellOf(s), "no text in the drawing names this ID.");
                }
            });
        });
        dwg.forEach((list, k) => {
            if (usedDwg.has(k)) return;
            const p = splitId(k);
            if (!p || !prefixes.has(p.prefix)) return; // a variant prefix with no workbook counterpart is not an ID we know
            const t = list[0];
            const where = t.space === "paper" ? t.block : (t.handle ? `handle ${t.handle}` : `layer ${t.layer}`);
            rows.push({ id: k, status: "drawing only", where });
            flag("warning", "In drawing, not in workbook", k, where, `the drawing names ${k} (${list.length} time${list.length === 1 ? "" : "s"}) but the workbook has no row for it.`);
        });

        // Table rows: an ID cell and the cells to its right on the same line, on the cell's own layer.
        const placed = texts.filter(t => t.space !== "paper" && isFinite(t.e) && isFinite(t.n));
        const rowsSeen = new Set();
        placed.forEach(cell => {
            const id = normId(cell.text);
            const cands = wbIds.get(id) || wbIds.get(variantOf.get(id)) || null;
            if (!cands) return;
            const h = isFinite(cell.height) && cell.height > 0 ? cell.height : 1;
            const line = placed.filter(t => t !== cell && t.layer === cell.layer && t.block === cell.block &&
                Math.abs(t.n - cell.n) <= 0.6 * h && t.e > cell.e && t.e - cell.e <= 60 * h).sort((a, b) => a.e - b.e);
            if (line.length < 2) return; // a callout, not a table row
            const nums = line.map(t => t.text.replace(/[,']/g, "")).filter(x => /^-?\d+(\.\d+)?$/.test(x)).map(Number);
            const N = nums.find(v => v >= 1.9e6 && v <= 2.4e6), E = nums.find(v => v >= 3e5 && v <= 6e5);
            const desc = line.map(t => t.text).join(" ");
            const key = `${id}|${N}|${E}|${desc}`;
            if (rowsSeen.has(key)) return; // the same table drawn again (another viewport / sheet copy)
            rowsSeen.add(key);
            // with two workbook structures behind one key, compare against the one this row matches best
            const s = cands.slice().sort((a, b) => Math.hypot((E ?? a.e) - a.e, (N ?? a.n) - a.n) - Math.hypot((E ?? b.e) - b.e, (N ?? b.n) - b.n))[0];
            const at = cell.handle ? `handle ${cell.handle}` : `layer ${cell.layer}`;
            if (N != null && Math.abs(N - s.n) > tol) flag("error", "Drawing table disagrees", s.id, cellOf(s), `drawing table (${at}) has N ${N}, workbook ${s.n} (Δ ${(N - s.n).toFixed(2)} ft).`);
            if (E != null && Math.abs(E - s.e) > tol) flag("error", "Drawing table disagrees", s.id, cellOf(s), `drawing table (${at}) has E ${E}, workbook ${s.e} (Δ ${(E - s.e).toFixed(2)} ft).`);
            const a = typeWords(desc);
            const b = typeWords([s.attribs.SUBTYPE, s.attribs.VALVE_TYPE, s.block.replace("JEA_", "").replace("_", " ")].filter(Boolean).join(" "));
            if (a.size && b.size && ![...a].some(w => b.has(w))) {
                flag("info", "Described differently", s.id, cellOf(s), `drawing table (${at}) says ${[...a].join("/")}; workbook says ${[...b].join("/")}.`);
            }
        });
        const counts = rows.reduce((c, r) => { c[r.status] = (c[r.status] || 0) + 1; return c; }, {});
        return { rows, counts, findings };
    }

    // ── Pipe-length labels vs the drawn runs ─────────────────────────────

    /**
     * "43.1 LF", "±293 LF 2\" POLY" labels vs the pipe run they sit on (from Jea24.extractPipeNetwork).
     * A label usually names one piece between fittings, and a fitting can sit anywhere along a drawn
     * segment, so a label SHORTER than the run can't be checked. What can: a label within 5 ft of a run
     * whose WHOLE length is shorter than the label — the label or the linework is wrong. "±" labels
     * get 10%, others 2% (at least 1 ft).
     * @returns {{ findings, counts: { labels, nearRun, agree, cannotCheck, longer } }}
     */
    function checkPipeLabels(info, network) {
        const findings = [];
        const len = r => r.reduce((s, v, i) => i ? s + Math.hypot(v.e - r[i - 1].e, v.n - r[i - 1].n) : 0, 0);
        // a "run" under 5 ft is a fitting or symbol drawn on the pipe layer, not a pipe
        const runs = ((network && network.model && network.model.pipes) || []).map(p => p.points).filter(r => r.length >= 2 && len(r) >= 5);
        const counts = { labels: 0, nearRun: 0, agree: 0, cannotCheck: 0, longer: 0 };
        info.texts.forEach(t => {
            if (t.space === "paper" || t.space === "block" || !isFinite(t.e) || !isFinite(t.n)) return;
            const m = /(±|\+\/-)?\s*(\d+(?:\.\d+)?)\s*(?:LF|L\.F\.)(?![A-Z])/i.exec(t.text);
            if (!m) return;
            counts.labels++;
            const L = +m[2], approx = !!m[1];
            let best = null;
            runs.forEach(r => {
                for (let i = 0; i < r.length - 1; i++) {
                    const a = r[i], b = r[i + 1], dx = b.e - a.e, dy = b.n - a.n, l2 = dx * dx + dy * dy || 1;
                    const u = Math.max(0, Math.min(1, ((t.e - a.e) * dx + (t.n - a.n) * dy) / l2));
                    const d = Math.hypot(a.e + u * dx - t.e, a.n + u * dy - t.n);
                    if (!best || d < best.d) best = { d, r };
                }
            });
            if (!best || best.d > 5) return;
            counts.nearRun++;
            const tol = Math.max(1, (approx ? 0.10 : 0.02) * L);
            const r = best.r, cum = [0];
            for (let i = 1; i < r.length; i++) cum.push(cum[i - 1] + Math.hypot(r[i].e - r[i - 1].e, r[i].n - r[i - 1].n));
            let agree = false;
            for (let i = 0; i < r.length && !agree; i++) for (let j = i + 1; j < r.length; j++) if (Math.abs(cum[j] - cum[i] - L) <= tol) { agree = true; break; }
            const total = len(r);
            if (agree) counts.agree++;
            else if (L > total + tol) {
                counts.longer++;
                findings.push({ severity: "warning", rule: "Pipe label longer than the run", id: "", where: t.handle ? `handle ${t.handle}` : `layer ${t.layer}`,
                    message: `"${t.text.slice(0, 60)}" says ${L} LF, but the drawn run it sits on is ${total.toFixed(1)} ft long — check the label, the linework, or whether it belongs to another pipe.` });
            } else counts.cannotCheck++;
        });
        if (counts.labels) {
            findings.push({ severity: "info", rule: "Pipe-length labels", id: "", where: "Model space",
                message: `${counts.labels} length label(s); ${counts.nearRun} on a drawn pipe run: ${counts.agree} agree with a stretch of it between two vertices, ${counts.longer} longer than the whole run, ${counts.cannotCheck} that can't be checked (a piece ending between drawn vertices).` });
        }
        return { findings, counts };
    }

    // ── Pipe geometry helpers ────────────────────────────────────────────
    const segDist = (p, a, b) => {
        const dx = b.e - a.e, dy = b.n - a.n, l2 = dx * dx + dy * dy || 1e-12;
        const u = Math.max(0, Math.min(1, ((p.e - a.e) * dx + (p.n - a.n) * dy) / l2));
        return { d: Math.hypot(a.e + u * dx - p.e, a.n + u * dy - p.n), u };
    };
    const runLength = pts => pts.reduce((s0, v, i) => i ? s0 + Math.hypot(v.e - pts[i - 1].e, v.n - pts[i - 1].n) : 0, 0);
    /** Station along a run of the point's projection, and its offset from the run. */
    function station(pts, p) {
        let best = null, acc = 0;
        for (let i = 0; i + 1 < pts.length; i++) {
            const L = Math.hypot(pts[i + 1].e - pts[i].e, pts[i + 1].n - pts[i].n), r = segDist(p, pts[i], pts[i + 1]);
            if (!best || r.d < best.d) best = { d: r.d, sta: acc + r.u * L };
            acc += L;
        }
        return best;
    }
    /** Points every `step` ft along a run (from its start, plus its end), with their station. */
    function samples(pts, step) {
        const out = [];
        let acc = 0, next = 0;
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], b = pts[i + 1], L = Math.hypot(b.e - a.e, b.n - a.n);
            for (; next <= acc + L + 1e-9; next += step) {
                const t = L ? (next - acc) / L : 0;
                out.push({ e: a.e + (b.e - a.e) * t, n: a.n + (b.n - a.n) * t, sta: next });
            }
            acc += L;
        }
        if (!out.length || acc - out[out.length - 1].sta > 1e-6) { const z = pts[pts.length - 1]; out.push({ e: z.e, n: z.n, sta: acc }); }
        return out;
    }

    // ── Recorded points along pressure mains (§501 III.1.3) ──────────────

    /**
     * "Coordinates and elevations on the main and finished grade will be required at all pipe dead ends,
     * size changes, points of connection …, fittings, valves, meter boxes, at intersections/crossings
     * of pipes, and at 100' maximum intervals" — JEA Standards 2026 §501 III.1.3. For each pressure main
     * drawn in the DXF, the workbook's recorded points within `nearFt` of it are put in station order and
     * gaps longer than `maxGapFt` reported. Needs the drawing and the workbook in the same coordinates.
     * @returns {{ findings, runs: [{ id, layer, length, points, maxGap }] }}
     */
    function checkPointSpacing(network, wbModel, opts) {
        opts = opts || {};
        const maxGap = opts.maxGapFt || 100, near = opts.nearFt || 5;
        const findings = [];
        const flag = (severity, rule, id, where, message) => findings.push({ severity, rule, id, where, message });
        const pressure = ((network && network.model && network.model.pipes) || []).filter(p => /^(W-MAIN|RW-MAIN|SS-FM)$/.test(p.layer) && p.points.length >= 2);
        const pts = []
            .concat(((wbModel && wbModel.structures) || []).filter(s => /JEA_(FITTING|VALVE|HYDRANT|METER)/.test(s.block)))
            .concat((wbModel && wbModel.crossings) || [], (wbModel && wbModel.pipePoints) || []);
        if (!pressure.length || !pts.length) {
            flag("info", "Point spacing not checked", "", "Drawing", !pressure.length ? "no pressure mains (water, reclaimed or force main layers) in the drawing." : "the workbook has no fittings, valves, hydrants, meters, crossings or points along pipe.");
            return { findings, runs: [] };
        }
        const onPipe = pts.filter(p => pressure.some(r => { const st = station(r.points, p); return st && st.d <= near; })).length;
        if (onPipe < 0.3 * pts.length) {
            flag("info", "Point spacing not checked", "", "Drawing", `only ${onPipe} of ${pts.length} workbook points sit within ${near} ft of a drawn pressure main — the drawing isn't in the workbook's coordinates (or is another job), so spacing can't be measured.`);
            return { findings, runs: [] };
        }
        const runs = [];
        pressure.forEach(r => {
            const L = runLength(r.points);
            if (L < maxGap) return;
            const st = pts.map(p => ({ p, s: station(r.points, p) })).filter(x => x.s && x.s.d <= near).map(x => ({ id: x.p.id, sta: x.s.sta })).sort((a, b) => a.sta - b.sta);
            const chain = [{ id: "start of run", sta: 0 }].concat(st, [{ id: "end of run", sta: L }]);
            let worst = { gap: 0 };
            for (let i = 1; i < chain.length; i++) {
                const gap = chain[i].sta - chain[i - 1].sta;
                if (gap > worst.gap) worst = { gap, a: chain[i - 1], b: chain[i] };
                if (gap > maxGap + 0.5) {
                    flag("warning", "Recorded points more than 100 ft apart", r.id, r.handle ? `handle ${r.handle}` : `layer ${r.sourceLayer || r.layer}`,
                        `${gap.toFixed(0)} ft between ${chain[i - 1].id} and ${chain[i].id} along this ${r.layer} run (stations ${chain[i - 1].sta.toFixed(0)}–${chain[i].sta.toFixed(0)}); JEA asks for a point at least every 100 ft (§501 III.1.3).`);
                }
            }
            const noEnd = ["start of run", "end of run"].filter(e => !st.some(x => Math.abs(x.sta - (e === "start of run" ? 0 : L)) <= near));
            if (noEnd.length) flag("info", "Run end without a recorded point", r.id, r.handle ? `handle ${r.handle}` : `layer ${r.layer}`, `no recorded point at the ${noEnd.join(" or ")} — a dead end or connection needs one (§501 III.1.3).`);
            runs.push({ id: r.id, layer: r.layer, length: L, points: st.length, maxGap: worst.gap });
        });
        flag("info", "Point spacing", "", "Drawing", `${runs.length} pressure run(s) of 100 ft or more checked against ${onPipe} recorded point(s) on them.`);
        return { findings, runs };
    }

    // ── Horizontal separation (§350 III.4.2–III.4.3) ─────────────────────

    /**
     * Water mains (W-MAIN) against sanitary gravity sewers (SS-GRAV) and force mains (SS-FM) — at least
     * 6 ft, preferably 10 ft (§350 III.4.3) — and reclaimed water (RW-MAIN) — at least 3 ft if it is
     * regulated under Part III of 62.610, F.A.C., otherwise 6 ft (§350 III.4.2–III.4.3). Distances are
     * between the drawn centerlines, so a centerline closer than the minimum is a definite violation
     * (outside-to-outside is closer still); stretches within 10 ft of where the pipes cross are skipped.
     * @returns {{ findings, pairs }}
     */
    function checkHorizontalSeparation(network, opts) {
        opts = opts || {};
        const step = opts.stepFt || 5, skip = opts.crossingSkipFt || 10;
        const findings = [];
        const pipes = ((network && network.model && network.model.pipes) || []).filter(p => p.points.length >= 2);
        const water = pipes.filter(p => p.layer === "W-MAIN");
        const others = pipes.filter(p => /^(SS-GRAV|SS-FM|RW-MAIN)$/.test(p.layer));
        const need = { "SS-GRAV": { min: 6, pref: 10, rule: "III.4.3" }, "SS-FM": { min: 6, pref: 10, rule: "III.4.3" }, "RW-MAIN": { min: 3, pref: null, rule: "III.4.2", note: "3 ft if the reclaimed main is regulated under Part III of 62.610, F.A.C.; 6 ft if not (III.4.3)" } };
        const segs = p => p.points.slice(1).map((b, i) => [p.points[i], b]);
        const intersections = (A, B) => {
            const out = [];
            segs(A).forEach(([a, b]) => segs(B).forEach(([c, d]) => {
                const r = (b.e - a.e) * (d.n - c.n) - (b.n - a.n) * (d.e - c.e);
                if (Math.abs(r) < 1e-12) return;
                const t = ((c.e - a.e) * (d.n - c.n) - (c.n - a.n) * (d.e - c.e)) / r, u = ((c.e - a.e) * (b.n - a.n) - (c.n - a.n) * (b.e - a.e)) / r;
                if (t >= 0 && t <= 1 && u >= 0 && u <= 1) out.push({ e: a.e + t * (b.e - a.e), n: a.n + t * (b.n - a.n) });
            }));
            return out;
        };
        let pairs = 0;
        water.forEach(W => {
            const ws = samples(W.points, step);
            others.forEach(O => {
                const req = need[O.layer];
                // quick reject: boxes farther apart than the minimum
                const box = P => P.points.reduce((b, v) => [Math.min(b[0], v.e), Math.min(b[1], v.n), Math.max(b[2], v.e), Math.max(b[3], v.n)], [Infinity, Infinity, -Infinity, -Infinity]);
                const bw = box(W), bo = box(O);
                if (bw[0] - req.min > bo[2] || bo[0] - req.min > bw[2] || bw[1] - req.min > bo[3] || bo[1] - req.min > bw[3]) return;
                pairs++;
                const xs = intersections(W, O);
                const close = ws.map(p => {
                    if (xs.some(x => Math.hypot(x.e - p.e, x.n - p.n) <= skip)) return null;
                    let d = Infinity;
                    segs(O).forEach(([a, b]) => { d = Math.min(d, segDist(p, a, b).d); });
                    return d < req.min - 1e-9 ? { sta: p.sta, d } : null;
                });
                // merge consecutive close samples into stretches
                let run = null;
                const stretches = [];
                close.forEach((c, i) => {
                    if (c) { if (!run) run = { from: c.sta, to: c.sta, dmin: c.d }; else { run.to = c.sta; run.dmin = Math.min(run.dmin, c.d); } }
                    if ((!c || i === close.length - 1) && run) { stretches.push(run); run = null; }
                });
                stretches.forEach(st => {
                    findings.push({ severity: "warning", rule: "Horizontal separation", id: W.id, where: W.handle ? `handle ${W.handle}` : `layer ${W.sourceLayer || W.layer}`,
                        message: `the water main is ${st.dmin.toFixed(1)} ft (centerline) from ${O.layer} ${O.id} for about ${Math.max(step, st.to - st.from).toFixed(0)} ft (stations ${st.from.toFixed(0)}–${st.to.toFixed(0)}); JEA requires at least ${req.min} ft${req.pref ? `, preferably ${req.pref} ft` : ""} (§350 ${req.rule}${req.note ? "; " + req.note : ""}).` });
                });
            });
        });
        findings.push({ severity: "info", rule: "Horizontal separation", id: "", where: "Drawing",
            message: water.length ? `${water.length} water main run(s) checked against ${pairs} nearby sewer / force main / reclaimed run(s) (centerlines; JEA §350 III.4.2–III.4.3). Storm drains, structures (§350 III.4.10) and the 3 ft gravity-sewer exception (water 6 in above) aren't checked.` : "no water mains (W-MAIN) in the drawing — horizontal separation not checked." });
        return { findings, pairs };
    }

    // ── Package files: PDF page count, eTransmit transmittal ─────────────

    async function inflateZlib(bytes) {
        if (typeof DecompressionStream !== "function") return null;
        try {
            const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")));
            return new Uint8Array(await out.arrayBuffer());
        } catch (e) { return null; } // a stream that isn't plain zlib (other filters, encryption)
    }

    /**
     * Pages in a PDF, without a PDF library: page objects ("/Type /Page") counted in the file, and,
     * when they're packed inside compressed object streams, in those streams once inflated.
     * @returns {Promise<{ pages: number|null, method: string }>}  pages null = could not be determined
     */
    async function pdfPageCount(buf) {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        const latin = bytes => { let s0 = ""; for (let i = 0; i < bytes.length; i += 8192) s0 += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); return s0; };
        const txt = latin(u8);
        if (!/^%PDF-/.test(txt)) throw new Error("Not a PDF file.");
        const encrypted = /\/Encrypt\b/.test(txt);
        // the file's own text plus every compressed object stream, inflated
        let all = txt;
        const directPages = (txt.match(/\/Type\s*\/Page(?![A-Za-z])/g) || []).length;
        const streamRe = /\/Type\s*\/ObjStm[\s\S]*?stream\r?\n/g;
        let m;
        while (!encrypted && (m = streamRe.exec(txt))) {
            const start = m.index + m[0].length;
            let end = txt.indexOf("endstream", start);
            if (end < 0) break;
            // The data is /Length bytes long; the line break before "endstream" is not part of it
            // (newer decompressors refuse trailing bytes).
            const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(m[0]);
            if (len && start + Number(len[1]) <= end) end = start + Number(len[1]);
            else while (end > start && (u8[end - 1] === 10 || u8[end - 1] === 13)) end--;
            const inflated = await inflateZlib(u8.subarray(start, end));
            if (inflated) all += "\n" + latin(inflated);
        }
        if (encrypted) return { pages: null, method: "encrypted — page count not readable", sizes: [], signatures: null };
        // page objects: "/Type /Page" (not /Pages). Each page's own dictionary is found by matching << >>
        // outward from the marker; its MediaBox (or, failing that, the page tree's) gives the sheet size.
        const dictAround = pos => {
            let i = pos, depth = 0, start = -1;
            while (i > 0) {
                if (all.startsWith(">>", i - 1) && i - 1 < pos) { depth++; i -= 2; continue; }
                if (all.startsWith("<<", i - 1)) { if (depth === 0) { start = i - 1; break; } depth--; i -= 2; continue; }
                i--;
            }
            if (start < 0) return "";
            let j = start, d = 0;
            while (j < all.length - 1) {
                if (all.startsWith("<<", j)) { d++; j += 2; continue; }
                if (all.startsWith(">>", j)) { d--; j += 2; if (d === 0) break; continue; }
                j++;
            }
            return all.slice(start, j);
        };
        const boxOf = d0 => {
            const mb = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(d0);
            return mb ? [Number(mb[3]) - Number(mb[1]), Number(mb[4]) - Number(mb[2])] : null;
        };
        const pageRe = /\/Type\s*\/Page(?![A-Za-z])/g;
        const treeRe = /\/Type\s*\/Pages\b/g;
        let tm, treeBox = null;
        while (!treeBox && (tm = treeRe.exec(all))) treeBox = boxOf(dictAround(tm.index));
        const sizes = [];
        let pm, pages = 0;
        while ((pm = pageRe.exec(all))) {
            pages++;
            const d0 = dictAround(pm.index);
            const box = boxOf(d0) || treeBox;
            if (!box) continue;
            const rot = Number((/\/Rotate\s+(-?\d+)/.exec(d0) || [])[1] || 0);
            let [w, h] = [box[0] / 72, box[1] / 72];
            if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
            sizes.push({ w: Number(w.toFixed(2)), h: Number(h.toFixed(2)) });
        }
        // digital signatures: signature fields (/FT /Sig); a signed one has a /ByteRange in its value
        const fields = (all.match(/\/FT\s*\/Sig\b/g) || []).length;
        const names = [];
        let signed = 0, br;
        const brRe = /\/ByteRange\s*\[/g;
        while ((br = brRe.exec(all))) {
            signed++;
            const end = all.indexOf("endobj", br.index), objText = all.slice(br.index, end > 0 ? end : br.index + 60000);
            const nm = /\/Name\s*\(([^)]{1,80})\)/.exec(objText);
            if (nm && !names.includes(nm[1])) names.push(nm[1]);
        }
        const method = !pages ? "no page objects found" : directPages ? "page objects" : "page objects in compressed streams";
        return { pages: pages || null, method, sizes, signatures: { fields, signed, names } };
    }

    /** An AutoCAD eTransmit "Transmittal Report" .txt → its lists. */
    function parseTransmittal(text) {
        const lines = String(text || "").split(/\r?\n/);
        const out = { root: null, xrefs: [], pdfs: [], plotFiles: [], excluded: [], missing: [] };
        let list = null;
        const heads = [
            [/^Root Drawing:/i, "root"], [/^AutoCAD Drawing \(External\) References:/i, "xrefs"],
            [/^Adobe Acrobat Document References:/i, "pdfs"], [/Plot Style Table File References:|Plotter Configuration File References:/i, "plotFiles"],
            [/files were excluded from the transmittal/i, "excluded"], [/could not be located/i, "missing"]
        ];
        lines.forEach(raw => {
            const line = raw.replace(/\s+$/, "");
            if (!line.trim()) return;
            const h = heads.find(([re]) => re.test(line.trim()));
            if (h) { list = h[1]; return; }
            if (/^\S/.test(line)) { list = null; return; } // any other heading ends the list
            if (!list) return;
            const item = line.trim();
            if (list === "root") { if (!out.root) out.root = item; } else out[list].push(item);
        });
        // the report lists the files twice (by type, then by folder)
        ["xrefs", "pdfs", "plotFiles", "excluded", "missing"].forEach(k => { out[k] = Array.from(new Set(out[k])); });
        return out;
    }

    /**
     * @param {{ transmittal?: {name, text}, pdfs?: [{name, pages, method}], sheets?: checkSheets() result,
     *           xrefs?: collectDrawingText().xrefs, drawingName?: string, sheetTotals?: number[] }} pkg
     * @returns {{ findings, transmittal }}
     */
    function checkPackageFiles(pkg) {
        const findings = [];
        const flag = (severity, rule, where, message) => findings.push({ severity, rule, id: "", where, message });
        const tr = pkg.transmittal ? parseTransmittal(pkg.transmittal.text) : null;
        if (tr) {
            const where = pkg.transmittal.name;
            tr.missing.forEach(f => flag("warning", "Transmittal: file not found", where, `eTransmit could not locate ${f} — it is not in the package.`));
            if (tr.excluded.length) {
                flag("info", "Transmittal: files left out", where, `${tr.excluded.length} file(s) were excluded (usually fonts the recipient must have): ${tr.excluded.slice(0, 6).join(", ")}${tr.excluded.length > 6 ? ", …" : ""}.`);
            }
            if (pkg.drawingName && tr.root) {
                const base = s => String(s).split(/[\\/]/).pop().replace(/\.(dwg|dxf)$/i, "").toUpperCase();
                if (base(tr.root) !== base(pkg.drawingName)) flag("info", "Transmittal: other drawing", where, `the transmittal is for ${tr.root}; the drawing loaded is ${pkg.drawingName}.`);
            }
            (pkg.xrefs || []).forEach(x => {
                const name = String(x.path || x.name).split(/[\\/]/).pop().replace(/\.dwg$/i, "").toUpperCase();
                if (!tr.xrefs.some(t => String(t).split(/[\\/]/).pop().replace(/\.dwg$/i, "").toUpperCase() === name)) {
                    flag("warning", "Xref not in the transmittal", where, `the drawing references ${x.path || x.name}, which the transmittal doesn't list.`);
                }
            });
        } else if ((pkg.xrefs || []).length) {
            flag("info", "Xrefs", pkg.drawingName || "Drawing", `the drawing references ${pkg.xrefs.length} external drawing(s): ${pkg.xrefs.slice(0, 4).map(x => x.path || x.name).join(", ")} — they must travel with it.`);
        }
        const totals = new Set();
        (pkg.sheetTotals || []).forEach(y => totals.add(y));
        (pkg.pdfs || []).forEach(p => {
            // Sheet size: 24" x 36" (§501 II.1.1, V.3)
            if (p.sizes && p.sizes.length) {
                const off = p.sizes.map((z, i) => ({ i: i + 1, z })).filter(x => !(Math.abs(Math.min(x.z.w, x.z.h) - 24) <= 0.1 && Math.abs(Math.max(x.z.w, x.z.h) - 36) <= 0.1));
                if (off.length) {
                    const kinds = Array.from(new Set(off.map(x => `${x.z.w}" × ${x.z.h}"`)));
                    flag("warning", "PDF sheet size", p.name, `${off.length} of ${p.sizes.length} page(s) aren't 24" × 36" (${kinds.slice(0, 3).join(", ")}${kinds.length > 3 ? ", …" : ""}; first: page ${off[0].i}) — JEA asks for 24" × 36" sheets (§501 II.1.1).`);
                } else flag("info", "PDF sheet size", p.name, `all ${p.sizes.length} page(s) are 24" × 36".`);
            }
            // Signed and sealed (§501 I.5.1; Rule 5J-17.062 for digital signatures)
            if (p.signatures) {
                const sg = p.signatures;
                if (!sg.signed) flag("warning", "PDF digital signature", p.name, sg.fields ? `${sg.fields} signature field(s), none signed — JEA requires each as-built page signed and sealed by the PSM/PE (§501 I.5.1, 5J-17.062).` : "no digital signature in the PDF — JEA requires the as-built signed and sealed by the PSM/PE (§501 I.5.1, 5J-17.062), unless it was sealed another way.");
                else flag("info", "PDF digital signature", p.name, `${sg.signed} signature(s) present${sg.names.length ? ` (${sg.names.join(", ")})` : ""} — present, not validated: open the PDF to check the certificate.`);
            }
            if (p.pages == null) { flag("info", "PDF page count", p.name, `page count not determined (${p.method}).`); return; }
            if (totals.size && !totals.has(p.pages)) {
                flag("warning", "PDF pages vs sheet numbers", p.name, `the PDF has ${p.pages} page(s), but the sheets say ${Array.from(totals).sort((a, b) => a - b).map(y => `"OF ${y}"`).join(", ")}.`);
            } else if (totals.size) {
                flag("info", "PDF pages vs sheet numbers", p.name, `${p.pages} page(s), matching "OF ${p.pages}".`);
            } else {
                flag("info", "PDF page count", p.name, `${p.pages} page(s)${pkg.sheets ? `; the drawing has ${pkg.sheets.sheets.length} layout(s) and no "SHEET x OF y" to compare` : ""}.`);
            }
        });
        return { findings, transmittal: tr };
    }

    // ── Every feature surveyed (§501 II.1.17) ────────────────────────────

    /**
     * A P,N,E,Z,D (or P,E,N,Z,D) point file → shots. In FL East the northing (~2,000,000) is larger than
     * the easting (~500,000); a file whose second column is mostly the smaller is read as P,E,N.
     * @returns {{ shots: [{ id, n, e, z, desc }], swapped, skipped }}
     */
    function parseShots(text) {
        const rows = [];
        let skipped = 0;
        String(text || "").split(/\r?\n/).forEach(line => {
            const t = line.trim();
            if (!t || /^[#;]/.test(t)) return;
            const f = t.includes(",") ? t.split(",").map(x => x.trim()) : t.split(/\s+/);
            const a = Number(f[1]), b = Number(f[2]);
            if (f.length < 3 || !isFinite(a) || !isFinite(b)) { skipped++; return; }
            rows.push({ id: f[0], a, b, z: f[3] !== undefined && f[3] !== "" && isFinite(Number(f[3])) ? Number(f[3]) : null, desc: f.slice(4).join(" ") });
        });
        const swapped = rows.length > 0 && rows.filter(r => r.a < r.b).length > rows.length / 2;
        return { shots: rows.map(r => ({ id: r.id, n: swapped ? r.b : r.a, e: swapped ? r.a : r.b, z: r.z, desc: r.desc })), swapped, skipped };
    }

    /**
     * "All features depicted in the as-built drawings must be surveyed" — JEA Standards 2026 §501 II.1.17.
     * Each workbook point (structures, crossings, points along pipe) should sit on a field shot within
     * JEA's 0.5 ft horizontally (§501 II.1.7). A point with no shot near it was likely taken from the
     * design. Elevations are compared too (0.1 ft), as notes: a shot may be on the nut, rim or pipe.
     */
    function checkSurveyedPoints(model, shots, opts) {
        opts = opts || {};
        const hTol = opts.horizontalFt || 0.5, vTol = opts.verticalFt || 0.1;
        const findings = [];
        const flag = (severity, rule, id, where, message) => findings.push({ severity, rule, id, where, message });
        const pts = [].concat((model && model.structures) || [], (model && model.crossings) || [], (model && model.pipePoints) || []).filter(p => isFinite(p.e) && isFinite(p.n));
        if (!pts.length || !shots.length) { flag("info", "Survey shots not checked", "", "Workbook", !pts.length ? "no workbook points to check." : "no shots in the point file."); return { findings, matched: 0 }; }
        const cell = 2, grid = new Map(), key = (e, n) => `${Math.floor(e / cell)},${Math.floor(n / cell)}`;
        shots.forEach(s0 => { const k = key(s0.e, s0.n); (grid.get(k) || grid.set(k, []).get(k)).push(s0); });
        const nearest = p => {
            let best = null;
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                (grid.get(`${Math.floor(p.e / cell) + dx},${Math.floor(p.n / cell) + dy}`) || []).forEach(s0 => {
                    const d = Math.hypot(s0.e - p.e, s0.n - p.n);
                    if (!best || d < best.d) best = { s: s0, d };
                });
            }
            return best;
        };
        const res = pts.map(p => ({ p, m: nearest(p) }));
        const matched = res.filter(x => x.m && x.m.d <= hTol);
        if (matched.length < 0.3 * pts.length) {
            flag("info", "Survey shots not checked", "", "Point file", `only ${matched.length} of ${pts.length} workbook points have a shot within ${hTol} ft — the point file and the workbook aren't in the same coordinates (or are different jobs).`);
            return { findings, matched: matched.length };
        }
        res.forEach(({ p, m }) => {
            const where = p.source ? `${p.source.sheet}!A${p.source.row}` : "";
            if (!m || m.d > hTol) {
                flag("warning", "Not surveyed", p.id, where, `no field shot within ${hTol} ft${m ? ` (nearest ${m.s.id}, ${m.d.toFixed(2)} ft away)` : ""} — JEA requires every feature on the as-built to be surveyed (§501 II.1.17).`);
            } else if (p.z != null && m.s.z != null && Math.abs(p.z - m.s.z) > vTol) {
                flag("info", "Elevation differs from the shot", p.id, where, `elevation ${Number(p.z).toFixed(2)} vs shot ${m.s.id} at ${m.s.z.toFixed(2)} (Δ ${(p.z - m.s.z).toFixed(2)} ft) — fine if the shot is on a different part (nut, rim, pipe top); otherwise beyond JEA's 0.1 ft.`);
            }
        });
        flag("info", "Survey shots", "", "Point file", `${matched.length} of ${pts.length} workbook point(s) sit on a field shot within ${hTol} ft (${shots.length} shots).`);
        return { findings, matched: matched.length };
    }

    // ── Published control (§501 II.1.6) ──────────────────────────────────

    /** An NGS datasheet (text) → marks: { pid, designation, n, e (US ft), orthoFt }. */
    function parseNgsDatasheet(text) {
        const marks = new Map();
        const get = pid => marks.get(pid) || marks.set(pid, { pid }).get(pid);
        String(text || "").split(/\r?\n/).forEach(line => {
            let m = /^\s*([A-Z]{2}\d{4})\s+DESIGNATION\s*-\s*(.+?)\s*$/.exec(line);
            if (m) { get(m[1]).designation = m[2]; return; }
            m = /^\s*([A-Z]{2}\d{4})\*?\s*NAVD 88 ORTHO HEIGHT\s*-\s*(-?[\d.]+)\s*\(meters\)\s*(-?[\d.]+)\s*\(feet\)/.exec(line);
            if (m) { get(m[1]).orthoFt = Number(m[3]); return; }
            m = /^\s*([A-Z]{2}\d{4})[;*]?\s*SPC FL E\s*-\s*([\d,]+\.\d+)\s+([\d,]+\.\d+)\s+(MT|sFT|iFT)/.exec(line);
            if (m) {
                const k = m[4] === "MT" ? 3937 / 1200 : m[4] === "iFT" ? 1 / 0.999998 : 1; // to US survey feet
                const mk = get(m[1]);
                mk.n = Number(m[2].replace(/,/g, "")) * k; mk.e = Number(m[3].replace(/,/g, "")) * k;
            }
        });
        return Array.from(marks.values());
    }

    /**
     * "The PSM or PE … will independently verify the positional accuracy … through checks to published
     * horizontal and vertical control points" — §501 II.1.6. Without a datasheet: does the drawing cite
     * any published mark (an NGS PID) or benchmark? With one: is each mark cited, and do the drawing's
     * stated elevation / coordinates for it agree (0.1 ft / 0.5 ft, §501 II.1.7)?
     */
    function checkPublishedControl(info, datasheetText) {
        const findings = [];
        const flag = (severity, rule, id, where, message) => findings.push({ severity, rule, id, where, message });
        const texts = info.texts.map(t => t.text);
        const pids = Array.from(new Set(texts.flatMap(t => (t.toUpperCase().match(/\bPID\s*[:#-]?\s*([A-Z]{2}\d{4})\b/g) || []).map(x => x.slice(-6)))));
        const bms = texts.filter(t => /\bBENCH\s*MARK|\bB\.?M\.?\s*#?\s*\d|\bNGS\b/i.test(t)).length;
        const marks = datasheetText ? parseNgsDatasheet(datasheetText) : [];
        if (!marks.length) {
            if (!pids.length && !bms) flag("warning", "Published control", "", "Drawing", "no NGS mark (PID) or benchmark cited — JEA asks for checks to published horizontal and vertical control (§501 II.1.6), and for the benchmarks used to be shown (§501 II.1.4).");
            else flag("info", "Published control", "", "Drawing", `${pids.length ? `NGS mark(s) cited: ${pids.join(", ")}` : "no NGS PID cited"}; ${bms} benchmark note(s). Paste the NGS datasheets to check their values.`);
            return { findings, marks };
        }
        marks.forEach(mk => {
            const near = info.texts.filter(t => t.text.toUpperCase().includes(mk.pid) || (mk.designation && t.text.toUpperCase().includes(mk.designation.toUpperCase())));
            if (!near.length) { flag("warning", "Published control not cited", mk.pid, "Drawing", `${mk.pid}${mk.designation ? ` (${mk.designation})` : ""} is in the datasheets but not named in the drawing (§501 II.1.4, II.1.6).`); return; }
            // only the part of each text that belongs to this mark: from its name to the next mark's
            const txt = near.map(t => {
                const u = t.text.toUpperCase();
                let i = u.indexOf(mk.pid);
                if (i < 0 && mk.designation) i = u.indexOf(mk.designation.toUpperCase());
                const rest = u.slice(i + 1), nx = rest.search(/\b[A-Z]{2}\d{4}\b/);
                return u.slice(i, nx >= 0 ? i + 1 + nx : u.length);
            }).join(" ");
            const el = /ELEV(?:ATION)?\.?\s*[=:]?\s*(-?\d+\.\d+)/.exec(txt);
            if (el && mk.orthoFt != null && Math.abs(Number(el[1]) - mk.orthoFt) > 0.1) {
                flag("error", "Published control elevation", mk.pid, "Drawing", `the drawing gives ${mk.pid} an elevation of ${el[1]}; the NGS datasheet says ${mk.orthoFt.toFixed(2)} ft NAVD 88 (Δ ${(Number(el[1]) - mk.orthoFt).toFixed(2)} ft — JEA allows 0.1 ft, §501 II.1.7).`);
            }
            const ne = /\bN\s*[=:]?\s*(\d{6,7}\.\d+)\D{1,12}?E\s*[=:]?\s*(\d{5,6}\.\d+)/.exec(txt);
            if (ne && mk.n != null && Math.hypot(Number(ne[1]) - mk.n, Number(ne[2]) - mk.e) > 0.5) {
                flag("error", "Published control position", mk.pid, "Drawing", `the drawing gives ${mk.pid} N ${ne[1]} E ${ne[2]}; the datasheet gives N ${mk.n.toFixed(2)} E ${mk.e.toFixed(2)} (${Math.hypot(Number(ne[1]) - mk.n, Number(ne[2]) - mk.e).toFixed(2)} ft apart — JEA allows 0.5 ft, §501 II.1.7).`);
            }
            if (!el && !ne) flag("info", "Published control", mk.pid, "Drawing", `${mk.pid} is cited, with no elevation or coordinates beside it to compare.`);
        });
        return { findings, marks };
    }

    // ── Resubmittal: compare two versions of the workbook (§501 I.6.3) ───

    /**
     * prev / curr: workbook results (JeaXlsx.workbookToModel). Lists IDs added, removed and changed, the
     * findings resolved and new, and — for JEA's review comments, one per line — whether the IDs each
     * comment names changed. (§501 I.6.3: a resubmittal comes with JEA's marked-up revision list.)
     */
    function compareSubmittals(prev, curr, commentsText) {
        const items = r => [].concat(r.model.structures || [], r.model.crossings || [], r.model.pipePoints || []);
        const byId = r => new Map(items(r).map(x => [normId(x.id), x]));
        const A = byId(prev), B = byId(curr);
        const added = [], removed = [], changed = [];
        B.forEach((x, k) => { if (!A.has(k)) added.push(x.id); });
        A.forEach((x, k) => {
            const y = B.get(k);
            if (!y) { removed.push(x.id); return; }
            const diffs = [];
            if (Math.hypot((y.e || 0) - (x.e || 0), (y.n || 0) - (x.n || 0)) > 0.01) diffs.push(`moved ${Math.hypot(y.e - x.e, y.n - x.n).toFixed(2)} ft`);
            if ((x.z == null) !== (y.z == null) || (x.z != null && Math.abs(x.z - y.z) > 0.005)) diffs.push(`elevation ${x.z == null ? "—" : x.z} → ${y.z == null ? "—" : y.z}`);
            new Set([...Object.keys(x.attribs || {}), ...Object.keys(y.attribs || {})]).forEach(f => {
                const a = (x.attribs || {})[f], b = (y.attribs || {})[f];
                if (String(a == null ? "" : a) !== String(b == null ? "" : b)) diffs.push(`${f} ${a == null ? "—" : a} → ${b == null ? "—" : b}`);
            });
            if (diffs.length) changed.push({ id: y.id, diffs });
        });
        const fk = f => `${f.rule}|${normId(f.id)}`;
        const real = r => (r.findings || []).filter(f => f.severity !== "info");
        const prevF = new Map(real(prev).map(f => [fk(f), f])), currF = new Map(real(curr).map(f => [fk(f), f]));
        const resolved = Array.from(prevF.keys()).filter(k => !currF.has(k)).map(k => prevF.get(k));
        const remaining = Array.from(prevF.keys()).filter(k => currF.has(k)).map(k => currF.get(k));
        const newFindings = Array.from(currF.keys()).filter(k => !prevF.has(k)).map(k => currF.get(k));
        const touchedIds = new Set([...added, ...removed, ...changed.map(c => c.id), ...resolved.map(f => f.id)].map(normId));
        const allIds = new Set([...A.keys(), ...B.keys()]);
        const comments = String(commentsText || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
            const ids = Array.from(new Set((line.toUpperCase().match(/\b[A-Z]{1,5}\s?-?\d{1,4}[A-Z]?\b/g) || []).map(normId).filter(k => allIds.has(k))));
            const status = !ids.length ? "no workbook ID in this comment — check it by hand" : ids.some(k => touchedIds.has(k)) ? "addressed — the ID(s) changed" : "NOT addressed — the ID(s) it names didn't change";
            return { comment: line, ids, status };
        });
        const findings = [];
        const flag = (severity, rule, id, message) => findings.push({ severity, rule, id, where: "Resubmittal", message });
        flag("info", "Resubmittal", "", `${added.length} ID(s) added, ${removed.length} removed, ${changed.length} changed; ${resolved.length} earlier finding(s) resolved, ${remaining.length} remaining, ${newFindings.length} new.`);
        remaining.forEach(f => flag("warning", "Still open from the last submittal", f.id, `${f.rule}: ${f.message}`));
        newFindings.forEach(f => flag("warning", "New since the last submittal", f.id, `${f.rule}: ${f.message}`));
        comments.filter(c => /^NOT/.test(c.status)).forEach(c => flag("warning", "Review comment not addressed", c.ids.join(", "), `"${c.comment.slice(0, 120)}" — ${c.status}.`));
        return { added, removed, changed, resolved, remaining, newFindings, comments, findings };
    }

    // ── Overlay and package zip ──────────────────────────────────────────

    /** The model's structures and crossings moved into the drawing's coordinates (drawing = SPC − shift), on JEA-OVERLAY. */
    function overlayModel(model, shift) {
        const dE = shift ? shift.dE : 0, dN = shift ? shift.dN : 0;
        const mv = x => Object.assign({}, x, { e: x.e - dE, n: x.n - dN, layer: "JEA-OVERLAY" });
        return { projectName: `${model.projectName || "Workbook"} — overlay`, pipes: [], structures: (model.structures || []).map(mv), crossings: (model.crossings || []).map(mv) };
    }

    /** files: [{ name, data: Uint8Array | string }] → one .zip (stored), for the submittal mailbox. */
    function packageZip(files) {
        const enc = new TextEncoder();
        if (!window.JeaXlsx || !window.JeaXlsx.zipStore) throw new Error("The zip writer (jea-xlsx.js) is not loaded.");
        const seen = new Set();
        return window.JeaXlsx.zipStore(files.filter(f => f && f.data != null).map(f => {
            let name = String(f.name).replace(/[\\:*?"<>|]+/g, "_");
            while (seen.has(name)) name = name.replace(/(\.[^.]+)?$/, m0 => `_2${m0}`);
            seen.add(name);
            return { name, data: typeof f.data === "string" ? enc.encode(f.data) : new Uint8Array(f.data) };
        }));
    }

    // ── Outputs: move script, readiness report, transmittal / checklist drafts ─

    /**
     * An AutoCAD script that moves everything in model space by the drawing's shift onto State Plane.
     * Run it on a COPY, in model space, after checking the shift — layouts (paper space) don't move.
     */
    function moveScript(shift) {
        if (!shift || !isFinite(shift.dE) || !isFinite(shift.dN)) throw new Error("No shift to apply — the drawing's position wasn't determined.");
        const f = v => v.toFixed(4);
        // TILEMODE 1 = model space; MOVE ALL from 0,0 by the shift; ZOOM E to see the result.
        return ["TILEMODE", "1", "_.MOVE", "_ALL", "", "0,0", `${f(shift.dE)},${f(shift.dN)}`, "_.ZOOM", "_E", ""].join("\r\n") + "\r\n";
    }

    const esc = v => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    /**
     * One page for the whole submittal: a pass / attention summary, every finding grouped by section
     * (with its JEA / FDOT source in the text), and the rules it was made under.
     * @param {{ title, drawingName?, workbookName?, rules: string, sections: [{ name, findings }] }} p
     * @returns {string} a self-contained HTML document
     */
    function readinessReport(p) {
        const sev = ["error", "warning", "info"];
        const total = k => p.sections.reduce((n, s0) => n + s0.findings.filter(f => f.severity === k).length, 0);
        const errors = total("error"), warnings = total("warning");
        const verdict = errors ? "Not ready — errors to fix" : warnings ? "Review the warnings before submitting" : "No errors or warnings found by the checks below";
        const reviewed = p.sections.some(s0 => s0.findings.some(f => f.review));
        const row = f => `<tr class="${f.severity}"><td>${esc(f.severity)}</td><td>${esc(f.rule)}</td><td>${esc(f.id)}</td><td>${esc(f.where)}</td><td>${esc(f.message)}</td>${reviewed ? `<td>${esc(f.review || "")}</td>` : ""}</tr>`;
        const sections = p.sections.filter(s0 => s0.findings.length).map(s0 => `<h2>${esc(s0.name)}</h2>
<p class="counts">${sev.map(k => `${s0.findings.filter(f => f.severity === k).length} ${k}`).join(" · ")}</p>
<table><thead><tr><th>Severity</th><th>Check</th><th>ID</th><th>Where</th><th>Finding</th>${reviewed ? "<th>Review</th>" : ""}</tr></thead><tbody>
${s0.findings.slice().sort((a, b) => sev.indexOf(a.severity) - sev.indexOf(b.severity)).map(row).join("\n")}
</tbody></table>`).join("\n");
        return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(p.title)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:20px}h2{font-size:16px;margin-top:24px}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top}tr.error td:first-child{color:#b00020;font-weight:600}tr.warning td:first-child{color:#8a5a00;font-weight:600}.verdict{font-size:16px;font-weight:600;padding:8px 12px;border:2px solid ${errors ? "#b00020" : warnings ? "#8a5a00" : "#1b7f3b"}}.counts,.meta{color:#555}@media print{body{margin:0}}</style></head><body>
<h1>${esc(p.title)}</h1>
<p class="meta">${p.drawingName ? `Drawing: ${esc(p.drawingName)} · ` : ""}${p.workbookName ? `Workbook: ${esc(p.workbookName)} · ` : ""}Generated ${esc(new Date().toISOString())}</p>
<p class="verdict">${esc(verdict)} — ${errors} error(s), ${warnings} warning(s).</p>
${reviewed ? `<p class="meta">Reviewed: ${["OK", "Fix", "N/A"].map(v => `${p.sections.reduce((n, s0) => n + s0.findings.filter(f => f.review === v).length, 0)} ${v}`).join(" · ")}; ${p.sections.reduce((n, s0) => n + s0.findings.filter(f => f.severity !== "info" && !f.review).length, 0)} not yet reviewed.</p>` : ""}
<p class="meta">${esc(p.rules)}</p>
${sections}
<p class="meta">A QC aid, not a certification: it reports what these checks found against the rules above. The surveyor of record remains responsible for the deliverable.</p>
</body></html>`;
    }

    // JEA Water and Wastewater Standards 2026, §501 V.3 "As-Built or Record Drawing Submittal Requirements
    // Check List — Pipelines and Pumping Stations" (the items, in JEA's words, abridged where long).
    const CHECKLIST_V3 = [
        { item: "Separate As-Builts or record drawings for water, wastewater, reclaimed water and chilled water as one continuous PDF", by: "files" },
        { item: "On each page of as-built, certification filled out, signed, sealed and dated by surveyor/mapper", by: "sheet:surveyorCert" },
        { item: "On each page of as-built, certification filled out, signed and dated by contractor", by: "sheet:contractorCert" },
        { item: "Old lines not built as per design deleted and redrawn as constructed", by: "eye" },
        { item: "Notes and elevations not struck through, but changed", by: "eye" },
        { item: "\u201cAS-BUILT\u201d or \u201cRECORD DRAWING\u201d labeled in 1\" letters on each page", by: "sheet:asBuilt" },
        { item: "PDF sheets are 24\" x 36\" in size", by: "eye" },
        { item: "All PDF sheets combined into one document", by: "files" },
        { item: "CAD and Excel files provided on first and every submittal", by: "files" },
        { item: "As-Built includes datum & reference to state plane coordinates (Florida East Zone NAD 83, NAVD 88)", by: "pkg:datumH,datumV,eastZone" },
        { item: "Vicinity map on cover page", by: "pkg:vicinity" },
        { item: "North Arrow and Graphic Scale on each page", by: "sheet:graphicScale" },
        { item: "Availability number and/or JEA Capital Project number on Cover Page and on each page", by: "sheet:jeaNumber" },
        { item: "Date of utility installation completion on Cover Page", by: "pkg:completionDate" },
        { item: "Match lines shown for continuation to other sheets", by: "eye" },
        { item: "Call outs provided showing points of connection to existing JEA infrastructure", by: "eye" },
        { item: "Legend, Surveyor Notes, General Notes on the cover page", by: "pkg:legend,surveyorNotes,generalNotes" },
        { item: "Asset data tables (Excel) complete and consistent with the drawing", by: "workbook" }
    ];

    /**
     * Drafts of JEA's §501 V.2 transmittal and V.3 checklist, filled from what the checks found. Blank
     * where a value isn't known; each checklist line marked from the check results — "found", "missing",
     * "check by eye" or "not checked" — for the submitter to verify and initial.
     */
    function draftSubmittalForms(p) {
        const sheets = p.sheets && p.sheets.sheets || [];
        const allFound = k => sheets.length && sheets.every(s0 => s0.found[k]);
        const anyFound = k => sheets.some(s0 => s0.found[k]);
        const vals = k => Array.from(new Set(sheets.flatMap(s0 => s0.found[k] || []))).join(", ");
        const mark = c => {
            if (c.by === "eye") return "check by eye";
            if (c.by === "files") return p.hasPdf ? "files present — check" : "not checked (add the PDF set)";
            if (c.by === "workbook") return p.workbookErrors == null ? "not checked (load the workbook)" : p.workbookErrors ? `${p.workbookErrors} error(s) in the workbook check` : "workbook check: no errors";
            const [kind, keys] = c.by.split(":"), ks = keys.split(",");
            if (!sheets.length) return "not checked";
            if (kind === "sheet") return ks.every(allFound) ? "found on every sheet" : ks.some(anyFound) ? "missing on some sheets" : "missing";
            return ks.every(anyFound) ? "found" : "missing";
        };
        const L = [];
        L.push("# JEA As-Built Submittal Transmittal — draft (JEA Standards 2026 §501 V.2)", "");
        L.push("To: W&S As-Built Submittal Mailbox", "");
        [["Project Name", p.projectName || ""], ["Date of Submittal", ""], ["JEA Availability Number", vals("availability")], ["JEA Capital Project Number", vals("jeaProject")],
            ["Surveying Co. / Surveyor", ""], ["Surveyor PSM #", vals("psm")], ["Engineering Firm", ""], ["Contracting Co.", ""], ["JEA Project Manager", ""]].forEach(([k, v]) => L.push(`- ${k}: ${v || "________"}`));
        L.push("", "Attached (from what was loaded):");
        (p.utilities || []).forEach(u => L.push(`- [ ] ${u} As-Builts & Data Tables – Electronic`));
        L.push("- [ ] As-Built Submittal Checklist filled out by Engineer, Contractor or Surveyor", "");
        L.push("# JEA As-Built Submittal Requirements Check List — draft (§501 V.3, Pipelines and Pumping Stations)", "");
        L.push(`Project Name: ${p.projectName || "________"} · JEA Availability Number: ${vals("availability") || "________"} · JEA Capital Project Number: ${vals("jeaProject") || "________"}`, "");
        L.push("| Requirement | From the checks | Initials |", "| --- | --- | --- |");
        CHECKLIST_V3.forEach(c => L.push(`| ${c.item} | ${mark(c)} | |`));
        L.push("", "Draft from the FDOT Civil 3D Tools package check. Verify every line and initial it yourself — this is a QC aid, not a certification.", "");
        L.push(p.rules || "");
        return L.join("\n");
    }

    window.JeaPackage = { cleanMText, collectDrawingText, checkSheets, georeference, reconcile, normId, SHEET_FIELDS, pdfPageCount, parseTransmittal, checkPackageFiles, checkPipeLabels, checkPointSpacing, checkHorizontalSeparation, moveScript, readinessReport, draftSubmittalForms, CHECKLIST_V3,
        parseShots, checkSurveyedPoints, parseNgsDatasheet, checkPublishedControl, compareSubmittals, overlayModel, packageZip };
})();
