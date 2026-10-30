/**
 * Plugin: subdivision (Subdivision — concept lot layout)
 * plugins/subdivision/subdivision.js
 *
 * Interactive front end for plugins/subdivision/subdivision-engine.js: every setting redraws the
 * layout as it changes — lots, the road (straight, curved or reverse-curved; cul-de-sac or
 * through), green space and retention ponds with their piping. The road can be dragged along
 * the frontage, a boundary edge clicked to make it the frontage, and lots hovered / clicked (in
 * the plan or the table) for their numbers.
 * Exports the layout as DXF (core/cogo.js buildDxf) and a one-page PDF.
 *
 * Exposes window.Subdivision = { readSettings, writeSettings, recompute, state } for tests.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "subdivision",
        version: "1.0.0",
        description: "Concept subdivision layout: lots by number / frontage / size, a cul-de-sac or through road, green space; live checks, PDF and DXF export.",
        tab: "tab-subdivision",
        icon: "fa-table-cells-large",
        tier: "Pro",
        dependencies: []
    };

    const SVGNS = "http://www.w3.org/2000/svg";
    const E = window.SubdivisionEngine;
    const clean = window.cleanText;
    const $ = id => document.getElementById(id);
    const fmt = (x, d = 0) => Number(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

    const state = { verts: null, settings: null, layout: null, sel: null, hover: null, drag: null, ctx: null, raf: 0 };

    // ── Settings <-> form ─────────────────────────────────────────────────────

    /** Settings from the form. Blank / invalid numbers become NaN so validation reports them. */
    function readSettings() {
        const s = Object.assign({}, state.settings || {});
        document.querySelectorAll("[data-sd]").forEach(el => {
            const v = el.value.trim();
            s[el.dataset.sd] = v === "" ? NaN : Number(v);
        });
        document.querySelectorAll("[data-sd-bool]").forEach(el => { s[el.dataset.sdBool] = el.checked; });
        document.querySelectorAll("[data-sd-select]").forEach(el => { s[el.dataset.sdSelect] = el.value; });
        document.querySelectorAll("[data-sd-radio]:checked").forEach(el => { s[el.dataset.sdRadio] = el.value; });
        const f = $("sd-front");
        if (f && f.value !== "") s.frontEdge = Number(f.value);
        return s;
    }

    function writeSettings(s) {
        document.querySelectorAll("[data-sd]").forEach(el => {
            const v = s[el.dataset.sd];
            el.value = v == null || !isFinite(v) ? "" : String(+(+v).toFixed(4));
        });
        document.querySelectorAll("[data-sd-range]").forEach(el => syncRange(el, s[el.dataset.sdRange]));
        document.querySelectorAll("[data-sd-bool]").forEach(el => { el.checked = !!s[el.dataset.sdBool]; });
        document.querySelectorAll("[data-sd-select]").forEach(el => { el.value = s[el.dataset.sdSelect]; });
        document.querySelectorAll("[data-sd-radio]").forEach(el => { el.checked = el.value === s[el.dataset.sdRadio]; });
        const f = $("sd-front");
        if (f && s.frontEdge != null) f.value = String(s.frontEdge);
        syncVisibility(s);
    }

    /** Range slider follows its number box; widen the slider's range when a typed value is outside it. */
    function syncRange(r, v) {
        if (!isFinite(v)) return;
        if (v > +r.max) r.max = String(v);
        if (v < +r.min) r.min = String(v);
        r.value = String(v);
    }

    function syncVisibility(s) {
        const road = $("sd-road-fields"), green = $("sd-green-fields"), pond = $("sd-pond-fields");
        if (road) road.classList.toggle("sd-fields-off", !s.roadOn);
        if (green) green.classList.toggle("sd-fields-off", !s.greenOn);
        if (pond) pond.classList.toggle("sd-fields-off", !s.pondsOn);
        document.querySelectorAll("[data-sd-culdesac]").forEach(el => { el.hidden = s.roadEnd !== "culdesac"; });
        document.querySelectorAll("[data-sd-roadlen]").forEach(el => { el.hidden = s.roadEnd !== "culdesac" && s.roadEnd !== "loop"; });
        document.querySelectorAll("[data-sd-pondslope]").forEach(el => { el.hidden = !(s.pondShape === "fixed" && s.pondSizeAuto); });
        const sbf = $("sd-setback-fields");
        if (sbf) sbf.classList.toggle("sd-fields-off", !s.setbacksOn);
        document.querySelectorAll("[data-sd-curve]").forEach(el => { el.hidden = s.alignment === "straight"; });
        const turn = $("sd-turn-toggle");
        if (turn) turn.disabled = s.alignment === "straight";
        document.querySelectorAll("[data-sd-reverse]").forEach(el => { el.hidden = s.alignment !== "reverse"; });
        document.querySelectorAll("[data-sd-pondauto]").forEach(el => { el.hidden = !s.pondSizeAuto; });
        document.querySelectorAll("[data-sd-road2]").forEach(el => { el.hidden = s.roadCount !== 2; });
        document.querySelectorAll("[data-sd-pondfixed]").forEach(el => { el.hidden = s.pondShape !== "fixed"; });
        const sf = $("sd-pondSF");
        if (sf) {
            sf.disabled = !!s.pondSizeAuto;
            // With auto sizing the field shows the computed requirement (read-only).
            if (s.pondSizeAuto && state.verts && [s.imperviousPct, s.treatmentIn, s.pondDepthFt].every(isFinite) && s.pondDepthFt > 0) {
                sf.value = String(Math.round(E.pondAreaRequired(window.COGO.shoelaceArea(state.verts), s)));
            }
        }
    }

    /** Slider ranges that suit the loaded boundary. */
    function tuneRanges(s) {
        const set = (key, max) => { const r = document.querySelector(`[data-sd-range="${key}"]`); if (r) r.max = String(max); };
        const best = Math.max(10, s.nLots || 1);
        set("nLots", Math.max(20, Math.ceil(best * 2)));
        set("roadLength", Math.max(200, Math.ceil(s.roadLength * 1.1 / 10) * 10));
    }

    // ── Boundary ──────────────────────────────────────────────────────────────

    function applyBoundary(text, keepSettings) {
        const r = E.parseBoundary(text, { descFilter: ($("sd-desc-filter") || {}).value || "" });
        // A boundary in metres is converted to US survey feet: every setting and output is in feet.
        if (!r.error && ($("sd-units") || {}).value === "m") r.verts = r.verts.map(p => ({ n: p.n * 3937 / 1200, e: p.e * 3937 / 1200 }));
        state.boundaryInfo = r;
        if (r.error) { showErrors([r.error]); return false; }
        state.verts = r.verts;
        state.sel = null;
        fillFrontage(r.verts);
        const prev = keepSettings && state.settings;
        const s = E.recommended(r.verts);
        if (prev) ["minFrontage", "minLotSF", "minLotAcres", "maxLotDepth", "minLotDepth", "roadOn", "roadEnd", "roadWidth", "culdesacRadius", "alignment", "turn",
            "tangent1", "radius1", "delta1", "tangent2", "radius2", "delta2", "greenOn", "greenPct",
            "pondsOn", "imperviousPct", "treatmentIn", "pondDepthFt", "pondSizeAuto", "pondCount", "pondLink",
            "roadCount", "roadPos2", "pondShape", "pondWidth", "setbacksOn", "frontSetback", "sideSetback", "rearSetback", "minBuildableSF",
            "cornerExtra", "sightLeg", "easementFront", "easementRear", "mergeEndLots", "phases", "pondSideSlope", "pondFreeboard"].forEach(k => { s[k] = prev[k]; });
        // bestLots lays the lots out, which throws on invalid kept settings: keep their lot count and
        // let recompute() show the errors instead.
        if (prev) s.nLots = E.validate(Object.assign({}, s, { nLots: 1 }), r.verts).length ? prev.nLots : E.bestLots(r.verts, s);
        state.settings = s;
        tuneRanges(state.settings);
        writeSettings(state.settings);
        recompute();
        return true;
    }

    function fillFrontage(verts) {
        const f = $("sd-front");
        if (!f) return;
        f.textContent = "";
        E.edges(verts).forEach(ed => {
            const o = document.createElement("option");
            o.value = String(ed.index);
            o.textContent = `Edge ${ed.index + 1}: ${ed.bearing}, ${fmt(ed.length, 2)} ft`;
            f.appendChild(o);
        });
        f.disabled = false;
    }

    /** Largest closed figure in the Linework Editor, as "N, E" lines. */
    function boundaryFromLinework() {
        const LW = window.Linework;
        const figs = LW && LW.getFigures ? LW.getFigures().filter(f => f.closed && f.pts && f.pts.length >= 3) : [];
        if (!figs.length) return null;
        const best = figs.reduce((m, f) => (window.COGO.shoelaceArea(f.pts) > window.COGO.shoelaceArea(m.pts) ? f : m));
        return best.pts.map(p => `${p.n.toFixed(3)}, ${p.e.toFixed(3)}`).join("\n");
    }

    // ── Compute + render ──────────────────────────────────────────────────────

    function schedule() {
        if (state.raf) return;
        const run = () => { state.raf = 0; recompute(); };
        state.raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : (run(), 0);
    }

    function recompute() {
        if (!state.verts) return null;
        const s = readSettings();
        state.settings = s;
        syncVisibility(s);
        const errs = E.validate(s, state.verts);
        // a stale layout must not be saved or exported as if it matched these settings
        if (errs.length) { state.layout = null; showErrors(errs); setExports(false); return null; }
        try {
            state.layout = E.layout(state.verts, s);
        } catch (e) {
            state.layout = null; showErrors([e.message]); setExports(false); return null;
        }
        showErrors([]);
        render();
        setExports(true);
        return state.layout;
    }

    function setExports(on) { ["btn-sd-pdf", "btn-sd-dxf", "btn-sd-landxml", "btn-sd-send-lw"].forEach(id => { const b = $(id); if (b) b.disabled = !on; }); }

    // ── Scenarios: named snapshots of the settings and their results, to compare side by side ──
    // (kept in this browser; a convenience — the settings themselves are what matter)
    const SCN_KEY = "subdivision.scenarios.v1";
    function loadScenarios() { try { const a = JSON.parse(localStorage.getItem(SCN_KEY) || "[]"); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
    function saveScenarios(a) { try { localStorage.setItem(SCN_KEY, JSON.stringify(a)); return true; } catch (e) { return false; } }
    function scenarioOf(name) {
        const L = state.layout;
        return {
            // the corners as used (already in feet), so a metric boundary comes back right
            name, savedAt: new Date().toISOString(), boundary: state.verts.map(p => `${p.n.toFixed(4)}, ${p.e.toFixed(4)}`).join("\n"), settings: Object.assign({}, L.settings),
            result: { lots: L.lots.length, avgLot: L.lots.length ? L.lotArea / L.lots.length : 0, roadLength: L.roadLength, roadArea: L.roadArea, pondArea: L.pondArea, remainder: L.remainderArea, ok: L.ok }
        };
    }
    function renderScenarios() {
        const tb = $("sd-scn-tbody");
        if (!tb) return;
        const a = loadScenarios();
        window.setSafeRows(tb, a.length ? a.map((x, i) => `<tr><td>${clean(x.name)}</td><td>${x.result.lots}</td><td>${fmt(x.result.avgLot)}</td><td>${fmt(x.result.roadLength)}</td>
            <td>${fmt(x.result.roadArea)}</td><td>${fmt(x.result.pondArea)}</td><td>${fmt(x.result.remainder)}</td><td${x.result.ok ? "" : ' class="bad"'}>${x.result.ok ? "Pass" : "Fail"}</td>
            <td><button class="btn btn-secondary btn-sm" data-scn-load="${i}">Load</button> <button class="btn btn-secondary btn-sm" data-scn-del="${i}" aria-label="Delete scenario ${clean(x.name)}">✕</button></td></tr>`).join("")
            : '<tr><td colspan="9" style="color:var(--text-muted)">No scenarios saved yet — save one, change the settings, save another, and compare.</td></tr>');
    }

    function showErrors(list) {
        const el = $("sd-errors");
        if (!el) return;
        el.hidden = !list.length;
        window.setSafeHTML(el, list.map(m => `<div><i class="fa-solid fa-triangle-exclamation"></i> ${clean(m)}</div>`).join(""));
    }

    function render() {
        renderPlan();
        renderSummary();
        renderChecks();
        renderTable();
        renderHover();
    }

    const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
    const ringsD = rings => rings.filter(r => r.length >= 3).map(r => "M" + r.map(p => `${p.e.toFixed(3)},${(-p.n).toFixed(3)}`).join("L") + "Z").join("");
    const lineD = pts => "M" + pts.map(p => `${p.e.toFixed(3)},${(-p.n).toFixed(3)}`).join("L");

    function renderPlan() {
        const host = $("sd-canvas"), L = state.layout;
        if (!host || !L) return;
        const b = L.boundary;
        const e0 = Math.min(...b.map(p => p.e)), e1 = Math.max(...b.map(p => p.e));
        const n0 = Math.min(...b.map(p => p.n)), n1 = Math.max(...b.map(p => p.n));
        const pad = Math.max(e1 - e0, n1 - n0) * 0.06;
        const svg = mk("svg", { viewBox: `${e0 - pad} ${-n1 - pad} ${e1 - e0 + 2 * pad} ${n1 - n0 + 2 * pad}`, preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": "Subdivision layout plan" });
        const px = Math.max(e1 - e0, n1 - n0) / 700;   // ≈ one screen pixel in feet
        // Remainder shows through: the parcel is painted first, everything else on top.
        svg.appendChild(mk("path", { d: ringsD([b]), fill: "rgba(100,116,139,0.16)", stroke: "none" }));
        L.green.forEach(g => svg.appendChild(mk("path", { d: ringsD([g]), fill: "rgba(34,197,94,0.28)", stroke: "#22c55e", "stroke-width": px })));
        // Ponds: light blue fill with a blue 45° hatch (an SVG pattern in plan units, so it scales with the view).
        const defs = mk("defs", {}), hp = 7 * px;
        const pat = mk("pattern", { id: "sd-pond-hatch", patternUnits: "userSpaceOnUse", width: hp, height: hp, patternTransform: "rotate(-45)" });
        pat.appendChild(mk("rect", { width: hp, height: hp, fill: "rgba(59,130,246,0.22)" }));
        pat.appendChild(mk("line", { x1: 0, y1: 0, x2: 0, y2: hp, stroke: "#3b82f6", "stroke-width": 1.6 * px }));
        defs.appendChild(pat);
        svg.appendChild(defs);
        L.ponds.forEach(p => svg.appendChild(mk("path", { d: ringsD(p.rings), "fill-rule": "evenodd", fill: "url(#sd-pond-hatch)", stroke: "#3b82f6", "stroke-width": 1.4 * px, "data-pond": p.id })));
        L.lots.forEach(l => {
            const on = state.sel === l.id || state.hover === l.id;
            svg.appendChild(mk("path", {
                d: ringsD(l.rings), "fill-rule": "evenodd", "data-lot": l.id,
                fill: l.ok ? (on ? "rgba(56,189,248,0.45)" : "rgba(56,189,248,0.18)") : (on ? "rgba(244,63,94,0.5)" : "rgba(244,63,94,0.22)"),
                stroke: l.ok ? "#38bdf8" : "#f43f5e", "stroke-width": (on ? 2.4 : 1.1) * px, style: "cursor:pointer"
            }));
        });
        L.lots.forEach(l => {
            (l.easements || []).forEach(r => svg.appendChild(mk("path", { d: ringsD([r]), fill: "rgba(148,163,184,0.10)", stroke: "#64748b", "stroke-width": 0.6 * px, "stroke-dasharray": `${2 * px} ${2 * px}`, "pointer-events": "none" })));
            (l.envelope || []).forEach(r => svg.appendChild(mk("path", { d: ringsD([r]), fill: "none", stroke: "#f59e0b", "stroke-width": 0.9 * px, "stroke-dasharray": `${4 * px} ${3 * px}`, "pointer-events": "none" })));
        });
        (L.sightTriangles || []).forEach(t => svg.appendChild(mk("path", { d: ringsD([t]), fill: "rgba(244,63,94,0.25)", stroke: "#f43f5e", "stroke-width": px, "pointer-events": "none" })));
        (L.roadOutlines || []).forEach((rings, i) => { if (rings.length) svg.appendChild(mk("path", { d: ringsD(rings), "fill-rule": "evenodd", fill: "rgba(148,163,184,0.45)", stroke: "none", "data-road": String(i + 1), style: "cursor:ew-resize" })); });
        L.roadEdges.forEach(e => svg.appendChild(mk("path", { d: lineD(e), fill: "none", stroke: "#cbd5e1", "stroke-width": 1.3 * px, "pointer-events": "none" })));
        (L.bulbs || []).forEach(b => svg.appendChild(mk("path", { d: lineD(b), fill: "none", stroke: "#cbd5e1", "stroke-width": 1.3 * px, "pointer-events": "none" })));
        L.roadCentre.forEach(c => svg.appendChild(mk("path", { d: lineD(c), fill: "none", stroke: "#facc15", "stroke-width": px, "stroke-dasharray": `${10 * px} ${6 * px}`, "pointer-events": "none" })));
        L.pipes.forEach(p => svg.appendChild(mk("line", { x1: p.a.e, y1: -p.a.n, x2: p.b.e, y2: -p.b.n, stroke: "#60a5fa", "stroke-width": 2 * px, "stroke-dasharray": `${5 * px} ${3 * px}`, "pointer-events": "none" })));
        // Boundary edges: click one to make it the frontage
        b.forEach((p, i) => {
            const q = b[(i + 1) % b.length], front = i === L.settings.frontEdge;
            const ln = mk("line", { x1: p.e, y1: -p.n, x2: q.e, y2: -q.n, stroke: front ? "#f59e0b" : "#e2e8f0", "stroke-width": (front ? 5 : 2.2) * px, "stroke-linecap": "round", "data-edge": i, style: "cursor:pointer" });
            const t = mk("title", {}); t.textContent = front ? "Frontage edge (existing street)" : `Edge ${i + 1} — click to make it the frontage`;
            ln.appendChild(t);
            svg.appendChild(ln);
        });
        const fs = Math.max(6 * px, Math.min(14 * px, Math.sqrt(L.gross / Math.max(1, L.lots.length)) / 6));
        const label = (p, txt, size, fill) => {
            const t = mk("text", { x: p.e, y: -p.n, "font-size": size, "text-anchor": "middle", "dominant-baseline": "middle", fill, "pointer-events": "none", "font-family": "Inter, sans-serif", "font-weight": 600 });
            t.textContent = txt;
            svg.appendChild(t);
        };
        L.lots.forEach(l => label(l.label, String(l.id), fs, "#f8fafc"));
        L.ponds.forEach(p => label(p.label, `Pond ${p.id}`, Math.max(fs, 9 * px), "#bfdbfe"));
        L.access.forEach(a => {
            svg.appendChild(mk("circle", { cx: a.e, cy: -a.n, r: 6 * px, fill: a.kind === "ingress" ? "#22c55e" : "#f97316", stroke: "#0b1220", "stroke-width": 1.5 * px, "pointer-events": "none" }));
            const t = mk("text", { x: a.e + 9 * px, y: -a.n - 9 * px, "font-size": 11 * px, fill: a.kind === "ingress" ? "#4ade80" : "#fb923c", "font-family": "Inter, sans-serif", "font-weight": 700, "pointer-events": "none" });
            t.textContent = a.kind === "ingress" ? "IN" : "OUT";
            svg.appendChild(t);
        });
        host.textContent = "";
        host.appendChild(svg);
        state.svg = svg;
    }

    function renderSummary() {
        const L = state.layout, el = $("sd-summary");
        if (!el || !L) return;
        const pct = a => (a / L.gross * 100).toFixed(1), best = E.bestLots(state.verts, L.settings);
        const cards = [
            [fmt(L.gross / E.SQFT_PER_ACRE, 3) + " ac", `Gross area (${fmt(L.gross)} sq ft)`],
            [String(L.lots.length), `Lots (most that meet the minimums: ${best})`],
            [fmt(L.lotArea / Math.max(1, L.lots.length)), "Average lot (sq ft)"],
            [L.settings.roadOn ? fmt(L.roadArea) : "off", L.settings.roadOn ? `Road sq ft (${pct(L.roadArea)}%), ${fmt(L.roadLength)} ft long` : "Road"],
            [L.settings.pondsOn ? fmt(L.pondArea) : "off", L.settings.pondsOn ? `Ponds sq ft (${L.ponds.length} behind the lots, ${fmt(L.pondWidth, 1)} ft wide; ${fmt(L.pipeLength)} ft pipe)` : "Retention ponds"],
            [L.settings.greenOn ? fmt(L.greenArea) : "off", L.settings.greenOn ? `Green space sq ft (${pct(L.greenArea)}%)` : "Green space"],
            [fmt(L.remainderArea), `Remainder sq ft (${pct(L.remainderArea)}%)`]
        ];
        window.setSafeHTML(el, cards.map(([b, s]) => `<div class="sd-stat"><b>${clean(b)}</b><span>${clean(s)}</span></div>`).join(""));
        const mx = $("btn-sd-max");
        if (mx) mx.textContent = `Use max that meets the minimums (${best})`;
    }

    function renderChecks() {
        const L = state.layout, el = $("sd-checks");
        if (!el || !L) return;
        window.setSafeHTML(el, L.checks.map(c => {
            const cls = c.ok ? "ok" : c.info ? "info" : "bad", icon = c.ok ? "fa-circle-check" : c.info ? "fa-circle-info" : "fa-circle-xmark";
            return `<li class="${cls}"><i class="fa-solid ${icon}"></i><span>${clean(c.label)}</span></li>`;
        }).join(""));
    }

    function renderTable() {
        const L = state.layout, tb = $("sd-lots-tbody");
        if (!tb || !L) return;
        const why = l => [l.checks.frontage ? null : (l.corner ? "corner frontage" : "frontage"), l.checks.depth ? null : "depth", l.checks.size ? null : "sq ft", l.checks.acres ? null : "acres", l.checks.buildable === false ? "buildable area" : null].filter(Boolean).join(", ");
        window.setSafeRows(tb, L.lots.map(l => `<tr data-lot="${l.id}"${state.sel === l.id ? ' class="sd-sel"' : ""}>
            <td>${l.id}${l.corner ? ' <span class="eb-status suggested" title="Corner lot">corner</span>' : ""}</td><td>${l.phase}</td>
            <td${l.checks.size && l.checks.acres ? "" : ' class="bad"'}>${fmt(l.area)}</td><td>${l.acres.toFixed(3)}</td>
            <td${l.checks.frontage ? "" : ' class="bad"'}>${fmt(l.frontage, 1)}</td><td${l.checks.depth ? "" : ' class="bad"'}>${l.depth == null ? "—" : fmt(l.depth, 1)}</td>
            <td${l.checks.buildable === false ? ' class="bad"' : ""}>${l.buildableArea == null ? "—" : fmt(l.buildableArea)}</td>
            <td${l.ok ? "" : ' class="bad"'}>${l.ok ? "Yes" : clean("No — " + why(l))}</td></tr>`).join(""));
    }

    function renderHover() {
        const el = $("sd-hover"), L = state.layout;
        if (!el) return;
        const id = state.hover || state.sel, l = L && L.lots.find(x => x.id === id);
        el.textContent = l
            ? `Lot ${l.id}: ${fmt(l.area)} sq ft (${l.acres.toFixed(3)} ac) · frontage ${fmt(l.frontage, 1)} ft · avg depth ${l.depth == null ? "—" : fmt(l.depth, 1)} ft · ${l.ok ? "meets the minimums" : "below a minimum"}`
            : L ? "Drag the road to move it · click a boundary edge to make it the frontage · hover a lot for its numbers" : " ";
    }

    function select(id) {
        state.sel = state.sel === id ? null : id;
        renderPlan(); renderTable(); renderHover();
        const row = document.querySelector(`#sd-lots-tbody tr[data-lot="${id}"]`);
        if (row && row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    }

    // ── Plan interaction ──────────────────────────────────────────────────────

    function worldAt(evt) {
        const svg = state.svg;
        if (!svg || !svg.getScreenCTM) return null;
        const m = svg.getScreenCTM();
        if (!m) return null;
        const p = svg.createSVGPoint();
        p.x = evt.clientX; p.y = evt.clientY;
        const w = p.matrixTransform(m.inverse());
        return { e: w.x, n: -w.y };
    }

    function bindPlan() {
        const host = $("sd-canvas");
        if (!host) return;
        host.addEventListener("pointerdown", e => {
            const t = e.target;
            if (t.getAttribute && t.getAttribute("data-road") && state.layout) {
                state.drag = t.getAttribute("data-road") === "2" ? "roadPos2" : "roadPos";
                if (host.setPointerCapture) host.setPointerCapture(e.pointerId);
                e.preventDefault();
            }
        });
        host.addEventListener("pointermove", e => {
            if (state.drag) {
                const w = worldAt(e);
                if (!w) return;
                const pos = Math.round(E.roadPosAt(state.verts, state.settings, w) * 10) / 10;
                $("sd-" + state.drag).value = String(pos);
                syncRange($("sd-" + state.drag + "-r"), pos);
                schedule();
                return;
            }
            const t = e.target, id = t.getAttribute && t.getAttribute("data-lot") ? +t.getAttribute("data-lot") : null;
            if (id !== state.hover) { state.hover = id; renderPlan(); renderHover(); }
        });
        const end = () => { state.drag = false; };
        host.addEventListener("pointerup", end);
        host.addEventListener("pointercancel", end);
        host.addEventListener("pointerleave", () => { if (!state.drag && state.hover != null) { state.hover = null; renderPlan(); renderHover(); } });
        host.addEventListener("click", e => {
            const t = e.target;
            if (!t.getAttribute) return;
            if (t.getAttribute("data-lot")) select(+t.getAttribute("data-lot"));
            else if (t.getAttribute("data-edge") != null && t.getAttribute("data-edge") !== "") {
                const k = +t.getAttribute("data-edge");
                if (k !== state.settings.frontEdge) setFrontage(k);
            }
        });
    }

    function setFrontage(k) {
        const f = $("sd-front");
        if (f) f.value = String(k);
        const s = readSettings();
        s.frontEdge = k;
        // The road length that fits depends on the frontage; refit it when it no longer fits.
        const r = E.recommended(state.verts, k);
        if (s.roadEnd === "culdesac" && !(s.roadLength <= r.roadLength)) s.roadLength = r.roadLength;
        state.settings = s;
        tuneRanges(Object.assign({}, s, { roadLength: r.roadLength }));
        writeSettings(s);
        recompute();
        if (state.ctx) state.ctx.showToast(`Frontage set to edge ${k + 1}.`);
    }

    // ── Exports ───────────────────────────────────────────────────────────────

    function exportName(ext) { return `subdivision-${state.layout.lots.length}-lots.${ext}`; }

    function exportDxf(ctx) {
        if (!state.layout) { ctx.showToast("Nothing to export — fix the settings first.", true); return; }
        window.COGO.downloadText(exportName("dxf"), E.toDxf(state.layout), "application/dxf");
        ctx.showToast("DXF exported.");
    }

    function exportPdf(ctx) {
        if (!state.layout) { ctx.showToast("Nothing to export — fix the settings first.", true); return; }
        const date = new Date().toISOString().slice(0, 10);
        window.COGO.downloadText(exportName("pdf"), E.toPdf(state.layout, { title: "Subdivision concept layout", date }), "application/pdf");
        ctx.showToast("PDF exported.");
    }

    // ── Plugin ────────────────────────────────────────────────────────────────

    const Plugin = {
        init(ctx) { state.ctx = ctx; },
        setupEvents(ctx) {
            state.ctx = ctx;
            $("btn-sd-sample")?.addEventListener("click", () => {
                const ta = $("sd-boundary");
                if (ta) ta.value = E.SAMPLE;
                applyBoundary(E.SAMPLE, false);
            });
            $("btn-sd-apply")?.addEventListener("click", () => {
                if (applyBoundary(($("sd-boundary") || {}).value || "", true)) ctx.showToast("Boundary applied.");
            });
            $("btn-sd-from-linework")?.addEventListener("click", () => {
                const text = boundaryFromLinework();
                if (!text) { ctx.showToast("No closed figure in the Linework Editor — load or close one there first.", true); return; }
                const ta = $("sd-boundary");
                if (ta) ta.value = text;
                if (applyBoundary(text, true)) ctx.showToast("Boundary taken from the largest closed Linework figure.");
            });
            $("sd-front")?.addEventListener("change", e => setFrontage(+e.target.value));
            const preset = $("sd-preset");
            if (preset) E.PRESETS.forEach(p => { const o = document.createElement("option"); o.value = p.id; o.textContent = `${p.label} — ${p.minFrontage} ft, ${p.minLotSF.toLocaleString("en-US")} sq ft`; preset.appendChild(o); });
            preset?.addEventListener("change", () => {
                const src = $("sd-preset-src");
                if (!preset.value) { if (src) src.textContent = ""; return; }
                const s = E.applyPreset(readSettings(), preset.value), p = E.PRESETS.find(x => x.id === preset.value);
                ["minFrontage", "minLotSF", "minLotAcres", "frontSetback", "sideSetback", "rearSetback"].forEach(k => { const el = $("sd-" + k); if (el) { el.value = String(s[k]); const r = $("sd-" + k + "-r"); if (r) syncRange(r, s[k]); } });
                if (src) src.textContent = `${p.source}. Verify against the current code; "Use max" to refit the lot count.`;
                recompute();
                ctx.showToast(`${p.label}: ${p.minFrontage} ft frontage, ${p.minLotSF.toLocaleString("en-US")} sq ft lots.`);
            });
            document.querySelectorAll("[data-sd]").forEach(el => {
                const onEdit = () => {
                    const r = document.querySelector(`[data-sd-range="${el.dataset.sd}"]`);
                    if (r && el.value.trim() !== "") syncRange(r, Number(el.value));
                    schedule();
                };
                el.addEventListener("input", onEdit);
                if (el.tagName === "SELECT") el.addEventListener("change", onEdit);   // number-valued dropdowns (roadCount)
            });
            document.querySelectorAll("[data-sd-range]").forEach(r => r.addEventListener("input", () => {
                const n = document.querySelector(`[data-sd="${r.dataset.sdRange}"]`);
                if (n) n.value = r.value;
                schedule();
            }));
            document.querySelectorAll("[data-sd-bool], [data-sd-select], [data-sd-radio]").forEach(el => el.addEventListener("change", schedule));
            $("sd-file")?.addEventListener("change", e => {
                const f = e.target.files && e.target.files[0];
                if (!f) return;
                const r = new FileReader();
                r.onload = () => {
                    const ta = $("sd-boundary");
                    if (ta) ta.value = String(r.result || "");
                    if (applyBoundary(String(r.result || ""), true)) ctx.showToast(`Boundary drawn from ${f.name}: ${state.verts.length} corners${state.boundaryInfo && state.boundaryInfo.skipped ? ` (${state.boundaryInfo.skipped} other point(s) skipped by the filter)` : ""}.`);
                };
                r.readAsText(f);
            });
            $("btn-sd-max")?.addEventListener("click", () => {
                if (!state.verts) return;
                const s = readSettings();
                const errs = E.validate(Object.assign({}, s, { nLots: 1 }), state.verts);
                if (errs.length) { showErrors(errs); return; }
                const n = E.bestLots(state.verts, s);
                $("sd-nLots").value = String(n);
                syncRange($("sd-nLots-r"), n);
                recompute();
                ctx.showToast(`${n} lots — the most that meet every minimum with these settings.`);
            });
            $("btn-sd-reset")?.addEventListener("click", () => {
                if (!state.verts) { ctx.showToast("Load a boundary first.", true); return; }
                state.settings = E.recommended(state.verts, state.settings ? state.settings.frontEdge : undefined);
                tuneRanges(state.settings);
                writeSettings(state.settings);
                recompute();
                ctx.showToast("Recommended settings applied — check them against the local code.");
            });
            $("sd-lots-tbody")?.addEventListener("click", e => {
                const tr = e.target.closest && e.target.closest("tr[data-lot]");
                if (tr) select(+tr.getAttribute("data-lot"));
            });
            $("sd-lots-tbody")?.addEventListener("mouseover", e => {
                const tr = e.target.closest && e.target.closest("tr[data-lot]");
                const id = tr ? +tr.getAttribute("data-lot") : null;
                if (id !== state.hover) { state.hover = id; renderPlan(); renderHover(); }
            });
            $("btn-sd-dxf")?.addEventListener("click", () => exportDxf(ctx));
            $("btn-sd-pdf")?.addEventListener("click", () => exportPdf(ctx));
            $("btn-sd-landxml")?.addEventListener("click", () => {
                if (!state.layout) return;
                window.COGO.downloadText(exportName("xml"), E.toLandXml(state.layout, { name: "Subdivision concept" }), "application/xml");
                ctx.showToast("LandXML exported — lots, right-of-way, open space and ponds as parcels.");
            });
            $("btn-sd-send-lw")?.addEventListener("click", () => {
                const L = state.layout, LW = window.Linework;
                if (!L || !LW || !LW.loadFigures) return;
                const pt = (p, i) => ({ e: p.e, n: p.n, z: 0, ptNum: null, desc: "" });
                const figs = [];
                L.lots.forEach(l => l.rings.forEach((r, i) => figs.push({ id: `LOT${l.id}-${i}`, name: `LOT-${l.id}`, code: "LOT", layer: "SUBD-LOT", closed: true, pts: r.map(pt) })));
                L.roadEdges.forEach((e, i) => figs.push({ id: `ROW${i}`, name: `ROW-${i + 1}`, code: "ROW", layer: "SUBD-ROAD-ROW", closed: false, pts: e.map(pt) }));
                L.roadCentre.forEach((c, i) => figs.push({ id: `CL${i}`, name: `CL-${i + 1}`, code: "CLINE", layer: "SUBD-ROAD-CL", closed: false, pts: c.map(pt) }));
                LW.loadFigures(figs);
                document.querySelector('.nav-btn[data-tab="tab-linework"]')?.click();
                ctx.showToast(`Sent ${L.lots.length} lot(s) and the road to the Linework Editor.`);
            });
            $("btn-sd-from-eb")?.addEventListener("click", () => {
                const EB = window.EasyButton, LW = window.Linework;
                const figs = EB && EB.state && EB.state.build ? (EB.state.handoff && LW && LW.getFigures ? LW.getFigures() : EB.state.build.figures) : [];
                const bnd = figs.filter(f => (f.ourCode || f.code) === "BND" && f.closed && f.pts && f.pts.length >= 3)
                    .reduce((m, f) => (!m || window.COGO.shoelaceArea(f.pts) > window.COGO.shoelaceArea(m.pts) ? f : m), null);
                if (!bnd) { ctx.showToast("No closed boundary (BND) figure in Easy Button — build its field data first.", true); return; }
                const text = bnd.pts.map(p => `${p.n.toFixed(3)}, ${p.e.toFixed(3)}`).join("\n");
                const ta = $("sd-boundary"); if (ta) ta.value = text;
                if (applyBoundary(text, true)) ctx.showToast(`Boundary taken from Easy Button's BND figure (${bnd.pts.length} corners).`);
            });
            $("btn-sd-scn-save")?.addEventListener("click", () => {
                if (!state.layout) { ctx.showToast("Fix the settings first — there's no layout to save.", true); return; }
                const name = (($("sd-scn-name") || {}).value || "").trim() || `Scenario ${loadScenarios().length + 1}`;
                const a = loadScenarios().filter(x => x.name !== name).concat([scenarioOf(name)]);
                if (!saveScenarios(a)) { ctx.showToast("This browser won't store scenarios.", true); return; }
                renderScenarios();
                ctx.showToast(`Scenario "${name}" saved: ${state.layout.lots.length} lots.`);
            });
            $("sd-scn-tbody")?.addEventListener("click", e => {
                const ld = e.target.closest && e.target.closest("[data-scn-load]"), dl = e.target.closest && e.target.closest("[data-scn-del]");
                const a = loadScenarios();
                if (ld) {
                    const x = a[+ld.dataset.scnLoad];
                    if (!x) return;
                    const ta = $("sd-boundary"); if (ta) ta.value = x.boundary;
                    const u = $("sd-units"); if (u) u.value = "ft";
                    const r = E.parseBoundary(x.boundary);
                    if (r.error) { ctx.showToast(r.error, true); return; }
                    state.verts = r.verts; fillFrontage(r.verts);
                    state.settings = Object.assign({}, x.settings);
                    tuneRanges(state.settings); writeSettings(state.settings); recompute();
                    ctx.showToast(`Scenario "${x.name}" loaded.`);
                } else if (dl) {
                    a.splice(+dl.dataset.scnDel, 1); saveScenarios(a); renderScenarios();
                }
            });
            renderScenarios();
            bindPlan();
        },
        onTabActivate() {
            if (!state.verts) {
                const ta = $("sd-boundary");
                if (ta && !ta.value.trim()) ta.value = E.SAMPLE;
                applyBoundary(ta ? ta.value : E.SAMPLE, false);
            }
        }
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);

    window.Subdivision = { readSettings, writeSettings, recompute, applyBoundary, state };
})();
