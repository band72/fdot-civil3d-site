/**
 * Plugin: easy-button (Easy Button — field data to drawing)
 * plugins/easy-button/easy-button.js
 *
 * A guided path through the existing tools; it changes none of them:
 *   1. the client's code list (code, description, our code) is parsed, matched and saved as a
 *      reusable profile (this browser; export / import as JSON);
 *   2. a field file in the client's codes is translated to ours and built into figures with the
 *      Linework engine — lines on our default layers, point features kept for symbols;
 *   3. the result opens in the Linework Editor for editing;
 *   4. our codes are matched to the client's template layers and symbols, and the drawing — the
 *      editor's linework, symbols with attributes — is written into the template
 *      (plugins/dxf-template). Matches are saved with the profile;
 *   5. pipe crossings are found (plugins/pipe-crossings); boxes drawn on the plan get crossing
 *      tables in the JEA Pipe Crossing Table format, written into the DXF beside them
 *      (the step's UI is plugins/easy-button/easy-crossings-ui.js, loaded first).
 *
 * Exposes window.EasyButton = { state, setCodeRows, build } for tests.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "easy-button",
        version: "1.0.0",
        description: "Guided field-data-to-drawing workflow: client code list → field data → linework, orchestrating the Linework engine and editor.",
        tab: "tab-easy-button",
        icon: "fa-wand-magic-sparkles",
        tier: "Pro",
        dependencies: ["linework"]
    };

    const E = window.EasyEngine;
    const clean = window.cleanText;
    const $ = id => document.getElementById(id);
    const STORE_KEY = "easyButton.profiles.v1";
    const state = { rows: [], build: null, ctx: null, tpl: null, tplName: "", tmap: null, savedMap: null, handoff: false, crossings: null, boxes: [], drag: null };

    // ── Profiles (browser storage is a convenience — export the JSON to keep one safe) ──

    function loadStore() {
        try { const o = JSON.parse(localStorage.getItem(STORE_KEY) || "{}"); return o && typeof o === "object" ? o : {}; } catch (e) { return {}; }
    }
    function saveStore(o) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); return true; } catch (e) { return false; }
    }
    function fillProfiles(selected) {
        const sel = $("eb-profile");
        if (!sel) return;
        const names = Object.keys(loadStore()).sort();
        sel.textContent = "";
        const first = document.createElement("option");
        first.value = ""; first.textContent = names.length ? "— choose a profile —" : "— none saved —";
        sel.appendChild(first);
        names.forEach(n => { const o = document.createElement("option"); o.value = n; o.textContent = n; sel.appendChild(o); });
        if (selected) sel.value = selected;
    }

    // ── Database profiles (bridge server) and the remembered template (this browser) ──

    function currentProfile() {
        const name = ($("eb-profile-name") || {}).value || ($("eb-profile") || {}).value;
        return E.makeProfile(name, state.rows, state.tmap && Object.assign({ name: state.tplName }, state.tmap));
    }

    async function refreshDbNames() {
        const DB = window.DatabaseService, dl = $("eb-db-names");
        if (!DB || !DB.easyProfiles || !dl || !$("btn-eb-db-load")) return;
        try {
            const r = await DB.easyProfiles();
            dl.textContent = "";
            r.profiles.forEach(p => { const o = document.createElement("option"); o.value = p.name; dl.appendChild(o); });
        } catch (e) { /* no bridge running — the database buttons say so when used */ }
    }

    // Templates can be several MB, so they're kept in IndexedDB (per browser), keyed by profile name;
    // "__last__" is the most recent one. A convenience: if it's gone, the template is uploaded again.
    const IDB = { name: "easyButton", store: "templates" };
    function idb() {
        return new Promise((resolve, reject) => {
            try {
                if (typeof indexedDB === "undefined") return reject(new Error("no IndexedDB"));
                const r = indexedDB.open(IDB.name, 1);
                r.onupgradeneeded = () => r.result.createObjectStore(IDB.store);
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            } catch (e) { reject(e); }
        });
    }
    async function idbPut(key, value) {
        try {
            const db = await idb();
            await new Promise((res, rej) => { const tx = db.transaction(IDB.store, "readwrite"); tx.objectStore(IDB.store).put(value, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
            db.close();
            return true;
        } catch (e) { return false; }
    }
    async function idbGet(key) {
        try {
            const db = await idb();
            const v = await new Promise((res, rej) => { const q = db.transaction(IDB.store).objectStore(IDB.store).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
            db.close();
            return v || null;
        } catch (e) { return null; }
    }
    function rememberTemplate(text, name) {
        const rec = { name, text, savedAt: new Date().toISOString() };
        idbPut("__last__", rec);
        const prof = ($("eb-profile-name") || {}).value;
        if (prof) idbPut("profile:" + prof, rec);
    }
    /** Load the template remembered for a profile (or the last one used). */
    async function restoreTemplate(profileName, ctx) {
        const rec = (profileName && await idbGet("profile:" + profileName)) || (!profileName && await idbGet("__last__"));
        if (!rec || !rec.text) return false;
        loadTemplate(rec.text, rec.name, ctx, { remembered: true });
        return true;
    }

    // ── Code list ─────────────────────────────────────────────────────────────

    function setCodeRows(parsed) {
        state.rows = parsed.rows;
        showMsgs("eb-codes-msgs", parsed.errors, parsed.warnings);
        renderCodes();
    }

    function showMsgs(id, errors, warnings) {
        const el = $(id);
        if (!el) return;
        const items = (errors || []).map(m => `<div class="err"><i class="fa-solid fa-circle-xmark"></i> ${clean(m)}</div>`)
            .concat((warnings || []).map(m => `<div><i class="fa-solid fa-triangle-exclamation"></i> ${clean(m)}</div>`));
        el.hidden = !items.length;
        window.setSafeHTML(el, items.join(""));
    }

    const STATUS_TEXT = { matched: "Matched", suggested: "Suggested — check", unknown: "Not one of ours", unmapped: "Not mapped" };

    function renderCodes() {
        const tb = $("eb-codes-tbody");
        if (!tb) return;
        const options = E.OUR_CODES.map(o => `<option value="${o.code}">${clean(`${o.code} — ${o.description}`)}</option>`).join("");
        window.setSafeRows(tb, state.rows.map((r, i) => `<tr>
            <td><code>${clean(r.code)}</code></td><td>${clean(r.description)}</td>
            <td><select data-eb-row="${i}" aria-label="Our code for ${clean(r.code)}"><option value="">— not mapped —</option>${options}</select></td>
            <td><span class="eb-status ${r.status}">${STATUS_TEXT[r.status]}</span></td>
            <td>${clean(r.suggestions.map(x => `${x.code} (${Math.round(x.score * 100)}%)`).join(", ") || "—")}</td></tr>`).join(""));
        tb.querySelectorAll("select[data-eb-row]").forEach(sel => { sel.value = state.rows[+sel.dataset.ebRow].ourCode || ""; });
        const c = s => state.rows.filter(r => r.status === s).length;
        const sum = $("eb-codes-summary");
        if (sum) window.setSafeHTML(sum, state.rows.length ? [
            `<span class="eb-chip"><b>${state.rows.length}</b> codes</span>`,
            `<span class="eb-chip ok"><b>${c("matched")}</b> matched</span>`,
            c("suggested") ? `<span class="eb-chip warn"><b>${c("suggested")}</b> suggested — check</span>` : "",
            c("unknown") + c("unmapped") ? `<span class="eb-chip bad"><b>${c("unknown") + c("unmapped")}</b> not mapped</span>` : ""
        ].join("") : "");
    }

    function loadCodesText(text, ctx, label) {
        const parsed = E.parseCodeList(text);
        setCodeRows(parsed);
        if (parsed.rows.length) ctx.showToast(`${label}: ${parsed.rows.length} code(s) loaded.`, !!parsed.errors.length);
        else ctx.showToast(parsed.errors[0] || "No codes found.", true);
    }

    // ── Field data → figures ──────────────────────────────────────────────────

    function build(ctx) {
        const text = ($("eb-field") || {}).value || "";
        if (!text.trim()) { ctx.showToast("Load or paste a field file first.", true); return null; }
        if (!state.rows.length) { ctx.showToast("Load a code list (step 1) first.", true); return null; }
        const mapping = E.mappingOf(state.rows);
        const order = ($("eb-order") || {}).value || "NE";
        const b = E.buildFromField(text, order, mapping, "byCode", E.sizesOf(state.rows), E.materialsOf(state.rows));
        state.build = Object.assign(b, { mapping, order, text });
        state.handoff = false;
        if (!b.points.length) { showMsgs("eb-build-msgs", ["No point rows recognized — check the coordinate order and delimiter."], []); setReady(false); return b; }
        const warns = [];
        if (b.stats.skipped) warns.push(`${b.stats.skipped} row(s) skipped (not P,N,E,Z,D).`);
        warns.push(...(b.warnings || []));
        if (b.stats.unmappedShots) warns.push(`${b.stats.unmappedShots} shot(s) use codes with no match — they're on layer ${E.UNMAPPED_LAYER} until you map them.`);
        showMsgs("eb-build-msgs", [], warns);
        renderBuild();
        if (state.tpl) applyTemplate();
        setReady(true);
        ctx.showToast(`Built ${b.stats.figures} figure(s) and ${b.stats.features} point feature(s) from ${b.stats.shots} shots.`);
        return b;
    }

    function renderBuild() {
        const b = state.build;
        if (!b) return;
        const sum = $("eb-build-summary");
        if (sum) window.setSafeHTML(sum, [
            `<span class="eb-chip"><b>${b.stats.shots}</b> shots</span>`,
            `<span class="eb-chip ok"><b>${b.stats.mappedShots}</b> matched</span>`,
            b.stats.unmappedShots ? `<span class="eb-chip bad"><b>${b.stats.unmappedShots}</b> unmatched</span>` : "",
            `<span class="eb-chip"><b>${b.stats.figures}</b> figures (${b.stats.pipes} pipes)</span>`,
            `<span class="eb-chip"><b>${b.stats.features}</b> point features</span>`
        ].join("") + Object.keys(b.counts).sort().map(k => `<span class="eb-chip">${clean(k)} <b>${b.counts[k]}</b></span>`).join(""));
        const un = Object.keys(b.unmapped).sort();
        const wrap = $("eb-unmapped"), tb = $("eb-unmapped-tbody");
        if (wrap) wrap.hidden = !un.length;
        if (tb) window.setSafeRows(tb, un.map(k => {
            const inList = state.rows.some(r => r.code === k);
            return `<tr><td><code>${clean(k)}</code></td><td>${b.unmapped[k]}</td><td>${inList
                ? "In the code list — pick its our code in step 1, then build again"
                : `<button class="btn btn-secondary btn-sm" data-eb-add="${clean(k)}">Add to the code list</button>`}</td></tr>`;
        }).join(""));
        const ft = $("eb-features-tbody");
        if (ft) window.setSafeRows(ft, b.features.map(f => `<tr><td>${clean(String(f.ptNum))}</td><td>${f.code ? clean(f.code) : "<em>unmatched</em>"}</td>
            <td>${clean(f.layer)}</td><td>${clean(f.symbol || "—")}</td><td>${f.z == null || !isFinite(f.z) ? "—" : f.z.toFixed(2)}</td><td>${clean(f.desc)}</td></tr>`).join(""));
    }

    function setReady(on) {
        ["btn-eb-open-editor", "btn-eb-dl-pnezd", "btn-eb-dl-features", "btn-eb-dl-script", "btn-eb-dl-prefixes"].forEach(id => { const b = $(id); if (b) b.disabled = !on; });
        const w = $("btn-eb-write"); if (w) w.disabled = !(state.build && state.tpl);
        const xw = $("btn-eb-x-write"); if (xw) xw.disabled = !(state.build && state.tpl);
    }

    // ── Template (step 4) ─────────────────────────────────────────────────────

    function loadTemplate(text, name, ctx, opts) {
        let tpl;
        try { tpl = window.DxfTemplate.readTemplate(text); }
        catch (err) { showMsgs("eb-tpl-msgs", [`${name}: ${err.message}`], []); ctx.showToast("That template couldn't be read.", true); return; }
        state.tpl = tpl; state.tplName = name;
        const warns = [];
        if (opts && opts.remembered) warns.push(`Using the template remembered in this browser: ${name}. Upload another to replace it.`);
        else rememberTemplate(text, name);
        if (!tpl.blocks.some(b => !/^[_*]/.test(b.name))) warns.push("The template has no symbols (block definitions) — point features will be drawn as points with labels.");
        if (tpl.entityCount) warns.push(`The template already has ${tpl.entityCount} entities (title block, notes…) — they're kept, and the survey is added alongside.`);
        showMsgs("eb-tpl-msgs", [], warns);
        applyTemplate();
        ctx.showToast(`Template ${name}: ${tpl.layers.length} layers, ${tpl.blocks.filter(b => !/^[_*]/.test(b.name)).length} symbols.`);
    }

    /** Suggested matches for the codes in use, with any saved (profile) matches that fit this template. */
    function applyTemplate() {
        const tpl = state.tpl;
        if (!tpl) return;
        const codes = E.codesInUse(state.rows, state.build);
        const map = E.suggestTemplateMap(tpl, codes);
        const saved = state.savedMap, layers = new Set(tpl.layers.map(l => l.name)), blocks = new Set(tpl.blocks.map(b => b.name));
        if (saved) codes.forEach(o => {
            if (saved.layer[o.code] && layers.has(saved.layer[o.code])) map.layer[o.code] = saved.layer[o.code];
            if (saved.symbol[o.code] && blocks.has(saved.symbol[o.code])) map.symbol[o.code] = saved.symbol[o.code];
        });
        state.tmap = map;
        renderTemplate();
        setReady(!!state.build);
    }

    function renderTemplate() {
        const tpl = state.tpl, map = state.tmap, tb = $("eb-tpl-tbody");
        if (!tpl || !map || !tb) return;
        const sum = $("eb-tpl-summary");
        const symbols = tpl.blocks.filter(b => !/^[_*]/.test(b.name));
        if (sum) window.setSafeHTML(sum, [
            `<span class="eb-chip">${clean(state.tplName)}</span>`,
            `<span class="eb-chip">DXF ${clean(tpl.version || "version unknown")}${tpl.handles ? "" : " (no handles)"}</span>`,
            `<span class="eb-chip"><b>${tpl.layers.length}</b> layers</span>`,
            `<span class="eb-chip"><b>${symbols.length}</b> symbols</span>`
        ].join(""));
        const layerOpts = tpl.layers.map(l => `<option value="${clean(l.name)}">${clean(l.name)}</option>`).join("");
        const symOpts = symbols.map(b => `<option value="${clean(b.name)}">${clean(b.name)}${b.attdefs.length ? clean(` (${b.attdefs.map(a => a.tag).join(", ")})`) : ""}</option>`).join("");
        const codes = E.codesInUse(state.rows, state.build);
        window.setSafeRows(tb, codes.map(o => {
            const def = o.layer || window.LineworkEngine.defaultLayer(o.code);
            return `<tr><td><code>${clean(o.code)}</code></td><td>${clean(o.description)}</td>
                <td><select data-eb-tl="${clean(o.code)}" aria-label="Template layer for ${clean(o.code)}"><option value="">Add “${clean(def)}” as a new layer</option>${layerOpts}</select></td>
                <td>${o.kind === "point" ? `<select data-eb-ts="${clean(o.code)}" aria-label="Symbol for ${clean(o.code)}"><option value="">No symbol — point and label</option>${symOpts}</select>` : (o.pipe ? "3D polyline (inverts)" : "polyline")}</td></tr>`;
        }).join(""));
        tb.querySelectorAll("select[data-eb-tl]").forEach(sel => { sel.value = map.layer[sel.dataset.ebTl] || ""; });
        tb.querySelectorAll("select[data-eb-ts]").forEach(sel => { sel.value = map.symbol[sel.dataset.ebTs] || ""; });
    }

    /** The linework to write: the editor's (edited) figures after "Open in Linework Editor", else the build's. */
    function currentFigures() {
        const LW = window.Linework;
        const figs = state.handoff && LW && LW.getFigures ? LW.getFigures() : [];
        if (figs.length) return { figures: figs, source: "the Linework Editor (with your edits)" };
        return { figures: state.build.figures, source: "the build (not opened in the editor)" };
    }

    function writeDrawing(ctx) {
        if (!state.build || !state.tpl) { ctx.showToast("Build the linework (step 2) and load a template first.", true); return null; }
        const { figures, source } = currentFigures();
        const drawing = E.drawingFromBuild(figures, state.build.features, state.tpl, state.tmap);
        const xing = X.drawing();
        if (xing.error) { showMsgs("eb-write-msgs", [xing.error], []); ctx.showToast(xing.error, true); return null; }
        ["layers", "polylines", "lines", "texts", "inserts", "points"].forEach(k => { drawing[k] = (drawing[k] || []).concat(xing[k] || []); });
        let res;
        try { res = window.DxfTemplate.writeInto(state.tpl, drawing); }
        catch (err) { showMsgs("eb-write-msgs", [err.message], []); ctx.showToast("The drawing couldn't be written.", true); return null; }
        const v = window.DxfTemplate.verify(res.text);
        // Attributes that kept the template default — usually a tag name this tool doesn't recognise.
        const kept = [];
        [...new Set(drawing.inserts.map(i => i.block))].forEach(name => {
            const blk = state.tpl.blocks.find(b => b.name === name);
            const r = blk && window.DxfTemplate.attribReport(blk.attdefs);
            const crossingTags = /CROSS|XING/i.test(name) ? Object.keys(window.PipeCrossings ? window.PipeCrossings.crossingAttribs({ id: "", upper: {}, lower: {}, notes: [] }) : {}) : [];
            const left = r ? r.kept.filter(t => !crossingTags.includes(t)) : [];
            if (left.length) kept.push(`${name}: ${left.join(", ")} kept the template's default (not filled from the shot — if one should be, tell us its tag name)`);
        });
        showMsgs("eb-write-msgs", v.problems, res.warnings.concat(kept));
        const sum = $("eb-write-summary");
        if (sum) window.setSafeHTML(sum, [
            `<span class="eb-chip ${v.ok ? "ok" : "bad"}">${v.ok ? "Checked: every layer and symbol is defined" : "Check found problems"}</span>`,
            `<span class="eb-chip">Linework from ${clean(source)}</span>`,
            `<span class="eb-chip"><b>${drawing.polylines.length}</b> polylines</span>`,
            `<span class="eb-chip"><b>${drawing.inserts.length}</b> symbols</span>`,
            xing.tables ? `<span class="eb-chip"><b>${xing.tables}</b> crossing table(s)</span>` : "",
            drawing.points.length ? `<span class="eb-chip warn"><b>${drawing.points.length}</b> points with labels (no symbol)</span>` : "",
            res.added.layers.length ? `<span class="eb-chip warn">New layers: ${clean(res.added.layers.join(", "))}</span>` : ""
        ].join("") + Object.keys(v.insertsByBlock).sort().map(k => `<span class="eb-chip">${clean(k)} <b>${v.insertsByBlock[k]}</b></span>`).join(""));
        const base = String(state.tplName || "template").replace(/\.dxf$/i, "").replace(/[^\w.-]+/g, "_");
        window.COGO.downloadText(`${base}-survey.dxf`, res.text, "application/dxf");
        ctx.showToast(`Wrote ${drawing.polylines.length} polylines and ${drawing.inserts.length} symbols into ${state.tplName}.`);
        return { res, verify: v, drawing };
    }

    function openInEditor(ctx) {
        const b = state.build, LW = window.Linework;
        if (!b || !LW || !LW.loadFigures) { ctx.showToast("Build the linework first (step 2).", true); return; }
        LW.loadFigures(b.figures);          // the editor gets a copy; this build stays as built
        state.handoff = true;
        document.querySelector('.nav-btn[data-tab="tab-linework"]')?.click();
        ctx.showToast(`Opened ${b.figures.length} figure(s) in the Linework Editor.`);
    }

    function featuresCsv(features) {
        return E.toCsv([["Point", "Northing", "Easting", "Z", "Our code", "Layer", "Symbol", "Field description"]].concat(
            features.map(f => [f.ptNum, f.n.toFixed(4), f.e.toFixed(4), f.z == null || !isFinite(f.z) ? "" : f.z.toFixed(4), f.code || "", f.layer, f.symbol || "", f.desc])));
    }

    // ── Pipe crossings (step 5) — plugins/easy-button/easy-crossings-ui.js ─────

    const X = window.EasyCrossingsUI.create({ state, $, clean, E, showMsgs, currentFigures });


    // ── Plugin ────────────────────────────────────────────────────────────────

    const readFile = (input, cb) => {
        const f = input && input.files && input.files[0];
        if (!f) return;
        const r = new FileReader();
        r.onload = () => cb(String(r.result || ""), f.name);
        r.readAsText(f);
    };

    const Plugin = {
        init(ctx) { state.ctx = ctx; },
        onTabActivate(ctx) {
            refreshDbNames();
            if (!state.tpl && !state.triedRestore) { state.triedRestore = true; restoreTemplate(null, ctx || state.ctx); }
        },
        setupEvents(ctx) {
            state.ctx = ctx;
            fillProfiles();
            $("btn-eb-our-codes")?.addEventListener("click", () => window.COGO.downloadText("our-codes.csv", E.ourCodesCsv(), "text/csv"));
            $("btn-eb-blank")?.addEventListener("click", () => window.COGO.downloadText("code-list-template.csv", "Code,Description,Our code\r\n", "text/csv"));
            $("btn-eb-sample-codes")?.addEventListener("click", () => loadCodesText(E.SAMPLE_CODES, ctx, "Sample code list"));
            $("eb-codes-file")?.addEventListener("change", e => readFile(e.target, (t, n) => loadCodesText(t, ctx, n)));
            $("eb-codes-tbody")?.addEventListener("change", e => {
                const sel = e.target.closest && e.target.closest("select[data-eb-row]");
                if (!sel) return;
                const r = state.rows[+sel.dataset.ebRow];
                r.ourCode = sel.value;
                r.status = sel.value ? "matched" : "unmapped";
                renderCodes();
            });
            $("btn-eb-save-profile")?.addEventListener("click", () => {
                if (!state.rows.length) { ctx.showToast("Load a code list first.", true); return; }
                let p;
                try { p = E.makeProfile(($("eb-profile-name") || {}).value, state.rows, state.tmap && Object.assign({ name: state.tplName }, state.tmap)); } catch (err) { ctx.showToast(err.message, true); return; }
                const store = loadStore();
                store[p.name] = p;
                if (!saveStore(store)) { ctx.showToast("This browser won't store profiles — use Export to keep a copy.", true); return; }
                fillProfiles(p.name);
                ctx.showToast(`Profile "${p.name}" saved in this browser.`);
            });
            $("btn-eb-load-profile")?.addEventListener("click", () => {
                const name = ($("eb-profile") || {}).value, p = loadStore()[name];
                if (!p) { ctx.showToast("Choose a saved profile first.", true); return; }
                try { setCodeRows(E.rowsFromProfile(p)); } catch (err) { ctx.showToast(err.message, true); return; }
                state.savedMap = E.templateMapFromProfile(p);
                if (state.tpl) applyTemplate();
                restoreTemplate(name, ctx);
                const nm = $("eb-profile-name"); if (nm) nm.value = name;
                ctx.showToast(`Profile "${name}" loaded.`);
            });
            $("btn-eb-delete-profile")?.addEventListener("click", () => {
                const name = ($("eb-profile") || {}).value;
                if (!name) { ctx.showToast("Choose a saved profile first.", true); return; }
                ctx.showConfirmModal(`Delete the profile "${name}" from this browser?`).then(ok => {
                    if (!ok) return;
                    const store = loadStore(); delete store[name]; saveStore(store); fillProfiles();
                    ctx.showToast(`Profile "${name}" deleted.`);
                });
            });
            $("btn-eb-export-profile")?.addEventListener("click", () => {
                if (!state.rows.length) { ctx.showToast("Load a code list first.", true); return; }
                const name = ($("eb-profile-name") || {}).value || ($("eb-profile") || {}).value;
                let p;
                try { p = E.makeProfile(name, state.rows, state.tmap && Object.assign({ name: state.tplName }, state.tmap)); } catch (err) { ctx.showToast(err.message + " (it's used as the file name).", true); return; }
                window.COGO.downloadText(`${p.name.replace(/[^\w.-]+/g, "_")}.easy-profile.json`, JSON.stringify(p, null, 2), "application/json");
            });
            $("eb-profile-file")?.addEventListener("change", e => readFile(e.target, (t, n) => {
                try { const obj = JSON.parse(t); setCodeRows(E.rowsFromProfile(obj)); state.savedMap = E.templateMapFromProfile(obj); if (state.tpl) applyTemplate(); ctx.showToast(`Profile imported from ${n}.`); }
                catch (err) { ctx.showToast(`${n}: ${err.message}`, true); }
            }));
            $("btn-eb-db-save")?.addEventListener("click", async () => {
                if (!state.rows.length) { ctx.showToast("Load a code list first.", true); return; }
                let p;
                try { p = currentProfile(); } catch (err) { ctx.showToast(err.message, true); return; }
                try { const r = await window.DatabaseService.saveEasyProfile(p); ctx.showToast(r.message); refreshDbNames(); }
                catch (err) { ctx.showToast(`Database: ${err.message} Is the bridge server running (npm start)?`, true); }
            });
            $("btn-eb-db-load")?.addEventListener("click", async () => {
                const name = (($("eb-profile-name") || {}).value || "").trim();
                if (!name) { ctx.showToast("Type the profile's name in “Save as” first.", true); return; }
                try {
                    const r = await window.DatabaseService.easyProfiles(name);
                    setCodeRows(E.rowsFromProfile(r.profile));
                    state.savedMap = E.templateMapFromProfile(r.profile);
                    if (state.tpl) applyTemplate();
                    restoreTemplate(name, ctx);
                    ctx.showToast(`Profile "${name}" loaded from the database.`);
                } catch (err) { ctx.showToast(`Database: ${err.message}`, true); }
            });
            $("btn-eb-sample-field")?.addEventListener("click", () => { const ta = $("eb-field"); if (ta) ta.value = E.SAMPLE_FIELD; });
            $("eb-field-file")?.addEventListener("change", e => readFile(e.target, t => { const ta = $("eb-field"); if (ta) ta.value = t; }));
            $("btn-eb-build")?.addEventListener("click", () => build(ctx));
            $("eb-unmapped-tbody")?.addEventListener("click", e => {
                const btn = e.target.closest && e.target.closest("button[data-eb-add]");
                if (!btn) return;
                const code = btn.dataset.ebAdd, sugg = E.suggest(code, "");
                state.rows.push({ line: null, code, description: "", ourCode: "", given: "", status: "unmapped", suggestions: sugg });
                renderCodes(); renderBuild();
                ctx.showToast(`${code} added to the code list — pick its our code in step 1, then build again.`);
            });
            $("btn-eb-open-editor")?.addEventListener("click", () => openInEditor(ctx));
            $("eb-tpl-file")?.addEventListener("change", e => readFile(e.target, (t, n) => loadTemplate(t, n, ctx)));
            $("btn-eb-tpl-jea")?.addEventListener("click", () => {
                if (!window.Jea24 || !window.Jea24.buildJeaDxf) { ctx.showToast("The JEA template plugin isn't loaded.", true); return; }
                loadTemplate(window.Jea24.buildJeaDxf({ pipes: [], structures: [], crossings: [] }), "JEA_AsBuilt_2026.dxf", ctx);
            });
            $("eb-tpl-tbody")?.addEventListener("change", e => {
                const t = e.target;
                if (!state.tmap || !t.dataset) return;
                if (t.dataset.ebTl) state.tmap.layer[t.dataset.ebTl] = t.value;
                if (t.dataset.ebTs) state.tmap.symbol[t.dataset.ebTs] = t.value;
            });
            $("btn-eb-write")?.addEventListener("click", () => writeDrawing(ctx));
            X.setupEvents(ctx);
            $("btn-eb-x-write")?.addEventListener("click", () => writeDrawing(ctx));
            $("btn-eb-dl-pnezd")?.addEventListener("click", () => { if (state.build) window.COGO.downloadText("field-our-codes.txt", E.translatedPnezd(state.build.points, state.build.mapping), "text/plain"); });
            $("btn-eb-dl-features")?.addEventListener("click", () => { if (state.build) window.COGO.downloadText("point-features.csv", featuresCsv(state.build.features), "text/csv"); });
            $("btn-eb-dl-script")?.addEventListener("click", () => {
                if (!state.build || !window.Linework || !window.Linework.buildLineworkScript) return;
                const { figures, source } = currentFigures();
                window.COGO.downloadText("easy-button-linework.fbk", window.Linework.buildLineworkScript(figures), "text/plain");
                ctx.showToast(`Civil 3D linework script: ${figures.length} figure(s) from ${source}.`);
            });
            $("btn-eb-dl-prefixes")?.addEventListener("click", () => {
                if (!state.build) return;
                window.COGO.downloadText("figure-prefixes.csv", E.figurePrefixCsv(E.codesInUse(state.rows, state.build), state.tmap), "text/csv");
            });
            $("btn-eb-dl-mapping")?.addEventListener("click", () => {
                if (!state.rows.length) { ctx.showToast("Load a code list first.", true); return; }
                window.COGO.downloadText("code-list-mapped.csv", E.mappingCsv(state.rows), "text/csv");
            });
        }
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);

    window.EasyButton = { state, setCodeRows, build, featuresCsv, loadTemplate, writeDrawing, findCrossings: X.find, addBox: X.addBox, boxEvery: X.boxEvery, crossingDrawing: X.drawing, restoreTemplate, idbGet };
})();
