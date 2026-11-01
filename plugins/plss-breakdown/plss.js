/**
 * Plugin: plss-breakdown (PLSS Section Breakdown)
 * plugins/plss-breakdown/plss.js
 *
 * Ported from the BoundaryQC desktop app (Services/PlssDrafter.cs +
 * .agents/rules/plss-section-breakdown.md). Parses a Public Land Survey System
 * aliquot description ("S 1/2 of the SE 1/4 of the NE 1/4 of Section 8, T7N, R7E"),
 * subdivides an ideal 5280 x 5280 ft section, and reports rectangle dimensions,
 * computed vs ideal acreage, the four cardinal-bearing courses, and a P,N,E,Z,D
 * coordinate file (points from 500).
 *
 * Registers via window.PluginRegistry. Depends on core/cogo.js (window.COGO).
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "plss-breakdown",
        version: "1.0.0",
        description: "PLSS aliquot section-breakdown: 5280 ft ideal-section subdivision, acreage check, cardinal courses, and PNEZD export.",
        tab: "tab-plss",
        icon: "fa-table-cells-large",
        tier: "Pro",
        dependencies: []
    };

    const SECTION_FT = 5280;
    const SQFT_PER_ACRE = 43560;
    let _last = null;

    // ── Parsing ──────────────────────────────────────────────────────────────

    function parseHeader(text) {
        const sec = text.match(/section\s+(\w+)/i);
        const twp = text.match(/township\s+(\d+)\s*(north|south|n|s)\b/i) || text.match(/\bT\.?\s*(\d+)\s*([NS])\b/i);
        const rng = text.match(/range\s+(\d+)\s*(east|west|e|w)\b/i) || text.match(/\bR\.?\s*(\d+)\s*([EW])\b/i);
        const norm = (n, d) => n ? `${n} ${d[0].toUpperCase()}` : "";
        return {
            section: sec ? sec[1] : "",
            township: twp ? norm(twp[1], twp[2]) : "",
            range: rng ? norm(rng[1], rng[2]) : ""
        };
    }

    /** Pull the aliquot fraction chain (reading order, outermost last) from a description. */
    function parseFractions(text) {
        const head = text.split(/\bsection\b/i)[0] || text;
        // Normalize spelled-out compass words to codes.
        const norm = head
            .replace(/\bnortheast\b/gi, "NE").replace(/\bnorthwest\b/gi, "NW")
            .replace(/\bsoutheast\b/gi, "SE").replace(/\bsouthwest\b/gi, "SW")
            .replace(/\bnorth\b/gi, "N").replace(/\bsouth\b/gi, "S")
            .replace(/\beast\b/gi, "E").replace(/\bwest\b/gi, "W");
        const parts = norm.split(/\s+of\s+(?:the\s+)?/i).map(s => s.trim()).filter(Boolean);
        const frac = [];
        for (const p of parts) {
            // quarter → NE/NW/SE/SW ; half → N/S/E/W ; require an explicit fraction/quarter/half token
            const q = p.match(/\b(NE|NW|SE|SW)\s*(?:1\/4|¼|quarter)/i);
            if (q) { frac.push(q[1].toUpperCase()); continue; }
            const h = p.match(/\b([NSEW])\s*(?:1\/2|½|half)/i);
            if (h) { frac.push(h[1].toUpperCase()); continue; }
            // bare "NE 1/4" already covered; allow bare quarter code with trailing 1/4 dropped
            const bareQ = p.match(/^\s*(NE|NW|SE|SW)\s*$/i);
            if (bareQ) frac.push(bareQ[1].toUpperCase());
        }
        return frac; // e.g. ["S", "SE", "NE"]  (reading order)
    }

    function isQualified(text) {
        return /\bthat\s+part\s+of\b/i.test(text) ||
               /\bwithin\s+[\d.]+\s*(?:feet|ft|')\s+of\b/i.test(text) ||
               /\bexcepting\s+any\s+part\b/i.test(text) ||
               /\bwhich\s+lies\s+(?:north|south|east|west)/i.test(text);
    }

    /** Port of PlssDrafter.ComputePlssBoundingBox — subdivide the section box. */
    function computeBox(fractions) {
        let box = { minX: 0, maxX: SECTION_FT, minY: 0, maxY: SECTION_FT };
        for (let i = fractions.length - 1; i >= 0; i--) {
            const f = fractions[i].toUpperCase().replace(/\s|\./g, "");
            const midX = box.minX + (box.maxX - box.minX) / 2;
            const midY = box.minY + (box.maxY - box.minY) / 2;
            if (f.includes("NE"))      { box.minX = midX; box.minY = midY; }
            else if (f.includes("NW")) { box.maxX = midX; box.minY = midY; }
            else if (f.includes("SE")) { box.minX = midX; box.maxY = midY; }
            else if (f.includes("SW")) { box.maxX = midX; box.maxY = midY; }
            else if (f === "N")        { box.minY = midY; }
            else if (f === "S")        { box.maxY = midY; }
            else if (f === "E")        { box.minX = midX; }
            else if (f === "W")        { box.maxX = midX; }
        }
        return box;
    }

    function analyzeParcel(text) {
        const fractions = parseFractions(text);
        const qualified = isQualified(text);
        const box = computeBox(fractions);
        const width = box.maxX - box.minX;   // E–W
        const height = box.maxY - box.minY;  // N–S
        const sqft = width * height;
        const acres = sqft / SQFT_PER_ACRE;

        // ideal acreage: quarter subdivisions count toward depth; halves add a factor of 1/2
        let ideal = 640;
        fractions.forEach(f => { ideal *= (f.length === 2 ? 0.25 : 0.5); });

        const statedM = text.match(/([\d,]+(?:\.\d+)?)\s*(?:\+\/-\s*)?acres?/i);
        const stated = statedM ? parseFloat(statedM[1].replace(/,/g, "")) : null;

        // corners CCW from SW; cardinal-bearing courses
        const verts = [
            { e: box.minX, n: box.minY },
            { e: box.maxX, n: box.minY },
            { e: box.maxX, n: box.maxY },
            { e: box.minX, n: box.maxY }
        ];
        const courses = [
            { call: "L1", bearing: 'N 90°00\'00" E', dist: width },
            { call: "L2", bearing: 'N 00°00\'00" E', dist: height },
            { call: "L3", bearing: 'N 90°00\'00" W', dist: width },
            { call: "L4", bearing: 'S 00°00\'00" W', dist: height }
        ];

        return {
            text, fractions, qualified, box, width, height, sqft, acres,
            idealAcres: ideal, statedAcres: stated, verts, courses
        };
    }

    function analyze(text) {
        const header = parseHeader(text);
        // one description block per line / per "Parcel N:" / per "That part of"
        const blocks = text.split(/(?:\r?\n)+|\bparcel\s+\d+\s*[:.]/i)
            .map(s => s.trim()).filter(s => /\b([NS][EW]|[NSEW])\b.*(?:1\/4|1\/2|¼|½|quarter|half)/i.test(s));
        const parcels = (blocks.length ? blocks : [text]).map(analyzeParcel).filter(p => p.fractions.length);
        return { header, parcels, rawText: text };
    }

    // ── Report ──────────────────────────────────────────────────────────────

    function report(result) {
        const L = [];
        L.push("=== BoundaryQC — PLSS Section Breakdown ===");
        L.push(`Generated: ${new Date().toISOString()}`);
        L.push(`Section ${result.header.section || "?"}, Township ${result.header.township || "?"}, Range ${result.header.range || "?"}`);
        L.push(`Ideal government section: 640 acres, ${SECTION_FT.toFixed(2)} ft x ${SECTION_FT.toFixed(2)} ft`);
        L.push("");
        result.parcels.forEach((p, i) => {
            L.push(`Parcel ${i + 1}: ${p.fractions.join(" of ")} of Section ${result.header.section || "?"}`);
            if (p.qualified) L.push("  [!] QUALIFIED PLSS ('that part of' / offset strip / EXCEPTING) — the rectangle below is the GROSS parent only; the true parcel is an irregular polygon trimmed by R/W and offset lines.");
            L.push(`  Rectangle: ${p.width.toFixed(2)} ft (E-W) x ${p.height.toFixed(2)} ft (N-S)`);
            L.push(`  Computed area: ${p.sqft.toFixed(2)} sq ft = ${p.acres.toFixed(2)} acres`);
            L.push(`  Ideal aliquot area: ${p.idealAcres.toFixed(2)} acres`);
            if (p.statedAcres != null) {
                const d = Math.abs(p.acres - p.statedAcres);
                L.push(`  Stated area: ${p.statedAcres.toFixed(2)} acres  ${d > 0.05 ? `[!] mismatch ${d.toFixed(2)} ac` : "(matches)"}`);
            }
            L.push("  Courses (true cardinal bearings, exact close):");
            p.courses.forEach(c => L.push(`    ${c.call}  ${c.bearing}  ${c.dist.toFixed(2)} ft`));
            L.push("  Coordinate file — P,N,E,Z,D:");
            L.push(window.COGO.pnezd(p.verts, 500 + i * 100));
        });
        return L.join("\r\n");
    }

    // ── Render ──────────────────────────────────────────────────────────────

    function run(ctx) {
        const input = document.getElementById("plss-input")?.value.trim() || "";
        const box = document.getElementById("plss-results");
        if (!box) return;
        box.classList.remove("hidden");
        if (!input) {
            window.setSafeHTML(box, `<strong style="color:var(--danger);">Enter a PLSS aliquot description.</strong>`);
            return;
        }
        const result = analyze(input);
        _last = result;

        if (!result.parcels.length) {
            window.setSafeHTML(box, `<div style="color:var(--warning);"><strong><i class="fa-solid fa-triangle-exclamation"></i> No aliquot fractions recognized.</strong><p>Try: <code>S 1/2 of the SE 1/4 of the NE 1/4 of Section 8, Township 7 North, Range 7 East</code></p></div>`);
            return;
        }

        const cards = result.parcels.map((p, i) => `
            <div style="background:var(--bg-surface); padding:0.85rem; border-radius:var(--radius-sm); margin-top:0.6rem; border-left:3px solid ${p.qualified ? 'var(--warning)' : 'var(--success)'};">
              <strong style="color:var(--text-main);">Parcel ${i + 1}: ${p.fractions.join(" of ")}</strong>
              ${p.qualified ? `<div style="color:var(--warning); font-size:0.78rem; margin-top:0.3rem;"><i class="fa-solid fa-triangle-exclamation"></i> Qualified PLSS — rectangle shown is the gross parent container only.</div>` : ""}
              <div style="display:grid; grid-template-columns:1fr 1fr; gap:0.6rem; margin-top:0.5rem; font-size:0.82rem;">
                <div><small style="color:var(--text-muted);">Dimensions</small><div style="font-weight:700; font-family:var(--font-mono);">${p.width.toFixed(2)} × ${p.height.toFixed(2)} ft</div></div>
                <div><small style="color:var(--text-muted);">Computed area</small><div style="font-weight:700;">${p.acres.toFixed(2)} ac <span style="color:var(--text-muted); font-weight:400;">(${p.sqft.toFixed(0)} sf)</span></div></div>
                <div><small style="color:var(--text-muted);">Ideal aliquot</small><div style="font-weight:700; color:var(--success);">${p.idealAcres.toFixed(2)} ac</div></div>
                <div><small style="color:var(--text-muted);">Stated</small><div style="font-weight:700; color:${p.statedAcres != null && Math.abs(p.acres - p.statedAcres) > 0.05 ? 'var(--danger)' : 'var(--text-main)'};">${p.statedAcres != null ? p.statedAcres.toFixed(2) + " ac" : "—"}</div></div>
              </div>
              <div style="margin-top:0.5rem; font-size:0.78rem; font-family:var(--font-mono); color:var(--text-secondary);">
                ${p.courses.map(c => `${c.call} ${c.bearing} ${c.dist.toFixed(2)}'`).join("<br>")}
              </div>
            </div>`).join("");

        window.setSafeHTML(box, `
            <h4 style="font-size:1rem; font-weight:700;"><i class="fa-solid fa-table-cells-large" style="color:var(--success);"></i>
              Section ${result.header.section || "?"}, ${result.header.township || "T?"}, ${result.header.range || "R?"} · ${result.parcels.length} parcel(s)</h4>
            <p style="font-size:0.8rem; color:var(--text-muted);">Ideal section = 640 ac, ${SECTION_FT.toFixed(2)}′ × ${SECTION_FT.toFixed(2)}′. Ideal aliquot rectangles close exactly.</p>
            ${cards}`);

        if (ctx) ctx.showToast(`PLSS: ${result.parcels.length} parcel(s), ${result.parcels.reduce((s, p) => s + p.acres, 0).toFixed(2)} ac total.`);
    }

    const Plugin = {
        init() {
            const ta = document.getElementById("plss-input");
            if (ta && !ta.value) {
                ta.value = "S 1/2 of the SE 1/4 of the NE 1/4 of Section 8, Township 7 North, Range 7 East";
            }
        },
        setupEvents(ctx) {
            document.getElementById("btn-run-plss")?.addEventListener("click", () => run(ctx));
            document.getElementById("btn-plss-pnezd")?.addEventListener("click", () => {
                if (!_last || !_last.parcels.length) { ctx.showToast("Run a breakdown first.", true); return; }
                const rows = ["P,N,E,Z,D"];
                _last.parcels.forEach((p, i) => {
                    p.verts.forEach((v, k) => {
                        rows.push(`${500 + i * 100 + k},${v.n.toFixed(3)},${v.e.toFixed(3)},0.000,${k === 0 ? "COGO POB" : "COGO P" + k} P${i + 1}`);
                    });
                });
                window.COGO.downloadText("plss_breakdown_coordinates.txt", rows.join("\r\n") + "\r\n", "text/csv");
                ctx.showToast("Exported P,N,E,Z,D coordinate file.");
            });
            document.getElementById("btn-plss-report")?.addEventListener("click", () => {
                if (!_last || !_last.parcels.length) { ctx.showToast("Run a breakdown first.", true); return; }
                const reportContent = report(_last);
                if (window.Reports?.addReport) {
                    window.Reports.addReport({
                        title: "PLSS Aliquot Section Breakdown Report",
                        type: "plss-breakdown",
                        category: "plss",
                        format: "log",
                        filename: "plss_breakdown_report.log",
                        content: reportContent
                    });
                }
                window.COGO.downloadText("plss_breakdown_report.log", reportContent);
                ctx.showToast("Exported PLSS breakdown report & stored in Reports Hub.");
            });
        },
        onTabActivate(ctx) { if (_last) run(ctx); }
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);

    // Exposed for console debugging / tests.
    window.PlssBreakdown = { analyze, computeBox, analyzeParcel, parseFractions };
})();
