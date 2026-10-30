/**
 * Linework engine — the pure (no-DOM) half of the linework plugin.
 * plugins/linework/linework-engine.js
 *
 * Point-file / call-list parsing, the Civil 3D linework code set, figure
 * building, arc fitting and the field-blunder checks (checkModel). The SVG
 * editor, exports and tab UI stay in plugins/linework/linework.js, which loads
 * after this file and reads window.LineworkEngine.
 *
 * Depends on core/cogo.js (window.COGO).
 */
(function () {
    "use strict";

    const FL_ENV = { minE: 50000, maxE: 3500000, minN: 50000, maxN: 4500000 };
    const nz = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };

    // Realistic Florida State Plane East (US ft) coordinates. Field-coded per the
    // Civil 3D linework code set (B begin, C continue, E end, CLS close). On purpose:
    //  - BND:  a normal closed boundary
    //  - BLDG: a closed building, POB re-shot as the last point (redundant)
    //  - EP:   an open line, interrupted by a TREE shot then continued (C); a
    //          duplicated shot (#12 == #11) makes a zero-length course
    //  - BOW:  a closed figure with the point order wrong — a bow-tie
    const SAMPLE = [
        "1,2015000.00,642000.00,12.5,BND B",
        "2,2015300.00,642000.00,12.6,BND",
        "3,2015300.00,642210.00,12.4,BND",
        "4,2015000.00,642210.00,12.5,BND CLS",
        "5,2015050.00,642050.00,11.9,BLDG B",
        "6,2015050.00,642120.00,11.9,BLDG",
        "7,2015095.00,642120.00,11.9,BLDG",
        "8,2015095.00,642050.00,11.9,BLDG",
        "9,2015050.00,642050.00,11.9,BLDG CLS",
        "10,2015400.00,642000.00,12.5,EP B",
        "11,2015600.00,642000.00,12.5,EP",
        "12,2015600.00,642000.00,12.5,EP",
        "13,2015700.00,642050.00,11.8,TREE",
        "14,2015610.00,642400.00,12.4,EP C",
        "15,2015620.00,642700.00,12.4,EP E",
        "16,2016000.00,643000.00,10.0,BOW B",
        "17,2016100.00,643100.00,10.0,BOW",
        "18,2016000.00,643100.00,10.0,BOW",
        "19,2016100.00,643000.00,10.0,BOW CLS",
        "20,2015680.00,642000.00,10.0,ARC B",
        "21,2015729.50,642040.50,10.0,ARC BC",
        "22,2015750.00,642090.00,10.0,ARC",
        "23,2015729.50,642139.50,10.0,ARC EC",
        "24,2015680.00,642180.00,10.0,ARC E",
        "25,2016315.00,642000.00,9.0,MH CIR",
        "26,2016300.00,642015.00,9.0,MH",
        "27,2016285.00,642000.00,9.0,MH"
    ].join("\n");

    // ── Parsing ──────────────────────────────────────────────────────────────

    /** Quote-aware CSV/TSV/whitespace tokenizer. */
    function tokenizeLine(line) {
        line = (line || "").trim();
        if (!line) return [];
        if (line.includes(",")) {
            const toks = [];
            let cur = "";
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                const ch = line[i];
                if (ch === '"') {
                    if (inQuotes && line[i + 1] === '"') {
                        cur += '"';
                        i++;
                    } else {
                        inQuotes = !inQuotes;
                    }
                } else if (ch === ',' && !inQuotes) {
                    toks.push(cur.trim());
                    cur = "";
                } else {
                    cur += ch;
                }
            }
            toks.push(cur.trim());
            return toks.filter(t => t.length > 0);
        }
        if (line.includes("\t")) {
            return line.split("\t").map(t => t.trim()).filter(t => t.length > 0);
        }
        return line.split(/\s+/).map(t => t.trim()).filter(t => t.length > 0);
    }

    /** Parse a P,N,E,Z,D point file. order = "NE" (default) or "EN". */
    function parsePointFile(text, order) {
        let en = order === "EN";
        const points = [];
        const bad = [];
        const badDetails = [];
        const lines = String(text || "").split(/\r?\n/);
        let headerDetected = null;

        lines.forEach((raw, i) => {
            const line = raw.trim();
            if (!line || line.startsWith("#") || line.startsWith(";")) return;
            const toks = tokenizeLine(line);
            if (toks.length < 3) {
                bad.push(i + 1);
                const detail = { line: i + 1, raw: line, reason: `Insufficient columns (${toks.length} found, expected >= 3)` };
                badDetails.push(detail);
                if (window.Logging) window.Logging.warn(`Linework: Skipped line ${i + 1} (${detail.reason}): "${line}"`, { source: "linework", ...detail });
                return;
            }

            const a = parseFloat(toks[1]), b = parseFloat(toks[2]);
            if (!Number.isFinite(a) || !Number.isFinite(b)) {
                // Header detection check (e.g. Point, Northing, Easting, Elev, Desc)
                const isHeader = (i === 0 || !points.length) && /^(p|pt|point|n|north|northing|e|east|easting|z|elev|elevation|desc|code)/i.test(toks[0] + toks[1] + toks[2]);
                if (isHeader) {
                    headerDetected = line;
                    if (window.Logging) window.Logging.info(`Linework: Detected and skipped header row at line ${i + 1}: "${line}"`, { source: "linework", line: i + 1, raw: line });
                    return;
                }
                if (points.length) {
                    bad.push(i + 1);
                    const detail = { line: i + 1, raw: line, reason: `Non-numeric coordinate tokens [${toks[1]}, ${toks[2]}]` };
                    badDetails.push(detail);
                    if (window.Logging) window.Logging.warn(`Linework: Skipped line ${i + 1} (${detail.reason}): "${line}"`, { source: "linework", ...detail });
                }
                return;
            }

            let z = parseFloat(toks[3]);
            let descStart = 4;
            if (!Number.isFinite(z)) { z = 0; descStart = 3; }
            const desc = toks.slice(descStart).join(" ").replace(/^["']+|["']+$/g, "").trim();
            const pn = parseInt(toks[0], 10);
            points.push({
                ptNum: Number.isFinite(pn) && String(pn) === toks[0] ? pn : toks[0],
                n: en ? b : a,
                e: en ? a : b,
                z, hasZ: descStart === 4, desc, srcLine: i + 1    // hasZ false → the 0 above is a placeholder, not an elevation
            });
        });

        const stats = {
            totalLines: lines.length,
            pointCount: points.length,
            badCount: bad.length,
            headerDetected
        };

        return { points, bad, badDetails, stats };
    }

    // Linework Code Set — matches the Civil 3D "Edit Linework Code Set" defaults.
    // Editable at runtime via window.Linework.CODESET before importing. Token
    // ORDER within a description is not significant — "EP B" and "B EP" both
    // parse the same way: whichever token isn't a recognized keyword is the
    // feature code. (Some offices' point-file exports put the control word
    // first; Civil 3D's own default puts the code first.)
    const CODESET = {
        delimiter: " ",          // Feature/Code delimiter (<Space>)
        escape: "/",             // Field code escape — ALSO marks multi-figure
                                  // membership: a token "<code><escape><ctrl>"
                                  // (e.g. "SD1/B" with escape "/", or "SD1XB"
                                  // with escape "X") cross-references a SECOND
                                  // figure from this same shot — see splitDesc.
        begin:    ["B", "BEG", "BEGIN", "START"],
        continue: ["C", "CONT"],                 // resume an interrupted figure of this code
        end:      ["E", "END"],                  // end the figure — NO closing segment
        close:    ["CLS", "CLO", "CLOSE", "CL", "Z"], // end AND draw the closing segment
        // Curve segment codes — resolved into real circular geometry (see resolveGeometry):
        curveBegin: ["BC", "PC", "MCS"],   // begin curve / point of curvature / mid-curve start
        curveEnd:   ["EC", "PT", "MCE"],   // end curve / point of tangency / mid-curve end
        curvePoint: ["OC", "POC"],      // on-curve shot (informational)
        circleWhole: ["CIR"],           // the whole figure is a circle
        // Line segment codes — RECT is built; the rest are recognized only:
        lineSeg:  ["RECT", "RT", "X", "RPN", "CPN"],
        curveSeg: ["BC", "EC", "PC", "PT", "CIR", "OC", "POC", "MCS", "MCE"],
        offset:   ["SO"],        // plus H<n> / V<n>, matched by regex
        // Codes that never form a figure even when 2+ shots share the code with
        // no B/C/E at all — the default "same bare code → auto-chain" behavior
        // (below) is what Civil 3D itself does for a code configured as linear,
        // but a point-only code (e.g. scattered grade shots, monuments) would
        // otherwise get wrongly strung into one figure across the whole site.
        // Empty by default — zero effect until a project opts a code in.
        pointOnly: []
    };

    // ── Named CODESET profiles — reusable starting points for a field crew's
    // own point-file convention, refined over time as real projects surface
    // more of it (each is a starting point, not a guarantee — a new project
    // on a known profile may still need its own pointOnly additions; see
    // applyCodesetProfile). Apply with window.Linework.applyCodesetProfile
    // ("name") before importing; "default" restores the Civil 3D stock set.
    const CODESET_PROFILES = {
        "default": { escape: "/", pointOnly: [] },
        // Control-word-first descriptions ("B TCL", not Civil 3D's stock
        // "TCL B"), "X" as the multi-figure-membership escape character,
        // MCS/MCE curve markers. Confirmed against a real project (a point
        // file cross-checked point-for-point against its compiled Civil 3D
        // field-book script). pointOnly lists standard point-feature codes —
        // never linework in any normal survey convention — that this
        // convention's exports leave with no B/C/E at all.
        "control-first-x-escape": {
            escape: "X",
            pointOnly: ["G", "TV", "IPF", "TBM", "LP", "LPP", "WV", "FH", "CO", "JB", "LINE"],
        },
        // Official FDOT Civil 3D State Kit Survey Database convention:
        // Delimiter: Space, Escape: "/", standard point codes (MONU*, BENCH*, TREE*, FH*, etc.)
        // that never chain into figures unless explicitly coded with B/C.
        "fdot-state-kit": {
            escape: "/",
            pointOnly: [
                "MONU", "BENCH", "BM", "PRM", "PCP", "PK", "IP", "IR", "CONC", "CM",
                "TREE", "PALM", "OAK", "PINE", "STUMP", "SOIL", "SPT", "TEST",
                "FH", "WM", "WV", "GM", "GV", "EM", "PED", "JB", "POLE", "LP", "PPC",
                "GUY", "TEL", "CATV", "SIGN", "MAIL", "WELL"
            ]
        },
    };

    /** Apply a window.Linework.CODESET_PROFILES preset onto the live CODESET
     *  (the object splitDesc/buildFigures actually read) — in place, so it
     *  takes effect immediately for the next import. A profile only needs to
     *  list what differs from the stock defaults; every other CODESET field
     *  (begin/continue/curveBegin/…) is left as it currently is. Add a new
     *  named entry to CODESET_PROFILES as new conventions get confirmed —
     *  that's the "train over time" part; nothing here is hardcoded to one
     *  project. */
    function applyCodesetProfile(name) {
        const profile = CODESET_PROFILES[name];
        if (!profile) throw new Error(`Unknown CODESET profile "${name}". Known: ${Object.keys(CODESET_PROFILES).join(", ")}`);
        Object.keys(profile).forEach(k => { CODESET[k] = profile[k]; });
        return CODESET;
    }
    const inSet = (arr, t) => arr.indexOf(t) !== -1;

    // How close a BC..EC (or MCS..MCE) span's shots must lie to a fitted circle
    // before it's drawn as a real arc. A single absolute distance doesn't work
    // across a realistic range of radii — a tight curb return and a gentle
    // roadway curve don't fail at the same absolute deviation — so it's
    // relative-or-absolute: accept if dev<=absFt OR dev/radius<=relFrac.
    // Editable at runtime via window.Linework.ARC_FIT before importing, same
    // as CODESET.
    const ARC_FIT = { absFt: 0.15, relFrac: 0.06 };

    /** Classify one already-uppercased token against the control/curve/offset
     *  keyword sets. Returns {kind, value} or null if it's not a keyword at all
     *  (kind: "begin"|"continue"|"end"|"close"|"fig"|"seg"). Shared by the
     *  primary-token pass and the compound cross-reference pass in splitDesc. */
    function classifyToken(t) {
        if (inSet(CODESET.begin, t)) return { kind: "begin" };
        if (inSet(CODESET.continue, t)) return { kind: "continue" };
        if (inSet(CODESET.end, t)) return { kind: "end" };
        if (inSet(CODESET.close, t)) return { kind: "close" };
        if (/^\d{1,3}$/.test(t)) return { kind: "fig", value: t };
        if (inSet(CODESET.lineSeg, t) || inSet(CODESET.curveSeg, t) ||
            inSet(CODESET.offset, t) || /^[HV]-?\d/.test(t)) return { kind: "seg", value: t };
        return null;
    }

    /**
     * Parse a survey description into
     *   { code, fig, control, closeFlag, segCodes, crossRefs }.
     * control ∈ "" | "begin" | "continue" | "end" | "close".
     * crossRefs: [{ code, control, closeFlag, segCodes }] — other figures this
     * SAME shot also belongs to, via an escape-joined compound token (e.g.
     * "SD1XB" with escape "X" → this shot also begins figure SD1). A
     * cross-reference to the SAME code as the primary is folded into the
     * primary's own control/segCodes instead of creating a duplicate vertex.
     */
    function splitDesc(desc) {
        const toks = String(desc || "").trim().split(/\s+/).filter(Boolean);
        if (!toks.length) return { code: "LINE", fig: "1", control: "", closeFlag: false, segCodes: [], crossRefs: [] };

        let control = "", fig = "", primaryTok = null;
        const segCodes = [];
        const compoundToks = [];
        for (const raw of toks) {
            // Only a genuine "<code><escape><word>" split (content on both sides)
            // counts as compound — a bare escape char alone (e.g. a lone "X"
            // token when escape is also configured as "X") falls through to
            // ordinary keyword/primary classification instead of being dropped.
            if (raw.includes(CODESET.escape) && raw.split(CODESET.escape).filter(Boolean).length >= 2) {
                compoundToks.push(raw); continue;
            }
            const t = raw.toUpperCase();
            const c = classifyToken(t);
            if (!c) { if (primaryTok == null) primaryTok = raw; continue; }
            if (c.kind === "begin") control = control || "begin";
            else if (c.kind === "continue") control = "continue";
            else if (c.kind === "end") control = control || "end";
            else if (c.kind === "close") control = "close";
            else if (c.kind === "fig") fig = c.value;
            else if (c.kind === "seg") segCodes.push(c.value);
        }
        const primary = (primaryTok || toks[0]).split(CODESET.escape)[0].toUpperCase() || "LINE";

        // Compound tokens: "<code><escape><word>[<escape><word>...]" — the
        // leading segment names the (possibly different) figure; each
        // trailing segment is a control/curve word for THAT figure.
        const crossRefs = [];
        for (const raw of compoundToks) {
            const segs = raw.split(CODESET.escape).filter(Boolean);
            if (segs.length < 2) continue;
            const refCode = segs[0].toUpperCase();
            let refControl = "", refSeg = [];
            for (const s of segs.slice(1)) {
                const c = classifyToken(s.toUpperCase());
                if (!c) continue;                       // unrecognized (e.g. "C3") — ignored, not fatal
                if (c.kind === "begin") refControl = refControl || "begin";
                else if (c.kind === "continue") refControl = "continue";
                else if (c.kind === "end") refControl = refControl || "end";
                else if (c.kind === "close") refControl = "close";
                else if (c.kind === "seg") refSeg.push(c.value);
            }
            if (refCode === primary) {
                // Same figure as the primary token — merge, don't duplicate the vertex.
                if (refControl && !control) control = refControl;
                else if (refControl === "close") control = "close";
                refSeg.forEach(s => { if (segCodes.indexOf(s) === -1) segCodes.push(s); });
            } else if (refControl || refSeg.length) {
                crossRefs.push({ code: refCode, control: refControl, closeFlag: refControl === "close", segCodes: refSeg });
            }
        }

        return { code: primary, fig: fig || "1", control, closeFlag: control === "close", segCodes, crossRefs };
    }

    function defaultLayer(code) {
        const c = String(code || "").toUpperCase();
        const map = [
            [/BND|BOUND|PROP|PARCEL|\bLOT\b/, "SURV_BND_PR"],
            [/R\/?W|ROW|RIGHT.?OF.?WAY/, "RW_LINE_PR"],
            [/EOP|\bEP\b|EDGE.?OF.?PAV|PAVE/, "ROAD_EOP_EX"],
            [/\bCL\b|CENTERLINE|C\/L|ALIGN/, "ROAD_ALIGN_EX"],
            [/CURB|C&G|\bBOC\b|\bFOC\b/, "ROAD_CURB_PR"],
            [/\bSW\b|SIDEWALK/, "ROAD_SWK_PR"],
            [/BLD|BUILD|STRUCT/, "SURV_BND_PR"],
            [/DITCH|SWALE|\bTOB\b|\bTOE\b|FLOW/, "DRAIN_FLOW_DIR"],
            [/CONT|CONTOUR/, "SURV_MIN_CONT"]
        ];
        for (const [re, l] of map) if (re.test(c)) return l;
        const disc = window.BoundaryQCCMS && window.BoundaryQCCMS.getActiveTemplateSetting
            ? window.BoundaryQCCMS.getActiveTemplateSetting("discipline", "SURV") : "SURV";
        const first = (window.FDOT_DATA && window.FDOT_DATA.layers || []).find(x => x.discipline === disc);
        return first ? first.name : "SURV_BND_PR";
    }

    const byNum = (x, y) => {
        const a = typeof x.ptNum === "number" ? x.ptNum : parseFloat(x.ptNum);
        const b = typeof y.ptNum === "number" ? y.ptNum : parseFloat(y.ptNum);
        if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
        return String(x.ptNum).localeCompare(String(y.ptNum));
    };

    /**
     * Group points into figures, honoring the linework code set:
     *  - B / begin   → start a new figure of that code (a second B on the same code
     *                  starts a separate figure — "Automatic begin on figure prefix match")
     *  - C / continue → resume the current (or most recent) figure of that code
     *  - E / end      → finish the figure, no closing segment
     *  - CLS / close  → finish the figure AND draw the segment back to the start
     * Points within a figure connect in point-number order.
     * mode = "byCode" | "byFigure" | "single".
     */
    // ── Circle geometry (for BC/EC arcs and CIR circles) ─────────────────────

    // Circle fits are done on data shifted to its own centroid — State Plane
    // coordinates (~2,000,000) otherwise swamp the radius (~100) in double precision.

    /** Exact circle through 3 points, or null if (near-)collinear. */
    function circumcircle(a, b, c) {
        const mx = (a.e + b.e + c.e) / 3, my = (a.n + b.n + c.n) / 3;
        const ax = a.e - mx, ay = a.n - my, bx = b.e - mx, by = b.n - my, cx = c.e - mx, cy = c.n - my;
        const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
        if (Math.abs(d) < 1e-6) return null;
        const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
        const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
        const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
        return { cx: ux + mx, cy: uy + my, r: Math.hypot(ax - ux, ay - uy) };
    }

    /** Kåsa algebraic least-squares circle fit through N>=3 points. */
    function fitCircle(pts) {
        if (pts.length === 3) return circumcircle(pts[0], pts[1], pts[2]);
        const n = pts.length;
        const mx = pts.reduce((s, p) => s + p.e, 0) / n;
        const my = pts.reduce((s, p) => s + p.n, 0) / n;
        let sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0;
        for (const p of pts) {
            const x = p.e - mx, y = p.n - my, z = x * x + y * y;
            sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
        }
        // Centered => Σx = Σy = 0, so C = sz/n and [sxx sxy; sxy syy][A B] = [sxz syz].
        const det = sxx * syy - sxy * sxy;
        if (Math.abs(det) < 1e-9) return null;
        const A = (sxz * syy - syz * sxy) / det;
        const B = (syz * sxx - sxz * sxy) / det;
        const r2 = (A * A + B * B) / 4 + sz / n;
        return r2 > 0 ? { cx: mx + A / 2, cy: my + B / 2, r: Math.sqrt(r2) } : null;
    }

    /** Resolve BC..EC arc spans, CIR circles and RECT rectangles from per-point codes.
     *  Idempotent — safe to re-run after an edit (RECT only fires while pts.length === 3). */
    function resolveGeometry(figs) {
        figs.forEach(f => {
            delete f.arcs; delete f.circle; delete f.isCircle; delete f.geomWarn; delete f.geomNote;
            if (!f.pts) return;
            const codesAt = i => (f.pts[i] && f.pts[i].codes) || [];
            const anyAt = (i, set) => codesAt(i).some(c => set.indexOf(c) !== -1);

            // Whole-figure circle
            if (f.pts.some((_, i) => anyAt(i, CODESET.circleWhole))) {
                const ps = f.pts;
                let cir = null;
                if (ps.length === 2) cir = { cx: ps[0].e, cy: ps[0].n, r: window.COGO.distanceBetween(ps[0], ps[1]) };
                else if (ps.length >= 3) cir = fitCircle(ps.slice(0, 3));
                if (cir && cir.r > 0) { f.circle = cir; f.isCircle = true; f.closed = true; }
                else f.geomWarn = "CIR code but points are collinear — cannot fit a circle.";
                return;
            }

            // RECT: 3 points → parallelogram (4th corner computed)
            if (f.pts.length === 3 && f.pts.some((_, i) => anyAt(i, ["RECT"]))) {
                const [a, b, c] = f.pts;
                f.pts.push({ e: a.e + (c.e - b.e), n: a.n + (c.n - b.n), z: a.z, desc: a.desc, codes: [] });
                f.closed = true;
                f.geomNote = "rectangle from RECT code (3 shots + computed 4th corner)";
            }

            // BC..EC arc spans
            const arcs = [];
            let bc = -1;
            for (let i = 0; i < f.pts.length; i++) {
                if (anyAt(i, CODESET.curveBegin)) bc = i;
                else if (anyAt(i, CODESET.curveEnd) && bc >= 0) {
                    const span = f.pts.slice(bc, i + 1);
                    const cir = span.length >= 3 ? fitCircle(span) : null;
                    const label = `curve span #${f.pts[bc].ptNum != null ? f.pts[bc].ptNum : bc}→#${f.pts[i].ptNum != null ? f.pts[i].ptNum : i}`;
                    if (cir && cir.r > 0 && cir.r < 1e7) {
                        const s = span[0], mid = span[Math.floor(span.length / 2)], e = span[span.length - 1];
                        const cross = (mid.e - s.e) * (e.n - mid.n) - (mid.n - s.n) * (e.e - mid.e);
                        // max deviation of a span point from the fitted circle
                        let dev = 0;
                        for (const p of span) dev = Math.max(dev, Math.abs(Math.hypot(p.e - cir.cx, p.n - cir.cy) - cir.r));
                        const rel = dev / cir.r;
                        if (dev <= ARC_FIT.absFt || rel <= ARC_FIT.relFrac) {
                            arcs.push({ startIdx: bc, endIdx: i, cx: cir.cx, cy: cir.cy, r: cir.r, ccw: cross > 0, dev, rel });
                        } else {
                            // The shots don't actually lie on a circle (e.g. a natural
                            // top-of-bank/toe-of-slope line, not an engineered curb
                            // return) — drawing one anyway would be visibly wrong, so
                            // the span is left to render as straight shot-to-shot
                            // chords instead (see figurePolyPoints), same as a BC with
                            // no matching EC.
                            f.geomWarn = (f.geomWarn || "") + ` ${label}: fit deviation ${dev.toFixed(2)}ft ` +
                                `(${(rel * 100).toFixed(0)}% of r=${cir.r.toFixed(1)}ft) exceeds tolerance — not a ` +
                                `constant-radius curve, drawn as straight chords.`;
                        }
                    } else {
                        f.geomWarn = (f.geomWarn || "") + ` ${label}: ` +
                            (span.length < 3 ? "need at least 3 shots (BC, on-curve, EC)." : "points are collinear — cannot fit an arc.");
                    }
                    bc = -1;
                }
            }
            if (bc >= 0) f.geomWarn = (f.geomWarn || "") + ` BC at #${f.pts[bc].ptNum != null ? f.pts[bc].ptNum : bc} has no matching EC.`;
            if (arcs.length) f.arcs = arcs;
        });
        return figs;
    }

    function buildFigures(points, mode) {
        const pt = p => ({ e: p.e, n: p.n, z: p.z, ptNum: p.ptNum, desc: p.desc });

        if (mode === "single") {
            const pts = points.slice().sort(byNum).map(pt);
            return pts.length >= 2 ? [{ id: "F1", name: "LINE-1", layer: defaultLayer("LINE"), closed: false, pts, segCodes: [] }] : [];
        }

        const ordered = points.slice().sort(byNum);
        const out = [];
        const current = {};   // key → figure currently open for that key
        let n = 0;

        /** Open/resume `key` (auto-begin if nothing's open for it yet, matching
         *  Civil 3D), push one copy of the shot onto it, honor end/close. Used
         *  for both a point's primary figure and any cross-referenced ones
         *  (see splitDesc's crossRefs — one shot can be a shared vertex of two
         *  different figures, e.g. a curb line ending and a swale beginning). */
        function apply(key, code, control, closeFlag, segCds, p) {
            if (control === "begin" || !current[key]) {
                current[key] = { id: "F" + (++n), name: key, code, layer: defaultLayer(code), closed: false, pts: [], segCodes: [] };
                out.push(current[key]);
            } else if (control === "continue" && !current[key]) {
                const prev = [...out].reverse().find(f => f.name === key);
                current[key] = prev || (current[key] = { id: "F" + (++n), name: key, code, layer: defaultLayer(code), closed: false, pts: [], segCodes: [] });
                if (!prev) out.push(current[key]);
            }
            const fig = current[key];
            const P = pt(p); P.codes = segCds.slice();
            fig.pts.push(P);
            segCds.forEach(c => { if (fig.segCodes.indexOf(c) === -1) fig.segCodes.push(c); });

            if (closeFlag) { fig.closed = true; current[key] = null; }
            else if (control === "end") { current[key] = null; }
        }

        const pointOnly = CODESET.pointOnly || [];
        ordered.forEach(p => {
            const d = splitDesc(p.desc);
            if (pointOnly.indexOf(d.code) === -1) {
                const key = mode === "byFigure" ? `${d.code} #${d.fig}` : d.code;
                apply(key, d.code, d.control, d.closeFlag, d.segCodes, p);
            }

            (d.crossRefs || []).forEach(cr => {
                if (pointOnly.indexOf(cr.code) !== -1) return;
                const crKey = mode === "byFigure" ? `${cr.code} #1` : cr.code;
                apply(crKey, cr.code, cr.control, cr.closeFlag, cr.segCodes, p);
            });
        });

        return resolveGeometry(out.filter(f => f.pts.length >= 2));
    }

    /** Parse a bearing/distance call list into a single figure. */
    function parseCalls(text, start) {
        const legs = [];
        String(text || "").split(/\r?\n/).forEach(line => {
            const s = line.trim();
            if (!s) return;
            const b = window.COGO.parseBearing(s);
            const d = s.match(/([\d,]+(?:\.\d+)?)\s*(?:feet|foot|ft|')?\s*$/i);
            if (b && d) legs.push({ kind: "line", azimuthDeg: b.azimuthDeg, distance: parseFloat(d[1].replace(/,/g, "")) });
        });
        if (!legs.length) return null;
        const tr = window.COGO.runTraverse(legs, start || { e: 0, n: 0 });
        const pts = tr.vertices.map((v, i) => ({ e: v.e, n: v.n, ptNum: 500 + i, desc: "COGO " + (i === 0 ? "POB" : "P" + i) }));
        // A call list is a traverse: closure/misclosure is meaningful here (unlike a
        // polygon of located corners). Flag it so checkModel runs the closure test.
        const closes = pts.length >= 3 && window.COGO.distanceBetween(pts[pts.length - 1], pts[0]) < 1;
        return {
            id: "F1", name: "TRAVERSE-1", layer: defaultLayer("BND"),
            closed: closes, fromCalls: true, pts
        };
    }

    // ── Checks ───────────────────────────────────────────────────────────────

    function segsProperlyCross(a, b, c, d) {
        const cr = (p, q, r) => (r.n - p.n) * (q.e - p.e) - (q.n - p.n) * (r.e - p.e);
        const d1 = cr(c, d, a), d2 = cr(c, d, b), d3 = cr(a, b, c), d4 = cr(a, b, d);
        return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
               ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
    }

    function selfIntersection(pts, closed) {
        const n = closed ? pts.length : pts.length - 1;
        const P = i => pts[i % pts.length];
        for (let i = 0; i < n; i++) {
            for (let j = i + 2; j < n; j++) {
                if (i === 0 && j === n - 1 && closed) continue;
                if (segsProperlyCross(P(i), P(i + 1), P(j), P(j + 1))) return { i: i + 1, j: j + 1 };
            }
        }
        return null;
    }

    function checkModel(model, opts) {
        opts = opts || {};
        const closeTol = nz(opts.closeTol, 0.1);
        const snapTol = nz(opts.snapTol, 0.1);
        const out = [];
        const add = (sev, msg, figId, idx, fix) => out.push({ sev, msg, figId, idx, fix });

        // duplicate point numbers across the whole dataset
        const seen = new Map();
        model.figures.forEach(f => f.pts.forEach(p => {
            if (p.ptNum == null) return;
            seen.set(p.ptNum, (seen.get(p.ptNum) || 0) + 1);
        }));
        const dups = [...seen].filter(([, c]) => c > 1).map(([n]) => n);
        if (dups.length) add("WARNING", `Duplicate point number(s): ${dups.slice(0, 12).join(", ")}${dups.length > 12 ? "…" : ""}`, null, null, null);

        model.figures.forEach(f => {
            const pts = f.pts;
            if (f.isCircle && f.circle) {
                add("INFO", `${f.name}: circle from CIR code — center (${f.circle.cx.toFixed(2)}, ${f.circle.cy.toFixed(2)}), R ${f.circle.r.toFixed(2)} ft.`, f.id, null, null);
                return;
            }
            if (pts.length < 2) { add("WARNING", `${f.name}: only ${pts.length} point — nothing to draw.`, f.id, null, null); return; }

            if (f.arcs && f.arcs.length) {
                f.arcs.forEach(a => {
                    const msg = `${f.name}: circular arc fitted from BC..EC — R ${a.r.toFixed(2)} ft${a.ccw ? " (left)" : " (right)"}, ${a.endIdx - a.startIdx + 1} shots, fit residual ${a.dev.toFixed(3)} ft.`;
                    add(a.dev > 0.25 ? "WARNING" : "INFO", msg, f.id, a.startIdx, { type: "goto", figId: f.id, kind: "vert", idx: a.startIdx });
                });
            }
            if (f.geomWarn) add("WARNING", `${f.name}:${f.geomWarn}`, f.id, null, null);
            if (f.geomNote) add("INFO", `${f.name}: ${f.geomNote}`, f.id, null, null);

            const otherCodes = (f.segCodes || []).filter(c =>
                !CODESET.curveBegin.concat(CODESET.curveEnd, CODESET.curvePoint, CODESET.circleWhole, ["RECT"]).includes(c));
            if (otherCodes.length) {
                add("INFO", `${f.name}: field code(s) ${otherCodes.join(", ")} recognized but not built as geometry (RT right-turn, X extend, RPN/CPN recall/connect, H/V/SO offsets) — apply in CAD.`, f.id, null, null);
            }

            // zero-length / duplicate consecutive
            for (let i = 1; i < pts.length; i++) {
                if (window.COGO.distanceBetween(pts[i - 1], pts[i]) < Math.max(1e-6, snapTol / 5)) {
                    add("ERROR", `${f.name}: coincident consecutive points at #${pts[i].ptNum ?? i} (zero-length course).`,
                        f.id, i, { type: "delVertex", figId: f.id, idx: i });
                }
            }
            // spike / backtrack (interior included angle ~0) — skip when an adjacent
            // course is near-zero-length (that case is reported separately).
            for (let i = 1; i < pts.length - 1; i++) {
                const inLen = window.COGO.distanceBetween(pts[i - 1], pts[i]);
                const outLen = window.COGO.distanceBetween(pts[i], pts[i + 1]);
                if (inLen < 0.05 || outLen < 0.05) continue;
                const ang = window.COGO.includedAngleDeg(pts[i - 1], pts[i], pts[i + 1]);
                if (ang < 3) {
                    add("WARNING", `${f.name}: spike / backtrack at #${pts[i].ptNum ?? i} (course reverses ~${ang.toFixed(1)}°). Likely a mis-sequenced shot.`,
                        f.id, i, { type: "delVertex", figId: f.id, idx: i });
                }
            }
            // non-consecutive near-coincident vertices → merge candidates
            let merges = 0;
            for (let i = 0; i < pts.length && merges < 4; i++) {
                for (let j = i + 2; j < pts.length && merges < 4; j++) {
                    if (i === 0 && j === pts.length - 1) continue;
                    if (window.COGO.distanceBetween(pts[i], pts[j]) < snapTol) {
                        add("INFO", `${f.name}: #${pts[i].ptNum ?? i} and #${pts[j].ptNum ?? j} are within ${snapTol} ft — merge?`,
                            f.id, i, { type: "merge", figId: f.id, i, j });
                        merges++;
                    }
                }
            }
            // envelope — not meaningful for a local call-list traverse (no SPC position)
            if (!f.fromCalls) {
                const oob = pts.find(p => p.e < FL_ENV.minE || p.e > FL_ENV.maxE || p.n < FL_ENV.minN || p.n > FL_ENV.maxN);
                if (oob) add("WARNING", `${f.name}: coordinates outside the Florida State Plane envelope (e.g. E ${oob.e.toFixed(1)}, N ${oob.n.toFixed(1)}).`, f.id, null, null);
            }

            // self-intersection
            const bt = selfIntersection(pts, f.closed);
            if (bt) add("ERROR", `${f.name}: self-intersecting (bow-tie) — course ${bt.i} crosses course ${bt.j}. Check bearing quadrant / point order.`,
                f.id, bt.i - 1, { type: "untangle", figId: f.id });

            // Closed figures.
            if (f.closed && pts.length >= 3) {
                const gap = window.COGO.distanceBetween(pts[pts.length - 1], pts[0]);
                const area = window.COGO.shoelaceArea(pts);
                if (f.fromCalls) {
                    // A traverse from bearing/distance calls: the end-to-POB gap IS the misclosure.
                    let per = 0;
                    for (let i = 1; i < pts.length; i++) per += window.COGO.distanceBetween(pts[i - 1], pts[i]);
                    const prec = gap > 1e-4 ? per / gap : Infinity;
                    if (gap > 0.1) {
                        add("WARNING", `${f.name}: traverse misclosure ${gap.toFixed(3)} ft (precision ${prec === Infinity ? "exact" : "1:" + Math.round(prec).toLocaleString()}). Review the courses.`, f.id, null, null);
                    } else {
                        add("INFO", `${f.name}: closes ${gap.toFixed(3)} ft · precision ${prec === Infinity ? "exact" : "1:" + Math.round(prec).toLocaleString()} · area ${(area / window.COGO.SQFT_PER_ACRE).toFixed(3)} ac.`, f.id, null, null);
                    }
                } else if (gap < Math.max(closeTol, 0.05)) {
                    // Located corners with the POB re-shot as the last point → redundant.
                    add("INFO", `${f.name}: last shot #${pts[pts.length - 1].ptNum ?? "last"} duplicates the POB — redundant, safe to remove. Area ${(area / window.COGO.SQFT_PER_ACRE).toFixed(3)} ac.`,
                        f.id, pts.length - 1, { type: "delVertex", figId: f.id, idx: pts.length - 1 });
                } else {
                    add("INFO", `${f.name}: closed polygon · ${pts.length} corners · area ${(area / window.COGO.SQFT_PER_ACRE).toFixed(3)} ac (${area.toFixed(0)} sf).`, f.id, null, null);
                }
            }
        });

        // figure-to-figure crossing
        for (let a = 0; a < model.figures.length; a++) {
            for (let b = a + 1; b < model.figures.length; b++) {
                const fa = model.figures[a], fb = model.figures[b];
                let crossed = false;
                const segs = f => { const n = f.closed ? f.pts.length : f.pts.length - 1; const r = []; for (let i = 0; i < n; i++) r.push([f.pts[i], f.pts[(i + 1) % f.pts.length]]); return r; };
                const A = segs(fa), B = segs(fb);
                for (const s of A) { for (const t of B) { if (segsProperlyCross(s[0], s[1], t[0], t[1])) { crossed = true; break; } } if (crossed) break; }
                if (crossed) add("INFO", `${fa.name} crosses ${fb.name}.`, fa.id, null, null);
            }
        }

        const rank = { ERROR: 0, WARNING: 1, INFO: 2 };
        return out.sort((x, y) => rank[x.sev] - rank[y.sev]);
    }

    window.LineworkEngine = {
        FL_ENV, nz, SAMPLE, tokenizeLine, parsePointFile, CODESET, CODESET_PROFILES, applyCodesetProfile, inSet, ARC_FIT, classifyToken, splitDesc, defaultLayer, byNum, circumcircle, fitCircle, resolveGeometry, buildFigures, parseCalls, segsProperlyCross, selfIntersection, checkModel
    };
})();
