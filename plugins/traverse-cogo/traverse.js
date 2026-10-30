/**
 * Plugin: traverse-cogo (Traverse & COGO)
 * plugins/traverse-cogo/traverse.js
 *
 * COGO traverse calculator with closure precision ratio, bowtie
 * bearing-quadrant detection, and QC checklist renderer.
 * Registers via window.PluginRegistry.
 */
(function () {
    const MANIFEST = {
        name: "traverse-cogo",
        version: "2.6.0",
        description: "COGO traverse calculator, closure report, and bowtie bearing detector.",
        tab: "tab-qc",
        icon: "fa-drafting-compass",
        tier: "Pro",
        dependencies: ["security-pki"]
    };

    // Default QC closure threshold (1:10,000). A firm/client preference, not a statutory value —
    // current Rule 5J-17.051 premises accuracy on survey type and expected use. Override per
    // client via the master template's "precisionPass" setting.
    const PRECISION_PASS_DEFAULT = 10000;
    // Pass threshold comes from the active client master template when one is set.
    function precisionPass() {
        const v = window.BoundaryQCCMS && window.BoundaryQCCMS.getActiveTemplateSetting
            ? window.BoundaryQCCMS.getActiveTemplateSetting("precisionPass", PRECISION_PASS_DEFAULT)
            : PRECISION_PASS_DEFAULT;
        return Number(v) || PRECISION_PASS_DEFAULT;
    }
    let _lastTraverse = null; // stashed for the Map Check Report export

    /** Zenith angle "89-30-00", "89 30 00", "89°30'00\"" or "89.5" → decimal degrees, or null. */
    function parseZenith(text) {
        const p = String(text).replace(/[°'"′″]/g, " ").split(/[\s-]+/).filter(Boolean).map(Number);
        if (!p.length || p.length > 3 || p.some(x => !isFinite(x) || x < 0)) return null;
        if ((p[1] != null && !(p[1] < 60)) || (p[2] != null && !(p[2] < 60))) return null;
        const z = p[0] + (p[1] || 0) / 60 + (p[2] || 0) / 3600;
        return z > 0 && z < 180 ? z : null;
    }

    /**
     * Parse a bearing/distance call list into courses. Delegates the bearing to
     * window.COGO.parseBearing (accepts "N 45-12-30 E", "North 45 degrees ... East",
     * "N45°12'30\"E", "N45d12m30sE", …), so this tab takes exactly the same formats
     * as the Legal Description and Linework tools.
     *
     * A call may end with a vertical part, which makes the traverse 3D:
     *   "N 45-12-30 E 150.00 DZ +1.25"   record data — horizontal distance and rise (−fall)
     *   "N 45-12-30 E 150.01 ZA 89-31-20" field data — slope distance and zenith angle
     * Either every course has one or none does (a mix is an error, never a zero filled in).
     * @returns {{courses: Array, skipped: Array<{line:number, text:string}>, errors: string[], is3d: boolean}}
     */
    function parseCourses(text) {
        const courses = [];
        const skipped = [];
        const errors = [];
        String(text || "").split(/\r?\n/).forEach((line, i) => {
            let s = line.trim();
            if (!s) return;
            let vert = null;
            const v = s.match(/\s+(DZ|ΔZ|ZA)\s*[=:]?\s*(\S.*?)\s*$/i);
            if (v) {
                s = s.slice(0, v.index).trim();
                const kind = v[1].toUpperCase() === "ZA" ? "za" : "dz";
                const val = kind === "za" ? parseZenith(v[2]) : (/^[+-]?\d+(?:\.\d+)?$/.test(v[2]) ? Number(v[2]) : null);
                if (val == null) { errors.push(`Line ${i + 1}: ${kind === "za" ? "zenith angle" : "DZ"} "${v[2]}" isn't valid${kind === "za" ? " (between 0° and 180°, e.g. 89-30-00)" : " (a signed number of feet, e.g. -1.25)"}.`); return; }
                vert = { kind, val };
            }
            const b = window.COGO.parseBearing(s);
            const d = s.match(/([\d,]+(?:\.\d+)?)\s*(?:feet|foot|ft|')?\s*$/i);
            if (!b || !d) { skipped.push({ line: i + 1, text: line.trim() }); return; }
            const given = parseFloat(d[1].replace(/,/g, ""));
            // ZA: the distance is a slope distance — reduce it to horizontal and rise.
            const dist = vert && vert.kind === "za" ? given * Math.sin(vert.val * Math.PI / 180) : given;
            const dz = !vert ? null : vert.kind === "za" ? given * Math.cos(vert.val * Math.PI / 180) : vert.val;
            const azRad = b.azimuthDeg * Math.PI / 180;
            courses.push({
                idx: courses.length + 1, line: i + 1, quad: b.quad, deg: b.deg, min: b.min, sec: b.sec,
                dist, azimuthDeg: b.azimuthDeg, azRad,
                latitude: dist * Math.cos(azRad),   // +N / -S
                departure: dist * Math.sin(azRad),   // +E / -W
                dz, zenith: vert && vert.kind === "za" ? vert.val : null, slopeDist: dz == null ? null : Math.hypot(dist, dz)
            });
        });
        const with3d = courses.filter(c => c.dz != null);
        if (with3d.length && with3d.length < courses.length) {
            errors.push(`Mixed 2D and 3D calls: line(s) ${courses.filter(c => c.dz == null).map(c => c.line).join(", ")} have no DZ or ZA. Give every course its vertical part for a 3D closure, or none for 2D.`);
        }
        return { courses, skipped, errors, is3d: courses.length > 0 && with3d.length === courses.length };
    }

    /**
     * Latitude/departure closure + bow-tie + Shoelace area for a set of courses.
     * All geometry goes through window.COGO so the traverse tab, linework editor,
     * and legal-description QC agree to the last decimal.
     */
    function computeClosure(courses, passThreshold, opts) {
        const thr = Number(passThreshold) || PRECISION_PASS_DEFAULT;
        // 3D when every course carries a rise (DZ, or reduced from a zenith angle); otherwise 2D.
        const is3d = courses.length > 0 && courses.every(c => c.dz != null && isFinite(c.dz));
        const startZ = opts && opts.startZ;
        if (is3d && !(typeof startZ === "number" && isFinite(startZ))) throw new Error("A 3D traverse needs the starting (POB) elevation.");
        const sumLat = courses.reduce((s, c) => s + c.latitude, 0);
        const sumDep = courses.reduce((s, c) => s + c.departure, 0);
        const sumZ = is3d ? courses.reduce((s, c) => s + c.dz, 0) : null;
        const horizontalPerimeter = courses.reduce((s, c) => s + c.dist, 0);
        const horizontalMisclosure = Math.hypot(sumLat, sumDep);
        // In 3D the closure is measured along the slope: misclosure √(ΔLat² + ΔDep² + ΔZ²) over the slope perimeter.
        const perimeter = is3d ? courses.reduce((s, c) => s + Math.hypot(c.dist, c.dz), 0) : horizontalPerimeter;
        const linearMisclosure = is3d ? Math.hypot(sumLat, sumDep, sumZ) : horizontalMisclosure;
        const precisionDenominator = linearMisclosure > 1e-9 ? perimeter / linearMisclosure : Infinity;
        const passes = precisionDenominator >= thr;

        // Direction from the computed end of the traverse back to the POB.
        const misclosureBearing = linearMisclosure > 1e-9
            ? window.COGO.azimuthToBearing(
                window.COGO.azimuthDegBetween({ e: 0, n: 0 }, { e: -sumDep, n: -sumLat }))
            : "—";

        // Walk the courses from an arbitrary origin
        const trace = [is3d ? { e: 0, n: 0, z: startZ } : { e: 0, n: 0 }];
        courses.forEach(c => {
            const prev = trace[trace.length - 1];
            trace.push(is3d ? { e: prev.e + c.departure, n: prev.n + c.latitude, z: prev.z + c.dz } : { e: prev.e + c.departure, n: prev.n + c.latitude });
        });
        // If the traverse closes back to the start, the last trace point duplicates the origin;
        // polygon corners (and PNEZD export) omit that duplicate closing copy.
        // For an open traverse that does not return to origin, retain all stations.
        const closes = courses.length >= 3 && (horizontalMisclosure <= 1e-4 || (horizontalMisclosure / (horizontalPerimeter || 1)) < 0.05);
        const verts = closes ? trace.slice(0, -1) : trace;
        const bowtie = verts.length >= 3 ? window.COGO.selfIntersects(verts) : null;
        const areaSqFt = closes && verts.length >= 3 ? window.COGO.shoelaceArea(verts) : 0;

        return {
            courses, is3d, startZ: is3d ? startZ : null, sumLat, sumDep, sumZ, perimeter, linearMisclosure, precisionDenominator,
            horizontalPerimeter, horizontalMisclosure,
            passThreshold: thr, passes, misclosureBearing, verts, bowtie, closes,
            areaSqFt, areaAcres: areaSqFt / window.COGO.SQFT_PER_ACRE
        };
    }

    function formatTraverseMapcheck(t) {
        if (!t) return "";
        const L = [];
        L.push("=== BoundaryQC Map Check Report — Traverse ===");
        L.push(`Generated: ${new Date().toISOString()}`);
        L.push("");
        L.push("[QA: Courses]");
        t.courses.forEach(c => {
            const d = window.COGO.normalizeDMS(c.deg, c.min, c.sec);
            const vert = !t.is3d ? "" : c.zenith != null ? `  (slope ${c.slopeDist.toFixed(2)} ft, zenith ${c.zenith.toFixed(4)}°)  ΔZ ${c.dz >= 0 ? "+" : ""}${c.dz.toFixed(3)} ft` : `  ΔZ ${c.dz >= 0 ? "+" : ""}${c.dz.toFixed(3)} ft`;
            L.push(`  ${c.idx}  ${c.quad} ${d.deg}°${String(d.min).padStart(2,"0")}'${String(d.sec).padStart(2,"0")}"  ${c.dist.toFixed(2)} ft${vert}`);
        });
        L.push("");
        L.push("[QA: Mathematical Closure & Area]");
        L.push(`  Closure: ${t.is3d ? `3D (horizontal and vertical; POB elevation ${t.startZ.toFixed(3)} ft)` : "2D (horizontal)"}`);
        if (t.is3d) {
            L.push(`  3D misclosure: ${t.linearMisclosure.toFixed(3)} ft  (ΔLat ${t.sumLat.toFixed(3)}, ΔDep ${t.sumDep.toFixed(3)}, ΔZ ${t.sumZ.toFixed(3)})`);
            L.push(`  Horizontal misclosure: ${t.horizontalMisclosure.toFixed(3)} ft`);
            L.push(`  Vertical misclosure: ${t.sumZ.toFixed(3)} ft`);
        } else {
            L.push(`  Linear misclosure: ${t.linearMisclosure.toFixed(3)} ft  (ΔLat ${t.sumLat.toFixed(3)}, ΔDep ${t.sumDep.toFixed(3)})`);
        }
        L.push(`  Misclosure course: ${t.misclosureBearing}`);
        L.push(`  Precision ratio: ${t.precisionDenominator === Infinity ? "exact" : "1 : " + Math.round(t.precisionDenominator).toLocaleString()}${t.is3d ? " (3D)" : ""}`);
        L.push(`  Perimeter: ${t.perimeter.toFixed(2)} ft${t.is3d ? ` along the slope (${t.horizontalPerimeter.toFixed(2)} ft horizontal)` : ""}`);
        L.push(`  Shoelace area: ${t.areaSqFt.toFixed(2)} sq ft = ${t.areaAcres.toFixed(2)} acres`);
        L.push(`  Status: ${t.passes && !t.bowtie ? "[PASS]" : "[FAIL/WARNING]"}`);
        L.push(`  Self-intersection: ${t.bowtie ? `YES — course ${t.bowtie.i} crosses course ${t.bowtie.j}` : "none"}`);
        L.push("");
        L.push("[Coordinate File — P,N,E,Z,D]");
        if (window.COGO) {
            L.push(window.COGO.pnezd(t.verts));
        }
        return L.join("\r\n");
    }

    function handleTraverseCalculation() {
        let input = document.getElementById("traverse-input")?.value.trim() || "";
        const resultsBox = document.getElementById("traverse-results");
        if (!resultsBox) return;
        resultsBox.classList.remove("hidden");

        if (!input) {
            input = "N 45-12-30 E 150.00\nS 44-47-30 E 200.00\nS 45-12-30 W 150.00\nN 44-47-30 W 200.00";
            const ta = document.getElementById("traverse-input");
            if (ta) ta.value = input;
        }

        const { courses, skipped, errors, is3d } = parseCourses(input);
        const zText = (document.getElementById("traverse-start-z")?.value || "").trim();
        if (is3d && zText === "") errors.push("Starting (POB) elevation is required for a 3D traverse — the calls have DZ / ZA.");
        else if (is3d && !isFinite(Number(zText))) errors.push(`Starting (POB) elevation "${zText}" isn't a number.`);
        if (errors.length) {
            _lastTraverse = null;
            window.setSafeHTML(resultsBox, `
                <div style="color:var(--danger);">
                    <strong><i class="fa-solid fa-triangle-exclamation"></i> The calls can't be closed yet:</strong>
                    <ul>${errors.map(e => `<li>${window.cleanText ? window.cleanText(e) : e}</li>`).join("")}</ul>
                </div>`);
            return;
        }

        if (courses.length < 3) {
            window.setSafeHTML(resultsBox, `
                <div style="color:var(--warning);">
                    <strong><i class="fa-solid fa-triangle-exclamation"></i> Need at least 3 parsable bearing/distance calls to close a polygon.</strong>
                    <p>Format example: <code>N 45-12-30 E 150.00</code></p>
                    ${skipped.length ? `<p style="font-size:0.8rem;">Skipped ${skipped.length} unparsed line(s): ${skipped.map(s => "L" + s.line).join(", ")}</p>` : ""}
                </div>`);
            return;
        }

        const passThreshold = precisionPass();
        const cl = computeClosure(courses, passThreshold, { startZ: is3d ? Number(zText) : null });
        const { sumLat, sumDep, perimeter, linearMisclosure, precisionDenominator, passes,
            misclosureBearing, bowtie, areaSqFt, areaAcres } = cl;
        _lastTraverse = cl;

        if (window.Reports?.addReport) {
            window.Reports.addReport({
                title: `Traverse Map Check (${cl.courses.length} Courses)`,
                type: "traverse-mapcheck",
                category: "cogo",
                format: "log",
                filename: "traverse_mapcheck.log",
                content: formatTraverseMapcheck(cl),
                metadata: { linearMisclosure: cl.linearMisclosure, precision: cl.precisionDenominator, area: cl.areaAcres }
            });
        }

        const ratioText = precisionDenominator === Infinity
            ? "exact (0.000 ft misclosure)"
            : `1 : ${Math.round(precisionDenominator).toLocaleString()}`;

        window.setSafeHTML(resultsBox, `
            <div style="display:flex; flex-direction:column; gap:0.5rem;">
                <h4 style="color:var(--text-primary); font-size:1rem; font-weight:700;">
                    <i class="fa-solid fa-square-check" style="color:var(--success);"></i> Polygon &amp; Traversal Verification Results
                </h4>
                <p style="font-size:0.85rem; color:var(--text-secondary);">Parsed ${courses.length} courses | <strong>${cl.is3d ? "3D closure" : "2D closure"}</strong> | Perimeter: <strong>${perimeter.toFixed(2)} ft</strong>${cl.is3d ? ` along the slope (${cl.horizontalPerimeter.toFixed(2)} ft horizontal)` : ""} | Shoelace area: <strong>${areaAcres.toFixed(3)} ac</strong> (${areaSqFt.toFixed(0)} sf)</p>
                ${skipped.length ? `<p style="font-size:0.78rem; color:var(--warning);"><i class="fa-solid fa-triangle-exclamation"></i> Skipped ${skipped.length} unparsed line(s): ${skipped.map(s => "L" + s.line + ' "' + s.text.slice(0, 30) + '"').join("; ")}</p>` : ""}
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; margin-top:0.5rem;">
                    <div style="background:var(--bg-surface); padding:0.75rem; border-radius:var(--radius-sm);">
                        <small style="color:var(--text-muted);">${cl.is3d ? "3D Misclosure" : "Linear Misclosure (2D)"}</small>
                        <div style="font-weight:700; color:var(--text-primary);">${linearMisclosure.toFixed(4)} ft</div>
                        <small style="color:var(--text-muted);">ΔLat ${sumLat.toFixed(4)} · ΔDep ${sumDep.toFixed(4)}${cl.is3d ? ` · ΔZ ${cl.sumZ.toFixed(4)}<br>horizontal ${cl.horizontalMisclosure.toFixed(4)} ft · vertical ${cl.sumZ.toFixed(4)} ft` : ""}</small>
                    </div>
                    <div style="background:var(--bg-surface); padding:0.75rem; border-radius:var(--radius-sm);">
                        <small style="color:var(--text-muted);">Precision Ratio</small>
                        <div style="font-weight:700; color:${passes ? 'var(--success)' : 'var(--danger)'};">${ratioText} (${passes ? 'PASS' : 'REVIEW'})</div>
                        <small style="color:var(--text-muted);">Misclosure course: ${misclosureBearing}</small>
                    </div>
                </div>
                <div style="margin-top:0.5rem; padding:0.75rem; background:${bowtie ? 'var(--danger-light)' : 'var(--success-light)'}; border-radius:var(--radius-sm); border-left:3px solid ${bowtie ? 'var(--danger)' : 'var(--success)'}; font-size:0.85rem;">
                    ${bowtie
                        ? `<strong style="color:var(--danger);"><i class="fa-solid fa-triangle-exclamation"></i> Bow-tie / self-intersecting boundary detected.</strong><p>Course ${bowtie.i} crosses course ${bowtie.j} in the plotted polygon. Check the bearing quadrant or call order on those lines.</p>`
                        : `<strong style="color:var(--success);"><i class="fa-solid fa-circle-check"></i> No self-intersection:</strong> the plotted polygon boundary does not cross itself.`
                    }
                </div>
                ${passes ? '' : `<small style="color:var(--danger);">Misclosure exceeds 1:${passThreshold.toLocaleString()} — review course bearings/distances before certifying.</small>`}
            </div>`);
    }

    function renderQcChecklist() {
        const container = document.getElementById("qc-items-container");
        if (!container) return;
        container.replaceChildren();
        (window.FDOT_DATA?.qcChecklist || []).forEach(qc => {
            const div = document.createElement("div");
            div.className = `qc-item ${qc.status?.toLowerCase() || "pass"}`;
            window.setSafeHTML(div, `
                <div class="qc-item-icon">
                    <i class="fa-solid ${qc.status === "FAIL" ? "fa-xmark" : (qc.status === "WARN" ? "fa-triangle-exclamation" : "fa-check")}"></i>
                </div>
                <div class="qc-item-content">
                    <h4>${qc.title} <span class="tag tag-discipline">${qc.category}</span></h4>
                    <p>${qc.desc}</p>
                </div>`);
            container.appendChild(div);
        });
    }

    function renderHeuristics() {
        const list = document.getElementById("heuristics-list");
        if (!list) return;
        list.replaceChildren();
        (window.FDOT_DATA?.heuristics || []).forEach(h => {
            const li = document.createElement("li");
            li.style.cssText = "padding:0.5rem 0; border-bottom:1px solid var(--glass-border); font-size:0.85rem; color:var(--text-secondary);";
            window.setSafeHTML(li, `<strong style="color:var(--primary);">${h.rule}:</strong> ${h.description}`);
            list.appendChild(li);
        });
    }

    /**
     * Generate Civil 3D Survey Command Language script from computed traverse courses.
     */
    function buildTraverseScript(traverse) {
        if (!traverse || !traverse.courses || !traverse.courses.length) return "";
        const lines = [];
        lines.push("// Civil 3D Survey Command Script — Generated from BoundaryQC Traverse");
        lines.push(`// Generated: ${new Date().toISOString()}`);
        lines.push(`// ${traverse.is3d ? "3D" : "2D"} Linear Misclosure: ${traverse.linearMisclosure.toFixed(4)} ft | Precision: ${traverse.precisionDenominator === Infinity ? "exact" : "1:" + Math.round(traverse.precisionDenominator).toLocaleString()}`);
        lines.push("// Compatible with Civil 3D Survey Command Window (Batch) & Field Book (.FBK)");
        lines.push("");
        lines.push("START_BATCH");
        lines.push("UNIT FOOT DMS");
        lines.push("");

        // traverse.verts (from computeClosure) is ALREADY the correct vertex
        // list — trimmed of the duplicate-of-POB closing point when the
        // traverse actually closes, left intact (every real station kept)
        // when it doesn't. Slicing it again here was dropping a genuine
        // corner even in the ordinary closed case (a 4-corner closed square
        // exported only 3 FIG PT / NEZ lines).
        const verts = traverse.verts || [];
        if (verts.length >= 2) {
            lines.push("// Plant Computed Coordinate Points (PNEZD)");
            verts.forEach((v, idx) => {
                const ptNum = 500 + idx;
                const desc = idx === 0 ? "TRAV_POB" : `TRAV_PT_${idx}`;
                lines.push(`NEZ ${ptNum} ${v.n.toFixed(4)} ${v.e.toFixed(4)} ${(isFinite(v.z) ? v.z : 0).toFixed(4)} "${desc}"`);
            });
            lines.push("");
            lines.push("// Define Survey Traverse Boundary Figure");
            lines.push("FIG BEGIN TRAVERSE_BOUNDARY");
            verts.forEach((v, idx) => {
                const ptNum = 500 + idx;
                lines.push(`FIG PT ${ptNum}`);
            });
            if (traverse.closes) lines.push("FIG CLOSE");
            lines.push("FIG END");
            lines.push("");
        }

        lines.push("// Traverse Observation Courses (Bearing / Distance)");
        lines.push("STN 500 0.00 \"TRAV_POB\"");
        traverse.courses.forEach((c, idx) => {
            const destPt = 501 + idx;
            const quadNum = c.quad === "NE" ? 1 : (c.quad === "SE" ? 2 : (c.quad === "SW" ? 3 : 4));
            const d = window.COGO.normalizeDMS(c.deg, c.min, c.sec);
            const dms = `${d.deg}.${String(d.min).padStart(2, "0")}${String(d.sec).padStart(2, "0")}`;
            lines.push(`BD ${destPt} ${quadNum} ${dms} ${c.dist.toFixed(2)} "COURSE_${c.idx}"`);
        });
        lines.push("");
        // The point AFTER the last course (500 + courses.length, i.e. the
        // final BD command's destination) — not "- 1" (the second-to-last
        // corner) — is the one that actually shows the real misclosure back
        // to 500; comparing against the second-to-last corner instead just
        // measures an ordinary course length and reports it as "misclosure".
        lines.push("// Compute Misclosure & Inverse Analysis");
        lines.push(`INV 500 ${500 + traverse.courses.length}`);
        lines.push("END_BATCH");
        return lines.join("\r\n") + "\r\n";
    }

    const Plugin = {
        init() {
            renderQcChecklist();
            renderHeuristics();
        },

        setupEvents(ctx) {
            const { showToast } = ctx;
            document.getElementById("btn-calc-traverse")?.addEventListener("click", handleTraverseCalculation);
            document.getElementById("btn-sample-traverse")?.addEventListener("click", () => {
                const ta = document.getElementById("traverse-input");
                if (ta) ta.value = "N 45-12-30 E 150.00\nS 44-47-30 E 200.00\nS 45-12-30 W 150.00\nN 44-47-30 W 200.00";
                handleTraverseCalculation();
            });
            document.getElementById("btn-gen-qc-report")?.addEventListener("click", () => {
                if (!_lastTraverse) handleTraverseCalculation();
                if (!_lastTraverse) { showToast("Run the traverse calculation first.", true); return; }
                const report = formatTraverseMapcheck(_lastTraverse);
                if (window.Reports?.addReport) {
                    window.Reports.addReport({
                        title: `Traverse Map Check (${_lastTraverse.courses.length} Courses)`,
                        type: "traverse-mapcheck",
                        category: "cogo",
                        format: "log",
                        filename: "traverse_mapcheck.log",
                        content: report,
                        metadata: { linearMisclosure: _lastTraverse.linearMisclosure, precision: _lastTraverse.precisionDenominator, area: _lastTraverse.areaAcres }
                    });
                }
                if (window.COGO) window.COGO.downloadText("traverse_mapcheck.log", report);
                showToast("Map Check Report exported & stored in Reports Hub.");
            });
            document.getElementById("btn-calc-traverse-script")?.addEventListener("click", () => {
                if (!_lastTraverse) { showToast("Run the traverse calculation first.", true); return; }
                const script = buildTraverseScript(_lastTraverse);
                if (window.COGO) window.COGO.downloadText("traverse_survey.fbk", script, "text/plain");
                showToast("Exported Civil 3D Survey Script (.fbk).");
            });
        }
    };

    window.PluginRegistry.register(MANIFEST, Plugin);

    // Exposed for console debugging / tests.
    window.TraverseCogo = { parseCourses, parseZenith, computeClosure, buildTraverseScript, formatTraverseMapcheck };
})();
