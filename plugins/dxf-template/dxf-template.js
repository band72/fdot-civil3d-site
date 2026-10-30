/**
 * Plugin: dxf-template (template drawing reader / writer — no tab of its own)
 * plugins/dxf-template/dxf-template.js
 *
 * Reads a client's template DXF (its layers, and its symbols — block definitions — with their
 * attribute fields), suggests which template layer / symbol fits a feature, and writes new
 * entities INTO the template: the template's header, tables, linetypes, text styles and block
 * definitions are kept exactly as they are; entities are appended to its ENTITIES section,
 * layers it doesn't have are added to its LAYER table, and — in a drawing that uses handles
 * (R2000 and later) — every new object gets a fresh handle, its owner and subclass markers, and
 * $HANDSEED is moved past them.
 *
 * Written entities: POLYLINE (2D with arcs as bulges, or 3D so pipe vertices keep their inverts),
 * INSERT with ATTRIBs (filled from the template's attribute definitions), LINE, POINT and TEXT.
 * Used by plugins/easy-button; pure functions, no DOM. Exposes window.DxfTemplate.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "dxf-template",
        version: "1.0.0",
        description: "Reads a template DXF's layers and symbols (with attribute fields) and writes linework, symbols and labels into it.",
        tab: null,
        icon: "fa-layer-group",
        tier: "Pro",
        dependencies: ["stdn-compare"]
    };

    // ── Tokenizing (strict pairs: the writer edits the file in place) ─────────

    /** Normalised DXF lines: CRs dropped, stray blank lines before a group code removed. */
    function lines(text) {
        const raw = String(text || "").replace(/\r/g, "").split("\n");
        const out = [];
        let expectCode = true;
        for (const ln of raw) {
            if (expectCode && ln.trim() === "") continue;
            out.push(ln);
            expectCode = !expectCode;
        }
        if (out.length % 2) out.pop();
        for (let i = 0; i < out.length; i += 2) {
            if (!/^\s*-?\d{1,4}\s*$/.test(out[i])) throw new Error(`Not a well-formed ASCII DXF: line ${i + 1} ("${out[i].trim().slice(0, 30)}") should be a group code. Re-save the template as an ASCII DXF.`);
        }
        return out;
    }
    const pairsOf = L => { const p = []; for (let i = 0; i < L.length; i += 2) p.push({ code: parseInt(L[i], 10), value: L[i + 1].trim(), at: i }); return p; };

    // ── Reading ───────────────────────────────────────────────────────────────

    /**
     * Read a template. Returns
     *   { version, handles, handseed, layers: [{ name, color, linetype }],
     *     blocks: [{ name, attdefs: [{ tag, prompt, value, x, y, z, height, flags }] }],
     *     entityCount, lines, ids: { layerTable, modelSpace } }
     */
    function readTemplate(text) {
        const L = lines(text), P = pairsOf(L);
        if (!P.some(p => p.code === 0 && p.value === "SECTION")) throw new Error("No DXF sections found — is this a DXF file?");
        const model = window.StdnEngine.parseDxf(L.join("\n"));
        const t = { version: null, handles: false, handseed: null, layers: [], blocks: [], entityCount: model.entities.length, lines: L, ids: { layerTable: null, modelSpace: null } };
        let section = null, maxHandle = 0;
        for (let i = 0; i < P.length; i++) {
            const p = P[i];
            if (p.code === 0 && p.value === "SECTION" && P[i + 1] && P[i + 1].code === 2) section = P[i + 1].value;
            if (p.code === 0 && p.value === "ENDSEC") section = null;
            if (p.code === 9 && p.value === "$ACADVER" && P[i + 1]) t.version = P[i + 1].value;
            if (p.code === 9 && p.value === "$HANDSEED" && P[i + 1]) t.handseed = P[i + 1].value;
            if ((p.code === 5 || p.code === 105) && /^[0-9A-Fa-f]+$/.test(p.value)) { t.handles = true; maxHandle = Math.max(maxHandle, parseInt(p.value, 16)); }
            if (section === "TABLES" && p.code === 0 && p.value === "TABLE" && P[i + 1] && P[i + 1].code === 2 && P[i + 1].value === "LAYER") {
                for (let j = i + 2; j < P.length && P[j].code !== 0; j++) if (P[j].code === 5) t.ids.layerTable = P[j].value;
            }
            if (section === "TABLES" && p.code === 0 && p.value === "BLOCK_RECORD") {
                let name = null, h = null;
                for (let j = i + 1; j < P.length && P[j].code !== 0; j++) { if (P[j].code === 2) name = P[j].value; if (P[j].code === 5) h = P[j].value; }
                if (name && /^\*model_space$/i.test(name)) t.ids.modelSpace = h;
            }
        }
        t.maxHandle = maxHandle;
        t.layers = Object.entries(model.layers).map(([name, e]) => ({ name, color: typeof e.color === "number" ? e.color : null, linetype: e.linetype || null }))
            .sort((a, b) => a.name.localeCompare(b.name));
        // Blocks and their attribute definitions (the shared parser doesn't keep ATTDEFs).
        let blk = null;
        section = null;
        for (let i = 0; i < P.length; i++) {
            const p = P[i];
            if (p.code === 0 && p.value === "SECTION" && P[i + 1] && P[i + 1].code === 2) section = P[i + 1].value;
            if (section !== "BLOCKS" || p.code !== 0) continue;
            if (p.value === "BLOCK") {
                blk = { name: null, attdefs: [] };
                for (let j = i + 1; j < P.length && P[j].code !== 0; j++) if (P[j].code === 2 && blk.name == null) blk.name = P[j].value;
            } else if (p.value === "ENDBLK") {
                if (blk && blk.name && !blk.name.startsWith("*")) t.blocks.push(blk);
                blk = null;
            } else if (p.value === "ATTDEF" && blk) {
                const a = { tag: null, prompt: "", value: "", x: 0, y: 0, z: 0, height: 1, flags: 0 };
                for (let j = i + 1; j < P.length && P[j].code !== 0; j++) {
                    const q = P[j];
                    if (q.code === 2) a.tag = q.value; else if (q.code === 3) a.prompt = q.value; else if (q.code === 1) a.value = q.value;
                    else if (q.code === 10) a.x = +q.value; else if (q.code === 20) a.y = +q.value; else if (q.code === 30) a.z = +q.value;
                    else if (q.code === 40) a.height = +q.value; else if (q.code === 70) a.flags = +q.value;
                }
                if (a.tag) blk.attdefs.push(a);
            }
        }
        t.blocks.sort((a, b) => a.name.localeCompare(b.name));
        return t;
    }

    // ── Matching ──────────────────────────────────────────────────────────────

    const words = s => String(s || "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);

    /**
     * Rank names (template layers or block names) for a feature described by its preferred name,
     * code, description and aliases: an exact preferred name scores 1, otherwise shared words.
     */
    // Layer-name parts that say nothing about the feature (discipline letters, status, "UTIL").
    const GENERIC = new Set(["C", "V", "G", "L", "E", "N", "X", "UTIL", "EX", "EXST", "EXIST", "EXISTING", "PR", "NEW", "DEMO", "PROPOSED", "LN", "LINE"]);

    /**
     * Rank names (template layers or block names) for a feature described by its preferred name,
     * code, description and aliases: an exact preferred name scores 1; otherwise the share of the
     * name's meaningful words the feature uses (ties go to the name matching more words).
     */
    function rank(names, feature, limit) {
        const want = new Set([].concat(words(feature.code), words(feature.description), ...(feature.aliases || []).map(words), words(feature.preferred)));
        const pref = String(feature.preferred || "").toUpperCase();
        return names.map(n => {
            if (pref && n.toUpperCase() === pref) return { name: n, score: 1, hits: Infinity };
            const nw = words(n).filter(w => !GENERIC.has(w));
            const hits = nw.filter(w => want.has(w)).length;
            return { name: n, score: nw.length ? Math.min(0.95, hits / nw.length) : 0, hits };
        }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.hits - a.hits || a.name.localeCompare(b.name)).slice(0, limit || 3)
            .map(({ name, score }) => ({ name, score }));
    }

    // Attribute tags filled from the shot. Anything else keeps the template's default value.
    // Matched after removing spaces, "_", "-", "#" and "." from the tag (PT_NO, PT-NO, PT# → PTNO).
    const ATTR_RULES = [
        { re: /^(PT|PNT|POINT|PTNO|PNTNO|POINTNO|PTNUM|PNTNUM|POINTNUM|POINTNUMBER|PTNUMBER|NUMBER|NUM|NO|ID|PTID|POINTID)$/, from: "ptNum" },
        { re: /^(INV|INVERT|INVELEV|INVERTELEV|INVERTELEVATION|INVEL|IE)$/, from: "z" },
        { re: /^(ELEV|ELEVATION|EL|Z|RIM|RIMELEV|RIMELEVATION|RIMEL|GRADE|GRADEELEV|TOP|TOPELEV|TOPELEVATION|TOPOFNUT|TOPNUT|TON)$/, from: "z" },
        { re: /^(DESC|DESCRIPTION|RAW|RAWDESC|RAWDESCRIPTION|FULLDESC|NOTE|NOTES|COMMENT|COMMENTS|REMARK|REMARKS)$/, from: "desc" },
        { re: /^(CODE|FEATURE|FEATURECODE|FCODE|FIELDCODE|DESCKEY)$/, from: "code" },
        { re: /^(NORTHING|NORTH|N|Y)$/, from: "n" },
        { re: /^(EASTING|EAST|E|X)$/, from: "e" }
    ];
    const tagKey = tag => String(tag).toUpperCase().replace(/[\s_\-#.]/g, "");
    /** The shot field an attribute tag is filled from ("ptNum", "z", "desc", "code", "n", "e"), or null. */
    const attrSource = tag => { const r = ATTR_RULES.find(x => x.re.test(tagKey(tag))); return r ? r.from : null; };
    /**
     * Which of a symbol's attribute tags are filled from the shot and which keep the template's
     * default — so tags this tool doesn't recognise are visible, not silently left at the default.
     */
    function attribReport(attdefs) {
        const filled = [], kept = [];
        attdefs.filter(a => !(a.flags & 8)).forEach(a => (attrSource(a.tag) ? filled : kept).push(a.tag));
        return { filled, kept };
    }
    /** Attribute values for a symbol's tags from a shot { ptNum, n, e, z, desc, code }. */
    function attribValues(attdefs, shot) {
        const out = {};
        attdefs.forEach(a => {
            const from = attrSource(a.tag);
            let v = from ? shot[from] : undefined;
            if (typeof v === "number") v = from === "n" || from === "e" ? v.toFixed(3) : (from === "ptNum" ? String(v) : v.toFixed(2));
            out[a.tag] = v == null || v === "" ? a.value : String(v);
        });
        return out;
    }

    // ── Writing ───────────────────────────────────────────────────────────────

    const fmt = v => (Math.round(v * 1e6) / 1e6).toString();

    /**
     * Write a drawing into a template (as returned by readTemplate). drawing =
     *   { layers: [{ name, color }],                       // layers to add if the template lacks them
     *     polylines: [{ layer, closed, points: [{ e, n, z?, bulge? }], is3d }],
     *     inserts: [{ block, layer, e, n, z, attribs: { TAG: value } }],
     *     lines: [{ layer, a: { e, n }, b: { e, n } }],
 *     points: [{ layer, e, n, z }], texts: [{ layer, e, n, height, value }] }
     * Returns { text, added: { layers, entities }, warnings }.
     */
    function writeInto(tpl, drawing) {
        const L = tpl.lines.slice(), warnings = [];
        const P = pairsOf(L);
        const H = tpl.handles;
        let next = Math.max(tpl.maxHandle + 1, tpl.handseed ? parseInt(tpl.handseed, 16) : 0, 1);
        const handle = () => (next++).toString(16).toUpperCase();
        const out = [];
        const p = (code, value) => { out.push(String(code)); out.push(String(value)); };
        const ms = tpl.ids.modelSpace;
        const head = (type, layer, owner, sub) => {
            p(0, type);
            let h = null;
            if (H) { h = handle(); p(5, h); if (owner) p(330, owner); p(100, "AcDbEntity"); }
            p(8, layer);
            if (H && sub) p(100, sub);
            return h;
        };

        // New layers (only ones the template doesn't have)
        const have = new Set(tpl.layers.map(l => l.name.toUpperCase()));
        const newLayers = [];
        (drawing.layers || []).forEach(l => { if (!have.has(l.name.toUpperCase())) { have.add(l.name.toUpperCase()); newLayers.push(l); } });
        const layerRecs = [];
        newLayers.forEach(l => {
            const r = [];
            const q = (c, v) => { r.push(String(c)); r.push(String(v)); };
            q(0, "LAYER");
            if (H) { q(5, handle()); if (tpl.ids.layerTable) q(330, tpl.ids.layerTable); q(100, "AcDbSymbolTableRecord"); q(100, "AcDbLayerTableRecord"); }
            q(2, l.name); q(70, 0); q(62, l.color == null ? 7 : l.color); q(6, "CONTINUOUS");
            layerRecs.push(...r);
        });

        // Entities
        let count = 0;
        (drawing.polylines || []).forEach(pl => {
            if (!pl.points || pl.points.length < 2) return;
            const is3d = !!pl.is3d && pl.points.every(v => isFinite(v.z)) && !pl.points.some(v => v.bulge);
            const h = head("POLYLINE", pl.layer, ms, is3d ? "AcDb3dPolyline" : "AcDb2dPolyline");
            p(66, 1); p(10, 0); p(20, 0); p(30, is3d ? 0 : fmt(isFinite(pl.points[0].z) && pl.elevation !== false ? (pl.elevation || 0) : 0));
            p(70, (pl.closed ? 1 : 0) | (is3d ? 8 : 0));
            pl.points.forEach(v => {
                head("VERTEX", pl.layer, h, null);
                if (H) { p(100, "AcDbVertex"); p(100, is3d ? "AcDb3dPolylineVertex" : "AcDb2dVertex"); }
                p(10, fmt(v.e)); p(20, fmt(v.n)); p(30, is3d ? fmt(v.z) : 0);
                if (!is3d && v.bulge) p(42, fmt(v.bulge));
                p(70, is3d ? 32 : 0);
            });
            head("SEQEND", pl.layer, h, null);
            count++;
        });
        const blocks = new Map(tpl.blocks.map(b => [b.name.toUpperCase(), b]));
        (drawing.inserts || []).forEach(ins => {
            const b = blocks.get(String(ins.block).toUpperCase());
            if (!b) { warnings.push(`Symbol "${ins.block}" isn't in the template — skipped.`); return; }
            const tags = b.attdefs.filter(a => !(a.flags & 8));   // skip preset (constant-style) attributes
            const h = head("INSERT", ins.layer, ms, "AcDbBlockReference");
            if (tags.length) p(66, 1);
            p(2, b.name); p(10, fmt(ins.e)); p(20, fmt(ins.n)); p(30, fmt(ins.z || 0));
            const vals = ins.attribs || {};
            tags.forEach(a => {
                head("ATTRIB", ins.layer, h, "AcDbText");
                p(10, fmt(ins.e + a.x)); p(20, fmt(ins.n + a.y)); p(30, fmt((ins.z || 0) + a.z));
                p(40, fmt(a.height || 1)); p(1, vals[a.tag] == null ? a.value : vals[a.tag]);
                if (H) p(100, "AcDbAttribute");
                p(2, a.tag); p(70, a.flags & 1 ? 1 : 0);
            });
            if (tags.length) head("SEQEND", ins.layer, h, null);
            count++;
        });
        (drawing.lines || []).forEach(ln => {
            head("LINE", ln.layer, ms, "AcDbLine");
            p(10, fmt(ln.a.e)); p(20, fmt(ln.a.n)); p(30, fmt(ln.a.z || 0));
            p(11, fmt(ln.b.e)); p(21, fmt(ln.b.n)); p(31, fmt(ln.b.z || 0));
            count++;
        });
        (drawing.points || []).forEach(pt => {
            head("POINT", pt.layer, ms, "AcDbPoint");
            p(10, fmt(pt.e)); p(20, fmt(pt.n)); p(30, fmt(pt.z || 0));
            count++;
        });
        (drawing.texts || []).forEach(tx => {
            head("TEXT", tx.layer, ms, "AcDbText");
            p(10, fmt(tx.e)); p(20, fmt(tx.n)); p(30, 0); p(40, fmt(tx.height || 2)); p(1, tx.value);
            if (H) p(100, "AcDbText");
            count++;
        });

        // Splice: layers before the LAYER table's ENDTAB (and bump its count), entities before
        // ENTITIES' ENDSEC (or a new ENTITIES section before EOF), then $HANDSEED.
        let section = null, layerTableAt = -1, layerEndtab = -1, layerCount = -1, entEnd = -1, eofAt = -1, seedAt = -1;
        for (let i = 0; i < P.length; i++) {
            const q = P[i];
            if (q.code === 0 && q.value === "SECTION" && P[i + 1] && P[i + 1].code === 2) section = P[i + 1].value;
            if (q.code === 0 && q.value === "ENDSEC") { if (section === "ENTITIES") entEnd = q.at; section = null; }
            if (q.code === 0 && q.value === "EOF") eofAt = q.at;
            if (q.code === 9 && q.value === "$HANDSEED") seedAt = P[i + 1].at;
            if (section === "TABLES" && q.code === 0 && q.value === "TABLE" && P[i + 1] && P[i + 1].value === "LAYER") {
                layerTableAt = i;
                for (let j = i + 2; j < P.length && P[j].code !== 0; j++) if (P[j].code === 70) layerCount = P[j].at;
            }
            if (layerTableAt >= 0 && layerEndtab < 0 && q.code === 0 && q.value === "ENDTAB" && i > layerTableAt) layerEndtab = q.at;
        }
        if (newLayers.length && layerEndtab < 0) throw new Error("The template has no LAYER table to add layers to.");
        const edits = [];
        if (newLayers.length) {
            edits.push({ at: layerEndtab, insert: layerRecs });
            if (layerCount >= 0) L[layerCount + 1] = String((parseInt(L[layerCount + 1], 10) || 0) + newLayers.length);
        }
        if (entEnd >= 0) edits.push({ at: entEnd, insert: out });
        else if (eofAt >= 0) edits.push({ at: eofAt, insert: ["0", "SECTION", "2", "ENTITIES"].concat(out, ["0", "ENDSEC"]) });
        else throw new Error("The template has no ENTITIES section or EOF marker.");
        if (H && seedAt >= 0) L[seedAt + 1] = next.toString(16).toUpperCase();
        // stitched in pieces, not L.splice(at, 0, ...insert): spreading a big job's lines overflows the call stack
        const parts = []; let from = 0;
        edits.sort((a, b) => a.at - b.at).forEach(e => { parts.push(L.slice(from, e.at), e.insert); from = e.at; });
        parts.push(L.slice(from));
        return { text: parts.map(p => p.join("\r\n")).filter(p => p).join("\r\n") + "\r\n", added: { layers: newLayers.map(l => l.name), entities: count }, warnings };
    }

    /**
     * Check a written drawing: every entity's layer is in the LAYER table and every INSERT's block
     * is defined. Returns { ok, problems, entitiesByLayer, insertsByBlock, entityCounts }.
     */
    function verify(text) {
        const m = window.StdnEngine.parseDxf(text);
        const problems = [], byLayer = {}, byBlock = {};
        m.entities.forEach(e => {
            const layer = e.layer || "0";
            byLayer[layer] = (byLayer[layer] || 0) + 1;
            if (!m.layers[layer] && layer !== "0") problems.push(`An entity is on layer "${layer}", which isn't in the layer table.`);
            if (e.type === "INSERT") {
                byBlock[e.blockName] = (byBlock[e.blockName] || 0) + 1;
                if (!m.blocks[e.blockName]) problems.push(`Symbol "${e.blockName}" is inserted but not defined.`);
            }
        });
        return { ok: !problems.length, problems: [...new Set(problems)], entitiesByLayer: byLayer, insertsByBlock: byBlock, entityCounts: m.entityCounts };
    }

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, { init() {} });

    window.DxfTemplate = { readTemplate, rank, attribValues, attribReport, attrSource, writeInto, verify, ATTR_RULES };
})();
