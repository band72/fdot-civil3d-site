/**
 * Plugin: legal-desc (Legal Description QC)
 * plugins/legal-desc/legal-desc.js
 *
 * Ported from the BoundaryQC desktop app (Services/Writer/CallExtractor.cs +
 * LegalDescriptionQc.cs + TraverseGeometryEngine.cs). Parses a narrative
 * metes-and-bounds legal description into line/curve calls, runs a chord-trace
 * closure, computes Shoelace area, applies QC rules, and exports a P,N,E,Z,D
 * coordinate file plus a Map Check Report.
 *
 * Registers via window.PluginRegistry. Depends on core/cogo.js (window.COGO).
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "legal-desc",
        version: "1.0.0",
        description: "Narrative metes-and-bounds legal description parser, closure + Shoelace area, QC rules, and PNEZD / Map Check export.",
        tab: "tab-legal-desc",
        icon: "fa-file-lines",
        tier: "Pro",
        dependencies: ["security-pki"]
    };

    // Default QC threshold for the description's mathematical closure. This is a firm/client
    // preference, NOT a statutory number: current Fla. Admin. Code 5J-17.051 premises accuracy
    // on the type and expected use of the survey rather than one fixed closure ratio. Set the
    // value per client in the master template ("precisionPass").
    const PRECISION_PASS_DEFAULT = 10000;
    // Threshold comes from the active client master template when one is set.
    function PRECISION_PASS_() {
        const v = window.BoundaryQCCMS && window.BoundaryQCCMS.getActiveTemplateSetting
            ? window.BoundaryQCCMS.getActiveTemplateSetting("precisionPass", PRECISION_PASS_DEFAULT)
            : PRECISION_PASS_DEFAULT;
        return Number(v) || PRECISION_PASS_DEFAULT;
    }
    let _last = null;             // last parse result, for the export buttons

    // ── Parsing ──────────────────────────────────────────────────────────────

    const SEGMENT_SPLIT = /(?=\b(?:THENCE|COMMENC(?:E|ING)|BEGINNING\s+AT|POINT\s+OF\s+BEGINNING)\b)/i;
    const DIST_RX = /(?:distance\s+of\s+|run\s+|for\s+)?([\d,]+(?:\.\d+)?)\s*(?:feet|foot|ft\b|')/i;
    const RADIUS_RX = /radius\s+of\s+([\d,]+(?:\.\d+)?)\s*(?:feet|foot|ft\b|')/i;
    const ARC_RX = /arc\s+(?:length\s+|distance\s+)?(?:of\s+)?([\d,]+(?:\.\d+)?)\s*(?:feet|foot|ft\b|')/i;
    const CHORD_DIST_RX = /chord\s+(?:distance|length)\s+(?:of\s+)?([\d,]+(?:\.\d+)?)\s*(?:feet|foot|ft\b|')/i;
    // Grab the whole chord-bearing phrase up to a delimiter; parseBearing pulls the DMS out.
    const CHORD_BRG_RX = /chord\s+bearing\s+(?:of\s+)?([^,;\n]+?)(?=,|;|\n|\bchord\s+(?:distance|length)\b|$)/i;
    const CONCAVE_RX = /concave\s+(?:to\s+the\s+)?([A-Za-z]+(?:erly)?)/i;
    // "a curve to the left/right", "curving to the right", "non-tangent curve concave … to the left"
    const TURN_RX = /\b(?:curve|curving)\b[^;]{0,60}?\bto\s+the\s+(left|right)\b/i;
    const DELTA_RX = /(?:central\s+angle|delta)\s+(?:of\s+)?(\d{1,3})\s*[^\d\s]?\s*(\d{1,2})?\s*['’′]?\s*(\d{1,2}(?:\.\d+)?)?/i;
    const NUM = s => parseFloat(String(s).replace(/,/g, ""));

    function classify(text) {
        const t = text.toUpperCase();
        if (/SECTION\s+\d+.*TOWNSHIP|T\.?\s*\d+\s*[NS].*R\.?\s*\d+\s*[EW]/.test(t) &&
            !/\d+\s*°|\d+\s+DEGREES/.test(t)) {
            return "SECTION_BREAKDOWN";
        }
        return "METES_AND_BOUNDS";
    }

    function parse(text) {
        const calls = [];
        const issues = [];
        const cls = classify(text);
        if (cls === "SECTION_BREAKDOWN") {
            issues.push({ sev: "WARNING", code: "LOOKS_LIKE_PLSS",
                msg: "This reads like a PLSS section-breakdown (aliquot parts), not metes-and-bounds. Use the PLSS Section Breakdown tab." });
        }

        const segs = text.split(SEGMENT_SPLIT).map(s => s.trim()).filter(s => s.length > 4);
        let li = 0, ci = 0;

        for (const seg of segs) {
            const hasCurve = RADIUS_RX.test(seg) || /\barc\b/i.test(seg) || /\bchord\b/i.test(seg);
            if (hasCurve) {
                const radius = RADIUS_RX.test(seg) ? NUM(seg.match(RADIUS_RX)[1]) : 0;
                const arc = ARC_RX.test(seg) ? NUM(seg.match(ARC_RX)[1]) : 0;
                let chordDist = CHORD_DIST_RX.test(seg) ? NUM(seg.match(CHORD_DIST_RX)[1]) : 0;
                const chordBrgTxt = CHORD_BRG_RX.test(seg) ? seg.match(CHORD_BRG_RX)[1].trim() : "";
                const concavity = CONCAVE_RX.test(seg) ? seg.match(CONCAVE_RX)[1] : "";
                let deltaDeg = 0;
                const dm = seg.match(DELTA_RX);
                if (dm) deltaDeg = (+dm[1]) + (+(dm[2] || 0)) / 60 + (+(dm[3] || 0)) / 3600;

                let backSolved = false;
                if (chordDist <= 0 && radius > 0 && arc > 0) {
                    chordDist = window.COGO.chordFromArc(radius, arc);
                    backSolved = true;
                }
                if (deltaDeg <= 0 && radius > 0 && arc > 0) deltaDeg = window.COGO.deltaDegFromArc(radius, arc);

                const brg = window.COGO.parseBearing(chordBrgTxt);
                // Turn direction drives the arc-to-chord area: stated "to the left/right" wins,
                // otherwise infer it from the concavity and the chord bearing.
                const turn = seg.match(TURN_RX);
                const direction = turn
                    ? (turn[1].toLowerCase() === "left" ? "L" : "R")
                    : window.COGO.directionFromConcavity(concavity, brg ? brg.azimuthDeg : null);
                ci++;
                calls.push({
                    kind: "curve", label: `C${ci}`,
                    radius, arc, chordDist, deltaDeg, concavity, direction,
                    chordAzimuthDeg: brg ? brg.azimuthDeg : null,
                    chordBearingText: brg ? window.COGO.azimuthToBearing(brg.azimuthDeg) : (chordBrgTxt || "(missing)"),
                    backSolved, raw: seg
                });
                continue;
            }

            const brg = window.COGO.parseBearing(seg);
            const dm = seg.match(DIST_RX);
            if (brg && dm) {
                li++;
                calls.push({
                    kind: "line", label: `L${li}`,
                    bearingText: window.COGO.azimuthToBearing(brg.azimuthDeg),
                    azimuthDeg: brg.azimuthDeg,
                    distance: NUM(dm[1]),
                    raw: seg
                });
            }
        }
        return { calls, issues, classification: cls, rawText: text };
    }

    // ── QC (ported from LegalDescriptionQc.Check) ────────────────────────────

    // ── FDOT right of way descriptions (opt-in) ─────────────────────────────
    // From the FDOT Surveying and Mapping Handbook, February 28, 2025 edition:
    //   §31.6.2 Area — "Areas are shown in all legal descriptions in square feet or acres, usually not
    //     both … Areas of a half-acre or more should be shown in acres, to 3 decimal places. Areas less
    //     than a half-acre should be shown in square feet, to the nearest foot … Areas, both acres and
    //     square feet, should be followed by more or less."
    //   §31.4 Parcel numbers — 1–99 reserved, 100–699 fee, 700–799 temporary easements, 800–899
    //     perpetual easements, 900–999 license agreements; a series past its range adds 1000.
    // Only for FDOT right of way parcels — a private boundary description has no such rule.
    const FDOT_HANDBOOK = "FDOT Surveying and Mapping Handbook (Feb 28, 2025)";
    const HALF_ACRE_SF = 21780;

    /** Stated areas: "CONTAINING 0.512 ACRES, MORE OR LESS" → [{ value, unit: "ac"|"sf", decimals, mol, text }]. */
    function statedAreas(text) {
        const out = [];
        const re = /\b(?:CONTAINING|CONTAINS|COMPRISING|HAVING\s+AN\s+AREA\s+OF|AREA\s+OF|TOTAL(?:\s+AREA)?\s+OF)\s+(?:APPROXIMATELY\s+)?([\d,]+(?:\.(\d+))?)\s*(SQUARE\s+FEET|SQ\.?\s*FT\.?|S\.F\.|SF\b|ACRES?|AC\.?)([^.;]{0,30})/gi;
        let m;
        while ((m = re.exec(text))) {
            const unit = /^AC/i.test(m[3]) ? "ac" : "sf";
            out.push({ value: Number(m[1].replace(/,/g, "")), unit, decimals: m[2] ? m[2].length : 0,
                mol: /MORE\s+OR\s+LESS|\bM\.?O\.?L\.?\b|±|\+\/-/i.test(m[4]), text: m[0].replace(/\s+/g, " ").trim() });
            // the same area restated in the other unit: "… ACRES, MORE OR LESS, OR 26,136 SQUARE FEET"
            const alt = /^[^.;]{0,40}?\b(?:OR|AND)\s*\(?\s*([\d,]+(?:\.(\d+))?)\s*(SQUARE\s+FEET|SQ\.?\s*FT\.?|S\.F\.|SF\b|ACRES?|AC\.?)([^.;]{0,30})/i.exec(text.slice(m.index + m[0].length - m[4].length));
            if (alt) {
                out.push({ value: Number(alt[1].replace(/,/g, "")), unit: /^AC/i.test(alt[3]) ? "ac" : "sf", decimals: alt[2] ? alt[2].length : 0,
                    mol: /MORE\s+OR\s+LESS|\bM\.?O\.?L\.?\b|±|\+\/-/i.test(alt[4]), text: alt[0].replace(/^[^\d]*?(?=[\d])/, "").replace(/\s+/g, " ").trim() });
            }
        }
        return out;
    }

    /** Parcel series a number belongs to (§31.4), or null for 1–99 (reserved). */
    function parcelSeries(n) {
        const r = n % 1000;
        if (r >= 100 && r <= 699) return "fee";
        if (r >= 700 && r <= 799) return "temporary easement";
        if (r >= 800 && r <= 899) return "perpetual easement";
        if (r >= 900 && r <= 999) return "license agreement";
        return null;
    }

    function fdotChecks(parsed, traverse) {
        const issues = [];
        const src = `(${FDOT_HANDBOOK} §31.6.2)`;
        const areas = statedAreas(parsed.rawText);
        if (!areas.length) {
            issues.push({ sev: "WARNING", code: "FDOT_AREA_MISSING", msg: `No stated area found ("CONTAINING … ACRES/SQUARE FEET, MORE OR LESS") — FDOT descriptions show the area ${src}.` });
        }
        const units = new Set(areas.map(a => a.unit));
        if (units.size > 1 && areas.length === 2) {
            issues.push({ sev: "WARNING", code: "FDOT_AREA_BOTH_UNITS", msg: `The area is stated in both acres and square feet; FDOT shows one, "usually not both" ${src}.` });
        }
        areas.forEach(a => {
            const sf = a.unit === "ac" ? a.value * 43560 : a.value;
            if (a.unit === "ac" && sf < HALF_ACRE_SF) issues.push({ sev: "WARNING", code: "FDOT_AREA_UNIT", msg: `"${a.text}": under half an acre should be stated in square feet, to the nearest foot ${src}.` });
            if (a.unit === "sf" && sf >= HALF_ACRE_SF && units.size === 1) issues.push({ sev: "WARNING", code: "FDOT_AREA_UNIT", msg: `"${a.text}": half an acre or more should be stated in acres, to 3 decimal places ${src}.` });
            if (a.unit === "ac" && a.decimals !== 3) issues.push({ sev: "WARNING", code: "FDOT_AREA_DECIMALS", msg: `"${a.text}": acres should be given to 3 decimal places ${src}.` });
            if (a.unit === "sf" && a.decimals > 0) issues.push({ sev: "WARNING", code: "FDOT_AREA_DECIMALS", msg: `"${a.text}": square feet should be given to the nearest foot ${src}.` });
            if (!a.mol) issues.push({ sev: "WARNING", code: "FDOT_AREA_MOL", msg: `"${a.text}": the area should be followed by "more or less" ${src}.` });
        });
        // Stated vs computed — only when the computed area is the parcel's (one area stated, no
        // exception subtracted, every curve's side known).
        if (traverse && areas.length === 1 && !/\b(LESS|SAVE)\s+AND\s+EXCEPT\b/i.test(parsed.rawText) && !traverse.curvesWithoutDirection && traverse.areaSqFt > 0) {
            const a = areas[0], stated = a.unit === "ac" ? a.value * 43560 : a.value;
            // the stated figure is rounded: 0.0005 ac (≈22 sf) for 3-decimal acres, 0.5 sf for whole feet
            const tol = a.unit === "ac" ? 0.5 * Math.pow(10, -a.decimals) * 43560 : 0.5 * Math.pow(10, -a.decimals);
            const diff = traverse.areaSqFt - stated;
            if (Math.abs(diff) > tol + 1e-6) {
                issues.push({ sev: "WARNING", code: "FDOT_AREA_MISMATCH", msg: `Stated area ${a.text.replace(/^\S+\s+/, "")} differs from the computed ${traverse.areaSqFt.toFixed(0)} sq ft (${traverse.areaAcres.toFixed(3)} ac) by ${diff.toFixed(0)} sq ft — more than the stated figure's rounding.` });
            }
        }
        // Parcel numbers (§31.4)
        const pRe = /\bPARCEL\s+(?:NO\.?\s*|NUMBER\s+|#\s*)?(\d{1,4})\b/gi;
        let m;
        const seen = new Set();
        while ((m = pRe.exec(parsed.rawText))) {
            const n = Number(m[1]);
            if (seen.has(n)) continue;
            seen.add(n);
            const series = parcelSeries(n);
            const kind = /TEMPORARY\s+(?:CONSTRUCTION\s+)?EASEMENT/i.test(parsed.rawText) ? "temporary easement"
                : /PERPETUAL\s+EASEMENT|\bEASEMENT\b/i.test(parsed.rawText) ? "perpetual easement"
                : /\bLICENSE\b/i.test(parsed.rawText) ? "license agreement" : null;
            if (!series) issues.push({ sev: "WARNING", code: "FDOT_PARCEL_RESERVED", msg: `Parcel ${n} is in the reserved series 1–99 (${FDOT_HANDBOOK} §31.4).` });
            else if (kind && series !== kind) issues.push({ sev: "WARNING", code: "FDOT_PARCEL_SERIES", msg: `Parcel ${n} is a ${series} number, but the description reads as a ${kind} (${FDOT_HANDBOOK} §31.4: 100–699 fee, 700–799 temporary, 800–899 perpetual easements, 900–999 licenses).` });
        }
        return issues;
    }

    function qc(parsed, traverse, opts) {
        const issues = [...parsed.issues];
        if (opts && opts.fdot) fdotChecks(parsed, traverse).forEach(i => issues.push(i));
        const geomCalls = parsed.calls.length;

        if (geomCalls < 3) {
            issues.push({ sev: "ERROR", code: "TOO_FEW_CALLS",
                msg: "A closed parcel generally requires at least three boundary calls." });
        }

        parsed.calls.forEach(c => {
            if (c.kind === "line" && !(c.distance > 0)) {
                issues.push({ sev: "ERROR", code: "BAD_LINE_DISTANCE", msg: `${c.label}: line distance must be greater than zero.` });
            }
            if (c.kind === "curve") {
                if (!(c.radius > 0)) issues.push({ sev: "ERROR", code: "BAD_CURVE_RADIUS", msg: `${c.label}: curve radius must be greater than zero.` });
                if (!(c.arc > 0)) issues.push({ sev: "ERROR", code: "BAD_CURVE_ARC", msg: `${c.label}: curve arc length must be greater than zero.` });
                if (!(c.chordDist > 0)) issues.push({ sev: "ERROR", code: "UNRESOLVED_CURVE", msg: `${c.label}: missing chord distance and could not be back-solved.` });
                if (c.chordAzimuthDeg == null) issues.push({ sev: "WARNING", code: "MISSING_CHORD_BEARING", msg: `${c.label}: chord bearing could not be parsed.` });
                if (c.radius > 0 && c.arc > 0 && c.chordDist > 0) {
                    const expected = window.COGO.chordFromArc(c.radius, c.arc);
                    const diff = Math.abs(expected - c.chordDist);
                    if (diff > 0.1) {
                        issues.push({ sev: "ERROR", code: "CURVE_GEOMETRY_INCONSISTENT",
                            msg: `${c.label}: R/Arc/Chord inconsistent — computed chord ≈ ${expected.toFixed(3)} ft vs stated ${c.chordDist.toFixed(3)} ft (Δ ${diff.toFixed(3)} ft). Check for swapped Radius/Arc or wrong Delta units.` });
                    }
                }
            }
        });

        if (/\b(LESS|SAVE)\s+AND\s+EXCEPT\b/i.test(parsed.rawText)) {
            issues.push({ sev: "WARNING", code: "EXCLUSION_NOT_SUBTRACTED",
                msg: "Description contains an exception (LESS AND EXCEPT). Computed acreage is the GROSS area and does not subtract the excepted tract." });
        }
        if (/encroachment/i.test(parsed.rawText)) {
            issues.push({ sev: "WARNING", code: "LEGAL_CONCLUSION_LANGUAGE",
                msg: "Avoid legal-conclusion language such as 'encroachment'; use observed-condition wording." });
        }

        if (traverse && geomCalls >= 3) {
            if (traverse.misclosure > 0.02) {
                issues.push({ sev: "ERROR", code: "CLOSURE_FAIL",
                    msg: `Boundary does not close: misclosure ${traverse.misclosure.toFixed(3)} ft.` });
            } else if (traverse.precisionDenominator !== Infinity && traverse.precisionDenominator < PRECISION_PASS_()) {
                issues.push({ sev: "WARNING", code: "PRECISION_WARNING",
                    msg: `Closure precision 1:${Math.round(traverse.precisionDenominator).toLocaleString()} is below the configured QC threshold of 1:${PRECISION_PASS_().toLocaleString()} (a client/firm setting — Rule 5J-17 sets no single fixed ratio).` });
            }
            if (traverse.curvesWithoutDirection > 0) {
                issues.push({ sev: "WARNING", code: "CURVE_AREA_EXCLUDED",
                    msg: `${traverse.curvesWithoutDirection} curve(s) have no stated turn direction (left/right or a concavity), so the area between their arc and chord is NOT included — acreage is chord-only for those curves.` });
            }
            const bt = window.COGO.selfIntersects(traverse.vertices.slice(0, -1));
            if (bt) issues.push({ sev: "ERROR", code: "SELF_INTERSECTION",
                msg: `Plotted boundary self-intersects: call ${bt.i} crosses call ${bt.j}.` });
        }
        return issues;
    }

    // ── Report ──────────────────────────────────────────────────────────────

    function mapCheckReport(parsed, traverse, issues) {
        const L = [];
        L.push("=== BoundaryQC Map Check Report — Legal Description ===");
        L.push(`Generated: ${new Date().toISOString()}`);
        L.push(`Classification: ${parsed.classification}`);
        L.push("");
        L.push("[QA: Parsed Calls]");
        parsed.calls.forEach(c => {
            if (c.kind === "line") L.push(`  ${c.label}  ${c.bearingText}  ${c.distance.toFixed(2)} ft`);
            else L.push(`  ${c.label}  R=${c.radius.toFixed(2)}  Arc=${c.arc.toFixed(2)}  Chord=${c.chordDist.toFixed(2)} ${c.chordBearingText}  Δ=${c.deltaDeg.toFixed(4)}°${c.backSolved ? "  [chord back-solved]" : ""}`);
        });
        L.push("");
        L.push("[QA: Mathematical Closure & Area]");
        if (traverse) {
            L.push(`  Raw linear misclosure: ${traverse.misclosure.toFixed(3)} ft  (ΔE ${(traverse.vertices[0].e - traverse.vertices[traverse.vertices.length-1].e).toFixed(3)}, ΔN ${(traverse.vertices[0].n - traverse.vertices[traverse.vertices.length-1].n).toFixed(3)})`);
            L.push(`  Precision ratio: ${traverse.precisionDenominator === Infinity ? "exact" : "1 : " + Math.round(traverse.precisionDenominator).toLocaleString()}`);
            L.push(`  Perimeter: ${traverse.perimeter.toFixed(2)} ft`);
            L.push(`  Computed area: ${traverse.areaSqFt.toFixed(2)} sq ft = ${traverse.areaAcres.toFixed(4)} acres`);
            L.push(`    (chord polygon ${traverse.chordAreaSqFt.toFixed(2)} sq ft ± curve segments ${traverse.curveSegmentAreaSqFt.toFixed(2)} sq ft` +
                   `${traverse.curvesWithoutDirection ? `; ${traverse.curvesWithoutDirection} curve(s) without direction NOT included` : ""})`);
            L.push(`  Status: ${traverse.misclosure <= 0.02 && (traverse.precisionDenominator === Infinity || traverse.precisionDenominator >= PRECISION_PASS_()) ? "[PASS]" : "[FAIL/WARNING]"}`);
        } else {
            L.push("  Not enough parsable geometry to compute closure.");
        }
        L.push("");
        L.push("[QA: Issues]");
        if (!issues.length) L.push("  (none)");
        issues.forEach(i => L.push(`  [${i.sev}] ${i.code}: ${i.msg}`));
        L.push("");
        L.push("[Coordinate File — P,N,E,Z,D]");
        if (traverse) L.push(window.COGO.pnezd(traverse.vertices.slice(0, -1)));
        return L.join("\r\n");
    }

    // ── Plot geometry (pure — coordinates only, no DOM) ─────────────────────

    /**
     * True circular arc between chord endpoints a→b. `direction` is the turn
     * ("L"/"R"); the arc bulges to the opposite side of the chord from its
     * centre. Returns { ok:false, reason } when the arc can't be drawn honestly
     * (no turn direction, or a chord longer than the diameter) so the caller
     * draws the chord and says why instead of inventing a curve.
     */
    function arcGeometry(a, b, radius, arcLength, direction) {
        if (direction !== "L" && direction !== "R") return { ok: false, reason: "no turn direction stated" };
        const dE = b.e - a.e, dN = b.n - a.n;
        const c = Math.hypot(dE, dN);
        if (!(radius > 0) || !(c > 0)) return { ok: false, reason: "radius or chord is zero" };
        if (c > 2 * radius + 1e-6) return { ok: false, reason: "chord is longer than the curve's diameter" };
        const ux = dE / c, uy = dN / c;
        // Unit vector toward the turn side (right of travel for "R").
        const s = direction === "R" ? { e: uy, n: -ux } : { e: -uy, n: ux };
        const largeArc = arcLength > 0 ? arcLength > Math.PI * radius + 1e-9 : false;
        const h = Math.sqrt(Math.max(0, radius * radius - (c / 2) * (c / 2)));
        const k = largeArc ? -h : h;
        const m = { e: (a.e + b.e) / 2, n: (a.n + b.n) / 2 };
        const center = { e: m.e + s.e * k, n: m.n + s.n * k };
        const mid = { e: center.e - s.e * radius, n: center.n - s.n * radius };
        // Sweep from a to b about the centre: right turn = clockwise (negative in E/N).
        const a0 = Math.atan2(a.n - center.n, a.e - center.e);
        let sweepRad = Math.atan2(b.n - center.n, b.e - center.e) - a0;
        if (direction === "R") { while (sweepRad > 0) sweepRad -= 2 * Math.PI; } else { while (sweepRad < 0) sweepRad += 2 * Math.PI; }
        return { ok: true, center, radius, mid, largeArc, startAngle: a0, sweepRad };
    }

    /**
     * Drawing model for the deed linework, built from the traverse that the
     * closure/area already use (so the picture and the numbers agree).
     * Plan coordinates (E, N), POB at 0,0. Returns null without resolved geometry.
     */
    function plotGeometry(parsed, traverse) {
        if (!parsed || !traverse || !traverse.vertices || traverse.vertices.length !== parsed.calls.length + 1) return null;
        const V = traverse.vertices;
        const ring = traverse.closes ? V.slice(0, -1) : V;
        // CCW ring (positive area) → outside is to the right of travel.
        const ccw = window.COGO.signedShoelaceArea(ring) >= 0;
        const crossing = ring.length >= 3 ? window.COGO.selfIntersects(ring) : null;

        const box = { minE: Infinity, minN: Infinity, maxE: -Infinity, maxN: -Infinity };
        const grow = p => {
            if (p.e < box.minE) box.minE = p.e; if (p.e > box.maxE) box.maxE = p.e;
            if (p.n < box.minN) box.minN = p.n; if (p.n > box.maxN) box.maxN = p.n;
        };
        V.forEach(grow);

        const segments = parsed.calls.map((c, i) => {
            const from = V[i], to = V[i + 1];
            const len = Math.hypot(to.e - from.e, to.n - from.n) || 1;
            const ux = (to.e - from.e) / len, uy = (to.n - from.n) / len;
            const seg = {
                index: i, label: c.label, kind: c.kind, from, to,
                azimuthDeg: c.kind === "line" ? c.azimuthDeg : c.chordAzimuthDeg,
                outward: ccw ? { e: uy, n: -ux } : { e: -uy, n: ux },
                mid: { e: (from.e + to.e) / 2, n: (from.n + to.n) / 2 },
                crossing: !!crossing && (i + 1 === crossing.i || i + 1 === crossing.j),
                text: c.kind === "line"
                    ? `${c.label}  ${c.bearingText}  ${c.distance.toFixed(2)}'`
                    : `${c.label}  R=${c.radius.toFixed(2)}'  L=${c.arc.toFixed(2)}'  CB ${c.chordBearingText}  CH=${c.chordDist.toFixed(2)}'`
            };
            if (c.kind === "curve") {
                const arc = arcGeometry(from, to, c.radius, c.arc, c.direction);
                if (arc.ok) {
                    seg.arc = arc;
                    seg.mid = arc.mid;
                    for (let k = 1; k < 16; k++) {
                        const t = arc.startAngle + arc.sweepRad * k / 16;
                        grow({ e: arc.center.e + arc.radius * Math.cos(t), n: arc.center.n + arc.radius * Math.sin(t) });
                    }
                } else {
                    seg.chordOnly = true;
                    seg.reason = arc.reason;
                }
            }
            return seg;
        });

        // An open trace's last vertex is drawn as the END marker of the closing gap instead.
        const vertices = (traverse.closes ? ring : ring.slice(0, -1))
            .map((v, i) => ({ e: v.e, n: v.n, label: i === 0 ? "POB" : `P${i}` }));
        const closingGap = traverse.closes ? null
            : { from: V[V.length - 1], to: V[0], distance: traverse.misclosure };
        return { segments, vertices, closingGap, crossing, bounds: box };
    }

    // Pan/zoom SVG plot of the deed linework. SVG is built with createElementNS
    // (DOMPurify strips <svg>); y = −N so north is up.
    const SVGNS = "http://www.w3.org/2000/svg";
    const Plot = {
        root: null, svg: null, geom: null, hi: null, onHover: null,
        view: { x: 0, y: 0, w: 100, h: 100 }, drag: null,

        mount(root) {
            if (this.root === root) return;
            this.root = root;
            this.svg = document.createElementNS(SVGNS, "svg");
            this.svg.setAttribute("width", "100%");
            this.svg.setAttribute("height", "100%");
            this.svg.setAttribute("role", "img");
            this.svg.setAttribute("aria-label", "Plot of the deed boundary linework");
            this.svg.style.cssText = "display:block; touch-action:none; cursor:grab; user-select:none;";
            root.replaceChildren(this.svg);
            this.svg.addEventListener("wheel", e => {
                e.preventDefault();
                const p = this._toWorld(e);
                this._zoom(e.deltaY < 0 ? 0.85 : 1 / 0.85, p);
            }, { passive: false });
            this.svg.addEventListener("pointerdown", e => {
                this.drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
                this.svg.setPointerCapture(e.pointerId);
                this.svg.style.cursor = "grabbing";
            });
            this.svg.addEventListener("pointermove", e => {
                if (!this.drag) return;
                const k = this.view.w / (this.svg.clientWidth || 1);
                this.view.x = this.drag.vx - (e.clientX - this.drag.x) * k;
                this.view.y = this.drag.vy - (e.clientY - this.drag.y) * k;
                this.render();
            });
            const end = () => { this.drag = null; this.svg.style.cursor = "grab"; };
            this.svg.addEventListener("pointerup", end);
            this.svg.addEventListener("pointercancel", end);
            this.svg.addEventListener("dblclick", () => this.fit());
        },

        set(geom) { this.geom = geom; this.hi = null; this.fit(); },

        fit() {
            if (!this.svg || !this.geom) return;
            const b = this.geom.bounds;
            const W = this.svg.clientWidth || 600, H = this.svg.clientHeight || 420;
            const w = Math.max(b.maxE - b.minE, 1), h = Math.max(b.maxN - b.minN, 1);
            const pad = Math.max(w, h) * 0.15;
            let vw = w + 2 * pad, vh = h + 2 * pad;
            if (vw / vh < W / H) vw = vh * W / H; else vh = vw * H / W;
            this.view = { x: (b.minE + b.maxE) / 2 - vw / 2, y: -(b.minN + b.maxN) / 2 - vh / 2, w: vw, h: vh };
            this.render();
        },

        _toWorld(e) {
            const r = this.svg.getBoundingClientRect();
            return { x: this.view.x + (e.clientX - r.left) / (r.width || 1) * this.view.w,
                     y: this.view.y + (e.clientY - r.top) / (r.height || 1) * this.view.h };
        },
        _zoom(f, p) {
            const nw = Math.min(1e7, Math.max(0.5, this.view.w * f)), k = nw / this.view.w;
            this.view = { x: p.x - (p.x - this.view.x) * k, y: p.y - (p.y - this.view.y) * k, w: nw, h: this.view.h * k };
            this.render();
        },
        highlight(i) { if (this.hi !== i) { this.hi = i; this.render(); } },

        _mk(tag, attrs, style, parent) {
            const el = document.createElementNS(SVGNS, tag);
            for (const k in attrs) el.setAttribute(k, attrs[k]);
            if (style) el.style.cssText = style;
            if (parent) parent.appendChild(el);
            return el;
        },
        _text(parent, x, y, str, px, style, anchor) {
            const t = this._mk("text", { x, y, "font-size": px, "text-anchor": anchor || "middle", "dominant-baseline": "middle" },
                `font-family:var(--font-mono); paint-order:stroke; stroke:var(--bg-surface); stroke-width:${px * 0.3}px; ${style || ""}`, parent);
            t.textContent = str;
            return t;
        },

        render() {
            if (!this.svg) return;
            const v = this.view, g = this.geom;
            this.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
            this.svg.replaceChildren();
            if (!g) return;
            const u = v.w / (this.svg.clientWidth || 600);   // world units per screen px
            const X = p => p.e, Y = p => -p.n;

            g.segments.forEach(s => {
                const hot = this.hi === s.index;
                const color = s.crossing ? "var(--danger)" : s.chordOnly ? "var(--warning)" : s.kind === "curve" ? "var(--accent)" : "var(--primary)";
                const d = s.arc
                    ? `M ${X(s.from)} ${Y(s.from)} A ${s.arc.radius} ${s.arc.radius} 0 ${s.arc.largeArc ? 1 : 0} ${s.arc.sweepRad < 0 ? 1 : 0} ${X(s.to)} ${Y(s.to)}`
                    : `M ${X(s.from)} ${Y(s.from)} L ${X(s.to)} ${Y(s.to)}`;
                const grp = this._mk("g", { "data-call": s.index }, "cursor:pointer;", this.svg);
                this._mk("title", {}, null, grp).textContent = s.text + (s.chordOnly ? `  — drawn as chord: ${s.reason}` : "");
                this._mk("path", { d, fill: "none", "vector-effect": "non-scaling-stroke" },
                    `stroke:transparent; stroke-width:12px;`, grp);
                this._mk("path", { d, fill: "none", "vector-effect": "non-scaling-stroke" },
                    `stroke:${color}; stroke-width:${hot ? 4 : 2}px; ${s.chordOnly ? "stroke-dasharray:6 4;" : ""}`, grp);
                // Direction-of-travel arrow at the midpoint (an arc's mid-tangent is parallel to its chord).
                const az = (s.azimuthDeg || 0) * Math.PI / 180, ax = Math.sin(az), ay = -Math.cos(az);
                const m = { x: X(s.mid), y: Y(s.mid) }, L = 7 * u, Wd = 4 * u;
                this._mk("path", { d: `M ${m.x + ax * L} ${m.y + ay * L} L ${m.x - ax * L / 2 - ay * Wd} ${m.y - ay * L / 2 + ax * Wd} L ${m.x - ax * L / 2 + ay * Wd} ${m.y - ay * L / 2 - ax * Wd} Z` },
                    `fill:${color};`, grp);
                const lp = { x: X(s.mid) + s.outward.e * 16 * u, y: Y(s.mid) - s.outward.n * 16 * u };
                this._text(grp, lp.x, lp.y, s.label, (hot ? 13 : 11) * u, `fill:${color}; font-weight:700;`);
                grp.addEventListener("pointerenter", () => { this.highlight(s.index); if (this.onHover) this.onHover(s.index); });
                grp.addEventListener("pointerleave", () => { this.highlight(null); if (this.onHover) this.onHover(null); });
            });

            if (g.closingGap) {
                const c = g.closingGap;
                this._mk("line", { x1: X(c.from), y1: Y(c.from), x2: X(c.to), y2: Y(c.to), "vector-effect": "non-scaling-stroke" },
                    "stroke:var(--danger); stroke-width:1.5px; stroke-dasharray:3 3;", this.svg);
                this._mk("circle", { cx: X(c.from), cy: Y(c.from), r: 6 * u, fill: "none", "vector-effect": "non-scaling-stroke" },
                    "stroke:var(--danger); stroke-width:1.5px;", this.svg);
                this._text(this.svg, X(c.from) + 9 * u, Y(c.from) + 12 * u, "END", 10 * u, "fill:var(--danger); font-weight:700;", "start");
            }

            g.vertices.forEach((p, i) => {
                const pob = i === 0;
                this._mk("circle", { cx: X(p), cy: Y(p), r: (pob ? 5 : 3) * u },
                    `fill:${pob ? "var(--danger)" : "var(--bg-surface)"}; stroke:var(--text-primary); stroke-width:${u}px;`, this.svg);
                this._text(this.svg, X(p) + 7 * u, Y(p) - 8 * u, p.label, (pob ? 11 : 9) * u,
                    `fill:var(--text-${pob ? "primary" : "muted"}); ${pob ? "font-weight:700;" : ""}`, "start");
            });

            // North arrow (top-right) and a 1-2-5 scale bar (bottom-left), sized in screen px.
            const nx = v.x + v.w - 28 * u, ny = v.y + 22 * u;
            this._mk("path", { d: `M ${nx} ${ny - 12 * u} L ${nx + 6 * u} ${ny + 8 * u} L ${nx} ${ny + 3 * u} L ${nx - 6 * u} ${ny + 8 * u} Z` },
                "fill:var(--text-primary);", this.svg);
            this._text(this.svg, nx, ny + 18 * u, "N", 11 * u, "fill:var(--text-primary); font-weight:700;");
            const target = v.w / 5, p10 = Math.pow(10, Math.floor(Math.log10(target)));
            const len = [5, 2, 1].map(m => m * p10).find(x => x <= target) || p10;
            const sx = v.x + 16 * u, sy = v.y + v.h - 18 * u;
            this._mk("path", { d: `M ${sx} ${sy - 4 * u} L ${sx} ${sy} L ${sx + len} ${sy} L ${sx + len} ${sy - 4 * u}`, fill: "none", "vector-effect": "non-scaling-stroke" },
                "stroke:var(--text-primary); stroke-width:1.5px;", this.svg);
            this._text(this.svg, sx + len / 2, sy - 9 * u, `${len >= 1 ? len.toLocaleString() : len.toPrecision(1)} ft`, 10 * u, "fill:var(--text-primary);");
        }
    };

    function renderPlot(traverseGeom) {
        const wrap = document.getElementById("legal-desc-plot-wrap");
        const root = document.getElementById("legal-desc-plot");
        if (!wrap || !root || typeof document.createElementNS !== "function") return;
        if (!traverseGeom) { wrap.classList.add("hidden"); return; }
        wrap.classList.remove("hidden");
        Plot.mount(root);
        Plot.set(traverseGeom);
        const notes = [];
        const chordOnly = traverseGeom.segments.filter(s => s.chordOnly);
        if (chordOnly.length) notes.push(`<span style="color:var(--warning);">Dashed = drawn as chord (${chordOnly.map(s => `${s.label}: ${s.reason}`).join("; ")}).</span>`);
        if (traverseGeom.crossing) {
            const lbl = n => (traverseGeom.segments[n - 1] || { label: "the closing gap" }).label;
            notes.push(`<span style="color:var(--danger);">Red = ${lbl(traverseGeom.crossing.i)} and ${lbl(traverseGeom.crossing.j)} cross.</span>`);
        }
        if (traverseGeom.closingGap) notes.push(`<span style="color:var(--danger);">Dotted red = gap from END (last call) back to the POB — misclosure ${traverseGeom.closingGap.distance.toFixed(3)} ft.</span>`);
        window.setSafeHTML(document.getElementById("legal-desc-plot-legend"),
            `Plotted from the POB at 0,0 (local, not State Plane). <span style="color:var(--primary);">Lines</span> · <span style="color:var(--accent);">curves</span> · arrows show direction of travel. ` +
            `Scroll to zoom, drag to pan, double-click to fit. ${notes.join(" ")}`);
    }

    function syncRowHighlight(i) {
        document.querySelectorAll("#legal-desc-results tr[data-call]").forEach(tr => {
            tr.style.background = String(i) === tr.getAttribute("data-call") ? "var(--primary-light)" : "";
        });
    }

    // ── Render ──────────────────────────────────────────────────────────────

    function run(ctx) {
        const input = document.getElementById("legal-desc-input")?.value.trim() || "";
        const box = document.getElementById("legal-desc-results");
        if (!box) return;
        box.classList.remove("hidden");

        if (!input) {
            window.setSafeHTML(box, `<strong style="color:var(--danger);">Paste a legal description to analyze.</strong>`);
            return;
        }

        const parsed = parse(input);
        let traverse = null;
        if (parsed.calls.length >= 2 && parsed.calls.every(c => c.kind === "line" ? c.azimuthDeg != null : c.chordAzimuthDeg != null)) {
            const legs = parsed.calls.map(c => c.kind === "curve"
                ? { kind: "curve", chordAzimuthDeg: c.chordAzimuthDeg, chordDistance: c.chordDist, arcLength: c.arc,
                    radius: c.radius, direction: c.direction }
                : { kind: "line", azimuthDeg: c.azimuthDeg, distance: c.distance });
            traverse = window.COGO.runTraverse(legs);
        }
        const issues = qc(parsed, traverse, { fdot: !!document.getElementById("legal-desc-fdot")?.checked });
        _last = { parsed, traverse, issues };
        const geom = plotGeometry(parsed, traverse);

        const errN = issues.filter(i => i.sev === "ERROR").length;
        const rows = parsed.calls.map((c, i) => c.kind === "line"
            ? `<tr data-call="${i}"><td>${c.label}</td><td>Line</td><td style="font-family:var(--font-mono);">${c.bearingText}</td><td style="font-family:var(--font-mono);">${c.distance.toFixed(2)} ft</td></tr>`
            : `<tr data-call="${i}"><td>${c.label}</td><td>Curve${c.direction ? ` (${c.direction === "L" ? "left" : "right"})` : ' <span style="color:var(--warning);">(direction?)</span>'}</td><td style="font-family:var(--font-mono);">${c.chordBearingText}${c.backSolved ? ' <span style="color:var(--warning);">(chord back-solved)</span>' : ''}</td><td style="font-family:var(--font-mono);">R ${c.radius.toFixed(2)} · Arc ${c.arc.toFixed(2)} · Chord ${c.chordDist.toFixed(2)}</td></tr>`
        ).join("");

        const closureHtml = traverse
            ? `<div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; margin-top:0.75rem;">
                 <div style="background:var(--bg-surface); padding:0.75rem; border-radius:var(--radius-sm);">
                   <small style="color:var(--text-muted);">Linear misclosure</small>
                   <div style="font-weight:700;">${traverse.misclosure.toFixed(3)} ft</div>
                   <small style="color:var(--text-muted);">Perimeter ${traverse.perimeter.toFixed(2)} ft</small>
                 </div>
                 <div style="background:var(--bg-surface); padding:0.75rem; border-radius:var(--radius-sm);">
                   <small style="color:var(--text-muted);">Precision</small>
                   <div style="font-weight:700; color:${traverse.precisionDenominator === Infinity || traverse.precisionDenominator >= PRECISION_PASS_() ? 'var(--success)' : 'var(--danger)'};">
                     ${traverse.precisionDenominator === Infinity ? 'exact' : '1 : ' + Math.round(traverse.precisionDenominator).toLocaleString()}</div>
                   <small style="color:var(--text-muted);">Area ${traverse.areaAcres.toFixed(4)} ac (${traverse.areaSqFt.toFixed(0)} sf)${traverse.curvesWithoutDirection ? ' <span style="color:var(--warning);">— chord-only for ' + traverse.curvesWithoutDirection + ' curve(s)</span>' : ''}</small>
                 </div>
               </div>`
            : `<p style="color:var(--warning); margin-top:0.5rem;">Not enough resolved geometry for a closure or a linework plot — check bearings/distances above.</p>`;

        const issueHtml = issues.length
            ? issues.map(i => `<div class="qc-item ${i.sev.toLowerCase()}" style="margin-top:0.4rem;"><div class="qc-item-content"><h4>${i.code} <span class="tag tag-discipline">${i.sev}</span></h4><p>${i.msg}</p></div></div>`).join("")
            : `<div style="color:var(--success); padding:0.5rem 0;"><i class="fa-solid fa-circle-check"></i> No QC issues.</div>`;

        window.setSafeHTML(box, `
            <h4 style="font-size:1rem; font-weight:700;"><i class="fa-solid fa-list-check" style="color:var(--success);"></i> Parsed ${parsed.calls.length} calls · ${errN} error(s)</h4>
            <div style="overflow-x:auto; margin-top:0.5rem;">
              <table class="data-table" style="width:100%; font-size:0.8rem;">
                <thead><tr><th>#</th><th>Type</th><th>Bearing</th><th>Geometry</th></tr></thead>
                <tbody>${rows || '<tr><td colspan="4">No line/curve calls recognized.</td></tr>'}</tbody>
              </table>
            </div>
            ${closureHtml}
            <div style="margin-top:0.75rem;">${issueHtml}</div>
        `);
        renderPlot(geom);

        if (ctx) ctx.showToast(`Legal description: ${parsed.calls.length} calls, ${errN} error(s).`, errN > 0);
    }

    /**
     * Generate Civil 3D Survey Command Language script from legal description calls.
     */
    function buildSurveyScript(parsed, traverse) {
        if (!parsed || !parsed.calls || !parsed.calls.length) return "";
        const lines = [];
        lines.push("// Civil 3D Survey Command Script — Generated from Metes & Bounds Legal Description");
        lines.push(`// Generated: ${new Date().toISOString()}`);
        lines.push("// Compatible with Civil 3D Survey Command Window (Batch) & Field Book (.FBK)");
        lines.push("");
        lines.push("START_BATCH");
        lines.push("UNIT FOOT DMS");
        lines.push("");

        // traverse.vertices always includes a final vertex even when the
        // description doesn't actually return to the POB (COGO.runTraverse
        // just walks the calls) — only drop it as a duplicate-of-POB when
        // traverse.closes says it genuinely is one; otherwise it's a real,
        // distinct endpoint and FIG CLOSE would draw a segment that was
        // never called for.
        const verts = traverse ? traverse.vertices : [];
        const closes = !!(traverse && traverse.closes);
        const planted = closes ? verts.slice(0, -1) : verts;
        if (verts.length >= 2) {
            lines.push("// Plant computed coordinate geometry (POB + course vertices)");
            planted.forEach((v, idx) => {
                const ptNum = 1000 + idx;
                const desc = idx === 0 ? "POB" : `CORNER_${idx}`;
                lines.push(`NEZ ${ptNum} ${v.n.toFixed(4)} ${v.e.toFixed(4)} 0.0000 "${desc}"`);
            });
            lines.push("");
            lines.push("// Define Legal Description Boundary Figure");
            lines.push("FIG BEGIN LEGAL_BOUNDARY");
            planted.forEach((v, idx) => {
                const ptNum = 1000 + idx;
                lines.push(`FIG PT ${ptNum}`);
            });
            if (closes) lines.push("FIG CLOSE");
            lines.push("FIG END");
            lines.push("");
        }

        lines.push("// Traversal Courses (Bearing/Distance)");
        // DD.MMSS for a BD command — rounded via COGO.normalizeDMS so a
        // seconds value that rounds to 60 carries into minutes (never ":60").
        const dmsCode = brg => {
            const d = window.COGO.normalizeDMS(brg.deg, brg.min, brg.sec);
            return `${d.deg}.${String(d.min).padStart(2, "0")}${String(d.sec).padStart(2, "0")}`;
        };
        lines.push("STN 1000 0.00 \"POB\"");
        parsed.calls.forEach((c, idx) => {
            const destPt = 1001 + idx;
            if (c.kind === "line" && c.azimuthDeg != null) {
                const brg = c.bearing || window.COGO.parseBearing(c.bearingText || c.raw);
                if (brg) {
                    const quadNum = brg.quad === "NE" ? 1 : (brg.quad === "SE" ? 2 : (brg.quad === "SW" ? 3 : 4));
                    lines.push(`BD ${destPt} ${quadNum} ${dmsCode(brg)} ${c.distance.toFixed(2)} "${c.label}"`);
                }
            } else if (c.kind === "curve" && c.chordAzimuthDeg != null) {
                const brg = window.COGO.parseBearing(c.chordBearingText || c.raw);
                if (brg) {
                    const quadNum = brg.quad === "NE" ? 1 : (brg.quad === "SE" ? 2 : (brg.quad === "SW" ? 3 : 4));
                    lines.push(`CRV RADIUS ${c.radius.toFixed(2)}`);
                    lines.push(`BD ${destPt} ${quadNum} ${dmsCode(brg)} ${c.chordDist.toFixed(2)} "${c.label} CHORD"`);
                }
            }
        });
        lines.push("END_BATCH");
        return lines.join("\r\n") + "\r\n";
    }

    const Plugin = {
        init() {
            const ta = document.getElementById("legal-desc-input");
            if (ta && !ta.value) {
                ta.value =
                    "BEGINNING at the POINT OF BEGINNING; thence North 45 degrees 12 minutes 30 seconds East, a distance of 150.00 feet; " +
                    "thence South 44 degrees 47 minutes 30 seconds East, a distance of 200.00 feet; " +
                    "thence South 45 degrees 12 minutes 30 seconds West, a distance of 150.00 feet; " +
                    "thence North 44 degrees 47 minutes 30 seconds West, a distance of 200.00 feet to the POINT OF BEGINNING.";
            }
        },
        setupEvents(ctx) {
            document.getElementById("btn-parse-legal-desc")?.addEventListener("click", () => run(ctx));
            document.getElementById("btn-legal-desc-fit")?.addEventListener("click", () => Plot.fit());
            Plot.onHover = syncRowHighlight;
            const results = document.getElementById("legal-desc-results");
            results?.addEventListener("mouseover", e => {
                const tr = e.target.closest && e.target.closest("tr[data-call]");
                Plot.highlight(tr ? Number(tr.getAttribute("data-call")) : null);
                syncRowHighlight(tr ? tr.getAttribute("data-call") : null);
            });
            results?.addEventListener("mouseleave", () => { Plot.highlight(null); syncRowHighlight(null); });
            document.getElementById("btn-legal-desc-pnezd")?.addEventListener("click", () => {
                if (!_last || !_last.traverse) { ctx.showToast("Run a parse with resolved geometry first.", true); return; }
                window.COGO.downloadText("legal_description_coordinates.txt", window.COGO.pnezd(_last.traverse.vertices.slice(0, -1)), "text/csv");
                ctx.showToast("Exported P,N,E,Z,D coordinate file.");
            });
            document.getElementById("btn-legal-desc-report")?.addEventListener("click", () => {
                if (!_last) { ctx.showToast("Run a parse first.", true); return; }
                const reportContent = mapCheckReport(_last.parsed, _last.traverse, _last.issues);
                if (window.Reports?.addReport) {
                    window.Reports.addReport({
                        title: "Legal Description Map Check Report",
                        type: "legal-desc-mapcheck",
                        category: "legal",
                        format: "log",
                        filename: "legal_description_mapcheck.log",
                        content: reportContent
                    });
                }
                window.COGO.downloadText("legal_description_mapcheck.log", reportContent);
                ctx.showToast("Exported Map Check Report & stored in Reports Hub.");
            });
            document.getElementById("btn-legal-desc-script")?.addEventListener("click", () => {
                if (!_last || !_last.parsed) { ctx.showToast("Run a parse first.", true); return; }
                const script = buildSurveyScript(_last.parsed, _last.traverse);
                window.COGO.downloadText("legal_description_survey.fbk", script, "text/plain");
                ctx.showToast("Exported Civil 3D Survey Script (.fbk).");
            });
        },
        onTabActivate(ctx) { if (_last) run(ctx); }
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);

    // Exposed for console debugging / tests.
    window.LegalDesc = { parse, qc, mapCheckReport, buildSurveyScript, arcGeometry, plotGeometry, statedAreas, parcelSeries, fdotChecks };
})();
