/**
 * Plugin: tmplt-jea2024 (JEA As-Built Standards 2024)
 * plugins/tmplt-jea2024/tmplt-jea2024.js
 *
 * Implements JEA As-Built 2024 Standards for Civil 3D drawings:
 *  - 45 reference picklist domains (Materials, Sizes, Subtypes, Manufacturers, Classes, Linings);
 *    the reverse-read audit engine actively checks attributes against 21 of them today (Water
 *    valves/manholes/hydrants/fittings/meters/crossings) — Sewer/Reclaimed/Chilled Water domains
 *    are fully defined in DOMAINS but not yet wired into auditDrawing()'s per-block checks.
 *  - 29 sheet rules & field requirements (Water, Wastewater, Reclaimed, Chilled, Crossings)
 *  - Florida State Plane East (US Survey Feet) geodetic boundary checks, cross-verified against
 *    the natural WGS84 GPS envelope via core/cogo.js's SPCS83 conversion
 *  - Civil 3D DXF generation with native BLOCKS, ATTRIB metadata, and JEA utility layers
 *  - Reverse-read DXF parsing and rigorous QA/QC audit engine
 *  - Pipe crossing vertical separation by pipe type (JEA Standards 2026 §350 III.4.4–III.4.5)
 *  - "The 2024 JEA template" (CLIENT_TEMPLATE, id tpl_jea_2024): addAsClientTemplate() adds/
 *    updates it in the signed-in user's local Client Master Templates (window.BoundaryQCCMS);
 *    syncTemplateWithDb() separately pushes it to the PostgreSQL client_templates table via
 *    window.DatabaseService. Neither runs automatically — cms-engine.js no longer seeds this
 *    (a plugin-specific template doesn't belong baked into that domain-agnostic engine), so this
 *    plugin is the one place that knows what "the JEA template" contains.
 *  - Centralized Reports Hub integration (window.Reports)
 *
 * Registers via window.PluginRegistry.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "tmplt-jea2024",
        version: "1.0.0",
        description: "JEA As-Built Standards (2026): Civil 3D drawing builder, reverse-read DXF auditor, and validation against 45 JEA domains and State Plane East specs.",
        tab: "tab-jea24",
        icon: "fa-faucet-drip",
        tier: "Pro",
        dependencies: ["dxf-auditor", "linework", "reports"]
    };

    const clean = window.cleanText; // core/safe-dom.js — shared across every plugin that sanitizes text before interpolation

    // JEA reference data (bounds, layers, domains, rules, block defs) lives in
    // plugins/tmplt-jea2024/jea-data.js, which loads before this file.
    const { BOUNDS, CLIENT_TEMPLATE, LAYERS, LAYER_ALIASES, DOMAINS, RULES, BLOCK_DEFS, crossingRequirement, CROSSING_RULE_SOURCE } = window.Jea24Data;

    // ── Settings (per browser): layer mappings, workbook-check tolerances, duplicate rows, picklists ──
    // These are the decisions that belong to the surveyor or to JEA, not to this tool. They are kept in
    // this browser's storage only; nothing here changes the built-in data files.
    const BUILTIN_DOMAINS = JSON.parse(JSON.stringify(DOMAINS));
    const SETTINGS_KEY = "jea24.settings.v1";
    const defaultSettings = () => ({ qc: {}, duplicates: "first", layerMap: [], confirmedAliases: [], picklists: null, crossing: null });
    const layerKey = n => String(n == null ? "" : n).trim().replace(/\s+/g, " ").toUpperCase();
    const systemOf = layer => /^SS-/.test(layer) ? "Sewer" : /^RW-/.test(layer) ? "Reclaimed" : /^CW-/.test(layer) ? "Chilled" : /^W-/.test(layer) ? "Water" : "";

    /** Validates a whole settings object; returns a clean copy or throws with the first problem. */
    function validateSettings(x) {
        const s = Object.assign(defaultSettings(), x || {});
        const out = defaultSettings();
        if (s.duplicates !== "first" && s.duplicates !== "last") throw new Error(`Duplicate rows: choose "first" or "last".`);
        out.duplicates = s.duplicates;
        if (typeof s.qc !== "object" || Array.isArray(s.qc)) throw new Error("Tolerances must be an object.");
        if (window.JeaXlsx) window.JeaXlsx.qcStructures([], { qc: s.qc }); // throws on an unknown key or a non-positive value
        out.qc = Object.assign({}, s.qc);
        if (!Array.isArray(s.layerMap)) throw new Error("Layer mappings must be a list.");
        const seen = new Set();
        out.layerMap = s.layerMap.map((m, i) => {
            const name = String((m && m.name) || "").trim();
            if (!name) throw new Error(`Layer mapping ${i + 1}: enter the drawing's layer name.`);
            if (!LAYERS.some(l => l.name === m.layer)) throw new Error(`Layer mapping "${name}": "${m.layer}" is not a JEA template layer.`);
            if (LAYERS.some(l => layerKey(l.name) === layerKey(name))) throw new Error(`Layer mapping "${name}" is already a JEA template layer.`);
            if (seen.has(layerKey(name))) throw new Error(`Layer "${name}" is mapped twice.`);
            seen.add(layerKey(name));
            return { name, layer: m.layer, confirmed: m.confirmed === true };
        });
        if (!Array.isArray(s.confirmedAliases)) throw new Error("Confirmed aliases must be a list.");
        const sources = LAYER_ALIASES.map(a => a.match.source);
        out.confirmedAliases = s.confirmedAliases.filter(src => {
            if (!sources.includes(src)) throw new Error(`Unknown built-in layer alias "${src}".`);
            return true;
        });
        if (s.crossing != null) {
            if (typeof s.crossing !== "object" || Array.isArray(s.crossing)) throw new Error("Crossing minimums must be an object.");
            const keep = window.Jea24Data.CROSSING_MINIMUMS_JEA_2026;
            Object.keys(s.crossing).forEach(k => {
                const v = s.crossing[k];
                if (!(k in keep)) throw new Error(`Unknown crossing minimum "${k}".`);
                if (typeof v !== "number" || !isFinite(v) || v <= 0 || v > 120) throw new Error(`Crossing minimum "${k}" must be a number of inches between 0 and 120.`);
            });
            out.crossing = Object.assign({}, s.crossing);
        }
        if (s.picklists != null) {
            const pl = s.picklists;
            if (typeof pl.source !== "string" || !pl.source || typeof pl.lists !== "object") throw new Error("Picklists need a source and lists.");
            Object.keys(pl.lists).forEach(k => {
                if (!(k in BUILTIN_DOMAINS)) throw new Error(`Picklist "${k}" is not one of the ${Object.keys(BUILTIN_DOMAINS).length} JEA lists.`);
                if (!Array.isArray(pl.lists[k]) || !pl.lists[k].length || pl.lists[k].some(v => typeof v !== "string" || !v.trim())) throw new Error(`Picklist "${k}" must be a list of non-blank values.`);
            });
            out.picklists = { source: pl.source, loadedAt: String(pl.loadedAt || ""), lists: JSON.parse(JSON.stringify(pl.lists)) };
        }
        return out;
    }

    function applyCrossing(c) { window.Jea24Data.setCrossingMinimums(c && Object.keys(c).length ? c : null); }

    function applyPicklists(pl) {
        // DOMAINS is shared by the audit, the importer and the Domains browser: change it in place.
        Object.keys(DOMAINS).forEach(k => { DOMAINS[k] = BUILTIN_DOMAINS[k].slice(); });
        if (pl) Object.keys(pl.lists).forEach(k => { DOMAINS[k] = pl.lists[k].slice(); });
    }

    function loadSettings() {
        try {
            const raw = window.localStorage && window.localStorage.getItem(SETTINGS_KEY);
            return raw ? validateSettings(JSON.parse(raw)) : defaultSettings();
        } catch (e) {
            return defaultSettings(); // unreadable or out-of-date settings: start clean rather than half-apply
        }
    }

    let _settings = loadSettings();
    applyPicklists(_settings.picklists);
    applyCrossing(_settings.crossing);

    function getSettings() { return JSON.parse(JSON.stringify(_settings)); }

    /** Merges, validates (throws on a bad value — nothing is saved then), applies and stores. */
    function setSettings(partial) {
        const next = validateSettings(Object.assign(getSettings(), partial || {}));
        _settings = next;
        applyPicklists(next.picklists);
        applyCrossing(next.crossing);
        try { if (window.localStorage) window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch (e) { /* storage blocked: settings last for this page only */ }
        return getSettings();
    }

    function resetSettings() {
        try { if (window.localStorage) window.localStorage.removeItem(SETTINGS_KEY); } catch (e) { /* ignore */ }
        _settings = defaultSettings();
        applyPicklists(null);
        applyCrossing(null);
        return getSettings();
    }

    /**
     * The rules a result was produced under — stamped on every audit, workbook check and package check
     * so a report can't be mistaken for one made under different rules.
     */
    function rulesApplied() {
        const X = window.JeaXlsx;
        const qc = Object.assign({}, X ? X.QC_DEFAULTS : {}, _settings.qc || {});
        return {
            standards: "JEA Water and Wastewater Standards, Vol. 1, rev. January 1, 2026 (§350 crossings, §501 as-builts)",
            crossings: crossingRequirement("Potable Water", "Force Main").source,
            picklists: _settings.picklists ? `${_settings.picklists.source} (loaded ${String(_settings.picklists.loadedAt).slice(0, 10)})` : "built-in — JEA As Built Template 2026",
            tolerances: `lat/lon ${qc.latLonTolFt} ft, depth ${qc.depthTolFt} ft${_settings.qc && Object.keys(_settings.qc).length ? " (set in Settings)" : " (JEA §501 II.1.7)"}`,
            layerMappingsConfirmed: _settings.confirmedAliases.length + _settings.layerMap.filter(m => m.confirmed).length,
            build: (window.BUILD_INFO && (window.BUILD_INFO.commit || window.BUILD_INFO.version)) || null
        };
    }
    const rulesLine = r => `Rules: ${r.standards}; crossings: ${r.crossings}; picklists ${r.picklists}; tolerances ${r.tolerances}${r.build ? `; app build ${r.build}` : ""}.`;

    /**
     * Layer name → { layer, system, how } or null when unrecognised. how:
     *   "standard"  a JEA template layer
     *   "confirmed" a mapping the user confirmed in Settings (counts toward the score like a standard layer)
     *   "inferred"  a built-in or user mapping not yet confirmed (reported; never earns a score)
     */
    function resolveLayer(name) {
        const std = LAYERS.find(l => l.name === name);
        if (std) return { layer: std.name, system: systemOf(std.name), how: "standard" };
        const key = layerKey(name);
        const user = _settings.layerMap.find(m => layerKey(m.name) === key);
        if (user) return { layer: user.layer, system: systemOf(user.layer), how: user.confirmed ? "confirmed" : "inferred" };
        const al = LAYER_ALIASES.find(a => a.match.test(String(name)));
        return al ? { layer: al.layer, system: al.system, how: _settings.confirmedAliases.includes(al.match.source) ? "confirmed" : "inferred" } : null;
    }

    // ═════════════════════════════════════════════════════════════════════
    // 2. Sample Demo Utility Network (Compliant with JEA 2024 specs)
    // ═════════════════════════════════════════════════════════════════════

    function getSampleNetwork() {
        return {
            projectName: "JEA San Jose Blvd Water & Sewer Realignment",
            county: "Duval",
            bounds: BOUNDS,
            pipes: [
                {
                    id: "W_PIPE_01",
                    layer: "W-MAIN",
                    system: "Water",
                    subtype: "Distribution Main",
                    diameter: "8",
                    material: "Ductile Iron",
                    pipeClass: "CL50",
                    lining: "Cementitious",
                    points: [
                        { p: 101, e: 436210.50, n: 2154320.10, z: 22.40, station: "10+00" },
                        { p: 102, e: 436350.80, n: 2154320.10, z: 22.15, station: "11+40" },
                        { p: 103, e: 436520.00, n: 2154320.10, z: 21.80, station: "13+10" }
                    ]
                },
                {
                    id: "SS_GRAV_01",
                    layer: "SS-GRAV",
                    system: "Sewer",
                    subtype: "Collection Main",
                    diameter: "8",
                    material: "Polyvinyl Chloride",
                    pipeClass: "DR26",
                    points: [
                        { p: 201, e: 436350.80, n: 2154200.00, z: 16.50, desc: "MH_101" },
                        { p: 202, e: 436350.80, n: 2154320.10, z: 15.80, desc: "CROSSING_PT" },
                        { p: 203, e: 436350.80, n: 2154480.00, z: 14.90, desc: "MH_102" }
                    ]
                }
            ],
            structures: [
                {
                    id: "V-101",
                    block: "JEA_VALVE",
                    layer: "W-VALV",
                    e: 436215.00,
                    n: 2154320.10,
                    z: 22.40,
                    attribs: {
                        SUBTYPE: "Valve",
                        VALVE_TYPE: "Resilient Seat Wedge Gate",
                        SIZE: "8",
                        MATERIAL: "Ductile Iron",
                        MANUFACTURER: "American Flow Control",
                        OPEN_DIR: "Left",
                        STATUS: "Open",
                        ELEVATION: "22.40"
                    }
                },
                {
                    id: "HYD-101",
                    block: "JEA_HYDRANT",
                    layer: "W-HYDR",
                    e: 436280.00,
                    n: 2154332.00,
                    z: 22.90,
                    attribs: {
                        SUBTYPE: "Hydrant",
                        MODEL: "American Darling",
                        MANUFACTURER: "American Flow Control",
                        VALVE_SIZE: "6",
                        BURY_DEPTH: "4.5",
                        ELEVATION: "22.90"
                    }
                },
                {
                    id: "FIT-101",
                    block: "JEA_FITTING",
                    layer: "W-FITT",
                    e: 436350.80,
                    n: 2154320.10,
                    z: 22.15,
                    attribs: {
                        SUBTYPE: "Tee",
                        SIZE: "8",
                        MATERIAL: "Ductile Iron",
                        MANUFACTURER: "American Cast Iron Pipe Company",
                        ELEVATION: "22.15"
                    }
                },
                {
                    id: "MH-101",
                    block: "JEA_MANHOLE",
                    layer: "SS-MANH",
                    e: 436350.80,
                    n: 2154200.00,
                    z: 23.50,
                    attribs: {
                        SUBTYPE: "Collection",
                        MANHOLE_TYPE: "A",
                        RIM_ELEV: "23.50",
                        INVERT_IN: "16.80",
                        INVERT_OUT: "16.50",
                        DEPTH: "7.00",
                        DIAMETER: "4",
                        MATERIAL: "Precast",
                        MANUFACTURER: "Del Zotto Precast",
                        LINING: "Epoxy"
                    }
                },
                {
                    id: "MH-102",
                    block: "JEA_MANHOLE",
                    layer: "SS-MANH",
                    e: 436350.80,
                    n: 2154480.00,
                    z: 23.10,
                    attribs: {
                        SUBTYPE: "Collection",
                        MANHOLE_TYPE: "A",
                        RIM_ELEV: "23.10",
                        INVERT_IN: "14.90",
                        INVERT_OUT: "14.70",
                        DEPTH: "8.40",
                        DIAMETER: "4",
                        MATERIAL: "Precast",
                        MANUFACTURER: "Del Zotto Precast",
                        LINING: "Epoxy"
                    }
                }
            ],
            crossings: [
                {
                    id: "X-01",
                    block: "JEA_CROSSING",
                    layer: "UTIL-CROSS",
                    e: 436350.80,
                    n: 2154320.10,
                    z: 22.15,
                    attribs: {
                        CROSS_NO: "CR-01",
                        UPPER_TYPE: "Potable Water",
                        UPPER_SIZE: "8",
                        UPPER_BOT_ELEV: "21.48", // 8" water pipe: bottom = 22.15 - 0.67 = 21.48
                        LOWER_TYPE: "Gravity Sewer",
                        LOWER_SIZE: "8",
                        LOWER_TOP_ELEV: "16.47", // 8" sewer: crown = 15.80 + 0.67 = 16.47
                        // Separation: 21.48 - 16.47 = 5.01 ft = 60.1 in; water above a gravity sewer needs 6 in (§350 III.4.4)
                        CLEARANCE_INCHES: "60.1",
                        COMPLIANT: "YES"
                    }
                }
            ]
        };
    }

    // ═════════════════════════════════════════════════════════════════════
    // 3. Civil 3D DXF Generation Engine
    // ═════════════════════════════════════════════════════════════════════

    /**
     * Builds a full Civil 3D DXF string containing JEA layer tables,
     * block definitions with ATTDEF tags, LWPOLYLINE pipe runs, and
     * INSERT block occurrences with ATTRIB metadata.
     */
    function buildJeaDxf(model, options) {
        const net = model || getSampleNetwork();
        const out = [];
        const p = (code, val) => { out.push(String(code)); out.push(String(val)); };

        // HEADER SECTION
        p(0, "SECTION"); p(2, "HEADER");
        p(9, "$ACADVER"); p(1, "AC1018"); // AutoCAD 2004+ format
        p(9, "$INSUNITS"); p(70, 2);     // US Survey Feet
        p(9, "$MEASUREMENT"); p(70, 0);  // Imperial
        p(0, "ENDSEC");

        // TABLES SECTION
        p(0, "SECTION"); p(2, "TABLES");

        // VPORT Table
        p(0, "TABLE"); p(2, "VPORT"); p(70, 1);
        p(0, "VPORT"); p(2, "*ACTIVE"); p(70, 0);
        p(10, 0.0); p(20, 0.0);
        p(11, 1.0); p(21, 1.0);
        p(12, 436350.0); p(22, 2154320.0); // Duval / JEA footprint
        p(40, 500.0); p(41, 1.5);
        p(0, "ENDTAB");

        // LAYER Table
        p(0, "TABLE"); p(2, "LAYER"); p(70, LAYERS.length + 1);
        p(0, "LAYER"); p(2, "0"); p(70, 0); p(62, 7); p(6, "CONTINUOUS");
        LAYERS.forEach(l => {
            p(0, "LAYER"); p(2, l.name); p(70, 0); p(62, l.color); p(6, "CONTINUOUS");
        });
        p(0, "ENDTAB");
        p(0, "ENDSEC");

        // BLOCKS SECTION (Civil 3D utility symbols with JEA ATTDEF attributes)
        p(0, "SECTION"); p(2, "BLOCKS");
        Object.entries(BLOCK_DEFS).forEach(([blkName, tagList]) => {
            p(0, "BLOCK"); p(2, blkName); p(70, 2); // 2 = has attributes
            p(10, 0.0); p(20, 0.0); p(30, 0.0);
            p(3, blkName); p(1, "");

            // Geometry of the block symbol
            if (blkName === "JEA_VALVE") {
                p(0, "CIRCLE"); p(8, "0"); p(10, 0.0); p(20, 0.0); p(40, 2.0);
                p(0, "LINE"); p(8, "0"); p(10, -2.0); p(20, -2.0); p(11, 2.0); p(21, 2.0);
                p(0, "LINE"); p(8, "0"); p(10, -2.0); p(20, 2.0); p(11, 2.0); p(21, -2.0);
            } else if (blkName === "JEA_MANHOLE") {
                p(0, "CIRCLE"); p(8, "0"); p(10, 0.0); p(20, 0.0); p(40, 2.5);
                p(0, "CIRCLE"); p(8, "0"); p(10, 0.0); p(20, 0.0); p(40, 1.25);
            } else if (blkName === "JEA_HYDRANT") {
                p(0, "CIRCLE"); p(8, "0"); p(10, 0.0); p(20, 0.0); p(40, 1.8);
                p(0, "LINE"); p(8, "0"); p(10, 0.0); p(20, -2.5); p(11, 0.0); p(21, 2.5);
                p(0, "LINE"); p(8, "0"); p(10, -2.5); p(20, 0.0); p(11, 2.5); p(21, 0.0);
            } else if (blkName === "JEA_CROSSING") {
                p(0, "LINE"); p(8, "0"); p(10, -3.0); p(20, -3.0); p(11, 3.0); p(21, 3.0);
                p(0, "LINE"); p(8, "0"); p(10, -3.0); p(20, 3.0); p(11, 3.0); p(21, -3.0);
                p(0, "CIRCLE"); p(8, "0"); p(10, 0.0); p(20, 0.0); p(40, 3.0);
            } else {
                p(0, "CIRCLE"); p(8, "0"); p(10, 0.0); p(20, 0.0); p(40, 1.5);
            }

            // Attribute definitions
            tagList.forEach((tag, idx) => {
                p(0, "ATTDEF"); p(8, "0");
                p(10, 0.0); p(20, -idx * 2.0); p(30, 0.0);
                p(40, 1.2); p(1, ""); p(2, tag); p(3, tag);
                p(70, 1);
            });

            p(0, "ENDBLK");
        });
        p(0, "ENDSEC");

        // ENTITIES SECTION
        p(0, "SECTION"); p(2, "ENTITIES");

        // 1. Pipe Runs (LWPOLYLINE with 3D elevations and layer)
        (net.pipes || []).forEach(pipe => {
            p(0, "LWPOLYLINE");
            p(8, pipe.layer || "W-MAIN");
            p(90, pipe.points.length);
            p(70, 0);
            p(38, pipe.points[0]?.z || 0.0);

            pipe.points.forEach(pt => {
                p(10, Number(pt.e).toFixed(4));
                p(20, Number(pt.n).toFixed(4));
                if (pt.bulge) p(42, Number(pt.bulge).toFixed(8)); // arc segment to the next vertex
            });

            // Pipe label text at midpoint
            if (pipe.points.length >= 2) {
                const p1 = pipe.points[0], p2 = pipe.points[pipe.points.length - 1];
                const mx = (p1.e + p2.e) / 2, my = (p1.n + p2.n) / 2;
                p(0, "TEXT");
                p(8, pipe.layer || "W-MAIN");
                p(10, mx.toFixed(4)); p(20, (my + 2.0).toFixed(4)); p(30, 0.0);
                p(40, 2.0);
                p(1, `${pipe.diameter || '8'}" ${pipe.material || 'DIP'} ${pipe.pipeClass || ''} (${pipe.subtype || 'Pipe'})`.trim());
            }
        });

        // 2. Structures & Valves (INSERT with ATTRIB entities)
        (net.structures || []).forEach(st => {
            p(0, "INSERT");
            p(2, st.block || "JEA_VALVE");
            p(8, st.layer || "W-VALV");
            p(66, 1); // Attributes follow
            p(10, Number(st.e).toFixed(4));
            p(20, Number(st.n).toFixed(4));
            p(30, Number(st.z || 0.0).toFixed(4));
            p(41, 1.0); p(42, 1.0); p(43, 1.0);
            p(50, 0.0);

            const tags = BLOCK_DEFS[st.block] || Object.keys(st.attribs || {});
            tags.forEach(tag => {
                const val = st.attribs?.[tag] ?? "";
                p(0, "ATTRIB");
                p(8, st.layer || "0");
                p(10, Number(st.e).toFixed(4));
                p(20, Number(st.n).toFixed(4));
                p(30, Number(st.z || 0.0).toFixed(4));
                p(40, 1.2);
                p(1, String(val));
                p(2, tag);
                p(70, 0);
            });

            p(0, "SEQEND");

            // Text callout
            p(0, "TEXT");
            p(8, st.layer || "0");
            p(10, Number(st.e + 3.0).toFixed(4));
            p(20, Number(st.n + 3.0).toFixed(4));
            p(30, 0.0);
            p(40, 1.8);
            p(1, `${st.id}: ${st.attribs?.SUBTYPE || st.block} (Elev: ${st.z?.toFixed(2) || '0.00'}')`);
        });

        // 3. Pipe Crossings (INSERT with ATTRIB entities)
        (net.crossings || []).forEach(cr => {
            p(0, "INSERT");
            p(2, "JEA_CROSSING");
            p(8, cr.layer || "UTIL-CROSS");
            p(66, 1);
            p(10, Number(cr.e).toFixed(4));
            p(20, Number(cr.n).toFixed(4));
            p(30, Number(cr.z || 0.0).toFixed(4));
            p(41, 1.0); p(42, 1.0); p(43, 1.0);
            p(50, 0.0);

            const tags = BLOCK_DEFS.JEA_CROSSING;
            tags.forEach(tag => {
                const val = cr.attribs?.[tag] ?? "";
                p(0, "ATTRIB");
                p(8, cr.layer || "UTIL-CROSS");
                p(10, Number(cr.e).toFixed(4));
                p(20, Number(cr.n).toFixed(4));
                p(30, Number(cr.z || 0.0).toFixed(4));
                p(40, 1.2);
                p(1, String(val));
                p(2, tag);
                p(70, 0);
            });

            p(0, "SEQEND");

            // Crossing annotation callout
            const clrInches = cr.attribs?.CLEARANCE_INCHES;
            const req = crossingRequirement(cr.attribs?.UPPER_TYPE, cr.attribs?.LOWER_TYPE);
            const verdict = clrInches == null || clrInches === "" || !isFinite(Number(clrInches)) ? "NOT SCORED"
                : !req.applies ? "NOT CHECKED" : Number(clrInches) >= req.minInches ? `PASS >=${req.minInches}"` : `FAIL <${req.minInches}"`;
            p(0, "TEXT");
            p(8, cr.layer || "UTIL-CROSS");
            p(10, Number(cr.e + 4.0).toFixed(4));
            p(20, Number(cr.n - 4.0).toFixed(4));
            p(30, 0.0);
            p(40, 2.0);
            p(1, `X-ING ${cr.attribs?.CROSS_NO || cr.id}: ${clrInches == null || clrInches === "" ? "?" : clrInches}" SEP [${verdict}]`);
        });

        p(0, "ENDSEC");
        p(0, "EOF");

        return out.join("\r\n") + "\r\n";
    }

    // ═════════════════════════════════════════════════════════════════════
    // 4. DXF Reverse-Reader & Parser
    // ═════════════════════════════════════════════════════════════════════

    /**
     * Parses standard ASCII DXF into an object containing layers, polylines,
     * block inserts with attached attributes, text labels, and point coords.
     */
    function parseDxf(dxfString, prePairs) {
        if (typeof dxfString !== "string") return { error: "Invalid DXF input (not a string)" };
        // The shared resilient tokenizer (plugins/dxf-auditor/dxf-parser.js): it resynchronises on
        // the next group-code line, so a blank line, stray whitespace or a corrupt line can't shift
        // every later code/value pair out of phase (a fixed `i += 2` walk did exactly that).
        // prePairs: the same text already tokenized (in a worker — see tokenizeInBackground)
        const pairs = prePairs || window.FDOTDXFInspector.prototype.tokenizeDXF.call(null, dxfString);
        let inEntities = false, sectionStart = false;
        let curEntity = null;
        let curInsert = null;

        const result = {
            layers: new Set(),
            polylines: [],
            inserts: [],
            texts: [],
            points: [],
            curves: [],      // ARC / SPLINE, as vertex lists (see flushEntity)
            allEntities: []
        };
        let curHeavy = null; // an old-style POLYLINE collecting its VERTEX entities until SEQEND

        for (const [code, val] of pairs) {
            if (code === 0 && val === "SECTION") { sectionStart = true; continue; }
            if (sectionStart) {
                sectionStart = false;
                if (code === 2) { inEntities = val === "ENTITIES"; continue; }
            }

            if (code === 0 && val === "ENDSEC") {
                inEntities = false;
                if (curEntity) flushEntity(curEntity, result);
                curEntity = null;
                continue;
            }

            if (!inEntities) continue;

            if (code === 0) {
                if (curEntity) {
                    if (curEntity.type === "POLYLINE") curHeavy = curEntity; // held until its SEQEND
                    else flushEntity(curEntity, result);
                }

                if (val === "ATTRIB") {
                    curEntity = { type: "ATTRIB", attribs: {}, layer: "0" };
                } else if (val === "VERTEX" && curHeavy) {
                    curEntity = { type: "VERTEX", parent: curHeavy, layer: curHeavy.layer, attribs: {}, vertices: [] };
                } else if (val === "SEQEND") {
                    if (curHeavy) { flushEntity(curHeavy, result); curHeavy = null; }
                    curInsert = null;
                    curEntity = null;
                } else {
                    curEntity = { type: val, layer: "0", attribs: {}, vertices: [] };
                    if (val === "INSERT") curInsert = curEntity;
                    else curInsert = null;
                }
                continue;
            }

            if (!curEntity) continue;

            if (code === 8) {
                curEntity.layer = val;
                result.layers.add(val);
            } else if (code === 2) {
                if (curEntity.type === "INSERT") curEntity.blockName = val;
                else if (curEntity.type === "ATTRIB") curEntity.tag = val;
            } else if (code === 1) {
                if (curEntity.type === "TEXT") curEntity.text = val;
                else if (curEntity.type === "ATTRIB") curEntity.val = val;
            } else if (curEntity.type === "SPLINE" && (code === 10 || code === 20 || code === 11 || code === 21)) {
                // 10/20 = control points, 11/21 = fit points (both repeat)
                const list = code === 10 || code === 20 ? (curEntity.ctrl = curEntity.ctrl || []) : (curEntity.fit = curEntity.fit || []);
                if (code === 10 || code === 11) list.push({ e: parseFloat(val), n: 0 });
                else if (list.length) list[list.length - 1].n = parseFloat(val);
            } else if (code === 10) {
                const x = parseFloat(val);
                if (curEntity.type === "LWPOLYLINE") {
                    curEntity.vertices.push({ e: x, n: 0 });
                } else {
                    curEntity.e = x;
                }
            } else if (code === 20) {
                const y = parseFloat(val);
                if (curEntity.type === "LWPOLYLINE" && curEntity.vertices.length) {
                    curEntity.vertices[curEntity.vertices.length - 1].n = y;
                } else {
                    curEntity.n = y;
                }
            } else if (code === 42 && (curEntity.type === "LWPOLYLINE" || curEntity.type === "VERTEX")) {
                const b = parseFloat(val);
                const tgt = curEntity.type === "LWPOLYLINE" ? curEntity.vertices[curEntity.vertices.length - 1] : curEntity;
                if (tgt && isFinite(b) && b !== 0) tgt.bulge = b;
            } else if (code === 70 && (curEntity.type === "LWPOLYLINE" || curEntity.type === "POLYLINE" || curEntity.type === "VERTEX")) {
                curEntity.flags = parseInt(val, 10) || 0;
            } else if (code === 40 && curEntity.type === "ARC") {
                curEntity.radius = parseFloat(val);
            } else if (code === 50 && curEntity.type === "ARC") {
                curEntity.startAngle = parseFloat(val);
            } else if (code === 51 && curEntity.type === "ARC") {
                curEntity.endAngle = parseFloat(val);
            } else if (code === 31 && curEntity.type === "LINE") {
                curEntity.z2 = parseFloat(val);
            } else if (code === 30) {
                curEntity.z = parseFloat(val);
            } else if (code === 38) {
                curEntity.elevation = parseFloat(val);
            } else if (code === 67) {
                curEntity.paper = String(val).trim() === "1";
            } else if (code === 5) {
                curEntity.handle = String(val).trim();
            } else if (code === 11 && curEntity.type === "LINE") {
                curEntity.e2 = parseFloat(val);
            } else if (code === 21 && curEntity.type === "LINE") {
                curEntity.n2 = parseFloat(val);
            }
        }

        if (curEntity && curEntity.type !== "POLYLINE") flushEntity(curEntity, result);
        if (curHeavy) flushEntity(curHeavy, result); // a POLYLINE missing its SEQEND still counts
        result.layers = Array.from(result.layers);
        return result;
    }

    // Points along an ARC (degrees, counter-clockwise from startAngle to endAngle), at most 5° apart.
    function arcVertices(a) {
        let sweep = ((a.endAngle - a.startAngle) % 360 + 360) % 360;
        if (sweep === 0) sweep = 360;
        const steps = Math.max(2, Math.ceil(sweep / 5));
        const out = [];
        for (let i = 0; i <= steps; i++) {
            const t = (a.startAngle + sweep * i / steps) * Math.PI / 180;
            out.push({ e: a.e + a.radius * Math.cos(t), n: a.n + a.radius * Math.sin(t), z: a.z });
        }
        return out;
    }

    function flushEntity(ent, res) {
        // A VERTEX belongs to the old-style POLYLINE above it; it is not an entity of its own.
        if (ent.type === "VERTEX") {
            const pl = ent.parent;
            // flag 16 = spline frame control point (not on the curve); 128 + no 64 = polyface face record
            if (pl && !((ent.flags || 0) & 16) && !(((ent.flags || 0) & 128) && !((ent.flags || 0) & 64)) && isFinite(ent.e) && isFinite(ent.n)) {
                const v = { e: ent.e, n: ent.n };
                if (isFinite(ent.z)) v.z = ent.z;
                if (ent.bulge) v.bulge = ent.bulge;
                pl.vertices.push(v);
            }
            return;
        }
        // Paper-space entities (group code 67 = 1: title blocks, viewports, sheet notes) sit at local
        // sheet coordinates, not state-plane ones — auditing them as model space made every sheet
        // look "outside the Florida East bounds". They're counted, not audited.
        if (ent.paper) {
            res.paperSpaceSkipped = (res.paperSpaceSkipped || 0) + 1;
            const ps = res.paperSpace || (res.paperSpace = { count: 0, byLayer: {}, byType: {}, jeaBlocks: [] });
            ps.count++;
            ps.byLayer[ent.layer] = (ps.byLayer[ent.layer] || 0) + 1;
            ps.byType[ent.type] = (ps.byType[ent.type] || 0) + 1;
            if (ent.type === "INSERT" && ent.blockName && BLOCK_DEFS[ent.blockName]) {
                ps.jeaBlocks.push({ blockName: ent.blockName, layer: ent.layer, handle: ent.handle || null, e: ent.e, n: ent.n });
            }
            return;
        }
        res.allEntities.push(ent);
        if (ent.type === "POLYLINE") {
            // 16 = polygon mesh, 64 = polyface mesh: surfaces, not linework.
            if ((ent.flags || 0) & (16 | 64)) { res.meshesSkipped = (res.meshesSkipped || 0) + 1; return; }
            // A 2D POLYLINE's elevation is the Z of its (otherwise dummy) header point.
            if (!((ent.flags || 0) & 8) && isFinite(ent.z)) ent.elevation = ent.z;
            delete ent.e; delete ent.n;
            res.polylines.push(ent);
        } else if (ent.type === "ARC") {
            if ([ent.e, ent.n, ent.radius, ent.startAngle, ent.endAngle].every(isFinite) && ent.radius > 0) {
                ent.vertices = arcVertices(ent);
                res.curves.push(ent);
            }
        } else if (ent.type === "SPLINE") {
            const pts = (ent.fit && ent.fit.length >= 2) ? ent.fit : (ent.ctrl || []);
            if (pts.length >= 2) {
                ent.vertices = pts.map(v => ({ e: v.e, n: v.n }));
                ent.approximate = !(ent.fit && ent.fit.length >= 2); // control points are off the curve
                res.curves.push(ent);
            }
        } else if (ent.type === "LWPOLYLINE") {
            res.polylines.push(ent);
        } else if (ent.type === "INSERT") {
            res.inserts.push(ent);
        } else if (ent.type === "TEXT") {
            res.texts.push(ent);
        } else if (ent.type === "ATTRIB") {
            const lastIns = res.inserts[res.inserts.length - 1];
            if (lastIns) {
                lastIns.attribs = lastIns.attribs || {};
                if (ent.tag) lastIns.attribs[ent.tag] = ent.val || "";
            }
        } else if (ent.type === "POINT" || ent.type === "CIRCLE") {
            res.points.push(ent);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // 5. JEA 2024 Audit Engine & Validation Logic
    // ═════════════════════════════════════════════════════════════════════

    /**
     * Pulls the pipe linework out of a drawing that has no JEA schema (plain polylines and lines on
     * recognised as-built layers — see LAYER_ALIASES) into the Jea24 model, so it can be audited,
     * rebuilt on JEA layers, or sent to the Linework Editor. Only geometry is carried over: size,
     * material and class are NOT in the linework, so they are left unset rather than guessed.
     * Arcs inside polylines (bulges) are kept exactly; standalone ARCs are densified (≤5°) and
     * SPLINEs follow their fit points (control points when there are none — flagged approximate).
     * Elevation comes from a polyline's elevation, a 3D polyline's vertices or a LINE's end Z.
     * An elevation of exactly 0 is read as "not set" (Civil 3D's default), never as a real Z.
     * @returns {{ model, stats: { pipes, vertices, byLayer, ignored, withZ, zeroZ, curved, approximate } }}
     */
    function extractPipeNetwork(dxfOrParsed) {
        const parsed = typeof dxfOrParsed === "string" ? parseDxf(dxfOrParsed) : dxfOrParsed;
        if (parsed.error) return { error: parsed.error };
        const pipes = [], byLayer = {};
        let vertices = 0, ignored = 0, pNo = 1, withZ = 0, zeroZ = 0, curved = 0, approximate = 0;
        const zOf = (v, ent) => {
            const z = isFinite(v.z) ? v.z : (isFinite(ent.elevation) ? ent.elevation : null);
            if (z === 0) { zeroZ++; return null; }
            return z;
        };
        const add = (ent, pts) => {
            const res = resolveLayer(ent.layer);
            // Only linework layers; valve / fitting / manhole layers hold symbols, not runs.
            if (!res || !/-(MAIN|GRAV|FM)$/.test(res.layer)) { ignored++; return; }
            const n = (byLayer[ent.layer] = (byLayer[ent.layer] || 0) + 1);
            pipes.push({
                id: `${ent.layer}-${n}`,
                layer: res.layer,
                system: res.system,
                sourceLayer: ent.layer,
                handle: ent.handle || null,
                mapping: res.how,
                points: pts.map(pt => {
                    const o = { p: pNo++, e: pt.e, n: pt.n };
                    const z = zOf(pt, ent);
                    if (z != null) { o.z = z; withZ++; }
                    if (pt.bulge) o.bulge = pt.bulge;
                    return o;
                }),
                ...(ent.type === "ARC" || ent.type === "SPLINE" || pts.some(v => v.bulge) ? { curved: true } : {}),
                ...(ent.approximate ? { approximate: true } : {})
            });
            if (pipes[pipes.length - 1].curved) curved++;
            if (ent.approximate) approximate++;
            vertices += pts.length;
        };
        (parsed.polylines || []).concat(parsed.curves || []).forEach(pl => {
            const pts = (pl.vertices || []).filter(v => isFinite(v.e) && isFinite(v.n));
            // a closed polyline returns to its first vertex
            if (pts.length >= 2 && ((pl.flags || 0) & 1) && pl.type !== "ARC") pts.push(Object.assign({}, pts[0], { bulge: undefined }));
            if (pts.length >= 2) add(pl, pts);
        });
        (parsed.allEntities || []).forEach(en => {
            if (en.type === "LINE" && [en.e, en.n, en.e2, en.n2].every(isFinite)) {
                add(en, [{ e: en.e, n: en.n, z: en.z }, { e: en.e2, n: en.n2, z: en.z2 }]);
            }
        });
        return {
            model: { projectName: "Extracted pipe network", pipes, structures: [], crossings: [] },
            stats: { pipes: pipes.length, vertices, byLayer, ignored, withZ, zeroZ, curved, approximate }
        };
    }

    /**
     * Comprehensive QA/QC audit of a Civil 3D drawing or parsed model
     * against JEA As-Built 2024 standards:
     *   1. Bounding box & Florida State Plane East geodetic coordinates
     *   2. Picklist domains (21 of the 45 defined domains are checked below — Water block types;
     *      Sewer/Reclaimed/Chilled Water domains are defined in DOMAINS but not yet wired in here)
     *   3. Layer naming & block schema conventions
     *   4. Mandatory attribute presence
     *   5. Pipe crossing vertical separation by pipe type (JEA Standards 2026 §350 III.4.4–III.4.5)
     */
    function auditDrawing(dxfOrModel, options = {}) {
        const parsed = (typeof dxfOrModel === "string") ? parseDxf(dxfOrModel, options.pairs) : dxfOrModel;
        if (parsed.error) return { error: parsed.error, score: null, scored: false, compliant: false };

        const issues = [];
        let totalItems = 0;
        let passItems = 0;
        let schemaItems = 0; // things the JEA schema actually applies to: JEA_* blocks and pipes on JEA layers

        const bounds = options.bounds || BOUNDS;
        const checkBounds = options.checkBounds !== false;

        function logIssue(severity, rule, message, entity = "General", layer = "", e = null, n = null) {
            issues.push({
                severity,
                rule,
                message,
                entity,
                layer,
                easting: e,
                northing: n
            });
        }

        function validateDomain(domainKey, val, entityDesc, fieldName, layer = "", e = null, n = null) {
            if (!val) return true;
            const list = DOMAINS[domainKey];
            if (!list || !list.length) return true;

            const vClean = String(val).trim().toLowerCase();
            const matched = list.some(item => String(item).trim().toLowerCase() === vClean);
            if (!matched) {
                logIssue("error", `Domain: ${domainKey}`,
                    `Invalid ${fieldName} "${val}". Expected one of: ${list.slice(0, 6).join(", ")}${list.length > 6 ? '...' : ''}`,
                    entityDesc, layer, e, n);
                return false;
            }
            return true;
        }

        // 1. Audit Pipe Polyline Runs. Findings are rolled up (one per polyline for coordinates, one
        // per layer for naming) — a real drawing has thousands of vertices and polylines, and one
        // issue each buried everything that mattered.
        const badLayers = new Map(), mappedLayers = new Map();
        let anonSkipped = 0;
        const where = (what, ent) => ent.handle ? `${what} [handle ${ent.handle}]` : what;
        // Polylines (LWPOLYLINE + old-style POLYLINE) everywhere; ARC / SPLINE only on JEA or mapped
        // layers — elsewhere they're mostly annotation and would only add noise.
        const curvesChecked = (parsed.curves || []).filter(c => resolveLayer(c.layer));
        (parsed.polylines || []).concat(curvesChecked).forEach((pl, idx) => {
            totalItems++;
            const res = resolveLayer(pl.layer);
            // Only a layer the template actually defines counts toward scoring; a name matched by
            // inference is reported, and its linework still gets the geometry checks, but it can't
            // earn a pass on its own.
            if (res && (res.how === "standard" || res.how === "confirmed")) schemaItems++;
            const pName = where(`Polyline #${idx + 1} (${pl.layer})`, pl);

            if (!res) badLayers.set(pl.layer, (badLayers.get(pl.layer) || 0) + 1);
            else if (res.how === "inferred") {
                const m = mappedLayers.get(pl.layer) || { count: 0, to: res.layer };
                m.count++; mappedLayers.set(pl.layer, m);
            }

            if (!pl.vertices || pl.vertices.length < 2) {
                logIssue("error", "Linework Geometry", "Pipe polyline has fewer than 2 vertices", pName, pl.layer);
            } else if (checkBounds) {
                let outside = 0, first = null, gpsBad = 0, gpsFirst = null;
                const toGeo = window.COGO && window.COGO.statePlaneToLatLon;
                pl.vertices.forEach(v => {
                    if (v.e == null || v.n == null) return;
                    if (v.e < bounds.eastingMin || v.e > bounds.eastingMax ||
                        v.n < bounds.northingMin || v.n > bounds.northingMax) {
                        outside++; if (!first) first = v;
                    } else if (toGeo) {
                        // COGO.statePlaneToLatLon(northing, easting, zoneKey, unit) → {latDeg, lonDeg}
                        const geo = toGeo(v.n, v.e, "FL_EAST", "sft");
                        if (geo.latDeg < bounds.latMin || geo.latDeg > bounds.latMax ||
                            geo.lonDeg < bounds.lonMin || geo.lonDeg > bounds.lonMax) {
                            gpsBad++; if (!gpsFirst) gpsFirst = { v, geo };
                        }
                    }
                });
                if (outside) {
                    logIssue("error", "SPCS83 East Bounds",
                        `${outside} of ${pl.vertices.length} vertices are outside JEA Duval/St. Johns/Clay East Plane bounds (${bounds.eastingMin} - ${bounds.eastingMax}); first at E: ${first.e.toFixed(1)}, N: ${first.n.toFixed(1)}`,
                        pName, pl.layer, first.e, first.n);
                }
                if (gpsBad) {
                    logIssue("error", "Natural GPS Bounds",
                        `${gpsBad} vertices compute to a ground GPS position out of the JEA geographic envelope; first (${gpsFirst.geo.latDeg.toFixed(5)}° N, ${gpsFirst.geo.lonDeg.toFixed(5)}° W)`,
                        pName, pl.layer, gpsFirst.v.e, gpsFirst.v.n);
                }
            }
        });
        mappedLayers.forEach((m, layer) => {
            logIssue("info", "Layer Mapping (inferred)",
                `${m.count} polyline(s) on "${layer}" were treated as ${m.to}. The mapping is inferred from the layer name (JEA's 2026 standards don't name layers) — confirm it for your drawings in Settings.`,
                `Layer ${layer}`, layer);
        });
        badLayers.forEach((count, layer) => {
            // JEA's standards (2026 Section 501 and the As-Built Checklist) set no CAD layer names, so this
            // is a note against this tool's template layers, not a JEA finding, and it costs no points.
            logIssue("info", "Layer Standards", `${count} polyline(s) on "${layer}", which is not one of this tool's template layers (JEA's 2026 standards don't specify layer names).`, `Layer ${layer}`, layer);
        });

        // 2. Audit Block Inserts & Attributes
        (parsed.inserts || []).forEach((ins, idx) => {
            // Anonymous blocks ("*U12", "*D3"…) are AutoCAD's own wrappers for dimensions, leaders and
            // annotation; they sit at 0,0 with the geometry inside the block, so they carry no JEA data
            // and no meaningful position.
            if (ins.blockName && ins.blockName.charAt(0) === "*") { anonSkipped++; return; }
            totalItems++;
            const blk = ins.blockName || "UNKNOWN_BLOCK";
            if (BLOCK_DEFS[blk]) schemaItems++;
            const bDesc = where(`${blk} #${idx + 1}`, ins);
            const attr = ins.attribs || {};

            if (checkBounds && ins.e != null && ins.n != null) {
                if (ins.e < bounds.eastingMin || ins.e > bounds.eastingMax ||
                    ins.n < bounds.northingMin || ins.n > bounds.northingMax) {
                    logIssue("error", "SPCS83 East Bounds",
                        `Block origin (E: ${ins.e.toFixed(1)}, N: ${ins.n.toFixed(1)}) is outside JEA service territory bounds`,
                        bDesc, ins.layer, ins.e, ins.n);
                }
            }

            if (blk === "JEA_VALVE") {
                if (!attr.SUBTYPE) logIssue("error", "Mandatory Field", "Valve missing required SUBTYPE attribute", bDesc, ins.layer, ins.e, ins.n);
                if (!attr.SIZE) logIssue("error", "Mandatory Field", "Valve missing required SIZE attribute", bDesc, ins.layer, ins.e, ins.n);
                if (!attr.ELEVATION && ins.z == null) logIssue("error", "Mandatory Field", "Valve missing required ELEVATION attribute", bDesc, ins.layer, ins.e, ins.n);

                if (attr.SUBTYPE) validateDomain("Subtype Water Valve", attr.SUBTYPE, bDesc, "SUBTYPE", ins.layer, ins.e, ins.n);
                if (attr.VALVE_TYPE) validateDomain("Valve Type", attr.VALVE_TYPE, bDesc, "VALVE_TYPE", ins.layer, ins.e, ins.n);
                if (attr.SIZE) validateDomain("Size Inches", attr.SIZE, bDesc, "SIZE", ins.layer, ins.e, ins.n);
                if (attr.MATERIAL) validateDomain("Pipe and Fitting Material", attr.MATERIAL, bDesc, "MATERIAL", ins.layer, ins.e, ins.n);
                if (attr.MANUFACTURER) validateDomain("Valve Manufacturer", attr.MANUFACTURER, bDesc, "MANUFACTURER", ins.layer, ins.e, ins.n);
                if (attr.OPEN_DIR) validateDomain("Valve Open Direction", attr.OPEN_DIR, bDesc, "OPEN_DIR", ins.layer, ins.e, ins.n);
            } else if (blk === "JEA_MANHOLE") {
                if (!attr.SUBTYPE) logIssue("error", "Mandatory Field", "Manhole missing required SUBTYPE attribute", bDesc, ins.layer, ins.e, ins.n);
                if (!attr.RIM_ELEV) logIssue("error", "Mandatory Field", "Manhole missing required RIM_ELEV attribute", bDesc, ins.layer, ins.e, ins.n);
                if (!attr.INVERT_OUT) logIssue("error", "Mandatory Field", "Manhole missing required INVERT_OUT attribute", bDesc, ins.layer, ins.e, ins.n);

                if (attr.SUBTYPE) validateDomain("Subtype Manhole", attr.SUBTYPE, bDesc, "SUBTYPE", ins.layer, ins.e, ins.n);
                if (attr.MANHOLE_TYPE) validateDomain("Manhole Type", attr.MANHOLE_TYPE, bDesc, "MANHOLE_TYPE", ins.layer, ins.e, ins.n);
                if (attr.MATERIAL) validateDomain("Manhole Material", attr.MATERIAL, bDesc, "MATERIAL", ins.layer, ins.e, ins.n);
                if (attr.MANUFACTURER) validateDomain("Manhole Manufacturer", attr.MANUFACTURER, bDesc, "MANUFACTURER", ins.layer, ins.e, ins.n);
                if (attr.LINING) validateDomain("Manhole Lining Material", attr.LINING, bDesc, "LINING", ins.layer, ins.e, ins.n);
                if (attr.DIAMETER) validateDomain("Size Feet", attr.DIAMETER, bDesc, "DIAMETER", ins.layer, ins.e, ins.n);
            } else if (blk === "JEA_HYDRANT") {
                if (!attr.SUBTYPE) logIssue("error", "Mandatory Field", "Hydrant missing required SUBTYPE attribute", bDesc, ins.layer, ins.e, ins.n);
                if (attr.MODEL) validateDomain("Hydrant Model", attr.MODEL, bDesc, "MODEL", ins.layer, ins.e, ins.n);
                if (attr.MANUFACTURER) validateDomain("Valve Manufacturer", attr.MANUFACTURER, bDesc, "MANUFACTURER", ins.layer, ins.e, ins.n);
                if (attr.VALVE_SIZE) validateDomain("Size Inches", attr.VALVE_SIZE, bDesc, "VALVE_SIZE", ins.layer, ins.e, ins.n);
            } else if (blk === "JEA_FITTING") {
                if (!attr.SUBTYPE) logIssue("error", "Mandatory Field", "Fitting missing required SUBTYPE attribute", bDesc, ins.layer, ins.e, ins.n);
                if (attr.SUBTYPE) validateDomain("Subtype Water Fitting", attr.SUBTYPE, bDesc, "SUBTYPE", ins.layer, ins.e, ins.n);
                if (attr.SIZE) validateDomain("Size Inches", attr.SIZE, bDesc, "SIZE", ins.layer, ins.e, ins.n);
                if (attr.MATERIAL) validateDomain("Pipe and Fitting Material", attr.MATERIAL, bDesc, "MATERIAL", ins.layer, ins.e, ins.n);
                if (attr.MANUFACTURER) validateDomain("Fitting Manufacturers", attr.MANUFACTURER, bDesc, "MANUFACTURER", ins.layer, ins.e, ins.n);
            } else if (blk === "JEA_METER") {
                if (attr.SUBTYPE) validateDomain("Subtype Water Meter", attr.SUBTYPE, bDesc, "SUBTYPE", ins.layer, ins.e, ins.n);
                if (attr.SIZE) validateDomain("Meter Size Inches", attr.SIZE, bDesc, "SIZE", ins.layer, ins.e, ins.n);
                if (attr.BOX_MFR) validateDomain("Meter Box Manufacturer", attr.BOX_MFR, bDesc, "BOX_MFR", ins.layer, ins.e, ins.n);
                if (attr.BOX_MAT) validateDomain("Meter Box Material", attr.BOX_MAT, bDesc, "BOX_MAT", ins.layer, ins.e, ins.n);
            } else if (blk === "JEA_LOCATE_BOX") {
                if (attr.SUBTYPE) validateDomain("Subtype Locate Box", attr.SUBTYPE, bDesc, "SUBTYPE", ins.layer, ins.e, ins.n);
            } else if (blk === "JEA_CROSSING") {
                // Pipe crossing separation, by pipe type (JEA Standards 2026 §350 III.4.4–III.4.5)
                const cNo = attr.CROSS_NO || `CR-${idx + 1}`;
                const cDesc = `Pipe Crossing ${cNo}`;

                if (attr.UPPER_TYPE) validateDomain("Crossing Pipe Type", attr.UPPER_TYPE, cDesc, "UPPER_TYPE", ins.layer, ins.e, ins.n);
                if (attr.LOWER_TYPE) validateDomain("Crossing Pipe Type", attr.LOWER_TYPE, cDesc, "LOWER_TYPE", ins.layer, ins.e, ins.n);
                if (attr.UPPER_SIZE) validateDomain("Size Inches", attr.UPPER_SIZE, cDesc, "UPPER_SIZE", ins.layer, ins.e, ins.n);
                if (attr.LOWER_SIZE) validateDomain("Size Inches", attr.LOWER_SIZE, cDesc, "LOWER_SIZE", ins.layer, ins.e, ins.n);

                // The separation is computed from the elevations when both are there; the stated
                // CLEARANCE_INCHES (or SEPARATION_FT) is the fallback.
                let clearanceInches = null;
                const uBot = parseFloat(attr.UPPER_BOT_ELEV), lTop = parseFloat(attr.LOWER_TOP_ELEV);
                if (isFinite(uBot) && isFinite(lTop)) clearanceInches = (uBot - lTop) * 12.0;
                else if (attr.CLEARANCE_INCHES && isFinite(parseFloat(attr.CLEARANCE_INCHES))) clearanceInches = parseFloat(attr.CLEARANCE_INCHES);
                else if (attr.SEPARATION_FT && isFinite(parseFloat(attr.SEPARATION_FT))) clearanceInches = parseFloat(attr.SEPARATION_FT) * 12.0;

                const req = crossingRequirement(attr.UPPER_TYPE, attr.LOWER_TYPE);
                if (clearanceInches == null) {
                    logIssue("error", "Crossing Separation", "Cannot determine the crossing's vertical separation (no pipe elevations or separation given)", cDesc, ins.layer, ins.e, ins.n);
                } else if (!req.applies) {
                    logIssue("info", "Crossing Separation (not checked)", `${clearanceInches.toFixed(1)}" separation; not checked — ${req.reason} (${req.source}).`, cDesc, ins.layer, ins.e, ins.n);
                } else if (clearanceInches < req.minInches - 1e-9) {
                    logIssue("error", "JEA Crossing Separation",
                        `${clearanceInches.toFixed(1)}" separation with the water main ${req.waterAbove ? "above" : "below"} the ${req.waterAbove ? attr.LOWER_TYPE : attr.UPPER_TYPE}: at least ${req.minInches}" is required (${req.source}, ${req.rule}); short by ${(req.minInches - clearanceInches).toFixed(1)}".`,
                        cDesc, ins.layer, ins.e, ins.n);
                } else {
                    passItems++;
                    if (req.preferredInches && clearanceInches < req.preferredInches) {
                        logIssue("info", "Crossing Separation (below preferred)", `${clearanceInches.toFixed(1)}" meets the ${req.minInches}" minimum; ${req.preferredInches}" is preferred (${req.source}, ${req.rule}).`, cDesc, ins.layer, ins.e, ins.n);
                    }
                }
            }
        });

        // 3. What was NOT checked. Paper space (title blocks, viewports, sheet notes) and AutoCAD's
        // anonymous blocks are skipped above; list them so nothing drops out silently.
        const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n)
            .map(([k, v]) => `${k} ×${v}`).join(", ") + (Object.keys(obj).length > n ? `, … (${Object.keys(obj).length - n} more)` : "");
        const ps = parsed.paperSpace;
        if (ps && ps.count) {
            logIssue("info", "Not checked: paper space",
                `${ps.count} paper-space entit${ps.count === 1 ? "y was" : "ies were"} not checked (sheet layouts sit at sheet coordinates, not state plane). By layer: ${top(ps.byLayer, 8)}. By type: ${top(ps.byType, 6)}.`,
                "Paper space");
            ps.jeaBlocks.forEach(b => {
                logIssue("warning", "JEA block in paper space",
                    `${b.blockName} is in a paper-space layout, so it was not checked. JEA blocks belong in model space at their state-plane position.`,
                    b.handle ? `${b.blockName} [handle ${b.handle}]` : b.blockName, b.layer);
            });
        }
        if (anonSkipped) {
            logIssue("info", "Not checked: anonymous blocks",
                `${anonSkipped} anonymous block insert(s) (*U…: AutoCAD's own wrappers for dimensions, leaders and annotation) were not checked.`,
                "Anonymous blocks");
        }

        const errorCount = issues.filter(i => i.severity === "error").length;
        const warnCount = issues.filter(i => i.severity === "warning").length;
        // A score or a COMPLIANT verdict means something was measured. A drawing with no JEA blocks
        // and no pipes on JEA layers has nothing for the standard to say yes to — report "not scored"
        // rather than a number (or a pass) computed from nothing.
        const scored = schemaItems > 0;
        const score = scored ? Math.max(0, 100 - (errorCount * 10 + warnCount * 2)) : null;
        const compliant = scored && errorCount === 0;

        return {
            timestamp: new Date().toISOString(),
            rules: rulesApplied(),
            compliant,
            score,
            scored,
            notScoredReason: scored ? null : (totalItems === 0
                ? "The drawing has no pipe polylines or block inserts to audit."
                : "No JEA_* blocks and no pipes on JEA template layers (W-MAIN, SS-GRAV…) were found, so there is nothing to score against the 2024 standard." +
                  (mappedLayers.size ? " Some layers matched as-built names by inference only; that is not enough to score." : "")),
            scope: "Checked: layer names, SPCS83 East / geographic bounds, picklist domains and mandatory attributes on JEA_* blocks, and pipe-crossing separation (JEA §350 III.4.4–III.4.5, where a water main is in the crossing). NOT checked: pipe size, material and class (not carried by polylines), anything on a layer or block this tool does not define, paper-space layouts and anonymous (*U) blocks — those are listed as 'Not checked' findings.",
            summary: {
                schemaItems,
                totalEntities: (parsed.allEntities || []).length,
                polylinesCount: (parsed.polylines || []).length,
                insertsCount: (parsed.inserts || []).length,
                mappedLayers: mappedLayers.size,
                curvesChecked: curvesChecked.length,
                paperSpaceSkipped: ps ? ps.count : 0,
                paperSpace: ps || { count: 0, byLayer: {}, byType: {}, jeaBlocks: [] },
                anonymousBlocksSkipped: anonSkipped,
                errorCount,
                warnCount,
                passItems
            },
            issues,
            model: parsed
        };
    }

    // ═════════════════════════════════════════════════════════════════════
    // 6. JEA As-Built Spreadsheet Tables Generator
    // ═════════════════════════════════════════════════════════════════════

    /**
     * Generates CSV strings matching the official JEA As-Built 2024 sheets:
     *  - Pipe Crossing Table
     *  - Water Valve Table
     *  - Manhole Table
     */
    function generateJeaTables(model) {
        const net = model || getSampleNetwork();
        const tables = {};

        // 1. Pipe Crossing Table
        const crossRows = [
            ["Crossing Number", "Upper Pipe Type", "Upper Pipe Size (Inches)", "Upper Pipe Bottom Elevation (Feet)", "Lower Pipe Type", "Lower Pipe Size (Inches)", "Lower Pipe Top Elevation (Feet)", "Separation (Inches)", "Meets JEA §350 Separation"]
        ];
        (net.crossings || []).forEach(cr => {
            const a = cr.attribs || {};
            crossRows.push([
                a.CROSS_NO || cr.id,
                a.UPPER_TYPE || "",
                a.UPPER_SIZE || "",
                a.UPPER_BOT_ELEV || "",
                a.LOWER_TYPE || "",
                a.LOWER_SIZE || "",
                a.LOWER_TOP_ELEV || "",
                a.CLEARANCE_INCHES || "",
                (() => {
                    const req = crossingRequirement(a.UPPER_TYPE, a.LOWER_TYPE), clr = parseFloat(a.CLEARANCE_INCHES);
                    if (!isFinite(clr)) return "NOT SCORED";
                    if (!req.applies) return "NOT CHECKED";
                    return clr >= req.minInches ? `YES (min ${req.minInches} in)` : `NO (min ${req.minInches} in)`;
                })()
            ]);
        });
        tables["Pipe Crossing Table"] = crossRows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");

        // 2. Water Valve Table
        const valveRows = [
            ["Valve Number", "Subtype", "Valve Type", "Size (Inches)", "Material", "Manufacturer", "Open Direction", "Status", "Easting", "Northing", "Elevation"]
        ];
        (net.structures || []).filter(s => s.block === "JEA_VALVE").forEach(v => {
            const a = v.attribs || {};
            valveRows.push([
                v.id,
                a.SUBTYPE || "Valve",
                a.VALVE_TYPE || "Gate",
                a.SIZE || "",
                a.MATERIAL || "",
                a.MANUFACTURER || "",
                a.OPEN_DIR || "",
                a.STATUS || "",
                v.e.toFixed(2),
                v.n.toFixed(2),
                (v.z != null ? v.z.toFixed(2) : (a.ELEVATION || ""))
            ]);
        });
        tables["Water Valve"] = valveRows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");

        // 3. Manhole Table
        const mhRows = [
            ["Manhole ID", "Subtype", "Manhole Type", "Rim Elevation", "Invert In", "Invert Out", "Depth (Feet)", "Diameter (Feet)", "Material", "Manufacturer", "Lining Material", "Easting", "Northing"]
        ];
        (net.structures || []).filter(s => s.block === "JEA_MANHOLE").forEach(m => {
            const a = m.attribs || {};
            mhRows.push([
                m.id,
                a.SUBTYPE || "Collection",
                a.MANHOLE_TYPE || "A",
                a.RIM_ELEV || "",
                a.INVERT_IN || "",
                a.INVERT_OUT || "",
                a.DEPTH || "",
                a.DIAMETER || "",
                a.MATERIAL || "",
                a.MANUFACTURER || "",
                a.LINING || "",
                m.e.toFixed(2),
                m.n.toFixed(2)
            ]);
        });
        tables["Manhole"] = mhRows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");

        return tables;
    }

    // ═════════════════════════════════════════════════════════════════════
    // 7. PostgreSQL Database Synchronization
    // ═════════════════════════════════════════════════════════════════════

    /**
     * Pushes the JEA 2024 template to PostgreSQL (client_templates) via the shared db-sync
     * bridge — window.DatabaseService.syncToDatabase() (plugins/db-sync/db-sync.js), the same
     * push path the Admin Dashboard's "Sync to DB" button uses, given an explicit override
     * payload instead of the whole-workspace one generateCloudSyncPayload() builds. There is no
     * window.DatabaseService.saveClientTemplate() and no /api/client_templates route — earlier
     * versions of this function called both and always fell through to a "local fallback" that,
     * in fact, never wrote anywhere.
     */
    async function syncTemplateWithDb() {
        const tenantId = (window.BoundaryQCCMS?.getCurrentUser?.() || {}).orgId || "org_kh_01";

        if (!window.DatabaseService) {
            return { success: false, note: "PostgreSQL bridge (db-sync) is not loaded.", settings: CLIENT_TEMPLATE.settings };
        }
        try {
            const res = await window.DatabaseService.syncToDatabase({
                tenantId,
                tables: {
                    client_templates: [{
                        id: CLIENT_TEMPLATE.id,
                        // No userId: this is a firm-wide reference template, not tied to one
                        // person's account, and an unrecognized id would fail the users(id) FK.
                        clientName: CLIENT_TEMPLATE.clientName,
                        label: CLIENT_TEMPLATE.label,
                        settings: CLIENT_TEMPLATE.settings
                    }]
                }
            });
            return { success: true, mode: "PostgreSQL", record: res };
        } catch (e) {
            return { success: false, note: e.message || "Database sync failed.", settings: CLIENT_TEMPLATE.settings };
        }
    }

    /**
     * Adds (or refreshes) "JEA As-Built Standards 2024" in the signed-in user's local Client
     * Master Templates (window.BoundaryQCCMS — plugins/cms-engine/cms-engine.js), through its
     * real createTemplate()/updateTemplate() API. This engine is domain-agnostic on purpose (see
     * cms-engine.js's initStorageDefaults() comment) — this plugin owns creating its own default
     * template on request, rather than it being pre-seeded for every user whether they use this
     * plugin or not. Idempotent: a second call updates the existing copy instead of duplicating it.
     */
    function addAsClientTemplate() {
        const cms = window.BoundaryQCCMS;
        if (!cms || !cms.isAuthenticated()) {
            return { success: false, note: "Sign in first to add a Client Master Template." };
        }
        const existing = cms.getTemplates().find(t => t.clientName === CLIENT_TEMPLATE.clientName && t.label === CLIENT_TEMPLATE.label);
        try {
            if (existing) {
                const tpl = cms.updateTemplate(existing.id, { settings: CLIENT_TEMPLATE.settings });
                return { success: true, mode: "updated", template: tpl };
            }
            const tpl = cms.createTemplate(CLIENT_TEMPLATE.clientName, CLIENT_TEMPLATE.label, CLIENT_TEMPLATE.settings);
            return { success: true, mode: "created", template: tpl };
        } catch (e) {
            // e.g. TEMPLATE_LIMIT — surface the real message (upsell copy included) rather than
            // swallowing it, same as the Dashboard's own "New Template" button does.
            return { success: false, note: e.message };
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // 8. User Interface Rendering & Controller
    // ═════════════════════════════════════════════════════════════════════

    let _lastAuditReport = null;
    let _activeSubTab = "gen";

    // Last model brought in from a workbook or extracted from a drawing; the Drawing Builder shows it
    // instead of the demo network until the page is reloaded.
    let _modelOverride = null;

    function renderUI(ctx) {
        const root = document.getElementById("tab-jea24");
        if (!root) return;

        window.setSafeHTML(root, `
          <div class="glass-panel" style="padding:1.5rem;">
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem; margin-bottom:1rem; border-bottom:1px solid var(--border-subtle); padding-bottom:0.75rem;">
              <div>
                <h2 style="margin:0; display:flex; align-items:center; gap:0.5rem;">
                  <i class="fa-solid fa-faucet-drip" style="color:var(--primary);"></i>
                  JEA As-Built Standards 2026
                </h2>
                <p class="subtitle" style="margin:0.25rem 0 0 0;">Civil 3D drawing builder, reverse-read DXF auditor, and validation against the 45 JEA 2026 picklists and the §350 crossing separations.</p>
                ${new Date() >= new Date("2027-01-01T00:00:00") ? `<p role="note" style="margin:0.35rem 0 0 0; font-size:0.78rem; color:var(--warning);"><i class="fa-solid fa-calendar-check"></i> JEA planned to publish updated Water and Wastewater Standards on January 1, 2027. This tool's rules are the January 1, 2026 edition — check JEA's site, then load the new template's picklists and review the crossing minimums and tolerances in Settings.</p>` : ""}
                <p role="note" style="margin:0.35rem 0 0 0; font-size:0.78rem; color:var(--warning);"><i class="fa-solid fa-circle-exclamation"></i> Changed October 28, 2026: pipe crossings are now checked by pipe type (JEA Standards 2026 §350 III.4.4–III.4.5). Earlier versions applied one 18-inch minimum, which is not JEA's rule — re-run crossing results made before this date.</p>
              </div>
              <div style="display:flex; gap:0.5rem;">
                <span class="badge" style="background:var(--bg-surface); color:var(--text-primary); border:1px solid var(--border-subtle); font-size:0.8rem; padding:0.35rem 0.6rem; border-radius:4px;">
                  <i class="fa-solid fa-location-crosshairs" style="color:var(--accent);"></i> FL East (Duval/Clay/St. Johns)
                </span>
                <span class="badge" style="background:var(--bg-surface); color:var(--text-primary); border:1px solid var(--border-subtle); font-size:0.8rem; padding:0.35rem 0.6rem; border-radius:4px;">
                  <i class="fa-solid fa-shield-halved" style="color:var(--success);"></i> Crossings: 6"/12" by type
                </span>
              </div>
            </div>

            <!-- Sub-navigation buttons -->
            <div style="display:flex; gap:0.5rem; margin-bottom:1.25rem; flex-wrap:wrap;">
              <button class="btn btn-sm ${_activeSubTab === 'gen' ? 'btn-primary' : 'btn-secondary'}" id="jea-sub-gen">
                <i class="fa-solid fa-pen-ruler"></i> Drawing Builder
              </button>
              <button class="btn btn-sm ${_activeSubTab === 'audit' ? 'btn-primary' : 'btn-secondary'}" id="jea-sub-audit">
                <i class="fa-solid fa-clipboard-check"></i> Reverse-Read DXF Auditor
              </button>
              <button class="btn btn-sm ${_activeSubTab === 'domains' ? 'btn-primary' : 'btn-secondary'}" id="jea-sub-domains">
                <i class="fa-solid fa-book-atlas"></i> 45 JEA Validation Domains
              </button>
              <button class="btn btn-sm ${_activeSubTab === 'dbsync' ? 'btn-primary' : 'btn-secondary'}" id="jea-sub-dbsync">
                <i class="fa-solid fa-database"></i> PostgreSQL Template Sync
              </button>
              <button class="btn btn-sm ${_activeSubTab === 'settings' ? 'btn-primary' : 'btn-secondary'}" id="jea-sub-settings">
                <i class="fa-solid fa-sliders"></i> Settings
              </button>
            </div>

            <!-- Dynamic Sub-view Container -->
            <div id="jea-subview-content"></div>
          </div>
        `);

        renderSubView(ctx);
        bindEvents(root, ctx);
    }

    function renderSubView(ctx) {
        const container = document.getElementById("jea-subview-content");
        if (!container) return;

        if (_activeSubTab === "gen") {
            renderGenView(container, ctx);
        } else if (_activeSubTab === "audit") {
            renderAuditView(container, ctx);
        } else if (_activeSubTab === "domains") {
            renderDomainsView(container, ctx);
        } else if (_activeSubTab === "dbsync") {
            renderDbSyncView(container, ctx);
        } else if (_activeSubTab === "settings") {
            renderSettingsView(container, ctx);
        }
    }

    function renderGenView(container, ctx) {
        const sample = _modelOverride || getSampleNetwork();
        window.setSafeHTML(container, `
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:1.25rem;">
            <div>
              <h4 style="margin:0 0 0.5rem 0;"><i class="fa-solid fa-network-wired"></i> Utility Linework & Attributes Model</h4>
              <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.75rem;">
                Constructs compliant Civil 3D drawings with JEA utility layers (<code>W-MAIN</code>, <code>SS-GRAV</code>, <code>UTIL-CROSS</code>), blocks (<code>JEA_VALVE</code>, <code>JEA_MANHOLE</code>, <code>JEA_CROSSING</code>), and <code>ATTRIB</code> metadata.
              </p>
              <div class="form-group">
                <label style="font-size:0.8rem;">Specification / Network JSON</label>
                <div style="display:flex; gap:0.5rem; align-items:center; margin-bottom:0.5rem; flex-wrap:wrap;">
                  <label for="jea-model-xlsx" style="font-size:0.8rem;">Import As-Built Excel workbook</label>
                  <input type="file" id="jea-model-xlsx" accept=".xlsx" style="font-size:0.8rem;" />
                </div>
                <div id="jea-model-import-notes" role="status" style="font-size:0.78rem; margin-bottom:0.5rem;"></div>
                <textarea id="jea-model-json" aria-label="JEA specification / network JSON" rows="14" style="width:100%; font-family:var(--font-mono); font-size:0.78rem;">${clean(JSON.stringify(sample, null, 2))}</textarea>
              </div>
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.75rem;">
                <button class="btn btn-primary btn-sm" id="jea-btn-build-dxf">
                  <i class="fa-solid fa-download"></i> Build & Download Civil 3D DXF
                </button>
                <button class="btn btn-secondary btn-sm" id="jea-btn-export-csv">
                  <i class="fa-solid fa-file-csv"></i> Export JEA CSV Tables
                </button>
                <button class="btn btn-secondary btn-sm" id="jea-btn-xlsx-tables" title="The model's structures, crossings and points along pipe as JEA's 2026 asset tables (.xlsx)">
                  <i class="fa-solid fa-file-excel"></i> Download JEA 2026 asset tables (.xlsx)
                </button>
                <button class="btn btn-secondary btn-sm" id="jea-btn-send-linework">
                  <i class="fa-solid fa-share-nodes"></i> Send to Linework Editor
                </button>
              </div>
            </div>

            <div>
              <h4 style="margin:0 0 0.5rem 0;"><i class="fa-solid fa-circle-info"></i> Standard JEA As-Built Layers</h4>
              <div style="max-height:280px; overflow-y:auto; border:1px solid var(--border-subtle); border-radius:4px;">
                <table class="data-table" style="width:100%; font-size:0.78rem;">
                  <thead><tr><th>Layer</th><th>Color</th><th>Description</th></tr></thead>
                  <tbody>
                    ${LAYERS.map(l => `<tr><td><code>${clean(l.name)}</code></td><td>Color ${l.color}</td><td>${clean(l.desc)}</td></tr>`).join("")}
                  </tbody>
                </table>
              </div>
              <div class="card" style="margin-top:1rem; padding:0.75rem; background:var(--bg-surface); border:1px solid var(--border-subtle);">
                <h5 style="margin:0 0 0.35rem 0; font-size:0.85rem;"><i class="fa-solid fa-triangle-exclamation" style="color:var(--warning);"></i> Pipe crossing separation (JEA §350 III.4)</h5>
                <p style="font-size:0.78rem; color:var(--text-secondary); margin:0;">
                  Outside to outside, by pipe type: a water main crossing a gravity or vacuum sewer or a storm sewer at least <strong>6 in above</strong> (12 in preferred) or <strong>12 in below</strong>; crossing a force main, pressure sewer or reclaimed main at least <strong>12 in above or below</strong>. Crossings without a water main are reported as not checked. Source: JEA Water and Wastewater Standards, rev. January 1, 2026.
                </p>
              </div>
            </div>
          </div>
        `);
    }

    function renderAuditView(container, ctx) {
        window.setSafeHTML(container, `
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:1.25rem;">
            <div>
              <h4 style="margin:0 0 0.5rem 0;"><i class="fa-solid fa-upload"></i> Reverse-Read DXF File or Input</h4>
              <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:0.75rem;">
                Audits uploaded Civil 3D DXF files <strong>or the JEA As-Built Excel workbook (.xlsx)</strong> against the 45 JEA validation domains, Florida East SPCS83 bounds, and the JEA §350 pipe-crossing separations.
              </p>
              <div style="display:flex; gap:0.5rem; margin-bottom:0.75rem;">
                <input type="file" id="jea-audit-file" accept=".dxf,.xlsx,.dwg" aria-label="DXF drawing or JEA As-Built Excel workbook" style="font-size:0.8rem;" />
              </div>
              <div id="jea-import-notes" role="status" style="font-size:0.78rem; margin-bottom:0.75rem;"></div>
              <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:0.5rem;">
                <label for="jea-package-files" style="font-size:0.8rem;">Package files for <em>Check Package</em> (PDF set, eTransmit .txt)</label>
                <input type="file" id="jea-package-files" accept=".pdf,.txt" multiple style="font-size:0.8rem;" />
              </div>
              <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:0.5rem;">
                <label for="jea-shots-file" style="font-size:0.8rem;">Survey point file (P,N,E,Z,D) — every feature surveyed</label>
                <input type="file" id="jea-shots-file" accept=".csv,.txt,.pnezd,.xyz" style="font-size:0.8rem;" />
              </div>
              <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:0.5rem;">
                <label for="jea-prev-file" style="font-size:0.8rem;">Previous submittal's workbook (.xlsx) — for a resubmittal</label>
                <input type="file" id="jea-prev-file" accept=".xlsx" style="font-size:0.8rem;" />
              </div>
              <details style="margin-bottom:0.5rem; font-size:0.8rem;"><summary>NGS datasheets and JEA review comments (paste)</summary>
                <label for="jea-ngs-text" style="display:block; margin-top:0.35rem;">NGS datasheets of the published control used</label>
                <textarea id="jea-ngs-text" rows="4" style="width:100%; font-family:var(--font-mono); font-size:0.75rem;" placeholder="AA1234  DESIGNATION -  …&#10;AA1234* NAVD 88 ORTHO HEIGHT - …&#10;AA1234;SPC FL E  - …"></textarea>
                <label for="jea-comments" style="display:block; margin-top:0.35rem;">JEA's review comments, one per line (resubmittal)</label>
                <textarea id="jea-comments" rows="3" style="width:100%; font-size:0.75rem;" placeholder="WV3: show the valve nut elevation&#10;Add the crossing at CR2"></textarea>
              </details>
              <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap; margin-bottom:0.5rem;">
                <label for="jea-batch-files" style="font-size:0.8rem;">Batch: several projects at once (.dxf + .xlsx, paired by file name)</label>
                <input type="file" id="jea-batch-files" accept=".dxf,.xlsx" multiple style="font-size:0.8rem;" />
              </div>
              <div id="jea-batch-panel" role="status" style="font-size:0.78rem; margin-bottom:0.5rem;"></div>
              <div id="jea-package-panel" role="status" style="font-size:0.78rem; margin-bottom:0.75rem;"></div>
              <div class="form-group">
                <label style="font-size:0.8rem;">Or Paste ASCII DXF Content</label>
                <textarea id="jea-audit-text" rows="12" placeholder="0\nSECTION\n2\nENTITIES\n..." style="width:100%; font-family:var(--font-mono); font-size:0.78rem;"></textarea>
              </div>
              <div style="display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.75rem;">
                <button class="btn btn-primary btn-sm" id="jea-btn-run-audit">
                  <i class="fa-solid fa-magnifying-glass"></i> Run JEA Standards Audit
                </button>
                <button class="btn btn-secondary btn-sm" id="jea-btn-package" title="Sheets and certifications, State Plane position, and (with a workbook loaded) workbook vs drawing">
                  <i class="fa-solid fa-list-check"></i> Check Package
                </button>
                <button class="btn btn-secondary btn-sm" id="jea-btn-extract-pipes" title="Pull the pipe linework (recognised as-built layers) out of the DXF above">
                  <i class="fa-solid fa-diagram-project"></i> Extract Pipe Network
                </button>
                <button class="btn btn-secondary btn-sm" id="jea-btn-audit-pass">
                  <i class="fa-solid fa-check"></i> Load Compliant Sample
                </button>
                <button class="btn btn-secondary btn-sm" id="jea-btn-audit-fail">
                  <i class="fa-solid fa-triangle-exclamation"></i> Load Violation Sample (water main 7" under a sewer)
                </button>
              </div>
            </div>

            <div id="jea-audit-results-panel">
              <p style="font-size:0.72rem; color:var(--text-secondary); margin:0 0 0.5rem 0;"><i class="fa-solid fa-scale-balanced"></i> A QC aid, not a certification: it checks a drawing against the rules built into this tool. The surveyor of record remains responsible for the deliverable.</p>
              <h4 style="margin:0 0 0.5rem 0;"><i class="fa-solid fa-chart-pie"></i> Audit Results & Compliance Score</h4>
              <div style="background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:6px; padding:1rem; text-align:center; color:var(--text-secondary);">
                <i class="fa-solid fa-file-circle-question" style="font-size:2rem; margin-bottom:0.5rem; opacity:0.6;"></i>
                <p style="margin:0; font-size:0.85rem;">Run an audit or load a sample to inspect compliance results.</p>
              </div>
            </div>
          </div>
        `);

        if (_lastAuditReport) {
            renderAuditResults(document.getElementById("jea-audit-results-panel"), _lastAuditReport, ctx);
        }
    }

    function renderAuditResults(panel, rep, ctx) {
        if (!panel) return;
        const scoreColor = rep.score == null ? "var(--text-secondary)" : rep.score >= 90 ? "var(--success)" : (rep.score >= 70 ? "var(--warning)" : "var(--danger)");
        const badgeBg = rep.compliant ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)";
        const badgeColor = rep.compliant ? "var(--success)" : "var(--danger)";

        window.setSafeHTML(panel, `
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.75rem;">
            <h4 style="margin:0;"><i class="fa-solid fa-chart-pie"></i> Audit Results</h4>
            <div style="display:flex; align-items:center; gap:0.5rem;">
              <span class="badge" style="background:${badgeBg}; color:${badgeColor}; font-weight:700; font-size:0.85rem; padding:0.25rem 0.5rem; border-radius:4px;">
                ${rep.score == null ? "NOT SCORED" : (rep.compliant ? "COMPLIANT" : "NON-COMPLIANT")}
              </span>
              <span style="font-size:1.1rem; font-weight:800; color:${scoreColor};">
                ${rep.score == null ? "n/a" : rep.score + "%"}
              </span>
            </div>
          </div>

          <p style="font-size:0.72rem; color:var(--text-secondary); margin:0 0 0.25rem 0;">${clean(rep.scope || "")}</p>
          ${rep.rules ? `<p style="font-size:0.72rem; color:var(--text-secondary); margin:0 0 0.75rem 0;">${clean(rulesLine(rep.rules))}</p>` : ""}
          ${rep.notScoredReason ? `<p style="font-size:0.8rem; color:var(--text-secondary); margin:0 0 0.75rem 0;"><i class="fa-solid fa-circle-info"></i> ${clean(rep.notScoredReason)}</p>` : ""}
          <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:0.5rem; margin-bottom:0.75rem;">
            <div class="card" style="padding:0.5rem; text-align:center; background:var(--bg-surface); border:1px solid var(--border-subtle);">
              <div style="font-size:1.1rem; font-weight:700;">${rep.summary.totalEntities}</div>
              <div style="font-size:0.7rem; color:var(--text-secondary);">Entities Checked</div>
            </div>
            <div class="card" style="padding:0.5rem; text-align:center; background:var(--bg-surface); border:1px solid var(--border-subtle);">
              <div style="font-size:1.1rem; font-weight:700; color:var(--danger);">${rep.summary.errorCount}</div>
              <div style="font-size:0.7rem; color:var(--text-secondary);">Errors / Violations</div>
            </div>
            <div class="card" style="padding:0.5rem; text-align:center; background:var(--bg-surface); border:1px solid var(--border-subtle);">
              <div style="font-size:1.1rem; font-weight:700; color:var(--warning);">${rep.summary.warnCount}</div>
              <div style="font-size:0.7rem; color:var(--text-secondary);">Warnings</div>
            </div>
          </div>

          <div style="max-height:220px; overflow-y:auto; border:1px solid var(--border-subtle); border-radius:4px; margin-bottom:0.75rem;">
            <table class="data-table" style="width:100%; font-size:0.75rem;">
              <thead><tr><th>Sev</th><th>Rule</th><th>Message</th><th>Entity</th></tr></thead>
              <tbody>
                ${rep.issues.length ? rep.issues.map(iss => `
                  <tr>
                    <td><span class="badge" style="background:${iss.severity === 'error' ? 'var(--danger)' : iss.severity === 'info' ? 'var(--text-secondary)' : 'var(--warning)'}; color:#fff; font-size:0.65rem; padding:0.15rem 0.35rem; border-radius:3px;">${iss.severity.toUpperCase()}</span></td>
                    <td><strong>${clean(iss.rule)}</strong></td>
                    <td>${clean(iss.message)}</td>
                    <td><code>${clean(iss.entity)}</code>${isFinite(iss.easting) && isFinite(iss.northing) ? ` <button class="btn btn-secondary btn-sm jea-zoom" data-e="${Number(iss.easting).toFixed(3)}" data-n="${Number(iss.northing).toFixed(3)}" aria-label="Civil 3D zoom command for this finding" title="Civil 3D command to zoom here">Zoom</button>` : ""}</td>
                  </tr>
                `).join("") : '<tr><td colspan="4" style="color:var(--success); text-align:center;">✓ All checked JEA 2026 standards verified without errors.</td></tr>'}
              </tbody>
            </table>
          </div>

          <div style="display:flex; justify-content:flex-end; gap:0.5rem;">
            <button class="btn btn-secondary btn-sm" id="jea-btn-save-reports">
              <i class="fa-solid fa-box-archive"></i> Save to Reports Hub
            </button>
          </div>
        `);

        panel.querySelector("#jea-btn-save-reports")?.addEventListener("click", () => {
            exportAuditReportToReports(rep);
            if (ctx && ctx.showToast) ctx.showToast("Saved audit report to Centralized Reports Hub.");
        });
    }

    function renderDomainsView(container, ctx) {
        const domainKeys = Object.keys(DOMAINS).sort();
        window.setSafeHTML(container, `
          <div>
            <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:0.5rem; margin-bottom:1rem;">
              <h4 style="margin:0;"><i class="fa-solid fa-book-atlas"></i> 45 JEA Picklist Validation Domains (2026 template)</h4>
              <input type="text" id="jea-domain-filter" placeholder="Filter domain or value..." style="font-size:0.8rem; padding:0.3rem 0.5rem; width:220px;" />
            </div>
            <div id="jea-domains-list" style="display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:0.75rem; max-height:480px; overflow-y:auto; padding-right:0.5rem;">
              ${domainKeys.map(k => `
                <div class="card domain-card" data-domain="${clean(k).toLowerCase()}" style="padding:0.75rem; background:var(--bg-surface); border:1px solid var(--border-subtle); border-radius:4px;">
                  <div style="font-weight:700; font-size:0.82rem; margin-bottom:0.35rem; color:var(--primary); display:flex; justify-content:space-between;">
                    <span>${clean(k)}</span>
                    <span style="font-size:0.7rem; color:var(--text-muted);">${DOMAINS[k].length} items</span>
                  </div>
                  <div style="font-size:0.75rem; color:var(--text-secondary); max-height:85px; overflow-y:auto; font-family:var(--font-mono);">
                    ${DOMAINS[k].map(item => `<span style="display:inline-block; background:rgba(255,255,255,0.05); padding:0.1rem 0.3rem; margin:0.1rem; border-radius:2px;">${clean(item)}</span>`).join("")}
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        `);

        const filterInput = container.querySelector("#jea-domain-filter");
        filterInput?.addEventListener("input", e => {
            const query = e.target.value.toLowerCase();
            container.querySelectorAll(".domain-card").forEach(card => {
                const dName = card.getAttribute("data-domain") || "";
                const text = card.textContent.toLowerCase();
                card.style.display = (dName.includes(query) || text.includes(query)) ? "block" : "none";
            });
        });
    }

    function renderDbSyncView(container, ctx) {
        window.setSafeHTML(container, `
          <div style="max-width:640px;">
            <h4 style="margin:0 0 0.5rem 0;"><i class="fa-solid fa-database"></i> PostgreSQL Template Sync (<code>client_templates</code>)</h4>
            <p style="font-size:0.8rem; color:var(--text-secondary); margin-bottom:1rem;">
              Synchronize the JEA As-Built template with your local PostgreSQL instance (<code>localhost:5432 / fdot_survey_db</code>).
            </p>
            <div class="card" style="padding:1rem; background:var(--bg-surface); border:1px solid var(--border-subtle); margin-bottom:1rem;">
              <table class="data-table" style="width:100%; font-size:0.8rem;">
                <tbody>
                  <tr><td><strong>Template ID</strong></td><td><code>tpl_jea_2024</code></td></tr>
                  <tr><td><strong>Client Name</strong></td><td>JEA</td></tr>
                  <tr><td><strong>Label</strong></td><td>${clean(CLIENT_TEMPLATE.label)}</td></tr>
                  <tr><td><strong>Discipline</strong></td><td>UTILITY</td></tr>
                  <tr><td><strong>Projection</strong></td><td>Florida East State Plane (US Survey Feet)</td></tr>
                  <tr><td><strong>Crossing separation</strong></td><td>By pipe type — JEA Standards 2026 §350 III.4.4–III.4.5</td></tr>
                  <tr><td><strong>Service Territory</strong></td><td>Duval, Clay, St. Johns, Nassau</td></tr>
                </tbody>
              </table>
            </div>
            <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
              <button class="btn btn-secondary btn-sm" id="jea-btn-add-local-tpl">
                <i class="fa-solid fa-user-plus"></i> Add as My Client Template
              </button>
              <button class="btn btn-primary btn-sm" id="jea-btn-dbsync-run">
                <i class="fa-solid fa-rotate"></i> Sync Template to PostgreSQL
              </button>
              <span id="jea-dbsync-status" style="font-size:0.8rem; display:flex; align-items:center; color:var(--text-secondary);"></span>
            </div>
          </div>
        `);

        container.querySelector("#jea-btn-add-local-tpl")?.addEventListener("click", () => {
            const st = container.querySelector("#jea-dbsync-status");
            const res = addAsClientTemplate();
            if (st) {
                st.textContent = res.success ? `✓ ${res.mode === "created" ? "Added to" : "Updated in"} your Client Master Templates` : `Notice: ${res.note}`;
                st.style.color = res.success ? "var(--success)" : "var(--warning)";
            }
            if (ctx && ctx.showToast) ctx.showToast(res.success ? "JEA template added to your Client Master Templates." : res.note, !res.success);
        });

        container.querySelector("#jea-btn-dbsync-run")?.addEventListener("click", async () => {
            const st = container.querySelector("#jea-dbsync-status");
            if (st) st.textContent = "Syncing with PostgreSQL...";
            const res = await syncTemplateWithDb();
            if (st) {
                st.textContent = res.success ? `✓ Synchronized via ${res.mode}` : `Notice: ${res.note}`;
                st.style.color = res.success ? "var(--success)" : "var(--warning)";
            }
            if (ctx && ctx.showToast) ctx.showToast(res.success ? "JEA Template synchronized to PostgreSQL" : `Sync failed: ${res.note}`, !res.success);
        });
    }

    function exportAuditReportToReports(rep) {
        if (!window.Reports || !window.Reports.addReport) return;

        const content = [
            `# JEA As-Built Standards Audit Report`,
            `Generated: ${rep.timestamp}`,
            rep.rules ? rulesLine(rep.rules) : ``,
            `Overall Status: ${rep.score == null ? 'NOT SCORED' : (rep.compliant ? 'COMPLIANT' : 'NON-COMPLIANT')} (Score: ${rep.score == null ? 'not scored' : rep.score + '%'})`,
            ``,
            `## Summary Metrics`,
            `- Total Entities Checked: ${rep.summary.totalEntities}`,
            `- Pipe Polyline Runs: ${rep.summary.polylinesCount}`,
            `- Structure & Valve Inserts: ${rep.summary.insertsCount}`,
            `- Errors & Violations: ${rep.summary.errorCount}`,
            `- Warnings: ${rep.summary.warnCount}`,
            ``,
            `## Issues & Standard Checks`,
            ...(rep.issues.map((i, idx) => `${idx + 1}. [${i.severity.toUpperCase()}] **${i.rule}**: ${i.message} (Entity: \`${i.entity}\`, Layer: \`${i.layer}\`)`)),
            rep.issues.length === 0 ? `✓ No violations of the checked JEA picklists or §350 crossing separations.` : ``
        ].join("\n");

        window.Reports.addReport({
            title: `JEA Audit (2026 standards) - ${rep.score == null ? 'Not scored' : 'Score ' + rep.score + '%'}`,
            type: "jea_audit",
            category: "audit",
            format: "markdown",
            content,
            metadata: {
                rules: rep.rules || rulesApplied(),
                score: rep.score,
                compliant: rep.compliant,
                errorCount: rep.summary.errorCount,
                warnCount: rep.summary.warnCount
            }
        });
    }

    /** Reads an .xlsx File into { model, warnings, stats } via window.JeaXlsx. */
    async function importXlsxFile(file) {
        if (!window.JeaXlsx) throw new Error("The Excel reader (jea-xlsx.js) is not loaded.");
        const buf = await file.arrayBuffer();
        const wb = await window.JeaXlsx.readWorkbook(buf);
        _lastWorkbookBytes = { name: file.name, buf };
        if (window.JeaXlsx.pumpStationSheet(wb)) {
            // JEA's pump station attribute worksheet: a completeness check, not an import
            const ps = window.JeaXlsx.checkPumpStationWorksheet(wb);
            ps.findings.unshift({ severity: "info", rule: "Rules applied", id: "", where: file.name, message: rulesLine(rulesApplied()) });
            return { pumpStation: ps };
        }
        const res = window.JeaXlsx.workbookToModel(wb, {
            domains: DOMAINS, bounds: BOUNDS, projectName: file.name.replace(/\.xlsx$/i, ""),
            qc: _settings.qc, duplicates: _settings.duplicates
        });
        if (!res.model.structures.length && !(res.model.crossings || []).length) throw new Error("No As-Built tables with coordinates were found in this workbook.");
        const stamp = { severity: "info", rule: "Rules applied", id: "", where: file.name, message: rulesLine(rulesApplied()) };
        res.findings.unshift(stamp);
        res.warnings.unshift(`${stamp.where} : ${stamp.message}`);
        return res;
    }

    let _lastImportFindings = null;
    let _lastWorkbookBytes = null; // the last workbook picked, as loaded — for the lat/lon-filled copy

    function renderPumpNotes(el, file, ps) {
        if (!el) return;
        _lastImportFindings = { name: file.name, findings: ps.findings };
        const color = { error: "var(--danger)", warning: "var(--warning)", info: "var(--text-secondary)" };
        const done = ps.assets.filter(a => !a.missing.length).length;
        window.setSafeHTML(el, `
          <div><strong>${clean(file.name)}</strong> is JEA's pump station attribute worksheet — checked for completeness, not imported:
            ${ps.assets.length} asset row(s), ${done} complete; ${ps.findings.filter(f => f.rule === "Worksheet header blank").length} header field(s) blank.
            <button class="btn btn-secondary btn-sm" id="jea-btn-qc-csv" style="margin-left:0.5rem;"><i class="fa-solid fa-file-csv"></i> Download findings CSV</button></div>
          <ul style="margin:0.35rem 0 0 1rem; max-height:220px; overflow-y:auto;">${ps.findings.slice(0, 60).map(x =>
            `<li style="color:${color[x.severity]};">${x.id ? `<strong>${clean(x.id)}</strong> ` : ""}<code>${clean(x.where)}</code> — ${clean(x.rule)}: ${clean(x.message)}</li>`).join("")}</ul>`);
    }

    function renderImportNotes(el, file, res) {
        if (!el) return;
        const s = res.stats;
        const f = res.findings || [];
        _lastImportFindings = { name: file.name, findings: f };
        const kinds = Object.keys(s.byKind).map(k => `${s.byKind[k]} ${k.replace("JEA_", "").toLowerCase()}`).join(", ");
        const count = sev => f.filter(x => x.severity === sev).length;
        const color = { error: "var(--danger)", warning: "var(--warning)", info: "var(--text-secondary)" };
        const SHOW = 40;
        const order = { error: 0, warning: 1, info: 2 };
        const list = f.slice().sort((a, b) => order[a.severity] - order[b.severity]);
        window.setSafeHTML(el, `
          <div><strong>${clean(file.name)}</strong>: imported ${s.imported} items (${clean(kinds)}) from ${s.tables} tables;
          ${s.duplicates} repeated row(s) across sheets merged, ${s.skipped} skipped.</div>
          <div style="margin-top:0.35rem;"><strong>Workbook check:</strong>
            <span style="color:${color.error};">${count("error")} error(s)</span>,
            <span style="color:${color.warning};">${count("warning")} warning(s)</span>,
            ${count("info")} note(s).
            ${f.length ? `<button class="btn btn-secondary btn-sm" id="jea-btn-qc-csv" style="margin-left:0.5rem;"><i class="fa-solid fa-file-csv"></i> Download findings CSV</button>` : ""}
            <button class="btn btn-secondary btn-sm" id="jea-btn-fill-latlon" style="margin-left:0.25rem;" title="A copy of this workbook with Latitude / Longitude filled or corrected from each row's State Plane position — every change listed"><i class="fa-solid fa-earth-americas"></i> Copy with lat/lon filled</button>
            <button class="btn btn-secondary btn-sm" id="jea-btn-fix-all" style="margin-left:0.25rem;" title="Lat/lon from State Plane, depth = grade − top where blank, gravity slopes from inverts and length — and, if ticked in the package check, the drawing's ID spelling; every change listed"><i class="fa-solid fa-wand-magic-sparkles"></i> Copy with all fixes</button>
          </div>
          ${list.length ? `<ul style="margin:0.35rem 0 0 1rem; max-height:220px; overflow-y:auto;">${list.slice(0, SHOW).map(x =>
            `<li style="color:${color[x.severity]};"><strong>${clean(x.id)}</strong> <code>${clean(x.where)}</code> — ${clean(x.rule)}: ${clean(x.message)}</li>`).join("")}
            ${list.length > SHOW ? `<li>…and ${list.length - SHOW} more in the CSV.</li>` : ""}</ul>` : ""}
          <div style="margin-top:0.35rem; color:var(--text-secondary);">Tolerances in use: lat/lon ${clean(String((_settings.qc && _settings.qc.latLonTolFt) || window.JeaXlsx.QC_DEFAULTS.latLonTolFt))} ft, depth ${clean(String((_settings.qc && _settings.qc.depthTolFt) || window.JeaXlsx.QC_DEFAULTS.depthTolFt))} ft (JEA's defaults: 0.5 ft horizontal, 0.1 ft vertical — Standards 2026 §501 II.1.7). Which value is right is the surveyor's call.</div>
        `);
    }

    // The real drawing and workbook last loaded (the auditor's text area may hold a generated drawing).
    let _lastDrawing = null;   // { name, text }
    let _lastWorkbook = null;  // { name, res }
    let _lastPackage = null;   // { name, findings }
    let _packageFiles = { transmittal: null, pdfs: [] }; // PDF page counts + transmittal text, for Check Package
    let _surveyShots = null;   // { name, shots } — the field point file, for "every feature surveyed"
    let _prevWorkbook = null;  // { name, res } — the previous submittal's workbook, for the resubmittal compare
    let _auditTextGenerated = false; // the text area holds a drawing this tool built (sample / workbook)

    /**
     * Tokenize a big DXF in a Web Worker (plugins/dxf-auditor/dxf-tokenize-worker.js) so the page stays
     * responsive; resolves to the group-code pairs, or null when workers aren't available (callers then
     * tokenize on the page as before).
     */
    function tokenizeInBackground(text) {
        return new Promise(resolve => {
            let w;
            try { w = new Worker("plugins/dxf-auditor/dxf-tokenize-worker.js"); } catch (e) { resolve(null); return; }
            const id = Date.now();
            w.onmessage = e => { w.terminate(); resolve(e.data && e.data.id === id && !e.data.error ? e.data.pairs : null); };
            w.onerror = () => { w.terminate(); resolve(null); };
            w.postMessage({ id, text });
        });
    }

    // Reviewer statuses per finding (OK / Fix / N/A), per drawing — this browser only.
    const REVIEW_KEY = "jea24.review.v1";
    const reviewKey = f => `${f.section || ""}|${f.rule}|${f.id || ""}|${f.where || ""}|${String(f.message).slice(0, 80)}`;
    function loadReview(name) {
        try { const all = JSON.parse(window.localStorage.getItem(REVIEW_KEY) || "{}"); return all[name] || {}; } catch (e) { return {}; }
    }
    function saveReview(name, key, status) {
        try {
            const all = JSON.parse(window.localStorage.getItem(REVIEW_KEY) || "{}");
            const m = all[name] || (all[name] = {});
            if (status) m[key] = status; else delete m[key];
            window.localStorage.setItem(REVIEW_KEY, JSON.stringify(all));
        } catch (e) { /* storage blocked: statuses last for this page only */ }
    }

    /** Points, pipes and findings on one plan — built with createElementNS (DOMPurify strips <svg>). */
    function drawFindingsMap(host, network, model, marks) {
        if (!host) return;
        host.textContent = "";
        const NS = "http://www.w3.org/2000/svg";
        const pipes = ((network && network.model && network.model.pipes) || []).filter(p => p.points.length >= 2);
        const pts = [].concat((model && model.structures) || [], (model && model.crossings) || [], (model && model.pipePoints) || []).filter(p => isFinite(p.e) && isFinite(p.n));
        const all = pipes.flatMap(p => p.points).concat(pts, marks);
        if (!all.length) { host.textContent = "Nothing with coordinates to draw."; return; }
        const es = all.map(p => p.e), ns = all.map(p => p.n);
        let x0 = Math.min(...es), x1 = Math.max(...es), y0 = Math.min(...ns), y1 = Math.max(...ns);
        const pad = Math.max(x1 - x0, y1 - y0, 10) * 0.04; x0 -= pad; x1 += pad; y0 -= pad; y1 += pad;
        const W = 760, H = Math.max(240, Math.min(620, W * (y1 - y0) / Math.max(1e-6, x1 - x0)));
        const k = Math.min(W / (x1 - x0), H / (y1 - y0));
        const X = e => (e - x0) * k, Y = n => H - (n - y0) * k;
        const el = (tag, attrs) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([a, v]) => n.setAttribute(a, v)); return n; };
        const svg = el("svg", { viewBox: `0 0 ${W} ${H.toFixed(0)}`, width: "100%", role: "img", "aria-label": "Plan of the drawing's pipes, the workbook's points and the findings" });
        svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: H.toFixed(0), fill: "var(--bg-surface)" }));
        const color = l => /^W-/.test(l) ? "#3b82f6" : /^SS-/.test(l) ? "#16a34a" : /^RW-/.test(l) ? "#a855f7" : "#94a3b8";
        pipes.forEach(p => svg.appendChild(el("polyline", { points: p.points.map(q => `${X(q.e).toFixed(1)},${Y(q.n).toFixed(1)}`).join(" "), fill: "none", stroke: color(p.layer), "stroke-width": 1.5 })));
        pts.forEach(p => svg.appendChild(el("circle", { cx: X(p.e).toFixed(1), cy: Y(p.n).toFixed(1), r: 2.5, fill: "#e2e8f0", stroke: "#475569", "stroke-width": 0.6 })));
        marks.forEach(m => {
            const g = el("g", {});
            g.appendChild(el("circle", { cx: X(m.e).toFixed(1), cy: Y(m.n).toFixed(1), r: 6, fill: "none", stroke: m.severity === "error" ? "#ef4444" : "#f59e0b", "stroke-width": 2 }));
            const t = el("title", {}); t.textContent = `${m.id ? m.id + ": " : ""}${m.rule} — ${m.message}`; g.appendChild(t);
            svg.appendChild(g);
        });
        host.appendChild(svg);
    }

    function runPackageCheck(ctx) {
        const P = window.JeaPackage;
        if (!P) { if (ctx && ctx.showToast) ctx.showToast("The package checker (jea-package.js) is not loaded.", true); return; }
        const area = document.getElementById("jea-audit-text");
        const drawing = _lastDrawing || (area && area.value.trim() && !_auditTextGenerated ? { name: "pasted DXF", text: area.value } : null);
        const panel = document.getElementById("jea-package-panel");
        if (!drawing) {
            if (panel) window.setSafeHTML(panel, "Load the drawing (.dxf) first — the package check reads a real drawing, not one built from the workbook.");
            return;
        }
        let info;
        try { info = P.collectDrawingText(drawing.text, drawing.pairs); } catch (err) {
            if (ctx && ctx.showToast) ctx.showToast("Package check failed: " + err.message, true);
            return;
        }
        const wbModel = _lastWorkbook ? _lastWorkbook.res.model : null;
        const sheets = P.checkSheets(info);
        const geo = P.georeference(info, wbModel ? wbModel.structures : null);
        const rec = _lastWorkbook ? P.reconcile(_lastWorkbook.res, info) : null;
        const files = P.checkPackageFiles({ transmittal: _packageFiles.transmittal, pdfs: _packageFiles.pdfs, xrefs: info.xrefs,
            drawingName: drawing.name, sheetTotals: sheets.totals, sheets });
        const network = extractPipeNetwork(parseDxf(drawing.text, drawing.pairs));
        const pipes = P.checkPipeLabels(info, network);
        const horiz = P.checkHorizontalSeparation(network);
        const spacing = wbModel ? P.checkPointSpacing(network, wbModel) : null;
        const survey = wbModel && _surveyShots ? P.checkSurveyedPoints(wbModel, _surveyShots.shots) : null;
        const ngsText = (document.getElementById("jea-ngs-text") || {}).value || "";
        const control = P.checkPublishedControl(info, ngsText.trim() ? ngsText : null);
        const commentsText = (document.getElementById("jea-comments") || {}).value || "";
        const resub = _lastWorkbook && _prevWorkbook ? P.compareSubmittals(_prevWorkbook.res, _lastWorkbook.res, commentsText) : null;
        const groups = [
            ["Sheets & certifications", sheets.findings], ["State Plane position", geo.findings], ["Workbook vs drawing", rec ? rec.findings : null],
            ["Every feature surveyed (§501 II.1.17)", survey ? survey.findings : null], ["Published control (§501 II.1.6)", control.findings],
            ["Pipe-length labels", pipes.findings], ["Horizontal separation (§350 III.4.2–III.4.3)", horiz.findings],
            ["Recorded points every 100 ft (§501 III.1.3)", spacing ? spacing.findings : null], ["Resubmittal (§501 I.6.3)", resub ? resub.findings : null],
            ["Package files", files.findings]
        ].filter(g => g[1]);
        const review = loadReview(drawing.name);
        const tagged = (sec, list) => list.map(f => { const t0 = Object.assign({ section: sec }, f); t0.review = review[reviewKey(t0)] || ""; return t0; });
        const all = [{ section: "Rules", severity: "info", rule: "Rules applied", id: "", where: drawing.name, message: rulesLine(rulesApplied()) }].concat(...groups.map(([n, f]) => tagged(n, f)));
        _lastPackage = {
            name: drawing.name, findings: all, geo, sheets, rec, files, network,
            sections: groups.map(([name, f]) => ({ name, findings: tagged(name, f) })).concat([
                { name: "Workbook check", findings: tagged("Workbook check", _lastWorkbook && _lastWorkbook.res.findings ? _lastWorkbook.res.findings : []) },
                { name: "Drawing audit", findings: tagged("Drawing audit", (_lastAuditReport && _lastAuditReport.issues) ? _lastAuditReport.issues.map(i => ({ severity: i.severity, rule: i.rule, id: "", where: i.entity, message: i.message })) : []) }])
        };
        const offSpc = geo.shift && geo.shift.groups && geo.shift.groups.length && geo.shift.groups[0].distance > 1 ? geo.shift.groups[0] : null;
        if (!panel) return;
        const color = { error: "var(--danger)", warning: "var(--warning)", info: "var(--text-secondary)" };
        const order = { error: 0, warning: 1, info: 2 };
        const reviewSel = f => f.severity === "info" ? "" : ` <select class="jea-review" data-key="${clean(reviewKey(f))}" aria-label="Review status" style="font-size:0.7rem;">${["", "OK", "Fix", "N/A"].map(v => `<option value="${v}"${f.review === v ? " selected" : ""}>${v || "— review"}</option>`).join("")}</select>`;
        const section = (title, list, extra) => `
          <details open style="margin-top:0.5rem;"><summary><strong>${clean(title)}</strong> — ${list.filter(f => f.severity === "error").length} error(s), ${list.filter(f => f.severity === "warning").length} warning(s), ${list.filter(f => f.severity === "info").length} note(s)</summary>
            ${extra || ""}
            <ul style="margin:0.35rem 0 0 1rem; max-height:220px; overflow-y:auto;">${list.slice().sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 60).map(f =>
                `<li style="color:${color[f.severity]};">${f.id ? `<strong>${clean(f.id)}</strong> ` : ""}<code>${clean(f.where || "")}</code> — ${clean(f.rule)}: ${clean(f.message)}${reviewSel(f)}</li>`).join("")}
              ${list.length > 60 ? `<li>…and ${list.length - 60} more in the CSV.</li>` : ""}</ul>
          </details>`;
        const sheetTable = sheets.sheets.length ? `<div style="overflow-x:auto;"><table class="data-table" style="width:100%; font-size:0.72rem; margin-top:0.35rem;">
            <thead><tr><th>Layout</th>${P.SHEET_FIELDS.map(f => `<th>${clean(f.label.replace(/\s*\(.*\)/, ""))}</th>`).join("")}</tr></thead>
            <tbody>${sheets.sheets.map(sh => `<tr><td><code>${clean(sh.layout)}</code></td>${P.SHEET_FIELDS.map(f => `<td>${sh.found[f.key] ? clean(sh.found[f.key].slice(0, 2).join(", ").slice(0, 24) || "✓") : "—"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
            <div style="color:var(--text-secondary);">${clean(sheets.basis)}</div>
            <div style="color:var(--text-secondary);">Check by eye (drawn, not text): ${clean((sheets.visualOnly || []).join("; "))}.</div>` : "";
        const recCounts = rec ? `<div>${Object.entries(rec.counts).map(([k, v]) => `${v} ${clean(k)}`).join(" · ")}</div>` : "";
        const variants = rec ? rec.rows.filter(r => r.status === "variant") : [];
        const resubTable = resub && resub.comments.length ? `<div style="overflow-x:auto;"><table class="data-table" style="width:100%; font-size:0.72rem;"><thead><tr><th>JEA comment</th><th>IDs</th><th>Status</th></tr></thead>
            <tbody>${resub.comments.map(c => `<tr><td>${clean(c.comment.slice(0, 140))}</td><td>${clean(c.ids.join(", "))}</td><td>${clean(c.status)}</td></tr>`).join("")}</tbody></table></div>` : "";
        const extras = {
            "Sheets & certifications": sheetTable, "Workbook vs drawing": recCounts, "Resubmittal (§501 I.6.3)": resubTable,
            "Package files": _packageFiles.transmittal || _packageFiles.pdfs.length ? "" : `<div style="color:var(--text-secondary);">Add the PDF set and the eTransmit transmittal (.txt) above to check page sizes, signatures, page counts, xrefs and missing files.</div>`,
            "Published control (§501 II.1.6)": ngsText.trim() ? "" : `<div style="color:var(--text-secondary);">Paste the NGS datasheets of the control used (above) to check their elevations and positions.</div>`
        };
        window.setSafeHTML(panel, `
          <div><strong>Package check</strong> of <strong>${clean(drawing.name)}</strong>${_lastWorkbook ? ` against <strong>${clean(_lastWorkbook.name)}</strong>` : " (load the workbook too to compare IDs and coordinates)"}.
            <button class="btn btn-secondary btn-sm" id="jea-btn-package-csv" style="margin-left:0.5rem;"><i class="fa-solid fa-file-csv"></i> Download findings CSV</button>
            <button class="btn btn-primary btn-sm" id="jea-btn-readiness" style="margin-left:0.25rem;"><i class="fa-solid fa-clipboard-check"></i> Readiness report</button>
            <button class="btn btn-secondary btn-sm" id="jea-btn-forms" style="margin-left:0.25rem;" title="Drafts of JEA's §501 V.2 transmittal and V.3 checklist, filled from these checks"><i class="fa-solid fa-file-signature"></i> Transmittal &amp; checklist draft</button>
            <button class="btn btn-secondary btn-sm" id="jea-btn-zip" style="margin-left:0.25rem;" title="One .zip for the W&amp;S As-Built Submittal Mailbox: the PDF set, the workbook, the checklist draft, the readiness report and the findings"><i class="fa-solid fa-file-zipper"></i> Submittal package (.zip)</button>
            ${_lastWorkbook ? `<button class="btn btn-secondary btn-sm" id="jea-btn-overlay" style="margin-left:0.25rem;" title="The workbook's points as JEA blocks, in the drawing's coordinates, on layer JEA-OVERLAY — XREF it over the drawing"><i class="fa-solid fa-layer-group"></i> Overlay DXF</button>` : ""}
            ${offSpc ? `<button class="btn btn-secondary btn-sm" id="jea-btn-move-scr" style="margin-left:0.25rem;" title="AutoCAD script: move model space by ΔE ${offSpc.dE.toFixed(2)}, ΔN ${offSpc.dN.toFixed(2)} ft onto State Plane — run it on a copy"><i class="fa-solid fa-up-down-left-right"></i> Move-to-State-Plane script</button>` : ""}</div>
          ${variants.length ? `<div style="margin-top:0.35rem;"><label for="jea-rename-ids" style="font-size:0.78rem;"><input type="checkbox" id="jea-rename-ids"> In "Copy with all fixes", rename ${variants.length} workbook ID(s) to the drawing's spelling (${clean(variants.slice(0, 3).map(v => `${v.id} → ${v.drawingId}`).join(", "))}${variants.length > 3 ? ", …" : ""})</label></div>` : ""}
          <div style="color:var(--text-secondary);">${clean(rulesLine(rulesApplied()))}</div>
          <details style="margin-top:0.5rem;"><summary><strong>Map</strong> — pipes (blue water, green sewer, purple reclaimed), workbook points, findings circled</summary><div id="jea-package-map" style="margin-top:0.35rem;"></div></details>
          ${groups.map(([name, f]) => section(name, tagged(name, f), extras[name] || "")).join("")}
        `);
        // findings with a known position, for the map
        const pos = new Map([].concat((wbModel && wbModel.structures) || [], (wbModel && wbModel.crossings) || []).map(x => [String(x.id).toUpperCase(), x]));
        const marks = all.filter(f => f.severity !== "info" && f.id && pos.has(String(f.id).toUpperCase())).map(f => Object.assign({}, f, { e: pos.get(String(f.id).toUpperCase()).e, n: pos.get(String(f.id).toUpperCase()).n }))
;
        // workbook points are in State Plane; the drawing may be shifted — draw both in the drawing's frame
        const sh = offSpc ? { dE: offSpc.dE, dN: offSpc.dN } : null;
        const inDrawing = x => sh ? Object.assign({}, x, { e: x.e - sh.dE, n: x.n - sh.dN }) : x;
        drawFindingsMap(document.getElementById("jea-package-map"), network,
            wbModel ? { structures: (wbModel.structures || []).map(inDrawing), crossings: (wbModel.crossings || []).map(inDrawing), pipePoints: (wbModel.pipePoints || []).map(inDrawing) } : null, marks.map(inDrawing));
    }

    /** Pair drawings with workbooks by file name: the workbook whose name contains the drawing's (or the reverse). */
    function pairByName(files) {
        const stem = f => f.name.replace(/\.(dxf|xlsx)$/i, "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
        const dxfs = files.filter(f => /\.dxf$/i.test(f.name)), books = files.filter(f => /\.xlsx$/i.test(f.name));
        const used = new Set();
        return dxfs.map(d => {
            const sd = stem(d);
            const words = sd.split(" ").filter(w => w.length >= 3);
            const score = b => { const sb = stem(b); if (sb.includes(sd) || sd.includes(sb)) return 100; return words.filter(w => sb.includes(w)).length; };
            const best = books.filter(b => !used.has(b)).map(b => ({ b, sc: score(b) })).sort((x, y) => y.sc - x.sc)[0];
            const wb = best && best.sc > 0 ? best.b : null;
            if (wb) used.add(wb);
            return { dxf: d, xlsx: wb };
        }).concat(books.filter(b => !used.has(b)).map(b => ({ dxf: null, xlsx: b })));
    }

    async function runBatch(files, ctx) {
        const P = window.JeaPackage, X = window.JeaXlsx, panel = document.getElementById("jea-batch-panel");
        if (!P || !X || !panel) return;
        const pairs = pairByName(files);
        const rows = [];
        for (const pr of pairs) {
            const row = { drawing: pr.dxf ? pr.dxf.name : "", workbook: pr.xlsx ? pr.xlsx.name : "", errors: 0, warnings: 0, onSpc: "", ids: "", note: "" };
            try {
                let wbRes = null;
                if (pr.xlsx) {
                    const wb = await X.readWorkbook(await pr.xlsx.arrayBuffer());
                    if (X.pumpStationSheet(wb)) { const ps = X.checkPumpStationWorksheet(wb); row.note = "pump station worksheet"; ps.findings.forEach(f => { if (f.severity === "error") row.errors++; if (f.severity === "warning") row.warnings++; }); }
                    else {
                        wbRes = X.workbookToModel(wb, { domains: DOMAINS, bounds: BOUNDS, qc: _settings.qc, duplicates: _settings.duplicates });
                        wbRes.findings.forEach(f => { if (f.severity === "error") row.errors++; if (f.severity === "warning") row.warnings++; });
                    }
                }
                if (pr.dxf) {
                    const text = await pr.dxf.text();
                    const info = P.collectDrawingText(text);
                    const sheets = P.checkSheets(info), geo = P.georeference(info, wbRes ? wbRes.model.structures : null);
                    const rec = wbRes ? P.reconcile(wbRes, info) : null;
                    const net = extractPipeNetwork(text), horiz = P.checkHorizontalSeparation(net), labels = P.checkPipeLabels(info, net);
                    const spacing = wbRes ? P.checkPointSpacing(net, wbRes.model) : null;
                    [sheets, geo, rec, horiz, labels, spacing].filter(Boolean).forEach(r => r.findings.forEach(f => { if (f.severity === "error") row.errors++; if (f.severity === "warning") row.warnings++; }));
                    row.onSpc = geo.findings.some(f => f.rule === "Drawing on State Plane") ? "yes" : geo.findings.some(f => /not on State Plane|partly/.test(f.rule)) ? "no" : "not determined";
                    if (rec) row.ids = Object.entries(rec.counts).map(([k, v]) => `${v} ${k}`).join(", ");
                }
            } catch (err) { row.note = `failed: ${err.message}`; }
            rows.push(row);
        }
        _lastBatch = rows;
        window.setSafeHTML(panel, `<strong>Batch: ${rows.length} project(s)</strong>
          <button class="btn btn-secondary btn-sm" id="jea-btn-batch-csv" style="margin-left:0.5rem;"><i class="fa-solid fa-file-csv"></i> Download summary CSV</button>
          <div style="overflow-x:auto;"><table class="data-table" style="width:100%; font-size:0.75rem; margin-top:0.35rem;">
            <thead><tr><th>Drawing</th><th>Workbook</th><th>Errors</th><th>Warnings</th><th>On State Plane</th><th>Workbook vs drawing</th><th>Note</th></tr></thead>
            <tbody>${rows.map(r => `<tr><td>${clean(r.drawing || "—")}</td><td>${clean(r.workbook || "—")}</td><td style="color:${r.errors ? "var(--danger)" : "inherit"};">${r.errors}</td><td>${r.warnings}</td><td>${clean(r.onSpc)}</td><td>${clean(r.ids)}</td><td>${clean(r.note)}</td></tr>`).join("")}</tbody></table></div>
          <div style="color:var(--text-secondary);">Open a project on its own (above) for its findings. ${clean(rulesLine(rulesApplied()))}</div>`);
        if (ctx && ctx.showToast) ctx.showToast(`Batch checked ${rows.length} project(s).`);
    }
    let _lastBatch = null;

    function renderSettingsView(container, ctx) {
        const X = window.JeaXlsx;
        const st = getSettings();
        const qcLabels = { latLonTolFt: "Lat/lon vs SPC (ft)", depthTolFt: "Top + depth vs grade (ft)", samePointTolFt: "Two IDs, one point (ft)", outlierFt: "Far from the job (ft)" };
        const layerOpts = sel => LAYERS.map(l => `<option value="${clean(l.name)}"${l.name === sel ? " selected" : ""}>${clean(l.name)}</option>`).join("");
        const pl = st.picklists;
        window.setSafeHTML(container, `
          <p style="font-size:0.8rem; color:var(--text-secondary); margin-top:0;">Decisions that belong to you or to JEA, not to this tool. Saved in this browser only.</p>

          <h4 style="margin:0.75rem 0 0.35rem 0;"><i class="fa-solid fa-layer-group"></i> As-built layer mapping</h4>
          <p style="font-size:0.78rem; color:var(--text-secondary); margin:0 0 0.35rem 0;">Drawing layers treated as JEA layers. <em>Inferred</em> mappings are reported but never earn a score; tick <em>Confirmed</em> once JEA (or your own standard) confirms one, and its linework then counts like a JEA layer.</p>
          <div style="overflow-x:auto;"><table class="data-table" style="width:100%; font-size:0.78rem;">
            <thead><tr><th>Drawing layer</th><th>Treated as</th><th>Source</th><th>Confirmed</th><th></th></tr></thead>
            <tbody>
              ${LAYER_ALIASES.map(a => `<tr><td><code>${clean(a.match.source)}</code></td><td>${clean(a.layer)}</td><td>built-in, inferred from the name</td>
                <td><input type="checkbox" class="jea-alias-confirm" data-src="${clean(a.match.source)}" aria-label="Confirm ${clean(a.match.source)} as ${clean(a.layer)}"${st.confirmedAliases.includes(a.match.source) ? " checked" : ""}></td><td></td></tr>`).join("")}
              ${st.layerMap.map((m, i) => `<tr><td><code>${clean(m.name)}</code></td><td>${clean(m.layer)}</td><td>yours</td>
                <td><input type="checkbox" class="jea-map-confirm" data-i="${i}" aria-label="Confirm ${clean(m.name)} as ${clean(m.layer)}"${m.confirmed ? " checked" : ""}></td>
                <td><button class="btn btn-secondary btn-sm jea-map-remove" data-i="${i}" aria-label="Remove mapping ${clean(m.name)}" title="Remove"><i class="fa-solid fa-xmark"></i></button></td></tr>`).join("")}
              <tr><td><input type="text" id="jea-map-name" placeholder="exact layer name" aria-label="Drawing layer name to map" style="width:100%;"></td>
                <td><select id="jea-map-layer" aria-label="JEA layer to treat it as">${layerOpts("W-MAIN")}</select></td><td>new</td>
                <td><input type="checkbox" id="jea-map-confirmed" aria-label="Mapping is confirmed"></td>
                <td><button class="btn btn-primary btn-sm" id="jea-btn-map-add">Add</button></td></tr>
            </tbody></table></div>

          <h4 style="margin:1rem 0 0.35rem 0;"><i class="fa-solid fa-ruler"></i> Workbook check tolerances</h4>
          <div style="display:flex; gap:0.75rem; flex-wrap:wrap;">
            ${Object.keys(qcLabels).map(k => `<div class="form-group" style="min-width:160px;"><label for="jea-qc-${k}" style="font-size:0.78rem;">${clean(qcLabels[k])}</label>
              <input type="number" step="any" min="0" id="jea-qc-${k}" value="${st.qc[k] != null ? st.qc[k] : (X ? X.QC_DEFAULTS[k] : "")}" style="width:100%;"></div>`).join("")}
          </div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" id="jea-btn-qc-save">Save tolerances</button>
            <button class="btn btn-secondary btn-sm" id="jea-btn-qc-reset">Back to this tool's defaults</button>
          </div>
          <p style="font-size:0.75rem; color:var(--text-secondary);">Defaults: ${X ? Object.keys(X.QC_DEFAULTS).map(k => `${clean(qcLabels[k])} ${X.QC_DEFAULTS[k]}`).join(" · ") : ""}. Lat/lon and depth default to JEA's positional accuracy (0.5 ft horizontal, 0.1 ft vertical — JEA Water and Wastewater Standards 2026 §501 II.1.7); the other two are this tool's.</p>

          <h4 style="margin:1rem 0 0.35rem 0;"><i class="fa-solid fa-arrows-up-down"></i> Pipe crossing minimums (inches)</h4>
          <div style="display:flex; gap:0.75rem; flex-wrap:wrap;">
            ${[["gravityAbove", "Water above gravity / storm sewer"], ["gravityAbovePreferred", "…preferred"], ["gravityBelow", "Water below gravity / storm sewer"], ["pressure", "Water and force main / reclaimed"]].map(([k, lbl]) => `<div class="form-group" style="min-width:160px;"><label for="jea-x-${k}" style="font-size:0.78rem;">${clean(lbl)}</label>
              <input type="number" step="any" min="0" id="jea-x-${k}" value="${(st.crossing && st.crossing[k] != null) ? st.crossing[k] : window.Jea24Data.CROSSING_MINIMUMS_JEA_2026[k]}" style="width:100%;"></div>`).join("")}
          </div>
          <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" id="jea-btn-x-save">Save crossing minimums</button>
            <button class="btn btn-secondary btn-sm" id="jea-btn-x-reset">Back to JEA 2026 (6 / 12 / 12 in)</button>
          </div>
          <p style="font-size:0.75rem; color:var(--text-secondary);">JEA Standards 2026 §350 III.4.4–III.4.5. Change these only for a newer JEA edition or a client's stricter rule — the audit, the workbook check and every report say which figures were used.</p>

          <h4 style="margin:1rem 0 0.35rem 0;"><i class="fa-solid fa-clone"></i> Repeated rows in the workbook</h4>
          <div class="form-group" style="max-width:340px;"><label for="jea-dup-policy" style="font-size:0.78rem;">When an ID appears on more than one sheet, keep</label>
            <select id="jea-dup-policy"><option value="first"${st.duplicates === "first" ? " selected" : ""}>the first row (sheet order)</option><option value="last"${st.duplicates === "last" ? " selected" : ""}>the last row (sheet order)</option></select></div>
          <p style="font-size:0.75rem; color:var(--text-secondary); margin-top:0;">Either way, every disagreement between the rows is listed.</p>

          <h4 style="margin:1rem 0 0.35rem 0;"><i class="fa-solid fa-list"></i> Picklists</h4>
          <p style="font-size:0.78rem; margin:0 0 0.35rem 0;">In use: <strong>${pl ? `${clean(pl.source)} (${Object.keys(pl.lists).length} list(s) replaced, loaded ${clean(pl.loadedAt.slice(0, 10))})` : "built-in JEA 2026 template lists"}</strong>.</p>
          <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
            <label for="jea-picklist-file" style="font-size:0.8rem;">Load from a JEA template workbook (.xlsx)</label>
            <input type="file" id="jea-picklist-file" accept=".xlsx" style="font-size:0.8rem;">
            <button class="btn btn-secondary btn-sm" id="jea-btn-picklist-reset"${pl ? "" : " disabled"}>Back to the built-in 2026 lists</button>
          </div>
          <div id="jea-picklist-notes" role="status" style="font-size:0.78rem; margin-top:0.35rem;"></div>
          <p style="font-size:0.75rem; color:var(--text-secondary);">Columns headed by one of the ${Object.keys(BUILTIN_DOMAINS).length} list names (or "Validation List: <name>") replace that list; lists the workbook doesn't have keep the built-in values.</p>
        `);
    }

    function saveSetting(partial, ctx, okMsg) {
        try {
            setSettings(partial);
            if (ctx && ctx.showToast && okMsg) ctx.showToast(okMsg);
            return true;
        } catch (err) {
            if (ctx && ctx.showToast) ctx.showToast(err.message, true);
            return false;
        }
    }

    function bindEvents(root, ctx) {
        // renderUI runs on every sub-tab switch, but #tab-jea24 itself stays: bind the delegated
        // listeners once (they used to pile up — one click ran its action once per earlier render).
        if (!root._jeaDelegated) {
            root._jeaDelegated = true;
            root.addEventListener("click", e => onRootClick(e, ctx));
            root.addEventListener("change", e => onRootChange(e, ctx));
        }
        bindFileInputs(root, ctx);
    }

    function onRootChange(e, ctx) {
        const t = e.target;
        if (!t || !t.classList) return;
        if (t.classList.contains("jea-alias-confirm")) {
            const src = t.getAttribute("data-src");
            const list = getSettings().confirmedAliases.filter(x => x !== src);
            if (t.checked) list.push(src);
            saveSetting({ confirmedAliases: list }, ctx, t.checked ? `Mapping ${src} confirmed.` : `Mapping ${src} back to inferred.`);
        } else if (t.classList.contains("jea-map-confirm")) {
            const map = getSettings().layerMap;
            map[+t.getAttribute("data-i")].confirmed = t.checked;
            saveSetting({ layerMap: map }, ctx);
        } else if (t.classList.contains("jea-review")) {
            if (!_lastPackage) return;
            const key = t.getAttribute("data-key");
            saveReview(_lastPackage.name, key, t.value);
            _lastPackage.sections.forEach(sec => sec.findings.forEach(f => { if (reviewKey(f) === key) f.review = t.value; }));
        } else if (t.id === "jea-dup-policy") {
            saveSetting({ duplicates: t.value }, ctx, `Repeated rows: keep the ${t.value} row.`);
        }
    }

    function onRootClick(e, ctx) {
            const t = e.target.closest("button");
            if (!t) return;

            if (t.id === "jea-sub-settings") {
                _activeSubTab = "settings";
                renderUI(ctx);
                return;
            }
            if (t.id === "jea-btn-package") { runPackageCheck(ctx); return; }
            if (t.id === "jea-btn-package-csv") {
                if (_lastPackage && window.JeaXlsx) {
                    const f = _lastPackage.findings.map(x => Object.assign({}, x, { rule: `${x.section}: ${x.rule}` }));
                    window.COGO.downloadText(`${_lastPackage.name.replace(/\.dxf$/i, "")}_package_check.csv`, window.JeaXlsx.findingsToCsv(f), "text/csv");
                }
                return;
            }
            if (t.id === "jea-btn-map-add") {
                const name = (document.getElementById("jea-map-name") || {}).value || "";
                const layer = (document.getElementById("jea-map-layer") || {}).value;
                const confirmed = !!(document.getElementById("jea-map-confirmed") || {}).checked;
                if (saveSetting({ layerMap: getSettings().layerMap.concat([{ name, layer, confirmed }]) }, ctx, `"${name.trim()}" now treated as ${layer}.`)) renderUI(ctx);
                return;
            }
            if (t.classList.contains("jea-map-remove")) {
                const map = getSettings().layerMap;
                map.splice(+t.getAttribute("data-i"), 1);
                if (saveSetting({ layerMap: map }, ctx, "Mapping removed.")) renderUI(ctx);
                return;
            }
            if (t.id === "jea-btn-qc-save") {
                const qc = {};
                for (const k of Object.keys(window.JeaXlsx.QC_DEFAULTS)) {
                    const el = document.getElementById(`jea-qc-${k}`);
                    const v = el ? String(el.value).trim() : "";
                    if (v === "") { if (ctx && ctx.showToast) ctx.showToast("Enter every tolerance (or use \"Back to this tool's defaults\").", true); return; }
                    qc[k] = Number(v);
                }
                saveSetting({ qc }, ctx, "Tolerances saved — they apply to the next workbook import.");
                return;
            }
            if (t.id === "jea-btn-x-save") {
                const crossing = {};
                for (const k of Object.keys(window.Jea24Data.CROSSING_MINIMUMS_JEA_2026)) {
                    const el = document.getElementById(`jea-x-${k}`);
                    const v = el ? String(el.value).trim() : "";
                    if (v === "") { if (ctx && ctx.showToast) ctx.showToast("Enter every crossing minimum (or use \"Back to JEA 2026\").", true); return; }
                    crossing[k] = Number(v);
                }
                saveSetting({ crossing }, ctx, "Crossing minimums saved.");
                return;
            }
            if (t.id === "jea-btn-x-reset") {
                if (saveSetting({ crossing: null }, ctx, "Crossing minimums back to JEA 2026.")) renderUI(ctx);
                return;
            }
            if (t.id === "jea-btn-qc-reset") {
                if (saveSetting({ qc: {} }, ctx, "Tolerances back to this tool's defaults.")) renderUI(ctx);
                return;
            }
            if (t.id === "jea-btn-picklist-reset") {
                if (saveSetting({ picklists: null }, ctx, "Back to the built-in 2026 picklists.")) renderUI(ctx);
                return;
            }

            if (t.id === "jea-sub-gen") {
                _activeSubTab = "gen";
                renderUI(ctx);
                return;
            }
            if (t.id === "jea-sub-audit") {
                _activeSubTab = "audit";
                renderUI(ctx);
                return;
            }
            if (t.id === "jea-sub-domains") {
                _activeSubTab = "domains";
                renderUI(ctx);
                return;
            }
            if (t.id === "jea-sub-dbsync") {
                _activeSubTab = "dbsync";
                renderUI(ctx);
                return;
            }

            if (t.id === "jea-btn-build-dxf") {
                const txt = document.getElementById("jea-model-json")?.value;
                let model = null;
                try { model = JSON.parse(txt); } catch (err) {
                    if (ctx && ctx.showToast) ctx.showToast("Invalid JSON in network model: " + err.message, true);
                    return;
                }
                const dxf = buildJeaDxf(model);
                if (window.COGO && window.COGO.downloadText) {
                    window.COGO.downloadText("JEA_AsBuilt_2026.dxf", dxf, "application/dxf");
                }
                if (ctx && ctx.showToast) ctx.showToast("Generated and downloaded JEA Civil 3D DXF.");
                return;
            }

            if (t.id === "jea-btn-export-csv") {
                const txt = document.getElementById("jea-model-json")?.value;
                let model = null;
                try { model = JSON.parse(txt); } catch (err) {
                    if (ctx && ctx.showToast) ctx.showToast("Invalid JSON in network model", true);
                    return;
                }
                const tables = generateJeaTables(model);
                if (tables["Pipe Crossing Table"] && window.COGO && window.COGO.downloadText) {
                    window.COGO.downloadText("JEA_Pipe_Crossing_Table.csv", tables["Pipe Crossing Table"], "text/csv");
                }
                if (ctx && ctx.showToast) ctx.showToast("Exported the JEA Pipe Crossing Table (CSV).");
                return;
            }

            if (t.id === "jea-btn-send-linework") {
                const txt = document.getElementById("jea-model-json")?.value;
                let model = null;
                try { model = JSON.parse(txt); } catch (err) { return; }
                if (!window.Linework || !window.Linework.loadFigures) {
                    if (ctx && ctx.showToast) ctx.showToast("Linework Editor is unavailable.", true);
                    return;
                }
                const figures = (model.pipes || []).map(p => ({
                    name: p.id,
                    code: p.subtype || "PIPE",
                    layer: p.layer || "W-MAIN",
                    closed: false,
                    pts: p.points.map(pt => ({ e: pt.e, n: pt.n, z: pt.z, name: String(pt.p) }))
                }));
                window.Linework.loadFigures(figures);
                if (ctx && ctx.showToast) ctx.showToast(`Sent ${figures.length} utility run(s) to Linework Editor.`);
                document.querySelector('.nav-btn[data-tab="tab-linework"]')?.click();
                return;
            }

            if (t.id === "jea-btn-run-audit") {
                const typed = document.getElementById("jea-audit-text")?.value;
                // a big loaded drawing isn't echoed into the text area — use it directly
                const dxfTxt = typed && typed.trim() ? typed : (_lastDrawing ? _lastDrawing.text : "");
                const prePairs = !(typed && typed.trim()) && _lastDrawing ? _lastDrawing.pairs : undefined;
                if (!dxfTxt || !dxfTxt.trim()) {
                    if (ctx && ctx.showToast) ctx.showToast("Please upload or paste DXF text first.", true);
                    return;
                }
                _lastAuditReport = auditDrawing(dxfTxt, { pairs: prePairs || undefined });
                renderAuditResults(document.getElementById("jea-audit-results-panel"), _lastAuditReport, ctx);
                if (ctx && ctx.showToast) ctx.showToast(_lastAuditReport.score == null ? `Audit completed: not scored — ${_lastAuditReport.notScoredReason}` : `Audit completed: Score ${_lastAuditReport.score}%`);
                return;
            }

            if (t.classList.contains("jea-zoom")) {
                const cmd = `_.ZOOM _C ${t.getAttribute("data-e")},${t.getAttribute("data-n")} 50`;
                if (ctx && ctx.showCopyModal) ctx.showCopyModal("Paste at the Civil 3D command line", cmd);
                return;
            }
            if (t.id === "jea-btn-fill-latlon") {
                if (!_lastWorkbookBytes || !window.JeaXlsx) return;
                window.JeaXlsx.fillLatLon(_lastWorkbookBytes.buf).then(r => {
                    const base = _lastWorkbookBytes.name.replace(/\.xlsx$/i, "");
                    const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
                    const log = [["Sheet", "Cell", "ID", "Was", "Now", "Off by (ft)"].map(q).join(",")].concat(r.changes.map(c => [c.sheet, c.cell, c.id, c.was, c.now, c.offFt].map(q).join(",")))
                        .concat(r.suspects.map(x => [x.sheet, `row ${x.row}`, x.id, `N ${x.n} E ${x.e}`, `NOT CHANGED — the northing/easting look wrong; the lat/lon gives N ${x.fromLatLon.n} E ${x.fromLatLon.e}`, ""].map(q).join(","))).join("\r\n");
                    if (r.bytes) window.COGO.downloadText(`${base}_latlon_filled.xlsx`, r.bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
                    window.COGO.downloadText(`${base}_latlon_changes.csv`, log, "text/csv");
                    if (ctx && ctx.showToast) ctx.showToast(r.changes.length ? `${r.changes.length} lat/lon cell(s) filled or corrected; ${r.suspects.length} row(s) left alone (their coordinates look wrong). The change list was downloaded too.` : `No lat/lon changes needed${r.suspects.length ? `; ${r.suspects.length} row(s) have coordinates that look wrong — see the CSV` : ""}.`);
                }).catch(err => { if (ctx && ctx.showToast) ctx.showToast("Lat/lon fill failed: " + err.message, true); });
                return;
            }
            if (t.id === "jea-btn-fix-all") {
                if (!_lastWorkbookBytes || !window.JeaXlsx) return;
                const renames = {};
                if (document.getElementById("jea-rename-ids")?.checked && _lastPackage && _lastPackage.rec) {
                    _lastPackage.rec.rows.filter(r => r.status === "variant").forEach(r => { renames[r.id] = r.drawingId; });
                }
                window.JeaXlsx.fixWorkbook(_lastWorkbookBytes.buf, { renames: Object.keys(renames).length ? renames : null }).then(r => {
                    const base = _lastWorkbookBytes.name.replace(/\.xlsx$/i, "");
                    const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
                    const log = [["Fix", "Sheet", "Cell", "ID", "Was", "Now"].map(q).join(",")].concat(r.changes.map(c => [c.kind, c.sheet, c.cell, c.id, c.was, c.now].map(q).join(",")))
                        .concat(r.suspects.map(x => ["not changed", x.sheet, `row ${x.row}`, x.id, `N ${x.n} E ${x.e}`, `the northing/easting look wrong; the lat/lon gives N ${x.fromLatLon.n} E ${x.fromLatLon.e}`].map(q).join(","))).join("\r\n");
                    if (r.bytes) window.COGO.downloadText(`${base}_fixed.xlsx`, r.bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
                    window.COGO.downloadText(`${base}_fixes.csv`, log, "text/csv");
                    const by = {};
                    r.changes.forEach(c => { by[c.kind] = (by[c.kind] || 0) + 1; });
                    if (ctx && ctx.showToast) ctx.showToast(r.changes.length ? `Fixed: ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(", ")}; ${r.suspects.length} row(s) left alone. The change list was downloaded too.` : "No fixes needed.");
                }).catch(err => { if (ctx && ctx.showToast) ctx.showToast("Fix failed: " + err.message, true); });
                return;
            }
            if (t.id === "jea-btn-overlay") {
                if (!_lastWorkbook || !window.JeaPackage) return;
                const g = _lastPackage && _lastPackage.geo.shift && _lastPackage.geo.shift.groups && _lastPackage.geo.shift.groups[0];
                const ov = window.JeaPackage.overlayModel(_lastWorkbook.res.model, g && g.distance > 1 ? g : null);
                window.COGO.downloadText(`${_lastWorkbook.name.replace(/\.xlsx$/i, "")}_overlay.dxf`, buildJeaDxf(ov), "application/dxf");
                if (ctx && ctx.showToast) ctx.showToast(`Overlay: ${ov.structures.length + ov.crossings.length} point(s) on layer JEA-OVERLAY${g && g.distance > 1 ? `, moved by the drawing's shift (ΔE ${g.dE.toFixed(2)}, ΔN ${g.dN.toFixed(2)})` : ""}. XREF it over the drawing.`);
                return;
            }
            if (t.id === "jea-btn-zip") {
                if (!_lastPackage || !window.JeaPackage) return;
                (async () => {
                    const base = _lastPackage.name.replace(/\.dxf$/i, "");
                    const files = [];
                    (_packageFiles.pdfFiles || []).forEach(f => files.push({ name: f.name, data: f.data }));
                    if (_lastWorkbookBytes) files.push({ name: _lastWorkbookBytes.name, data: new Uint8Array(_lastWorkbookBytes.buf) });
                    files.push({ name: `${base}_readiness.html`, data: window.JeaPackage.readinessReport({ title: `JEA submittal readiness — ${_lastPackage.name}`, drawingName: _lastPackage.name, workbookName: _lastWorkbook ? _lastWorkbook.name : null, rules: rulesLine(rulesApplied()), sections: _lastPackage.sections }) });
                    files.push({ name: `${base}_findings.csv`, data: window.JeaXlsx.findingsToCsv(_lastPackage.findings.map(x => Object.assign({}, x, { rule: `${x.section}: ${x.rule}` }))) });
                    const systems = new Set(((_lastWorkbook && _lastWorkbook.res.model.structures) || []).map(x => x.source && x.source.system).filter(Boolean));
                    files.push({ name: `${base}_transmittal_checklist_draft.md`, data: window.JeaPackage.draftSubmittalForms({ projectName: _lastWorkbook ? _lastWorkbook.res.model.projectName : "", sheets: _lastPackage.sheets, hasPdf: !!(_packageFiles.pdfs && _packageFiles.pdfs.length), workbookErrors: _lastWorkbook ? _lastWorkbook.res.findings.filter(x => x.severity === "error").length : null, utilities: Array.from(systems).map(x => x === "Sewer" ? "Wastewater" : x === "Reclaimed" ? "Reclaimed Water" : x === "Chilled" ? "Chilled Water" : x), rules: rulesLine(rulesApplied()) }) });
                    window.COGO.downloadText(`${base}_submittal_package.zip`, window.JeaPackage.packageZip(files), "application/zip");
                    if (ctx && ctx.showToast) ctx.showToast(`Submittal package: ${files.length} file(s)${(_packageFiles.pdfFiles || []).length ? "" : " (add the PDF set under Package files to include it)"}. The DWG isn't included — the browser only has the DXF.`);
                })().catch(err => { if (ctx && ctx.showToast) ctx.showToast("Package zip failed: " + err.message, true); });
                return;
            }
            if (t.id === "jea-btn-xlsx-tables") {
                const txt = document.getElementById("jea-model-json")?.value;
                let model;
                try { model = JSON.parse(txt); } catch (err) { if (ctx && ctx.showToast) ctx.showToast("Invalid JSON in network model: " + err.message, true); return; }
                try {
                    const o = window.JeaXlsx.modelToJeaWorkbook(Object.assign({ pipePoints: (_lastWorkbook && _lastWorkbook.res.model.pipePoints) || [] }, model), RULES);
                    window.COGO.downloadText(`${(model.projectName || "JEA").replace(/[^\w -]+/g, "").trim() || "JEA"}_asset_tables_2026.xlsx`, o.bytes, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
                    if (ctx && ctx.showToast) ctx.showToast(`JEA 2026 asset tables: ${Object.entries(o.counts).map(([k, v]) => `${v} ${k}`).join(", ")}. Blank cells are values the model doesn't hold — fill them before submitting.`);
                } catch (err) { if (ctx && ctx.showToast) ctx.showToast(err.message, true); }
                return;
            }
            if (t.id === "jea-btn-batch-csv") {
                if (!_lastBatch || !window.JeaXlsx) return;
                const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
                const csv = [["Drawing", "Workbook", "Errors", "Warnings", "On State Plane", "Workbook vs drawing", "Note"].map(q).join(",")]
                    .concat(_lastBatch.map(r => [r.drawing, r.workbook, r.errors, r.warnings, r.onSpc, r.ids, r.note].map(q).join(","))).concat([q(rulesLine(rulesApplied()))]).join("\r\n");
                window.COGO.downloadText("jea_batch_package_check.csv", csv, "text/csv");
                return;
            }
            if (t.id === "jea-btn-readiness") {
                if (!_lastPackage || !window.JeaPackage) return;
                const html = window.JeaPackage.readinessReport({ title: `JEA submittal readiness — ${_lastPackage.name}`, drawingName: _lastPackage.name, workbookName: _lastWorkbook ? _lastWorkbook.name : null, rules: rulesLine(rulesApplied()), sections: _lastPackage.sections });
                window.COGO.downloadText(`${_lastPackage.name.replace(/\.dxf$/i, "")}_readiness.html`, html, "text/html");
                if (window.Reports && window.Reports.addReport) {
                    const errs = _lastPackage.sections.reduce((n, s0) => n + s0.findings.filter(f => f.severity === "error").length, 0);
                    window.Reports.addReport({ title: `JEA readiness — ${_lastPackage.name}`, type: "jea_readiness", category: "audit", format: "html", content: html, metadata: { rules: rulesApplied(), errors: errs } });
                }
                if (ctx && ctx.showToast) ctx.showToast("Readiness report downloaded and saved to the Reports Hub.");
                return;
            }
            if (t.id === "jea-btn-forms") {
                if (!_lastPackage || !window.JeaPackage) return;
                const systems = new Set(((_lastWorkbook && _lastWorkbook.res.model.structures) || []).map(x => x.source && x.source.system).filter(Boolean));
                const md = window.JeaPackage.draftSubmittalForms({
                    projectName: _lastWorkbook ? _lastWorkbook.res.model.projectName : "", sheets: _lastPackage.sheets,
                    hasPdf: !!(_packageFiles.pdfs && _packageFiles.pdfs.length), workbookErrors: _lastWorkbook ? _lastWorkbook.res.findings.filter(f => f.severity === "error").length : null,
                    utilities: Array.from(systems).map(x => x === "Sewer" ? "Wastewater" : x === "Reclaimed" ? "Reclaimed Water" : x === "Chilled" ? "Chilled Water" : x), rules: rulesLine(rulesApplied())
                });
                window.COGO.downloadText(`${_lastPackage.name.replace(/\.dxf$/i, "")}_transmittal_checklist_draft.md`, md, "text/markdown");
                return;
            }
            if (t.id === "jea-btn-move-scr") {
                const g = _lastPackage && _lastPackage.geo.shift && _lastPackage.geo.shift.groups[0];
                if (!g) return;
                try {
                    window.COGO.downloadText(`${_lastPackage.name.replace(/\.dxf$/i, "")}_move_to_state_plane.scr`, window.JeaPackage.moveScript(g), "text/plain");
                    if (ctx && ctx.showToast) ctx.showToast(`Script moves model space by ΔE ${g.dE.toFixed(2)}, ΔN ${g.dN.toFixed(2)} ft. Run it on a copy, then re-check the drawing.`);
                } catch (err) { if (ctx && ctx.showToast) ctx.showToast(err.message, true); }
                return;
            }
            if (t.id === "jea-btn-qc-csv") {
                if (!_lastImportFindings || !window.JeaXlsx) return;
                const base = _lastImportFindings.name.replace(/\.xlsx$/i, "");
                window.COGO.downloadText(`${base}_workbook_QC.csv`, window.JeaXlsx.findingsToCsv(_lastImportFindings.findings), "text/csv");
                return;
            }

            if (t.id === "jea-btn-extract-pipes") {
                const typed = document.getElementById("jea-audit-text")?.value;
                const dxfTxt = typed && typed.trim() ? typed : (_lastDrawing ? _lastDrawing.text : "");
                const prePairs = !(typed && typed.trim()) && _lastDrawing ? _lastDrawing.pairs : undefined;
                if (!dxfTxt || !dxfTxt.trim()) {
                    if (ctx && ctx.showToast) ctx.showToast("Load or paste a DXF first.", true);
                    return;
                }
                const ex = extractPipeNetwork(parseDxf(dxfTxt, prePairs));
                const notes = document.getElementById("jea-import-notes");
                if (ex.error || !ex.model.pipes.length) {
                    if (notes) window.setSafeHTML(notes, `No pipe linework found on a recognised layer${ex.error ? " (" + clean(ex.error) + ")" : ""}. Recognised: the template layers (W-MAIN, SS-GRAV…) and the inferred as-built layers listed in <code>LAYER_ALIASES</code>.`);
                    if (ctx && ctx.showToast) ctx.showToast("No pipe network found on a recognised layer.", true);
                    return;
                }
                _modelOverride = ex.model;
                const lay = Object.keys(ex.stats.byLayer).map(l => `${clean(l)} ×${ex.stats.byLayer[l]}`).join(", ");
                if (notes) window.setSafeHTML(notes, `Extracted <strong>${ex.stats.pipes}</strong> pipe run(s), ${ex.stats.vertices} vertices (${lay}). Geometry only — size, material and class are not in the linework and are left blank. Open <em>Drawing Builder</em> to build, export or send to the Linework Editor.`);
                if (ctx && ctx.showToast) ctx.showToast(`Extracted ${ex.stats.pipes} pipe run(s).`);
                return;
            }

            if (t.id === "jea-btn-audit-pass") {
                const passDxf = buildJeaDxf(getSampleNetwork());
                const area = document.getElementById("jea-audit-text");
                if (area) area.value = passDxf;
                _auditTextGenerated = true;
                _lastAuditReport = auditDrawing(passDxf);
                renderAuditResults(document.getElementById("jea-audit-results-panel"), _lastAuditReport, ctx);
                if (ctx && ctx.showToast) ctx.showToast("Loaded compliant JEA sample drawing (100% Score)");
                return;
            }

            if (t.id === "jea-btn-audit-fail") {
                const failNet = getSampleNetwork();
                failNet.crossings = [{
                    id: "X-FAIL",
                    block: "JEA_CROSSING",
                    layer: "UTIL-CROSS",
                    e: 436350.80,
                    n: 2154320.10,
                    z: 22.15,
                    attribs: {
                        CROSS_NO: "CR-FAIL-01",
                        UPPER_TYPE: "Gravity Sewer",
                        UPPER_SIZE: "8",
                        UPPER_BOT_ELEV: "21.48",
                        LOWER_TYPE: "Potable Water",
                        LOWER_SIZE: "8",
                        LOWER_TOP_ELEV: "20.90", // 21.48 - 20.90 = 0.58 ft = 7.0 in; a water main under a sewer needs 12 in (§350 III.4.4)
                        CLEARANCE_INCHES: "7.0",
                        COMPLIANT: "NO"
                    }
                }];
                failNet.structures[0].attribs.VALVE_TYPE = "Invalid Valve Type XYZ";

                const failDxf = buildJeaDxf(failNet);
                const area = document.getElementById("jea-audit-text");
                if (area) area.value = failDxf;
                _auditTextGenerated = true;
                _lastAuditReport = auditDrawing(failDxf);
                renderAuditResults(document.getElementById("jea-audit-results-panel"), _lastAuditReport, ctx);
                if (ctx && ctx.showToast) ctx.showToast('Loaded violation sample (water main 7" under a sewer; 12" required)');
                return;
            }
    }

    function bindFileInputs(root, ctx) {
        root.querySelector("#jea-shots-file")?.addEventListener("change", async e => {
            const f = e.target.files && e.target.files[0];
            if (!f || !window.JeaPackage) return;
            const r = window.JeaPackage.parseShots(await f.text());
            _surveyShots = { name: f.name, shots: r.shots };
            if (ctx && ctx.showToast) ctx.showToast(`${r.shots.length} shot(s) read from ${f.name}${r.swapped ? " (read as P,E,N — the second column was the easting)" : ""}${r.skipped ? `; ${r.skipped} line(s) skipped` : ""}. Click Check Package.`);
        });
        root.querySelector("#jea-prev-file")?.addEventListener("change", async e => {
            const f = e.target.files && e.target.files[0];
            if (!f || !window.JeaXlsx) return;
            try {
                const wb = await window.JeaXlsx.readWorkbook(await f.arrayBuffer());
                _prevWorkbook = { name: f.name, res: window.JeaXlsx.workbookToModel(wb, { domains: DOMAINS, bounds: BOUNDS, qc: _settings.qc, duplicates: _settings.duplicates }) };
                if (ctx && ctx.showToast) ctx.showToast(`Previous submittal ${f.name} loaded — Check Package compares it with the current workbook.`);
            } catch (err) { if (ctx && ctx.showToast) ctx.showToast(`${f.name}: ${err.message}`, true); }
        });
        root.querySelector("#jea-batch-files")?.addEventListener("change", e => {
            const list = Array.from(e.target.files || []);
            if (list.length) runBatch(list, ctx).catch(err => { if (ctx && ctx.showToast) ctx.showToast("Batch failed: " + err.message, true); });
        });
        root.querySelector("#jea-package-files")?.addEventListener("change", async e => {
            const list = Array.from((e.target.files) || []);
            if (!list.length || !window.JeaPackage) return;
            const next = { transmittal: null, pdfs: [] };
            for (const f of list) {
                try {
                    if (/\.pdf$/i.test(f.name)) {
                        const buf = await f.arrayBuffer();
                        next.pdfs.push(Object.assign({ name: f.name }, await window.JeaPackage.pdfPageCount(buf)));
                        (next.pdfFiles = next.pdfFiles || []).push({ name: f.name, data: new Uint8Array(buf) });
                    }
                    else if (/\.txt$/i.test(f.name)) next.transmittal = { name: f.name, text: await f.text() };
                } catch (err) {
                    if (ctx && ctx.showToast) ctx.showToast(`${f.name}: ${err.message}`, true);
                }
            }
            _packageFiles = next;
            if (ctx && ctx.showToast) ctx.showToast(`Package files: ${next.pdfs.length} PDF(s)${next.transmittal ? " and the transmittal" : ""} — click Check Package.`);
        });
        root.querySelector("#jea-audit-text")?.addEventListener("input", () => {
            // typed or pasted text replaces whatever drawing was loaded
            _lastDrawing = null;
            _auditTextGenerated = false;
        });
        root.querySelector("#jea-picklist-file")?.addEventListener("change", async e => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            const notes = document.getElementById("jea-picklist-notes");
            try {
                const wb = await window.JeaXlsx.readWorkbook(await file.arrayBuffer());
                const ex = window.JeaXlsx.extractPicklists(wb, Object.keys(BUILTIN_DOMAINS));
                const names = Object.keys(ex.lists);
                if (!names.length) throw new Error("no column in this workbook is headed by one of the JEA list names.");
                const changed = names.filter(k => JSON.stringify(ex.lists[k]) !== JSON.stringify(BUILTIN_DOMAINS[k]));
                if (!saveSetting({ picklists: { source: file.name, loadedAt: new Date().toISOString(), lists: ex.lists } }, ctx, `Loaded ${names.length} picklist(s) from ${file.name}.`)) return;
                renderUI(ctx);
                const n2 = document.getElementById("jea-picklist-notes");
                if (n2) window.setSafeHTML(n2, `Found ${names.length} of ${Object.keys(BUILTIN_DOMAINS).length} lists (${changed.length} differ from the built-in 2026 values${changed.length ? ": " + clean(changed.slice(0, 8).join(", ")) + (changed.length > 8 ? ", …" : "") : ""}). Not in the workbook (built-in kept): ${clean(ex.missing.slice(0, 8).join(", ")) || "none"}${ex.missing.length > 8 ? ", …" : ""}.`);
            } catch (err) {
                if (notes) window.setSafeHTML(notes, `<span style="color:var(--danger);">Picklists not loaded: ${clean(err.message)}</span>`);
            }
        });

        root.querySelector("#jea-model-xlsx")?.addEventListener("change", async e => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            try {
                const res = await importXlsxFile(file);
                if (res.pumpStation) { renderPumpNotes(document.getElementById("jea-model-import-notes"), file, res.pumpStation); return; }
                const area = document.getElementById("jea-model-json");
                if (area) area.value = JSON.stringify(res.model, null, 2);
                _modelOverride = res.model;
                _lastWorkbook = { name: file.name, res };
                renderImportNotes(document.getElementById("jea-model-import-notes"), file, res);
                if (ctx && ctx.showToast) ctx.showToast(`Imported ${res.stats.imported} As-Built items from ${file.name}.`);
            } catch (err) {
                if (ctx && ctx.showToast) ctx.showToast("Excel import failed: " + err.message, true);
            }
        });

        const fileInput = root.querySelector("#jea-audit-file");
        fileInput?.addEventListener("change", async e => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            if (/\.dwg$/i.test(file.name)) {
                const notes = document.getElementById("jea-import-notes");
                if (notes) window.setSafeHTML(notes, `<strong>${clean(file.name)}</strong> is a DWG, which a browser can't read. In Civil 3D run <code>DXFOUT</code> and save as <em>AutoCAD 2018 DXF</em> (ASCII), then load that file.`);
                if (ctx && ctx.showToast) ctx.showToast("DWG can't be read in the browser — export a DXF (DXFOUT) first.", true);
                return;
            }
            if (/\.xlsx$/i.test(file.name)) {
                try {
                    const res = await importXlsxFile(file);
                    if (res.pumpStation) { renderPumpNotes(document.getElementById("jea-import-notes"), file, res.pumpStation); return; }
                    _modelOverride = res.model;
                    _lastWorkbook = { name: file.name, res };
                    const dxf = buildJeaDxf(res.model);
                    const area = document.getElementById("jea-audit-text");
                    if (area) area.value = dxf;
                    _auditTextGenerated = true;
                    renderImportNotes(document.getElementById("jea-import-notes"), file, res);
                    _lastAuditReport = auditDrawing(dxf);
                    renderAuditResults(document.getElementById("jea-audit-results-panel"), _lastAuditReport, ctx);
                } catch (err) {
                    if (ctx && ctx.showToast) ctx.showToast("Excel import failed: " + err.message, true);
                }
                return;
            }
            const reader = new FileReader();
            reader.onload = async evt => {
                const txt = evt.target.result;
                _lastDrawing = { name: file.name, text: txt };
                _auditTextGenerated = false;
                const area = document.getElementById("jea-audit-text");
                const notes = document.getElementById("jea-import-notes");
                if (txt.length > 2e6) {
                    // big drawing: read it in the background, so the page doesn't freeze
                    if (notes) window.setSafeHTML(notes, `<i class="fa-solid fa-spinner fa-spin"></i> Reading <strong>${clean(file.name)}</strong> (${(txt.length / 1e6).toFixed(0)} MB) in the background…`);
                    _lastDrawing.pairs = await tokenizeInBackground(txt);
                    if (notes) window.setSafeHTML(notes, `<strong>${clean(file.name)}</strong> read (${(txt.length / 1e6).toFixed(0)} MB${_lastDrawing.pairs ? ", in the background" : ""}).`);
                }
                // a big drawing's text is not echoed into the text area (it would freeze the page)
                if (area) area.value = txt.length > 2e6 ? "" : txt;
                if (area && txt.length > 2e6) area.placeholder = `${file.name} is loaded (too large to show here).`;
                _lastAuditReport = auditDrawing(txt, { pairs: _lastDrawing.pairs || undefined });
                renderAuditResults(document.getElementById("jea-audit-results-panel"), _lastAuditReport, ctx);
            };
            reader.readAsText(file);
        });
    }

    const Plugin = {
        init(ctx) {
            renderUI(ctx);
        },
        onTabActivate(ctx) {
            renderUI(ctx);
        }
    };

    // Public API
    window.Jea24 = {
        MANIFEST,
        BOUNDS,
        LAYERS,
        DOMAINS,
        RULES,
        BLOCK_DEFS,
        CLIENT_TEMPLATE,
        LAYER_ALIASES,
        resolveLayer,
        extractPipeNetwork,
        getSampleNetwork,
        buildJeaDxf,
        parseDxf,
        auditDrawing,
        generateJeaTables,
        exportAuditReportToReports,
        syncTemplateWithDb,
        addAsClientTemplate,
        importXlsxFile,
        rulesApplied,
        pairByName,
        /** From Easy Button: use its field data as the workbook and its shots as the survey, on the auditor tab. */
        setPackageInputs({ workbookName, model, shots }) {
            const res = { model, findings: window.JeaXlsx ? window.JeaXlsx.qcStructures(model.structures || [], { qc: _settings.qc }) : [], stats: { imported: (model.structures || []).length + (model.crossings || []).length } };
            _lastWorkbook = { name: workbookName || "field data", res }; // the package check's input only — the Drawing Builder keeps its own model
            if (shots) _surveyShots = { name: workbookName || "field data", shots };
            _activeSubTab = "audit";
        },
        getSettings,
        setSettings,
        resetSettings,
        validateSettings,
        BUILTIN_DOMAINS
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);
})();
