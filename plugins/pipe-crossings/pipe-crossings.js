/**
 * Plugin: pipe-crossings (utility crossing finder + crossing tables — no tab of its own)
 * plugins/pipe-crossings/pipe-crossings.js
 *
 * Finds where pipes cross in plan, works out each pipe's invert at the crossing (interpolated
 * between its surveyed inverts), its top, the vertical separation and the clearance check, and
 * lays out crossing tables in the JEA "Pipe Crossing Table" format for the drawing and CSV.
 *
 *   The chosen calculation (TOP_CALCS) gives how far the outside top sits above the invert and
 *   the outside bottom below it:
 *     "walls"   — (default) top = invert + inside diameter + wall, bottom = invert − wall, with the
 *                 outside diameter from the Materials size tables and published wall thicknesses
 *                 (WALLS): ductile iron at its minimum pressure class or C900 PVC DR 18 for water,
 *                 reclaimed and force main; PVC SDR 35 for gravity / vacuum sewer; RCP Wall B for
 *                 storm (nominal size = inside diameter). Sizes without a published wall fall back
 *                 to "od" and say so.
 *     "od"      — top = invert + outside diameter, bottom = invert (no wall).
 *     "nominal" — top = invert + nominal size, bottom = invert.
 *   The calculation is a setting so a client's own method can replace it.
 *   separation     = upper pipe bottom − lower pipe top. Compliant when ≥ the required separation:
 *                    where a water main is in the crossing, JEA's figure for the pair (JEA Standards
 *                    2026 §350 III.4.4–III.4.5: 6 in above / 12 in below a gravity or vacuum sewer or
 *                    storm sewer, 12 in from a force main or reclaimed main — Jea24Data.crossingRequirement);
 *                    otherwise the user's minimum (opts.minSeparation).
 *   finished grade = estimated from nearby ground shots (inverse-distance), or none.
 * A value that can't be computed (no pipe size, no invert, no ground shots) is null — reported as
 * "not scored" — never a guess. Exposes window.PipeCrossings; pure functions, no DOM.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "pipe-crossings",
        version: "1.0.0",
        description: "Finds pipe crossings, computes tops, separation and clearance, and lays out JEA-format crossing tables.",
        tab: null,
        icon: "fa-xmark",
        tier: "Pro",
        dependencies: ["materials", "tmplt-jea2024"]
    };

    // Sizing system (Materials SIZE_SYSTEMS id) for each JEA crossing pipe type.
    const SIZE_SYSTEM = { "Potable Water": "DIPS", "Reclaimed": "DIPS", "Force Main": "DIPS", "Gravity Sewer": "PVC-SEWER", "Vacuum Sewer": "PVC-SEWER", "Storm": null };

    /** Outside diameter (in) for a pipe type and nominal size, or null when there's no table entry. */
    function outsideDiameter(type, size) {
        const sysId = SIZE_SYSTEM[type];
        const sys = sysId && window.MaterialsData && window.MaterialsData.SIZE_SYSTEMS.find(x => x.id === sysId);
        const od = sys && sys.od[String(size)];
        return typeof od === "number" ? od : null;
    }

    /**
     * Published wall thicknesses (inches). Representative values for a concept check, not a design
     * — confirm against the project's pipe specification.
     */
    const WALLS = {
        "DI": {
            label: "Ductile iron, minimum pressure class (PC 350 to 12 in, PC 250 14–20 in, PC 200 24 in)",
            source: "American Cast Iron Pipe Co. (ACIPCO), Fastite Joint Pipe — Maximum Depths of Cover, nominal thickness by pressure class (AWWA C150 / C151)",
            url: "https://american-usa.com/products/ductile-iron-pipe-and-fittings/unrestrained-joint-pipe/fastite-joint-pipe/maximum-depths-of-cover",
            table: { 4: 0.25, 6: 0.25, 8: 0.25, 10: 0.26, 12: 0.28, 14: 0.28, 16: 0.30, 18: 0.31, 20: 0.33, 24: 0.33 }
        },
        "C900-DR18": {
            label: "C900 PVC, DR 18",
            source: "AWWA C900 — minimum wall = outside diameter ÷ DR (e.g. 8 in: 9.050 in OD, 0.503 in wall)",
            url: "https://www.ferguson.com/product/c900-8-in.-dr-18-gasket-pvc-pressure-pipe-dr18lok21px/4325202.html",
            ratio: 18, minSize: 4              // C900 is made from 4 in up
        },
        "PVC-SDR35": {
            label: "PVC gravity sewer, SDR 35 (ASTM D3034)",
            source: "ASTM D3034 — minimum wall = outside diameter ÷ SDR (e.g. 8 in: 8.400 in OD, 0.240 in wall). Values from the 2000 edition's table; the 8 in wall matches current SDR 35 product listings. The current edition (D3034-24e1, April 2024) wasn't checked size by size",
            url: "https://www.engineeringtoolbox.com/ASTM-D3034-PSM-PVC-pipe-d_2133.html",
            ratio: 35
        },
        "RCP-B": {
            label: "Reinforced concrete pipe, ASTM C76 Wall B",
            source: "ASTM C76 Wall B as tabulated by Iowa DOT Design Manual 1B-5 (wall in = diameter in ft + 1)",
            url: "https://iowadot.gov/design-manual/chapter-1-general-information/1b-5-pipe-thickness-tables",
            table: { 12: 2, 15: 2.25, 18: 2.5, 21: 2.75, 24: 3, 27: 3.25, 30: 3.5, 33: 3.75, 36: 4 },
            insideDiameter: true            // RCP is sized by its inside diameter
        }
    };
    // Ductile iron nominal wall by pressure class (same ACIPCO source). 4–12 in are made only in PC 350.
    const DI_CLASS = {
        350: { 4: 0.25, 6: 0.25, 8: 0.25, 10: 0.26, 12: 0.28, 14: 0.31, 16: 0.34, 18: 0.36, 20: 0.38, 24: 0.43 },
        300: { 14: 0.30, 16: 0.32, 18: 0.34, 20: 0.36, 24: 0.40 },
        250: { 14: 0.28, 16: 0.31, 18: 0.31, 20: 0.33, 24: 0.37 },
        200: { 24: 0.33 }
    };

    /**
     * A pipe material from the code list ("DI", "Ductile iron", "C900 DR14", "PVC SDR 26", "RCP"…)
     * and optional pressure class: { kind, dr?, pc?, label } or { error } when there's no wall data.
     */
    function parseMaterial(material, pclass) {
        const m = String(material || "").toUpperCase().trim();
        if (!m) return null;
        const num = re => { const x = m.match(re); return x ? +x[1] : null; };
        if (/\bDI\b|DIP|DUCTILE/.test(m)) {
            const pc = pclass != null && String(pclass).trim() !== "" ? Number(String(pclass).replace(/[^\d.]/g, "")) : null;
            if (pc != null && !DI_CLASS[pc]) return { error: `pressure class ${pclass} isn't one of ${Object.keys(DI_CLASS).join(", ")}` };
            return { kind: "DI", pc, label: pc ? `Ductile iron PC ${pc}` : "Ductile iron (minimum pressure class)" };
        }
        if (/C\s?900/.test(m)) { const dr = num(/DR\s?(\d+)/) || 18; return { kind: "C900", dr, label: `C900 PVC DR ${dr}` }; }
        if (/SDR|PSM|D3034|PVC/.test(m)) { const dr = num(/SDR\s?(\d+)/) || 35; return { kind: "PVC-SDR", dr, label: `PVC sewer SDR ${dr}` }; }
        if (/RCP|CONCRETE/.test(m)) return { kind: "RCP-B", label: "RCP Wall B" };
        return { error: `no published wall data for "${material}"` };
    }

    /** Which wall applies to a pipe type (water / reclaimed / force main follow the chosen material). */
    const wallKind = (type, waterWall) => (["Potable Water", "Reclaimed", "Force Main"].includes(type) ? (waterWall || "DI")
        : ["Gravity Sewer", "Vacuum Sewer"].includes(type) ? "PVC-SDR35" : type === "Storm" ? "RCP-B" : null);
    /** Wall thickness (in) for a pipe type and size, or null when nothing is published for it. */
    function wallThickness(type, size, waterWall, material) {
        if (!(size > 0)) return null;
        if (material && material.kind) {                       // the code list's material wins
            if (material.kind === "DI") { const tb = material.pc ? DI_CLASS[material.pc] : WALLS.DI.table; return tb && tb[size] != null ? tb[size] : null; }
            if (material.kind === "RCP-B") return WALLS["RCP-B"].table[size] != null ? WALLS["RCP-B"].table[size] : null;
            if (material.kind === "C900" && size < 4) return null;
            const od = outsideDiameter(type, size);
            return od != null ? od / material.dr : null;
        }
        const k = wallKind(type, waterWall), w = k && WALLS[k];
        if (!w) return null;
        if (w.table) return w.table[size] != null ? w.table[size] : null;
        if (w.minSize && size < w.minSize) return null;
        const od = outsideDiameter(type, size);
        return od != null ? od / w.ratio : null;
    }

    // Each calculation returns, in inches, how far the outside top is above the invert (up) and the
    // outside bottom below it (down), with a note saying where the numbers came from.
    const TOP_CALCS = {
        walls: {
            label: "Invert + inside diameter + wall (published wall thicknesses)",
            diameter(type, size, o, material) {
                if (!(size > 0)) return { up: null, down: null, note: "no pipe size" };
                const mat = material && material.kind ? material : null;
                const k = mat ? (mat.kind === "RCP-B" ? "RCP-B" : null) : wallKind(type, o && o.waterWall);
                const w = k ? WALLS[k] : null, t = wallThickness(type, size, o && o.waterWall, mat);
                const label = mat ? mat.label : w && w.label;
                if (t == null) {
                    const f = TOP_CALCS.od.diameter(type, size);
                    return Object.assign(f, { note: `${f.note}; no published wall for ${size} in ${type || "pipe"} — wall not included` });
                }
                if ((w && w.insideDiameter) || (mat && mat.kind === "RCP-B")) return { up: size + t, down: t, note: `ID ${size} in + wall ${t} in (${label})` };
                const od = outsideDiameter(type, size);
                return { up: od - t, down: t, note: `OD ${od} in, wall ${t.toFixed(3)} in (${label})` };
            }
        },
        od: {
            label: "Invert + outside diameter (no wall)",
            diameter(type, size) {
                if (!(size > 0)) return { up: null, down: null, note: "no pipe size" };
                const od = outsideDiameter(type, size);
                return od != null ? { up: od, down: 0, note: `OD ${od} in (${SIZE_SYSTEM[type]})` } : { up: size, down: 0, note: `nominal ${size} in (no OD table for ${type || "this pipe"})` };
            }
        },
        nominal: {
            label: "Invert + nominal size",
            diameter(type, size) { return size > 0 ? { up: size, down: 0, note: `nominal ${size} in` } : { up: null, down: null, note: "no pipe size" }; }
        }
    };

    /** Pipe size (inches) written on a shot: a token like 8", 8IN, 12in, 1.5". Bare numbers are figure numbers. */
    function sizeToken(desc) {
        for (const tok of String(desc || "").split(/\s+/)) {
            const m = tok.match(/^(\d{1,2}(?:\.\d+)?)(?:"|''|IN|INCH|INCHES)$/i);
            if (m) return parseFloat(m[1]);
        }
        return null;
    }

    // ── Geometry ──────────────────────────────────────────────────────────────

    /** Proper / touching intersection of segments ab and cd: { t, u, e, n } (t along ab, u along cd) or null. */
    function segX(a, b, c, d) {
        const r = { e: b.e - a.e, n: b.n - a.n }, s = { e: d.e - c.e, n: d.n - c.n };
        const den = r.e * s.n - r.n * s.e;
        if (Math.abs(den) < 1e-12) return null;                                   // parallel / collinear
        const qp = { e: c.e - a.e, n: c.n - a.n };
        const t = (qp.e * s.n - qp.n * s.e) / den, u = (qp.e * r.n - qp.n * r.e) / den;
        if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null;
        return { t, u, e: a.e + t * r.e, n: a.n + t * r.n };
    }
    const lerpZ = (a, b, t) => (isFinite(a.z) && isFinite(b.z) ? a.z + t * (b.z - a.z) : null);

    /** Finished grade at (e, n) from ground shots within radius (inverse-distance², up to 4 nearest), or null. */
    function estimateGrade(ground, e, n, radius) {
        const near = ground.filter(g => isFinite(g.z)).map(g => ({ g, d: Math.hypot(g.e - e, g.n - n) }))
            .filter(x => x.d <= radius).sort((a, b) => a.d - b.d).slice(0, 4);
        if (!near.length) return null;
        if (near[0].d < 1e-6) return near[0].g.z;
        let w = 0, s = 0;
        near.forEach(x => { const k = 1 / (x.d * x.d); w += k; s += k * x.g.z; });
        return s / w;
    }

    /**
     * Ground shots bucketed on a grid one search radius wide: fn(e, n) → the shots in the 3×3 cells around
     * (e, n), in their original order (so ties in estimateGrade resolve exactly as a full scan would).
     */
    function groundIndex(ground, radius) {
        if (!(radius > 0) || ground.length < 200) return () => ground;
        const cell = new Map(), key = (i, j) => `${i},${j}`;
        ground.forEach((g, k) => {
            if (!isFinite(g.e) || !isFinite(g.n)) return;
            const id = key(Math.floor(g.e / radius), Math.floor(g.n / radius));
            if (!cell.has(id)) cell.set(id, []);
            cell.get(id).push(k);
        });
        return (e, n) => {
            const ci = Math.floor(e / radius), cj = Math.floor(n / radius), ks = [];
            for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) (cell.get(key(ci + di, cj + dj)) || []).forEach(k => ks.push(k));
            return ks.sort((a, b) => a - b).map(k => ground[k]);
        };
    }

    /**
     * Find crossings between pipes. pipes: [{ id, type (JEA crossing type or null), size (in or null),
     * pts: [{ e, n, z = invert }] }]; ground: [{ e, n, z }]; opts: { calc, minSeparation (ft),
     * gradeRadius (ft), waterWall? ("DI" | "C900-DR18"), maxInterp? (ft — flag inverts interpolated farther
 * than this from a shot), toLonLat? (fn(e, n) → { lat, lon }) }. A pipe may carry material (parseMaterial).
     * Returns crossings sorted north → south, west → east, numbered CR-01…, each with
     *   { id, e, n, upper, lower, grade, separation, clearanceIn, compliant, notes[] }
     * where upper / lower = { pipeId, type, size, invert, top, bottom, cover, diameterNote }.
     */
    function findCrossings(pipes, ground, opts) {
        const calc = TOP_CALCS[opts.calc];
        if (!calc) throw new Error(`Unknown top-of-pipe calculation "${opts.calc}".`);
        const found = [];
        // Big jobs: skip pipe pairs whose extents can't touch, and compare a new crossing only with its own pair's.
        const box = P => P.pts.reduce((b, p) => [Math.min(b[0], p.e), Math.min(b[1], p.n), Math.max(b[2], p.e), Math.max(b[3], p.n)], [Infinity, Infinity, -Infinity, -Infinity]);
        const boxes = pipes.map(box), apart = (p, q) => p[2] < q[0] - 1e-6 || q[2] < p[0] - 1e-6 || p[3] < q[1] - 1e-6 || q[3] < p[1] - 1e-6;
        for (let i = 0; i < pipes.length; i++) for (let j = i + 1; j < pipes.length; j++) {
            if (apart(boxes[i], boxes[j])) continue;
            const A = pipes[i], B = pipes[j], mine = [];
            for (let a = 0; a + 1 < A.pts.length; a++) for (let b = 0; b + 1 < B.pts.length; b++) {
                const x = segX(A.pts[a], A.pts[a + 1], B.pts[b], B.pts[b + 1]);
                if (!x) continue;
                if (mine.some(f => Math.hypot(f.e - x.e, f.n - x.n) < 0.01)) continue;   // at a shared vertex
                const near = (p, q, tt) => Math.min(tt, 1 - tt) * Math.hypot(q.e - p.e, q.n - p.n);   // distance to the nearer shot
                const f = { pair: `${i}:${j}`, e: x.e, n: x.n, A, B, zA: lerpZ(A.pts[a], A.pts[a + 1], x.t), zB: lerpZ(B.pts[b], B.pts[b + 1], x.u),
                    spanA: near(A.pts[a], A.pts[a + 1], x.t), spanB: near(B.pts[b], B.pts[b + 1], x.u) };
                mine.push(f); found.push(f);
            }
        }
        found.sort((p, q) => (q.n - p.n) || (p.e - q.e));
        const nearGround = groundIndex(ground, opts.gradeRadius);
        return found.map((f, k) => {
            const side = (pipe, inv, span) => {
                const dia = calc.diameter(pipe.type, pipe.size, opts, pipe.material);
                const ok = inv != null && dia.up != null;
                return { pipeId: pipe.id, type: pipe.type, size: pipe.size, invert: inv, top: ok ? inv + dia.up / 12 : null, bottom: ok ? inv - dia.down / 12 : null, diameterNote: dia.note, fromShot: span };
            };
            let u = side(f.A, f.zA, f.spanA), l = side(f.B, f.zB, f.spanB);
            if (u.invert != null && l.invert != null && l.invert > u.invert) [u, l] = [l, u];
            const grade = estimateGrade(nearGround(f.e, f.n), f.e, f.n, opts.gradeRadius);
            u.cover = grade != null && u.top != null ? grade - u.top : null;
            l.cover = grade != null && l.top != null ? grade - l.top : null;
            const separation = u.bottom != null && l.top != null ? u.bottom - l.top : null;
            const notes = [];
            if (u.invert == null || l.invert == null) notes.push("no invert on one pipe");
            if (u.top == null || l.top == null) notes.push("no pipe size on one pipe");
            if (grade == null) notes.push(`no ground shots within ${opts.gradeRadius} ft`);
            if (!u.type || !l.type) notes.push("a pipe type isn't on JEA's crossing list");
            const far = [u, l].filter(sd => opts.maxInterp > 0 && sd.fromShot > opts.maxInterp);
            far.forEach(sd => notes.push(`${sd.pipeId} invert interpolated ${sd.fromShot.toFixed(0)} ft from the nearest shot`));
            const ll = opts.toLonLat ? opts.toLonLat(f.e, f.n) : null;
            const rule = window.Jea24Data && window.Jea24Data.crossingRequirement ? window.Jea24Data.crossingRequirement(u.type, l.type) : null;
            let requiredFt, basis;
            if (rule && rule.applies) { requiredFt = rule.minInches / 12; basis = `JEA §350 ${rule.rule}`; }
            else { requiredFt = opts.minSeparation; basis = "your minimum"; if (rule && u.type && l.type) notes.push(`${rule.reason}; your minimum used`); }
            return {
                id: `CR-${String(k + 1).padStart(2, "0")}`, e: f.e, n: f.n, lat: ll ? ll.lat : null, lon: ll ? ll.lon : null,
                upper: u, lower: l, grade, separation, clearanceIn: separation != null ? separation * 12 : null, interpolatedFar: far.length > 0,
                requiredFt, basis,
                compliant: separation != null && requiredFt != null && isFinite(requiredFt) ? separation >= requiredFt - 1e-9 : null, notes
            };
        });
    }

    // ── JEA table ─────────────────────────────────────────────────────────────

    const n2 = v => (v == null || !isFinite(v) ? "" : v.toFixed(2));
    /** JEA "Pipe Crossing Table" columns (from the JEA template data, in its order; spacing tidied). */
    function columns() {
        const rules = window.Jea24Data && window.Jea24Data.RULES["Pipe Crossing Table"];
        if (!rules) throw new Error("The JEA template data isn't loaded.");
        return rules.map(c => c.column.replace(/\s+/g, " ").trim());
    }
    /** Value for a JEA column (matched by meaning, so a re-ordered or re-worded list still fills). */
    function cell(col, c) {
        const k = col.toLowerCase(), side = /upper/.test(k) ? c.upper : /lower/.test(k) ? c.lower : null;
        if (/crossing number/.test(k)) return c.id;
        if (side && /type/.test(k)) return side.type || "";
        if (side && /size/.test(k)) return side.size == null ? "" : String(side.size);
        if (side && /top elevation/.test(k)) return n2(side.top);
        if (side && /bottom elevation/.test(k)) return n2(side.bottom);
        if (side && /cover/.test(k)) return n2(side.cover);
        if (/finished grade/.test(k)) return n2(c.grade);
        if (/separation/.test(k)) return n2(c.separation);
        if (/x coord|easting/.test(k)) return c.e.toFixed(2);
        if (/y coord|northing/.test(k)) return c.n.toFixed(2);
        if (/latitude/.test(k)) return c.lat == null ? "" : c.lat.toFixed(6);
        if (/longitude/.test(k)) return c.lon == null ? "" : c.lon.toFixed(6);
        return "";
    }
    /** Rows for a table: [[column, value…]] — JEA columns plus the clearance check. */
    function tableRows(crossings) {
        return columns().map(col => [col].concat(crossings.map(c => cell(col, c))))
            .concat([["Clearance (Inches)"].concat(crossings.map(c => c.clearanceIn == null ? "" : c.clearanceIn.toFixed(1))),
                ["Required Separation (Inches)"].concat(crossings.map(c => c.requiredFt == null ? "" : `${(c.requiredFt * 12).toFixed(0)} (${c.basis})`)),
                ["Meets Minimum Separation"].concat(crossings.map(c => c.compliant == null ? "NOT SCORED" : c.compliant ? "YES" : "NO"))]);
    }
    /** CSV in the JEA column order (one crossing per row) + clearance and compliance. */
    function toCsv(crossings) {
        const cols = columns().concat(["Clearance (Inches)", "Required Separation (Inches)", "Meets Minimum Separation", "Notes"]);
        const q = v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
        return [cols.map(q).join(",")].concat(crossings.map(c => cols.map(col =>
            q(col === "Clearance (Inches)" ? (c.clearanceIn == null ? "" : c.clearanceIn.toFixed(1)) : col === "Required Separation (Inches)" ? (c.requiredFt == null ? "" : `${(c.requiredFt * 12).toFixed(0)} (${c.basis})`) : col === "Meets Minimum Separation" ? (c.compliant == null ? "NOT SCORED" : c.compliant ? "YES" : "NO") : col === "Notes" ? c.notes.join("; ") : cell(col, c))
        ).join(","))).join("\r\n") + "\r\n";
    }

    /**
     * Drawing geometry for one box: its rectangle, a marker and label at each crossing inside, and a
     * crossing table (fields down, crossings across) to the right of the box.
     * Returns { polylines, lines, texts, markers: [{ crossing, e, n }] } in plan coordinates.
     */
    function boxDrawing(box, crossings, layer, th) {
        const inside = crossings.filter(c => c.e >= box.e0 && c.e <= box.e1 && c.n >= box.n0 && c.n <= box.n1);
        const polylines = [{ layer, closed: true, points: [{ e: box.e0, n: box.n0 }, { e: box.e1, n: box.n0 }, { e: box.e1, n: box.n1 }, { e: box.e0, n: box.n1 }] }];
        const texts = inside.map(c => ({ layer, e: c.e + th * 0.6, n: c.n + th * 0.6, height: th, value: c.id }));
        const lines = [];
        if (!inside.length) return { polylines, lines, texts, markers: [] };
        const rows = [["Crossing"].concat(inside.map(c => c.id))].concat(tableRows(inside).slice(1));
        const cw = th * 0.62, pad = th * 0.5, rh = th * 1.7;
        const widths = rows[0].map((_, ci) => Math.max(...rows.map(r => String(r[ci]).length)) * cw + 2 * pad);
        const x0 = box.e1 + th * 3, y0 = box.n1, W = widths.reduce((a, b) => a + b, 0), Hh = rows.length * rh;
        for (let r = 0; r <= rows.length; r++) lines.push({ layer, a: { e: x0, n: y0 - r * rh }, b: { e: x0 + W, n: y0 - r * rh } });
        let x = x0;
        for (let ci = 0; ci <= widths.length; ci++) { lines.push({ layer, a: { e: x, n: y0 }, b: { e: x, n: y0 - Hh } }); x += widths[ci] || 0; }
        rows.forEach((row, r) => {
            let cx = x0;
            row.forEach((v, ci) => { if (v !== "") texts.push({ layer, e: cx + pad, n: y0 - r * rh - rh * 0.68, height: th, value: String(v) }); cx += widths[ci]; });
        });
        texts.push({ layer, e: x0, n: y0 + th * 0.8, height: th * 1.2, value: "PIPE CROSSING TABLE" });
        return { polylines, lines, texts, markers: inside.map(c => ({ crossing: c, e: c.e, n: c.n })) };
    }

    /** Attribute values for a JEA_CROSSING-style symbol (tags from the JEA template). */
    function crossingAttribs(c) {
        return {
            CROSS_NO: c.id, UPPER_TYPE: c.upper.type || "", UPPER_SIZE: c.upper.size == null ? "" : String(c.upper.size),
            UPPER_BOT_ELEV: n2(c.upper.bottom), LOWER_TYPE: c.lower.type || "", LOWER_SIZE: c.lower.size == null ? "" : String(c.lower.size),
            LOWER_TOP_ELEV: n2(c.lower.top), CLEARANCE_INCHES: c.clearanceIn == null ? "" : c.clearanceIn.toFixed(1),
            COMPLIANT: c.compliant == null ? "NOT SCORED" : c.compliant ? "YES" : "NO"
        };
    }

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, { init() {} });

    window.PipeCrossings = { SIZE_SYSTEM, WALLS, DI_CLASS, TOP_CALCS, parseMaterial, wallThickness, outsideDiameter, sizeToken, segX, estimateGrade, findCrossings, columns, cell, tableRows, toCsv, boxDrawing, crossingAttribs };
})();
