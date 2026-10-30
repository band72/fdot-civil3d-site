/**
 * plugins/stdn-compare/stdn-engine.js
 *
 * The comparison + auto-correct engine for the "Standards Compare" tool, ported
 * to dependency-free browser JS from the `standardcompare-plugin` project
 * (an Express + React app). Everything that needed a server — the HTTP
 * router, multer upload handling, CORS, the in-memory rate limiter, the
 * filesystem-backed standards directory — is dropped: this build runs the
 * whole pipeline in the page.
 *
 * Ported modules (names kept 1:1 with the source for traceability):
 *   dxfLoader.parseDxf        — ASCII DXF → { header, layers, linetypes, styles, blocks, entities }
 *   standardsCheck            — parsed model vs. a JSON standard spec → severity-tagged violations
 *   geometryDiff              — tolerance-based entity diff vs. a reference drawing (spatial-grid indexed)
 *   standardFromDxf           — derive a standard from a master template's tables + merge a JSON standard on top
 *   regexSafety               — reject catastrophic-backtracking naming-pattern regexes before they run
 *   dxfDocument + dxfMender   — line-indexed raw-DXF editor + the safe auto-correct orchestration
 *   svgOverlay                — diff result → standalone SVG string
 *   reportBuilder             — combine the above into one report object
 *   compareOrchestrator       — the pure "which standard wins / validation order" decision logic
 *   reportRenderer            — report object → self-contained HTML doc or Markdown summary
 *
 * Exposed as window.StdnEngine.
 */
