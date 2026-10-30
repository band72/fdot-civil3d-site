/**
 * Subdivision engine — pure layout maths for plugins/subdivision (no DOM).
 * plugins/subdivision/subdivision-engine.js
 *
 * Works in a local frame on the chosen frontage edge (the existing street): u runs into the
 * parcel, v runs along the edge. Land is laid out from the back:
 *   - green space off the back of the parcel (a % of the gross area);
 *   - the rest is the buildable area. A new road enters from the frontage street (ingress) and
 *     runs in — straight, through one curve or a reverse curve — and either ends in a cul-de-sac
 *     or runs through to the back boundary (egress).
 * Lots front the road edges (or, with the road off, the existing street). Each lot is the band
 * between two stations along the road edge, out to the lot depth: lot lines are perpendicular to
 * the road, and radial around a curve or cul-de-sac bulb. Retention ponds run behind the lots,
 * parallel to the road: a strip from the lot depth outward, its width solved to hold the required
 * area (sized from the impervious surface, or typed in), split into equal ponds and connected in
 * series, each to the road, or not at all. Every piece is clipped to the parcel
 * with half-plane (Sutherland–Hodgman) clipping against convex pieces, so areas are exact, also
 * for concave parcels. Lots on the inside of a curve can't be deeper than its inside radius,
 * which keeps them from overlapping.
 *
 * A concept layout for yield studies — not a plat, not a drainage design. Setbacks, easements,
 * pond side slopes and grading are not modelled; default settings are starting values to check
 * against the governing land development code and water management district rules.
 *
 * Exposes window.SubdivisionEngine = { parseBoundary, layout, recommended, validate, bestLots,
 *   maxLots, pondAreaRequired, roadPosAt, toDxf, toPdf, ... }.
 */
