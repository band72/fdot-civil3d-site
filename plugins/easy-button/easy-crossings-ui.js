/**
 * Easy Button — step 5, pipe crossings: the settings form, the find, the results table, the plan
 * (drag a box, wheel to zoom) and the crossing tables written into the template.
 *
 * Split out of easy-button.js; it has no state of its own. easy-button.js calls
 * window.EasyCrossingsUI.create({ state, $, clean, E, showMsgs, currentFigures }) and gets back
 * { setupEvents(ctx), find(ctx), render(), addBox(b), boxEvery(), drawing() }.
 */
(function () {
    "use strict";

    function create(host) {
        const { state, $, clean, E, showMsgs, currentFigures } = host;

        const PX = () => window.PipeCrossings;
        const pipeTypes = () => (window.Jea24Data && window.Jea24Data.DOMAINS["Crossing Pipe Type"]) || [];

        function initCrossingSettings() {
            const calc = $("eb-x-calc");
            if (calc && PX()) {
                calc.textContent = "";
                Object.entries(PX().TOP_CALCS).forEach(([k, c]) => { const o = document.createElement("option"); o.value = k; o.textContent = c.label; calc.appendChild(o); });
            }
            const min = $("eb-x-min");
            // Used only where JEA's §350 rule doesn't decide (no water main in the crossing). Prefilled with
            // 1.0 ft — JEA's figure for pressure crossings — for the user to change to their client's.
            if (min && !min.value) min.value = "1.0";
            const sizes = $("eb-x-sizes");
            if (sizes) window.setSafeHTML(sizes, pipeTypes().map((t, i) => `<label class="eb-x-size" for="eb-x-size-${i}">Default size, ${clean(t)} (in)<input type="number" id="eb-x-size-${i}" data-eb-xtype="${clean(t)}" min="0" step="1" placeholder="none"></label>`).join(""));
        }

        /** Crossing settings from the form; blank required numbers are errors, never defaults. */
        function crossingSettings() {
            const num = (id, label, lo) => {
                const el = $(id), v = el ? el.value.trim() : "";
                if (v === "" || !isFinite(Number(v)) || Number(v) < lo) return { error: `${label} is required (at least ${lo}).` };
                return { value: Number(v) };
            };
            const min = num("eb-x-min", "Minimum separation (ft)", 0), radius = num("eb-x-radius", "Grade search radius (ft)", 1), th = num("eb-x-th", "Table text height (ft)", 0.1);
            const interp = num("eb-x-interp", "Flag inverts interpolated farther than (ft)", 1);
            const errs = [min, radius, th, interp].filter(x => x.error).map(x => x.error);
            const defaults = {};
            document.querySelectorAll("[data-eb-xtype]").forEach(el => {
                const v = el.value.trim();
                if (v === "") return;
                if (!(Number(v) > 0)) errs.push(`Default size for ${el.dataset.ebXtype} must be a positive number of inches (or blank).`);
                else defaults[el.dataset.ebXtype] = Number(v);
            });
            return { errors: errs, calc: ($("eb-x-calc") || {}).value || "walls", waterWall: ($("eb-x-wall") || {}).value || "DI", minSeparation: min.value, gradeRadius: radius.value, maxInterp: interp.value, th: th.value, defaults };
        }

        function pipesAndGround(figures, features) {
            const pipes = [], ground = [];
            figures.forEach((f, i) => {
                const o = E.ourCode(f.ourCode || f.code);
                const mat = f.material && PX() ? PX().parseMaterial(f.material, f.pclass) : null;
                if (o && o.pipe) pipes.push({ id: f.name || f.id || `P${i + 1}`, code: o.code, type: o.utility, size: f.size || null, material: mat && !mat.error ? mat : null, pts: f.pts.map(p => ({ e: p.e, n: p.n, z: p.z })) });
                else f.pts.forEach(p => ground.push({ e: p.e, n: p.n, z: p.z }));
            });
            features.forEach(ft => ground.push({ e: ft.e, n: ft.n, z: ft.z }));
            return { pipes, ground };
        }

        function toLonLatFn() {
            const O = window.Overlay;
            if (!O || !O.state) return null;
            const cs = { zone: O.state.zone, unit: O.state.unit };
            return (e, n) => { try { const ll = O.toLonLat(cs, e, n); return O.inZone(cs.zone, ll) ? ll : null; } catch (err) { return null; } };
        }

        function findCrossings(ctx) {
            if (!state.build) { ctx.showToast("Build the linework (step 2) first.", true); return null; }
            const st = crossingSettings();
            if (st.errors.length) { showMsgs("eb-x-msgs", st.errors, []); return null; }
            const { figures } = currentFigures();
            const { pipes, ground } = pipesAndGround(figures, state.build.features);
            pipes.forEach(p => { if (!p.size && p.type && st.defaults[p.type]) { p.size = st.defaults[p.type]; p.sizeFrom = "default"; } });
            state.crossings = PX().findCrossings(pipes, ground, { calc: st.calc, waterWall: st.waterWall, minSeparation: st.minSeparation, gradeRadius: st.gradeRadius, maxInterp: st.maxInterp, toLonLat: toLonLatFn() });
            state.xsettings = st;
            state.xpipes = pipes;
            state.xview = null;
            const warns = [];
            const noSize = pipes.filter(p => !p.size).map(p => p.code);
            if (noSize.length) warns.push(`No pipe size for ${[...new Set(noSize)].join(", ")} — add a Size column to the code list, write the size on the shots (8"), or set a default above.`);
            if (!pipes.length) warns.push("No pipes in the linework — nothing can cross.");
            showMsgs("eb-x-msgs", [], warns);
            renderCrossings();
            ctx.showToast(`${state.crossings.length} crossing(s) found among ${pipes.length} pipe(s).`);
            return state.crossings;
        }

        const inBox = (b, c) => c.e >= b.e0 && c.e <= b.e1 && c.n >= b.n0 && c.n <= b.n1;
        const boxedIds = () => new Set((state.crossings || []).filter(c => state.boxes.some(b => inBox(b, c))).map(c => c.id));

        function renderCrossings() {
            const xs = state.crossings || [];
            ["btn-eb-x-boxall", "btn-eb-x-clear", "btn-eb-x-csv"].forEach(id => { const b = $(id); if (b) b.disabled = !xs.length; });
            const w = $("btn-eb-x-write"); if (w) w.disabled = !(state.tpl && state.build);
            const boxed = boxedIds();
            const sum = $("eb-x-summary");
            const bad = xs.filter(c => c.compliant === false).length, ns = xs.filter(c => c.compliant == null).length;
            if (sum) window.setSafeHTML(sum, [
                `<span class="eb-chip"><b>${xs.length}</b> crossings</span>`,
                `<span class="eb-chip ok"><b>${xs.filter(c => c.compliant).length}</b> meet the minimum</span>`,
                bad ? `<span class="eb-chip bad"><b>${bad}</b> below the minimum</span>` : "",
                ns ? `<span class="eb-chip warn"><b>${ns}</b> not scored</span>` : "",
                `<span class="eb-chip" title="JEA Standards 2026 §350 III.4.4–III.4.5 decides a crossing with a water main in it; the others use your minimum"><b>${xs.filter(c => /^JEA/.test(String(c.basis))).length}</b> by JEA §350 · <b>${xs.filter(c => c.basis === "your minimum").length}</b> by your minimum</span>`,
                xs.some(c => c.interpolatedFar) ? `<span class="eb-chip warn"><b>${xs.filter(c => c.interpolatedFar).length}</b> with inverts interpolated far from a shot</span>` : "",
                `<span class="eb-chip"><b>${state.boxes.length}</b> box(es), ${boxed.size} crossing(s) boxed</span>`
            ].join(""));
            const f2 = v => (v == null ? "—" : v.toFixed(2));
            const needs = c => [c.requiredFt].filter(v => v != null).map(v => clean(`needs ${(v * 12).toFixed(0)} in (${c.basis})`)).join("");
            const tb = $("eb-x-tbody");
            if (tb) window.setSafeRows(tb, xs.map(c => `<tr><td>${clean(c.id)}</td>
                <td>${clean(`${c.upper.type || "?"} ${c.upper.size ? c.upper.size + '"' : ""}`)}</td><td>${clean(`${c.lower.type || "?"} ${c.lower.size ? c.lower.size + '"' : ""}`)}</td>
                <td>${f2(c.upper.bottom)}</td><td>${f2(c.lower.top)}</td><td>${f2(c.separation)}</td><td>${c.clearanceIn == null ? "—" : c.clearanceIn.toFixed(1)}</td>
                <td class="${c.compliant == null ? "na" : c.compliant ? "ok" : "bad"}" title="${needs(c)}">${c.compliant == null ? "Not scored" : c.compliant ? "Yes" : "No"}${c.interpolatedFar ? ' <span class="eb-status suggested" title="An invert was interpolated far from a shot — check it">check</span>' : ""}</td>
                <td>${boxed.has(c.id) ? "Yes" : "—"}</td><td>${clean(c.notes.concat([c.upper.diameterNote, c.lower.diameterNote]).filter(Boolean).join("; "))}</td></tr>`).join(""));
            renderCrossingPlan();
        }

        const SVGNS = "http://www.w3.org/2000/svg";
        const mk = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
        const TYPE_COLOR = { "Potable Water": "#38bdf8", "Reclaimed": "#c084fc", "Force Main": "#f59e0b", "Gravity Sewer": "#22c55e", "Vacuum Sewer": "#84cc16", "Storm": "#94a3b8" };

        function renderCrossingPlan() {
            const host = $("eb-x-canvas");
            if (!host || !state.build) return;
            const { figures } = currentFigures();
            // bounds by a loop, not Math.min(...points): a big field file overflows the argument stack
            let e0 = Infinity, e1 = -Infinity, n0 = Infinity, n1 = -Infinity;
            figures.forEach(f => f.pts.forEach(p => { e0 = Math.min(e0, p.e); e1 = Math.max(e1, p.e); n0 = Math.min(n0, p.n); n1 = Math.max(n1, p.n); }));
            if (!isFinite(e0)) return;
            const pad = Math.max(e1 - e0, n1 - n0, 10) * 0.08;
            // The view (plan units; y = -northing) — whole site, or where the wheel zoomed to.
            const v = state.xview || { x: e0 - pad, y: -n1 - pad, w: e1 - e0 + 2 * pad, h: n1 - n0 + 2 * pad };
            state.xview = v;
            const px = Math.max(v.w, v.h) / 700;
            const svg = mk("svg", { viewBox: `${v.x} ${v.y} ${v.w} ${v.h}`, preserveAspectRatio: "xMidYMid meet", role: "img", "aria-label": "Pipe crossings plan — drag to draw a box, wheel to zoom" });
            svg.appendChild(mk("rect", { x: Math.min(v.x, e0 - pad), y: Math.min(v.y, -n1 - pad), width: Math.max(v.w, e1 - e0 + 2 * pad) * 3, height: Math.max(v.h, n1 - n0 + 2 * pad) * 3, fill: "transparent", "data-eb-bg": "1" }));
            figures.forEach(f => {
                const o = E.ourCode(f.ourCode || f.code);
                const color = o && o.pipe ? (TYPE_COLOR[o.utility] || "#e2e8f0") : "#334155";
                svg.appendChild(mk("polyline", { points: f.pts.map(p => `${p.e},${-p.n}`).join(" ") + (f.closed && f.pts.length ? ` ${f.pts[0].e},${-f.pts[0].n}` : ""), fill: "none", stroke: color, "stroke-width": (o && o.pipe ? 2.6 : 1.2) * px, "pointer-events": "none" }));
            });
            state.boxes.forEach((b, i) => svg.appendChild(mk("rect", { x: b.e0, y: -b.n1, width: b.e1 - b.e0, height: b.n1 - b.n0, fill: "rgba(250,204,21,0.08)", stroke: "#facc15", "stroke-width": 1.6 * px, "stroke-dasharray": `${6 * px} ${4 * px}`, "data-eb-box": i, style: "cursor:pointer" })));
            (state.crossings || []).forEach(c => {
                const color = c.compliant == null ? "#94a3b8" : c.compliant ? "#22c55e" : "#f43f5e";
                svg.appendChild(mk("circle", { cx: c.e, cy: -c.n, r: 5 * px, fill: color, stroke: "#0b1220", "stroke-width": 1.5 * px, "pointer-events": "none" }));
                const t = mk("text", { x: c.e + 7 * px, y: -c.n - 7 * px, "font-size": 11 * px, fill: color, "font-family": "Inter, sans-serif", "font-weight": 700, "pointer-events": "none" });
                t.textContent = c.id;
                svg.appendChild(t);
            });
            host.textContent = "";
            host.appendChild(svg);
            state.xsvg = svg;
        }

        function planPoint(evt) {
            const svg = state.xsvg, m = svg && svg.getScreenCTM && svg.getScreenCTM();
            if (!m) return null;
            const p = svg.createSVGPoint(); p.x = evt.clientX; p.y = evt.clientY;
            const w = p.matrixTransform(m.inverse());
            return { e: w.x, n: -w.y };
        }

        function bindCrossingPlan() {
            const host = $("eb-x-canvas");
            if (!host) return;
            host.addEventListener("pointerdown", e => {
                if (!state.xsvg || !e.target.getAttribute || !e.target.getAttribute("data-eb-bg")) return;
                const p = planPoint(e);
                if (!p) return;
                state.drag = { start: p, rect: mk("rect", { fill: "rgba(250,204,21,0.12)", stroke: "#facc15", "stroke-width": 1, "pointer-events": "none" }) };
                state.xsvg.appendChild(state.drag.rect);
                if (host.setPointerCapture) host.setPointerCapture(e.pointerId);
            });
            host.addEventListener("pointermove", e => {
                if (!state.drag) return;
                const p = planPoint(e);
                if (!p) return;
                const s0 = state.drag.start, r = state.drag.rect;
                state.drag.end = p;
                r.setAttribute("x", Math.min(s0.e, p.e)); r.setAttribute("y", -Math.max(s0.n, p.n));
                r.setAttribute("width", Math.abs(p.e - s0.e)); r.setAttribute("height", Math.abs(p.n - s0.n));
            });
            host.addEventListener("pointerup", () => {
                const d = state.drag;
                state.drag = null;
                if (!d || !d.end) { renderCrossingPlan(); return; }
                const b = { e0: Math.min(d.start.e, d.end.e), e1: Math.max(d.start.e, d.end.e), n0: Math.min(d.start.n, d.end.n), n1: Math.max(d.start.n, d.end.n) };
                if (b.e1 - b.e0 > 0.5 && b.n1 - b.n0 > 0.5) addBox(b);
                else renderCrossingPlan();
            });
            host.addEventListener("wheel", e => {
                if (!state.xview || !state.xsvg) return;
                e.preventDefault();
                const p = planPoint(e);
                if (!p) return;
                const k = e.deltaY > 0 ? 1.25 : 0.8, v = state.xview, x = p.e, y = -p.n;
                state.xview = { x: x - (x - v.x) * k, y: y - (y - v.y) * k, w: v.w * k, h: v.h * k };
                renderCrossingPlan();
            }, { passive: false });
            host.addEventListener("dblclick", () => { state.xview = null; renderCrossingPlan(); });
            host.addEventListener("click", e => {
                const i = e.target.getAttribute && e.target.getAttribute("data-eb-box");
                if (i == null) return;
                state.boxes.splice(+i, 1);
                renderCrossings();
            });
        }

        function addBox(b) {
            state.boxes.push(b);
            renderCrossings();
            const n = (state.crossings || []).filter(c => inBox(b, c)).length;
            if (state.ctx) state.ctx.showToast(n ? `Box added around ${n} crossing(s).` : "Box added — it has no crossings in it, so it gets no table.", !n);
        }

        function boxEvery() {
            const pad = Math.max(10, (state.xsettings ? state.xsettings.th : 2.5) * 6);
            state.boxes = (state.crossings || []).map(c => ({ e0: c.e - pad, e1: c.e + pad, n0: c.n - pad, n1: c.n + pad }));
            renderCrossings();
        }

        /** Crossing tables, boxes and markers for the DXF (only boxes with crossings get a table). */
        function crossingDrawing() {
            const out = { layers: [], polylines: [], lines: [], texts: [], inserts: [], points: [], tables: 0 };
            if (!state.boxes.length || !state.crossings || !state.tpl) return out;
            const st = crossingSettings();
            if (st.errors.length) return { error: st.errors[0] };
            const T = window.DxfTemplate, tpl = state.tpl;
            const feature = { code: "XING", description: "Utility pipe crossing", aliases: ["CROSS", "CROSSING", "XING", "CRSG"] };
            const L = T.rank(tpl.layers.map(l => l.name), Object.assign({ preferred: "UTIL-CROSS" }, feature), 1)[0];
            const layer = L && L.score >= 0.5 ? L.name : "UTIL-CROSS";
            if (!L || L.score < 0.5) out.layers.push({ name: "UTIL-CROSS", color: 7 });
            const B = T.rank(tpl.blocks.map(b => b.name).filter(n => !/^[_*]/.test(n)), Object.assign({ preferred: "JEA_CROSSING" }, feature), 1)[0];
            const sym = B && B.score >= 0.5 ? tpl.blocks.find(b => b.name === B.name) : null;
            const seen = new Set();
            state.boxes.forEach(box => {
                const d = PX().boxDrawing(box, state.crossings, layer, st.th);
                out.polylines.push(...d.polylines); out.lines.push(...d.lines); out.texts.push(...d.texts);
                if (d.markers.length) out.tables++;
                d.markers.forEach(m => {
                    if (seen.has(m.crossing.id)) return;
                    seen.add(m.crossing.id);
                    if (sym) out.inserts.push({ block: sym.name, layer, e: m.e, n: m.n, z: 0, attribs: Object.assign(T.attribValues(sym.attdefs, { e: m.e, n: m.n }), pick(PX().crossingAttribs(m.crossing), sym.attdefs)) });
                    else out.points.push({ layer, e: m.e, n: m.n, z: 0 });
                });
            });
            return out;
        }
        const pick = (vals, attdefs) => { const o = {}; attdefs.forEach(a => { if (vals[a.tag] != null) o[a.tag] = vals[a.tag]; }); return o; };

        function setupEvents(ctx) {
            initCrossingSettings();
            bindCrossingPlan();
            $("btn-eb-x-find")?.addEventListener("click", () => findCrossings(ctx));
            const jeaModel = () => window.EasyEngine.jeaModelFromBuild(state.build, state.crossings, PX() && PX().crossingAttribs, "Easy Button field data");
            $("btn-eb-jea-tables")?.addEventListener("click", () => {
                try {
                    const o = window.JeaXlsx.modelToJeaWorkbook(jeaModel().model, window.Jea24Data.RULES);
                    window.COGO.downloadText("easy_button_jea_asset_tables_2026.xlsx", o.bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
                    ctx.showToast(`JEA 2026 tables: ${Object.entries(o.counts).map(([k, v]) => `${v} ${k}`).join(", ")}. IDs are the shots' point numbers; fill the attributes the field data doesn't carry.`);
                } catch (err) { ctx.showToast(err.message, true); }
            });
            $("btn-eb-jea-package")?.addEventListener("click", () => {
                try {
                    const m = jeaModel();
                    window.Jea24.setPackageInputs({ workbookName: "Easy Button field data", model: m.model, shots: m.shots });
                    document.querySelector('.nav-btn[data-tab="tab-jea24"]')?.click();
                    ctx.showToast("Sent to the JEA tab: load the drawing (.dxf) under Reverse-Read DXF Auditor, then Check Package.");
                } catch (err) { ctx.showToast(err.message, true); }
            });
            $("btn-eb-x-boxall")?.addEventListener("click", () => { boxEvery(); ctx.showToast(`${state.boxes.length} box(es) — one per crossing.`); });
            $("btn-eb-x-clear")?.addEventListener("click", () => { state.boxes = []; renderCrossings(); });
            $("btn-eb-x-csv")?.addEventListener("click", () => {
                if (!state.crossings) return;
                const boxed = boxedIds(), list = state.boxes.length ? state.crossings.filter(c => boxed.has(c.id)) : state.crossings;
                window.COGO.downloadText("pipe-crossings.csv", PX().toCsv(list), "text/csv");
            });
        }

        return { setupEvents, find: findCrossings, render: renderCrossings, addBox, boxEvery, drawing: crossingDrawing };
    }

    window.EasyCrossingsUI = { create };
})();