(function () {
    "use strict";

    /** Client-caused failures carry a statusCode so callers can distinguish them from bugs. */
    class CompareError extends Error {
        constructor(statusCode, message) {
            super(message);
            this.name = "CompareError";
            this.statusCode = statusCode;
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  dxfLoader — ASCII DXF parser
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Split raw DXF text into { code, value } group pairs.
     *
     * DEVIATION FROM SOURCE: the original stepped a fixed even/odd index
     * (`for (i = 0; i + 1 < lines.length; i += 2)`) and `continue`d on a
     * non-numeric code — which only skips 2 lines and leaves every later pair
     * out of phase after a single stray/blank line. This is the same fragility
     * the project's own FDOTDXFInspector carried until it was rebuilt around a
     * resilient scanner; the same fix is applied here: find the next line that
     * looks like a group code, then take the following line as its value.
     */
    function tokenize(text) {
        const raw = String(text == null ? "" : text).split(/\r\n|\r|\n/);
        const pairs = [];
        let i = 0;
        while (i < raw.length) {
            let code = null;
            while (i < raw.length) {
                const tok = raw[i].trim();
                i++;
                if (tok === "") continue;
                if (!/^[-+]?\d{1,4}$/.test(tok)) continue;   // resync on the next real code
                code = parseInt(tok, 10);
                break;
            }
            if (code === null || i >= raw.length) break;
            pairs.push({ code, value: raw[i].trim() });      // value may legitimately be ""
            i++;
        }
        return pairs;
    }

    function toNumber(v, fallback) {
        const n = parseFloat(v);
        return Number.isFinite(n) ? n : fallback;
    }

    /** Parse the ENTITIES section (also reused for BLOCK bodies). */
    function parseEntities(pairs, startIndex, endMarker) {
        const entities = [];
        let current = null;
        let i = startIndex;
        let polyVertexBuffer = null;

        const pushCurrent = () => {
            if (current) {
                if (polyVertexBuffer) { current.vertices = polyVertexBuffer; polyVertexBuffer = null; }
                entities.push(current);
            }
            current = null;
        };

        for (; i < pairs.length; i++) {
            const { code, value } = pairs[i];

            if (code === 0) {
                if (value === endMarker) { pushCurrent(); return { entities, nextIndex: i + 1 }; }
                if (value === "SEQEND") { pushCurrent(); continue; }
                if (value === "VERTEX") {
                    if (!polyVertexBuffer) polyVertexBuffer = [];
                    polyVertexBuffer.push({ x: 0, y: 0, z: 0 });
                    continue;
                }
                pushCurrent();
                current = { type: value, layer: "0", color: null, linetype: "BYLAYER", lineweight: null, handle: null };
                continue;
            }

            if (!current) continue;

            if (polyVertexBuffer && polyVertexBuffer.length > 0 && (code === 10 || code === 20 || code === 30)) {
                const v = polyVertexBuffer[polyVertexBuffer.length - 1];
                if (code === 10) v.x = toNumber(value, 0);
                if (code === 20) v.y = toNumber(value, 0);
                if (code === 30) v.z = toNumber(value, 0);
                continue;
            }

            switch (code) {
                case 8: current.layer = value; break;
                case 6: current.linetype = value; break;
                case 62: current.color = parseInt(value, 10); break;
                case 370: current.lineweight = parseInt(value, 10); break;
                case 5: current.handle = value; break;
                default: break;
            }

            switch (current.type) {
                case "LINE":
                    if (code === 10) current.x1 = toNumber(value, 0);
                    if (code === 20) current.y1 = toNumber(value, 0);
                    if (code === 30) current.z1 = toNumber(value, 0);
                    if (code === 11) current.x2 = toNumber(value, 0);
                    if (code === 21) current.y2 = toNumber(value, 0);
                    if (code === 31) current.z2 = toNumber(value, 0);
                    break;
                case "CIRCLE":
                    if (code === 10) current.cx = toNumber(value, 0);
                    if (code === 20) current.cy = toNumber(value, 0);
                    if (code === 30) current.cz = toNumber(value, 0);
                    if (code === 40) current.radius = toNumber(value, 0);
                    break;
                case "ARC":
                    if (code === 10) current.cx = toNumber(value, 0);
                    if (code === 20) current.cy = toNumber(value, 0);
                    if (code === 30) current.cz = toNumber(value, 0);
                    if (code === 40) current.radius = toNumber(value, 0);
                    if (code === 50) current.startAngle = toNumber(value, 0);
                    if (code === 51) current.endAngle = toNumber(value, 0);
                    break;
                case "LWPOLYLINE":
                    if (code === 90) current.vertexCount = parseInt(value, 10);
                    if (code === 70) current.closed = (parseInt(value, 10) & 1) === 1;
                    if (code === 10 || code === 20) {
                        if (!current.points) current.points = [];
                        if (code === 10) current.points.push({ x: toNumber(value, 0), y: 0 });
                        else if (current.points.length > 0) current.points[current.points.length - 1].y = toNumber(value, 0);
                    }
                    break;
                case "POLYLINE":
                    if (code === 70) current.closed = (parseInt(value, 10) & 1) === 1;
                    break;
                case "TEXT":
                case "MTEXT":
                    if (code === 10) current.x = toNumber(value, 0);
                    if (code === 20) current.y = toNumber(value, 0);
                    if (code === 30) current.z = toNumber(value, 0);
                    if (code === 40) current.height = toNumber(value, 0);
                    if (code === 50) current.rotation = toNumber(value, 0);
                    if (code === 7) current.style = value;
                    if (code === 1) current.text = (current.text || "") + value;
                    if (code === 3 && current.type === "MTEXT") current.text = (current.text || "") + value;
                    break;
                case "INSERT":
                    if (code === 2) current.blockName = value;
                    if (code === 10) current.x = toNumber(value, 0);
                    if (code === 20) current.y = toNumber(value, 0);
                    if (code === 30) current.z = toNumber(value, 0);
                    if (code === 41) current.xscale = toNumber(value, 1);
                    if (code === 42) current.yscale = toNumber(value, 1);
                    if (code === 50) current.rotation = toNumber(value, 0);
                    break;
                default: break;
            }
        }

        pushCurrent();
        return { entities, nextIndex: i };
    }

    /** Parse the TABLES section: LAYER, LTYPE, STYLE table entries. */
    function parseTables(pairs, startIndex) {
        const tables = { layers: {}, linetypes: {}, styles: {} };
        let i = startIndex;
        let currentTableName = null;
        let currentEntry = null;

        const commitEntry = () => {
            if (!currentEntry || !currentTableName) return;
            const name = currentEntry.name;
            if (!name) return;
            if (currentTableName === "LAYER") tables.layers[name] = currentEntry;
            else if (currentTableName === "LTYPE") tables.linetypes[name] = currentEntry;
            else if (currentTableName === "STYLE") tables.styles[name] = currentEntry;
            currentEntry = null;
        };

        for (; i < pairs.length; i++) {
            const { code, value } = pairs[i];
            if (code === 0 && value === "ENDSEC") { commitEntry(); return { tables, nextIndex: i + 1 }; }
            if (code === 0 && value === "TABLE") { currentTableName = null; continue; }
            if (code === 2 && currentTableName === null && !currentEntry) { currentTableName = value; continue; }
            if (code === 0 && ["LAYER", "LTYPE", "STYLE"].includes(value)) {
                commitEntry();
                currentEntry = { color: null, linetype: "CONTINUOUS", flags: 0, lineweight: null };
                continue;
            }
            if (code === 0 && value === "ENDTAB") { commitEntry(); currentTableName = null; continue; }
            if (!currentEntry) continue;

            switch (code) {
                case 2: currentEntry.name = value; break;
                case 62: currentEntry.color = parseInt(value, 10); break;
                case 6: currentEntry.linetype = value; break;
                case 70: currentEntry.flags = parseInt(value, 10); break;
                case 370: currentEntry.lineweight = parseInt(value, 10); break;
                case 40: currentEntry.fixedHeight = toNumber(value, 0); break;
                case 3: currentEntry.font = value; break;
                case 41: currentEntry.widthFactor = toNumber(value, 1); break;
                default: break;
            }
        }
        commitEntry();
        return { tables, nextIndex: i };
    }

    /** Parse the HEADER section into a flat { varName: { code: value } } map. */
    function parseHeader(pairs, startIndex) {
        const header = {};
        let i = startIndex;
        let currentVar = null;
        for (; i < pairs.length; i++) {
            const { code, value } = pairs[i];
            if (code === 0 && value === "ENDSEC") return { header, nextIndex: i + 1 };
            if (code === 9) { currentVar = value; header[currentVar] = {}; continue; }
            if (currentVar) header[currentVar][code] = value;
        }
        return { header, nextIndex: i };
    }

    /** Parse BLOCKS section into { blockName: { entities, base } }. */
    function parseBlocks(pairs, startIndex) {
        const blocks = {};
        let i = startIndex;
        while (i < pairs.length) {
            const { code, value } = pairs[i];
            if (code === 0 && value === "ENDSEC") return { blocks, nextIndex: i + 1 };
            if (code === 0 && value === "BLOCK") {
                let name = null;
                const base = { x: 0, y: 0, z: 0 };
                let j = i + 1;
                for (; j < pairs.length; j++) {
                    const p = pairs[j];
                    if (p.code === 0) break;
                    if (p.code === 2 && !name) name = p.value;
                    if (p.code === 10) base.x = toNumber(p.value, 0);
                    if (p.code === 20) base.y = toNumber(p.value, 0);
                    if (p.code === 30) base.z = toNumber(p.value, 0);
                }
                const result = parseEntities(pairs, j, "ENDBLK");
                if (name) blocks[name] = { base, entities: result.entities };
                i = result.nextIndex;
                continue;
            }
            i++;
        }
        return { blocks, nextIndex: i };
    }

    const INSUNITS_MAP = {
        "0": "unitless", "1": "inches", "2": "feet",
        "4": "millimeters", "5": "centimeters", "6": "meters",
    };
    function mapInsUnits(code) {
        if (code === undefined) return "unspecified";
        return INSUNITS_MAP[code] || `code:${code}`;
    }

    /** Parse a full DXF file's text into the structured model. */
    function parseDxf(text) {
        if (typeof text !== "string" || text.length === 0) {
            throw new Error("parseDxf: empty or non-string input");
        }
        const pairs = tokenize(text);
        const model = { header: {}, layers: {}, linetypes: {}, styles: {}, blocks: {}, entities: [] };

        let i = 0;
        while (i < pairs.length) {
            const { code, value } = pairs[i];
            if (code === 0 && value === "SECTION") {
                const nameCode = pairs[i + 1];
                const sectionName = nameCode && nameCode.code === 2 ? nameCode.value : null;
                const bodyStart = i + 2;

                if (sectionName === "HEADER") { const r = parseHeader(pairs, bodyStart); model.header = r.header; i = r.nextIndex; continue; }
                if (sectionName === "TABLES") {
                    const r = parseTables(pairs, bodyStart);
                    Object.assign(model.layers, r.tables.layers);
                    Object.assign(model.linetypes, r.tables.linetypes);
                    Object.assign(model.styles, r.tables.styles);
                    i = r.nextIndex; continue;
                }
                if (sectionName === "BLOCKS") { const r = parseBlocks(pairs, bodyStart); Object.assign(model.blocks, r.blocks); i = r.nextIndex; continue; }
                if (sectionName === "ENTITIES") { const r = parseEntities(pairs, bodyStart, "ENDSEC"); model.entities = model.entities.concat(r.entities); i = r.nextIndex; continue; }

                let j = bodyStart;
                while (j < pairs.length && !(pairs[j].code === 0 && pairs[j].value === "ENDSEC")) j++;
                i = j + 1;
                continue;
            }
            i++;
        }

        const entityCounts = {};
        for (const e of model.entities) entityCounts[e.type] = (entityCounts[e.type] || 0) + 1;
        model.entityCounts = entityCounts;

        const insUnits = model.header && model.header.$INSUNITS ? model.header.$INSUNITS[70] : undefined;
        model.units = mapInsUnits(insUnits);
        return model;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  standardsCheck — parsed model vs. a JSON standard spec
    // ═════════════════════════════════════════════════════════════════════════

    const SEVERITY = { ERROR: "error", WARNING: "warning", INFO: "info" };

    function makeViolation(severity, code, message, context) {
        return { severity, code, message, ...context };
    }

    function testPattern(pattern, value) {
        if (!pattern) return true;
        try { return new RegExp(pattern).test(value); } catch (e) { return true; }
    }

    function checkStandards(model, standard) {
        const violations = [];
        standard = standard || {};

        // 1. Units
        if (standard.units && model.units && standard.units !== model.units) {
            violations.push(makeViolation(SEVERITY.ERROR, "UNITS_MISMATCH",
                `Drawing units are "${model.units}" but the standard requires "${standard.units}".`, {}));
        }

        // 2. Required layers must exist
        const drawingLayerNames = new Set(Object.keys(model.layers || {}));
        for (const e of model.entities || []) if (e.layer) drawingLayerNames.add(e.layer);

        const requiredLayers = (standard.layers || []).filter(l => l.required);
        for (const reqLayer of requiredLayers) {
            if (!drawingLayerNames.has(reqLayer.name)) {
                violations.push(makeViolation(SEVERITY.ERROR, "MISSING_REQUIRED_LAYER",
                    `Required layer "${reqLayer.name}" is missing from the drawing.`, { layer: reqLayer.name }));
            }
        }

        // 3. Prohibited layers must not exist
        for (const prohibited of standard.prohibitedLayers || []) {
            if (drawingLayerNames.has(prohibited)) {
                violations.push(makeViolation(SEVERITY.ERROR, "PROHIBITED_LAYER_PRESENT",
                    `Prohibited layer "${prohibited}" is present in the drawing.`, { layer: prohibited }));
            }
        }

        // 4. Per-layer rules (color / linetype / lineweight / naming)
        const layerRuleByName = {};
        for (const rule of standard.layers || []) layerRuleByName[rule.name] = rule;

        for (const layerName of drawingLayerNames) {
            const rule = layerRuleByName[layerName];
            const tableEntry = (model.layers || {})[layerName];

            if (!rule && standard.namingConvention &&
                (standard.namingConvention.appliesTo || []).includes("layers")) {
                if (!testPattern(standard.namingConvention.pattern, layerName)) {
                    violations.push(makeViolation(SEVERITY.WARNING, "LAYER_NAME_CONVENTION",
                        `Layer "${layerName}" does not match the required naming pattern (${standard.namingConvention.pattern}).`,
                        { layer: layerName }));
                }
            }

            if (!rule) continue;

            if (rule.namingPattern && !testPattern(rule.namingPattern, layerName)) {
                violations.push(makeViolation(SEVERITY.WARNING, "LAYER_NAME_CONVENTION",
                    `Layer "${layerName}" does not match its required naming pattern (${rule.namingPattern}).`,
                    { layer: layerName }));
            }

            if (tableEntry) {
                if (rule.color !== undefined && tableEntry.color !== rule.color) {
                    violations.push(makeViolation(SEVERITY.ERROR, "LAYER_COLOR_MISMATCH",
                        `Layer "${layerName}" has color ${tableEntry.color} but the standard requires color ${rule.color}.`,
                        { layer: layerName }));
                }
                if (rule.colorRange && Array.isArray(rule.colorRange)) {
                    const [lo, hi] = rule.colorRange;
                    if (typeof tableEntry.color === "number" && (tableEntry.color < lo || tableEntry.color > hi)) {
                        violations.push(makeViolation(SEVERITY.WARNING, "LAYER_COLOR_OUT_OF_RANGE",
                            `Layer "${layerName}" has color ${tableEntry.color}, outside the allowed range [${lo}-${hi}].`,
                            { layer: layerName }));
                    }
                }
                if (rule.linetype && tableEntry.linetype && tableEntry.linetype !== rule.linetype) {
                    violations.push(makeViolation(SEVERITY.ERROR, "LAYER_LINETYPE_MISMATCH",
                        `Layer "${layerName}" uses linetype "${tableEntry.linetype}" but the standard requires "${rule.linetype}".`,
                        { layer: layerName }));
                }
                // `lineweightMax` is a ceiling; `lineweight` (checked in 4b) is an
                // exact value. If a rule sets both, the exact value wins and the
                // ceiling check is skipped so one bad lineweight isn't reported twice.
                if (rule.lineweightMax !== undefined && rule.lineweight === undefined &&
                    typeof tableEntry.lineweight === "number" && tableEntry.lineweight > rule.lineweightMax) {
                    violations.push(makeViolation(SEVERITY.WARNING, "LAYER_LINEWEIGHT_EXCEEDS_MAX",
                        `Layer "${layerName}" has lineweight ${tableEntry.lineweight}, exceeding the max of ${rule.lineweightMax}.`,
                        { layer: layerName }));
                }
            } else {
                violations.push(makeViolation(SEVERITY.INFO, "LAYER_USED_WITHOUT_TABLE_ENTRY",
                    `Layer "${layerName}" is used by entities but has no formal LAYER table entry.`, { layer: layerName }));
            }
        }

        // 4b. Exact lineweight rule
        for (const layerName of drawingLayerNames) {
            const rule = layerRuleByName[layerName];
            const tableEntry = (model.layers || {})[layerName];
            if (!rule || !tableEntry) continue;
            if (rule.lineweight !== undefined && tableEntry.lineweight !== rule.lineweight) {
                violations.push(makeViolation(SEVERITY.ERROR, "LAYER_LINEWEIGHT_MISMATCH",
                    `Layer "${layerName}" has lineweight ${tableEntry.lineweight} but the standard requires ${rule.lineweight}.`,
                    { layer: layerName }));
            }
        }

        // 4c. Required linetypes must be defined
        const drawingLinetypeNames = new Set(Object.keys(model.linetypes || {}));
        for (const ltName of standard.requiredLinetypes || []) {
            if (!drawingLinetypeNames.has(ltName)) {
                violations.push(makeViolation(SEVERITY.ERROR, "MISSING_REQUIRED_LINETYPE",
                    `Required linetype "${ltName}" is not defined in the drawing's LTYPE table.`, { linetype: ltName }));
            }
        }

        // 4d. References to linetypes that aren't defined at all
        const ALWAYS_AVAILABLE_LINETYPES = new Set(["BYLAYER", "BYBLOCK", "CONTINUOUS"]);
        const referencedLinetypes = new Set();
        for (const entry of Object.values(model.layers || {})) if (entry.linetype) referencedLinetypes.add(entry.linetype);
        for (const e of model.entities || []) if (e.linetype) referencedLinetypes.add(e.linetype);
        for (const ltName of referencedLinetypes) {
            if (ALWAYS_AVAILABLE_LINETYPES.has(ltName)) continue;
            if (!drawingLinetypeNames.has(ltName)) {
                violations.push(makeViolation(SEVERITY.ERROR, "UNDEFINED_LINETYPE_REFERENCE",
                    `Linetype "${ltName}" is referenced but has no LTYPE table entry — the drawing may not display or open correctly.`,
                    { linetype: ltName }));
            }
        }

        // 4e. Required blocks must be defined
        const drawingBlockNames = new Set(Object.keys(model.blocks || {}));
        for (const blockName of standard.requiredBlocks || []) {
            if (!drawingBlockNames.has(blockName)) {
                violations.push(makeViolation(SEVERITY.ERROR, "MISSING_REQUIRED_BLOCK",
                    `Required block "${blockName}" is not defined in the drawing.`, { block: blockName }));
            }
        }

        // 5. Text styles
        const allowedTextStyles = new Set((standard.textStyles || []).filter(s => s.allowed !== false).map(s => s.name));
        const usedStyles = new Set();
        for (const e of model.entities || []) {
            if ((e.type === "TEXT" || e.type === "MTEXT") && e.style) usedStyles.add(e.style);
        }
        if (standard.textStyles && standard.textStyles.length > 0) {
            for (const styleName of usedStyles) {
                if (!allowedTextStyles.has(styleName)) {
                    violations.push(makeViolation(SEVERITY.WARNING, "DISALLOWED_TEXT_STYLE",
                        `Text style "${styleName}" is used but is not in the standard's allowed list.`, { style: styleName }));
                }
            }
        }

        const drawingStyleNames = new Set(Object.keys(model.styles || {}));
        for (const styleName of standard.requiredTextStyles || []) {
            if (!drawingStyleNames.has(styleName)) {
                violations.push(makeViolation(SEVERITY.ERROR, "MISSING_REQUIRED_STYLE",
                    `Required text style "${styleName}" is not defined in the drawing's STYLE table.`, { style: styleName }));
            }
        }

        // 6. Color policy (ByLayer enforcement). ByBlock (color 0) is a
        // distinct, legitimate coloring mode and is deliberately NOT flagged.
        const BYLAYER = 256;
        const BYBLOCK = 0;
        if (standard.colorPolicy === "byLayer") {
            for (const e of model.entities || []) {
                if (e.color !== null && e.color !== undefined && e.color !== BYLAYER && e.color !== BYBLOCK) {
                    violations.push(makeViolation(SEVERITY.WARNING, "ENTITY_COLOR_NOT_BYLAYER",
                        `A ${e.type} entity on layer "${e.layer}" has an explicit color override (${e.color}) instead of ByLayer.`,
                        { layer: e.layer, entityType: e.type, handle: e.handle }));
                }
            }
        }

        // 7. Block naming convention
        if (standard.namingConvention && (standard.namingConvention.appliesTo || []).includes("blocks")) {
            for (const blockName of Object.keys(model.blocks || {})) {
                if (!testPattern(standard.namingConvention.pattern, blockName)) {
                    violations.push(makeViolation(SEVERITY.WARNING, "BLOCK_NAME_CONVENTION",
                        `Block "${blockName}" does not match the required naming pattern (${standard.namingConvention.pattern}).`,
                        { block: blockName }));
                }
            }
        }

        const summary = {
            total: violations.length,
            errors: violations.filter(v => v.severity === SEVERITY.ERROR).length,
            warnings: violations.filter(v => v.severity === SEVERITY.WARNING).length,
            info: violations.filter(v => v.severity === SEVERITY.INFO).length,
            passed: violations.filter(v => v.severity === SEVERITY.ERROR).length === 0,
        };
        return { violations, summary };
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  geometryDiff — tolerance-based entity diff vs. a reference drawing
    // ═════════════════════════════════════════════════════════════════════════

    const DEFAULT_TOLERANCES = {
        position: 0.01, radius: 0.01, angle: 0.5, textHeight: 0.05,
        matchRadius: 25,   // coarse matched-vs-unmatched radius (>> `position`)
    };

    function dist2d(x1, y1, x2, y2) {
        const dx = x2 - x1, dy = y2 - y1;
        return Math.sqrt(dx * dx + dy * dy);
    }

    function anchorPoint(e) {
        switch (e.type) {
            case "LINE": return { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 };
            case "CIRCLE":
            case "ARC": return { x: e.cx, y: e.cy };
            case "TEXT":
            case "MTEXT":
            case "INSERT": return { x: e.x, y: e.y };
            case "LWPOLYLINE":
            case "POLYLINE": {
                const pts = e.points || e.vertices || [];
                if (pts.length > 0) {
                    const sx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
                    const sy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
                    return { x: sx, y: sy };
                }
                return { x: 0, y: 0 };
            }
            default: return { x: 0, y: 0 };
        }
    }

    function diffEntityFields(a, b, tol) {
        const diffs = [];
        const t = { ...DEFAULT_TOLERANCES, ...tol };
        const checkNum = (field, va, vb, tolerance, label) => {
            if (typeof va !== "number" || typeof vb !== "number") return;
            if (Math.abs(va - vb) > tolerance) diffs.push({ field, label: label || field, from: va, to: vb, delta: vb - va });
        };

        if (a.layer !== b.layer) diffs.push({ field: "layer", label: "Layer", from: a.layer, to: b.layer });

        switch (a.type) {
            case "LINE":
                checkNum("x1", a.x1, b.x1, t.position, "Start X");
                checkNum("y1", a.y1, b.y1, t.position, "Start Y");
                checkNum("x2", a.x2, b.x2, t.position, "End X");
                checkNum("y2", a.y2, b.y2, t.position, "End Y");
                break;
            case "CIRCLE":
                checkNum("cx", a.cx, b.cx, t.position, "Center X");
                checkNum("cy", a.cy, b.cy, t.position, "Center Y");
                checkNum("radius", a.radius, b.radius, t.radius, "Radius");
                break;
            case "ARC":
                checkNum("cx", a.cx, b.cx, t.position, "Center X");
                checkNum("cy", a.cy, b.cy, t.position, "Center Y");
                checkNum("radius", a.radius, b.radius, t.radius, "Radius");
                checkNum("startAngle", a.startAngle, b.startAngle, t.angle, "Start Angle");
                checkNum("endAngle", a.endAngle, b.endAngle, t.angle, "End Angle");
                break;
            case "TEXT":
            case "MTEXT":
                checkNum("x", a.x, b.x, t.position, "X");
                checkNum("y", a.y, b.y, t.position, "Y");
                checkNum("height", a.height, b.height, t.textHeight, "Text Height");
                if ((a.text || "") !== (b.text || "")) diffs.push({ field: "text", label: "Text", from: a.text, to: b.text });
                break;
            case "LWPOLYLINE":
            case "POLYLINE": {
                const pa = a.points || a.vertices || [];
                const pb = b.points || b.vertices || [];
                const na = pa.length, nb = pb.length;
                if (na !== nb) {
                    diffs.push({ field: "vertexCount", label: "Vertex Count", from: na, to: nb });
                } else {
                    for (let i = 0; i < na; i++) {
                        checkNum(`points[${i}].x`, pa[i].x, pb[i].x, t.position, `Vertex ${i + 1} X`);
                        checkNum(`points[${i}].y`, pa[i].y, pb[i].y, t.position, `Vertex ${i + 1} Y`);
                    }
                }
                if (!!a.closed !== !!b.closed) diffs.push({ field: "closed", label: "Closed", from: !!a.closed, to: !!b.closed });
                break;
            }
            case "INSERT":
                checkNum("x", a.x, b.x, t.position, "X");
                checkNum("y", a.y, b.y, t.position, "Y");
                checkNum("rotation", a.rotation, b.rotation, t.angle, "Rotation");
                if (a.blockName !== b.blockName) diffs.push({ field: "blockName", label: "Block", from: a.blockName, to: b.blockName });
                break;
            default: break;
        }
        return diffs;
    }

    /**
     * Tolerance diff between a reference model and a target model. Entities are
     * bucketed by layer+type, then matched by anchor-point distance — candidate
     * pairs are found via a uniform spatial grid (cell = matchRadius), not a
     * full refList×tgtList cross product, so a layer with tens of thousands of
     * entities doesn't blow up allocation/sort time.
     */
    function diffGeometry(referenceModel, targetModel, tolerances) {
        const tol = { ...DEFAULT_TOLERANCES, ...(tolerances || {}) };
        const bucketKey = (e) => `${e.layer}::${e.type}`;
        const bucketize = (model) => {
            const buckets = {};
            for (const e of model.entities || []) {
                const key = bucketKey(e);
                (buckets[key] || (buckets[key] = [])).push(e);
            }
            return buckets;
        };

        const refBuckets = bucketize(referenceModel);
        const tgtBuckets = bucketize(targetModel);
        const added = [], removed = [], modified = [], unchanged = [];
        const allKeys = new Set([...Object.keys(refBuckets), ...Object.keys(tgtBuckets)]);

        for (const key of allKeys) {
            const refList = (refBuckets[key] || []).slice();
            const tgtList = (tgtBuckets[key] || []).slice();
            const refUsed = new Array(refList.length).fill(false);
            const tgtUsed = new Array(tgtList.length).fill(false);

            const MATCH_RADIUS = tol.matchRadius;
            const cellSize = Math.max(MATCH_RADIUS, 1e-6);
            const cellKey = (x, y) => `${Math.floor(x / cellSize)}:${Math.floor(y / cellSize)}`;

            const refAnchors = refList.map(anchorPoint);
            const tgtAnchors = tgtList.map(anchorPoint);

            const refGrid = new Map();
            for (let i = 0; i < refAnchors.length; i++) {
                const gKey = cellKey(refAnchors[i].x, refAnchors[i].y);
                if (!refGrid.has(gKey)) refGrid.set(gKey, []);
                refGrid.get(gKey).push(i);
            }

            const candidates = [];
            for (let j = 0; j < tgtAnchors.length; j++) {
                const ta = tgtAnchors[j];
                const cx = Math.floor(ta.x / cellSize);
                const cy = Math.floor(ta.y / cellSize);
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        const refIndices = refGrid.get(`${cx + dx}:${cy + dy}`);
                        if (!refIndices) continue;
                        for (const i of refIndices) {
                            const ra = refAnchors[i];
                            candidates.push({ i, j, d: dist2d(ra.x, ra.y, ta.x, ta.y) });
                        }
                    }
                }
            }
            // Distance first; then a stable tie-break on (ref index, target index)
            // so equal-distance candidates match the same way on every run / engine.
            candidates.sort((a, b) => a.d - b.d || a.i - b.i || a.j - b.j);

            for (const c of candidates) {
                if (refUsed[c.i] || tgtUsed[c.j]) continue;
                if (c.d > MATCH_RADIUS) continue;
                refUsed[c.i] = true;
                tgtUsed[c.j] = true;

                const a = refList[c.i];
                const b = tgtList[c.j];
                const fieldDiffs = diffEntityFields(a, b, tol);
                if (fieldDiffs.length === 0) {
                    unchanged.push({ layer: a.layer, type: a.type, handleRef: a.handle, handleTarget: b.handle });
                } else {
                    modified.push({ layer: a.layer, type: a.type, handleRef: a.handle, handleTarget: b.handle, changes: fieldDiffs, reference: a, target: b });
                }
            }

            for (let i = 0; i < refList.length; i++) if (!refUsed[i]) removed.push(refList[i]);
            for (let j = 0; j < tgtList.length; j++) if (!tgtUsed[j]) added.push(tgtList[j]);
        }

        const summary = {
            referenceEntityCount: (referenceModel.entities || []).length,
            targetEntityCount: (targetModel.entities || []).length,
            added: added.length, removed: removed.length, modified: modified.length, unchanged: unchanged.length,
            identical: added.length === 0 && removed.length === 0 && modified.length === 0,
        };
        return { added, removed, modified, unchanged, summary, tolerances: tol };
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  standardFromDxf — a master template's tables ARE the standard
    // ═════════════════════════════════════════════════════════════════════════

    function standardFromMasterDxf(masterModel, options) {
        const opts = { colorPolicy: "byLayer", requireAllMasterLayers: true, ...(options || {}) };
        const layers = Object.entries(masterModel.layers || {}).map(([name, entry]) => ({
            name,
            color: typeof entry.color === "number" ? entry.color : undefined,
            linetype: entry.linetype || undefined,
            lineweight: typeof entry.lineweight === "number" ? entry.lineweight : undefined,
            required: opts.requireAllMasterLayers,
        }));
        const requiredLinetypes = Object.keys(masterModel.linetypes || {});
        const requiredTextStyles = Object.keys(masterModel.styles || {});
        const requiredBlocks = Object.keys(masterModel.blocks || {});
        const textStyles = requiredTextStyles.map((name) => ({ name, allowed: true }));

        return {
            name: masterModel.header && masterModel.header.$PROJECTNAME ? masterModel.header.$PROJECTNAME[1] : "Master Template Standard",
            source: "master-dxf",
            units: masterModel.units && masterModel.units !== "unspecified" ? masterModel.units : undefined,
            layers, requiredLinetypes, requiredTextStyles, requiredBlocks, textStyles,
            colorPolicy: opts.colorPolicy || undefined,
        };
    }

    function mergeStandards(masterDerived, jsonStandard) {
        if (!jsonStandard) return masterDerived;
        const merged = { ...masterDerived, ...jsonStandard };
        if (merged.units == null) merged.units = masterDerived.units;
        if (merged.colorPolicy == null) merged.colorPolicy = masterDerived.colorPolicy;

        const byName = (arr) => {
            const map = {};
            for (const item of arr || []) map[item.name] = item;
            return map;
        };
        // Union the layer lists, but on a name collision MERGE fields rather than
        // replacing wholesale — so a JSON standard that adds a `namingPattern` or
        // `lineweightMax` to a layer doesn't silently drop the master-derived
        // `required` / `color` / `linetype` for that same layer.
        const mLayers = byName(masterDerived.layers);
        const jLayers = byName(jsonStandard.layers);
        const mergedLayers = { ...mLayers };
        for (const name of Object.keys(jLayers)) {
            mergedLayers[name] = { ...(mLayers[name] || {}), ...jLayers[name] };
        }
        merged.layers = Object.values(mergedLayers);
        merged.requiredLinetypes = Array.from(new Set([...(masterDerived.requiredLinetypes || []), ...(jsonStandard.requiredLinetypes || [])]));
        merged.requiredTextStyles = Array.from(new Set([...(masterDerived.requiredTextStyles || []), ...(jsonStandard.requiredTextStyles || [])]));
        merged.requiredBlocks = Array.from(new Set([...(masterDerived.requiredBlocks || []), ...(jsonStandard.requiredBlocks || [])]));
        merged.textStyles = Object.values({ ...byName(masterDerived.textStyles), ...byName(jsonStandard.textStyles) });
        return merged;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  regexSafety — reject catastrophic-backtracking naming patterns
    // ═════════════════════════════════════════════════════════════════════════

    const MAX_PATTERN_LENGTH = 200;
    const NESTED_QUANTIFIER = /\((?:\?:)?[^()]*[+*]\)[+*]/;
    const REPEATED_QUANTIFIED_GROUP = /\)[+*]\s*\)[+*]/;

    function checkPatternSafety(pattern) {
        if (typeof pattern !== "string" || pattern.length === 0) return { safe: true };
        if (pattern.length > MAX_PATTERN_LENGTH) return { safe: false, reason: `Pattern exceeds the ${MAX_PATTERN_LENGTH}-character limit.` };
        if (NESTED_QUANTIFIER.test(pattern)) return { safe: false, reason: 'Pattern contains a nested quantifier (e.g. "(x+)+"), a classic catastrophic-backtracking shape.' };
        if (REPEATED_QUANTIFIED_GROUP.test(pattern)) return { safe: false, reason: "Pattern contains adjacent quantified groups, which can cause catastrophic backtracking." };
        try { new RegExp(pattern); } catch (e) { return { safe: false, reason: `Not a valid regular expression: ${e.message}` }; }
        return { safe: true };
    }

    function assertStandardPatternsAreSafe(standard) {
        if (!standard) return;
        if (standard.namingConvention && standard.namingConvention.pattern) {
            const result = checkPatternSafety(standard.namingConvention.pattern);
            if (!result.safe) throw new Error(`Unsafe standard: namingConvention.pattern — ${result.reason}`);
        }
        for (const layer of standard.layers || []) {
            if (layer.namingPattern) {
                const result = checkPatternSafety(layer.namingPattern);
                if (!result.safe) throw new Error(`Unsafe standard: layers["${layer.name}"].namingPattern — ${result.reason}`);
            }
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  dxfDocument — line-indexed raw-DXF editor (the auto-correct write path)
    // ═════════════════════════════════════════════════════════════════════════

    function splitLines(text) { return text.split(/\r\n|\r|\n/); }

    /**
     * Drop stray blank lines so the line-indexed editor's `+= 2` walk stays in
     * phase. A blank line where a group *code* is expected is stray formatting
     * (hand-edited / concatenated DXF) and is removed; a blank where a *value*
     * is expected is a legitimate empty value (an empty TEXT string, etc.) and
     * is kept. DXF blank lines carry no meaning, so the result is byte-identical
     * for a clean export and semantically identical for a messy one.
     * @returns {string[]} the compacted, strictly-alternating line array
     */
    function normalizeDxfLines(rawLines) {
        const out = [];
        let expectCode = true;
        for (const ln of rawLines) {
            if (expectCode && ln.trim() === "") continue;   // stray blank before a code
            out.push(ln);
            expectCode = !expectCode;
        }
        return out;
    }

    /**
     * After blank-line normalisation, every even index must be a group-code
     * line. If it isn't, the file is genuinely malformed (not just messy) and a
     * "surgical" edit would corrupt it — so fail loudly instead. (The read-only
     * Check path uses the resilient `parseDxf` tokenizer and tolerates more.)
     */
    function assertStrictDxf(lines) {
        const n = (lines.length > 0 && lines[lines.length - 1].trim() === "") ? lines.length - 1 : lines.length;
        for (let i = 0; i < n; i += 2) {
            const codeTok = lines[i] === undefined ? "" : lines[i].trim();
            if (!/^-?\d{1,4}$/.test(codeTok)) {
                throw new CompareError(400,
                    `Auto-correct needs a well-formed ASCII DXF — alternating group-code / value lines. ` +
                    `Line ${i + 1} reads "${codeTok.slice(0, 40)}", which is not a group code. Re-export the drawing from your CAD application and try again.`);
            }
        }
    }

    function indexDocument(lines) {
        const index = { tables: {}, blocksSection: null };
        let i = 0;
        const codeAt = (n) => (lines[n] !== undefined ? lines[n].trim() : undefined);
        const valAt = (n) => (lines[n + 1] !== undefined ? lines[n + 1].trim() : undefined);

        while (i < lines.length) {
            if (codeAt(i) === "0" && valAt(i) === "SECTION") {
                const sectionName = codeAt(i + 2) === "2" ? valAt(i + 2) : null;

                if (sectionName === "TABLES") {
                    let j = i + 4;
                    let currentTableName = null;
                    let tableHeaderLine = null;
                    let entryStart = null;
                    let entryName = null;
                    const TRACKED = new Set(["LAYER", "LTYPE", "STYLE"]);

                    while (j < lines.length) {
                        const c = codeAt(j);
                        const v = valAt(j);
                        if (c === "0" && v === "ENDSEC") { i = j + 2; break; }
                        if (c === "0" && v === "TABLE") { currentTableName = null; tableHeaderLine = j; j += 2; continue; }
                        if (c === "2" && tableHeaderLine !== null && currentTableName === null) {
                            currentTableName = v;
                            if (TRACKED.has(currentTableName)) index.tables[currentTableName] = { tableHeaderLine, endtabLine: null, entries: {} };
                            j += 2; continue;
                        }
                        if (c === "0" && TRACKED.has(v) && currentTableName && TRACKED.has(currentTableName)) {
                            if (entryStart !== null && entryName) index.tables[currentTableName].entries[entryName] = { start: entryStart, end: j };
                            entryStart = j; entryName = null; j += 2; continue;
                        }
                        if (c === "2" && entryStart !== null && !entryName && currentTableName && TRACKED.has(currentTableName)) {
                            entryName = v; j += 2; continue;
                        }
                        if (c === "0" && v === "ENDTAB") {
                            if (entryStart !== null && entryName && currentTableName && TRACKED.has(currentTableName)) index.tables[currentTableName].entries[entryName] = { start: entryStart, end: j };
                            if (currentTableName && TRACKED.has(currentTableName)) index.tables[currentTableName].endtabLine = j;
                            entryStart = null; entryName = null; currentTableName = null; j += 2; continue;
                        }
                        j += 2;
                    }
                    continue;
                }

                if (sectionName === "BLOCKS") {
                    const blocksSection = { start: i, endsecLine: null, blocks: {} };
                    let j = i + 4;
                    while (j < lines.length) {
                        const c = codeAt(j);
                        const v = valAt(j);
                        if (c === "0" && v === "ENDSEC") { blocksSection.endsecLine = j; i = j + 2; break; }
                        if (c === "0" && v === "BLOCK") {
                            const blockStart = j;
                            let name = null;
                            let k = j + 2;
                            while (k < lines.length) {
                                const ck = codeAt(k);
                                const vk = valAt(k);
                                if (ck === "2" && name === null) name = vk;
                                if (ck === "0" && vk === "ENDBLK") { k += 2; break; }
                                k += 2;
                            }
                            if (name) blocksSection.blocks[name] = { start: blockStart, end: k };
                            j = k;
                            continue;
                        }
                        j += 2;
                    }
                    index.blocksSection = blocksSection;
                    continue;
                }

                if (sectionName === "ENTITIES") {
                    const entitiesSection = { start: i, endsecLine: null, entities: [] };
                    let j = i + 4;
                    let entStart = null, entType = null, entLayer = null, entColorLine = null;
                    const closeEntity = (endIdx) => {
                        if (entStart !== null) entitiesSection.entities.push({ start: entStart, end: endIdx, type: entType, layer: entLayer, colorLine: entColorLine });
                        entStart = null; entType = null; entLayer = null; entColorLine = null;
                    };
                    while (j < lines.length) {
                        const c = codeAt(j);
                        const v = valAt(j);
                        if (c === "0" && v === "ENDSEC") { closeEntity(j); entitiesSection.endsecLine = j; i = j + 2; break; }
                        if (c === "0") { closeEntity(j); entStart = j; entType = v; entLayer = null; entColorLine = null; j += 2; continue; }
                        if (c === "8" && entStart !== null && entLayer === null) { entLayer = v; j += 2; continue; }
                        if (c === "62" && entStart !== null && entColorLine === null) { entColorLine = j; j += 2; continue; }
                        j += 2;
                    }
                    index.entitiesSection = entitiesSection;
                    continue;
                }

                let k = i + 2;
                while (k < lines.length && !(codeAt(k) === "0" && valAt(k) === "ENDSEC")) k += 2;
                i = k + 2;
                continue;
            }
            i += 2;
        }
        return index;
    }

    class DxfDocument {
        constructor(text) {
            this.lines = normalizeDxfLines(splitLines(text));
            assertStrictDxf(this.lines);
            this.index = indexDocument(this.lines);
        }
        toText() { return this.lines.join("\n"); }

        _findCodeLine(range, code) {
            for (let n = range.start; n < range.end; n += 2) {
                if (this.lines[n] !== undefined && this.lines[n].trim() === String(code)) return n;
            }
            return -1;
        }

        _spliceLines(atLine, deleteCount, newLines) {
            this.lines.splice(atLine, deleteCount, ...newLines);
            const delta = newLines.length - deleteCount;
            if (delta === 0) return;
            const shiftLine = (n) => (n === null || n === undefined ? n : (n >= atLine ? n + delta : n));
            const shiftRange = (r) => (r ? { start: shiftLine(r.start), end: shiftLine(r.end) } : r);

            for (const tableName of Object.keys(this.index.tables)) {
                const t = this.index.tables[tableName];
                t.tableHeaderLine = shiftLine(t.tableHeaderLine);
                t.endtabLine = shiftLine(t.endtabLine);
                for (const name of Object.keys(t.entries)) t.entries[name] = shiftRange(t.entries[name]);
            }
            if (this.index.blocksSection) {
                const b = this.index.blocksSection;
                b.start = shiftLine(b.start);
                b.endsecLine = shiftLine(b.endsecLine);
                for (const name of Object.keys(b.blocks)) b.blocks[name] = shiftRange(b.blocks[name]);
            }
            if (this.index.entitiesSection) {
                const es = this.index.entitiesSection;
                es.start = shiftLine(es.start);
                es.endsecLine = shiftLine(es.endsecLine);
                for (const e of es.entities) {
                    e.start = shiftLine(e.start);
                    e.end = shiftLine(e.end);
                    e.colorLine = shiftLine(e.colorLine);
                }
            }
        }

        setTableEntryField(tableName, entryName, code, value) {
            const table = this.index.tables[tableName];
            if (!table || !table.entries[entryName]) return false;
            const range = table.entries[entryName];
            const lineIdx = this._findCodeLine(range, code);
            if (lineIdx !== -1) {
                if (this.lines[lineIdx + 1].trim() === String(value)) return false;
                this.lines[lineIdx + 1] = String(value);
                return true;
            }
            this._spliceLines(range.end, 0, [String(code), String(value)]);
            return true;
        }

        insertTableEntry(tableName, entryLines) {
            const table = this.index.tables[tableName];
            if (!table || table.endtabLine === null) return false;
            this._spliceLines(table.endtabLine, 0, entryLines);
            return true;
        }

        insertBlockSegment(blockLines) {
            const b = this.index.blocksSection;
            if (!b || b.endsecLine === null) return false;
            this._spliceLines(b.endsecLine, 0, blockLines);
            return true;
        }

        getTableEntryLines(tableName, entryName) {
            const table = this.index.tables[tableName];
            if (!table || !table.entries[entryName]) return null;
            const r = table.entries[entryName];
            return this.lines.slice(r.start, r.end);
        }

        getBlockLines(blockName) {
            const b = this.index.blocksSection;
            if (!b || !b.blocks[blockName]) return null;
            const r = b.blocks[blockName];
            return this.lines.slice(r.start, r.end);
        }

        removeExplicitEntityColors(shouldStrip) {
            const es = this.index.entitiesSection;
            if (!es) return 0;
            let count = 0;
            const ents = [...es.entities].filter(e => e.colorLine !== null).sort((a, b) => b.start - a.start);
            for (const e of ents) {
                const colorVal = parseInt(this.lines[e.colorLine + 1], 10);
                if (shouldStrip({ type: e.type, layer: e.layer, color: colorVal })) {
                    this._spliceLines(e.colorLine, 2, []);
                    count++;
                }
            }
            return count;
        }

        hasTable(tableName) { return !!this.index.tables[tableName]; }
        hasBlocksSection() { return !!this.index.blocksSection; }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  dxfMender — the safe auto-correct orchestration
    // ═════════════════════════════════════════════════════════════════════════

    const HEAL_DEFAULT_OPTIONS = {
        fixLayerProperties: true,
        addMissingLayers: true,
        addMissingLinetypes: true,
        addMissingTextStyles: true,
        fixEntityColorOverrides: true,
        healBlocks: false,   // opt-in: BLOCK_RECORD table isn't modelled — verify in CAD
    };

    function findLayerRule(standard, name) {
        return (standard.layers || []).find(l => l.name === name);
    }

    function explainSkip({ optionEnabled, optionName, ruleFound, tableExists, tableName }) {
        if (!optionEnabled) return `Automatic fix disabled (options.${optionName} is off).`;
        if (!ruleFound) return "No corresponding rule found in the derived standard.";
        if (!tableExists) return `The drawing has no ${tableName} table to insert into — add one manually first.`;
        return "Could not apply the automatic fix — see the drawing manually.";
    }

    function healDxf(masterText, targetText, options) {
        const opts = { ...HEAL_DEFAULT_OPTIONS, ...(options || {}) };

        const masterModel = parseDxf(masterText);
        const targetModelBefore = parseDxf(targetText);
        const standard = standardFromMasterDxf(masterModel);
        const violationsBefore = checkStandards(targetModelBefore, standard).violations;

        const masterDoc = new DxfDocument(masterText);
        const targetDoc = new DxfDocument(targetText);

        const actions = [];
        const unresolved = [];
        const alreadyInserted = { LAYER: new Set(), LTYPE: new Set(), STYLE: new Set(), BLOCK: new Set() };

        for (const v of violationsBefore) {
            switch (v.code) {
                case "LAYER_COLOR_MISMATCH": {
                    const rule = findLayerRule(standard, v.layer);
                    if (opts.fixLayerProperties && rule && rule.color !== undefined && targetDoc.setTableEntryField("LAYER", v.layer, 62, rule.color)) {
                        actions.push({ code: v.code, layer: v.layer, action: "Set layer color", to: rule.color });
                    } else {
                        unresolved.push({ ...v, reason: explainSkip({ optionEnabled: opts.fixLayerProperties, optionName: "fixLayerProperties", ruleFound: !!(rule && rule.color !== undefined), tableExists: true }) });
                    }
                    break;
                }
                case "LAYER_LINETYPE_MISMATCH": {
                    const rule = findLayerRule(standard, v.layer);
                    if (opts.fixLayerProperties && rule && rule.linetype && targetDoc.setTableEntryField("LAYER", v.layer, 6, rule.linetype)) {
                        actions.push({ code: v.code, layer: v.layer, action: "Set layer linetype", to: rule.linetype });
                    } else {
                        unresolved.push({ ...v, reason: explainSkip({ optionEnabled: opts.fixLayerProperties, optionName: "fixLayerProperties", ruleFound: !!(rule && rule.linetype), tableExists: true }) });
                    }
                    break;
                }
                case "LAYER_LINEWEIGHT_MISMATCH":
                case "LAYER_LINEWEIGHT_EXCEEDS_MAX": {
                    const rule = findLayerRule(standard, v.layer);
                    const target = rule && (rule.lineweight !== undefined ? rule.lineweight : rule.lineweightMax);
                    if (opts.fixLayerProperties && rule && target !== undefined && targetDoc.setTableEntryField("LAYER", v.layer, 370, target)) {
                        actions.push({ code: v.code, layer: v.layer, action: "Set layer lineweight", to: target });
                    } else {
                        unresolved.push({ ...v, reason: explainSkip({ optionEnabled: opts.fixLayerProperties, optionName: "fixLayerProperties", ruleFound: !!(rule && target !== undefined), tableExists: true }) });
                    }
                    break;
                }
                case "MISSING_REQUIRED_LAYER": {
                    if (alreadyInserted.LAYER.has(v.layer)) { actions.push({ code: v.code, layer: v.layer, action: "Already added this pass" }); break; }
                    const entryLines = masterDoc.getTableEntryLines("LAYER", v.layer);
                    if (opts.addMissingLayers && entryLines && targetDoc.hasTable("LAYER") && targetDoc.insertTableEntry("LAYER", entryLines)) {
                        alreadyInserted.LAYER.add(v.layer);
                        actions.push({ code: v.code, layer: v.layer, action: "Added layer from master template" });
                    } else {
                        unresolved.push({ ...v, reason: explainSkip({ optionEnabled: opts.addMissingLayers, optionName: "addMissingLayers", ruleFound: !!entryLines, tableExists: targetDoc.hasTable("LAYER"), tableName: "LAYER" }) });
                    }
                    break;
                }
                case "MISSING_REQUIRED_LINETYPE":
                case "UNDEFINED_LINETYPE_REFERENCE": {
                    if (alreadyInserted.LTYPE.has(v.linetype)) { actions.push({ code: v.code, linetype: v.linetype, action: "Already added this pass" }); break; }
                    const entryLines = masterDoc.getTableEntryLines("LTYPE", v.linetype);
                    if (opts.addMissingLinetypes && entryLines && targetDoc.hasTable("LTYPE") && targetDoc.insertTableEntry("LTYPE", entryLines)) {
                        alreadyInserted.LTYPE.add(v.linetype);
                        actions.push({ code: v.code, linetype: v.linetype, action: "Added linetype from master template" });
                    } else {
                        unresolved.push({ ...v, reason: explainSkip({ optionEnabled: opts.addMissingLinetypes, optionName: "addMissingLinetypes", ruleFound: !!entryLines, tableExists: targetDoc.hasTable("LTYPE"), tableName: "LTYPE" }) });
                    }
                    break;
                }
                case "MISSING_REQUIRED_STYLE": {
                    if (alreadyInserted.STYLE.has(v.style)) { actions.push({ code: v.code, style: v.style, action: "Already added this pass" }); break; }
                    const entryLines = masterDoc.getTableEntryLines("STYLE", v.style);
                    if (opts.addMissingTextStyles && entryLines && targetDoc.hasTable("STYLE") && targetDoc.insertTableEntry("STYLE", entryLines)) {
                        alreadyInserted.STYLE.add(v.style);
                        actions.push({ code: v.code, style: v.style, action: "Added text style from master template" });
                    } else {
                        unresolved.push({ ...v, reason: explainSkip({ optionEnabled: opts.addMissingTextStyles, optionName: "addMissingTextStyles", ruleFound: !!entryLines, tableExists: targetDoc.hasTable("STYLE"), tableName: "STYLE" }) });
                    }
                    break;
                }
                case "MISSING_REQUIRED_BLOCK": {
                    if (alreadyInserted.BLOCK.has(v.block)) { actions.push({ code: v.code, block: v.block, action: "Already added this pass" }); break; }
                    const blockLines = masterDoc.getBlockLines(v.block);
                    if (opts.healBlocks && blockLines && targetDoc.hasBlocksSection() && targetDoc.insertBlockSegment(blockLines)) {
                        alreadyInserted.BLOCK.add(v.block);
                        actions.push({ code: v.code, block: v.block, action: "Copied block definition from master template", caveat: "Verify the BLOCK_RECORD table and any cross-references in your CAD application before distributing." });
                    } else {
                        unresolved.push({ ...v, reason: opts.healBlocks ? "Block not found in master, or target has no BLOCKS section to insert into." : "Block auto-correct is off by default — enable options.healBlocks and verify the result in your CAD application." });
                    }
                    break;
                }
                case "ENTITY_COLOR_NOT_BYLAYER":
                    if (!opts.fixEntityColorOverrides) unresolved.push({ ...v, reason: "Automatic fix disabled (options.fixEntityColorOverrides is off)." });
                    break;
                default:
                    unresolved.push({ ...v, reason: "No automated fix for this rule — requires manual review." });
            }
        }

        if (opts.fixEntityColorOverrides && standard.colorPolicy === "byLayer") {
            const removedCount = targetDoc.removeExplicitEntityColors(
                ({ color }) => typeof color === "number" && color !== 256 && color !== 0
            );
            if (removedCount > 0) {
                actions.push({ code: "ENTITY_COLOR_NOT_BYLAYER", action: `Removed an explicit color override on ${removedCount} ${removedCount === 1 ? "entity" : "entities"}, reverting to ByLayer` });
            }
        }

        const healedDxf = targetDoc.toText();
        const targetModelAfter = parseDxf(healedDxf);
        const violationsAfter = checkStandards(targetModelAfter, standard).violations;

        return {
            standard, violationsBefore, actions, unresolved, violationsAfter, healedDxf,
            summary: {
                violationsBefore: violationsBefore.length,
                actionsApplied: actions.length,
                unresolved: unresolved.length,
                violationsAfter: violationsAfter.length,
                fullyHealed: violationsAfter.length === 0,
            },
        };
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  svgOverlay — diff result → standalone SVG string
    // ═════════════════════════════════════════════════════════════════════════

    const OVERLAY_COLORS = { unchanged: "#9AA0A6", added: "#2E7BE0", removed: "#D0342C", modified: "#E08A00" };

    function collectPoints(entity) {
        const pts = [];
        switch (entity.type) {
            case "LINE": pts.push([entity.x1, entity.y1], [entity.x2, entity.y2]); break;
            case "CIRCLE":
                pts.push([entity.cx - entity.radius, entity.cy - entity.radius]);
                pts.push([entity.cx + entity.radius, entity.cy + entity.radius]);
                break;
            case "ARC": {
                // Tight extent: the two endpoints plus whichever cardinal
                // directions (0/90/180/270°) the sweep actually passes through —
                // not the full cx±r circle bbox.
                const r = entity.radius || 0;
                const s = entity.startAngle || 0;
                const e = entity.endAngle || 0;
                let sweep = ((e - s) % 360 + 360) % 360;
                if (sweep === 0) sweep = 360;
                const at = (deg) => { const a = deg * Math.PI / 180; return [entity.cx + r * Math.cos(a), entity.cy + r * Math.sin(a)]; };
                pts.push(at(s), at(e));
                for (const card of [0, 90, 180, 270]) {
                    if (((card - s) % 360 + 360) % 360 <= sweep + 1e-9) pts.push(at(card));
                }
                break;
            }
            case "LWPOLYLINE":
            case "POLYLINE":
                for (const p of entity.points || entity.vertices || []) pts.push([p.x, p.y]);
                break;
            case "TEXT":
            case "MTEXT":
            case "INSERT": pts.push([entity.x, entity.y]); break;
            default: break;
        }
        return pts;
    }

    function computeBounds(entities) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const e of entities) {
            for (const [x, y] of collectPoints(e)) {
                if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                minX = Math.min(minX, x); minY = Math.min(minY, y);
                maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            }
        }
        if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
        const padX = Math.max((maxX - minX) * 0.05, 1);
        const padY = Math.max((maxY - minY) * 0.05, 1);
        return { minX: minX - padX, minY: minY - padY, maxX: maxX + padX, maxY: maxY + padY };
    }

    function svgEntity(entity, status) {
        const color = OVERLAY_COLORS[status] || OVERLAY_COLORS.unchanged;
        const cls = status;
        const strokeWidth = status === "unchanged" ? 0.4 : 0.8;
        const dash = status === "removed" ? ' stroke-dasharray="2,1.5"' : "";
        switch (entity.type) {
            case "LINE":
                return `<line class="${cls}" x1="${entity.x1}" y1="${-entity.y1}" x2="${entity.x2}" y2="${-entity.y2}" stroke="${color}" stroke-width="${strokeWidth}"${dash} />`;
            case "CIRCLE":
                return `<circle class="${cls}" cx="${entity.cx}" cy="${-entity.cy}" r="${entity.radius}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"${dash} />`;
            case "ARC": {
                // Real arc sweep (DXF angles are degrees CCW from +X). The overlay
                // flips Y (y → -y), so a DXF-CCW arc draws CW on screen → sweep-flag 0.
                const r = entity.radius || 0;
                const a0 = (entity.startAngle || 0) * Math.PI / 180;
                const a1 = (entity.endAngle || 0) * Math.PI / 180;
                const sx = entity.cx + r * Math.cos(a0), sy = entity.cy + r * Math.sin(a0);
                const ex = entity.cx + r * Math.cos(a1), ey = entity.cy + r * Math.sin(a1);
                const sweepDeg = (((entity.endAngle || 0) - (entity.startAngle || 0)) % 360 + 360) % 360;
                const largeArc = sweepDeg > 180 ? 1 : 0;
                return `<path class="${cls}" d="M ${sx} ${-sy} A ${r} ${r} 0 ${largeArc} 0 ${ex} ${-ey}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"${dash} />`;
            }
            case "LWPOLYLINE":
            case "POLYLINE": {
                const raw = entity.points || entity.vertices || [];
                const pts = raw.map(p => `${p.x},${-p.y}`).join(" ");
                const tag = entity.closed ? "polygon" : "polyline";
                return `<${tag} class="${cls}" points="${pts}" fill="none" stroke="${color}" stroke-width="${strokeWidth}"${dash} />`;
            }
            case "TEXT":
            case "MTEXT":
            case "INSERT":
                return `<circle class="${cls}" cx="${entity.x}" cy="${-entity.y}" r="0.8" fill="${color}" />`;
            default:
                return "";
        }
    }

    function buildSvgOverlay(referenceModel, targetModel, diffResult) {
        const allEntities = [...(referenceModel.entities || []), ...(targetModel.entities || [])];
        const bounds = computeBounds(allEntities);
        const width = bounds.maxX - bounds.minX;
        const height = bounds.maxY - bounds.minY;

        const removedSet = new Set(diffResult.removed);
        const addedSet = new Set(diffResult.added);
        const modifiedRefSet = new Set(diffResult.modified.map(m => m.reference));
        const modifiedTgtSet = new Set(diffResult.modified.map(m => m.target));

        const parts = [];
        for (const e of referenceModel.entities || []) {
            if (modifiedRefSet.has(e)) continue;
            const status = removedSet.has(e) ? "removed" : "unchanged";
            if (status === "unchanged") continue;   // drawn once via the target pass
            parts.push(svgEntity(e, status));
        }
        for (const e of targetModel.entities || []) {
            if (modifiedTgtSet.has(e)) continue;
            const status = addedSet.has(e) ? "added" : "unchanged";
            parts.push(svgEntity(e, status));
        }
        for (const m of diffResult.modified) {
            parts.push(svgEntity(m.reference, "removed"));
            parts.push(svgEntity(m.target, "modified"));
        }

        return [
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.minX} ${-bounds.maxY} ${width} ${height}" preserveAspectRatio="xMidYMid meet">`,
            `<rect x="${bounds.minX}" y="${-bounds.maxY}" width="${width}" height="${height}" fill="#0B1220" />`,
            ...parts,
            "</svg>",
        ].join("\n");
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  reportBuilder — combine standards check + geometry diff into one report
    // ═════════════════════════════════════════════════════════════════════════

    function buildReport({ meta, standardsResult, geometryResult, svg }) {
        const report = { meta: { generatedAt: new Date().toISOString(), ...meta } };
        if (standardsResult) report.standardsCheck = standardsResult;
        if (geometryResult) report.geometryDiff = geometryResult;
        if (svg) report.overlaySvg = svg;

        // A check that did not run is null ("not checked"), never an implicit pass.
        const standardsPassed = standardsResult ? standardsResult.summary.passed : null;
        const geometryPassed = geometryResult ? geometryResult.summary.identical : null;
        const ran = [standardsPassed, geometryPassed].filter(v => v !== null);
        report.overall = { passed: ran.length ? ran.every(Boolean) : null, standardsPassed, geometryIdentical: geometryPassed };
        return report;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  compareOrchestrator — the pure "which standard wins" decision logic
    //  (server req/res adapter, multer, and the filesystem standards dir dropped)
    //  CompareError is declared at the top of this module.
    // ═════════════════════════════════════════════════════════════════════════

    function orchestrateCompare(input) {
        const {
            targetText,
            targetFileName = null,
            referenceText = null,
            referenceFileName = null,
            masterText = null,
            masterFileName = null,
            jsonStandardSpec = null,
            standardId = null,
            tolerances = null,
            resolveBuiltInStandard = defaultResolveBuiltInStandard,
        } = input || {};

        if (!targetText) throw new CompareError(400, 'A "target" DXF file is required.');

        let resolvedJsonStandard = jsonStandardSpec;
        if (!resolvedJsonStandard && standardId) resolvedJsonStandard = resolveBuiltInStandard(standardId);

        let standardSpec = resolvedJsonStandard;
        if (masterText) {
            const masterDerived = standardFromMasterDxf(parseDxf(masterText));
            standardSpec = mergeStandards(masterDerived, resolvedJsonStandard);
        }

        if (standardSpec) {
            try {
                assertStandardPatternsAreSafe(standardSpec);
            } catch (err) {
                throw new CompareError(400, err.message);
            }
        }

        if (!referenceText && !standardSpec) {
            throw new CompareError(400, 'Provide a "reference" DXF, a "master" template DXF, and/or a "standard" to compare against.');
        }

        const targetModel = parseDxf(targetText);

        let standardsResult = null;
        if (standardSpec) standardsResult = checkStandards(targetModel, standardSpec);

        let geometryResult = null;
        let svg = null;
        if (referenceText) {
            const referenceModel = parseDxf(referenceText);
            geometryResult = diffGeometry(referenceModel, targetModel, tolerances);
            svg = buildSvgOverlay(referenceModel, targetModel, geometryResult);
        }

        return buildReport({
            meta: {
                targetFile: targetFileName,
                referenceFile: referenceFileName,
                masterFile: masterFileName,
                standardName: standardSpec ? standardSpec.name : null,
                targetEntityCount: targetModel.entities.length,
                targetUnits: targetModel.units,
            },
            standardsResult, geometryResult, svg,
        });
    }

    /**
     * The FDOT 2026 layer standard, derived from window.FDOT_DATA — every layer
     * name → colour (ACI) + linetype + exact lineweight (1/100 mm), all
     * required, ByLayer colour policy. This is the built-in the retired
     * "Template Compare" tab checked against; picking it here reproduces that
     * layer-table diff (plus everything else this engine does).
     */
    function fdot2026Standard() {
        const src = (typeof window !== "undefined" && window.FDOT_DATA && window.FDOT_DATA.layers) || [];
        return {
            name: "FDOT 2026 Layer Standard (built-in)",
            source: "fdot-data",
            layers: src.map(l => ({
                name: l.name,
                color: typeof l.color === "number" ? l.color : undefined,
                linetype: l.linetype || undefined,
                lineweight: Number.isFinite(parseFloat(l.lineweight)) ? Math.round(parseFloat(l.lineweight) * 100) : undefined,
                required: true,
            })),
            colorPolicy: "byLayer",
        };
    }

    /** Built-in JSON standards (was a filesystem directory server-side). */
    const BUILTIN_STANDARDS = {
        "fdot-2026": fdot2026Standard(),
        "example-standard": {
            name: "Example Company Drafting Standard",
            version: "1.0",
            units: "millimeters",
            layers: [
                { name: "0", color: 7, linetype: "CONTINUOUS", required: true },
                { name: "WALLS", color: 1, linetype: "CONTINUOUS", lineweightMax: 30, namingPattern: "^[A-Z0-9_-]+$" },
                { name: "DIMS", color: 3, linetype: "CONTINUOUS", namingPattern: "^[A-Z0-9_-]+$" },
                { name: "DOORS", color: 2, linetype: "CONTINUOUS", namingPattern: "^[A-Z0-9_-]+$" },
            ],
            prohibitedLayers: ["DEFPOINTS_TEMP", "XREF_UNRESOLVED"],
            namingConvention: { pattern: "^[A-Z][A-Z0-9_-]{1,30}$", appliesTo: ["layers", "blocks"] },
            textStyles: [{ name: "STANDARD", font: "arial.ttf", allowed: true }],
            colorPolicy: "byLayer",
            tolerances: { position: 0.01, radius: 0.01, angle: 0.5, textHeight: 0.05 },
        },
    };

    function defaultResolveBuiltInStandard(id) {
        const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "");
        const std = BUILTIN_STANDARDS[safeId];
        if (!std) throw new CompareError(400, `Unknown standardId "${safeId}".`);
        return JSON.parse(JSON.stringify(std));
    }

    function parseTolerancesField(raw) {
        if (!raw) return undefined;
        try { return JSON.parse(raw); } catch (e) { throw new CompareError(400, 'The "tolerances" field must be valid JSON.'); }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  reportRenderer — report object → self-contained HTML or Markdown
    // ═════════════════════════════════════════════════════════════════════════

    const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };
    const SEVERITY_LABEL = { error: "Error", warning: "Warning", info: "Info" };

    function esc(str) {
        return String(str === undefined || str === null ? "" : str)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }
    function sortBySeverity(list) {
        return [...list].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
    }

    function buildReportModel({ source, data, meta }) {
        if (source !== "compare" && source !== "heal") {
            throw new Error(`buildReportModel: unknown source "${source}" (expected "compare" or "heal")`);
        }
        const model = { source, generatedAt: new Date().toISOString(), meta: { ...(data.meta || {}), ...(meta || {}) } };

        if (source === "compare") {
            const violations = data.standardsCheck ? sortBySeverity(data.standardsCheck.violations) : [];
            model.standardName = data.meta && data.meta.standardName;
            model.violations = violations;
            model.violationCounts = data.standardsCheck ? data.standardsCheck.summary : null;   // null = no standards check ran
            model.geometryDiff = data.geometryDiff || null;
            model.overallPassed = !!(data.overall && data.overall.passed);
            model.statusLabel = data.overall && data.overall.passed === null ? "Not checked"
                : model.overallPassed ? "Passed" : "Needs attention";
        } else {
            model.standardName = data.standard && data.standard.name;
            model.actions = data.actions || [];
            model.unresolved = sortBySeverity(data.unresolved || []);
            model.violationsBefore = data.violationsBefore || [];
            model.violationsAfter = data.violationsAfter || [];
            model.summary = data.summary || {};
            model.overallPassed = !!(data.summary && data.summary.fullyHealed);
            model.statusLabel = model.overallPassed ? "Fully corrected" : "Partially corrected";
        }
        return model;
    }

    function renderStatCard(value, label) {
        return `<div class="stat"><div class="stat-value">${esc(value)}</div><div class="stat-label">${esc(label)}</div></div>`;
    }

    function renderViolationsTable(violations, { withReasonColumn } = {}) {
        if (!violations || violations.length === 0) return '<p class="empty">None.</p>';
        const rows = violations.map((v) => `
        <tr>
          <td><span class="badge badge-${esc(v.severity)}">${esc(SEVERITY_LABEL[v.severity] || v.severity)}</span></td>
          <td class="code">${esc(v.code)}</td>
          <td>${esc(v.layer || v.linetype || v.style || v.block || "—")}</td>
          <td>${esc(v.message)}</td>
          ${withReasonColumn ? `<td>${esc(v.reason || "")}</td>` : ""}
        </tr>`).join("");
        return `
        <table>
          <thead><tr><th>Severity</th><th>Code</th><th>Item</th><th>Description</th>${withReasonColumn ? "<th>Why manual review</th>" : ""}</tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    function renderActionsTable(actions) {
        if (!actions || actions.length === 0) return '<p class="empty">None.</p>';
        const rows = actions.map((a) => `
        <tr>
          <td class="code">${esc(a.code)}</td>
          <td>${esc(a.layer || a.linetype || a.style || a.block || "—")}</td>
          <td>${esc(a.action)}${a.to !== undefined ? ` &rarr; ${esc(a.to)}` : ""}${a.caveat ? `<div class="caveat">${esc(a.caveat)}</div>` : ""}</td>
        </tr>`).join("");
        return `
        <table>
          <thead><tr><th>Code</th><th>Item</th><th>Action taken</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    }

    function renderGeometrySection(geometryDiff) {
        if (!geometryDiff) return "";
        const s = geometryDiff.summary;
        return `
        <h2>Geometry differences</h2>
        <div class="stat-grid">
          ${renderStatCard(s.unchanged, "Unchanged")}
          ${renderStatCard(s.added, "Added")}
          ${renderStatCard(s.removed, "Removed")}
          ${renderStatCard(s.modified, "Modified")}
        </div>`;
    }

    const BASE_STYLE = `
      * { box-sizing: border-box; }
      body { font-family: 'Segoe UI', Arial, sans-serif; color: #1A2436; background: #fff; margin: 0; padding: 32px 40px; }
      h1 { font-size: 20px; margin: 0 0 4px 0; }
      h2 { font-size: 14px; margin: 28px 0 10px 0; border-bottom: 1px solid #D8DEE9; padding-bottom: 6px; }
      .subtitle { color: #5B6B87; font-size: 12.5px; margin: 0 0 18px 0; }
      .meta-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px 24px; font-size: 12px; color: #40506B; margin-bottom: 18px; }
      .meta-grid strong { color: #1A2436; }
      .status-banner { padding: 10px 14px; border-radius: 3px; font-weight: 600; font-size: 13px; margin-bottom: 18px; border-left: 4px solid; }
      .status-pass { background: #EAF6EE; border-color: #3F9F6B; color: #1F5C39; }
      .status-fail { background: #FBF1E1; border-color: #C98A22; color: #7A5310; }
      .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: #D8DEE9; border: 1px solid #D8DEE9; margin-bottom: 8px; }
      .stat { background: #F7F9FC; padding: 10px; text-align: center; }
      .stat-value { font-size: 18px; font-weight: 700; font-family: 'Consolas', monospace; }
      .stat-label { font-size: 10.5px; color: #5B6B87; margin-top: 2px; }
      table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin-bottom: 10px; }
      th { text-align: left; font-weight: 600; color: #5B6B87; border-bottom: 1px solid #D8DEE9; padding: 5px 8px; }
      td { padding: 6px 8px; border-bottom: 1px solid #EDF0F5; vertical-align: top; }
      .code { font-family: 'Consolas', monospace; color: #2E7BE0; font-size: 10.5px; }
      .badge { font-size: 9.5px; font-weight: 700; padding: 2px 6px; border-radius: 999px; text-transform: uppercase; letter-spacing: .02em; }
      .badge-error { background: #FBE4E1; color: #A3271D; }
      .badge-warning { background: #FBEFD4; color: #8A5E00; }
      .badge-info { background: #DEF0F7; color: #0E5A78; }
      .caveat { color: #A3671D; font-size: 10px; margin-top: 2px; }
      .empty { color: #5B6B87; font-size: 12px; font-style: italic; }
      footer { margin-top: 32px; padding-top: 10px; border-top: 1px solid #D8DEE9; color: #8A97AD; font-size: 10.5px; }
      @media print { body { padding: 0.5in; } }
    `;

    function renderHtml(model) {
        const dateStr = new Date(model.generatedAt).toLocaleString();
        const title = model.source === "heal" ? "DXF Auto-Correct Report" : "DXF Standards Compliance Report";
        const metaRows = [
            ["Drawing", model.meta.targetFile],
            ["Standard", model.standardName || model.meta.standardName],
            ["Reference drawing", model.meta.referenceFile],
            ["Master template", model.meta.masterFile],
            ["Generated", dateStr],
        ].filter(([, v]) => v);

        let body = "";
        if (model.source === "compare") {
            body += `
            <div class="status-banner ${model.overallPassed ? "status-pass" : "status-fail"}">${esc(model.statusLabel)}</div>
            ${model.violationCounts ? `
            <h2>Standards violations (${model.violationCounts.total})</h2>
            <div class="stat-grid">
              ${renderStatCard(model.violationCounts.errors, "Errors")}
              ${renderStatCard(model.violationCounts.warnings, "Warnings")}
              ${renderStatCard(model.violationCounts.info, "Info")}
              ${renderStatCard(model.violationCounts.total, "Total")}
            </div>
            ${renderViolationsTable(model.violations)}` : `
            <h2>Standards violations</h2>
            <p>Not checked — no standard or master template was supplied.</p>`}
            ${renderGeometrySection(model.geometryDiff)}
          `;
        } else {
            body += `
            <div class="status-banner ${model.overallPassed ? "status-pass" : "status-fail"}">${esc(model.statusLabel)}</div>
            <div class="stat-grid">
              ${renderStatCard(model.summary.violationsBefore, "Deficiencies found")}
              ${renderStatCard(model.summary.actionsApplied, "Auto-fixed")}
              ${renderStatCard(model.summary.unresolved, "Needs review")}
              ${renderStatCard(model.summary.violationsAfter, "Remaining")}
            </div>
            <h2>Applied automatically</h2>
            ${renderActionsTable(model.actions)}
            <h2>Needs manual review</h2>
            ${renderViolationsTable(model.unresolved, { withReasonColumn: true })}
          `;
        }

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>${BASE_STYLE}</style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <p class="subtitle">Generated by stdn-compare</p>
  <div class="meta-grid">
    ${metaRows.map(([k, v]) => `<div><strong>${esc(k)}:</strong> ${esc(v)}</div>`).join("")}
  </div>
  ${body}
  <footer>Generated ${esc(dateStr)} &middot; stdn-compare defect report</footer>
</body>
</html>`;
    }

    function renderMarkdown(model) {
        const dateStr = new Date(model.generatedAt).toLocaleString();
        const title = model.source === "heal" ? "DXF Auto-Correct Report" : "DXF Standards Compliance Report";
        const lines = [];
        lines.push(`# ${title}`, "");
        if (model.meta.targetFile) lines.push(`**Drawing:** ${model.meta.targetFile}`);
        if (model.standardName || model.meta.standardName) lines.push(`**Standard:** ${model.standardName || model.meta.standardName}`);
        if (model.meta.referenceFile) lines.push(`**Reference drawing:** ${model.meta.referenceFile}`);
        if (model.meta.masterFile) lines.push(`**Master template:** ${model.meta.masterFile}`);
        lines.push(`**Generated:** ${dateStr}`, `**Status:** ${model.statusLabel}`, "");

        const violationLine = (v) => `- **[${(v.severity || "").toUpperCase()}] ${v.code}**${v.layer || v.linetype || v.style || v.block ? ` (${v.layer || v.linetype || v.style || v.block})` : ""} — ${v.message}${v.reason ? ` _(${v.reason})_` : ""}`;

        if (model.source === "compare") {
            if (!model.violationCounts) {
                lines.push("## Standards violations", "", "Not checked — no standard or master template was supplied.", "");
            } else {
                lines.push(`## Standards violations (${model.violationCounts.total})`, "");
                lines.push(`Errors: ${model.violationCounts.errors} · Warnings: ${model.violationCounts.warnings} · Info: ${model.violationCounts.info}`, "");
                if (model.violations.length === 0) lines.push("No violations found.", "");
                else { for (const v of model.violations) lines.push(violationLine(v)); lines.push(""); }
            }
            if (model.geometryDiff) {
                const s = model.geometryDiff.summary;
                lines.push("## Geometry differences", "");
                lines.push(`Unchanged: ${s.unchanged} · Added: ${s.added} · Removed: ${s.removed} · Modified: ${s.modified}`, "");
            }
        } else {
            lines.push(
                `Deficiencies found: ${model.summary.violationsBefore} · Auto-fixed: ${model.summary.actionsApplied} · ` +
                `Needs review: ${model.summary.unresolved} · Remaining: ${model.summary.violationsAfter}`, "");
            lines.push("## Applied automatically", "");
            if (model.actions.length === 0) lines.push("No automatic fixes were applied.", "");
            else {
                for (const a of model.actions) {
                    lines.push(`- **${a.code}**${a.layer || a.linetype || a.style || a.block ? ` (${a.layer || a.linetype || a.style || a.block})` : ""} — ${a.action}${a.to !== undefined ? ` → ${a.to}` : ""}${a.caveat ? ` _(${a.caveat})_` : ""}`);
                }
                lines.push("");
            }
            lines.push("## Needs manual review", "");
            if (model.unresolved.length === 0) lines.push("Nothing outstanding.", "");
            else { for (const v of model.unresolved) lines.push(violationLine(v)); lines.push(""); }
        }
        return lines.join("\n");
    }

    function suggestFilename(model, format) {
        const base = (model.meta.targetFile || "drawing").replace(/\.dxf$/i, "");
        const kind = model.source === "heal" ? "correction-report" : "defect-report";
        const ext = format === "markdown" ? "md" : "html";
        return `${base}.${kind}.${ext}`;
    }

    // ═════════════════════════════════════════════════════════════════════════

    window.StdnEngine = {
        // dxfLoader
        parseDxf, tokenize,
        // standardsCheck
        checkStandards, SEVERITY,
        // geometryDiff
        diffGeometry, anchorPoint, DEFAULT_TOLERANCES,
        // standardFromDxf
        standardFromMasterDxf, mergeStandards,
        // regexSafety
        checkPatternSafety, assertStandardPatternsAreSafe, MAX_PATTERN_LENGTH,
        // dxfDocument
        DxfDocument, indexDocument, splitLines, normalizeDxfLines,
        // dxfMender
        healDxf, HEAL_DEFAULT_OPTIONS,
        // svgOverlay
        buildSvgOverlay, OVERLAY_COLORS,
        // reportBuilder
        buildReport,
        // compareOrchestrator
        orchestrateCompare, parseTolerancesField, defaultResolveBuiltInStandard, BUILTIN_STANDARDS, CompareError,
        // reportRenderer
        buildReportModel, renderHtml, renderMarkdown, suggestFilename,
    };
})();