(function () {
    "use strict";

    const SQFT_PER_ACRE = 43560;
    const ARC_STEP_DEG = 2;          // curve densification
    const BULB_SEGS = 96;

    // Starting values for a single-family subdivision. They are typical, not a code requirement.
    const RECOMMENDED = Object.freeze({
        nLots: null,            // filled with the most lots that meet every minimum
        minFrontage: 60,        // ft along the street
        minLotSF: 7500,         // sq ft
        minLotAcres: 0.17,      // acres (≈ 7,405 sq ft)
        maxLotDepth: 150,       // ft from the road edge; land beyond is remainder
        minLotDepth: 100,       // ft — each lot's average depth (area ÷ frontage) must reach this
        setbacksOn: true,       // check a building envelope inside each lot
        frontSetback: 20,       // ft from the road edge
        sideSetback: 5,         // ft from each side lot line
        rearSetback: 10,        // ft from the rear of the lot
        minBuildableSF: 0,      // sq ft the envelope must reach (0 = it just has to exist)
        cornerExtra: 10,        // ft of extra frontage for a corner lot (at a road entry / exit)
        sightLeg: 25,           // ft legs of the sight triangle kept clear at each corner (0 = none)
        easementFront: 10,      // ft utility easement along the front of each lot (0 = none)
        easementRear: 0,        // ft utility easement along the rear (0 = none)
        mergeEndLots: false,    // fold a failing first / last lot on a road side into its neighbour
        phases: 1,              // build phases, numbered from the entrance back
        roadOn: true,
        roadEnd: "culdesac",    // "culdesac" (turnaround bulb), "through" (ingress + egress), or "loop" (two roads joined at the back)
        roadWidth: 50,          // ft right-of-way, typical local street
        roadLength: null,       // ft, cul-de-sac only, to the end of the bulb — filled to fit the parcel
        culdesacRadius: 50,     // ft right-of-way radius of the turnaround bulb
        roadMaxPct: 25,         // allowable road area as % of gross (sets roadMaxSF)
        roadMaxSF: null,        // sq ft — filled from roadMaxPct × gross
        roadPos: 50,            // where the road enters along the frontage, % of the parcel area to its left
        roadCount: 1,           // 1, or 2 parallel straight roads
        roadPos2: 75,           // second road's entry, % of the parcel area to its left
        alignment: "straight",  // "straight", "curve" (one curve) or "reverse" (reverse curve)
        turn: "left",           // direction of the first curve, driving in
        tangent1: 150,          // ft of straight road before the first curve
        radius1: 300,           // ft centreline radius
        delta1: 30,             // degrees of deflection
        tangent2: 100,          // ft of straight road between the curves of a reverse curve
        radius2: 300,
        delta2: 30,
        greenOn: true,
        greenPct: 10,           // required green space, % of gross area
        pondsOn: true,
        imperviousPct: 40,      // impervious surface, % of gross area
        treatmentIn: 1.0,       // inches of runoff from the impervious area to retain
        pondDepthFt: 3,         // ft average water depth (side slopes not modelled)
        pondSizeAuto: true,     // size the ponds from the three values above
        pondSF: null,           // sq ft required — filled from the sizing (or typed when not auto)
        pondCount: 2,
        pondShape: "fixed",     // "fixed" — ponds pondWidth wide, as long as needed, at the back; "fit" — a strip along the whole road
        pondWidth: 40,          // ft, for fixed-width ponds (top of bank)
        pondSideSlope: 4,       // horizontal per 1 vertical — fixed-width ponds sized from a volume
        pondFreeboard: 1,       // ft above the design water level
        pondLink: "series"      // "series" (pond to pond, then to the road), "road" (each to the road), "none"
    });

    // Lot standards from the City of Jacksonville / Duval County zoning code (Ordinance Code §656.305,
    // Residential Low Density districts — minimum lot width and area for a single-family dwelling,
    // and minimum front / side / rear yards, per the City's RLD district summary of 01.31.2022).
    // Verify against the current code text.
    const PRESETS = [
        { id: "JAX-RLD-40", label: "Jacksonville RLD-40", minFrontage: 40, minLotSF: 4000, frontSetback: 20, sideSetback: 3, rearSetback: 10 },
        { id: "JAX-RLD-50", label: "Jacksonville RLD-50", minFrontage: 50, minLotSF: 5000, frontSetback: 20, sideSetback: 5, rearSetback: 10 },
        { id: "JAX-RLD-60", label: "Jacksonville RLD-60", minFrontage: 60, minLotSF: 6000, frontSetback: 20, sideSetback: 5, rearSetback: 10 },
        { id: "JAX-RLD-70", label: "Jacksonville RLD-70", minFrontage: 70, minLotSF: 7200, frontSetback: 20, sideSetback: 5, rearSetback: 10 },
        { id: "JAX-RLD-90", label: "Jacksonville RLD-90", minFrontage: 90, minLotSF: 9900, frontSetback: 20, sideSetback: 5, rearSetback: 10 },
        { id: "JAX-RLD-100A", label: "Jacksonville RLD-100A", minFrontage: 100, minLotSF: 21780, frontSetback: 25, sideSetback: 7.5, rearSetback: 10 },
        { id: "JAX-RLD-100B", label: "Jacksonville RLD-100B", minFrontage: 100, minLotSF: 14000, frontSetback: 20, sideSetback: 7.5, rearSetback: 10 }
    ].map(p => Object.assign(p, { minLotAcres: Math.floor(p.minLotSF / SQFT_PER_ACRE * 1000) / 1000, source: "City of Jacksonville Ordinance Code §656.305 (RLD district summary, 01.31.2022)" }));
    /** Settings with a preset's lot minimums applied. */
    function applyPreset(s, id) {
        const p = PRESETS.find(x => x.id === id);
        if (!p) throw new Error(`Unknown preset "${id}".`);
        return Object.assign({}, s, { minFrontage: p.minFrontage, minLotSF: p.minLotSF, minLotAcres: p.minLotAcres,
            frontSetback: p.frontSetback, sideSetback: p.sideSetback, rearSetback: p.rearSetback });
    }

    // ── Polygon helpers (points are {u, v} in the local frame) ───────────────

    function signedArea(poly) {
        let s = 0;
        for (let i = 0, n = poly.length; i < n; i++) {
            const a = poly[i], b = poly[(i + 1) % n];
            s += a.u * b.v - b.u * a.v;
        }
        return s / 2;
    }
    const area = poly => poly.length >= 3 ? Math.abs(signedArea(poly)) : 0;

    /** Keep the part of poly where p[axis] <= value (keepLess) or >= value. */
    function clip(poly, axis, value, keepLess) {
        const inside = p => keepLess ? p[axis] <= value + 1e-9 : p[axis] >= value - 1e-9;
        const out = [];
        for (let i = 0, n = poly.length; i < n; i++) {
            const a = poly[i], b = poly[(i + 1) % n], ia = inside(a), ib = inside(b);
            if (ia) out.push(a);
            if (ia !== ib) {
                const t = (value - a[axis]) / (b[axis] - a[axis]);
                out.push({ u: a.u + t * (b.u - a.u), v: a.v + t * (b.v - a.v) });
            }
        }
        return out.length >= 3 && area(out) > 1e-6 ? out : [];
    }
    const clipBox = (poly, u0, u1, v0, v1) => {
        let p = poly;
        if (u0 != null && p.length) p = clip(p, "u", u0, false);
        if (u1 != null && p.length) p = clip(p, "u", u1, true);
        if (v0 != null && p.length) p = clip(p, "v", v0, false);
        if (v1 != null && p.length) p = clip(p, "v", v1, true);
        return p;
    };

    /** Keep the part of poly to the left of the directed line through a with direction d. */
    function clipLine(poly, a, d) {
        const side = p => d.u * (p.v - a.v) - d.v * (p.u - a.u);
        const out = [];
        for (let i = 0, n = poly.length; i < n; i++) {
            const p = poly[i], q = poly[(i + 1) % n], sp = side(p), sq = side(q), ip = sp >= -1e-9, iq = sq >= -1e-9;
            if (ip) out.push(p);
            if (ip !== iq) {
                const t = sp / (sp - sq);
                out.push({ u: p.u + t * (q.u - p.u), v: p.v + t * (q.v - p.v) });
            }
        }
        return out.length >= 3 && area(out) > 1e-6 ? out : [];
    }
    /** Subject (any simple polygon) ∩ a convex polygon. */
    function clipConvex(subject, convex) {
        const c = signedArea(convex) < 0 ? convex.slice().reverse() : convex;
        let p = subject;
        for (let i = 0; i < c.length && p.length; i++) {
            const a = c[i], b = c[(i + 1) % c.length];
            p = clipLine(p, a, { u: b.u - a.u, v: b.v - a.v });
        }
        return p;
    }
    const areaIn = (subject, convexes) => subject.length ? convexes.reduce((t, c) => t + area(clipConvex(subject, c)), 0) : 0;

    const bounds = poly => poly.reduce((b, p) => ({
        u0: Math.min(b.u0, p.u), u1: Math.max(b.u1, p.u), v0: Math.min(b.v0, p.v), v1: Math.max(b.v1, p.v)
    }), { u0: Infinity, u1: -Infinity, v0: Infinity, v1: -Infinity });

    /** Value t in [lo, hi] where f(t) = target, for f increasing in t. */
    function solve(f, target, lo, hi) {
        for (let i = 0; i < 60; i++) {
            const mid = (lo + hi) / 2;
            if (f(mid) < target) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    /** Intervals of the free axis where the line {constAxis = value} lies inside poly (even–odd). */
    function lineIntervals(poly, value, constAxis) {
        const c = constAxis || "v", f = c === "v" ? "u" : "v";
        const xs = [];
        for (let i = 0, n = poly.length; i < n; i++) {
            const a = poly[i], b = poly[(i + 1) % n];
            if ((a[c] <= value) !== (b[c] <= value)) xs.push(a[f] + (value - a[c]) / (b[c] - a[c]) * (b[f] - a[f]));
        }
        xs.sort((x, y) => x - y);
        const out = [];
        for (let i = 0; i + 1 < xs.length; i += 2) out.push([xs[i], xs[i + 1]]);
        return out;
    }
    function pointInPoly(poly, p) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const a = poly[i], b = poly[j];
            if ((a.v > p.v) !== (b.v > p.v) && p.u < (b.u - a.u) * (p.v - a.v) / (b.v - a.v) + a.u) inside = !inside;
        }
        return inside;
    }
    const add = (p, n, k) => ({ u: p.u + n.u * k, v: p.v + n.v * k });
    const unit = n => { const l = Math.hypot(n.u, n.v) || 1; return { u: n.u / l, v: n.v / l }; };
    const dist = (a, b) => Math.hypot(b.u - a.u, b.v - a.v);
    const polyLen = pts => pts.reduce((t, p, i) => i ? t + dist(pts[i - 1], p) : 0, 0);

    /**
     * Merge pieces that tile a region (sharing edges exactly) into outline rings, by cancelling
     * edges that appear in both directions. Falls back to the pieces themselves if the edges
     * don't chain into closed rings.
     */
    function mergePieces(pieces) {
        if (pieces.length <= 1) return pieces.slice();
        const key = p => `${Math.round(p.u * 1e5)},${Math.round(p.v * 1e5)}`;
        const edges = new Map();
        pieces.forEach(pc => {
            const r = signedArea(pc) < 0 ? pc.slice().reverse() : pc;
            r.forEach((a, i) => {
                const b = r[(i + 1) % r.length], ka = key(a), kb = key(b);
                if (ka === kb) return;
                const rev = `${kb}>${ka}`;
                if (edges.has(rev)) edges.delete(rev); else edges.set(`${ka}>${kb}`, { a, b, ka, kb });
            });
        });
        const from = new Map();
        edges.forEach(e => { if (!from.has(e.ka)) from.set(e.ka, []); from.get(e.ka).push(e); });
        const rings = [];
        for (const start of edges.values()) {
            if (start.used) continue;
            const ring = [];
            let e = start, guard = 0;
            while (e && !e.used && guard++ < 100000) {
                e.used = true; ring.push(e.a);
                const next = (from.get(e.kb) || []).find(x => !x.used);
                if (!next) { if (e.kb !== start.ka) return pieces.slice(); break; }
                e = next;
            }
            if (ring.length >= 3) rings.push(simplify(ring));
        }
        return rings.filter(r => r.length >= 3);
    }
    /** Drop collinear and duplicate points. */
    function simplify(ring) {
        const out = [];
        for (let i = 0; i < ring.length; i++) {
            const a = ring[(i - 1 + ring.length) % ring.length], b = ring[i], c = ring[(i + 1) % ring.length];
            const cross = (b.u - a.u) * (c.v - b.v) - (b.v - a.v) * (c.u - b.u);
            if (dist(a, b) > 1e-6 && Math.abs(cross) > 1e-7 * Math.max(1, dist(a, b) * dist(b, c))) out.push(b);
        }
        return out.length >= 3 ? out : ring;
    }

    // ── Boundary input ───────────────────────────────────────────────────────

    /**
     * Boundary from text: either bearing/distance calls ("N 45-12-30 E 150.00", one per line)
     * or coordinates ("N, E", or a point file "P, N, E, Z, D" — a header row is skipped; Z and D
     * are read but don't affect the outline). opts.descFilter keeps only points whose description
     * contains that word (e.g. "BND"), in file order — for a field file with more than the boundary.
     * Returns { verts:[{n,e}], source, used, skipped } or { error }.
     */
    function parseBoundary(text, opts) {
        const C = window.COGO, filter = String((opts && opts.descFilter) || "").trim().toUpperCase();
        let lines = String(text || "").split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^[#;]/.test(s));
        // A header row (P,N,E,Z,D / Point,Northing,Easting…): its coordinate columns aren't numbers.
        if (lines.length && !C.parseBearing(lines[0])) {
            const f0 = lines[0].split(/[,\t]+|\s+/).filter(Boolean);
            if (f0.length >= 2 && !f0.slice(0, 3).some(x => isFinite(Number(x)) && x !== "")) lines = lines.slice(1);
        }
        let skipped = 0;
        if (filter) {
            const word = new RegExp(`(^|[^A-Z0-9])${filter.replace(/[^A-Z0-9]/g, "")}([^A-Z0-9]|$)`);
            const kept = lines.filter(l => { const d = l.split(/[,\t]/).slice(4).join(" ").toUpperCase() || l.split(/\s+/).slice(4).join(" ").toUpperCase(); return word.test(d); });
            skipped = lines.length - kept.length;
            if (!kept.length) return { error: `No points have "${filter}" in their description.` };
            lines = kept;
        }
        if (!lines.length) return { error: "Enter a boundary: bearing/distance calls or N,E coordinates, one per line." };
        const isCalls = lines.every(l => C.parseBearing(l));
        let verts = [];
        if (isCalls) {
            const legs = [];
            for (let i = 0; i < lines.length; i++) {
                const b = C.parseBearing(lines[i]), d = lines[i].match(/([\d,]+(?:\.\d+)?)\s*(?:feet|foot|ft|')?\s*$/i);
                if (!d) return { error: `Line ${i + 1}: no distance in "${lines[i]}".` };
                legs.push({ azimuthDeg: b.azimuthDeg, distance: parseFloat(d[1].replace(/,/g, "")), kind: "line" });
            }
            const tr = C.runTraverse(legs);
            if (!tr.closes) return { error: `The calls don't close (misclosure ${tr.misclosure.toFixed(3)} ft). Fix the calls before subdividing.` };
            verts = tr.vertices.slice(0, -1);
        } else {
            for (let i = 0; i < lines.length; i++) {
                const f = lines[i].split(/[,\s\t]+/).filter(Boolean);
                const nums = f.map(Number);
                let n, e;
                if (f.length === 2 && nums.every(isFinite)) { n = nums[0]; e = nums[1]; }
                else if (f.length >= 3 && isFinite(nums[1]) && isFinite(nums[2])) { n = nums[1]; e = nums[2]; }
                else return { error: `Line ${i + 1}: expected "N, E" or "P, N, E" — got "${lines[i]}".` };
                verts.push({ n, e });
            }
            const f = verts[0], l = verts[verts.length - 1];
            if (verts.length > 3 && Math.hypot(f.n - l.n, f.e - l.e) < 1e-6) verts.pop();   // closing point repeated
        }
        if (verts.length < 3) return { error: "A boundary needs at least 3 corners." };
        if (C.selfIntersects(verts)) return { error: "The boundary crosses itself. Fix the corner order." };
        if (C.shoelaceArea(verts) < 1) return { error: "The boundary has no area." };
        return { verts, source: isCalls ? "calls" : "coordinates", used: verts.length, skipped };
    }

    /** Boundary edges with bearing and length, for choosing the frontage edge. */
    function edges(verts) {
        return verts.map((a, i) => {
            const b = verts[(i + 1) % verts.length];
            return { index: i, length: Math.hypot(b.e - a.e, b.n - a.n), bearing: window.COGO.azimuthToBearing(window.COGO.azimuthDegBetween(a, b)) };
        });
    }
    const longestEdge = verts => edges(verts).reduce((m, e) => e.length > m.length ? e : m).index;

    /**
     * Local frame on edge k: origin at its start, v along the edge, u into the parcel.
     * leftSign is +1 when +v is to the driver's left heading into the parcel (+u).
     */
    function frame(verts, k) {
        const a = verts[k], b = verts[(k + 1) % verts.length], len = Math.hypot(b.e - a.e, b.n - a.n);
        const de = (b.e - a.e) / len, dn = (b.n - a.n) / len;
        let ne = -dn, nn = de;                                  // left normal
        const c = verts.reduce((s, p) => ({ e: s.e + p.e / verts.length, n: s.n + p.n / verts.length }), { e: 0, n: 0 });
        if ((c.e - a.e) * ne + (c.n - a.n) * nn < 0) { ne = -ne; nn = -nn; }
        // driver's left of heading (ne, nn) in east/north is (-nn, ne)
        const leftSign = (-nn * de + ne * dn) > 0 ? 1 : -1;
        return {
            leftSign,
            toLocal: p => ({ u: (p.e - a.e) * ne + (p.n - a.n) * nn, v: (p.e - a.e) * de + (p.n - a.n) * dn }),
            toWorld: q => ({ e: a.e + q.u * ne + q.v * de, n: a.n + q.u * nn + q.v * dn })
        };
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    /** Retention pond area (sq ft) from the impervious surface: volume ÷ average depth. */
    function pondAreaRequired(gross, s) {
        return gross * (s.imperviousPct / 100) * (s.treatmentIn / 12) / s.pondDepthFt;
    }

    /** Recommended settings for a boundary: the fixed starting values plus the ones that depend on it. */
    function recommended(verts, frontEdge) {
        const k = frontEdge == null ? longestEdge(verts) : frontEdge;
        const s = Object.assign({}, RECOMMENDED, { frontEdge: k });
        const gross = window.COGO.shoelaceArea(verts);
        s.roadMaxSF = Math.round(gross * s.roadMaxPct / 100);
        s.pondSF = Math.round(pondAreaRequired(gross, s));
        s.roadLength = fitRoadLength(verts, s);
        s.nLots = bestLots(verts, s);
        return s;
    }

    /** Longest cul-de-sac that stays in the buildable area along the road's line (rounded down to 5 ft). */
    function fitRoadLength(verts, s) {
        const z = zones(verts, Object.assign({}, s, { roadEnd: "culdesac", roadLength: 1e9 }), true);
        const ivs = lineIntervals(z.W, z.vc, "v");
        const depth = ivs.length ? ivs[0][1] - ivs[0][0] : 0;
        return Math.max(2 * s.culdesacRadius + 5, Math.floor((depth - 5) / 5) * 5);
    }

    /**
     * Largest lot count whose actual layout meets every minimum (lot sizes and frontages vary on an
     * irregular parcel, so the estimate is only the upper bound to search down from).
     */
    function bestLots(verts, s) {
        for (let n = Math.max(1, maxLots(verts, s)); n > 1; n--) {
            const L = layout(verts, Object.assign({}, s, { nLots: n }), { lotsOnly: true });
            if (L.lots.length === n && L.lots.every(l => l.ok)) return n;
        }
        return 1;
    }

    /** Length of the alignment's curves and tangents before the final straight. */
    function alignmentLength(s) {
        if (s.alignment === "straight") return 0;
        let L = s.tangent1 + s.radius1 * s.delta1 * Math.PI / 180;
        if (s.alignment === "reverse") L += s.tangent2 + s.radius2 * s.delta2 * Math.PI / 180;
        return L;
    }
    const minInsideRadius = s => s.alignment === "straight" ? Infinity
        : Math.min(s.radius1, s.alignment === "reverse" ? s.radius2 : Infinity) - s.roadWidth / 2;

    /**
     * Problems with the settings, as messages (empty = valid). Blank or non-numeric input is an
     * error — never silently replaced by a default.
     */
    function validate(s, verts) {
        const errs = [];
        const ok = v => typeof v === "number" && isFinite(v);
        const num = (key, label, lo, hi, intOnly) => {
            const v = s[key];
            if (!ok(v)) { errs.push(`${label} is required.`); return; }
            if (intOnly && !Number.isInteger(v)) errs.push(`${label} must be a whole number.`);
            if (v < lo || (hi != null && v > hi)) errs.push(`${label} must be ${hi != null ? `between ${lo} and ${hi}` : `at least ${lo}`}.`);
        };
        num("nLots", "Number of lots", 1, 2000, true);
        num("minFrontage", "Minimum frontage (ft)", 0);
        num("minLotSF", "Minimum lot size (sq ft)", 0);
        num("minLotAcres", "Minimum lot size (acres)", 0);
        num("maxLotDepth", "Maximum lot depth (ft)", 20, 5000);
        num("minLotDepth", "Minimum lot depth (ft)", 0, 5000);
        if (ok(s.minLotDepth) && ok(s.maxLotDepth) && s.minLotDepth > s.maxLotDepth) errs.push("Minimum lot depth can't be more than the maximum lot depth.");
        if (s.setbacksOn) {
            num("frontSetback", "Front setback (ft)", 0, 500);
            num("sideSetback", "Side setback (ft)", 0, 500);
            num("rearSetback", "Rear setback (ft)", 0, 500);
            num("minBuildableSF", "Minimum buildable area (sq ft)", 0);
        }
        num("cornerExtra", "Corner lot extra width (ft)", 0, 500);
        num("sightLeg", "Sight triangle legs (ft)", 0, 200);
        num("easementFront", "Front easement (ft)", 0, 100);
        num("easementRear", "Rear easement (ft)", 0, 100);
        num("phases", "Number of phases", 1, 20, true);
        if (s.roadOn) {
            num("roadWidth", "Road width (ft)", 10, 300);
            num("roadMaxSF", "Allowable road area (sq ft)", 1);
            num("roadPos", "Road position (%)", 5, 95);
            if (!["culdesac", "through", "loop"].includes(s.roadEnd)) errs.push("Road end must be cul-de-sac, through or a loop.");
            if (s.roadEnd === "loop") {
                if (s.roadCount !== 2) errs.push("A loop needs two roads (joined at the back).");
                num("roadLength", "Road length (ft)", 1);
                if (ok(s.roadLength) && ok(s.roadWidth) && s.roadLength < 3 * s.roadWidth) errs.push(`Road length must be at least ${3 * s.roadWidth} ft for a loop.`);
            }
            if (!["straight", "curve", "reverse"].includes(s.alignment)) errs.push("Road alignment must be straight, one curve or a reverse curve.");
            if (s.roadCount !== 1 && s.roadCount !== 2) errs.push("Number of roads must be 1 or 2.");
            if (s.roadCount === 2) {
                num("roadPos2", "Second road position (%)", 5, 95);
                if (s.alignment !== "straight") errs.push("Two roads must both be straight — curves would make their lots overlap.");
                if (ok(s.roadPos2) && ok(s.roadPos) && Math.abs(s.roadPos2 - s.roadPos) < 5) errs.push("Put the two roads at least 5% apart.");
            }
            if (s.alignment === "curve" || s.alignment === "reverse") {
                if (s.turn !== "left" && s.turn !== "right") errs.push("Curve direction must be left or right.");
                num("tangent1", "Tangent before the first curve (ft)", 0);
                num("radius1", "First curve radius (ft)", 20, 10000);
                num("delta1", "First curve deflection (°)", 1, 120);
                if (ok(s.radius1) && ok(s.roadWidth) && s.radius1 <= s.roadWidth / 2 + 5) errs.push("First curve radius must be more than half the road width plus 5 ft.");
            }
            if (s.alignment === "reverse") {
                num("tangent2", "Tangent between the curves (ft)", 0);
                num("radius2", "Second curve radius (ft)", 20, 10000);
                num("delta2", "Second curve deflection (°)", 1, 120);
                if (ok(s.radius2) && ok(s.roadWidth) && s.radius2 <= s.roadWidth / 2 + 5) errs.push("Second curve radius must be more than half the road width plus 5 ft.");
            }
            const r = minInsideRadius(s);
            if (isFinite(r) && ok(s.maxLotDepth) && s.maxLotDepth > r) errs.push(`Maximum lot depth (${s.maxLotDepth} ft) can't exceed the inside radius of the curves (${Math.floor(r)} ft) — lots on the inside would overlap.`);
            if (s.roadEnd === "culdesac") {
                num("roadLength", "Road length (ft)", 1);
                num("culdesacRadius", "Cul-de-sac radius (ft)", 10, 500);
                if (ok(s.culdesacRadius) && ok(s.roadWidth) && s.culdesacRadius <= s.roadWidth / 2) errs.push("Cul-de-sac radius must be more than half the road width.");
                const need = alignmentLength(s) + 2 * s.culdesacRadius;
                if (ok(s.roadLength) && isFinite(need) && s.roadLength < need) errs.push(`Road length must be at least ${Math.ceil(need)} ft for this alignment and cul-de-sac (curves and tangents, then a straight run into the bulb).`);
            }
        }
        if (s.greenOn) num("greenPct", "Green space (%)", 0.1, 90);
        if (s.pondsOn) {
            num("pondCount", "Number of ponds", 1, 20, true);
            if (s.pondShape !== "fixed" && s.pondShape !== "fit") errs.push("Pond shape must be fixed width or fit to the road.");
            if (s.pondShape === "fixed") num("pondWidth", "Pond width (ft)", 5, 1000);
            if (s.pondShape === "fixed" && s.pondSizeAuto) {
                num("pondSideSlope", "Pond side slope (H:1V)", 1, 10);
                num("pondFreeboard", "Pond freeboard (ft)", 0, 5);
                const bottom = s.pondWidth - 2 * s.pondSideSlope * (s.pondFreeboard + s.pondDepthFt);
                if ([s.pondWidth, s.pondSideSlope, s.pondFreeboard, s.pondDepthFt].every(ok) && bottom <= 0) errs.push(`A ${s.pondWidth} ft wide pond is too narrow for ${s.pondSideSlope}:1 side slopes ${s.pondDepthFt + s.pondFreeboard} ft deep — it needs more than ${Math.ceil(2 * s.pondSideSlope * (s.pondFreeboard + s.pondDepthFt))} ft.`);
            }
            if (!["series", "road", "none"].includes(s.pondLink)) errs.push("Pond connectivity must be series, to the road, or none.");
            if (s.pondSizeAuto) {
                num("imperviousPct", "Impervious surface (%)", 0, 100);
                num("treatmentIn", "Treatment depth (in)", 0.1, 12);
                num("pondDepthFt", "Pond depth (ft)", 0.5, 20);
            } else {
                num("pondSF", "Required pond area (sq ft)", 1);
            }
        }
        if (verts && (!Number.isInteger(s.frontEdge) || s.frontEdge < 0 || s.frontEdge >= verts.length)) errs.push("Pick a frontage edge.");
        return errs;
    }

    // ── Road alignment ───────────────────────────────────────────────────────

    /**
     * Centreline from the entry point, heading +u: tangent / curve elements, then a final
     * straight (to the bulb centre for a cul-de-sac, or far past the boundary for a through road).
     * Points carry heading h (radians from +u toward +v) and station st (0 at the entry).
     */
    function centreline(s, start, leftSign, far) {
        const ext = s.roadWidth;                       // start a little outside so the edges meet a slanted frontage
        const pts = [{ u: start.u - ext, v: start.v, h: 0, st: -ext }];
        const curves = [];
        let c = { u: start.u, v: start.v, h: 0, st: 0 };
        pts.push(c);
        const tangent = L => {
            if (!(L > 1e-9)) return;
            c = { u: c.u + L * Math.cos(c.h), v: c.v + L * Math.sin(c.h), h: c.h, st: c.st + L };
            pts.push(c);
        };
        const curve = (R, deltaDeg, sign) => {
            const ctr = { u: c.u - sign * R * Math.sin(c.h), v: c.v + sign * R * Math.cos(c.h) };
            const n = Math.max(2, Math.ceil(deltaDeg / ARC_STEP_DEG)), h0 = c.h, st0 = c.st, d = deltaDeg * Math.PI / 180;
            curves.push({ R, delta: deltaDeg, turn: sign * leftSign > 0 ? "left" : "right", pc: st0, pt: st0 + R * d, length: R * d });
            for (let k = 1; k <= n; k++) {
                const h = h0 + sign * d * k / n;
                c = { u: ctr.u + sign * R * Math.sin(h), v: ctr.v - sign * R * Math.cos(h), h, st: st0 + R * d * k / n };
                pts.push(c);
            }
        };
        if (s.alignment !== "straight") {
            const sign = (s.turn === "left" ? 1 : -1) * leftSign;
            tangent(s.tangent1);
            curve(s.radius1, s.delta1, sign);
            if (s.alignment === "reverse") { tangent(s.tangent2); curve(s.radius2, s.delta2, -sign); }
        }
        if (s.roadEnd === "culdesac" && s.roadOn) {
            const Lc = s.roadLength - s.culdesacRadius, a = Math.sqrt(s.culdesacRadius ** 2 - (s.roadWidth / 2) ** 2);
            tangent(Lc - a - c.st);                       // to the bulb join
            const join = pts.length - 1;
            tangent(a);
            return { pts, curves, join, end: pts[pts.length - 1] };
        }
        tangent(far);
        return { pts, curves, join: null, end: pts[pts.length - 1] };
    }
    const leftN = h => ({ u: -Math.sin(h), v: Math.cos(h) });

    /** Convex quads covering the road strip, up to point index `upto` (the bulb join for a cul-de-sac). */
    function roadQuads(cl, half, upto) {
        const q = [];
        for (let k = 0; k + 1 <= upto; k++) {
            const a = cl.pts[k], b = cl.pts[k + 1], na = leftN(a.h), nb = leftN(b.h);
            q.push([add(a, na, -half), add(b, nb, -half), add(b, nb, half), add(a, na, half)]);
        }
        return q;
    }
    const circle = (c, R, n) => Array.from({ length: n }, (_, k) => ({ u: c.u + R * Math.cos(2 * Math.PI * k / n), v: c.v + R * Math.sin(2 * Math.PI * k / n) }));

    /** Longest run of a path inside polygon P (points keep their normals). */
    function trimPath(path, P) {
        const runs = [];
        let cur = null;
        const lerp = (a, b, t) => ({ u: a.u + t * (b.u - a.u), v: a.v + t * (b.v - a.v), n: unit({ u: a.n.u + t * (b.n.u - a.n.u), v: a.n.v + t * (b.n.v - a.n.v) }) });
        for (let k = 0; k + 1 < path.length; k++) {
            const a = path[k], b = path[k + 1], ts = [0, 1];
            for (let i = 0; i < P.length; i++) {
                const p = P[i], q = P[(i + 1) % P.length];
                const den = (b.u - a.u) * (q.v - p.v) - (b.v - a.v) * (q.u - p.u);
                if (Math.abs(den) < 1e-12) continue;
                const t = ((p.u - a.u) * (q.v - p.v) - (p.v - a.v) * (q.u - p.u)) / den;
                const w = ((p.u - a.u) * (b.v - a.v) - (p.v - a.v) * (b.u - a.u)) / den;
                if (t > 1e-9 && t < 1 - 1e-9 && w >= 0 && w <= 1) ts.push(t);
            }
            ts.sort((x, y) => x - y);
            for (let i = 0; i + 1 < ts.length; i++) {
                const t0 = ts[i], t1 = ts[i + 1];
                if (t1 - t0 < 1e-12) continue;
                const mid = lerp(a, b, (t0 + t1) / 2);
                if (pointInPoly(P, mid)) {
                    if (!cur) cur = [t0 === 0 ? a : lerp(a, b, t0)];
                    cur.push(t1 === 1 ? b : lerp(a, b, t1));
                } else if (cur) { runs.push(cur); cur = null; }
            }
        }
        if (cur) runs.push(cur);
        return runs.reduce((m, r) => (polyLen(r) > polyLen(m) ? r : m), []);
    }

    /** Do any edges of two polygons cross? */
    function edgesCross(A, B) {
        const x = (p, q, r) => (q.u - p.u) * (r.v - p.v) - (q.v - p.v) * (r.u - p.u);
        for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
            const a = A[i], b = A[(i + 1) % A.length], c = B[j], d = B[(j + 1) % B.length];
            if (x(a, b, c) * x(a, b, d) < 0 && x(c, d, a) * x(c, d, b) < 0) return true;
        }
        return false;
    }

    // ── Layout ───────────────────────────────────────────────────────────────

    /** Road centre (v) entering at roadPos % of the parcel area, measured along the frontage. */
    const roadCentre = (P, PB, pos) => solve(t => area(clipBox(P, null, null, null, t)), area(P) * pos / 100, PB.v0, PB.v1);

    /**
     * The parcel split into zones: green space at the back, the buildable area W, and the road
     * (unless roadFree, used to size the road itself).
     */
    function zones(verts, s, roadFree) {
        const F = frame(verts, s.frontEdge);
        const P = verts.map(F.toLocal), gross = area(P), PB = bounds(P), diag = Math.hypot(PB.u1 - PB.u0, PB.v1 - PB.v0);
        const half = s.roadOn ? s.roadWidth / 2 : 0;
        const vc = s.roadOn ? roadCentre(P, PB, s.roadPos) : null;
        const vcs = !s.roadOn ? [] : s.roadCount === 2 ? [vc, roadCentre(P, PB, s.roadPos2)] : [vc];
        const roads = [];
        const loop = s.roadOn && s.roadEnd === "loop" && vcs.length === 2;
        // A loop: both roads run straight in to a connector at the back (centre uC), which joins them.
        const starts = vcs.map(vcN => { const ivs = lineIntervals(P, vcN, "v"); return ivs.length ? ivs[0][0] : PB.u0; });
        const uC = loop ? Math.min(...starts) + s.roadLength - half : null;
        if (s.roadOn && !roadFree) vcs.forEach((vcN, ri) => {
            const start = { u: starts[ri], v: vcN };
            if (loop) {
                const ext = s.roadWidth, endU = uC - half;
                const pts = [{ u: start.u - ext, v: vcN, h: 0, st: -ext }, { u: start.u, v: vcN, h: 0, st: 0 }, { u: endU, v: vcN, h: 0, st: endU - start.u }];
                const cl = { pts, curves: [], join: pts.length - 1, end: pts[pts.length - 1] };
                const quads = roadQuads(cl, half, cl.join);
                roads.push({ cl, quads, bulb: null, convexes: quads, vc: vcN });
                return;
            }
            const cl = centreline(s, start, F.leftSign, 3 * diag);
            const upto = s.roadEnd === "culdesac" ? cl.join : cl.pts.length - 1;
            const quads = roadQuads(cl, half, upto);
            // The bulb, less the cap behind its join line (already covered by the strip), so the pieces tile.
            let bulb = null;
            if (s.roadEnd === "culdesac") {
                const j = cl.pts[cl.join], f = { u: Math.cos(cl.end.h), v: Math.sin(cl.end.h) };
                bulb = clipLine(circle(cl.end, s.culdesacRadius, BULB_SEGS), j, { u: f.v, v: -f.u });
            }
            roads.push({ cl, quads, bulb, convexes: bulb ? quads.concat([bulb]) : quads, vc: vcN });
        });
        let connector = null;
        if (loop && roads.length === 2 && !roadFree) {
            const v0 = Math.min(...vcs) - half, v1 = Math.max(...vcs) + half;
            connector = { uC, v0, v1, quad: [{ u: uC - half, v: v0 }, { u: uC + half, v: v0 }, { u: uC + half, v: v1 }, { u: uC - half, v: v1 }] };
        }
        const road = roads[0] || null;
        const allConvexes = [].concat(...roads.map(r => r.convexes), connector ? [connector.quad] : []);
        const roadArea = poly => (roads.length ? areaIn(poly, allConvexes) : 0);
        // Green space: the back of the parcel, net of any road crossing it.
        let ug = PB.u1;
        if (s.greenOn && s.greenPct > 0) {
            const target = gross * s.greenPct / 100;
            ug = solve(t => { const g = clipBox(P, t, null); return -(area(g) - roadArea(g)); }, -target, PB.u0, PB.u1);
        }
        const G = s.greenOn && ug < PB.u1 ? clipBox(P, ug, null) : [];
        const W = G.length ? clipBox(P, null, ug) : P;
        return { F, P, gross, PB, diag, half, vc, road, roads, connector, allConvexes, roadArea, G, ug, W };
    }

    /** Lot frontage paths: each road edge (and half the bulb), or the existing street with the road off. */
    function frontagePaths(z, s) {
        const { roads, half, W, P } = z;
        if (!roads.length) {
            const ivs = lineIntervals(W, 1e-6, "u");
            const iv = ivs.reduce((m, x) => (x[1] - x[0] > m[1] - m[0] ? x : m), [0, 0]);
            const n = { u: 1, v: 0 };
            return [[{ u: 0, v: iv[0], n }, { u: 0, v: iv[1], n }]];
        }
        const out = [];
        roads.forEach((road, ri) => {
        const cl = road.cl;
        // With two parallel roads, lots on the sides facing each other share the gap between them.
        const other = roads[1 - ri], gapDepth = other ? Math.abs(other.vc - road.vc) / 2 - half : null;
        const facing = other ? Math.sign(other.vc - road.vc) : 0;
        [1, -1].forEach(side => {
            const upto = s.roadEnd === "culdesac" ? cl.join : cl.pts.length - 1;
            const path = cl.pts.slice(0, upto + 1).map(p => { const n = leftN(p.h); return { u: p.u + side * n.u * half, v: p.v + side * n.v * half, n: { u: side * n.u, v: side * n.v } }; });
            if (road.bulb) {
                // Round the bulb from the join to its far end. Lot lines are radial where the radius
                // points forward, and perpendicular to the road where it would point back over the
                // lots beside the straight.
                const e = cl.end, R = s.culdesacRadius, a = Math.sqrt(R * R - half * half), f = { u: Math.cos(e.h), v: Math.sin(e.h) };
                const sideN = { u: side * leftN(e.h).u, v: side * leftN(e.h).v };
                const th0 = Math.atan2(sideN.v * half - f.v * a, sideN.u * half - f.u * a);   // angle of the join point
                let d = e.h - th0;
                while (d > Math.PI) d -= 2 * Math.PI;
                while (d < -Math.PI) d += 2 * Math.PI;
                const n = Math.max(8, Math.ceil(Math.abs(d) / (4 * Math.PI / 180)));
                for (let k = 1; k <= n; k++) {
                    const th = th0 + d * k / n, rad = { u: Math.cos(th), v: Math.sin(th) };
                    const fwd = rad.u * f.u + rad.v * f.v;
                    path.push({ u: e.u + R * rad.u, v: e.v + R * rad.v, n: fwd >= 0 ? rad : sideN });
                }
            }
            const t = trimPath(path, W.length ? W : P);
            if (t.length >= 2) {
                if (other && side === facing) { t.depth = Math.max(0, gapDepth); t.inner = true; }
                // Corner lots: where the road meets the frontage street, and where a through road
                // or a loop's connector meets another street.
                t.cornerStart = true;
                t.cornerEnd = s.roadEnd === "through" || s.roadEnd === "loop";
                out.push(t);
            }
        });
        });
        if (z.connector) {
            // Lots behind the loop's connector, fronting it (the block between the roads is served by them).
            const c = z.connector, n = { u: 1, v: 0 };
            const t = trimPath([{ u: c.uC + half, v: c.v0, n }, { u: c.uC + half, v: c.v1, n }], W.length ? W : P);
            if (t.length >= 2) { t.cornerStart = true; t.cornerEnd = true; t.connector = true; out.push(t); }
        }
        return out;
    }
    const depthOf = (path, s) => (path.depth != null ? Math.min(path.depth, s.maxLotDepth) : s.maxLotDepth);

    /** The sub-path between two stations (endpoints interpolated). */
    function subPath(path, s0, s1) {
        const out = [];
        let acc = 0;
        const at = (a, b, t) => ({ u: a.u + t * (b.u - a.u), v: a.v + t * (b.v - a.v), n: unit({ u: a.n.u + t * (b.n.u - a.n.u), v: a.n.v + t * (b.n.v - a.n.v) }) });
        for (let k = 0; k + 1 < path.length; k++) {
            const a = path[k], b = path[k + 1], L = dist(a, b);
            const x0 = acc, x1 = acc + L;
            if (x1 >= s0 - 1e-9 && x0 <= s1 + 1e-9 && L > 0) {
                if (!out.length) out.push(at(a, b, Math.max(0, (s0 - x0) / L)));
                const tEnd = Math.min(1, (s1 - x0) / L);
                if (tEnd >= 1) out.push(b); else { out.push(at(a, b, tEnd)); break; }
            }
            acc = x1;
        }
        return out.filter((p, i) => !i || dist(p, out[i - 1]) > 1e-9);
    }

    /** Convex pieces of the band from a sub-path out to depth D (triangles where lot lines converge). */
    function bandPieces(sp, D) {
        const pieces = [];
        for (let k = 0; k + 1 < sp.length; k++) {
            const p0 = sp[k], p1 = sp[k + 1], n0 = p0.n, n1 = p1.n;
            const den = n0.u * n1.v - n0.v * n1.u;
            if (Math.abs(den) > 1e-12) {
                const du = p1.u - p0.u, dv = p1.v - p0.v;
                const t = (du * n1.v - dv * n1.u) / den, w = (du * n0.v - dv * n0.u) / den;
                if (t > 0 && t < D && w > 0 && w < D) { pieces.push([p0, p1, add(p0, n0, t)]); continue; }
            }
            pieces.push([p0, p1, add(p1, n1, D), add(p0, n0, D)]);
        }
        return pieces;
    }

    /**
     * Convex pieces of the band between depths d0 and d1 behind a path (the pond strip behind the
     * lots). Where lot lines converge (inside of a curve) the strip stops at the convergence point.
     */
    function bandBetween(sp, d0, d1) {
        const pieces = [];
        for (let k = 0; k + 1 < sp.length; k++) {
            const p0 = sp[k], p1 = sp[k + 1], n0 = p0.n, n1 = p1.n;
            const den = n0.u * n1.v - n0.v * n1.u;
            let t = Infinity, w = Infinity;
            if (Math.abs(den) > 1e-12) {
                const du = p1.u - p0.u, dv = p1.v - p0.v;
                t = (du * n1.v - dv * n1.u) / den; w = (du * n0.v - dv * n0.u) / den;
                if (!(t > 0 && w > 0)) { t = Infinity; w = Infinity; }
            }
            if (Math.min(t, w) <= d0 + 1e-9) continue;
            const a0 = add(p0, n0, d0), a1 = add(p1, n1, d0);
            if (t < d1 && w < d1) pieces.push([a0, a1, add(p0, n0, t)]);
            else pieces.push([a0, a1, add(p1, n1, d1), add(p0, n0, d1)]);
        }
        return pieces;
    }

    /** Area of the strip [d0, d1] behind a path inside W, per segment (for splitting by area). */
    const stripArea = (sp, d0, d1, W) => bandBetween(sp, d0, d1).reduce((t, q) => t + area(clipConvex(W, q)), 0);

    /** Station on the path where the strip area from the start reaches `target`. */
    function stationAtArea(path, d0, d1, W, target) {
        let acc = 0, st = 0;
        for (let k = 0; k + 1 < path.length; k++) {
            const L = dist(path[k], path[k + 1]), a = stripArea([path[k], path[k + 1]], d0, d1, W);
            if (acc + a >= target) {
                const x = solve(m => acc + stripArea(subPath(path, st, st + m), d0, d1, W), target, 0, L);
                return st + x;
            }
            acc += a; st += L;
        }
        return st;
    }

    /** Split n across paths in proportion to length (largest remainder). */
    function apportion(n, sizes) {
        const tot = sizes.reduce((a, b) => a + b, 0);
        if (!tot) return sizes.map(() => 0);
        const raw = sizes.map(a => n * a / tot), out = raw.map(Math.floor);
        let left = n - out.reduce((a, b) => a + b, 0);
        raw.map((r, i) => [r - out[i], i]).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
        return out;
    }

    /** Most lots the frontage and buildable area can hold at the minimums — an upper bound. */
    function maxLots(verts, s) {
        const z = zones(verts, s), paths = frontagePaths(z, s);
        const need = Math.max(s.minLotSF || 0, (s.minLotAcres || 0) * SQFT_PER_ACRE, 1);
        const byPath = paths.reduce((t, p) => {
            const L = polyLen(p);
            const byFront = s.minFrontage > 0 ? Math.floor(L / s.minFrontage) : Infinity;
            return t + Math.min(byFront, Math.floor(L * depthOf(p, s) / need));
        }, 0);
        return Math.max(0, Math.min(byPath, Math.floor((area(z.W) - z.roadArea(z.W)) / need)));
    }

    /** Nearest point on a polyline. */
    function nearestOn(pts, p) {
        let best = null, bd = Infinity;
        for (let k = 0; k + 1 < pts.length; k++) {
            const a = pts[k], b = pts[k + 1], L2 = (b.u - a.u) ** 2 + (b.v - a.v) ** 2;
            const t = L2 ? Math.max(0, Math.min(1, ((p.u - a.u) * (b.u - a.u) + (p.v - a.v) * (b.v - a.v)) / L2)) : 0;
            const q = { u: a.u + t * (b.u - a.u), v: a.v + t * (b.v - a.v) }, d = dist(p, q);
            if (d < bd) { bd = d; best = q; }
        }
        return best;
    }

    /**
     * Full layout for the settings. Returns world-coordinate geometry ({n,e}) for the boundary,
     * green space, ponds and pipes, road (edges, centreline, bulb), and every lot, with each lot's
     * area / frontage / checks and the overall checks. Throws if the settings don't validate.
     */
    function layout(verts, s, opts) {
        const lotsOnly = !!(opts && opts.lotsOnly);       // bestLots only needs the lots
        const errs = validate(s, verts);
        if (errs.length) { const e = new Error(errs.join(" ")); e.errors = errs; throw e; }
        const z = zones(verts, s), W2 = z.F.toWorld, toW = poly => poly.map(W2);
        const need = Math.max(s.minLotSF, s.minLotAcres * SQFT_PER_ACRE);
        const paths = frontagePaths(z, s);
        const counts = apportion(s.nLots, paths.map(polyLen));
        // Sight triangles at corners: legs along the road edge and along the cross street.
        const sight = [];
        if (s.sightLeg > 0) paths.forEach(path => {
            const tri = (c, along, out) => [c, add(c, along, s.sightLeg), add(c, out, s.sightLeg)];
            if (path.cornerStart && path.length >= 2) { const a = path[0], b = path[1], d = unit({ u: b.u - a.u, v: b.v - a.v }); sight.push(tri(a, d, a.n)); }
            if (path.cornerEnd && path.length >= 2) { const a = path[path.length - 1], b = path[path.length - 2], d = unit({ u: b.u - a.u, v: b.v - a.v }); sight.push(tri(a, d, a.n)); }
        });
        /** Keep the part of each piece outside every sight triangle (beyond its hypotenuse). */
        const outsideSight = pieces => sight.reduce((ps, tr) => ps.map(pc => {
            const [c, p1, p2] = tr, d = { u: p2.u - p1.u, v: p2.v - p1.v };
            const sideC = d.u * (c.v - p1.v) - d.v * (c.u - p1.u);
            const pcIn = pc.some(q => pointInPoly(tr, q)) || tr.some(q => pointInPoly(pc, q)) || edgesCross(pc, tr);
            if (!pcIn) return pc;
            return sideC > 0 ? clipLine(pc, p2, { u: -d.u, v: -d.v }) : clipLine(pc, p1, d);
        }).filter(pc => pc.length), pieces);

        /** One lot between two stations on a path, with its checks, building envelope and easements. */
        const makeLot = (path, pi, s0, s1, corner) => {
            const sp = subPath(path, s0, s1);
            if (sp.length < 2) return null;
            const Dp = depthOf(path, s);
            if (Dp <= 0) return null;
            const pieces = bandPieces(sp, Dp).map(q => clipConvex(z.W, q)).filter(p => p.length);
            const a = pieces.reduce((t, p) => t + area(p), 0);
            if (a < 1e-6) return null;
            const front = polyLen(sp), depth = front > 0 ? a / front : null;
            const deep = Math.min(Dp, depth || Dp);
            const mid = subPath(sp, front / 2, front / 2 + 1e-6)[0] || sp[0];
            // Building envelope: inside the setbacks (and easements), clear of sight triangles.
            const fs = Math.max(s.setbacksOn ? s.frontSetback : 0, s.easementFront), rs = Math.max(s.setbacksOn ? s.rearSetback : 0, s.easementRear);
            const side = s.setbacksOn ? s.sideSetback : 0;
            let env = [];
            if (s.setbacksOn && s1 - s0 > 2 * side && deep - rs > fs) {
                const esp = subPath(path, s0 + side, s1 - side);
                if (esp.length >= 2) env = outsideSight(bandBetween(esp, fs, deep - rs).map(q => clipConvex(z.W, q)).filter(p => p.length));
            }
            const envArea = env.reduce((t, p) => t + area(p), 0);
            const ease = [];
            if (s.easementFront > 0) ease.push(...bandBetween(sp, 0, Math.min(s.easementFront, deep)).map(q => clipConvex(z.W, q)).filter(p => p.length));
            if (s.easementRear > 0 && deep > s.easementRear) ease.push(...bandBetween(sp, deep - s.easementRear, deep).map(q => clipConvex(z.W, q)).filter(p => p.length));
            const needFront = s.minFrontage + (corner ? s.cornerExtra : 0);
            const checks = {
                size: a >= s.minLotSF - 0.5,
                acres: a >= s.minLotAcres * SQFT_PER_ACRE - 0.5,
                frontage: front >= needFront - 0.005,
                depth: depth != null && depth >= s.minLotDepth - 0.005,
                buildable: !s.setbacksOn || (envArea > 1e-6 && envArea >= s.minBuildableSF - 0.5)
            };
            return {
                side: pi + 1, s0, s1, key: (s0 + s1) / 2 + (path.connector ? 1e7 : 0), corner: !!corner,
                area: a, acres: a / SQFT_PER_ACRE, frontage: front, depth, buildableArea: s.setbacksOn ? envArea : null,
                checks, ok: checks.size && checks.acres && checks.frontage && checks.depth && checks.buildable,
                rings: mergePieces(pieces).map(toW), envelope: mergePieces(env).map(toW), easements: mergePieces(ease).map(toW),
                label: W2(add(mid, mid.n, deep / 2))
            };
        };

        let lots = [], merged = 0;
        paths.forEach((path, pi) => {
            const n = counts[pi], L = polyLen(path);
            if (!n) return;
            // Corner lots get the extra width; the rest share what's left equally.
            const cs = !!path.cornerStart, ce = !!path.cornerEnd && n > 1;
            const extra = s.cornerExtra || 0, base = (L - extra * ((cs ? 1 : 0) + (ce ? 1 : 0))) / n;
            const widths = Array.from({ length: n }, (_, i) => (base > 0 ? base + ((i === 0 && cs) || (i === n - 1 && ce) ? extra : 0) : L / n));
            const st = [0];
            widths.forEach(w => st.push(st[st.length - 1] + w));
            st[n] = L;
            let row = [];
            for (let i = 0; i < n; i++) {
                const lot = makeLot(path, pi, st[i], st[i + 1], (i === 0 && cs) || (i === n - 1 && ce));
                if (lot) row.push(lot);
            }
            // Fold a failing first / last lot into its neighbour.
            if (s.mergeEndLots) {
                if (row.length > 1 && !row[0].ok) { const m = makeLot(path, pi, row[0].s0, row[1].s1, row[0].corner); if (m) { row.splice(0, 2, m); merged++; } }
                if (row.length > 1 && !row[row.length - 1].ok) { const k = row.length - 1, m = makeLot(path, pi, row[k - 1].s0, row[k].s1, row[k].corner); if (m) { row.splice(k - 1, 2, m); merged++; } }
            }
            lots.push(...row);
        });
        // Number lots from the entrance back, and split them into phases in that order.
        lots.sort((a, b) => a.key - b.key || a.side - b.side);
        lots.forEach((l, i) => { l.id = i + 1; l.phase = Math.min(s.phases, Math.floor(i * s.phases / Math.max(1, lots.length)) + 1); });
        const lotArea = lots.reduce((t, l) => t + l.area, 0);
        if (lotsOnly) return { lots, lotArea, merged };
        const roadArea = z.roads.length ? areaIn(z.P, z.allConvexes) : 0;
        // Road beyond its first road-width (the entry, which meets the frontage) must lie inside the parcel.
        const inner = [].concat(...z.roads.map(r => r.quads.filter((q, k) => r.cl.pts[k].st >= s.roadWidth - 1e-9).concat(r.bulb ? [r.bulb] : [])), z.connector ? [z.connector.quad] : []);
        const roadOut = inner.reduce((t, q) => t + area(q) - area(clipConvex(z.P, q)), 0);
        const roadInW = z.roadArea(z.W);
        const greenArea = z.G.length ? area(z.G) - z.roadArea(z.G) : 0;
        // Retention ponds: a strip behind the lots, parallel to the road, wide enough to hold the
        // required area, split into equal ponds along the road.
        // Fixed-width ponds sized from a volume take their side slopes and freeboard into account:
        // the footprint (top of bank) is what has to fit behind the lots.
        let pondSF = s.pondsOn ? (s.pondSizeAuto ? pondAreaRequired(z.gross, s) : s.pondSF) : 0, pondVolume = null, pondLength = null;
        if (s.pondsOn && s.pondSizeAuto && s.pondShape === "fixed") {
            pondVolume = z.gross * (s.imperviousPct / 100) * (s.treatmentIn / 12);
            const ww = s.pondWidth - 2 * s.pondSideSlope * s.pondFreeboard, wb = ww - 2 * s.pondSideSlope * s.pondDepthFt;
            pondLength = pondVolume / ((ww + wb) / 2 * s.pondDepthFt);
            pondSF = pondLength * s.pondWidth;
        }
        const D = s.maxLotDepth, pondList = [];
        let pondWidth = 0, pondFits = true;
        // Ponds sit behind the outer lots only (with two roads, not in the gap between them).
        const pondPaths = paths.filter(p => !p.inner);
        if (pondSF > 0 && pondPaths.length) {
            // Ponds go to each side of the road in proportion to its length; a pond never straddles a road.
            const cnt = apportion(s.pondCount, pondPaths.map(polyLen));
            const used = pondPaths.map((p, i) => cnt[i] > 0);
            const pushPond = (sp, d1, mid) => {
                const pieces = sp.length >= 2 ? bandBetween(sp, D, d1).map(q => clipConvex(z.W, q)).filter(p => p.length) : [];
                const a = pieces.reduce((t, p) => t + area(p), 0);
                if (a > 1e-6) pondList.push({ id: pondList.length + 1, area: a, rings: mergePieces(pieces), c: add(mid, mid.n, (D + d1) / 2) });
            };
            if (s.pondShape === "fixed") {
                // Fixed width: as long as needed, from the back end of each side toward the front.
                pondWidth = s.pondWidth;
                const d1 = D + pondWidth;
                const avail = pondPaths.map((p, i) => used[i] ? stripArea(p, D, d1, z.W) : 0), tot = avail.reduce((a, b) => a + b, 0);
                if (tot < pondSF - 0.5) pondFits = false;
                pondPaths.forEach((path, pi) => {
                    if (!used[pi]) return;
                    const want = Math.min(avail[pi], pondSF * avail[pi] / (tot || 1)), n = cnt[pi];
                    const rev = path.slice().reverse();
                    let st0 = 0;
                    for (let i = 1; i <= n; i++) {
                        const st1 = stationAtArea(rev, D, d1, z.W, want * i / n);
                        const sp = subPath(rev, st0, st1), L2 = polyLen(sp);
                        pushPond(sp, d1, subPath(sp, L2 / 2, L2 / 2 + 1e-6)[0] || sp[0] || rev[0]);
                        st0 = st1;
                    }
                });
            } else {
                // Fit: a strip along the whole side, its width solved to hold the required area.
                const total = w => pondPaths.reduce((t, p, i) => t + (used[i] ? stripArea(p, D, D + w, z.W) : 0), 0);
                const most = total(z.diag);
                if (most < pondSF) { pondFits = false; pondWidth = z.diag; } else pondWidth = solve(total, pondSF, 0, z.diag);
                const d1 = D + pondWidth, per = pondPaths.map((p, i) => used[i] ? stripArea(p, D, d1, z.W) : 0);
                pondPaths.forEach((path, pi) => {
                    const n = cnt[pi];
                    let st0 = 0;
                    for (let i = 1; i <= n; i++) {
                        const st1 = i === n ? polyLen(path) : stationAtArea(path, D, d1, z.W, per[pi] * i / n);
                        const sp = subPath(path, st0, st1), L2 = polyLen(sp);
                        pushPond(sp, d1, subPath(sp, L2 / 2, L2 / 2 + 1e-6)[0] || sp[0] || path[0]);
                        st0 = st1;
                    }
                });
            }
        } else if (pondSF > 0) pondFits = false;
        const pondArea = pondList.reduce((t, p) => t + p.area, 0);
        const remainderArea = Math.max(0, area(z.W) - roadInW - lotArea - pondArea);

        // Road geometry: right-of-way lines and centreline inside the boundary
        const roadEdges = [], access = [], centres = [], bulbs = [];
        let roadLength = 0;
        z.roads.forEach(road => {
            const cl = road.cl, upto = s.roadEnd === "culdesac" ? cl.join : cl.pts.length - 1;
            [1, -1].forEach(side => {
                const e = cl.pts.slice(0, upto + 1).map(p => { const n = leftN(p.h); return { u: p.u + side * n.u * z.half, v: p.v + side * n.v * z.half, n }; });
                const t = trimPath(e, z.P);
                if (t.length >= 2) roadEdges.push(t);
            });
            const centre = trimPath(cl.pts.map(p => ({ u: p.u, v: p.v, n: leftN(p.h) })), z.P);
            if (centre.length >= 2) centres.push(centre);
            roadLength += polyLen(centre);
            if (centre.length) access.push({ kind: "ingress", u: centre[0].u, v: centre[0].v });
            if (s.roadEnd === "through" && centre.length) access.push({ kind: "egress", u: centre[centre.length - 1].u, v: centre[centre.length - 1].v });
            if (road.bulb) {
                // bulb arc between the two joins, round the far end
                const e = cl.end, R = s.culdesacRadius, a = Math.sqrt(R * R - z.half * z.half), f = { u: Math.cos(e.h), v: Math.sin(e.h) }, ln = leftN(e.h);
                const thL = Math.atan2(ln.v * z.half - f.v * a, ln.u * z.half - f.u * a);
                const thR = Math.atan2(-ln.v * z.half - f.v * a, -ln.u * z.half - f.u * a);
                let d = thR - thL;
                if (Math.cos(thL + d / 2 - e.h) < 0) d = d > 0 ? d - 2 * Math.PI : d + 2 * Math.PI;
                const ring = [];
                for (let k = 0; k <= 64; k++) { const th = thL + d * k / 64; ring.push({ u: e.u + R * Math.cos(th), v: e.v + R * Math.sin(th) }); }
                bulbs.push(ring);
            }
        });
        if (z.connector) {
            const c = z.connector, n = { u: 1, v: 0 }, h = z.half;
            const front = trimPath([{ u: c.uC - h, v: c.v0 + 2 * h, n }, { u: c.uC - h, v: c.v1 - 2 * h, n }], z.P), back = trimPath([{ u: c.uC + h, v: c.v0, n }, { u: c.uC + h, v: c.v1, n }], z.P);
            [front, back].forEach(e => { if (e.length >= 2) roadEdges.push(e); });
            const cc = trimPath([{ u: c.uC, v: c.v0 + h, n }, { u: c.uC, v: c.v1 - h, n }], z.P);
            if (cc.length >= 2) { centres.push(cc); roadLength += polyLen(cc); }
        }
        const nearestRoad = p => centres.reduce((best, c) => { const q = nearestOn(c, p); return !best || dist(p, q) < dist(p, best) ? q : best; }, null);

        // Pond connectivity
        const pipes = [];
        if (pondList.length && s.pondLink !== "none" && centres.length) {
            if (s.pondLink === "series") {
                for (let i = 0; i + 1 < pondList.length; i++) pipes.push({ kind: "pond-pond", a: pondList[i].c, b: pondList[i + 1].c });
                const first = pondList.reduce((m, p) => (dist(p.c, nearestRoad(p.c)) < dist(m.c, nearestRoad(m.c)) ? p : m), pondList[0]);
                pipes.push({ kind: "pond-road", a: first.c, b: nearestRoad(first.c) });
            } else {
                pondList.forEach(p => pipes.push({ kind: "pond-road", a: p.c, b: nearestRoad(p.c) }));
            }
        } else if (pondList.length > 1 && s.pondLink === "series") {
            for (let i = 0; i + 1 < pondList.length; i++) pipes.push({ kind: "pond-pond", a: pondList[i].c, b: pondList[i + 1].c });
        }
        const pipeLength = pipes.reduce((t, p) => t + dist(p.a, p.b), 0);

        const checks = [
            { key: "lots", label: `${lots.length} of ${s.nLots} lots laid out${merged ? ` (${merged} merged)` : ""}`, ok: lots.length + merged === s.nLots },
            { key: "lotsOk", label: `${lots.filter(l => l.ok).length} of ${lots.length} lots meet every minimum`, ok: lots.length > 0 && lots.every(l => l.ok) }
        ];
        if (s.roadOn) {
            checks.push({ key: "roadArea", label: `Road area ${fmt(roadArea)} sq ft ≤ allowable ${fmt(s.roadMaxSF)} sq ft`, ok: roadArea <= s.roadMaxSF + 0.5 });
            if (s.roadEnd === "loop") {
                checks.push({ key: "inside", label: "Loop road stays inside the boundary", ok: roadOut < 1 });
                checks.push({ key: "clear", label: "Loop stops short of the green space", ok: (z.roads.length ? areaIn(z.G, z.allConvexes) : 0) < 1 });
                checks.push({ key: "roadLen", label: `Loop: two roads joined at the back — ${fmt(roadLength)} ft of road, two entrances`, ok: true, info: true });
            } else if (s.roadEnd === "culdesac") {
                checks.push({ key: "inside", label: `Road and cul-de-sac (${fmt(s.culdesacRadius)} ft radius) stay inside the boundary`, ok: roadOut < 1 });
                const into = z.roads.length ? areaIn(z.G, z.allConvexes) : 0;
                checks.push({ key: "clear", label: "Cul-de-sac stops short of the green space", ok: into < 1 });
            } else {
                checks.push({ key: "roadLen", label: `Through road ${fmt(roadLength)} ft, frontage to back boundary (ingress + egress)`, ok: true, info: true });
            }
            if (z.roads.length === 2) {
                const gap = Math.abs(z.roads[1].vc - z.roads[0].vc) - 2 * z.half;
                const shared = Math.min(s.maxLotDepth, gap / 2);
                checks.push({ key: "roadsGap", label: gap > 0 ? `Two roads ${fmt(gap)} ft apart (edge to edge) — lots between them ${fmt(shared)} ft deep` : "The two roads overlap — move them apart", ok: gap > 0, info: gap > 0 && shared >= s.maxLotDepth });
            }
            (z.road ? z.road.cl.curves : []).forEach((c, i) => checks.push({ key: "curve" + (i + 1), label: `Curve ${i + 1}: radius ${fmt(c.R)} ft, ${fmt(c.delta, 1)}° ${c.turn}, arc ${fmt(c.length, 1)} ft`, ok: true, info: true }));
        }
        const corners = lots.filter(l => l.corner);
        if (corners.length && s.cornerExtra > 0) checks.push({ key: "corners", label: `${corners.length} corner lot(s), each needing ${fmt(s.minFrontage + s.cornerExtra)} ft frontage (${fmt(s.cornerExtra)} ft extra)`, ok: corners.every(l => l.checks.frontage), info: corners.every(l => l.checks.frontage) });
        if (s.setbacksOn) {
            const nb = lots.filter(l => !l.checks.buildable).length;
            checks.push({ key: "buildable", label: `Building envelope (setbacks ${fmt(s.frontSetback, 1)} / ${fmt(s.sideSetback, 1)} / ${fmt(s.rearSetback, 1)} ft${s.minBuildableSF ? `, at least ${fmt(s.minBuildableSF)} sq ft` : ""}): ${lots.length - nb} of ${lots.length} lots`, ok: nb === 0 });
        }
        if (merged) checks.push({ key: "merged", label: `${merged} undersized end lot(s) merged into their neighbours — ${lots.length} lots`, ok: true, info: true });
        if (s.phases > 1) {
            for (let ph = 1; ph <= s.phases; ph++) {
                const pl = lots.filter(l => l.phase === ph);
                if (pl.length) checks.push({ key: "phase" + ph, label: `Phase ${ph}: lots ${pl[0].id}–${pl[pl.length - 1].id} (${pl.length})`, ok: true, info: true });
            }
        }
        if (s.greenOn) checks.push({ key: "green", label: `Green space ${(greenArea / z.gross * 100).toFixed(1)}% of gross (required ${s.greenPct}%)`, ok: greenArea >= z.gross * s.greenPct / 100 - 0.5 });
        if (s.pondsOn) {
            checks.push({ key: "ponds", label: `${pondList.length} pond(s), ${fmt(pondArea)} sq ft behind the lots, ${fmt(pondWidth, s.pondShape === "fixed" ? 0 : 1)} ft wide ${s.pondShape === "fixed" ? "(fixed)" : "strip"} (required ${fmt(pondSF)} sq ft${s.pondSizeAuto ? `: ${s.imperviousPct}% impervious, ${s.treatmentIn} in retained, ${s.pondDepthFt} ft deep` : ""})`, ok: pondFits && pondList.length === s.pondCount && pondArea >= pondSF - 0.5 });
            if (pondVolume != null) checks.push({ key: "pondVolume", label: `Pond volume ${fmt(pondVolume)} cu ft at ${s.pondDepthFt} ft deep with ${s.pondSideSlope}:1 side slopes and ${s.pondFreeboard} ft freeboard → ${fmt(pondLength)} ft of ${s.pondWidth} ft wide pond (${fmt(pondSF)} sq ft footprint)`, ok: true, info: true });
            if (!pondFits) checks.push({ key: "pondRoom", label: "Not enough land behind the lots for the required pond area — reduce the lot depth or the lot count", ok: false });
            if (s.pondLink === "series") checks.push({ key: "pipes", label: `Ponds connected in series${centres.length ? ", then to the road" : ""} — ${fmt(pipeLength)} ft of pipe`, ok: true, info: true });
            if (s.pondLink === "road") checks.push({ key: "pipes", label: centres.length ? `Each pond piped to the road — ${fmt(pipeLength)} ft of pipe` : "Ponds can't be piped to the road with the road off", ok: !!centres.length, info: !!centres.length });
        }
        return {
            settings: Object.assign({}, s),
            gross: z.gross, lotArea, roadArea, greenArea, pondArea, pondRequired: pondSF, pondWidth, pondVolume, pondLength, merged,
            sightTriangles: sight.map(toW), remainderArea, roadLength, pipeLength,
            minLotArea: need, maxLots: maxLots(verts, s),
            boundary: verts.map(p => ({ n: p.n, e: p.e })),
            green: z.G.length ? [toW(z.G)] : [],
            ponds: pondList.map(p => { const rings = p.rings.map(toW); return { id: p.id, area: p.area, rings, label: W2(p.c), hatch: [].concat(...rings.map(r => hatch(r, hatchSpacing(z.gross)))) }; }),
            pipes: pipes.map(p => ({ kind: p.kind, a: W2(p.a), b: W2(p.b) })),
            roadOutline: z.roads.length ? mergePieces(z.allConvexes.map(c => clipConvex(z.P, c)).filter(p => p.length)).map(toW) : [],
            roadOutlines: z.roads.map(r => mergePieces(r.convexes.map(c => clipConvex(z.P, c)).filter(p => p.length)).map(toW)),
            roadEdges: roadEdges.map(toW), bulbs: bulbs.map(toW), bulb: bulbs.length ? toW(bulbs[0]) : [],
            roadCentre: centres.map(toW),
            access: access.map(a => Object.assign({ kind: a.kind }, W2(a))),
            lots, checks, ok: checks.every(c => c.ok || c.info)
        };
    }

    /** Road position (%) whose centreline passes through a world point — for dragging the road. */
    function roadPosAt(verts, s, pt) {
        const F = frame(verts, s.frontEdge), P = verts.map(F.toLocal), PB = bounds(P), q = F.toLocal(pt);
        const v = Math.max(PB.v0, Math.min(PB.v1, q.v));
        return Math.max(5, Math.min(95, area(clipBox(P, null, null, null, v)) / area(P) * 100));
    }

    /** Hatch spacing (ft) that reads well at plan scale: about 1/150 of the parcel's size. */
    const hatchSpacing = gross => Math.max(1, Math.round(Math.sqrt(gross) / 150));

    const fmt = (x, d = 0) => Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

    /**
     * Hatch lines filling a ring (world {e, n}): parallel lines at `angleDeg`, `spacing` apart,
     * clipped to the ring (even–odd, so concave rings hatch correctly). Returns [[a, b], …].
     */
    function hatch(ring, spacing, angleDeg) {
        const a = (angleDeg == null ? 45 : angleDeg) * Math.PI / 180, d = { e: Math.cos(a), n: Math.sin(a) }, m = { e: -d.n, n: d.e };
        const off = p => p.e * m.e + p.n * m.n, along = p => p.e * d.e + p.n * d.n;
        const offs = ring.map(off), lo = Math.min(...offs), hi = Math.max(...offs), out = [];
        for (let c = Math.ceil(lo / spacing) * spacing; c <= hi; c += spacing) {
            const xs = [];
            for (let i = 0; i < ring.length; i++) {
                const p = ring[i], q = ring[(i + 1) % ring.length], op = off(p) - c, oq = off(q) - c;
                if ((op <= 0) !== (oq <= 0)) { const t = op / (op - oq); xs.push(along(p) + t * (along(q) - along(p))); }
            }
            xs.sort((x, y) => x - y);
            for (let i = 0; i + 1 < xs.length; i += 2) {
                if (xs[i + 1] - xs[i] < 1e-9) continue;
                const P = t => ({ e: c * m.e + t * d.e, n: c * m.n + t * d.n });
                out.push([P(xs[i]), P(xs[i + 1])]);
            }
        }
        return out;
    }

    // ── Exports ──────────────────────────────────────────────────────────────

    const LAYERS = [
        { name: "SUBD-BOUNDARY", color: 7 }, { name: "SUBD-LOT", color: 4 }, { name: "SUBD-ROAD-ROW", color: 8 },
        { name: "SUBD-ROAD-CL", color: 1 }, { name: "SUBD-GREEN", color: 3 }, { name: "SUBD-POND", color: 5 },
        { name: "SUBD-POND-HATCH", color: 5 }, { name: "SUBD-POND-PIPE", color: 6 }, { name: "SUBD-TEXT", color: 2 },
        { name: "SUBD-BUILDABLE", color: 30 }, { name: "SUBD-EASEMENT", color: 9 }, { name: "SUBD-SIGHT", color: 1 }
    ];

    function toDxf(L) {
        const pl = (layer, poly, closed) => ({ layer, closed: closed !== false, points: poly.map(p => ({ e: p.e, n: p.n })) });
        const h = Math.max(2, Math.sqrt(L.gross) / 120);
        const polylines = [pl("SUBD-BOUNDARY", L.boundary)];
        L.green.forEach(g => polylines.push(pl("SUBD-GREEN", g)));
        L.ponds.forEach(p => {
            p.rings.forEach(r => polylines.push(pl("SUBD-POND", r)));
            p.hatch.forEach(h => polylines.push(pl("SUBD-POND-HATCH", h, false)));
        });
        L.pipes.forEach(p => polylines.push(pl("SUBD-POND-PIPE", [p.a, p.b], false)));
        L.roadEdges.forEach(e => polylines.push(pl("SUBD-ROAD-ROW", e, false)));
        (L.bulbs || []).forEach(b => polylines.push(pl("SUBD-ROAD-ROW", b, false)));
        L.roadCentre.forEach(c => polylines.push(pl("SUBD-ROAD-CL", c, false)));
        L.lots.forEach(l => l.rings.forEach(r => polylines.push(pl("SUBD-LOT", r))));
        L.lots.forEach(l => (l.envelope || []).forEach(r => polylines.push(pl("SUBD-BUILDABLE", r))));
        L.lots.forEach(l => (l.easements || []).forEach(r => polylines.push(pl("SUBD-EASEMENT", r))));
        (L.sightTriangles || []).forEach(t => polylines.push(pl("SUBD-SIGHT", t)));
        const texts = L.lots.map(l => ({ layer: "SUBD-TEXT", e: l.label.e, n: l.label.n, height: h, value: `LOT ${l.id}  ${fmt(l.area)} SF${L.settings.phases > 1 ? `  PH ${l.phase}` : ""}` }));
        const cen = poly => poly.reduce((s, p) => ({ e: s.e + p.e / poly.length, n: s.n + p.n / poly.length }), { e: 0, n: 0 });
        L.green.forEach(g => texts.push(Object.assign({ layer: "SUBD-TEXT", height: h, value: "GREEN SPACE" }, cen(g))));
        L.ponds.forEach(p => texts.push(Object.assign({ layer: "SUBD-TEXT", height: h, value: `POND ${p.id}  ${fmt(p.area)} SF` }, p.label)));
        L.access.forEach(a => texts.push({ layer: "SUBD-TEXT", e: a.e, n: a.n, height: h, value: a.kind.toUpperCase() }));
        return window.COGO.buildDxf({ layers: LAYERS, polylines, texts });
    }

    /** Single-page PDF (US Letter landscape): the plan plus a summary and lot table. ASCII only. */
    function toPdf(L, meta) {
        const W = 792, H = 612, M = 36, plan = { x: M, y: M + 20, w: 470, h: H - 2 * M - 40 };
        const all = L.boundary;
        const e0 = Math.min(...all.map(p => p.e)), e1 = Math.max(...all.map(p => p.e));
        const n0 = Math.min(...all.map(p => p.n)), n1 = Math.max(...all.map(p => p.n));
        const k = Math.min(plan.w / (e1 - e0 || 1), plan.h / (n1 - n0 || 1)) * 0.95;
        const ox = plan.x + (plan.w - (e1 - e0) * k) / 2, oy = plan.y + (plan.h - (n1 - n0) * k) / 2;
        const X = p => (ox + (p.e - e0) * k).toFixed(2), Y = p => (oy + (p.n - n0) * k).toFixed(2);
        const esc = t => String(t).replace(/[^\x20-\x7e]/g, "").replace(/([\\()])/g, "\\$1");
        const c = [];
        const path = pts => pts.map((p, i) => `${X(p)} ${Y(p)} ${i ? "l" : "m"}`).join(" ");
        const poly = (rings, fill, stroke, lw) => {
            rings = rings.filter(r => r.length >= 2);
            if (!rings.length) return;
            c.push(`${lw} w ${stroke} RG ${fill || stroke} rg`);
            c.push(rings.map(r => path(r) + " h").join(" ") + ` ${fill ? "B*" : "S"}`);
        };
        const line = (pts, stroke, lw, dash) => { if (pts.length < 2) return; c.push(`${lw} w ${stroke} RG [${dash || ""}] 0 d`); c.push(path(pts) + " S"); c.push("[] 0 d"); };
        const text = (x, y, size, t, bold) => c.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc(t)}) Tj ET`);
        poly([L.boundary], "0.93 0.93 0.93", "0.6 0.6 0.6", 0.4);          // remainder shows through
        poly(L.green, "0.80 0.93 0.80", "0.20 0.55 0.25", 0.8);
        L.ponds.forEach(p => {
            poly(p.rings, "0.86 0.92 0.99", "0.15 0.40 0.75", 0.8);
            if (p.hatch.length) { c.push("0.4 w 0.15 0.40 0.75 RG [] 0 d"); c.push(p.hatch.map(h => path(h)).join(" ") + " S"); }
        });
        L.lots.forEach(l => poly(l.rings, l.ok ? "0.88 0.94 1.00" : "1.00 0.88 0.88", l.ok ? "0.10 0.35 0.65" : "0.75 0.15 0.15", 0.6));
        L.lots.forEach(l => (l.envelope || []).forEach(r => line(r.concat([r[0]]), "0.85 0.45 0.05", 0.4, "2 1.5")));
        (L.sightTriangles || []).forEach(t => line(t.concat([t[0]]), "0.75 0.15 0.15", 0.4, "1 1"));
        poly(L.roadOutline, "0.82 0.82 0.85", "0.35 0.35 0.40", 0.8);
        L.roadCentre.forEach(cl => line(cl, "0.85 0.65 0.10", 0.6, "4 3"));
        L.pipes.forEach(p => line([p.a, p.b], "0.15 0.40 0.75", 0.9, "2 2"));
        poly([L.boundary], null, "0 0 0", 1.6);
        c.push("0 0 0 rg");
        const fs = Math.max(4, Math.min(8, 300 / Math.max(10, L.lots.length)));
        L.lots.forEach(l => text(+X(l.label) - fs, +Y(l.label) - fs / 3, fs, String(l.id)));
        L.ponds.forEach(p => text(+X(p.label) - 8, +Y(p.label) - 2, 6, `POND ${p.id}`, true));
        L.access.forEach(a => text(+X(a) + 3, +Y(a) + 3, 7, a.kind.toUpperCase(), true));
        // Title and summary
        text(M, H - M, 14, (meta && meta.title) || "Subdivision concept layout", true);
        text(M, H - M - 14, 8, `Generated ${(meta && meta.date) || ""} - concept layout for yield study, not a plat or drainage design. Verify against the governing codes.`);
        let y = H - M - 40;
        const tx = 530, ln = (t, b) => { text(tx, y, 8, t, b); y -= 11; };
        const st = L.settings;
        ln("Summary", true);
        ln(`Gross area: ${fmt(L.gross)} sq ft (${fmt(L.gross / SQFT_PER_ACRE, 3)} ac)`);
        ln(`Lots: ${L.lots.length}   Lot area: ${fmt(L.lotArea)} sq ft`);
        if (st.roadOn) ln(`Road (${st.roadEnd === "through" ? "through" : `cul-de-sac R ${fmt(st.culdesacRadius)} ft`}, ${st.alignment}): ${fmt(L.roadArea)} sq ft, ${fmt(st.roadWidth)} ft wide, ${fmt(L.roadLength)} ft`);
        if (st.greenOn) ln(`Green space: ${fmt(L.greenArea)} sq ft (${(L.greenArea / L.gross * 100).toFixed(1)}%)`);
        if (st.pondsOn) ln(`Ponds: ${L.ponds.length} behind the lots, ${fmt(L.pondArea)} sq ft (req. ${fmt(L.pondRequired)}), ${fmt(L.pondWidth, 1)} ft wide, pipe ${fmt(L.pipeLength)} ft`);
        ln(`Remainder: ${fmt(L.remainderArea)} sq ft`);
        ln(`Minimums: ${fmt(st.minFrontage)} ft frontage, ${fmt(st.minLotSF)} sq ft, ${st.minLotAcres} ac; depth ${fmt(st.minLotDepth)}-${fmt(st.maxLotDepth)} ft`);
        y -= 4; ln("Checks", true);
        L.checks.forEach(ch => ln(`${ch.info ? "NOTE" : ch.ok ? "PASS" : "FAIL"}  ${ch.label}`));
        y -= 4; ln("Lot    Area (sq ft)   Acres    Frontage (ft)  OK", true);
        const rows = L.lots.slice(0, Math.max(0, Math.floor((y - M) / 10)));
        rows.forEach(l => { text(tx, y, 7, `${String(l.id).padEnd(6)} ${fmt(l.area).padStart(12)}  ${l.acres.toFixed(3).padStart(7)}  ${fmt(l.frontage, 1).padStart(12)}   ${l.ok ? "yes" : "NO"}`); y -= 10; });
        if (rows.length < L.lots.length) text(tx, y, 7, `... ${L.lots.length - rows.length} more lots in the DXF / on screen`);
        const stream = c.join("\n");
        const objs = [
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
            `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
        ];
        let out = "%PDF-1.4\n";
        const offs = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
        const xref = out.length;
        out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("");
        out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
        return out;
    }

    /** LandXML 1.2 parcels (lots, right-of-way, green space, ponds) via the LandXML plugin, for Civil 3D. */
    function toLandXml(L, meta) {
        if (!window.LandXML || !window.LandXML.buildLandXML) throw new Error("The LandXML plugin isn't loaded.");
        const ring = r => r.map(p => ({ n: p.n, e: p.e }));
        const parcels = [];
        L.lots.forEach(l => l.rings.forEach((r, i) => parcels.push({ name: `LOT ${l.id}${l.rings.length > 1 ? "-" + (i + 1) : ""}`, area: l.area / l.rings.length, desc: `${fmt(l.frontage, 1)} ft frontage${L.settings.phases > 1 ? `, phase ${l.phase}` : ""}`, parcelType: "Lot", vertices: ring(r) })));
        L.roadOutline.forEach((r, i) => parcels.push({ name: `ROW ${i + 1}`, area: L.roadArea, parcelType: "Right-of-Way", vertices: ring(r) }));
        L.green.forEach((g, i) => parcels.push({ name: `OPEN SPACE ${i + 1}`, area: L.greenArea, parcelType: "Open Space", vertices: ring(g) }));
        L.ponds.forEach(pd => pd.rings.forEach((r, i) => parcels.push({ name: `POND ${pd.id}${pd.rings.length > 1 ? "-" + (i + 1) : ""}`, area: pd.area, parcelType: "Stormwater", vertices: ring(r) })));
        return window.LandXML.buildLandXML({ project: { name: (meta && meta.name) || "Subdivision concept", desc: "Concept lot layout — not a plat" }, parcels });
    }

    // A sample tract (~20 acres) in Florida East State Plane feet, irregular on purpose.
    const SAMPLE = [
        "1, 2015000.00, 642000.00",
        "2, 2015040.00, 643180.00",
        "3, 2015690.00, 643250.00",
        "4, 2015820.00, 642620.00",
        "5, 2015640.00, 641990.00"
    ].join("\n");

    window.SubdivisionEngine = {
        SQFT_PER_ACRE, RECOMMENDED, SAMPLE, LAYERS,
        area, clip, clipConvex, lineIntervals, pointInPoly, apportion, mergePieces,
        PRESETS, applyPreset,
        parseBoundary, edges, longestEdge, frame, recommended, validate, maxLots, bestLots, layout, roadPosAt,
        pondAreaRequired, fitRoadLength, hatch, toDxf, toPdf, toLandXml
    };
})();
