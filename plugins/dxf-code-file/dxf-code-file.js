/**
 * Plugin: dxf-code-file (DXF → Code File)
 * plugins/dxf-code-file/dxf-code-file.js
 *
 * Reads the linework in a DXF (LINE, ARC, CIRCLE, LWPOLYLINE, 2D/3D POLYLINE)
 * and writes a Civil 3D Survey Command Language code file (.fbk) in the same
 * style as the Linework Editor's script: every vertex planted once with NEZ,
 * then one FIG BEGIN / FIG PT / FIG CLOSE / FIG END block per figure. Figures
 * are named LW### (LW001, LW002, …) in drawing order.
 *
 * Curves are written as PC / OC / PT points: the arc's start (PC), its
 * mid-arc point (OC, with R/Δ/L in a comment) and its end (PT), so the true
 * curve can be rebuilt from three points on it. A CIRCLE becomes a closed
 * figure of two semicircles.
 *
 * Limits: layers whose first five characters are "SCOPE" (any case — SCOPE,
 * scope01, Scope12…) are not written as figures; each one bounds the
 * linework instead. A closed shape on the layer (closed polyline, circle, or
 * exploded lines that join closed) is the limit; a scope layer with only open
 * linework falls back to its bounding box. Each figure goes to the first scope
 * (natural order) that any of it falls inside; one that runs over a limit is
 * kept whole and commented so it can be trimmed by hand. Each scope gets its
 * own commented block (its NEZ points, then its figures) in the code file.
 *
 * Coordinates are passed through unchanged (DXF X = Easting, Y = Northing,
 * drawing units). Entity types that carry no linework, or that this reader
 * does not convert (SPLINE, ELLIPSE, block INSERTs, …), are counted and
 * reported — never silently dropped.
 *
 * Points: every figure vertex is its own point by default (several points may
 * occupy the same spot); identical coordinates can optionally share a number.
 * TEXT on chosen layers becomes standalone points (text = description). An
 * optional survey point file (PNEZD) supplies elevations: each point takes the
 * Z of the survey point on the same spot (within a tolerance), preferring one
 * whose code matches the figure's layer or the TEXT; unmatched points are
 * reported and keep the DXF elevation.
 *
 * Depends on plugins/dxf-auditor/dxf-parser.js (window.FDOTDXFInspector — the
 * shared resilient tokenizer/parser), plugins/linework/linework-engine.js
 * (window.LineworkEngine.parsePointFile) and core/cogo.js (downloadText).
 * Exposes window.DxfCodeFile for the test suite.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "dxf-code-file",
        version: "1.0.0",
        description: "Read a DXF's linework and write a Civil 3D survey code file (.fbk): NEZ points plus FIG BEGIN/PT/CLOSE/END figures named LW###, with curves as PC/OC/PT points.",
        tab: "tab-dxf-code-file",
        icon: "fa-file-code",
        tier: "Pro",
        dependencies: ["dxf-auditor", "linework"]
    };

    const clean = window.cleanText;
    const LINEWORK_TYPES = ["LINE", "ARC", "CIRCLE", "LWPOLYLINE"];
    const D2R = Math.PI / 180, R2D = 180 / Math.PI;

    // ── Naming ───────────────────────────────────────────────────────────────

    /** LW001 … LW999. Past 999 the number keeps growing (LW1000) rather than wrapping. */
    function figureName(n) {
        if (!Number.isInteger(n) || n < 1) throw new Error(`Figure number must be a positive integer (got ${n}).`);
        return "LW" + String(n).padStart(3, "0");
    }

    // ── Input validation (engineering inputs: blank/invalid is an error) ──────

    function readOptions(raw) {
        const errors = [];
        const int = (v, label, min) => {
            const s = String(v == null ? "" : v).trim();
            if (!/^\d+$/.test(s) || parseInt(s, 10) < min) { errors.push(`${label} must be a whole number ≥ ${min}.`); return null; }
            return parseInt(s, 10);
        };
        const num = (v, label) => {
            const s = String(v == null ? "" : v).trim();
            const n = Number(s);
            if (s === "" || !Number.isFinite(n) || n < 0) { errors.push(`${label} must be a number ≥ 0.`); return null; }
            return n;
        };
        const opts = {
            startPoint: int(raw.startPoint, "Starting point number", 1),
            startFigure: int(raw.startFigure, "Starting figure number", 1),
            join: !!raw.join,
            useScopes: !!raw.useScopes,
            joinTol: raw.join ? num(raw.joinTol, "Join tolerance") : 0,
            layers: raw.layers || null,
            sharePoints: !!raw.sharePoints,
            format: raw.format == null || raw.format === "" ? "script" : String(raw.format),
            textLayers: raw.textLayers || [],
            elevPoints: raw.elevPoints || null,
            matchTol: raw.elevPoints ? num(raw.matchTol, "Point match tolerance") : 0
        };
        if (opts.elevPoints && !opts.elevPoints.length) errors.push("The point file has no points with an elevation.");
        if (opts.format !== "script" && opts.format !== "autodesk") errors.push(`Unknown output format "${opts.format}" (script or autodesk).`);
        return { ok: errors.length === 0, errors, opts };
    }

    // ── Geometry helpers ─────────────────────────────────────────────────────

    /** Arc data for the span a→b with DXF bulge b (tan(Δ/4), + = counter-clockwise). */
    function bulgeArc(a, b, bulge) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const c = Math.hypot(dx, dy);
        const delta = 4 * Math.atan(Math.abs(bulge));
        const radius = c / (2 * Math.sin(delta / 2));
        const sagitta = Math.abs(bulge) * c / 2;
        // A CCW arc keeps its centre on the left of a→b, so it bulges to the right.
        const side = bulge > 0 ? { x: dy / c, y: -dx / c } : { x: -dy / c, y: dx / c };
        const mid = {
            x: (a.x + b.x) / 2 + side.x * sagitta,
            y: (a.y + b.y) / 2 + side.y * sagitta,
            z: ((a.z || 0) + (b.z || 0)) / 2
        };
        const center = { x: mid.x - side.x * radius, y: mid.y - side.y * radius };
        return { radius, deltaDeg: delta * R2D, length: radius * delta, mid, center,
            startAngle: Math.atan2(a.y - center.y, a.x - center.x), sweepRad: bulge > 0 ? delta : -delta,
            direction: bulge > 0 ? "L" : "R" };
    }

    const same = (p, q, tol) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;

    /**
     * Normalise one parsed entity into a path: { layer, closed, verts:[{x,y,z,bulge}] }
     * where verts[i].bulge describes the span verts[i]→verts[i+1] (→verts[0] when
     * closed). An OCS extrusion of (0,0,−1) mirrors X and reverses arc sense.
     */
    function entityToPath(e) {
        const flip = e.extrusionZ != null && e.extrusionZ < 0;
        const fx = x => flip ? -x : x;
        if (e.type === "LINE") {
            return { layer: e.layer, closed: false, source: "LINE", verts: [
                { x: e.startX, y: e.startY, z: e.startZ || 0, bulge: 0 },
                { x: e.endX, y: e.endY, z: e.endZ != null ? e.endZ : (e.startZ || 0), bulge: 0 }] };
        }
        if (e.type === "ARC") {
            let s = e.startAngle || 0, t = e.endAngle || 0;
            if (flip) { [s, t] = [180 - t, 180 - s]; }
            const sweep = ((t - s) % 360 + 360) % 360 || 360;
            const cx = fx(e.startX), cy = e.startY, z = e.startZ || 0, r = e.radius;
            const p = ang => ({ x: cx + r * Math.cos(ang * D2R), y: cy + r * Math.sin(ang * D2R), z });
            return { layer: e.layer, closed: false, source: "ARC", verts: [
                { ...p(s), bulge: Math.tan(sweep * D2R / 4) }, { ...p(s + sweep), bulge: 0 }] };
        }
        if (e.type === "CIRCLE") {
            const cx = fx(e.startX), cy = e.startY, z = e.startZ || 0, r = e.radius;
            return { layer: e.layer, closed: true, source: "CIRCLE", verts: [
                { x: cx + r, y: cy, z, bulge: 1 }, { x: cx - r, y: cy, z, bulge: 1 }] };
        }
        // LWPOLYLINE (also the normalised heavy 2D/3D POLYLINE)
        const is3d = ((e.flags || 0) & 8) === 8;
        const elev = e.elevation || 0;
        return { layer: e.layer, closed: !!e.closed, source: is3d ? "3D POLYLINE" : "POLYLINE", verts: e.vertices.map(v => ({
            x: fx(v.x), y: v.y, z: is3d ? (v.z || 0) : elev,
            bulge: is3d ? 0 : (flip ? -(v.bulge || 0) : (v.bulge || 0)) })) };
    }

    /** Drop repeated vertices (zero-length spans); a closed path also loses a duplicate closing vertex. */
    function tidyPath(path, tol) {
        const out = [];
        let dropped = path.dropped || 0;
        path.verts.forEach(v => {
            const prev = out[out.length - 1];
            // A repeated vertex is a zero-length span: keep the first, but the span after it is v's.
            if (prev && same(prev, v, Math.max(tol, 1e-9))) { prev.bulge = v.bulge || 0; dropped++; return; }
            out.push({ ...v });
        });
        if (dropped) path = { ...path, dropped };
        if (out.length > 2 && same(out[0], out[out.length - 1], Math.max(tol, 1e-9))) {
            out.pop();
            path = { ...path, closed: true };
        }
        return { ...path, verts: out };
    }

    function reversePath(p) {
        const n = p.verts.length;
        const verts = p.verts.slice().reverse().map((v, k) => ({ ...v, bulge: k < n - 1 ? -(p.verts[n - 2 - k].bulge || 0) : 0 }));
        return { ...p, verts };
    }

    /** Only loose LINE / ARC pieces are joined; a polyline or circle is already a drawn figure. */
    const joinable = p => !p.closed && (p.source === "LINE" || p.source === "ARC" || p.source === "joined");

    /**
     * Join open LINE / ARC pieces on the same layer whose endpoints meet within
     * `tol` (exploded linework → one figure). Polylines are left as drawn: two
     * polylines that merely share an endpoint (e.g. parallel offsets) must not be
     * fused into one figure. Order follows the first piece of each chain.
     */
    function joinPaths(paths, tol) {
        const pool = paths.map(p => ({ ...p }));
        const used = new Uint8Array(pool.length);
        // Endpoint index (grid of `cell`), so each extension is a local lookup instead of a scan.
        const cell = Math.max(tol, 1e-6), grid = new Map();
        const key = (i, j) => i + "," + j;
        pool.forEach((p, j) => {
            if (!joinable(p)) return;
            [0, p.verts.length - 1].forEach((vi, end) => {
                const v = p.verts[vi], k = key(Math.floor(v.x / cell), Math.floor(v.y / cell));
                if (!grid.has(k)) grid.set(k, []);
                grid.get(k).push({ j, end });
            });
        });
        // Lowest-index unused piece on `layer` with an end within tol of pt (deterministic).
        const near = (pt, layer) => {
            const ci = Math.floor(pt.x / cell), cj = Math.floor(pt.y / cell);
            let best = null;
            for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
                (grid.get(key(i, j)) || []).forEach(c => {
                    if (used[c.j] || pool[c.j].layer !== layer || (best && best.j <= c.j)) return;
                    const v = pool[c.j].verts[c.end ? pool[c.j].verts.length - 1 : 0];
                    if (same(v, pt, tol)) best = c;
                });
            }
            return best;
        };
        const out = [];
        for (let i = 0; i < pool.length; i++) {
            if (used[i]) continue;
            used[i] = 1;
            const first = pool[i];
            if (!joinable(first)) { out.push(first); continue; }
            const verts = first.verts.map(v => ({ ...v }));
            const prefix = [];                      // chunks found at the head, newest last
            let head = verts[0], count = 1, source = first.source;
            // Extend the tail: the next piece must start at the tail (reverse it if it ends there).
            for (let c = near(verts[verts.length - 1], first.layer); c; c = near(verts[verts.length - 1], first.layer)) {
                used[c.j] = 1;
                const o = c.end === 1 ? reversePath(pool[c.j]) : pool[c.j];
                verts[verts.length - 1] = { ...verts[verts.length - 1], bulge: o.verts[0].bulge || 0 };
                for (let k = 1; k < o.verts.length; k++) verts.push({ ...o.verts[k] });
                count++; if (o.source !== source) source = "joined";
            }
            // Extend the head: the piece must end at the head (reverse it if it starts there).
            for (let c = near(head, first.layer); c; c = near(head, first.layer)) {
                used[c.j] = 1;
                const o = c.end === 0 ? reversePath(pool[c.j]) : pool[c.j];
                const chunk = o.verts.slice(0, -1).map(v => ({ ...v }));
                prefix.push(chunk);
                head = chunk[0];
                count++; if (o.source !== source) source = "joined";
            }
            const all = [].concat(...prefix.reverse(), verts);
            const joined = { ...first, verts: all, source };
            if (count > 1) joined.joined = count;
            out.push(tidyPath(joined, tol));
        }
        return out;
    }

    // ── Scope limits ─────────────────────────────────────────────────────────

    /** "SCOPE", "scope01", "Scope-North"… — the first five characters, case-insensitive. */
    const isScopeLayer = name => String(name || "").slice(0, 5).toUpperCase() === "SCOPE";

    /** Path → plain {x,y} points, arcs sampled every `stepDeg` (closing vertex not repeated). */
    function densifyPath(p, stepDeg) {
        const step = (stepDeg || 5) * D2R;
        const n = p.verts.length, spans = p.closed ? n : n - 1, out = [];
        for (let k = 0; k < spans; k++) {
            const a = p.verts[k], b = p.verts[(k + 1) % n];
            out.push({ x: a.x, y: a.y });
            if (Math.abs(a.bulge || 0) > 1e-12) {
                const arc = bulgeArc(a, b, a.bulge);
                const m = Math.max(1, Math.ceil(Math.abs(arc.sweepRad) / step));
                for (let j = 1; j < m; j++) {
                    const t = arc.startAngle + arc.sweepRad * j / m;
                    out.push({ x: arc.center.x + arc.radius * Math.cos(t), y: arc.center.y + arc.radius * Math.sin(t) });
                }
            }
        }
        if (!p.closed) out.push({ x: p.verts[n - 1].x, y: p.verts[n - 1].y });
        return out;
    }

    function boxOf(pts) {
        const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
        pts.forEach(q => { b.minX = Math.min(b.minX, q.x); b.maxX = Math.max(b.maxX, q.x); b.minY = Math.min(b.minY, q.y); b.maxY = Math.max(b.maxY, q.y); });
        return b;
    }

    /** Point in ring (even-odd), counting points within `tol` of an edge as inside. */
    function inRing(ring, q, tol) {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const a = ring[i], b = ring[j];
            const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2)) : 0;
            if (Math.hypot(q.x - (a.x + t * dx), q.y - (a.y + t * dy)) <= tol) return true;
            if ((a.y > q.y) !== (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
        }
        return inside;
    }

    /**
     * Scope layers → limits, in natural layer order. Closed shapes (after joining
     * the layer's segments within `tol`) are the limit; otherwise its bounding box.
     */
    function buildScopeLimits(scopes, tol) {
        return scopes.map(sc => {
            const rings = joinPaths(sc.paths, tol).filter(p => p.closed).map(p => densifyPath(p)).filter(r => r.length >= 3);
            const box = boxOf(sc.paths.flatMap(p => densifyPath(p)));
            if (rings.length) return { name: sc.name, kind: "polygon", rings, box };
            const boxRing = [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];
            return { name: sc.name, kind: "bbox", rings: [boxRing], box };
        });
    }

    function insideLimit(lim, q, tol) { return lim.rings.some(r => inRing(r, q, tol)); }

    /** Proper crossing of segments p1p2 and p3p4 (touching at an end does not count). */
    function segsCross(p1, p2, p3, p4) {
        const o = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
        const d1 = o(p3, p4, p1), d2 = o(p3, p4, p2), d3 = o(p1, p2, p3), d4 = o(p1, p2, p4);
        return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
    }

    /**
     * How a path relates to a limit: { touches, inside } — touches if any of it
     * is inside or any of its segments crosses the limit's edge; inside if all of
     * it is inside and nothing crosses the edge.
     */
    function relateToLimit(path, lim, tol) {
        const pts = densifyPath(path);
        const segs = [];
        for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
        if (path.closed && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]]);
        const nIn = pts.filter(q => insideLimit(lim, q, tol)).length;
        const crosses = segs.some(([a, b]) => lim.rings.some(r => r.some((q, i) => segsCross(a, b, q, r[(i + 1) % r.length]))));
        return { touches: nIn > 0 || crosses, inside: nIn === pts.length && !crosses };
    }

    // ── Elevations from a survey point file ──────────────────────────────────

    /**
     * PNEZD text → points that carry a real elevation (rows without a Z column
     * are dropped — their 0 would be a placeholder, not an elevation).
     * Uses the Linework Editor's parser.
     */
    function parseElevationFile(text) {
        const res = window.LineworkEngine.parsePointFile(text, "NE");
        const points = res.points.filter(p => p.hasZ && Number.isFinite(p.z));
        return { points, noZ: res.points.length - points.length, bad: res.bad.length };
    }

    const codeTokens = d => String(d || "").toUpperCase().split(/[\s,;]+/).filter(Boolean);

    /**
     * Nearest-point lookup within `tol`. When several survey points sit on the
     * same spot (allowed), the one whose description contains `prefer` (the
     * figure's layer, or the TEXT value) wins, then the nearest, then file order.
     */
    function makeMatcher(points, tol) {
        const cell = Math.max(tol, 1e-6), grid = new Map();
        const key = (i, j) => i + "," + j;
        points.forEach((p, idx) => {
            const k = key(Math.floor(p.e / cell), Math.floor(p.n / cell));
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push({ p, idx, codes: codeTokens(p.desc) });
        });
        return (x, y, prefer) => {
            const ci = Math.floor(x / cell), cj = Math.floor(y / cell), want = String(prefer || "").toUpperCase();
            const found = [];
            for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
                (grid.get(key(i, j)) || []).forEach(c => {
                    const d = Math.hypot(c.p.e - x, c.p.n - y);
                    if (d <= tol + 1e-9) found.push({ ...c, d, code: want && c.codes.includes(want) });
                });
            }
            if (!found.length) return null;
            found.sort((a, b) => (b.code - a.code) || (a.d - b.d) || (a.idx - b.idx));
            const best = found[0];
            const ambiguous = !best.code && found.some(c => Math.abs(c.p.z - best.p.z) > 1e-6);
            return { z: best.p.z, ptNum: best.p.ptNum, desc: best.p.desc, ambiguous };
        };
    }

    // ── Extraction ───────────────────────────────────────────────────────────

    /** Count every entity type in the ENTITIES section (the parser only keeps the types it models). */
    function countEntityTypes(dxfText) {
        const pairs = window.FDOTDXFInspector.prototype.tokenizeDXF.call(null, dxfText);
        const counts = {};
        let section = "", expectName = false;
        for (const [code, value] of pairs) {
            if (code === 0 && value === "SECTION") { expectName = true; continue; }
            if (expectName && code === 2) { section = value; expectName = false; continue; }
            if (code === 0 && value === "ENDSEC") { section = ""; continue; }
            if (section === "ENTITIES" && code === 0 && !["VERTEX", "SEQEND"].includes(value)) counts[value] = (counts[value] || 0) + 1;
        }
        return counts;
    }

    /**
     * DXF text → { paths, layers, scopes, texts, textLayers, skipped, entityCounts,
     * repairs }. `texts` are TEXT entities (candidate points). `paths` are
     * model-space linework in drawing order (scope layers excluded); `scopes` are
     * the SCOPE* layers' paths, [{ name, paths }] in natural layer order;
     * `skipped` lists what was not converted and why.
     */
    function extractLinework(dxfText) {
        const text = String(dxfText == null ? "" : dxfText);
        if (!/\bENTITIES\b/.test(text)) throw new Error("No ENTITIES section found — this does not look like an ASCII DXF file.");
        const inspector = new window.FDOTDXFInspector(window.FDOT_DATA || { layers: [] });
        const parsed = inspector.parseDXF(text);
        const entityCounts = countEntityTypes(text);
        const skipped = [];
        const paths = [];
        let paper = 0, degenerate = 0;
        parsed.entities.forEach(e => {
            if (!LINEWORK_TYPES.includes(e.type)) return;
            if (e.paperSpace) { paper++; return; }
            const p = tidyPath(entityToPath(e), 0);
            const bad = p.verts.length < 2 || p.verts.some(v => !Number.isFinite(v.x) || !Number.isFinite(v.y))
                || ((e.type === "ARC" || e.type === "CIRCLE") && !(e.radius > 0));
            if (bad) { degenerate++; return; }
            paths.push(p);
        });
        const scopeMap = new Map();
        paths.filter(p => isScopeLayer(p.layer)).forEach(p => {
            if (!scopeMap.has(p.layer)) scopeMap.set(p.layer, []);
            scopeMap.get(p.layer).push(p);
        });
        const scopes = [...scopeMap.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .map(name => ({ name, paths: scopeMap.get(name) }));
        const linework = paths.filter(p => !isScopeLayer(p.layer));
        const repairs = {};
        linework.forEach(p => { if (p.dropped) repairs[p.layer] = (repairs[p.layer] || 0) + p.dropped; });
        if (paper) skipped.push({ what: "paper-space linework", count: paper, why: "only model space is converted" });
        if (degenerate) skipped.push({ what: "zero-length / invalid entities", count: degenerate, why: "no usable geometry" });
        const modelled = { LINE: 1, ARC: 1, CIRCLE: 1, LWPOLYLINE: 1, POLYLINE: 1 };
        Object.keys(entityCounts).sort().forEach(type => {
            if (modelled[type]) return;
            const why = ["TEXT", "MTEXT", "DIMENSION", "HATCH", "POINT", "ATTRIB", "ATTDEF", "LEADER", "MULTILEADER", "VIEWPORT"].includes(type)
                ? "not linework"
                : type === "INSERT" ? "block references are not exploded — explode them in CAD first"
                : "entity type not converted (approximate it as a polyline in CAD first)";
            skipped.push({ what: type, count: entityCounts[type], why });
        });
        const layers = [...new Set(linework.map(p => p.layer))].sort();
        // TEXT → candidate points (insertion point, text as description).
        const texts = parsed.entities
            .filter(e => e.type === "TEXT" && !e.paperSpace && Number.isFinite(e.startX) && Number.isFinite(e.startY) && String(e.text || "").trim())
            .map(e => ({ layer: e.layer, text: String(e.text).replace(/["\r\n]+/g, " ").replace(/\s+/g, " ").trim(), x: e.startX, y: e.startY, z: e.startZ || 0 }));
        const textLayers = {};
        texts.forEach(t => { textLayers[t.layer] = (textLayers[t.layer] || 0) + 1; });
        const skippedOut = skipped.filter(sk => sk.what !== "TEXT");
        return { paths: linework, layers, scopes, skipped: skippedOut, entityCounts, repairs, texts, textLayers };
    }

    // ── Code file ────────────────────────────────────────────────────────────

    /**
     * Autodesk Field Book syntax, as Civil 3D's Import Field Book reads it (and as
     * field books like Vinings.fbk use it): `NE SS pt N E Z "desc"` creates a point
     * and adds it to the open figure, `POINT pt` re-uses an existing point,
     * `BEG name` / `END` / `CLOSE name` bound a figure, and `C3` makes a curve
     * through the next three points (PC, on-curve, PT). TEXT points come first,
     * outside any figure. No comments are written (the format's comment syntax
     * isn't documented) — scope, elevation-source and warning notes are in the
     * conversion report instead.
     */
    function autodeskFieldBook(groups, figures, points) {
        const L = [], made = new Set();
        const pointLine = pt => {
            if (made.has(pt.num)) return `POINT ${pt.num}`;
            made.add(pt.num);
            // Figure points carry just the figure name: PC/OC/PT tokens in a description could be
            // re-read as linework codes if "Process linework" is ticked on import.
            const desc = pt.kind === "fig" ? pt.fig : pt.desc;
            return `NE SS ${pt.num} ${pt.n.toFixed(4)} ${pt.e.toFixed(4)} ${pt.z.toFixed(4)} "${desc}"`;
        };
        groups.forEach((g, gi) => {
            points.filter(pt => pt.group === gi && pt.kind === "text").forEach(pt => L.push(pointLine(pt)));
            figures.filter(f => f.group === gi).forEach(f => {
                L.push(`BEG ${f.name}`);
                const seq = f.seq;
                let endsOnStart = false;
                for (let i = 0; i < seq.length; i++) {
                    const q = seq[i];
                    if (q.arc) {
                        // Curve PC → OC → PT: C3, then the PC re-listed, the OC, and the PT.
                        const pc = seq[i - 1].pt, closing = i === seq.length - 1;
                        const pt = closing ? seq[0].pt : seq[i + 1].pt;
                        L.push("C3", `POINT ${pc.num}`, pointLine(q.pt), pointLine(pt));
                        if (closing) endsOnStart = true; else i++;
                    } else {
                        L.push(pointLine(q.pt));
                    }
                }
                L.push(f.closed && !endsOnStart ? `CLOSE ${f.name}` : "END");
            });
        });
        return L.join("\r\n") + "\r\n";      // never empty: buildCodeFile refuses a drawing with nothing to write
    }

    /**
     * Build figures from paths (layer filter → optional join → elevations →
     * scope limits → LW### names), plus TEXT points, and the code-file text.
     * Returns { text, figures, points, warnings, scopes, outside, elevation }.
     * `scopes` is null when no scope limits were applied; `elevation` is null
     * without a point file.
     */
    function buildCodeFile(extracted, rawOpts, meta) {
        const { ok, errors, opts } = readOptions(rawOpts || {});
        if (!ok) throw new Error(errors.join(" "));
        meta = meta || {};
        let paths = extracted.paths;
        if (opts.layers) {
            const keep = new Set(opts.layers);
            paths = paths.filter(p => keep.has(p.layer));
        }
        if (opts.join) paths = joinPaths(paths, opts.joinTol);
        const wantText = new Set(opts.textLayers);
        let texts = (extracted.texts || []).filter(t => wantText.has(t.layer)).map(t => ({ ...t }));
        if (!paths.length && !texts.length) throw new Error("No linework to convert (check the layer selection).");

        const warnings = [];
        const fixed = Object.keys(extracted.repairs || {}).filter(l => paths.some(p => p.layer === l));
        const fixedN = fixed.reduce((a, l) => a + extracted.repairs[l], 0);
        const repairNote = fixedN ? `${fixedN} repeated vertex(es) (zero-length segments) removed on ${fixed.join(", ")}.` : null;
        if (repairNote) warnings.push(repairNote);

        // Group by scope: [{ limit|null, items:[{ path, crosses, alsoIn }], texts:[] }].
        const tol = opts.join ? opts.joinTol : 1e-6;
        const scopeOn = opts.useScopes && extracted.scopes && extracted.scopes.length > 0;
        let groups, outside = 0, textOutside = 0, limits = null;
        if (scopeOn) {
            limits = buildScopeLimits(extracted.scopes, tol);
            groups = limits.map(limit => ({ limit, items: [], texts: [] }));
            paths.forEach(path => {
                const hits = [];
                limits.forEach((lim, i) => {
                    const rel = relateToLimit(path, lim, tol);
                    if (rel.touches) hits.push({ i, all: rel.inside });
                });
                if (!hits.length) { outside++; return; }
                groups[hits[0].i].items.push({ path, crosses: !hits[0].all, alsoIn: hits.slice(1).map(h => limits[h.i].name) });
            });
            texts.forEach(t => {
                const i = limits.findIndex(lim => insideLimit(lim, t, tol));
                if (i < 0) textOutside++; else groups[i].texts.push(t);
            });
            if (outside) warnings.push(`${outside} figure(s) lie entirely outside every SCOPE layer and were not written.`);
            if (textOutside) warnings.push(`${textOutside} TEXT point(s) lie outside every SCOPE layer and were not written.`);
            const crossing = groups.reduce((a, g) => a + g.items.filter(it => it.crosses).length, 0);
            if (crossing) warnings.push(`${crossing} figure(s) run over a SCOPE limit — kept whole and commented in the file for manual editing.`);
            if (!groups.some(g => g.items.length || g.texts.length)) throw new Error("No linework falls inside the SCOPE limits.");
        } else {
            groups = [{ limit: null, items: paths.map(path => ({ path })), texts }];
        }
        // Elevations: every written vertex / TEXT point takes Z from the survey point on the same
        // spot (after scope filtering, so dropped linework doesn't skew the counts).
        let elevation = null;
        if (opts.elevPoints) {
            const match = makeMatcher(opts.elevPoints, opts.matchTol);
            const miss = {};
            let matched = 0, total = 0, ambiguous = 0;
            const onePath = p => ({ ...p, verts: p.verts.map(v => {
                total++;
                const m = match(v.x, v.y, p.layer);
                if (!m) { miss[p.layer] = (miss[p.layer] || 0) + 1; return { ...v, srcPt: null }; }
                matched++; if (m.ambiguous) ambiguous++;
                return { ...v, z: m.z, srcPt: m.ptNum, ambiguous: m.ambiguous };
            }) });
            const oneText = tx => {
                total++;
                const m = match(tx.x, tx.y, tx.text);
                if (!m) { miss[`TEXT ${tx.layer}`] = (miss[`TEXT ${tx.layer}`] || 0) + 1; return { ...tx, srcPt: null }; }
                matched++; if (m.ambiguous) ambiguous++;
                return { ...tx, z: m.z, srcPt: m.ptNum, ambiguous: m.ambiguous };
            };
            groups = groups.map(g => ({ ...g, items: g.items.map(it => ({ ...it, path: onePath(it.path) })), texts: g.texts.map(oneText) }));
            const missList = Object.keys(miss).map(l => `${l} (${miss[l]})`);
            elevation = { matched, total, tol: opts.matchTol, unmatched: total - matched, missByLayer: miss, ambiguous };
            if (total - matched) warnings.push(`${total - matched} of ${total} point(s) have no survey point within ${opts.matchTol} — they keep the DXF elevation: ${missList.join(", ")}.`);
            if (ambiguous) warnings.push(`${ambiguous} point(s) matched more than one survey point with different elevations and no matching code — the nearest was used; check them.`);
        }
        const figCount = groups.reduce((a, g) => a + g.items.length, 0);
        const lastFig = opts.startFigure + figCount - 1;
        if (lastFig > 999) warnings.push(`${figCount} figures run past LW999 — numbering continues as ${figureName(Math.max(1000, opts.startFigure))}…${figureName(lastFig)}.`);

        // Points. By default every figure vertex is its own point — several points may
        // occupy the same spot. sharePoints reuses one number for identical coordinates.
        const points = [];
        const byKey = new Map();
        let nextPt = opts.startPoint;
        const plant = (v, desc, gi, kind, fig) => {
            const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${(v.z || 0).toFixed(4)}`;
            if (opts.sharePoints && kind === "fig" && byKey.has(key)) return byKey.get(key);
            const pt = { num: nextPt++, n: v.y, e: v.x, z: v.z || 0, desc, group: gi, kind, fig: fig || null,
                srcPt: v.srcPt === undefined ? undefined : v.srcPt, ambiguous: !!v.ambiguous };
            if (kind === "fig") byKey.set(key, pt);
            points.push(pt);
            return pt;
        };

        const figures = [];
        groups.forEach((g, gi) => {
            g.texts.forEach(t => plant(t, t.text, gi, "text"));
            g.items.forEach(it => {
                const p = it.path;
                const name = figureName(opts.startFigure + figures.length);
                const n = p.verts.length;
                const spans = p.closed ? n : n - 1;
                const marks = p.verts.map(() => []);          // curve flags per vertex
                const curves = [];
                for (let k = 0; k < spans; k++) {
                    const b = p.verts[k].bulge || 0;
                    if (Math.abs(b) < 1e-12) continue;
                    const a = p.verts[k], z = p.verts[(k + 1) % n];
                    curves.push({ after: k, arc: bulgeArc(a, z, b) });
                    marks[k].push("PC");
                    marks[(k + 1) % n].push("PT");
                }
                // Vertex order in the file: each vertex, then its span's OC point.
                const seq = [];
                p.verts.forEach((v, k) => {
                    const flags = ["PT", "PC"].filter(f => marks[k].includes(f));   // a PT/PC point ends one curve and starts the next
                    seq.push({ pt: plant(v, [name].concat(flags).join(" "), gi, "fig", name), flags });
                    const c = curves.find(cv => cv.after === k);
                    if (c) seq.push({ pt: plant({ ...c.arc.mid, srcPt: opts.elevPoints ? "OC" : undefined }, `${name} OC`, gi, "fig", name), flags: ["OC"], arc: c.arc });
                });
                let length = 0;
                for (let k = 0; k < spans; k++) {
                    const c = curves.find(cv => cv.after === k);
                    length += c ? c.arc.length : Math.hypot(p.verts[(k + 1) % n].x - p.verts[k].x, p.verts[(k + 1) % n].y - p.verts[k].y);
                }
                // Closed figures: exact area = chord polygon ± each arc's circular segment.
                let area = null;
                if (p.closed && n >= 2) {
                    let signed = window.COGO.signedShoelaceArea(p.verts.map(v => ({ e: v.x, n: v.y })));
                    curves.forEach(c => { signed += Math.sign(p.verts[c.after].bulge) * window.COGO.circularSegmentArea(c.arc.radius, c.arc.length); });
                    area = Math.abs(signed);
                }
                const zs = seq.map(q => q.pt.z);
                figures.push({ name, layer: p.layer, closed: p.closed, source: p.source, joined: p.joined || 1, seq, curves: curves.length, length,
                    group: gi, scope: g.limit ? g.limit.name : null, crosses: !!it.crosses, alsoIn: it.alsoIn || [],
                    dropped: p.dropped || 0, area, zMin: Math.min(...zs), zMax: Math.max(...zs),
                    firstPt: Math.min(...seq.map(q => q.pt.num)), lastPt: Math.max(...seq.map(q => q.pt.num)),
                    // In seq an OC sits between its PC (before) and PT (after, wrapping on a closed figure).
                    arcs: curves.map(c => { const i = seq.findIndex(q => q.arc === c.arc); return {
                        pc: seq[i - 1].pt.num, oc: seq[i].pt.num, pt: seq[(i + 1) % seq.length].pt.num,
                        radius: c.arc.radius, deltaDeg: c.arc.deltaDeg, length: c.arc.length, direction: c.arc.direction,
                        chord: Math.hypot(p.verts[(c.after + 1) % n].x - p.verts[c.after].x, p.verts[(c.after + 1) % n].y - p.verts[c.after].y) }; }) });
            });
        });
        const textCount = points.filter(pt => pt.kind === "text").length;

        const f3 = v => v.toFixed(3);
        const limitText = lim => lim.kind === "polygon"
            ? `closed boundary on the layer (${lim.rings.length} shape${lim.rings.length === 1 ? "" : "s"})`
            : "bounding box of the layer's linework (no closed shape found)";
        const nezLine = pt => {
            let note = "";
            if (pt.srcPt === "OC") note = "   // Z = mean of PC/PT";
            else if (pt.srcPt === null) note = "   // no survey point here — Z from DXF";
            else if (pt.srcPt !== undefined) note = `   // Z from survey pt ${pt.srcPt}`;
            return `NEZ ${pt.num} ${pt.n.toFixed(4)} ${pt.e.toFixed(4)} ${pt.z.toFixed(4)} "${pt.desc}"${note}`;
        };

        const L = [];
        L.push("// Generated by DXF → Code File (plugins/dxf-code-file/dxf-code-file.js)");
        if (meta.sourceName) L.push(`// Source: ${String(meta.sourceName).replace(/[\r\n]+/g, " ")}`);
        L.push(`// ${meta.timestamp || new Date().toISOString()}`);
        L.push(`// ${figures.length} figure(s)${figures.length ? ` ${figures[0].name}–${figures[figures.length - 1].name}` : ""}, ${points.length} point(s)${textCount ? ` (${textCount} from TEXT)` : ""}. Coordinates in drawing units (DXF X = E, Y = N).`);
        L.push("// Civil 3D Survey Command Language — NEZ, FIG BEGIN/PT/CLOSE/END. Curves: PC / OC (mid-arc) / PT points.");
        L.push(opts.sharePoints ? "// Coincident vertices share one point number." : "// Each figure has its own points (points may occupy the same spot).");
        if (elevation) L.push(`// Elevations: ${elevation.matched} of ${elevation.total} point(s) matched to the survey point file within ${elevation.tol}${meta.elevSource ? ` (${String(meta.elevSource).replace(/[\r\n]+/g, " ")})` : ""}; the rest keep the DXF elevation.`);
        if (repairNote) L.push(`// ${repairNote}`);
        if (scopeOn) {
            L.push(`// Limited to ${limits.length} SCOPE layer(s): ${limits.map(l => l.name).join(", ")}. Each scope below is its own block (points, then figures).`);
            if (outside) L.push(`// ${outside} figure(s) outside every scope were not written.`);
            if (textOutside) L.push(`// ${textOutside} TEXT point(s) outside every scope were not written.`);
        }
        L.push("");
        const writeFigure = f => {
            const notes = [`layer ${f.layer}`];
            if (f.joined > 1) notes.push(`joined from ${f.joined} entities`);
            if (f.crosses) notes.push(`RUNS OVER the ${f.scope} limit — edit manually`);
            if (f.alsoIn.length) notes.push(`also touches ${f.alsoIn.join(", ")}`);
            L.push(`FIG BEGIN ${f.name}   // ${notes.join(", ")}`);
            f.seq.forEach(s => {
                let tag = "";
                if (s.arc) tag = `   // OC  R=${s.arc.radius.toFixed(4)}  Δ=${s.arc.deltaDeg.toFixed(4)}°  L=${s.arc.length.toFixed(4)}  ${s.arc.direction === "L" ? "left" : "right"}`;
                else if (s.flags.length) tag = `   // ${s.flags.join("/")}`;
                L.push(`FIG PT ${s.pt.num}${tag}`);
            });
            if (f.closed) L.push("FIG CLOSE");
            L.push("FIG END");
            L.push("");
        };
        groups.forEach((g, gi) => {
            const figs = figures.filter(f => f.group === gi);
            const tpts = points.filter(pt => pt.group === gi && pt.kind === "text");
            if (g.limit) {
                const b = g.limit.box;
                const what = [figs.length ? `${figs.length} figure(s) ${figs[0].name}–${figs[figs.length - 1].name}` : "", tpts.length ? `${tpts.length} TEXT point(s)` : ""].filter(Boolean).join(", ");
                L.push("// ════════════════════════════════════════════════════════════════");
                L.push(`// SCOPE ${g.limit.name} — ${what || "no linework inside these limits"}`);
                L.push(`// Limits: ${limitText(g.limit)}; extents E ${f3(b.minX)}–${f3(b.maxX)}, N ${f3(b.minY)}–${f3(b.maxY)}`);
                L.push("// ════════════════════════════════════════════════════════════════");
                L.push("");
            }
            if (tpts.length) {
                L.push(`// Points from TEXT (${[...new Set(g.texts.map(t => t.layer))].join(", ")}) — the text is the description`);
                tpts.forEach(pt => L.push(nezLine(pt)));
                L.push("");
            }
            const fpts = points.filter(pt => pt.group === gi && pt.kind === "fig");
            if (fpts.length) {
                if (tpts.length) L.push("// Figure points");
                fpts.forEach(pt => L.push(nezLine(pt)));
                L.push("");
            }
            figs.forEach(writeFigure);
        });
        const scopesOut = scopeOn ? limits.map((lim, gi) => ({ name: lim.name, kind: lim.kind, box: lim.box, figures: figures.filter(f => f.group === gi).length })) : null;
        const text = opts.format === "autodesk"
            ? autodeskFieldBook(groups, figures, points)
            : L.join("\r\n").replace(/(\r\n){3,}/g, "\r\n\r\n").trim() + "\r\n";
        return { text, figures, points, warnings, scopes: scopesOut, outside, textOutside, elevation, opts, limits, meta };
    }

    // ── Conversion report ────────────────────────────────────────────────────

    const padR = (v, w) => String(v).padEnd(w);
    const padL = (v, w) => String(v).padStart(w);
    const ft = (v, d) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d == null ? 3 : d));

    /** Nearest distance from (x,y) to a point set, via a coarse grid searched ring by ring. */
    function makeNearest(pts) {
        if (!pts.length) return () => ({ d: Infinity, item: null });
        const box = boxOf(pts);
        const cell = Math.max((box.maxX - box.minX) / 100, (box.maxY - box.minY) / 100, 1);
        const grid = new Map(), key = (i, j) => i + "," + j;
        pts.forEach(q => { const k = key(Math.floor(q.x / cell), Math.floor(q.y / cell)); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(q); });
        const maxRing = Math.ceil(Math.max(box.maxX - box.minX, box.maxY - box.minY) / cell) + 2;
        return (x, y) => {
            const ci = Math.floor(x / cell), cj = Math.floor(y / cell);
            let best = { d: Infinity, item: null };
            for (let r = 0; r <= maxRing; r++) {
                if (best.d < (r - 1) * cell) break;
                for (let i = ci - r; i <= ci + r; i++) for (let j = cj - r; j <= cj + r; j++) {
                    if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
                    (grid.get(key(i, j)) || []).forEach(q => { const d = Math.hypot(q.x - x, q.y - y); if (d < best.d) best = { d, item: q }; });
                }
            }
            if (!Number.isFinite(best.d)) pts.forEach(q => { const d = Math.hypot(q.x - x, q.y - y); if (d < best.d) best = { d, item: q }; });
            return best;
        };
    }

    /**
     * Survey point accounting: which points of the elevation file were used, and
     * for each one that wasn't, the factual reason (same spot as a used point,
     * outside the drawing's extents, or off the linework with the distance).
     */
    function surveyAccounting(result, extracted) {
        const pts = result.opts.elevPoints;
        if (!pts) return null;
        const used = new Set(result.points.map(p => p.srcPt).filter(x => x != null && x !== "OC"));
        const tol = result.opts.matchTol;
        const geo = [];
        extracted.paths.forEach(p => p.verts.forEach(v => geo.push({ x: v.x, y: v.y, what: p.layer })));
        (extracted.texts || []).forEach(t => geo.push({ x: t.x, y: t.y, what: `TEXT "${t.text}"` }));
        const box = boxOf(geo.length ? geo : [{ x: 0, y: 0 }]);
        const nearest = makeNearest(geo);
        const usedPts = pts.filter(p => used.has(p.ptNum));
        const nearestUsed = makeNearest(usedPts.map(q => ({ x: q.e, y: q.n, what: `pt ${q.ptNum}${q.desc ? ` "${q.desc}"` : ""}` })));
        const unused = pts.filter(p => !used.has(p.ptNum)).map(p => {
            const nu = nearestUsed(p.e, p.n);
            if (nu.item && nu.d <= tol + 1e-9) return { p, reason: `same spot as ${nu.item.what} (used) — repeat shot` };
            const dx = Math.max(box.minX - p.e, 0, p.e - box.maxX), dy = Math.max(box.minY - p.n, 0, p.n - box.maxY);
            const out = Math.hypot(dx, dy);
            if (out > 0) return { p, reason: `outside the drawing extents by ${ft(out, 1)}` };
            const nb = nearest(p.e, p.n);
            return { p, reason: `not on the linework — nearest: ${nb.item ? nb.item.what : "nothing"} at ${ft(nb.d, 3)}${nu.item ? `; used survey ${nu.item.what} at ${ft(nu.d, 3)}` : ""}` };
        });
        return { total: pts.length, used: used.size, unused };
    }

    /** Plain-text conversion report for a buildCodeFile result (facts only, no grades). */
    function buildReport(result, extracted, extra) {
        extra = extra || {};
        const o = result.opts, meta = result.meta || {}, figs = result.figures, pts = result.points;
        const L = [], rule = "=".repeat(78), sub = "-".repeat(78);
        const line = (label, value) => L.push(`  ${padR(label, 28)}: ${value}`);
        L.push("DXF → CODE FILE — CONVERSION REPORT");
        L.push(rule);
        line("Source DXF", meta.sourceName || "—");
        line("Point file (elevations)", meta.elevSource ? `${meta.elevSource} (${o.elevPoints.length} points with an elevation)` : "none");
        line("Code file", extra.codeFileName || "—");
        line("Generated", meta.timestamp || new Date().toISOString());
        line("Tool", `plugins/dxf-code-file v${MANIFEST.version}`);
        L.push("");
        L.push("SETTINGS");
        L.push(sub);
        line("Starting point / figure", `${o.startPoint} / ${figureName(o.startFigure)}`);
        line("Join LINE / ARC pieces", o.join ? `on, tolerance ${o.joinTol}` : "off");
        line("Output format", o.format === "autodesk" ? "Autodesk Field Book (BEG / NE SS / C3 / END)" : "survey command script (NEZ + FIG BEGIN / PT / END)");
        line("Points", o.sharePoints ? "coincident vertices share one number" : "every figure has its own points");
        const nScopes = (extracted.scopes || []).length;
        line("SCOPE limits", !nScopes ? "none in the drawing" : o.useScopes ? `on — ${result.limits.map(l => `${l.name} (${l.kind === "polygon" ? "boundary" : "bounding box"})`).join(", ")}` : `off (${nScopes} in the drawing)`);
        if (o.elevPoints) line("Elevation match tolerance", String(o.matchTol));
        const allLayers = extracted.layers, chosen = o.layers ? allLayers.filter(l => o.layers.includes(l)) : allLayers;
        line("Linework layers", chosen.length === allLayers.length ? `all ${allLayers.length}` : `${chosen.length} of ${allLayers.length} — left out: ${allLayers.filter(l => !chosen.includes(l)).join(", ")}`);
        const tl = extracted.textLayers || {};
        line("TEXT → points layers", o.textLayers.length ? o.textLayers.map(l => `${l} (${tl[l] || 0})`).join(", ") : "none");
        L.push("");

        const textPts = pts.filter(p => p.kind === "text").length;
        const closed = figs.filter(f => f.closed).length, nCurves = figs.reduce((a, f) => a + f.curves, 0);
        L.push("RESULT");
        L.push(sub);
        line("Figures", `${figs.length}${figs.length ? ` (${figs[0].name}–${figs[figs.length - 1].name})` : ""} — ${closed} closed, ${figs.length - closed} open, ${nCurves} curve(s)`);
        line("Points", `${pts.length} — ${pts.length - textPts} figure, ${textPts} from TEXT`);
        if (result.elevation) line("Elevations", `${result.elevation.matched} of ${result.elevation.total} matched to a survey point; ${result.elevation.unmatched} kept the DXF elevation`);
        const byLayer = {};
        figs.forEach(f => { const b = byLayer[f.layer] || (byLayer[f.layer] = { n: 0, len: 0 }); b.n++; b.len += f.length; });
        L.push("");
        L.push(`  ${padR("Layer", 16)}${padL("Figures", 8)}${padL("Length", 14)}`);
        Object.keys(byLayer).sort().forEach(l => L.push(`  ${padR(l, 16)}${padL(byLayer[l].n, 8)}${padL(ft(byLayer[l].len), 14)}`));
        L.push("");

        // Items to review — most actionable first.
        const items = [];
        const layerOf = {};
        figs.forEach(f => { layerOf[f.name] = f.layer; });
        const where = p => p.fig ? `${p.fig} ${padR(`(${layerOf[p.fig]})`, 14)}` : `${padR(`TEXT "${p.desc}"`, 20)}`;
        const unmatched = pts.filter(p => p.srcPt === null);
        if (unmatched.length) items.push({ title: `Points with no survey point within ${o.matchTol} — they kept the DXF elevation (${unmatched.length})`,
            rows: unmatched.map(p => `pt ${padL(p.num, 6)}  ${where(p)} N ${ft(p.n, 4)}  E ${ft(p.e, 4)}  Z ${ft(p.z, 4)}`) });
        const amb = pts.filter(p => p.ambiguous);
        if (amb.length) items.push({ title: `Elevations taken from one of several survey points on the same spot with different Z and no matching code (${amb.length})`,
            rows: amb.map(p => `pt ${padL(p.num, 6)}  ${where(p)} Z ${ft(p.z, 4)} from survey pt ${p.srcPt}`) });
        const over = figs.filter(f => f.crosses);
        if (over.length) items.push({ title: `Figures running over a SCOPE limit — kept whole, trim by hand (${over.length})`,
            rows: over.map(f => `${f.name}  ${padR(f.layer, 12)} ${f.scope}${f.alsoIn.length ? `, also touches ${f.alsoIn.join(", ")}` : ""}`) });
        if (result.outside) items.push({ title: `Figures outside every SCOPE layer — not written (${result.outside})`, rows: [] });
        if (result.textOutside) items.push({ title: `TEXT points outside every SCOPE layer — not written (${result.textOutside})`, rows: [] });
        const dropped = figs.filter(f => f.dropped);
        if (dropped.length) items.push({ title: `Repeated vertices removed (zero-length segments) — ${dropped.reduce((a, f) => a + f.dropped, 0)} in ${dropped.length} figure(s)`,
            rows: dropped.map(f => `${f.name}  ${padR(f.layer, 12)} ${f.dropped} removed`) });
        const skipped = extracted.skipped || [];
        if (skipped.length) items.push({ title: "DXF entities not converted", rows: skipped.map(sk => `${padR(sk.what, 24)} ×${padL(sk.count, 5)}  ${sk.why}`) });
        L.push(`ITEMS TO REVIEW (${items.length})`);
        L.push(sub);
        if (!items.length) L.push("  (none)");
        items.forEach((it, i) => {
            L.push(`  ${i + 1}. ${it.title}`);
            it.rows.forEach(r => L.push(`       ${r}`));
        });
        L.push("");

        L.push("FIGURES");
        L.push(sub);
        const scoped = !!result.scopes;
        L.push(`  ${padR("Figure", 8)}${scoped ? padR("Scope", 10) : ""}${padR("Layer", 13)}${padR("Type", 7)}${padR("Points", 14)}${padL("Curves", 7)}${padL("Length", 12)}${padL("Area", 14)}${padL("Z min", 11)}${padL("Z max", 11)}`);
        figs.forEach(f => L.push(`  ${padR(f.name, 8)}${scoped ? padR(f.scope, 10) : ""}${padR(f.layer, 13)}${padR(f.closed ? "closed" : "open", 7)}${padR(`${f.firstPt}–${f.lastPt}`, 14)}${padL(f.curves || "—", 7)}${padL(ft(f.length), 12)}${padL(f.area == null ? "—" : ft(f.area, 2), 14)}${padL(ft(f.zMin), 11)}${padL(ft(f.zMax), 11)}`));
        L.push("");

        const arcs = [];
        figs.forEach(f => f.arcs.forEach(a => arcs.push({ f, a })));
        if (arcs.length) {
            L.push("CURVES");
            L.push(sub);
            L.push(`  ${padR("Figure", 8)}${padR("PC/OC/PT", 20)}${padL("Radius", 12)}${padL("Delta °", 11)}${padL("Arc L", 11)}${padL("Chord", 11)}  Turn`);
            arcs.forEach(({ f, a }) => L.push(`  ${padR(f.name, 8)}${padR(`${a.pc}/${a.oc}/${a.pt}`, 20)}${padL(ft(a.radius, 4), 12)}${padL(ft(a.deltaDeg, 4), 11)}${padL(ft(a.length), 11)}${padL(ft(a.chord), 11)}  ${a.direction === "L" ? "left" : "right"}`));
            L.push("");
        }

        const acc = surveyAccounting(result, extracted);
        if (acc) {
            L.push("SURVEY POINT ACCOUNTING");
            L.push(sub);
            L.push(`  ${acc.used} of ${acc.total} survey points supplied an elevation; ${acc.unused.length} were not used:`);
            acc.unused.forEach(u => L.push(`    pt ${padL(u.p.ptNum, 6)}  ${padR(`"${u.p.desc}"`, 12)} N ${ft(u.p.n, 3)}  E ${ft(u.p.e, 3)}  Z ${ft(u.p.z, 3)}  — ${u.reason}`));
            L.push("");
        }
        L.push(rule);
        L.push("Facts only: counts and values are computed from the drawing and point file; nothing here is a pass/fail grade.");
        return L.join("\r\n") + "\r\n";
    }

    /** Figure table as CSV (one row per figure). */
    function buildFigureCsv(result) {
        const q = v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
        const rows = [["Figure", "Scope", "Layer", "Type", "FirstPoint", "LastPoint", "Points", "Curves", "Length", "Area", "Zmin", "Zmax", "RunsOverScope"].join(",")];
        result.figures.forEach(f => rows.push([f.name, f.scope || "", f.layer, f.closed ? "closed" : "open", f.firstPt, f.lastPt, f.seq.length, f.curves,
            f.length.toFixed(3), f.area == null ? "" : f.area.toFixed(2), f.zMin.toFixed(3), f.zMax.toFixed(3), f.crosses ? "yes" : ""].map(q).join(",")));
        return rows.join("\r\n") + "\r\n";
    }

    // ── Render ───────────────────────────────────────────────────────────────

    let _src = null;      // { name, extracted }
    let _out = null;      // last buildCodeFile result
    let _elev = null;     // { name, points, noZ } — survey point file for elevations

    const $ = id => document.getElementById(id);

    function renderControls() {
        const root = $("dcf-controls");
        if (!root) return;
        window.setSafeHTML(root, `
            <div style="display:flex; gap:0.75rem; flex-wrap:wrap; align-items:center;">
                <label class="btn btn-accent" for="dcf-file" style="cursor:pointer;"><i class="fa-solid fa-folder-open"></i> Open DXF…</label>
                <input type="file" id="dcf-file" accept=".dxf" style="display:none;">
                <button class="btn btn-secondary" id="dcf-sample"><i class="fa-solid fa-flask"></i> Load sample DXF</button>
                <span id="dcf-source" style="color:var(--text-muted); font-size:0.85rem;">No file loaded.</span>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:0.75rem; margin-top:1rem;">
                <div class="form-group"><label for="dcf-start-pt">Starting point number</label><input id="dcf-start-pt" type="text" inputmode="numeric" value="1"></div>
                <div class="form-group"><label for="dcf-start-fig">Starting figure (LW###)</label><input id="dcf-start-fig" type="text" inputmode="numeric" value="1"></div>
                <div class="form-group"><label for="dcf-join-tol">Join tolerance (drawing units)</label><input id="dcf-join-tol" type="text" inputmode="decimal" value="0.001"></div>
                <div class="form-group" style="display:flex; align-items:flex-end;"><label style="display:flex; gap:0.4rem; align-items:center;"><input id="dcf-join" type="checkbox" checked> Join connected LINE / ARC pieces on the same layer</label></div>
            </div>
            <div class="form-group" style="margin-top:0.25rem; max-width:34rem;">
                <label for="dcf-format">Output format</label>
                <select id="dcf-format">
                    <option value="script">Survey command script — NEZ + FIG BEGIN / FIG PT / FIG END (with comments)</option>
                    <option value="autodesk">Autodesk Field Book — BEG / NE SS / C3 / END (for Import Field Book; no comments)</option>
                </select>
            </div>
            <div style="margin-top:0.25rem;"><label style="display:flex; gap:0.4rem; align-items:center; font-size:0.85rem;"><input id="dcf-share-pts" type="checkbox"> Share one point number where vertices coincide (off: every figure has its own points — points may occupy the same spot)</label></div>
            <div style="margin-top:0.75rem; padding:0.6rem 0.75rem; border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
                <div style="display:flex; gap:0.75rem; flex-wrap:wrap; align-items:center;">
                    <label class="btn btn-secondary btn-sm" for="dcf-elev-file" style="cursor:pointer;"><i class="fa-solid fa-mountain"></i> Elevations from point file…</label>
                    <input type="file" id="dcf-elev-file" accept=".txt,.csv,.pts,.pnt" style="display:none;">
                    <button class="btn btn-secondary btn-sm" id="dcf-elev-clear">Clear</button>
                    <label for="dcf-match-tol" style="font-size:0.85rem;">Match tolerance</label>
                    <input id="dcf-match-tol" type="text" inputmode="decimal" value="0.010" style="width:6rem;">
                </div>
                <div id="dcf-elev-status" style="font-size:0.8rem; color:var(--text-muted); margin-top:0.35rem;">Optional: a P,N,E,Z,D survey point file. Each vertex / TEXT point takes the Z of the survey point on the same spot (preferring the one coded like the layer); the rest keep the DXF elevation and are reported.</div>
            </div>
            <div id="dcf-layers" style="margin-top:0.75rem;"></div>
            <div style="display:flex; gap:0.75rem; flex-wrap:wrap; margin-top:1rem;">
                <button class="btn btn-accent" id="dcf-build"><i class="fa-solid fa-gears"></i> Build code file</button>
                <button class="btn btn-secondary" id="dcf-download"><i class="fa-solid fa-download"></i> Download .fbk</button>
                <button class="btn btn-secondary" id="dcf-report"><i class="fa-solid fa-file-lines"></i> Conversion report (.txt)</button>
                <button class="btn btn-secondary" id="dcf-csv"><i class="fa-solid fa-file-csv"></i> Figure table (.csv)</button>
            </div>
            <div id="dcf-results" class="results-box hidden" style="margin-top:1rem;"></div>`);
    }

    function renderLayers() {
        const box = $("dcf-layers");
        if (!box || !_src) return;
        const counts = {};
        _src.extracted.paths.forEach(p => { counts[p.layer] = (counts[p.layer] || 0) + 1; });
        const sc = _src.extracted.scopes;
        const scopeHtml = sc.length
            ? `<div style="margin-bottom:0.75rem; padding:0.6rem 0.75rem; border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
                 <label style="display:flex; gap:0.4rem; align-items:center; font-weight:600; font-size:0.85rem;"><input id="dcf-use-scopes" type="checkbox" checked> Limit linework to the SCOPE layers</label>
                 <div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.3rem;">${sc.length} scope layer(s): ${sc.map(x => `<span style="font-family:var(--font-mono);">${clean(x.name)}</span> (${x.paths.length})`).join(", ")}. Each scope is written as its own commented block; scope layers themselves are not written as figures.</div>
               </div>`
            : `<div style="font-size:0.8rem; color:var(--text-muted); margin-bottom:0.5rem;">No SCOPE* layers in this drawing — all linework on the selected layers is written.</div>`;
        const tl = _src.extracted.textLayers;
        const tNames = Object.keys(tl).sort();
        // TEXT layers named like point layers (POINTS, PNTS…) are ticked by default; annotation layers are not.
        const textHtml = tNames.length
            ? `<label style="display:block; font-weight:600; font-size:0.85rem; margin-top:0.75rem;">TEXT → points <span style="font-weight:400; color:var(--text-muted);">(text becomes the point description)</span></label>
               <div style="display:flex; flex-wrap:wrap; gap:0.4rem 1rem; margin-top:0.35rem; font-size:0.8rem;">
                 ${tNames.map(l => `<label style="display:flex; gap:0.3rem; align-items:center;"><input type="checkbox" class="dcf-text-layer" data-layer="${clean(l)}"${/^(POINTS?|PNTS?|PTS?)([-_ ]|$)/i.test(l) ? " checked" : ""}> <span style="font-family:var(--font-mono);">${clean(l)}</span> <span style="color:var(--text-muted);">(${tl[l]})</span></label>`).join("")}
               </div>`
            : "";
        window.setSafeHTML(box, `
            ${scopeHtml}
            <label style="font-weight:600; font-size:0.85rem;">Layers with linework</label>
            <div style="display:flex; flex-wrap:wrap; gap:0.4rem 1rem; margin-top:0.35rem; font-size:0.8rem;">
              ${_src.extracted.layers.map(l => `<label style="display:flex; gap:0.3rem; align-items:center;"><input type="checkbox" class="dcf-layer" data-layer="${clean(l)}" checked> <span style="font-family:var(--font-mono);">${clean(l)}</span> <span style="color:var(--text-muted);">(${counts[l]})</span></label>`).join("")}
            </div>
            ${textHtml}`);
    }

    function load(text, name, ctx) {
        try {
            _src = { name, extracted: extractLinework(text) };
        } catch (err) {
            _src = null;
            ctx.showToast(err.message, true);
            return;
        }
        _out = null;
        const n = _src.extracted.paths.length, nt = _src.extracted.texts.length;
        window.setSafeHTML($("dcf-source"), `<strong>${clean(name)}</strong> — ${n} linework entit${n === 1 ? "y" : "ies"} on ${_src.extracted.layers.length} layer(s)${nt ? `, ${nt} TEXT` : ""}`);
        renderLayers();
        $("dcf-results")?.classList.add("hidden");
        if (n || nt) build(ctx); else ctx.showToast("No LINE / ARC / CIRCLE / POLYLINE linework or TEXT found in model space.", true);
    }

    function build(ctx) {
        const box = $("dcf-results");
        if (!_src) { ctx.showToast("Open a DXF first.", true); return; }
        const picked = sel => [...document.querySelectorAll(sel)].filter(c => c.checked).map(c => c.getAttribute("data-layer"));
        try {
            _out = buildCodeFile(_src.extracted, {
                startPoint: $("dcf-start-pt").value, startFigure: $("dcf-start-fig").value,
                join: $("dcf-join").checked, joinTol: $("dcf-join-tol").value, layers: picked("#dcf-layers .dcf-layer"),
                useScopes: !!($("dcf-use-scopes") && $("dcf-use-scopes").checked),
                sharePoints: $("dcf-share-pts").checked,
                format: $("dcf-format").value,
                textLayers: picked("#dcf-layers .dcf-text-layer"),
                elevPoints: _elev ? _elev.points : null, matchTol: $("dcf-match-tol").value
            }, { sourceName: _src.name, elevSource: _elev ? _elev.name : null });
        } catch (err) {
            _out = null;
            box.classList.remove("hidden");
            window.setSafeHTML(box, `<strong style="color:var(--danger);">${clean(err.message)}</strong>`);
            return;
        }
        const scoped = !!_out.scopes;
        const rows = _out.figures.map(f => `<tr><td style="font-family:var(--font-mono); font-weight:700;">${f.name}</td>${scoped ? `<td style="font-family:var(--font-mono);">${clean(f.scope)}${f.crosses ? ' <span style="color:var(--warning);">(runs over limit)</span>' : ""}</td>` : ""}<td style="font-family:var(--font-mono);">${clean(f.layer)}</td><td>${f.closed ? "Closed" : "Open"}${f.joined > 1 ? ` · joined ${f.joined}` : ""}</td><td>${f.seq.length}</td><td>${f.curves || "—"}</td><td style="font-family:var(--font-mono);">${f.length.toFixed(3)}</td></tr>`).join("");
        const skipped = _src.extracted.skipped;
        const notes = _out.warnings.map(w => `<div class="qc-item warning" style="margin-top:0.4rem;"><div class="qc-item-content"><p>${clean(w)}</p></div></div>`).join("")
            + (skipped.length ? `<div class="qc-item warning" style="margin-top:0.4rem;"><div class="qc-item-content"><h4>Not converted</h4><p>${skipped.map(s => `${clean(s.what)} ×${s.count} — ${clean(s.why)}`).join("<br>")}</p></div></div>` : "");
        const preview = _out.text.split("\r\n");
        window.setSafeHTML(box, `
            <h4 style="font-size:1rem; font-weight:700;"><i class="fa-solid fa-circle-check" style="color:var(--success);"></i> ${_out.figures.length} figure(s) · ${_out.points.length} point(s)${_out.points.some(p => p.kind === "text") ? ` (${_out.points.filter(p => p.kind === "text").length} from TEXT)` : ""}${scoped ? ` · ${_out.scopes.length} scope(s)` : ""}</h4>
            ${_out.elevation ? `<div style="font-size:0.8rem; margin-top:0.25rem; color:${_out.elevation.unmatched ? "var(--warning)" : "var(--success)"};">Elevations: ${_out.elevation.matched} of ${_out.elevation.total} point(s) matched to ${clean(_elev.name)} within ${_out.elevation.tol}.</div>` : ""}
            ${scoped ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:0.25rem;">${_out.scopes.map(x => `<span style="font-family:var(--font-mono);">${clean(x.name)}</span>: ${x.figures} figure(s), ${x.kind === "polygon" ? "closed boundary" : "bounding box"}`).join(" · ")}</div>` : ""}
            <div style="overflow-x:auto; margin-top:0.5rem; max-height:320px;">
              <table class="data-table" style="width:100%; font-size:0.8rem;">
                <thead><tr><th>Figure</th>${scoped ? "<th>Scope</th>" : ""}<th>Layer</th><th>Type</th><th>Points</th><th>Curves</th><th>Length</th></tr></thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
            ${notes}
            <label style="display:block; font-weight:600; font-size:0.85rem; margin-top:0.75rem;">Preview${preview.length > 150 ? " (first 150 lines — the download has everything)" : ""}</label>
            <pre style="max-height:320px; overflow:auto; font-size:0.75rem; background:var(--bg-surface); padding:0.75rem; border-radius:var(--radius-sm); border:1px solid var(--border-subtle);">${clean(preview.slice(0, 150).join("\n"))}</pre>`);
        box.classList.remove("hidden");
        ctx.showToast(`Built ${_out.figures.length} figure(s).`);
    }

    const Plugin = {
        init() { renderControls(); },
        setupEvents(ctx) {
            $("dcf-file")?.addEventListener("change", e => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = ev => load(ev.target.result, file.name, ctx);
                reader.readAsText(file);
                e.target.value = "";
            });
            $("dcf-sample")?.addEventListener("click", () => {
                fetch("example_dxfs/fdot_sr50.dxf")
                    .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
                    .then(t => load(t, "fdot_sr50.dxf (sample)", ctx))
                    .catch(err => ctx.showToast(`Could not load the sample DXF: ${err.message}`, true));
            });
            $("dcf-build")?.addEventListener("click", () => build(ctx));
            $("dcf-format")?.addEventListener("change", () => { if (_src) build(ctx); });
            $("dcf-elev-file")?.addEventListener("change", e => {
                const file = e.target.files && e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = ev => {
                    const res = parseElevationFile(ev.target.result);
                    if (!res.points.length) { ctx.showToast(`${file.name}: no points with an elevation found.`, true); return; }
                    _elev = { name: file.name, points: res.points, noZ: res.noZ };
                    window.setSafeHTML($("dcf-elev-status"), `<strong>${clean(file.name)}</strong> — ${res.points.length} point(s) with an elevation${res.noZ ? `; ${res.noZ} without one ignored` : ""}${res.bad ? `; ${res.bad} unreadable line(s)` : ""}.`);
                    if (_src) build(ctx);
                };
                reader.readAsText(file);
                e.target.value = "";
            });
            $("dcf-elev-clear")?.addEventListener("click", () => {
                _elev = null;
                window.setSafeHTML($("dcf-elev-status"), "No point file — points keep the DXF elevation.");
                if (_src) build(ctx);
            });
            // Only reachable once a drawing is loaded (the buttons guard on _out).
            const baseName = () => _src.name.replace(/\s*\(sample\)$/, "").replace(/\.dxf$/i, "") || "linework";
            $("dcf-download")?.addEventListener("click", () => {
                if (!_out) { ctx.showToast("Build the code file first.", true); return; }
                window.COGO.downloadText(`${baseName()}_LW.fbk`, _out.text, "text/plain");
                ctx.showToast("Downloaded the code file.");
            });
            $("dcf-report")?.addEventListener("click", () => {
                if (!_out) { ctx.showToast("Build the code file first.", true); return; }
                const name = `${baseName()}_LW_report.txt`;
                const report = buildReport(_out, _src.extracted, { codeFileName: `${baseName()}_LW.fbk` });
                if (window.Reports && window.Reports.addReport) {
                    window.Reports.addReport({ title: `DXF → Code File report — ${_src.name}`, type: "dxf-code-file-report", category: "dxf", format: "log", filename: name, content: report });
                }
                window.COGO.downloadText(name, report, "text/plain");
                ctx.showToast("Downloaded the conversion report and saved it to the Reports Hub.");
            });
            $("dcf-csv")?.addEventListener("click", () => {
                if (!_out) { ctx.showToast("Build the code file first.", true); return; }
                window.COGO.downloadText(`${baseName()}_LW_figures.csv`, buildFigureCsv(_out), "text/csv");
                ctx.showToast("Downloaded the figure table.");
            });
        }
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);

    window.DxfCodeFile = { figureName, readOptions, parseElevationFile, makeMatcher, bulgeArc, entityToPath, tidyPath, reversePath, joinPaths, countEntityTypes, extractLinework, buildCodeFile,
        isScopeLayer, densifyPath, inRing, buildScopeLimits, insideLimit, relateToLimit, buildReport, buildFigureCsv, surveyAccounting, makeNearest };
})();
