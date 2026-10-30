/**
 * Plugin: efbk (Electronic Field Book)
 * plugins/efbk/efbk.js
 *
 * Implements the planimetric data model from FDOT's Electronic Field Book
 * (EFB) system — Point Naming, Reference Naming, P/C point Geometry, the
 * Chain List mini-language, Attributes/Zones, and Feature Codes — as
 * described in the FDOT "EFB User's Handbook" and "EFBP Processing
 * Handbook". Feeds a compatible figures model into plugins/linework/
 * linework.js (window.Linework.buildLineworkScript, window.COGO.buildDxf)
 * and can push a built model straight into the Linework Editor.
 *
 * Deliberately OUT of scope (not what "support the linework plugin" calls
 * for, and not realistic for a static client-side app):
 *   - the 1990s DOS field-computer hardware/menu layer (Segment Manager,
 *     RAM disk file management, .BAT startup, time-zone/date screens) —
 *     those describe a specific handheld's operating environment, not a
 *     data model.
 *   - raw angle/distance observation reduction (HVD-Obs / SOR-Obs data
 *     entry) and the least-squares network adjustment in EFBP — a whole
 *     separate discipline (see the EFBP Processing Handbook, Ch. 3, 6-11).
 *     This plugin, like every other tool in this app, works from already-
 *     reduced N/E/Z coordinates.
 *   - the HVD cross-section STATION/OFFSET-to-baseline computation itself
 *     (needs an alignment geometry engine) — the feature-code FORMAT for it
 *     is parsed (parseHVDFeatureCode) so the data survives round-trip, but
 *     no offset/end-area math is performed.
 *
 * Registers via window.PluginRegistry. Depends on core/cogo.js and
 * plugins/linework/linework.js (window.Linework.circumcircle,
 * window.Linework.buildLineworkScript; window.COGO.buildDxf/downloadText).
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "efbk",
        version: "1.0.0",
        description: "FDOT Electronic Field Book data model: point/reference naming, P/C curve geometry, the chain-list mini-language, attributes/zones and feature codes — builds linework-compatible figures for the Linework Editor.",
        tab: "tab-efbk",
        icon: "fa-book-open",
        tier: "Pro",
        dependencies: ["linework"],
    };

    const clean = window.cleanText; // core/safe-dom.js — shared across every plugin that sanitizes text before interpolation

    // ═════════════════════════════════════════════════════════════════════
    // Point naming — EFB User's Handbook, "(a) Point Naming"
    // ═════════════════════════════════════════════════════════════════════

    /** "TAN19" -> { prefix:"TAN", suffix:"19", suffixNum:19 }. The trailing
     *  digit run is the suffix (matches the handbook's exhaustive point-name
     *  capacity table, e.g. AAAAAAA1..AAAAAAA9). No trailing digits ->
     *  suffix null (a bare prefix, used by the chain-list global listing). */
    function splitPointName(name) {
        const s = String(name || "");
        const m = s.match(/^(.*?)(\d+)$/);
        if (m) return { prefix: m[1], suffix: m[2], suffixNum: parseInt(m[2], 10) };
        return { prefix: s, suffix: null, suffixNum: null };
    }
    function formatPointName(prefix, suffix) { return `${prefix}${suffix}`; }

    /** "10+00" | "13+66.273" | "1366.273" -> a plain station number. */
    function parseStationValue(raw) {
        const s = String(raw || "").trim();
        if (!s) return null;
        const plus = s.match(/^(\d+)\+(\d+(?:\.\d+)?)$/);
        if (plus) return parseFloat(plus[1]) * 100 + parseFloat(plus[2]);
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : null;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Reference naming — "(b) Reference Naming"
    // ═════════════════════════════════════════════════════════════════════

    /** A leading "." marks a point establishing NEW control (vs. an existing,
     *  already-databased control point); spaces print as underbars. */
    function parseReferenceName(raw) {
        const s = String(raw || "").trim();
        if (!s) return null;
        const isNewControl = s.startsWith(".");
        const body = isNewControl ? s.slice(1) : s;
        const name = body.replace(/ /g, "_");
        return { name, isNewControl, tooLong: name.length > 16 };
    }

    // ═════════════════════════════════════════════════════════════════════
    // Feature codes — "(e) Identifying Objects"
    // ═════════════════════════════════════════════════════════════════════

    /** "TREE-48" WHITE OAK" -> {code:"TREE", description:"48\" WHITE OAK"}.
     *  "99-PLACE TEXT HERE" -> a text-only annotation (no symbol/line). */
    function parseFeatureCode(raw) {
        const s = String(raw || "").trim();
        if (!s) return { code: "", description: "" };
        if (/^99(-|$)/.test(s)) return { code: "99", description: s.replace(/^99-?/, ""), textOnly: true };
        const dash = s.indexOf("-");
        if (dash === -1) return { code: s, description: "" };
        return { code: s.slice(0, dash), description: s.slice(dash + 1) };
    }

    /** HVD cross-section feature code, only meaningful when a point's
     *  attribute is "X": "alignment,station,L|R|B". Parses the format so
     *  the data round-trips; does NOT compute the station/offset itself
     *  (needs an alignment engine — see file header). */
    function parseHVDFeatureCode(raw) {
        const parts = String(raw || "").split(",").map(x => x.trim());
        if (parts.length !== 3) return null;
        const [alignment, stationRaw, orientation] = parts;
        if (!alignment || !/^[LRB]$/i.test(orientation)) return null;
        const station = parseStationValue(stationRaw);
        if (station == null) return null;
        return { alignment, station, orientation: orientation.toUpperCase() };
    }

    // Feature code aliases (TS_FEAT.COD equivalent) — empty by default, a
    // project can populate window.EFBK.FEATURE_ALIASES["shorthand"] = "REAL".
    const FEATURE_ALIASES = {};
    function resolveFeatureAlias(code) {
        const c = String(code || "").toUpperCase();
        return FEATURE_ALIASES[c] || c;
    }

    // ═════════════════════════════════════════════════════════════════════
    // Point rows / point database
    // Row format (this plugin's own plaintext serialization — the handbook
    // describes binary .RAW / data-screen concepts, not a text row):
    //   NAME,N,E,Z,GEOM,ATTR,ZONE,REFNAME,FEATURE[,...]
    // GEOM: P or C (default P). ATTR: G|X|F|U (optional). ZONE: 1-9 (optional).
    // FEATURE is everything after the 8th comma, rejoined — so an HVD
    // "alignment,station,L" feature code (attr=X) survives intact.
    // ═════════════════════════════════════════════════════════════════════

    function parseEfbRow(line, idx) {
        const raw = String(line || "");
        const s = raw.trim();
        if (!s || s.startsWith("#") || s.startsWith(";")) return null;
        const toks = s.split(",").map(t => t.trim());
        if (toks.length < 3) return { error: `line ${idx}: need at least NAME,N,E`, line: idx };
        const [nameRaw, nRaw, eRaw, zRaw, geomRaw, attrRaw, zoneRaw, refRaw] = toks;
        const featRaw = toks.slice(8).join(",");
        const n = parseFloat(nRaw), e = parseFloat(eRaw);
        if (!nameRaw || !Number.isFinite(n) || !Number.isFinite(e)) return { error: `line ${idx}: bad NAME/N/E`, line: idx };
        const z = zRaw !== undefined && zRaw !== "" ? parseFloat(zRaw) : 0;
        const { prefix, suffix, suffixNum } = splitPointName(nameRaw);
        if (suffix == null) return { error: `line ${idx}: "${nameRaw}" has no numeric suffix — point names need a prefix + numeric suffix`, line: idx };
        const geom = geomRaw && geomRaw.toUpperCase() === "C" ? "C" : "P";
        const attr = attrRaw ? attrRaw.toUpperCase() : null;
        if (attr && "GXFU".indexOf(attr) === -1) return { error: `line ${idx}: unknown attribute "${attr}" (expected G, X, F or U)`, line: idx };
        const zone = zoneRaw ? parseInt(zoneRaw, 10) : null;
        if (zone != null && (!Number.isInteger(zone) || zone < 1 || zone > 9)) return { error: `line ${idx}: zone must be 1-9`, line: idx };
        let feature = null, hvd = null;
        if (featRaw) {
            if (attr === "X") {
                hvd = parseHVDFeatureCode(featRaw);
                if (!hvd) return { error: `line ${idx}: attribute X requires a feature code "alignment,station,L|R|B"`, line: idx };
            } else {
                feature = parseFeatureCode(featRaw);
            }
        }
        const reference = refRaw ? parseReferenceName(refRaw) : null;
        return { name: nameRaw, prefix, suffix, suffixNum, n, e, z: Number.isFinite(z) ? z : 0, geom, attr, zone, feature, hvd, reference, srcLine: idx };
    }

    /** -> { points: Map<name, row>, order: [name...], errors: [...] } */
    function parseEfbPoints(text) {
        const points = new Map();
        const order = [];
        const errors = [];
        String(text || "").split(/\r?\n/).forEach((line, i) => {
            const r = parseEfbRow(line, i + 1);
            if (!r) return;
            if (r.error) { errors.push(r.error); return; }
            if (points.has(r.name)) { errors.push(`line ${r.srcLine}: duplicate point name "${r.name}" (earlier one kept)`); return; }
            points.set(r.name, r);
            order.push(r.name);
        });
        return { points, order, errors };
    }

    // ═════════════════════════════════════════════════════════════════════
    // Chain lists — "(c) Planimetric Information / 4. Chain lists / 5. Rules"
    // ═════════════════════════════════════════════════════════════════════

    function splitTrailingDigits(s) {
        const m = String(s || "").match(/^(.*?)(\d+)$/);
        return m ? { prefix: m[1], suffix: m[2] } : { prefix: s, suffix: null };
    }

    /** One chain-list token -> the point name(s) it expands to, honoring:
     *  bare prefix = global list ascending; leading "-" = descending;
     *  "PREFIXa-b" = range a..b (direction from a vs b); a bare number with
     *  no prefix uses the prefix carried from the last token that had one. */
    function resolveChainToken(raw, pointsByPrefix, carriedPrefix) {
        let s = String(raw || "").trim();
        let descending = false;
        if (s.startsWith("-")) { descending = true; s = s.slice(1); }
        const dashIdx = s.indexOf("-");
        const head = dashIdx === -1 ? s : s.slice(0, dashIdx);
        const tailDigits = dashIdx === -1 ? null : s.slice(dashIdx + 1);
        const { prefix: headPrefix, suffix: headSuffix } = splitTrailingDigits(head);
        const prefix = headPrefix || carriedPrefix;
        if (!prefix) return { error: `chain token "${raw}": no prefix given and none carried from an earlier token` };

        const bucket = (pointsByPrefix.get(prefix) || []).slice().sort((a, b) => a.suffixNum - b.suffixNum);

        if (headSuffix == null && tailDigits == null) {
            if (!bucket.length) return { error: `chain token "${raw}": prefix "${prefix}" matches no points` };
            const list = descending ? bucket.slice().reverse() : bucket;
            return { names: list.map(p => p.name), prefix };
        }
        if (tailDigits == null) return { names: [prefix + headSuffix], prefix };

        const a = parseInt(headSuffix, 10), b = parseInt(tailDigits, 10);
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const inRange = bucket.filter(p => p.suffixNum >= lo && p.suffixNum <= hi);
        const ordered = a <= b ? inRange : inRange.slice().reverse();
        return { names: ordered.map(p => p.name), prefix };
    }

    /** Resolve a chain-list string against a point database into connected
     *  runs — a "," connects, a ",," (empty token) breaks the chain into a
     *  new, unconnected run. -> { segments:[[name,...],...], errors:[...] } */
    function resolveChainList(chainListStr, points) {
        const pointsByPrefix = new Map();
        for (const p of points.values()) {
            if (!pointsByPrefix.has(p.prefix)) pointsByPrefix.set(p.prefix, []);
            pointsByPrefix.get(p.prefix).push(p);
        }
        const toks = String(chainListStr || "").split(",");
        const segments = [[]];
        let carriedPrefix = null;
        const errors = [];
        toks.forEach(raw => {
            if (raw.trim() === "") { segments.push([]); return; }
            const r = resolveChainToken(raw, pointsByPrefix, carriedPrefix);
            if (r.error) { errors.push(r.error); return; }
            carriedPrefix = r.prefix;
            const cur = segments[segments.length - 1];
            r.names.forEach(nm => {
                if (!points.has(nm)) errors.push(`chain references unknown point "${nm}"`);
                cur.push(nm);
            });
        });
        return { segments: segments.filter(s => s.length > 0), errors };
    }

    // ═════════════════════════════════════════════════════════════════════
    // P/C curve geometry — "(c).1 Geometry", "(c).2 Types of curves"
    // ═════════════════════════════════════════════════════════════════════

    const V = {
        sub: (a, b) => ({ e: a.e - b.e, n: a.n - b.n }),
        add: (a, b) => ({ e: a.e + b.e, n: a.n + b.n }),
        scale: (a, k) => ({ e: a.e * k, n: a.n * k }),
        dot: (a, b) => a.e * b.e + a.n * b.n,
        cross: (a, b) => a.e * b.n - a.n * b.e,
        norm: a => { const L = Math.hypot(a.e, a.n) || 1; return { e: a.e / L, n: a.n / L }; },
    };

    function lineIntersect(p1, d1, p2, d2) {
        const denom = V.cross(d1, d2);
        if (Math.abs(denom) < 1e-9) return null;
        const t = V.cross(V.sub(p2, p1), d2) / denom;
        return V.add(p1, V.scale(d1, t));
    }

    /**
     * The EFB's "single curve point" case: 2 P points define the back
     * tangent LINE, 2 P points define the ahead tangent LINE, and a lone
     * C point (the POC) lies somewhere on the arc between them. Solves for
     * the unique circle tangent to both lines and passing through the POC,
     * and returns the computed PC/PT (Autodesk's FIG CRV / this app's own
     * arc-fit code never had to solve this — the other two curve rules give
     * you 3+ points already ON the circle). Returns null if the tangents
     * are parallel/degenerate or no valid positive radius exists.
     */
    function circleTangentThroughPoint(back1, back2, ahead1, ahead2, poc) {
        const backDir = V.norm(V.sub(back2, back1));
        const aheadDir = V.norm(V.sub(ahead2, ahead1));
        const PI = lineIntersect(back1, backDir, ahead1, aheadDir);
        if (!PI) return null;
        const revBack = V.scale(backDir, -1);
        const theta = Math.acos(Math.max(-1, Math.min(1, V.dot(revBack, aheadDir))));
        if (theta < 1e-6 || theta > Math.PI - 1e-6) return null;
        const half = theta / 2;
        const bisDir = V.norm(V.add(revBack, aheadDir));
        const k = 1 / Math.sin(half);
        const D = V.sub(PI, poc);
        const a = k * k - 1;
        const b = 2 * k * V.dot(D, bisDir);
        const c = V.dot(D, D);
        let candidates;
        if (Math.abs(a) < 1e-9) {
            if (Math.abs(b) < 1e-9) return null;
            candidates = [-c / b];
        } else {
            const disc = b * b - 4 * a * c;
            if (disc < 0) return null;
            const sq = Math.sqrt(disc);
            candidates = [(-b + sq) / (2 * a), (-b - sq) / (2 * a)];
        }
        candidates = candidates.filter(r => r > 1e-6);
        if (!candidates.length) return null;
        const ccw = V.cross(backDir, aheadDir) > 0;

        // The quadratic generally has TWO positive roots — both are circles
        // genuinely tangent to both lines and passing through poc (a small
        // one tucked near PI, and the real curve). Disambiguate by which one
        // actually has poc ON the arc BETWEEN pc and pt (the correct root),
        // not on the far side of the circle from it.
        let best = null;
        for (const R of candidates) {
            const center = V.add(PI, V.scale(bisDir, k * R));
            const T = R / Math.tan(half);
            const pc = V.sub(PI, V.scale(backDir, T));
            const pt = V.add(PI, V.scale(aheadDir, T));
            const a0 = Math.atan2(pc.n - center.n, pc.e - center.e);
            const a1 = Math.atan2(pt.n - center.n, pt.e - center.e);
            const aPoc = Math.atan2(poc.n - center.n, poc.e - center.e);
            let inc = a1 - a0;
            if (ccw) { while (inc <= 0) inc += 2 * Math.PI; } else { while (inc >= 0) inc -= 2 * Math.PI; }
            let toPoc = aPoc - a0;
            if (ccw) { while (toPoc < 0) toPoc += 2 * Math.PI; while (toPoc > inc + 1e-6) toPoc -= 2 * Math.PI; }
            else { while (toPoc > 0) toPoc -= 2 * Math.PI; while (toPoc < inc - 1e-6) toPoc += 2 * Math.PI; }
            const onArc = ccw ? (toPoc >= -1e-6 && toPoc <= inc + 1e-6) : (toPoc <= 1e-6 && toPoc >= inc - 1e-6);
            if (onArc) { best = { cx: center.e, cy: center.n, r: R, pc, pt, ccw }; break; }
        }
        if (!best) return null;
        return best;
    }

    function catmullRomPoint(p0, p1, p2, p3, t) {
        const t2 = t * t, t3 = t2 * t;
        const c = k => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t +
            (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
            (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
        return { e: c("e"), n: c("n") };
    }

    /** Densify a smooth-curve run (4+ C points) into a fine chord polyline —
     *  this app has no true DXF SPLINE entity support, so a smooth curve is
     *  approximated by many short straight segments (Catmull-Rom sampled).
     *  Endpoints of the run are kept exact; interior points are inserted. */
    function densifySmoothRun(pts, samplesPerSpan) {
        samplesPerSpan = samplesPerSpan || 8;
        if (pts.length < 2) return pts.slice();
        const out = [pts[0]];
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
            for (let s = 1; s <= samplesPerSpan; s++) out.push(catmullRomPoint(p0, p1, p2, p3, s / samplesPerSpan));
        }
        return out;
    }

    /**
     * Resolve one connected run of ordered points (each carrying .geom
     * "P"|"C") into the three EFB curve rules:
     *   - a run of exactly 3 C's -> a circular arc (PC/POC/PT)
     *   - a run of 4+ C's        -> a smooth curve (spline; see densifySmoothRun)
     *   - a run of exactly 2 C's -> "treated as P points" (straight)
     *   - a lone C bounded by 2 P's on each side -> the tangent-solved
     *     single-curve-point arc (circleTangentThroughPoint); PC/PT are
     *     COMPUTED and inserted. A lone C NOT so bounded has no rule in the
     *     handbook — kept as a straight vertex, flagged in `warnings`
     *     rather than silently guessing.
     * -> { pts, arcs:[{startIdx,endIdx,cx,cy,r,ccw}], smoothRuns:[{startIdx,endIdx}], warnings }
     */
    function resolveChainCurves(orderedPts) {
        const out = [], arcs = [], smoothRuns = [], warnings = [];
        let i = 0;
        while (i < orderedPts.length) {
            if (orderedPts[i].geom !== "C") { out.push(orderedPts[i]); i++; continue; }
            let j = i;
            while (j < orderedPts.length && orderedPts[j].geom === "C") j++;
            const runLen = j - i;

            if (runLen === 1) {
                const hasBack = i >= 2 && orderedPts[i - 1].geom === "P" && orderedPts[i - 2].geom === "P";
                const hasAhead = j + 1 < orderedPts.length && orderedPts[j].geom === "P" && orderedPts[j + 1].geom === "P";
                if (hasBack && hasAhead) {
                    const sol = circleTangentThroughPoint(orderedPts[i - 2], orderedPts[i - 1], orderedPts[j], orderedPts[j + 1], orderedPts[i]);
                    if (sol) {
                        const startIdx = out.length;
                        out.push({ name: orderedPts[i].name + "_PC", e: sol.pc.e, n: sol.pc.n, z: orderedPts[i].z, geom: "C", computed: true });
                        out.push(orderedPts[i]);
                        out.push({ name: orderedPts[i].name + "_PT", e: sol.pt.e, n: sol.pt.n, z: orderedPts[i].z, geom: "C", computed: true });
                        arcs.push({ startIdx, endIdx: startIdx + 2, cx: sol.cx, cy: sol.cy, r: sol.r, ccw: sol.ccw });
                    } else {
                        warnings.push(`point ${orderedPts[i].name}: tangent-arc solve failed (parallel/degenerate tangents) — kept as a straight vertex`);
                        out.push(orderedPts[i]);
                    }
                } else {
                    warnings.push(`point ${orderedPts[i].name}: isolated C point without 2 bounding P points on each side — kept as a straight vertex (undefined case per EFB rules)`);
                    out.push(orderedPts[i]);
                }
            } else if (runLen === 2) {
                out.push(orderedPts[i], orderedPts[i + 1]);
            } else if (runLen === 3) {
                const span = [orderedPts[i], orderedPts[i + 1], orderedPts[i + 2]];
                const cir = window.Linework && window.Linework.circumcircle(span[0], span[1], span[2]);
                const startIdx = out.length;
                out.push(...span);
                if (cir) {
                    const cross = (span[1].e - span[0].e) * (span[2].n - span[1].n) - (span[1].n - span[0].n) * (span[2].e - span[1].e);
                    arcs.push({ startIdx, endIdx: startIdx + 2, cx: cir.cx, cy: cir.cy, r: cir.r, ccw: cross > 0 });
                } else {
                    warnings.push(`points ${span[0].name}..${span[2].name}: collinear — 3-point arc not fit, kept straight`);
                }
            } else {
                const span = orderedPts.slice(i, j);
                const startIdx = out.length;
                out.push(...span);
                smoothRuns.push({ startIdx, endIdx: startIdx + span.length - 1 });
            }
            i = j;
        }
        return { pts: out, arcs, smoothRuns, warnings };
    }

    // ═════════════════════════════════════════════════════════════════════
    // Bridge to the linework figures model
    // ═════════════════════════════════════════════════════════════════════

    /** chains: [{name, featureCode, chainList}] -> figures shaped exactly
     *  like plugins/linework/linework.js's buildFigures() output, so
     *  window.Linework.buildLineworkScript / window.COGO.buildDxf / the
     *  Linework Editor (window.Linework.loadFigures) can all consume it
     *  directly. A chain list whose first and last resolved point share the
     *  same name (a lot-boundary chain, e.g. "A1,A2,A3,A4,A1") is flagged
     *  closed — EFB's chain-list language has no separate CLOSE token; the
     *  handbook's own examples close a chain by repeating the start point. */
    function buildFiguresFromChains(chains, points) {
        const figures = [];
        const allWarnings = [];
        let n = 0;
        (chains || []).forEach(chainDef => {
            const { segments, errors } = resolveChainList(chainDef.chainList, points);
            errors.forEach(e => allWarnings.push(`${chainDef.name}: ${e}`));
            segments.forEach((seg, segIdx) => {
                const orderedPts = seg.map(nm => points.get(nm)).filter(Boolean)
                    .map(p => ({ name: p.name, ptNum: p.name, desc: p.name, e: p.e, n: p.n, z: p.z, geom: p.geom }));
                if (orderedPts.length < 2) return;
                const resolved = resolveChainCurves(orderedPts);
                resolved.warnings.forEach(w => allWarnings.push(`${chainDef.name}: ${w}`));
                const first = orderedPts[0], last = orderedPts[orderedPts.length - 1];
                const closed = orderedPts.length > 2 && first.name === last.name;
                const code = resolveFeatureAlias(chainDef.featureCode || chainDef.name);
                figures.push({
                    id: "F" + (++n),
                    name: segments.length > 1 ? `${chainDef.name}-${segIdx + 1}` : chainDef.name,
                    code, layer: code, closed,
                    pts: resolved.pts, arcs: resolved.arcs, smoothRuns: resolved.smoothRuns,
                });
            });
        });
        return { figures, warnings: allWarnings };
    }

    /** A figure with smoothRuns isn't understood by the DXF/script exporters
     *  (bulge-arc rendering only knows circular arcs) — flatten each smooth
     *  run into literal straight-chord vertices so the figure exports
     *  cleanly. Circular arcs (f.arcs) are left as real arcs. */
    function flattenForExport(figures) {
        return figures.map(f => {
            if (!f.smoothRuns || !f.smoothRuns.length) return { code: f.code, layer: f.layer, closed: f.closed, pts: f.pts, arcs: f.arcs || [] };
            const runs = f.smoothRuns.slice().sort((a, b) => a.startIdx - b.startIdx);
            const pts = [];
            const arcs = [];
            let i = 0;
            while (i < f.pts.length) {
                const run = runs.find(r => r.startIdx === i);
                if (run) {
                    const span = f.pts.slice(run.startIdx, run.endIdx + 1);
                    densifySmoothRun(span).forEach(p => pts.push(p));
                    i = run.endIdx + 1;
                } else {
                    pts.push(f.pts[i]);
                    i++;
                }
            }
            (f.arcs || []).forEach(a => arcs.push(a)); // indices among circular-arc spans are unaffected by smooth-run flattening order here since EFB runs don't overlap circular runs
            return { code: f.code, layer: f.layer, closed: f.closed, pts, arcs };
        });
    }

    // ── Minimal UI & Presets ────────────────────────────────────────────────

    const PRESETS = {
        lot: {
            name: "Closed Lot Boundary",
            points: [
                "A1,2015000.00,642000.00,10.0,P,,,,",
                "A2,2015000.00,642300.00,10.0,P,,,,",
                "A3,2015200.00,642300.00,10.0,P,,,,",
                "A4,2015200.00,642000.00,10.0,P,,,,",
            ].join("\n"),
            chains: "LOT1,BND,A1-4,A1",
        },
        curve: {
            name: "Tangent P/C Curve",
            points: [
                "T1,2000.66,1254.95,10.0,P,,,,",
                "T2,2039.87,1247.00,10.0,P,,,,",
                "T3,2151.30,1199.02,10.0,C,,,,",
                "T4,2227.34,1104.49,10.0,P,,,,",
                "T5,2245.48,1068.84,10.0,P,,,,",
            ].join("\n"),
            chains: "CURVE1,EP,T1-5",
        },
        spline: {
            name: "Smooth Spline (4+ C)",
            points: [
                "S1,2000.00,2000.00,15.0,P,,,,",
                "S2,2040.00,2030.00,15.0,C,,,,",
                "S3,2080.00,2010.00,15.0,C,,,,",
                "S4,2120.00,2040.00,15.0,C,,,,",
                "S5,2160.00,2020.00,15.0,C,,,,",
                "S6,2200.00,2050.00,15.0,P,,,,",
            ].join("\n"),
            chains: "SWALE1,SWL,S1-6",
        },
    };

    const state = { pointsText: PRESETS.lot.points, chainsText: PRESETS.lot.chains, lastModel: null };

    function loadPreset(key, ctx) {
        const p = PRESETS[key];
        if (!p) return;
        state.pointsText = p.points;
        state.chainsText = p.chains;
        const ptEl = document.getElementById("efbk-points");
        if (ptEl) ptEl.value = p.points;
        const chEl = document.getElementById("efbk-chains");
        if (chEl) chEl.value = p.chains;
        if (ctx) {
            build(ctx);
            ctx.showToast(`Loaded preset: ${p.name}`);
        }
    }

    window.EFBK = {
        splitPointName, formatPointName, parseStationValue,
        parseReferenceName,
        parseFeatureCode, parseHVDFeatureCode, FEATURE_ALIASES, resolveFeatureAlias,
        parseEfbRow, parseEfbPoints,
        splitTrailingDigits, resolveChainToken, resolveChainList,
        circleTangentThroughPoint, densifySmoothRun, resolveChainCurves,
        buildFiguresFromChains, flattenForExport,
        PRESETS, loadPreset,
        getLastModel: () => {
            if (!state.lastModel) {
                const { points, order } = parseEfbPoints(state.pointsText);
                const { chains } = parseChainsText(state.chainsText);
                const { figures } = buildFiguresFromChains(chains, points);
                state.lastModel = { points, order, figures };
            }
            return state.lastModel;
        },
    };

    function parseChainsText(text) {
        // one chain per line: NAME,FEATURE,CHAINLIST
        const chains = [];
        const errors = [];
        String(text || "").split(/\r?\n/).forEach((line, i) => {
            const s = line.trim();
            if (!s || s.startsWith("#")) return;
            const parts = s.split(",");
            if (parts.length < 3) { errors.push(`chain line ${i + 1}: need NAME,FEATURE,CHAINLIST`); return; }
            chains.push({ name: parts[0].trim(), featureCode: parts[1].trim(), chainList: parts.slice(2).join(",") });
        });
        return { chains, errors };
    }

    function build(ctx) {
        const { points, order, errors: ptErrors } = parseEfbPoints(state.pointsText);
        const { chains, errors: chainErrors } = parseChainsText(state.chainsText);
        const { figures, warnings } = buildFiguresFromChains(chains, points);
        state.lastModel = { points, order, figures };
        const box = document.getElementById("efbk-results");
        if (!box) return;
        const allMsgs = [...ptErrors, ...chainErrors, ...warnings];
        window.setSafeHTML(box, `
          <div class="results-box">
            <strong>${clean(order.length)} points, ${clean(figures.length)} figure(s) built</strong>
            ${allMsgs.length ? `<details open style="margin-top:0.5rem;"><summary style="cursor:pointer; color:var(--warning);">${clean(allMsgs.length)} note(s)</summary>
              <ul style="font-size:0.8rem; color:var(--text-secondary);">${allMsgs.map(m => `<li>${clean(m)}</li>`).join("")}</ul>
            </details>` : ""}
            <div style="overflow-x:auto; margin-top:0.5rem;"><table class="data-table" style="width:100%;"><thead><tr><th>Figure</th><th>Code</th><th>Pts</th><th>Arcs</th><th>Smooth runs</th><th>Closed</th></tr></thead><tbody>
              ${figures.map(f => `<tr><td>${clean(f.name)}</td><td>${clean(f.code)}</td><td>${f.pts.length}</td><td>${f.arcs.length}</td><td>${f.smoothRuns.length}</td><td>${f.closed ? "yes" : "no"}</td></tr>`).join("") || `<tr><td colspan="6" style="color:var(--text-muted);">none</td></tr>`}
            </tbody></table></div>
          </div>`);
        ctx.showToast(figures.length ? `Built ${figures.length} figure(s).` : "No figures built — check the notes.", !figures.length);
    }

    const Plugin = {
        init(ctx) {
            const box = document.getElementById("efbk-controls");
            if (!box) return;
            window.setSafeHTML(box, `
              <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:0.75rem;">
                <span style="font-size:0.8rem; font-weight:600; color:var(--text-secondary);">Sample Presets:</span>
                <button class="btn btn-secondary btn-sm" id="efbk-preset-lot"><i class="fa-solid fa-draw-polygon"></i> Lot Boundary</button>
                <button class="btn btn-secondary btn-sm" id="efbk-preset-curve"><i class="fa-solid fa-bezier-curve"></i> Tangent Curve (P/C)</button>
                <button class="btn btn-secondary btn-sm" id="efbk-preset-spline"><i class="fa-solid fa-water"></i> Smooth Spline</button>
              </div>
              <div class="form-group">
                <label>Points <span style="color:var(--text-muted); font-weight:400;">(NAME,N,E,Z,GEOM,ATTR,ZONE,REFNAME,FEATURE)</span></label>
                <textarea id="efbk-points" aria-label="EFB points (NAME, N, E, Z, GEOM, ATTR, ZONE, REFNAME, FEATURE)" rows="8" style="width:100%; font-family:var(--font-mono); font-size:0.78rem;">${clean(state.pointsText)}</textarea>
              </div>
              <div class="form-group">
                <label>Chains <span style="color:var(--text-muted); font-weight:400;">(one per line: NAME,FEATURE,CHAINLIST)</span></label>
                <textarea id="efbk-chains" aria-label="EFB chains (NAME, FEATURE, CHAIN LIST)" rows="3" style="width:100%; font-family:var(--font-mono); font-size:0.78rem;">${clean(state.chainsText)}</textarea>
              </div>
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                <button class="btn btn-primary" id="efbk-build">Build figures</button>
                <button class="btn btn-secondary btn-sm" id="efbk-dxf">Download DXF</button>
                <button class="btn btn-secondary btn-sm" id="efbk-script">Download linework script</button>
                <button class="btn btn-secondary btn-sm" id="efbk-send">Send to Linework Editor</button>
              </div>
              <div id="efbk-results" style="margin-top:0.75rem;"></div>`);
        },
        onTabActivate() {},
        setupEvents(ctx) {
            const root = document.getElementById("tab-efbk");
            if (!root) return;
            root.addEventListener("input", e => {
                if (e.target.id === "efbk-points") state.pointsText = e.target.value;
                if (e.target.id === "efbk-chains") state.chainsText = e.target.value;
            });
            root.addEventListener("click", e => {
                const t = e.target.closest("button");
                if (!t) return;
                if (t.id === "efbk-preset-lot") { loadPreset("lot", ctx); return; }
                if (t.id === "efbk-preset-curve") { loadPreset("curve", ctx); return; }
                if (t.id === "efbk-preset-spline") { loadPreset("spline", ctx); return; }
                if (t.id === "efbk-build") { build(ctx); return; }
                if (t.id === "efbk-dxf") {
                    if (!state.lastModel || !state.lastModel.figures.length) { ctx.showToast("Build figures first.", true); return; }
                    const flat = flattenForExport(state.lastModel.figures);
                    const layers = [...new Set(flat.map(f => f.layer))].map(name => ({ name, color: 4 }));
                    const dxf = window.COGO.buildDxf({ layers, polylines: flat.map(f => ({ layer: f.layer, closed: f.closed, points: figurePolyPoints(f) })), texts: [] });
                    window.COGO.downloadText("efbk.dxf", dxf, "application/dxf");
                    return;
                }
                if (t.id === "efbk-script") {
                    if (!state.lastModel || !state.lastModel.figures.length) { ctx.showToast("Build figures first.", true); return; }
                    const script = window.Linework.buildLineworkScript(state.lastModel.figures);
                    window.COGO.downloadText("efbk_script.fbk", script, "text/plain");
                    return;
                }
                if (t.id === "efbk-send") {
                    if (!state.lastModel || !state.lastModel.figures.length) { ctx.showToast("Build figures first.", true); return; }
                    if (!window.Linework || !window.Linework.loadFigures) { ctx.showToast("Linework Editor is unavailable.", true); return; }
                    window.Linework.loadFigures(state.lastModel.figures);
                    ctx.showToast(`Sent ${state.lastModel.figures.length} figure(s) to the Linework Editor.`);
                    document.querySelector('.nav-btn[data-tab="tab-linework"]')?.click();
                    return;
                }
            });
        },
    };

    /** LWPOLYLINE vertex list for a figure, collapsing circular-arc spans
     *  into a single bulge segment (same pattern as linework.js's own
     *  figurePolyPoints — duplicated here in miniature since that one is
     *  private to the linework plugin's closure). */
    function figurePolyPoints(f) {
        const arcs = (f.arcs || []).slice().sort((a, b) => a.startIdx - b.startIdx);
        const out = [];
        for (let i = 0; i < f.pts.length; i++) {
            const a = arcs.find(x => x.startIdx === i);
            if (a) {
                const s = f.pts[a.startIdx], e = f.pts[a.endIdx];
                let a0 = Math.atan2(s.n - a.cy, s.e - a.cx), a1 = Math.atan2(e.n - a.cy, e.e - a.cx);
                let inc = a1 - a0;
                if (a.ccw) { while (inc <= 0) inc += 2 * Math.PI; } else { while (inc >= 0) inc -= 2 * Math.PI; }
                out.push({ e: s.e, n: s.n, bulge: window.COGO.bulge(inc) });
                i = a.endIdx - 1;
            } else {
                out.push({ e: f.pts[i].e, n: f.pts[i].n });
            }
        }
        return out;
    }

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);
})();
