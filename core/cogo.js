/**
 * BoundaryQC / FDOT Civil3D Standards — shared COGO math
 * core/cogo.js
 *
 * Ported from the BoundaryQC desktop app (Services/CogoMath.cs,
 * Services/Writer/TraverseGeometryEngine.cs). Conventions:
 *   - Azimuth measured clockwise from North, in radians.
 *   - Coordinates are (E, N) = (easting, northing); N is +Y.
 *   - Bearings are quadrant bearings: N/S <deg> <min> <sec> E/W.
 *   - Per the BoundaryQC "decimal-angle-bearing-tolerance" rule: math carried to
 *     0.001, reported to 0.01; angles to 0.1"; coordinate points start at 500 with
 *     descriptions "COGO POB", "COGO P1", "COGO P2", ...
 *
 * Exposed as window.COGO.
 */
(function () {
    "use strict";

    const D2R = Math.PI / 180;
    const R2D = 180 / Math.PI;

    /** Parse a quadrant bearing string → { quad, deg, min, sec, azimuthDeg } or null. */
    function parseBearing(text) {
        if (!text) return null;
        let s = String(text);
        // Normalize every common DMS notation to space-separated numbers:
        //   "North 45 degrees 12 minutes 30 seconds East", "N45°12'30\"E",
        //   "N 45-12-30 E", "N45d12m30sE", "N.45*12'30\"W"
        s = s.replace(/\bnorth\b/gi, "N").replace(/\bsouth\b/gi, "S")
             .replace(/\beast\b/gi, "E").replace(/\bwest\b/gi, "W")
             .replace(/\s*deg(?:rees?)?\.?\s*/gi, " ").replace(/\s*min(?:utes?)?\.?\s*/gi, " ").replace(/\s*sec(?:onds?)?\.?\s*/gi, " ")
             .replace(/[°'"′″*]/g, " ")                       // degree / minute / second marks
             .replace(/(\d)\s*[-–—]\s*(?=\d)/g, "$1 ")        // 45-12-30  ->  45 12 30
             .replace(/(\d)\s*[dm]\s*(?=\d)/gi, "$1 ")        // 45d12m30  ->  45 12 30
             .replace(/(\d)\s*s\s*(?=[EW\d])/gi, "$1 ")       // 30sE      ->  30 E
             .replace(/\s+/g, " ").trim();
        const m = s.match(
            /([NS])\s*\.?\s*(\d{1,3}(?:\.\d+)?)(?:\s+(\d{1,2}(?:\.\d+)?))?(?:\s+(\d{1,2}(?:\.\d+)?))?\s*([EW])/i
        );
        if (!m) return null;
        const quad = (m[1] + m[5]).toUpperCase();
        const deg = parseFloat(m[2]);
        const min = m[3] ? parseFloat(m[3]) : 0;
        const sec = m[4] ? parseFloat(m[4]) : 0;
        // Reject impossible quadrant bearings instead of silently turning them into an azimuth
        // ("N 95 E", "N45 75 00E", "S 400 E" all used to parse).
        if (!(deg <= 90) || !(min < 60) || !(sec < 60)) return null;
        const inner = deg + min / 60 + sec / 3600;
        if (inner > 90) return null;
        let az;
        switch (quad) {
            case "NE": az = inner; break;
            case "SE": az = 180 - inner; break;
            case "SW": az = 180 + inner; break;
            case "NW": az = 360 - inner; break;
            default:   az = inner;
        }
        return { quad, deg, min, sec, azimuthDeg: (az % 360 + 360) % 360 };
    }

    /** Azimuth degrees → "N dd°mm'ss.s\" E" quadrant-bearing string. */
    function azimuthToBearing(azDeg) {
        let deg = ((azDeg % 360) + 360) % 360;
        let ns = "N", ew = "E", b = 0;
        if (deg <= 90)        { ns = "N"; ew = "E"; b = deg; }
        else if (deg <= 180)  { ns = "S"; ew = "E"; b = 180 - deg; }
        else if (deg <= 270)  { ns = "S"; ew = "W"; b = deg - 180; }
        else                  { ns = "N"; ew = "W"; b = 360 - deg; }
        // Round once, in tenths of a second, then split — so 45.99999° prints 46°00'00.0"
        // rather than 45°59'60.0".
        const tenths = Math.round(b * 36000);
        const d = Math.floor(tenths / 36000);
        const mm = Math.floor((tenths - d * 36000) / 600);
        const ss = (tenths - d * 36000 - mm * 600) / 10;
        return `${ns} ${String(d).padStart(2, "0")}°${String(mm).padStart(2, "0")}'${ss.toFixed(1).padStart(4, "0")}" ${ew}`;
    }

    /** Advance an {e, n} point along an azimuth (deg) for a distance. */
    function advance(pt, azimuthDeg, distance) {
        const a = azimuthDeg * D2R;
        return { e: pt.e + Math.sin(a) * distance, n: pt.n + Math.cos(a) * distance };
    }

    /** Plane distance between two {e, n} points. */
    function distanceBetween(a, b) { return Math.hypot(b.e - a.e, b.n - a.n); }

    /** Azimuth (deg, clockwise from north) from point a to point b. */
    function azimuthDegBetween(a, b) {
        const az = Math.atan2(b.e - a.e, b.n - a.n) * R2D;
        return (az % 360 + 360) % 360;
    }

    /** Included angle (deg, 0..180) at vertex `at` between the rays to `prev` and `next`. */
    function includedAngleDeg(prev, at, next) {
        const a1 = azimuthDegBetween(at, prev);
        const a2 = azimuthDegBetween(at, next);
        let d = Math.abs(a1 - a2);
        if (d > 180) d = 360 - d;
        return d;
    }

    /** Chord distance from radius + arc length: 2R·sin(Δ/2), Δ = arc/R. */
    function chordFromArc(radius, arcLength) {
        if (!(radius > 0) || !(arcLength > 0)) return 0;
        return 2 * radius * Math.sin(arcLength / radius / 2);
    }

    /** Delta angle (deg) from radius + arc length. */
    function deltaDegFromArc(radius, arcLength) {
        if (!(radius > 0) || !(arcLength > 0)) return 0;
        return (arcLength / radius) * R2D;
    }

    /** Signed Shoelace area (sq ft): positive when the vertices run counter-clockwise. */
    function signedShoelaceArea(verts) {
        if (!verts || verts.length < 3) return 0;
        let a = 0;
        for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
            a += (verts[j].e + verts[i].e) * (verts[j].n - verts[i].n);
        }
        // This form is positive for clockwise rings in an (e, n) plane; flip to the usual sign.
        return -a / 2;
    }

    /** Shoelace area (sq ft) for a list of {e, n} vertices. */
    function shoelaceArea(verts) {
        return Math.abs(signedShoelaceArea(verts));
    }

    /**
     * Area (sq ft) between a circular arc and its chord: R²/2 · (Δ − sin Δ), Δ in radians.
     * Valid for Δ up to 2π (a major arc's segment is the larger piece).
     */
    function circularSegmentArea(radius, arcLength) {
        if (!(radius > 0) || !(arcLength > 0)) return 0;
        const delta = arcLength / radius;
        return radius * radius / 2 * (delta - Math.sin(delta));
    }

    /**
     * Normalise a curve direction to "L" / "R" (the way the curve turns, walking the call).
     * Accepts "L"/"R"/"left"/"right"; returns null when unknown.
     */
    function curveDirection(v) {
        const s = String(v || "").trim().toUpperCase();
        if (s === "L" || s === "LEFT") return "L";
        if (s === "R" || s === "RIGHT") return "R";
        return null;
    }

    /**
     * Turn direction from a "concave Northwesterly"-style phrase and the chord azimuth: the
     * radius point lies on the concave side, so concave-to-the-right-of-travel = turning right.
     * Returns "L" / "R", or null if the word isn't a compass direction or lies ~along the chord.
     */
    function directionFromConcavity(concavityWord, chordAzimuthDeg) {
        const w = String(concavityWord || "").toUpperCase().replace(/ERLY$|LY$/, "").replace(/[^A-Z]/g, "");
        if (w === "LEFT" || w === "RIGHT") return w[0];   // "concave to the left" = turning left
        const AZ = { NORTH: 0, N: 0, NORTHEAST: 45, NE: 45, EAST: 90, E: 90, SOUTHEAST: 135, SE: 135,
                     SOUTH: 180, S: 180, SOUTHWEST: 225, SW: 225, WEST: 270, W: 270, NORTHWEST: 315, NW: 315 };
        const conc = AZ[w];
        if (conc === undefined || chordAzimuthDeg == null || !isFinite(chordAzimuthDeg)) return null;
        const side = Math.sin((conc - chordAzimuthDeg) * D2R);
        if (Math.abs(side) < 0.2) return null;   // concavity roughly along the chord: ambiguous
        return side > 0 ? "R" : "L";
    }

    const SQFT_PER_ACRE = 43560;

    /**
     * Run a traverse from an origin through a list of legs.
     * Each leg: { kind:'line', azimuthDeg, distance } or
     *           { kind:'curve', chordAzimuthDeg, chordDistance, arcLength, radius?, direction? }.
     * Returns { vertices, perimeter, misclosure, precisionDenominator, areaSqFt,
     *           areaAcres, closeAzimuthDeg, closes, chordAreaSqFt, curveSegmentAreaSqFt,
     *           curvesWithoutDirection }.
     * Area includes each curve's arc-to-chord segment when the curve's radius and turn
     * direction ('L'/'R') are given; curves lacking them are counted in
     * `curvesWithoutDirection` and contribute chord-only area (flag that to the user).
     * `closes` is true when the trace returns to the origin (misclosure ≈ 0); the
     * area fields assume closure and are not meaningful for an open traverse.
     */
    function runTraverse(legs, origin) {
        const start = origin || { e: 0, n: 0 };
        const vertices = [{ ...start }];
        let perimeter = 0;
        let cur = { ...start };
        let segmentSigned = 0, curvesWithoutDirection = 0;
        for (const leg of legs) {
            if (leg.kind === "curve") {
                cur = advance(cur, leg.chordAzimuthDeg, leg.chordDistance || 0);
                perimeter += leg.arcLength || leg.chordDistance || 0;
                const dir = curveDirection(leg.direction);
                const seg = circularSegmentArea(leg.radius, leg.arcLength);
                // Walking A→B, a left-turning arc bulges to the right of the chord, which adds
                // counter-clockwise (positive) area; a right-turning arc subtracts it.
                if (dir && seg > 0) segmentSigned += dir === "L" ? seg : -seg;
                else curvesWithoutDirection++;
            } else {
                cur = advance(cur, leg.azimuthDeg, leg.distance || 0);
                perimeter += leg.distance || 0;
            }
            vertices.push({ ...cur });
        }
        const end = vertices[vertices.length - 1];
        const dE = start.e - end.e, dN = start.n - end.n;
        const misclosure = Math.hypot(dE, dN);
        const precisionDenominator = misclosure > 1e-4 ? perimeter / misclosure : Infinity;
        // Area of the ring that closes the trace back to the origin. When the trace closes, the
        // last vertex duplicates the origin and is dropped; otherwise the implicit closing
        // segment last→origin is used (the old code dropped the last real vertex either way).
        const ring = misclosure <= 1e-4 ? vertices.slice(0, -1) : vertices;
        const chordSigned = signedShoelaceArea(ring.length >= 3 ? ring : vertices);
        const areaSqFt = Math.abs(chordSigned + segmentSigned);
        const closeAzimuthDeg = misclosure > 1e-4
            ? ((Math.atan2(dE, dN) * R2D) % 360 + 360) % 360
            : null;
        return {
            vertices, perimeter, misclosure, precisionDenominator,
            areaSqFt, areaAcres: areaSqFt / SQFT_PER_ACRE, closeAzimuthDeg,
            chordAreaSqFt: Math.abs(chordSigned),
            curveSegmentAreaSqFt: Math.abs(segmentSigned),
            curvesWithoutDirection,
            closes: misclosure <= 1e-4
        };
    }

    /**
     * Build a P,N,E,Z,D point-file string. Points start at 500; descriptions
     * "COGO POB", "COGO P1", ... (BoundaryQC decimal-angle-bearing-tolerance rule).
     */
    function pnezd(vertices, startNumber) {
        const n0 = startNumber || 500;
        const rows = ["P,N,E,Z,D"];
        vertices.forEach((v, i) => {
            const desc = i === 0 ? "COGO POB" : `COGO P${i}`;
            // Z from a 3D traverse when there is one; a 2D one has no elevation and keeps 0.000
            rows.push(`${n0 + i},${v.n.toFixed(3)},${v.e.toFixed(3)},${(isFinite(v.z) ? v.z : 0).toFixed(3)},${desc}`);
        });
        return rows.join("\r\n") + "\r\n";
    }

    /** Test whether the closed polygon over {e,n} vertices intersects itself. */
    function selfIntersects(verts) {
        const cross = (a, b, c) => (c.n - a.n) * (b.e - a.e) - (b.n - a.n) * (c.e - a.e);
        const ring = verts.concat([verts[0]]);
        const n = ring.length - 1;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (j === i || j === i + 1 || (i === 0 && j === n - 1)) continue;
                const [p1, p2, p3, p4] = [ring[i], ring[i + 1], ring[j], ring[j + 1]];
                const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
                const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
                if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
                    ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) {
                    return { i: i + 1, j: j + 1 };
                }
            }
        }
        return null;
    }

    /** Bulge factor for an LWPOLYLINE arc segment: tan(includedAngle / 4). Sign: + = CCW. */
    function bulge(includedAngleRad) { return Math.tan(includedAngleRad / 4); }

    /** Round a D/M/S angle to whole seconds, carrying overflow into minutes
     *  and degrees — a raw seconds value that rounds to 60 must not print as
     *  ":60" (e.g. 45°12'59.6" -> {45,13,0}, not {45,12,60}). Every DMS/DD.MMSS
     *  string built for a report or a Survey Command Language script should
     *  round through this, not `Math.round(sec)` inline. */
    function normalizeDMS(deg, min, sec) {
        let d = deg, m = min, s = Math.round(sec);
        if (s >= 60) { s -= 60; m += 1; }
        if (m >= 60) { m -= 60; d += 1; }
        return { deg: d, min: m, sec: s };
    }

    /**
     * Build a minimal ASCII DXF (R12-style) from layers + entities.
     * layers:    [{ name, color }]  (ACI colour number)
     * polylines: [{ layer, closed, points:[{ e, n, bulge? }] }]   bulge on a vertex = arc to the next vertex
     * texts:     [{ layer, e, n, height, value }]
     * circles:   [{ layer, cx, cy, r }]
     */
    function buildDxf({ layers = [], polylines = [], texts = [], circles = [] }) {
        const out = [];
        const p = (code, val) => { out.push(String(code)); out.push(String(val)); };

        p(0, "SECTION"); p(2, "TABLES");
        p(0, "TABLE"); p(2, "LAYER"); p(70, layers.length || 1);
        (layers.length ? layers : [{ name: "0", color: 7 }]).forEach(l => {
            p(0, "LAYER"); p(2, l.name); p(70, 0); p(62, l.color == null ? 7 : l.color); p(6, "CONTINUOUS");
        });
        p(0, "ENDTAB"); p(0, "ENDSEC");

        p(0, "SECTION"); p(2, "ENTITIES");
        polylines.forEach(pl => {
            p(0, "LWPOLYLINE"); p(8, pl.layer || "0");
            p(90, pl.points.length); p(70, pl.closed ? 1 : 0);
            pl.points.forEach(pt => {
                p(10, pt.e.toFixed(4)); p(20, pt.n.toFixed(4));
                if (pt.bulge) p(42, pt.bulge.toFixed(6));
            });
        });
        circles.forEach(c => {
            p(0, "CIRCLE"); p(8, c.layer || "0");
            p(10, c.cx.toFixed(4)); p(20, c.cy.toFixed(4)); p(40, c.r.toFixed(4));
        });
        texts.forEach(t => {
            p(0, "TEXT"); p(8, t.layer || "0");
            p(10, t.e.toFixed(4)); p(20, t.n.toFixed(4));
            p(40, (t.height || 5).toFixed(4)); p(1, t.value);
        });
        p(0, "ENDSEC");
        p(0, "EOF");
        return out.join("\r\n") + "\r\n";
    }

    /** Trigger a browser download of a text blob. */
    function downloadText(filename, text, mime) {
        const blob = new Blob([text], { type: mime || "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = filename; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ── Florida State Plane Coordinate System (SPCS83 / NAD83 2011) & CSF ────
    const GRS80_A = 6378137.0; // semi-major axis (meters)
    const GRS80_F = 1 / 298.257222101; // flattening
    const GRS80_E2 = 2 * GRS80_F - GRS80_F * GRS80_F; // 1st eccentricity squared
    const GRS80_E = Math.sqrt(GRS80_E2);
    const GRS80_EP2 = GRS80_E2 / (1 - GRS80_E2); // 2nd eccentricity squared
    const METER_TO_SFT = 3937 / 1200; // US Survey Foot ratio
    const SFT_TO_METER = 1200 / 3937;
    const MEAN_EARTH_RADIUS_FT = 20906000; // mean radius for Florida (~6372 km)

    const SPCS83_ZONES = {
        FL_EAST: {
            name: "Florida East",
            fips: "0901",
            proj: "TM",
            cmDeg: -81.0,
            origLatDeg: 24 + 20 / 60,
            k0: 0.9999411764705882, // 1 / 17000
            feM: 200000.0,
            fnM: 0.0
        },
        FL_WEST: {
            name: "Florida West",
            fips: "0902",
            proj: "TM",
            cmDeg: -82.0,
            origLatDeg: 24 + 20 / 60,
            k0: 0.9999411764705882, // 1 / 17000
            feM: 200000.0,
            fnM: 0.0
        },
        FL_NORTH: {
            name: "Florida North",
            fips: "0903",
            proj: "LCC",
            sp1Deg: 29 + 35 / 60,
            sp2Deg: 30 + 45 / 60,
            origLatDeg: 29.0,
            cmDeg: -84.5,
            feM: 600000.0,
            fnM: 0.0
        }
    };

    function _tmMeridionalDist(phi) {
        const c0 = 1 - GRS80_E2 / 4 - 3 * GRS80_E2 * GRS80_E2 / 64 - 5 * Math.pow(GRS80_E2, 3) / 256;
        const c2 = 3 * GRS80_E2 / 8 + 3 * GRS80_E2 * GRS80_E2 / 32 + 45 * Math.pow(GRS80_E2, 3) / 1024;
        const c4 = 15 * GRS80_E2 * GRS80_E2 / 256 + 45 * Math.pow(GRS80_E2, 3) / 1024;
        const c6 = 35 * Math.pow(GRS80_E2, 3) / 3072;
        return GRS80_A * (c0 * phi - c2 * Math.sin(2 * phi) + c4 * Math.sin(4 * phi) - c6 * Math.sin(6 * phi));
    }

    function _lccInit(z) {
        if (z._init) return z._init;
        const p1 = z.sp1Deg * D2R;
        const p2 = z.sp2Deg * D2R;
        const p0 = z.origLatDeg * D2R;
        const m1 = Math.cos(p1) / Math.sqrt(1 - GRS80_E2 * Math.sin(p1) * Math.sin(p1));
        const m2 = Math.cos(p2) / Math.sqrt(1 - GRS80_E2 * Math.sin(p2) * Math.sin(p2));
        const tFn = p => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - GRS80_E * Math.sin(p)) / (1 + GRS80_E * Math.sin(p)), GRS80_E / 2);
        const t1 = tFn(p1);
        const t2 = tFn(p2);
        const t0 = tFn(p0);
        const n = (Math.log(m1) - Math.log(m2)) / (Math.log(t1) - Math.log(t2));
        const F = m1 / (n * Math.pow(t1, n));
        const rho0 = GRS80_A * F * Math.pow(t0, n);
        z._init = { n, F, rho0, tFn };
        return z._init;
    }

    /**
     * Convert WGS84 / NAD83 latitude & longitude to Florida State Plane coordinates.
     * Natural Physical GPS Coordinates: Always exact, ground-truthed WGS84/NAD83 without artificial offset fudging.
     * @param {number} latDeg - Latitude in decimal degrees (North)
     * @param {number} lonDeg - Longitude in decimal degrees (West, negative)
     * @param {"FL_EAST"|"FL_WEST"|"FL_NORTH"} zoneKey
     * @param {"sft"|"m"} [unit="sft"] - US Survey Feet (sft) or Meters (m)
     * @returns {{ northing: number, easting: number, k: number, zone: string, unit: string }}
     */
    // An unknown zone or unit is an input error, not a reason to quietly use FL East / metres.
    function spcsZone(zoneKey, unit) {
        const zone = SPCS83_ZONES[zoneKey];
        if (!zone) throw new Error(`Unknown State Plane zone "${zoneKey}" (expected ${Object.keys(SPCS83_ZONES).join(", ")}).`);
        if (unit !== "sft" && unit !== "m") throw new Error(`Unknown State Plane unit "${unit}" (expected "sft" or "m").`);
        return zone;
    }

    function latLonToStatePlane(latDeg, lonDeg, zoneKey, unit = "sft") {
        const zone = spcsZone(zoneKey, unit);
        const phi = latDeg * D2R;
        const lam = lonDeg * D2R;
        let eastingM = 0, northingM = 0, k = 1.0;

        if (zone.proj === "TM") {
            const lam0 = zone.cmDeg * D2R;
            const phi0 = zone.origLatDeg * D2R;
            const dLam = lam - lam0;
            const N = GRS80_A / Math.sqrt(1 - GRS80_E2 * Math.sin(phi) * Math.sin(phi));
            const T = Math.tan(phi) * Math.tan(phi);
            const C = GRS80_EP2 * Math.cos(phi) * Math.cos(phi);
            const A = dLam * Math.cos(phi);
            const M = _tmMeridionalDist(phi);
            const M0 = _tmMeridionalDist(phi0);

            eastingM = zone.feM + zone.k0 * N * (A + (1 - T + C) * Math.pow(A, 3) / 6 + (5 - 18 * T + T * T + 72 * C - 58 * GRS80_EP2) * Math.pow(A, 5) / 120);
            northingM = zone.fnM + zone.k0 * (M - M0 + N * Math.tan(phi) * (A * A / 2 + (5 - T + 9 * C + 4 * C * C) * Math.pow(A, 4) / 24 + (61 - 58 * T + T * T + 600 * C - 330 * GRS80_EP2) * Math.pow(A, 6) / 720));
            k = zone.k0 * (1 + (1 + C) * A * A / 2 + (5 - 4 * T + 42 * C + 13 * C * C - 28 * GRS80_EP2) * Math.pow(A, 4) / 24);
        } else if (zone.proj === "LCC") {
            const init = _lccInit(zone);
            const lam0 = zone.cmDeg * D2R;
            const t = init.tFn(phi);
            const rho = GRS80_A * init.F * Math.pow(t, init.n);
            const theta = init.n * (lam - lam0);
            eastingM = zone.feM + rho * Math.sin(theta);
            northingM = zone.fnM + init.rho0 - rho * Math.cos(theta);
            const m = Math.cos(phi) / Math.sqrt(1 - GRS80_E2 * Math.sin(phi) * Math.sin(phi));
            k = (rho * init.n) / (GRS80_A * m);
        }

        const toFeet = unit === "sft";
        return {
            easting: toFeet ? eastingM * METER_TO_SFT : eastingM,
            northing: toFeet ? northingM * METER_TO_SFT : northingM,
            k,
            zone: zoneKey,
            unit
        };
    }

    /**
     * Convert Florida State Plane coordinates to natural WGS84 / NAD83 latitude & longitude.
     * @param {number} northing
     * @param {number} easting
     * @param {"FL_EAST"|"FL_WEST"|"FL_NORTH"} zoneKey
     * @param {"sft"|"m"} [unit="sft"]
     * @returns {{ latDeg: number, lonDeg: number, zone: string }}
     */
    function statePlaneToLatLon(northing, easting, zoneKey, unit = "sft") {
        const zone = spcsZone(zoneKey, unit);
        const toMeters = unit === "sft" ? SFT_TO_METER : 1.0;
        const xM = easting * toMeters;
        const yM = northing * toMeters;
        let latDeg = 0, lonDeg = 0;

        if (zone.proj === "TM") {
            const lam0 = zone.cmDeg * D2R;
            const phi0 = zone.origLatDeg * D2R;
            const M0 = _tmMeridionalDist(phi0);
            const M = M0 + (yM - zone.fnM) / zone.k0;
            const e1 = (1 - Math.sqrt(1 - GRS80_E2)) / (1 + Math.sqrt(1 - GRS80_E2));
            const mu = M / (GRS80_A * (1 - GRS80_E2 / 4 - 3 * GRS80_E2 * GRS80_E2 / 64 - 5 * Math.pow(GRS80_E2, 3) / 256));
            const phi1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu)
                            + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu)
                            + (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu)
                            + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);

            const sinP = Math.sin(phi1);
            const cosP = Math.cos(phi1);
            const tanP = Math.tan(phi1);
            const N1 = GRS80_A / Math.sqrt(1 - GRS80_E2 * sinP * sinP);
            const R1 = GRS80_A * (1 - GRS80_E2) / Math.pow(1 - GRS80_E2 * sinP * sinP, 1.5);
            const C1 = GRS80_EP2 * cosP * cosP;
            const T1 = tanP * tanP;
            const D = (xM - zone.feM) / (N1 * zone.k0);

            const lat = phi1 - (N1 * tanP / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * GRS80_EP2) * Math.pow(D, 4) / 24 + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * GRS80_EP2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);
            const lon = lam0 + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * GRS80_EP2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / cosP;
            latDeg = lat * R2D;
            lonDeg = lon * R2D;
        } else if (zone.proj === "LCC") {
            const init = _lccInit(zone);
            const lam0 = zone.cmDeg * D2R;
            const xP = xM - zone.feM;
            const yP = init.rho0 - (yM - zone.fnM);
            const rhoP = Math.sign(init.n) * Math.hypot(xP, yP);
            const thetaP = Math.atan2(xP, yP);
            const tP = Math.pow(rhoP / (GRS80_A * init.F), 1 / init.n);
            let phi = Math.PI / 2 - 2 * Math.atan(tP);
            for (let i = 0; i < 6; i++) {
                const es = GRS80_E * Math.sin(phi);
                const next = Math.PI / 2 - 2 * Math.atan(tP * Math.pow((1 - es) / (1 + es), GRS80_E / 2));
                if (Math.abs(next - phi) < 1e-13) break;
                phi = next;
            }
            latDeg = phi * R2D;
            lonDeg = (lam0 + thetaP / init.n) * R2D;
        }

        return { latDeg, lonDeg, zone: zoneKey };
    }

    /**
     * Compute Elevation Factor (EF) for a given ellipsoidal/orthometric height in feet.
     * EF = R / (R + h)
     */
    /** Finite number from a value, or throw — blank/invalid input is an error, never a silent default. */
    function requireNumber(v, label) {
        const n = typeof v === "number" ? v : (String(v == null ? "" : v).trim() === "" ? NaN : Number(v));
        if (!Number.isFinite(n)) throw new Error(`${label} must be a number (got ${JSON.stringify(v)}).`);
        return n;
    }

    function elevationFactor(elevationFt, meanRadiusFt = MEAN_EARTH_RADIUS_FT) {
        const h = requireNumber(elevationFt, "Elevation");
        return meanRadiusFt / (meanRadiusFt + h);
    }

    /**
     * Combined Scale Factor (CSF) = Grid Scale Factor (k) * Elevation Factor (EF).
     */
    function combinedScaleFactor(gridScaleK, elevationFt, meanRadiusFt = MEAN_EARTH_RADIUS_FT) {
        const k = requireNumber(gridScaleK, "Grid scale factor");
        if (k <= 0) throw new Error("Grid scale factor must be greater than zero.");
        return k * elevationFactor(elevationFt, meanRadiusFt);
    }

    /**
     * Ground distance to Grid distance: Grid = Ground * CSF
     */
    function groundToGridDistance(groundDist, csf) {
        const c = requireNumber(csf, "Combined scale factor");
        if (c <= 0) throw new Error("Combined scale factor must be greater than zero.");
        return requireNumber(groundDist, "Ground distance") * c;
    }

    /**
     * Grid distance to Ground distance: Ground = Grid / CSF
     */
    function gridToGroundDistance(gridDist, csf) {
        const c = requireNumber(csf, "Combined scale factor");
        if (c <= 0) throw new Error("Combined scale factor must be greater than zero.");
        return requireNumber(gridDist, "Grid distance") / c;
    }

    window.COGO = {
        D2R, R2D, SQFT_PER_ACRE,
        parseBearing, azimuthToBearing, advance,
        distanceBetween, azimuthDegBetween, includedAngleDeg,
        chordFromArc, deltaDegFromArc, shoelaceArea, signedShoelaceArea, circularSegmentArea,
        curveDirection, directionFromConcavity, bulge, normalizeDMS,
        runTraverse, pnezd, selfIntersects, buildDxf, downloadText,
        SPCS83_ZONES, latLonToStatePlane, statePlaneToLatLon,
        elevationFactor, combinedScaleFactor, groundToGridDistance, gridToGroundDistance
    };
})();
