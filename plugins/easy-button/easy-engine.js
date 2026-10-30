/**
 * Easy Button engine — pure functions for plugins/easy-button (no DOM).
 * plugins/easy-button/easy-engine.js
 *
 * Easy Button orchestrates the existing plugins; it doesn't replace them. This engine holds:
 *   - OUR_CODES: the standard code list a client's codes are associated with. Each entry says
 *     what a code is (point or line), which utility it carries (for pipe crossings, using JEA's
 *     "Crossing Pipe Type" list), and a default layer / symbol until the client's template
 *     supplies its own.
 *   - the client code list: a CSV of code, description, our code — parsed, validated, and
 *     matched (the client's "our code" column first, then suggestions by code and description).
 *   - translation of a field file (P,N,E,Z,D) from the client's codes to ours, then figures via
 *     window.LineworkEngine (same parser, control codes and checks as the Linework Editor).
 *
 *   - phase 2: our codes matched to the client's template layers and symbols, and the drawing
 *     (linework, symbols with attributes) written into the template via window.DxfTemplate.
 *
 * Z on utility shots is the pipe invert. Default layers are starting points — the client's
 * template replaces them. Exposes window.EasyEngine.
 */
(function () {
    "use strict";

    // kind: "line" (strung into figures) or "point" (a symbol at the shot). pipe: written as a 3D
    // polyline so every vertex keeps its invert.
    // utility: JEA "Crossing Pipe Type" for pipes that can cross (null = not a crossing pipe).
    // layer: default layer; null = the Linework engine's defaultLayer(code). symbol: default block.
    const OUR_CODES = [
        // Boundary / topo — lines
        { code: "BND", description: "Property / boundary line", kind: "line", utility: null, layer: null, symbol: null, aliases: ["PROP", "BOUNDARY", "PL", "LOT", "PROP", "PLIN"] },
        { code: "ROW", description: "Right-of-way line", kind: "line", utility: null, layer: null, symbol: null, aliases: ["RW", "RIGHT OF WAY", "ROWY"] },
        { code: "EOP", description: "Edge of pavement", kind: "line", utility: null, layer: null, symbol: null, aliases: ["EP", "PAVEMENT", "ASPH", "ASPHALT", "EDGE", "PVMT"] },
        { code: "CLINE", description: "Road centerline", kind: "line", utility: null, layer: "ROAD_ALIGN_EX", symbol: null, aliases: ["CENTERLINE", "CL", "CTR", "CNTR", "CTLN"] },
        { code: "CURB", description: "Curb / curb and gutter", kind: "line", utility: null, layer: null, symbol: null, aliases: ["BOC", "FOC", "GUTTER", "C&G", "CURB"] },
        { code: "SW", description: "Sidewalk edge", kind: "line", utility: null, layer: null, symbol: null, aliases: ["SIDEWALK", "WALK", "CONC WALK", "WALK", "SWLK"] },
        { code: "BLDG", description: "Building / structure outline", kind: "line", utility: null, layer: null, symbol: null, aliases: ["BUILDING", "HOUSE", "STRUCTURE", "BLD", "BLDG"] },
        { code: "FENCE", description: "Fence line", kind: "line", utility: null, layer: null, symbol: null, aliases: ["FNC", "FN", "CHAIN LINK", "WOOD FENCE", "FENC"] },
        { code: "DITCH", description: "Ditch / swale flow line", kind: "line", utility: null, layer: null, symbol: null, aliases: ["SWALE", "FLOWLINE", "FL", "TOB", "TOE", "DTCH", "DRAN"] },
        // Utilities — pipes (lines; Z = invert)
        { code: "WM", description: "Water main", kind: "line", pipe: true, utility: "Potable Water", layer: "W-MAIN", symbol: null, aliases: ["WATER", "WL", "WATER LINE", "WATER MAIN", "W", "WATR"] },
        { code: "WS", description: "Water service", kind: "line", pipe: true, utility: "Potable Water", layer: "W-MAIN", symbol: null, aliases: ["WATER SERVICE", "SERVICE", "WATR", "SERV"] },
        { code: "SAN", description: "Gravity sanitary sewer", kind: "line", pipe: true, utility: "Gravity Sewer", layer: "SS-GRAV", symbol: null, aliases: ["SEWER", "SS", "SANITARY", "GRAVITY SEWER", "SSWR"] },
        { code: "FM", description: "Sewer force main", kind: "line", pipe: true, utility: "Force Main", layer: "SS-FM", symbol: null, aliases: ["FORCE MAIN", "FORCEMAIN", "LPFM", "SSWR", "FORC"] },
        { code: "VAC", description: "Vacuum sewer", kind: "line", pipe: true, utility: "Vacuum Sewer", layer: "SS-GRAV", symbol: null, aliases: ["VACUUM", "VACUUM SEWER", "SSWR", "VACU"] },
        { code: "RCL", description: "Reclaimed water main", kind: "line", pipe: true, utility: "Reclaimed", layer: "RW-MAIN", symbol: null, aliases: ["RECLAIMED", "REUSE", "RW MAIN", "RWM", "RCLM", "RECL"] },
        { code: "STM", description: "Storm pipe", kind: "line", pipe: true, utility: "Storm", layer: "DRAIN_PIPE_PR", symbol: null, aliases: ["STORM", "STORM PIPE", "RCP", "SD", "DRAIN", "STRM", "SDRN"] },
        { code: "CHW", description: "Chilled water main", kind: "line", pipe: true, utility: null, layer: "CW-MAIN", symbol: null, aliases: ["CHILLED", "CHILLED WATER", "CHLD"] },
        // Points — survey control and topo
        { code: "MON", description: "Monument / property corner found", kind: "point", utility: null, layer: "SURV_MONUMENT", symbol: "FDOT_MONUMENT_PRM", aliases: ["IP", "IR", "IRON", "PIPE FOUND", "ROD", "CM", "PRM", "CORNER", "MONU"] },
        { code: "BM", description: "Benchmark", kind: "point", utility: null, layer: "SURV_CTRL_PT", symbol: "FDOT_BENCHMARK", aliases: ["BENCH", "BENCHMARK", "TBM", "BNCH"] },
        { code: "CP", description: "Survey control point", kind: "point", utility: null, layer: "SURV_CTRL_PT", symbol: null, aliases: ["CONTROL", "TRAVERSE", "CTL", "CTRL"] },
        { code: "TREE", description: "Tree", kind: "point", utility: null, layer: "ENV_WETL_EX", symbol: "FDOT_TREE_EX", aliases: ["OAK", "PINE", "PALM", "TR", "TREE"] },
        { code: "INL", description: "Storm inlet", kind: "point", utility: null, layer: "DRAIN_STR_EX", symbol: "FDOT_DRAIN_INLET", aliases: ["INLET", "CATCH BASIN", "CB", "GRATE", "STRM", "INLT"] },
        { code: "STMH", description: "Storm manhole", kind: "point", utility: null, layer: "DRAIN_STR_EX", symbol: "FDOT_DRAIN_MANHOLE", aliases: ["STORM MANHOLE", "SDMH", "STORM MH", "STRM", "MANH"] },
        // Points — water / sewer / reclaimed appurtenances (JEA template symbols)
        { code: "WV", description: "Water valve", kind: "point", utility: null, layer: "W-VALV", symbol: "JEA_VALVE", aliases: ["VALVE", "WATER VALVE", "GV", "GATE VALVE", "WATR", "VALV"] },
        { code: "FH", description: "Fire hydrant", kind: "point", utility: null, layer: "W-HYDR", symbol: "JEA_HYDRANT", aliases: ["HYDRANT", "FIRE HYDRANT", "WATR", "HYDT", "HYDR"] },
        { code: "WMTR", description: "Water meter", kind: "point", utility: null, layer: "W-METR", symbol: "JEA_METER", aliases: ["METER", "WATER METER", "WMETER", "WATR", "METR"] },
        { code: "WFIT", description: "Water fitting (tee, bend, reducer)", kind: "point", utility: null, layer: "W-FITT", symbol: "JEA_FITTING", aliases: ["TEE", "BEND", "REDUCER", "FITTING", "WATR", "FITT"] },
        { code: "WLOC", description: "Water locate box", kind: "point", utility: null, layer: "W-LOC8", symbol: "JEA_LOCATE_BOX", aliases: ["LOCATE", "LOCATE BOX", "TRACER", "WATR", "LOC8"] },
        { code: "SMH", description: "Sanitary manhole", kind: "point", utility: null, layer: "SS-MANH", symbol: "JEA_MANHOLE", aliases: ["MANHOLE", "SANITARY MANHOLE", "SSMH", "MH", "SSWR", "MANH"] },
        { code: "SV", description: "Sewer valve", kind: "point", utility: null, layer: "SS-VALV", symbol: "JEA_VALVE", aliases: ["SEWER VALVE", "PLUG VALVE", "ARV", "SSWR", "VALV"] },
        { code: "SCO", description: "Sewer cleanout", kind: "point", utility: null, layer: "SS-FITT", symbol: "JEA_FITTING", aliases: ["CLEANOUT", "CO", "CLEAN OUT", "SSWR", "CLNO"] },
        { code: "RV", description: "Reclaimed water valve", kind: "point", utility: null, layer: "RW-VALV", symbol: "JEA_VALVE", aliases: ["RECLAIMED VALVE", "REUSE VALVE", "RCLM", "VALV"] }
    ];
    const BY_CODE = new Map(OUR_CODES.map(c => [c.code, c]));
    const UNMAPPED_LAYER = "EB-UNMAPPED";

    // aliases include the National CAD Standard layer-name abbreviations (WATR, SSWR, VALV, HYDT…)
    // so template layers named that way are matched.

    // ── CSV ──────────────────────────────────────────────────────────────────

    /** RFC 4180-ish CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
    function parseCsv(text) {
        const rows = [];
        let row = [], f = "", q = false;
        const s = String(text || "").replace(/^﻿/, "");
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (q) {
                if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
                else f += ch;
            } else if (ch === '"') q = true;
            else if (ch === ",") { row.push(f); f = ""; }
            else if (ch === "\n" || ch === "\r") {
                if (ch === "\r" && s[i + 1] === "\n") i++;
                row.push(f); f = "";
                if (row.some(x => x.trim() !== "")) rows.push(row);
                row = [];
            } else f += ch;
        }
        row.push(f);
        if (row.some(x => x.trim() !== "")) rows.push(row);
        return rows.map(r => r.map(x => x.trim()));
    }
    const csvCell = v => /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const toCsv = rows => rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

    // ── Matching ─────────────────────────────────────────────────────────────

    /** a is an abbreviation of b: same first letter, a's letters appear in b in order. */
    function isAbbrev(a, b) {
        if (a[0] !== b[0]) return false;
        let j = 0;
        for (let i = 0; i < b.length && j < a.length; i++) if (b[i] === a[j]) j++;
        return j === a.length;
    }
    const words = s => String(s || "").toUpperCase().replace(/[^A-Z0-9&]+/g, " ").trim().split(/\s+/).filter(Boolean);

    /**
     * Best matches for a client code + description against OUR_CODES, highest first:
     * [{ code, score }] with score 0–1. Exact code or alias = 1; otherwise word overlap.
     */
    function suggest(code, description, limit) {
        const C = String(code || "").toUpperCase().trim(), D = String(description || "").toUpperCase().trim();
        const dw = new Set(words(D).concat(words(C)));
        const scored = OUR_CODES.map(o => {
            const names = [o.code].concat(o.aliases);
            if (names.includes(C) || (D && names.includes(D))) return { code: o.code, score: 1 };
            const ow = new Set(words(o.description).concat(...o.aliases.map(words), [o.code]));
            let hit = 0;
            dw.forEach(w => { if (ow.has(w)) hit++; });
            let score = dw.size ? hit / Math.max(dw.size, 2) : 0;
            // Crews abbreviate: INLT → INLET, HYD → HYDRANT, SSMH → SANITARY MANHOLE.
            if (C.length >= 2 && !ow.has(C) && [...ow].some(w => w.length > C.length && isAbbrev(C, w))) score += 0.3;
            return { code: o.code, score: Math.min(0.95, score) };
        }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.code.localeCompare(b.code));
        return scored.slice(0, limit || 3);
    }

    /** Codes that clash with the linework control words (B, E, CL, PC, …) or figure numbers. */
    function controlClash(code) {
        const E = window.LineworkEngine;
        const t = String(code || "").toUpperCase();
        if (!E || !t) return null;
        if (/^\d{1,3}$/.test(t)) return "a figure number";
        const cs = E.CODESET, kinds = [["begin", "begin"], ["continue", "continue"], ["end", "end"], ["close", "close"], ["lineSeg", "line segment"], ["curveSeg", "curve"], ["offset", "offset"]];
        for (const [k, label] of kinds) if ((cs[k] || []).includes(t)) return `the "${label}" control word`;
        return null;
    }

    /**
     * Parse the client's code list CSV (code, description, our code, and optionally size — the pipe
     * size in inches for pipe codes). A header row is detected by name ("code", "description",
     * "our code" / "maps to" / "standard", "size"); without one the columns are taken in that order. Returns { rows, errors, warnings } where each row is
     *   { line, code, description, ourCode, status, suggestions }
     * status: "matched" (our code given and known), "unknown" (our code given but not ours),
     *         "suggested" (blank our code, a confident suggestion), "unmapped" (nothing usable).
     */
    function parseCodeList(text) {
        const all = parseCsv(text), errors = [], warnings = [];
        if (!all.length) return { rows: [], errors: ["The code list is empty."], warnings };
        let cols = { code: 0, description: 1, ourCode: 2, size: 3, material: 4, pclass: 5 }, start = 0;
        const head = all[0].map(h => h.toLowerCase().replace(/[^a-z]/g, ""));
        const find = re => head.findIndex(h => re.test(h));
        if (head.some(h => /^(code|fieldcode|yourcode|clientcode|description|desc)$/.test(h))) {
            const oc = find(/^(ourcode|ourcodes|mapsto|mapto|standard|standardcode|associate|associatedcode|bqccode|easycode)$/);
            const c = find(/^(code|fieldcode|yourcode|clientcode|rawcode)$/), d = find(/^(description|desc)$/);
            if (c < 0) errors.push('The header has no "code" column.');
            cols = { code: c, description: d, ourCode: oc, size: find(/^(size|sizein|sizeinches|dia|diameter|pipesize|nominalsize)$/),
                material: find(/^(material|mat|pipematerial)$/), pclass: find(/^(class|pressureclass|pc|pipeclass)$/) };
            if (oc < 0) warnings.push('No "our code" column — every code will be matched by suggestion. Check each one.');
            start = 1;
        }
        const seen = new Map(), rows = [];
        for (let i = start; i < all.length; i++) {
            const r = all[i], line = i + 1;
            const code = cols.code >= 0 ? (r[cols.code] || "").trim() : "";
            const description = cols.description >= 0 ? (r[cols.description] || "").trim() : "";
            const ourRaw = cols.ourCode >= 0 ? (r[cols.ourCode] || "").trim().toUpperCase() : "";
            const sizeRaw = cols.size >= 0 ? (r[cols.size] || "").trim().replace(/("|in(ch(es)?)?)$/i, "") : "";
            const size = sizeRaw === "" ? null : Number(sizeRaw);
            if (sizeRaw !== "" && !(size > 0 && size <= 144)) { errors.push(`Line ${line}: size "${r[cols.size]}" isn't a pipe size in inches.`); continue; }
            if (!code) { errors.push(`Line ${line}: no code.`); continue; }
            if (/\s/.test(code)) { errors.push(`Line ${line}: code "${code}" has a space — field codes are single words.`); continue; }
            const key = code.toUpperCase();
            if (seen.has(key)) { errors.push(`Line ${line}: code "${code}" is listed twice (first on line ${seen.get(key)}).`); continue; }
            seen.set(key, line);
            const clash = controlClash(key);
            if (clash) warnings.push(`Line ${line}: code "${code}" is also ${clash} — shots using it may start, end or close figures.`);
            const sugg = suggest(code, description);
            let status, ourCode = ourRaw;
            if (ourRaw && BY_CODE.has(ourRaw)) status = "matched";
            else if (ourRaw) { status = "unknown"; warnings.push(`Line ${line}: our code "${ourRaw}" isn't in the standard list${sugg[0] ? ` — did you mean ${sugg[0].code}?` : "."}`); ourCode = ""; }
            else if (sugg[0] && sugg[0].score >= 0.5) { status = "suggested"; ourCode = sugg[0].code; }
            else status = "unmapped";
            const material = cols.material >= 0 ? (r[cols.material] || "").trim() : "";
            const pclass = cols.pclass >= 0 ? (r[cols.pclass] || "").trim() : "";
            if (material && window.PipeCrossings) {
                const pm = window.PipeCrossings.parseMaterial(material, pclass);
                if (pm && pm.error) warnings.push(`Line ${line}: ${pm.error} — the pipe type's default wall will be used.`);
            }
            rows.push({ line, code: key, description, ourCode, given: ourRaw, status, suggestions: sugg, size, material, pclass });
        }
        return { rows, errors, warnings };
    }

    /** Client code → pipe size (in), from the code list's optional size column. */
    function sizesOf(rows) {
        const m = {};
        rows.forEach(r => { if (r.size > 0) m[r.code] = r.size; });
        return m;
    }

    /** Client code → { material, pclass } from the code list's optional Material / Class columns. */
    function materialsOf(rows) {
        const m = {};
        rows.forEach(r => { if (r.material) m[r.code] = { material: r.material, pclass: r.pclass || "" }; });
        return m;
    }

    /**
     * A per-shot Size column in a field file with a header (e.g. P,N,E,Z,D,SIZE): read the sizes by
     * point number and drop the column, so the Linework parser doesn't read it as part of the
     * description. Returns { text, sizes: { ptNum: inches }, column } (column null when there's none).
     */
    function extractSizeColumn(text) {
        const lines = String(text || "").split(/\r?\n/);
        const hi = lines.findIndex(l => l.trim() && !/^[#;]/.test(l.trim()));
        if (hi < 0) return { text, sizes: {}, column: null };
        const delim = lines[hi].includes(",") ? "," : lines[hi].includes("\t") ? "\t" : null;
        if (!delim) return { text, sizes: {}, column: null };
        const head = lines[hi].split(delim).map(h => h.trim().toLowerCase().replace(/[^a-z]/g, ""));
        const col = head.findIndex(h => /^(size|sizein|dia|diameter|pipesize)$/.test(h));
        if (col < 0 || !head.some(h => /^(p|pt|point|pnt|number|n|northing)$/.test(h))) return { text, sizes: {}, column: null };
        const sizes = {};
        const out = lines.map((l, i) => {
            if (i < hi || !l.trim()) return l;
            const cells = delim === "," ? parseCsv(l)[0] || [] : l.split(delim);
            if (i > hi) {
                const v = String(cells[col] || "").trim().replace(/("|in(ch(es)?)?)$/i, "");
                if (v !== "" && Number(v) > 0) sizes[String(cells[0]).trim()] = Number(v);
            }
            cells.splice(col, 1);
            return cells.map(c => (delim === "," && /[,"]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(delim);
        });
        return { text: out.join("\n"), sizes, column: col };
    }

    /** Client code → our code (only rows with a usable our code). */
    function mappingOf(rows) {
        const m = {};
        rows.forEach(r => { if (r.ourCode && BY_CODE.has(r.ourCode)) m[r.code] = r.ourCode; });
        return m;
    }

    // ── Field data ───────────────────────────────────────────────────────────

    /**
     * Rewrite a shot description from client codes to ours, token by token. Control words,
     * figure numbers and curve codes are kept; "<code><escape><ctrl>" compounds keep their suffix.
     * Returns { desc, primary (client code), ours (our code or null) }.
     */
    function translateDesc(desc, mapping) {
        const E = window.LineworkEngine, esc = E.CODESET.escape;
        let primary = null, ours = null;
        const toks = String(desc || "").trim().split(/\s+/).filter(Boolean).map(tok => {
            const parts = tok.split(esc), head = parts[0].toUpperCase();
            const isCompound = parts.length >= 2 && parts.filter(Boolean).length >= 2;
            if (!isCompound && E.classifyToken(head)) return tok;          // control / figure / curve word
            if (primary == null) primary = head;
            if (Object.prototype.hasOwnProperty.call(mapping, head)) {
                if (ours == null && head === primary) ours = mapping[head];
                parts[0] = mapping[head];
                return parts.join(esc);
            }
            return tok;
        });
        return { desc: toks.join(" "), primary, ours };
    }

    /**
     * Translate and build a field file (sizes: client code → pipe size, from the code list). Returns
     *   { points, figures, features, unmapped: { code: count }, counts: { ourCode: n }, bad, stats }
     * figures: Linework figures (line codes), on our default layer — or EB-UNMAPPED.
     * features: point-code shots { ptNum, n, e, z, code, layer, symbol, desc }.
     */
    function buildFromField(text, order, mapping, mode, sizes, materials) {
        const E = window.LineworkEngine, PX = window.PipeCrossings;
        const sc = extractSizeColumn(text);
        const parsed = E.parsePointFile(sc.text, order || "NE");
        const matByPt = {};
        const unmapped = {}, counts = {}, linePts = [], features = [], sizeByPt = {};
        parsed.points.forEach(p => {
            const t = translateDesc(p.desc, mapping);
            // Pipe size: written on the shot (8", 8IN) first, else the code list's size for the code.
            // Pipe size: the file's Size column, then written on the shot (8IN), then the code list.
            const sz = sc.sizes[String(p.ptNum)] || (PX && PX.sizeToken(p.desc)) || (sizes && t.primary && sizes[t.primary]) || null;
            if (sz) sizeByPt[p.ptNum] = sz;
            if (materials && t.primary && materials[t.primary]) matByPt[p.ptNum] = materials[t.primary];
            const o = t.ours ? BY_CODE.get(t.ours) : null;
            if (!o) {
                const k = t.primary || "(blank)";
                unmapped[k] = (unmapped[k] || 0) + 1;
                linePts.push(Object.assign({}, p, { desc: t.desc, __unmapped: true }));
                return;
            }
            counts[o.code] = (counts[o.code] || 0) + 1;
            if (o.kind === "point") {
                features.push({ ptNum: p.ptNum, n: p.n, e: p.e, z: p.z, code: o.code, layer: o.layer || E.defaultLayer(o.code), symbol: o.symbol, desc: p.desc });
            } else {
                linePts.push(Object.assign({}, p, { desc: t.desc }));
            }
        });
        const figures = E.buildFigures(linePts, mode || "byCode").map(f => {
            const o = BY_CODE.get(String(f.code || "").toUpperCase());
            const layer = o ? (o.layer || E.defaultLayer(o.code)) : UNMAPPED_LAYER;
            const sz = f.pts.map(q => sizeByPt[q.ptNum]).find(v => v > 0) || null;
            const mat = f.pts.map(q => matByPt[q.ptNum]).find(Boolean) || null;
            return Object.assign(f, { layer, ourCode: o ? o.code : null, utility: o ? o.utility : null, size: o && o.pipe ? sz : null, material: o && o.pipe && mat ? mat.material : null, pclass: o && o.pipe && mat ? mat.pclass : null });
        });
        // Unmapped shots that didn't string into a figure stay visible as points on EB-UNMAPPED.
        const used = new Set();
        figures.forEach(f => f.pts.forEach(q => used.add(q.ptNum)));
        linePts.filter(p => p.__unmapped && !used.has(p.ptNum)).forEach(p => {
            features.push({ ptNum: p.ptNum, n: p.n, e: p.e, z: p.z, code: null, layer: UNMAPPED_LAYER, symbol: null, desc: p.desc });
        });
        // A bare number on a pipe shot is a figure number to the Linework engine — if it was meant as
        // a size (or a 12" whose quote the CSV reader stripped), say how to write it.
        const warnings = [];
        const bareOnPipe = parsed.points.filter(p => {
            const t = translateDesc(p.desc, mapping), o = t.ours && BY_CODE.get(t.ours);
            return o && o.pipe && /(^|\s)(4|6|8|10|12|14|16|18|20|24|30|36|42|48)(\s|$)/.test(String(p.desc).replace(/^\S+/, ""));
        });
        if (bareOnPipe.length) warnings.push(`${bareOnPipe.length} pipe shot(s) have a bare number (e.g. "${bareOnPipe[0].desc}") — that's read as a figure number. Write pipe sizes as 12IN (a 12" loses its quote mark in a CSV point file).`);
        const stats = {
            shots: parsed.points.length, skipped: parsed.bad.length, figures: figures.length,
            features: features.filter(f => f.code).length, mappedShots: Object.values(counts).reduce((a, b) => a + b, 0),
            unmappedShots: Object.values(unmapped).reduce((a, b) => a + b, 0),
            pipes: figures.filter(f => f.utility).length
        };
        if (sc.column != null) warnings.push(`Pipe sizes read from the file's Size column for ${Object.keys(sc.sizes).length} shot(s).`);
        return { points: parsed.points, figures, features, unmapped, counts, bad: parsed.bad, stats, warnings };
    }

    /** The translated field file (P,N,E,Z,D with our codes), for Civil 3D or the Linework Editor. */
    function translatedPnezd(points, mapping) {
        const rows = ["P,N,E,Z,D"];
        points.forEach(p => rows.push([p.ptNum, p.n.toFixed(4), p.e.toFixed(4), p.z == null || !isFinite(p.z) ? "" : p.z.toFixed(4), translateDesc(p.desc, mapping).desc].join(",")));
        return rows.join("\r\n") + "\r\n";
    }

    /** Our code list as CSV (what a client maps to). */
    function ourCodesCsv() {
        return toCsv([["Our code", "Description", "Kind", "Utility (crossing type)", "Default layer", "Default symbol"]].concat(
            OUR_CODES.map(o => [o.code, o.description, o.kind, o.utility || "", o.layer || window.LineworkEngine.defaultLayer(o.code), o.symbol || ""])));
    }
    /** A mapping CSV (the client's list with our codes filled in). */
    function mappingCsv(rows) {
        const withMat = rows.some(r => r.material), withSize = withMat || rows.some(r => r.size > 0);
        const head = ["Code", "Description", "Our code"].concat(withSize ? ["Size"] : [], withMat ? ["Material", "Class"] : []);
        return toCsv([head].concat(rows.map(r => [r.code, r.description, r.ourCode || ""].concat(withSize ? [r.size > 0 ? String(r.size) : ""] : [], withMat ? [r.material || "", r.pclass || ""] : []))));
    }

    // ── Profiles (a client's saved code list) ────────────────────────────────

    /** A profile is plain data, so it can be saved, exported and imported as JSON. */
    function makeProfile(name, rows, templateMap) {
        const n = String(name || "").trim();
        if (!n) throw new Error("Give the profile a name.");
        const p = { kind: "easy-button-profile", version: 2, name: n, savedAt: new Date().toISOString(), rows: rows.map(r => ({ code: r.code, description: r.description, ourCode: r.ourCode || "", size: r.size > 0 ? r.size : null, material: r.material || "", pclass: r.pclass || "" })) };
        if (templateMap) p.template = { name: templateMap.name || "", layer: Object.assign({}, templateMap.layer), symbol: Object.assign({}, templateMap.symbol) };
        return p;
    }
    /** The saved template matching in a profile, or null (version 1 profiles have none). */
    function templateMapFromProfile(obj) {
        const t = obj && obj.template;
        if (!t || typeof t.layer !== "object" || typeof t.symbol !== "object") return null;
        return { name: String(t.name || ""), layer: Object.assign({}, t.layer), symbol: Object.assign({}, t.symbol) };
    }
    /** Rows from an imported profile JSON (validated; unknown our codes become unmapped). */
    function rowsFromProfile(obj) {
        if (!obj || obj.kind !== "easy-button-profile" || !Array.isArray(obj.rows)) throw new Error("Not an Easy Button profile file.");
        return parseCodeList(mappingCsv(obj.rows.map(r => ({ code: String(r.code || ""), description: String(r.description || ""), ourCode: String(r.ourCode || ""), size: Number(r.size) > 0 ? Number(r.size) : null, material: String(r.material || ""), pclass: String(r.pclass || "") }))));
    }

    // ── Template (phase 2) — via window.DxfTemplate ───────────────────────────

    /** Our codes worth matching: those in the client's code list, plus any in a build. */
    function codesInUse(rows, build) {
        const set = new Set(rows.map(r => r.ourCode).filter(c => BY_CODE.has(c)));
        if (build) Object.keys(build.counts || {}).forEach(c => set.add(c));
        return OUR_CODES.filter(o => set.has(o.code));
    }

    /**
     * Suggested template layer and symbol for each of our codes: { layer: { code: name|"" },
     * symbol: { code: name|"" }, score: { code: { layer, symbol } } }. "" layer = add our default
     * layer to the template; "" symbol = a point and label instead of a symbol.
     */
    function suggestTemplateMap(tpl, codes) {
        const T = window.DxfTemplate, map = { layer: {}, symbol: {}, score: {} };
        const layerNames = tpl.layers.map(l => l.name).filter(n => n !== "0" && !/^defpoints$/i.test(n));
        const symbolNames = tpl.blocks.map(b => b.name).filter(n => !/^[_*]/.test(n));
        codes.forEach(o => {
            const f = { code: o.code, description: o.description, aliases: o.aliases };
            const L = T.rank(layerNames, Object.assign({ preferred: o.layer || window.LineworkEngine.defaultLayer(o.code) }, f), 1)[0];
            map.layer[o.code] = L && L.score >= 0.5 ? L.name : "";
            map.score[o.code] = { layer: L ? L.score : 0, symbol: null };
            if (o.kind === "point") {
                const B = T.rank(symbolNames, Object.assign({ preferred: o.symbol }, f), 1)[0];
                map.symbol[o.code] = B && B.score >= 0.5 ? B.name : "";
                map.score[o.code].symbol = B ? B.score : 0;
            }
        });
        return map;
    }

    /** Figure → polyline points; a resolved arc span becomes one bulged vertex (as the editor's DXF does). */
    function figurePoints(f) {
        const arcs = (f.arcs || []).slice().sort((a, b) => a.startIdx - b.startIdx), out = [];
        for (let i = 0; i < f.pts.length; i++) {
            const a = arcs.find(x => x.startIdx === i);
            if (a && a.endIdx > i && f.pts[a.endIdx]) {
                const s = f.pts[a.startIdx], e = f.pts[a.endIdx];
                const a0 = Math.atan2(s.n - a.cy, s.e - a.cx), a1 = Math.atan2(e.n - a.cy, e.e - a.cx);
                let inc = a1 - a0;
                if (a.ccw) { while (inc <= 0) inc += 2 * Math.PI; } else { while (inc >= 0) inc -= 2 * Math.PI; }
                out.push({ e: s.e, n: s.n, z: s.z, bulge: window.COGO.bulge(inc) });
                i = a.endIdx - 1;
            } else out.push({ e: f.pts[i].e, n: f.pts[i].n, z: f.pts[i].z });
        }
        return out;
    }

    /**
     * The drawing to write into the template: figures as polylines on the matched layers (pipes 3D,
     * keeping their inverts), point features as the matched symbols with attributes filled — or a
     * point and label where no symbol is matched — and unmatched shots on EB-UNMAPPED.
     * A figure whose layer was changed in the Linework Editor keeps that layer.
     */
    function drawingFromBuild(figures, features, tpl, map) {
        const E = window.LineworkEngine, T = window.DxfTemplate;
        const blocks = new Map(tpl.blocks.map(b => [b.name, b]));
        const defaultLayer = o => o.layer || E.defaultLayer(o.code);
        const layerFor = (o, current) => {
            if (!o) return current || UNMAPPED_LAYER;
            if (current && current !== defaultLayer(o)) return current;           // changed in the editor
            return map.layer[o.code] || defaultLayer(o);
        };
        const jeaColor = name => { const l = ((window.Jea24Data && window.Jea24Data.LAYERS) || []).find(x => x.name === name); return l ? l.color : 7; };
        const used = new Map();
        const use = name => { if (!used.has(name)) used.set(name, { name, color: name === UNMAPPED_LAYER ? 1 : jeaColor(name) }); return name; };
        const polylines = figures.filter(f => f.pts && f.pts.length >= 2 && !f.isCircle).map(f => {
            const o = BY_CODE.get(String(f.ourCode || f.code || "").toUpperCase()) || null;
            return { layer: use(layerFor(o, f.layer)), closed: !!f.closed, points: figurePoints(f), is3d: !!(o && o.pipe) };
        });
        const inserts = [], points = [], texts = [];
        const h = Math.max(1, Math.min(5, (tpl.blocks[0] && tpl.blocks[0].attdefs[0] && tpl.blocks[0].attdefs[0].height) || 2));
        features.forEach(ft => {
            const o = ft.code ? BY_CODE.get(ft.code) : null;
            const layer = use(layerFor(o, ft.layer));
            const sym = o && map.symbol[o.code] && blocks.get(map.symbol[o.code]);
            if (sym) {
                inserts.push({ block: sym.name, layer, e: ft.e, n: ft.n, z: isFinite(ft.z) ? ft.z : 0, attribs: T.attribValues(sym.attdefs, { ptNum: ft.ptNum, n: ft.n, e: ft.e, z: ft.z, desc: ft.desc, code: o.code }) });
            } else {
                points.push({ layer, e: ft.e, n: ft.n, z: isFinite(ft.z) ? ft.z : 0 });
                texts.push({ layer, e: ft.e + h, n: ft.n + h, height: h, value: `${ft.ptNum} ${o ? o.code : ft.desc}` });
            }
        });
        return { layers: [...used.values()], polylines, inserts, points, texts };
    }

    // ── Civil 3D survey figures ───────────────────────────────────────────────

    /**
     * A Civil 3D Figure Prefix Database starter, as CSV: one row per line code in use — Name (the
     * figure prefix; figures are named by our code), Layer (the template's matched layer, else our
     * default), Breakline (ground features yes, pipes no — inverts aren't ground), Lot Line
     * (boundary / right-of-way), and a Description. Point codes aren't figures, so they're left out.
     */
    function figurePrefixCsv(codes, map) {
        const rows = codes.filter(o => o.kind === "line").map(o => [
            o.code, (map && map.layer && map.layer[o.code]) || o.layer || window.LineworkEngine.defaultLayer(o.code),
            o.pipe ? "No" : "Yes", o.code === "BND" || o.code === "ROW" ? "Yes" : "No", o.description
        ]);
        return toCsv([["Name", "Layer", "Breakline", "Lot Line", "Description"]].concat(rows));
    }

    // ── Samples ──────────────────────────────────────────────────────────────

    // A crew's own codes (one left blank, one with a typo'd our code) — JEA area, FL East ft.
    const SAMPLE_CODES = [
        "Code,Description,Our code,Size",
        "IP,Iron pipe found,MON,",
        "PROP,Property line,BND,",
        "EP,Edge of pavement,EOP,",
        "WL,Water line (invert),WM,8",
        "SS,Sanitary sewer (invert),SAN,8",
        "GV,Gate valve,WV,",
        "HYD,Fire hydrant,FH,",
        "SSMH,Sanitary manhole,SMH,",
        "RCP,Storm pipe (invert),STM,18",
        "INLT,Curb inlet,,",
        "TRE,Tree,TREES,"
    ].join("\n");

    const SAMPLE_FIELD = [
        "P,N,E,Z,D",
        "1,2154200.00,436200.00,24.10,IP",
        "2,2154200.00,436500.00,24.30,PROP B",
        "3,2154450.00,436500.00,24.80,PROP",
        "4,2154450.00,436200.00,24.60,PROP",
        "5,2154200.00,436200.00,24.10,PROP CLS",
        "6,2154230.00,436210.00,23.90,EP B",
        "7,2154232.00,436490.00,24.00,EP E",
        "10,2154260.00,436210.00,19.20,WL B",
        "11,2154262.00,436350.00,19.10,WL",
        "12,2154265.00,436490.00,19.00,WL E",
        "20,2154220.00,436340.00,14.20,SS B",
        "21,2154330.00,436352.00,13.80,SS",
        "22,2154440.00,436360.00,13.40,SS E",
        "30,2154245.00,436300.00,15.50,RCP B",
        "31,2154300.00,436420.00,15.10,RCP E",
        "40,2154261.00,436280.00,22.90,GV",
        "41,2154264.00,436440.00,23.10,HYD",
        "42,2154330.00,436352.00,23.70,SSMH",
        "43,2154236.00,436300.00,23.80,INLT",
        "44,2154400.00,436250.00,24.40,TRE",
        "45,2154410.00,436260.00,24.40,XYZ"
    ].join("\n");

    /**
     * A build (buildFromField) → the JEA As-Built model: every point feature whose symbol is a JEA block
     * becomes a structure (ID = the shot's point number, at the shot), every found crossing a
     * JEA_CROSSING (attribs from PipeCrossings.crossingAttribs). Attributes the field data doesn't carry
     * (subtype, manufacturer…) are left out for the surveyor to fill — never guessed. Also returns the
     * shots, for the "every feature surveyed" check.
     */
    function jeaModelFromBuild(build, crossings, crossingAttribs, projectName) {
        if (!build || !build.features) throw new Error("Build the linework first (step 2).");
        const sysOf = layer => /^SS-/.test(layer || "") ? "Sewer" : /^RW-/.test(layer || "") ? "Reclaimed" : /^CW-/.test(layer || "") ? "Chilled" : "Water";
        const structures = build.features.filter(f => f.symbol && /^JEA_/.test(f.symbol) && f.symbol !== "JEA_CROSSING").map(f => ({
            id: String(f.ptNum), block: f.symbol, layer: f.layer, e: f.e, n: f.n, z: f.z != null && isFinite(f.z) ? f.z : null,
            attribs: {}, source: { sheet: "field data", row: f.ptNum, system: sysOf(f.layer), code: f.code, desc: f.desc || "" }
        }));
        const xs = (crossings || []).map(c => ({ id: c.id, block: "JEA_CROSSING", layer: "UTIL-CROSS", e: c.e, n: c.n, z: c.upper && c.upper.bottom != null ? c.upper.bottom : null,
            attribs: crossingAttribs ? crossingAttribs(c) : {}, source: { sheet: "crossings", row: c.id } }));
        if (!structures.length && !xs.length) throw new Error("No JEA structures in the field data (codes whose symbol is a JEA block) and no crossings found.");
        const shots = (build.points || []).filter(p => isFinite(p.n) && isFinite(p.e)).map(p => ({ id: String(p.ptNum), n: p.n, e: p.e, z: p.z != null && isFinite(p.z) ? p.z : null, desc: p.desc || "" }));
        return { model: { projectName: projectName || "Easy Button field data", structures, crossings: xs, pipes: [], pipePoints: [] }, shots };
    }

    window.EasyEngine = {
        OUR_CODES, UNMAPPED_LAYER, SAMPLE_CODES, SAMPLE_FIELD,
        parseCsv, toCsv, suggest, controlClash, parseCodeList, mappingOf, sizesOf, materialsOf, extractSizeColumn,
        translateDesc, buildFromField, translatedPnezd, jeaModelFromBuild, ourCodesCsv, mappingCsv, makeProfile, rowsFromProfile,
        templateMapFromProfile, codesInUse, suggestTemplateMap, figurePoints, drawingFromBuild, figurePrefixCsv,
        ourCode: c => BY_CODE.get(String(c || "").toUpperCase()) || null
    };
})();
