/**
 * Plugin: materials (Materials)
 * plugins/materials/materials.js
 *
 * One reference tab for utility materials:
 *   - every material / equipment list in the JEA As-Built Standards 2024
 *     template, read live from window.Jea24Data.DOMAINS (never copied);
 *   - pipe sizes in imperial and metric — nominal size, DN, and outside
 *     diameter in inches and millimetres for each sizing system (IPS, DIPS,
 *     PVC sewer, CTS) — plus the JEA standard size list;
 *   - pipe systems, appurtenances and typical fittings for water, sewer and
 *     gas service lines (plugins/materials/materials-data.js).
 * Search, utility and units filters; CSV export of what is shown.
 *
 * Reference data — verify against the governing standard, the utility's
 * current specifications and the manufacturer before design or procurement.
 * Depends on plugins/tmplt-jea2024/jea-data.js and materials-data.js.
 * Exposes window.Materials for the test suite.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "materials",
        version: "1.0.0",
        description: "Utility materials reference: JEA template material lists, pipe sizes (imperial + metric), pipe systems, appurtenances and fittings for water, sewer and gas.",
        tab: "tab-materials",
        icon: "fa-cubes",
        tier: "Free",
        dependencies: ["tmplt-jea2024"]
    };

    const clean = window.cleanText;
    const D = window.MaterialsData;

    // ── JEA template materials ──────────────────────────────────────────────

    // How the JEA template's domains are grouped on this tab. Every domain must be either
    // grouped here or listed in JEA_NOT_MATERIALS — the tests fail if a new domain appears in
    // the template without being placed, so nothing can be silently left off.
    const JEA_GROUPS = [
        { group: "Pipe & fitting materials", domains: ["Pipe and Fitting Material"] },
        { group: "Pipe classes", domains: ["Water/Reclaimed Pipe Class", "Sewer Pipe Class", "Chilled Pipe Class"] },
        { group: "Pipe linings", domains: ["Water/Reclaimed/Chilled Pipe Lining Material", "Sewer Pipe Lining Material"] },
        { group: "Pipe types", domains: ["Subtype Water Pipe", "Subtype Sewer Gravity Pipe", "Subtype Sewer Pressure Pipe", "Subtype Reclaimed Pipe", "Chilled Pipe Role", "Crossing Pipe Type"] },
        { group: "Fittings", domains: ["Subtype Water Fitting", "Subtype Sewer Fitting", "Subtype Reclaimed Fitting", "Subtype Chilled Fitting"] },
        { group: "Valves & hydrants", domains: ["Valve Type", "Subtype Water Valve", "Subtype Sewer Valve", "Subtype Reclaimed Valve", "Valve Open Direction", "Hydrant Model"] },
        { group: "Manholes", domains: ["Subtype Manhole", "Manhole Type", "Manhole Material", "Manhole Lining Material", "Manhole Drop Type", "Manhole Exterior Joint Tape Manufacturer"] },
        { group: "Meters, boxes & customer points", domains: ["Subtype Water Meter", "Subtype Reclaimed Meter", "Meter Box Material", "Subtype Locate Box", "Subtype Sewer Customer Point"] },
        { group: "Manufacturers", domains: ["Pipe Manufacturers", "Fitting Manufacturers", "Valve Manufacturer", "Manhole Manufacturer", "Meter Box Manufacturer"] },
        { group: "Sizes", domains: ["Size Inches", "Meter Size Inches", "Size Feet"] }
    ];
    const JEA_NOT_MATERIALS = ["County", "Facility Owner", "Orientation", "Pipe Location"];
    // JEA size codes that are not sizes (shown as codes, never converted).
    const isSizeCode = v => /^-99\d$/.test(String(v));

    /** The JEA template's material lists, grouped; `missing` names any grouped domain the template lacks. */
    function jeaMaterialGroups(domains) {
        const dom = domains || (window.Jea24Data && window.Jea24Data.DOMAINS) || {};
        const missing = [];
        const groups = JEA_GROUPS.map(g => ({
            group: g.group,
            lists: g.domains.filter(name => { if (!dom[name]) { missing.push(name); return false; } return true; })
                .map(name => ({ name, values: dom[name].slice() }))
        }));
        const placed = new Set(JEA_GROUPS.flatMap(g => g.domains).concat(JEA_NOT_MATERIALS));
        const unplaced = Object.keys(dom).filter(k => !placed.has(k));
        return { groups, missing, unplaced };
    }

    // ── Sizes and units ─────────────────────────────────────────────────────

    const inToMm = inches => inches * 25.4;

    /** Nominal size (inches) → DN designation, or null when there is no standard DN. */
    function nominalToDN(nominalIn) {
        const v = D.DN[String(Number(nominalIn))];
        return v === undefined ? null : v;
    }

    /** 0.75 → "3/4", 1.25 → "1-1/4", 6 → "6". Eighths and quarters only; anything else as a decimal. */
    function formatNominal(n) {
        const x = Number(n);
        if (!Number.isFinite(x)) return String(n);
        const whole = Math.floor(x), frac = Math.round((x - whole) * 8);
        if (frac === 0) return String(whole);
        if (Math.abs((x - whole) * 8 - frac) > 1e-9) return String(x);
        const g = frac % 4 === 0 ? 4 : frac % 2 === 0 ? 2 : 1;
        const f = `${frac / g}/${8 / g}`;
        return whole ? `${whole}-${f}` : f;
    }

    /** Size rows for a sizing system: nominal (in), DN, nominal in mm, OD (in) and OD (mm, computed). */
    function sizeRows(systemId) {
        const sys = D.SIZE_SYSTEMS.find(s => s.id === systemId);
        if (!sys) return [];
        return Object.keys(sys.od).map(Number).sort((a, b) => a - b).map(n => ({
            nominalIn: n, label: formatNominal(n), dn: nominalToDN(n),
            nominalMm: inToMm(n), odIn: sys.od[String(n)], odMm: inToMm(sys.od[String(n)])
        }));
    }

    /** The JEA standard sizes (Size Inches domain) with DN and mm; codes such as -998 / -999 listed apart. */
    function jeaSizeRows(domains) {
        const dom = domains || (window.Jea24Data && window.Jea24Data.DOMAINS) || {};
        const list = dom["Size Inches"] || [];
        return {
            sizes: list.filter(v => !isSizeCode(v)).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
                .map(n => ({ nominalIn: n, label: formatNominal(n), dn: nominalToDN(n), nominalMm: inToMm(n) })),
            codes: list.filter(isSizeCode)
        };
    }

    // ── Filtering and export ────────────────────────────────────────────────

    /** Rows matching a utility ("All" = any) and a free-text query over every string field. */
    function filterRows(rows, opts) {
        const o = opts || {};
        const q = String(o.query || "").trim().toLowerCase();
        return (rows || []).filter(r =>
            (!o.utility || o.utility === "All" || r.utility === o.utility) &&
            (!q || Object.values(r).some(v => typeof v === "string" && v.toLowerCase().includes(q))));
    }

    /** CSV text (RFC 4180 quoting) from a header list and rows of values. */
    function toCsv(headers, rows) {
        const q = v => { const s = v == null ? "" : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        return [headers.map(q).join(",")].concat(rows.map(r => r.map(q).join(","))).join("\r\n") + "\r\n";
    }

    // ── Render ──────────────────────────────────────────────────────────────

    const $ = id => document.getElementById(id);
    const f3 = v => v.toFixed(3), f1 = v => v.toFixed(1);
    let _view = null;      // what is on screen, for CSV export

    function opts() {
        return { query: $("mat-search").value, utility: $("mat-utility").value, units: $("mat-units").value, system: $("mat-system").value };
    }

    function renderControls() {
        const root = $("materials-root");
        if (!root) return;
        window.setSafeHTML(root, `
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap:0.75rem;">
                <div class="form-group"><label for="mat-search">Search materials</label><input id="mat-search" type="text" placeholder="e.g. PVC, gate valve, DR 18"></div>
                <div class="form-group"><label for="mat-utility">Utility</label>
                    <select id="mat-utility"><option>All</option><option>Water</option><option>Sewer</option><option>Gas</option></select></div>
                <div class="form-group"><label for="mat-units">Units</label>
                    <select id="mat-units"><option value="both">Imperial + metric</option><option value="imperial">Imperial (in)</option><option value="metric">Metric (mm)</option></select></div>
                <div class="form-group"><label for="mat-system">Pipe sizing system</label>
                    <select id="mat-system">${D.SIZE_SYSTEMS.map(s => `<option value="${s.id}">${clean(s.name)}</option>`).join("")}</select></div>
            </div>
            <div style="display:flex; gap:0.75rem; flex-wrap:wrap; margin-top:0.5rem;">
                <button class="btn btn-secondary" id="mat-export"><i class="fa-solid fa-file-csv"></i> Export shown rows (.csv)</button>
            </div>
            <div id="mat-results" style="margin-top:1rem;"></div>`);
    }

    const table = (headers, rows) => rows.length
        ? `<div style="overflow-x:auto;"><table class="data-table" style="width:100%; font-size:0.8rem;"><thead><tr>${headers.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
        : `<p style="color:var(--text-muted); font-size:0.85rem;">Nothing matches the current filters.</p>`;

    function render() {
        const box = $("mat-results");
        if (!box) return;
        const o = opts();
        const q = o.query.trim().toLowerCase();
        const showIn = o.units !== "metric", showMm = o.units !== "imperial";
        const csv = [];

        // JEA template materials (water / sewer / reclaimed / chilled utility data — shown unless Gas is chosen).
        const jea = jeaMaterialGroups();
        const jeaHtml = o.utility === "Gas" ? `<p style="color:var(--text-muted); font-size:0.85rem;">The JEA template covers water, sewer, reclaimed and chilled water — no gas materials.</p>`
            : jea.groups.map(g => {
                const lists = g.lists.map(l => ({ ...l, values: q ? l.values.filter(v => String(v).toLowerCase().includes(q) || l.name.toLowerCase().includes(q)) : l.values }))
                    .filter(l => l.values.length);
                lists.forEach(l => l.values.forEach(v => csv.push(["JEA template", g.group, l.name, isSizeCode(v) ? `${v} (code)` : v, "", "", ""])));
                return lists.length ? `<div style="margin-top:0.6rem;"><h4 style="font-size:0.9rem; font-weight:700;">${clean(g.group)}</h4>
                    ${lists.map(l => `<div style="margin-top:0.35rem;"><span style="font-size:0.75rem; color:var(--text-muted);">${clean(l.name)} (${l.values.length})</span>
                        <div style="display:flex; flex-wrap:wrap; gap:0.3rem; margin-top:0.2rem;">${l.values.map(v => `<span class="tag tag-discipline">${clean(isSizeCode(v) ? `${v} (code)` : v)}</span>`).join("")}</div></div>`).join("")}</div>` : "";
            }).join("") || `<p style="color:var(--text-muted); font-size:0.85rem;">No JEA template material matches “${clean(o.query)}”.</p>`;

        // Pipe sizes for the chosen sizing system.
        const sys = D.SIZE_SYSTEMS.find(s => s.id === o.system);
        const sizeRowsShown = sizeRows(o.system).filter(r => !q || r.label.includes(q) || String(r.nominalIn).includes(q) || String(r.dn || "").includes(q) || sys.name.toLowerCase().includes(q) || sys.usedFor.toLowerCase().includes(q));
        const sizeHead = ["Nominal (in)", "DN"].concat(showMm ? ["Nominal (mm)"] : [], showIn ? ["OD (in)"] : [], showMm ? ["OD (mm)"] : []);
        const sizeBody = sizeRowsShown.map(r => [clean(r.label), r.dn == null ? "—" : `DN ${r.dn}`].concat(showMm ? [f1(r.nominalMm)] : [], showIn ? [f3(r.odIn)] : [], showMm ? [f1(r.odMm)] : []));
        sizeRowsShown.forEach(r => csv.push(["Pipe size", sys.name, r.label + " in", r.dn == null ? "" : `DN ${r.dn}`, f3(r.odIn), f1(r.odMm), sys.standard]));

        // JEA standard size list.
        const js = jeaSizeRows();
        const jsShown = js.sizes.filter(r => !q || r.label.includes(q) || String(r.nominalIn).includes(q) || /size|jea/.test(q));
        const jsHead = ["Nominal (in)", "DN"].concat(showMm ? ["Nominal (mm)"] : []);
        const jsBody = jsShown.map(r => [clean(r.label), r.dn == null ? "— (no standard DN)" : `DN ${r.dn}`].concat(showMm ? [f1(r.nominalMm)] : []));

        // Pipe systems, appurtenances, fittings.
        const systems = filterRows(D.PIPE_SYSTEMS, o);
        const app = filterRows(D.APPURTENANCES, o);
        const fit = filterRows(D.FITTINGS, o);
        systems.forEach(r => csv.push(["Pipe system", r.utility, `${r.use}: ${r.material}`, r.sizes, r.classes, r.standard, r.system || ""]));
        app.forEach(r => csv.push(["Appurtenance", r.utility, `${r.line}: ${r.name}`, r.note, "", r.standard, ""]));
        fit.forEach(r => csv.push(["Fitting", r.utility, `${r.line}: ${r.name}`, r.note, "", r.standard, ""]));
        _view = { headers: ["Section", "Group / utility", "Item", "Detail", "Value", "Standard / OD (mm)", "Notes"], rows: csv };

        window.setSafeHTML(box, `
            <p style="font-size:0.8rem; color:var(--warning);"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i> Reference values — verify sizes, classes and standards against the governing standard, the utility's current specifications and the manufacturer before design or procurement. Metric values are computed from the inch values (× 25.4); DN is a size designation, not a measured diameter.</p>
            <nav aria-label="Materials sections" style="display:flex; flex-wrap:wrap; gap:0.4rem 1rem; font-size:0.85rem; margin-top:0.5rem;">
                <a href="#mat-sec-jea">JEA template materials</a><a href="#mat-sec-sizes">Pipe sizes</a><a href="#mat-sec-systems">Pipe systems</a><a href="#mat-sec-app">Appurtenances</a><a href="#mat-sec-fit">Typical fittings</a>
            </nav>
            <section id="mat-sec-jea" style="margin-top:1rem;"><h3 style="font-size:1.05rem; font-weight:700;"><i class="fa-solid fa-faucet-drip" style="color:var(--primary);"></i> JEA template materials</h3>
                <p style="font-size:0.8rem; color:var(--text-muted);">Every material and equipment list in the JEA As-Built (2026) template, read live from the template data.</p>${jeaHtml}</section>
            <section id="mat-sec-sizes" style="margin-top:1.25rem;"><h3 style="font-size:1.05rem; font-weight:700;"><i class="fa-solid fa-ruler-horizontal" style="color:var(--primary);"></i> Pipe sizes — ${clean(sys.name)}</h3>
                <p style="font-size:0.8rem; color:var(--text-muted);">${clean(sys.usedFor)}. Standard: ${clean(sys.standard)}.</p>${table(sizeHead, sizeBody)}
                <h4 style="font-size:0.9rem; font-weight:700; margin-top:0.75rem;">JEA standard sizes</h4>${table(jsHead, jsBody)}
                ${js.codes.length ? `<p style="font-size:0.75rem; color:var(--text-muted);">The JEA size list also contains the codes ${js.codes.map(c => clean(c)).join(", ")}, which are not sizes.</p>` : ""}</section>
            <section id="mat-sec-systems" style="margin-top:1.25rem;"><h3 style="font-size:1.05rem; font-weight:700;"><i class="fa-solid fa-grip-lines" style="color:var(--primary);"></i> Pipe systems</h3>
                ${table(["Utility", "Use", "Material", "Standard", "Sizes", "Classes", "OD system"], systems.map(r => [r.utility, clean(r.use), clean(r.material), clean(r.standard), clean(r.sizes), clean(r.classes), r.system || "—"]))}</section>
            <section id="mat-sec-app" style="margin-top:1.25rem;"><h3 style="font-size:1.05rem; font-weight:700;"><i class="fa-solid fa-gauge" style="color:var(--primary);"></i> Appurtenances</h3>
                ${table(["Utility", "Line", "Appurtenance", "Standard", "Notes"], app.map(r => [r.utility, clean(r.line), clean(r.name), clean(r.standard), clean(r.note)]))}</section>
            <section id="mat-sec-fit" style="margin-top:1.25rem;"><h3 style="font-size:1.05rem; font-weight:700;"><i class="fa-solid fa-code-branch" style="color:var(--primary);"></i> Typical fittings</h3>
                ${table(["Utility", "Line", "Fitting", "Standard", "Notes"], fit.map(r => [r.utility, clean(r.line), clean(r.name), clean(r.standard), clean(r.note)]))}</section>`);
    }

    const Plugin = {
        init() { renderControls(); render(); },
        setupEvents(ctx) {
            ["mat-search"].forEach(id => $(id)?.addEventListener("input", render));
            ["mat-utility", "mat-units", "mat-system"].forEach(id => $(id)?.addEventListener("change", render));
            $("mat-export")?.addEventListener("click", () => {
                if (!_view || !_view.rows.length) { ctx.showToast("Nothing to export with the current filters.", true); return; }
                window.COGO.downloadText("materials.csv", toCsv(_view.headers, _view.rows), "text/csv");
                ctx.showToast(`Exported ${_view.rows.length} row(s).`);
            });
        },
        onTabActivate() { render(); }
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);

    window.Materials = { JEA_GROUPS, JEA_NOT_MATERIALS, jeaMaterialGroups, inToMm, nominalToDN, formatNominal, sizeRows, jeaSizeRows, filterRows, toCsv };
})();
