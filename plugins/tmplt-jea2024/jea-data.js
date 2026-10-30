/**
 * JEA As-Built Standards 2024 — reference data for the tmplt-jea2024 plugin.
 * plugins/tmplt-jea2024/jea-data.js
 *
 * Pure data (no DOM, no dependencies): coordinate bounds, the client-template
 * defaults, layers, attribute domains, audit rules and block attribute lists.
 * Split out of tmplt-jea2024.js so the plugin file is about behaviour. Must load
 * before plugins/tmplt-jea2024/tmplt-jea2024.js (index.html / tests/_env.js).
 *
 * The 45 picklists (DOMAINS) match the JEA As Built Template 2026 ("Validation Lists" sheet); the
 * 2026 template changed two of them from 2024 — Manhole Manufacturer and Valve Type. Other values here
 * (layers, block tags, rules) are illustrative and unverified — check against the current JEA
 * standard before relying on it.
 */
(function () {
    "use strict";

    // ═════════════════════════════════════════════════════════════════════
    // 1. JEA Standards Specifications & Reference Data
    // ═════════════════════════════════════════════════════════════════════

    const BOUNDS = {
        projection: "FL_EAST_83",
        eastingMin: 320000,
        eastingMax: 590000,
        northingMin: 1920000,
        northingMax: 2370000,
        latMin: 29.0,
        latMax: 31.0,
        lonMin: -83.0,
        lonMax: -80.0
    };

    // Pipe crossing vertical separation — JEA Water and Wastewater Standards, Volume 1, Section 350
    // (Potable Water Piping), III.4 Required Pipe Separations, revised January 1, 2026 (the same
    // figures as Rule 62-555.314, F.A.C.):
    //   III.4.4  a water main crossing a gravity or vacuum sanitary sewer or a storm sewer: the outside
    //            of the water main at least 6 in (preferably 12 in) above, or at least 12 in below, the
    //            outside of the other pipe;
    //   III.4.5  a water main crossing a pressure sewer, force main or reclaimed water pipe: at least
    //            12 in above or below.
    // A crossing with no water main in it has no vertical separation rule there. (Earlier versions of
    // this tool applied one 18-inch minimum to every crossing; that figure is not in JEA's standards.)
    const CROSSING_RULE_SOURCE = "JEA Water and Wastewater Standards (rev. Jan 1, 2026), Vol. 1 §350 III.4.4–III.4.5";
    const crossingKind = t => {
        const s = String(t || "").toUpperCase();
        if (/RECLAIM/.test(s) || /FORCE|PRESSURE/.test(s)) return "pressure";
        if (/POTABLE|^WATER\b|WATER MAIN/.test(s) && !/CHILL/.test(s)) return "water";
        if (/GRAVITY|VACUUM|STORM|SANITARY/.test(s)) return "gravity";
        return null;
    };
    /**
     * The separation a crossing needs, from the two pipe types (JEA "Crossing Pipe Type" values).
     * @returns {{ applies: true, minInches, preferredInches?, waterAbove, rule, source }
     *         | { applies: false, reason, source }}
     */
    // JEA's figures, in inches; Settings can replace them (e.g. when JEA publishes its 2027 update).
    const CROSSING_MINIMUMS_JEA_2026 = Object.freeze({ gravityAbove: 6, gravityAbovePreferred: 12, gravityBelow: 12, pressure: 12 });
    let crossingMinimums = Object.assign({}, CROSSING_MINIMUMS_JEA_2026), crossingSource = CROSSING_RULE_SOURCE;
    /** Replace the crossing minimums (inches) — null restores JEA's 2026 figures. Each must be a positive number. */
    function setCrossingMinimums(m) {
        if (m == null) { crossingMinimums = Object.assign({}, CROSSING_MINIMUMS_JEA_2026); crossingSource = CROSSING_RULE_SOURCE; return; }
        const next = Object.assign({}, CROSSING_MINIMUMS_JEA_2026);
        Object.keys(m).forEach(k => {
            if (!(k in CROSSING_MINIMUMS_JEA_2026)) throw new Error(`Unknown crossing minimum "${k}".`);
            const v = m[k];
            if (typeof v !== "number" || !isFinite(v) || v <= 0 || v > 120) throw new Error(`Crossing minimum "${k}" must be a number of inches between 0 and 120.`);
            next[k] = v;
        });
        crossingMinimums = next;
        const changed = Object.keys(next).filter(k => next[k] !== CROSSING_MINIMUMS_JEA_2026[k]);
        crossingSource = changed.length ? `minimums set in Settings (${changed.map(k => `${k} ${next[k]} in`).join(", ")}; JEA 2026 §350: 6 / 12 / 12 in)` : CROSSING_RULE_SOURCE;
    }

    function crossingRequirement(upperType, lowerType) {
        const u = crossingKind(upperType), l = crossingKind(lowerType);
        const source = crossingSource, M = crossingMinimums;
        if (!u || !l) return { applies: false, reason: `pipe type ${!u ? `"${upperType || ""}"` : `"${lowerType || ""}"`} is not one the rule names`, source };
        if (u === "water" && l === "water") return { applies: false, reason: "two water mains — the rule sets no vertical separation between them", source };
        if (u !== "water" && l !== "water") return { applies: false, reason: "no water main in the crossing — §350 III.4 sets no vertical separation for it", source };
        const waterAbove = u === "water", other = waterAbove ? l : u;
        if (other === "gravity") {
            return waterAbove
                ? { applies: true, minInches: M.gravityAbove, preferredInches: M.gravityAbovePreferred, waterAbove, rule: "III.4.4", source }
                : { applies: true, minInches: M.gravityBelow, waterAbove, rule: "III.4.4", source };
        }
        return { applies: true, minInches: M.pressure, waterAbove, rule: "III.4.5", source };
    }

    // JEA Water and Wastewater Standards 2026, Section 501 II.1.7 (also III.1.2, III.2.2, III.4.2):
    // "The positional accuracy relative to the referenced published control points used shall not
    // exceed 0.5' horizontally and 0.1' vertically. Elevations relative to the site facilities must be
    // within 0.1' of each other."
    const ACCURACY = { horizontalFt: 0.5, verticalFt: 0.1, source: "JEA Water and Wastewater Standards (rev. Jan 1, 2026), Vol. 1 §501 II.1.7" };

    // The single definition of "the JEA 2024 template" — what addAsClientTemplate() writes into
    // the signed-in user's local Client Master Templates (window.BoundaryQCCMS) and what
    // syncTemplateWithDb() pushes to the PostgreSQL client_templates table. Built from BOUNDS
    // rather than repeating its numbers, so there's one source of truth for both.
    const CLIENT_TEMPLATE = {
        id: "tpl_jea_2024",
        clientName: "JEA",
        label: "JEA As-Built Standards 2026",
        settings: {
            discipline: "UTILITY",
            projection: BOUNDS.projection,
            crossingRule: CROSSING_RULE_SOURCE,
            eastingMin: BOUNDS.eastingMin,
            eastingMax: BOUNDS.eastingMax,
            northingMin: BOUNDS.northingMin,
            northingMax: BOUNDS.northingMax,
            sheetDwt: "JEA_AsBuilt_2026.dwt",
            county: "Duval",
            district: 2,
            rulesVersion: "2026.1"
        }
    };

    const LAYERS = [
        { name: "W-MAIN", color: 4, desc: "Water Distribution & Transmission Mains" },
        { name: "W-VALV", color: 5, desc: "Water Gate/Butterfly/ARV Valves" },
        { name: "W-HYDR", color: 2, desc: "Water Fire Hydrants" },
        { name: "W-FITT", color: 6, desc: "Water Fittings (Tee, Cross, Reducer, Bend)" },
        { name: "W-METR", color: 3, desc: "Water Service Meters & Backflow Units" },
        { name: "W-LOC8", color: 1, desc: "Water Locate Wire Boxes & Marker Balls" },
        { name: "SS-GRAV", color: 3, desc: "Sanitary Gravity Sewer Mains" },
        { name: "SS-FM", color: 30, desc: "Sanitary Sewer Force Mains & Low Pressure" },
        { name: "SS-MANH", color: 1, desc: "Sanitary Sewer Manholes" },
        { name: "SS-VALV", color: 5, desc: "Sewer Valves (Plug, Gate, Air Release)" },
        { name: "SS-FITT", color: 6, desc: "Sewer Fittings & Cleanouts" },
        { name: "SS-METR", color: 3, desc: "Sewer Customer Points & Flow Meters" },
        { name: "SS-LOC8", color: 1, desc: "Sewer Locate Wire Boxes & Marker Balls" },
        { name: "RW-MAIN", color: 210, desc: "Reclaimed Water Distribution Mains" },
        { name: "RW-VALV", color: 5, desc: "Reclaimed Water Valves" },
        { name: "RW-HYDR", color: 2, desc: "Reclaimed Water Hydrants" },
        { name: "RW-METR", color: 3, desc: "Reclaimed Water Meters" },
        { name: "RW-FITT", color: 6, desc: "Reclaimed Water Fittings" },
        { name: "CW-MAIN", color: 140, desc: "Chilled Water Supply & Return Mains" },
        { name: "UTIL-CROSS", color: 7, desc: "Utility Pipe Crossing Markers & Labels" }
    ];

    const DOMAINS = {
    "Subtype Chilled Fitting": [
        "Cross",
        "Elbow 11.25",
        "Elbow 22.5",
        "Elbow 45",
        "Elbow 90",
        "Plug",
        "Reducer",
        "Repair Coupling",
        "Sleeve",
        "Tapping Sleeve",
        "Tee",
        "Transition Coupling",
        "Other",
        "Unknown Fitting",
        "Vertical"
    ],
    "Subtype Locate Box": [
        "Marker Ball",
        "Locate Wire Box"
    ],
    "Subtype Manhole": [
        "Collection",
        "Effluent",
        "Force Main",
        "Low Pressure",
        "Trunk"
    ],
    "Subtype Reclaimed Fitting": [
        "Cross",
        "Elbow 11.25",
        "Elbow 22.5",
        "Elbow 45",
        "Elbow 90",
        "Lateral Main Connection",
        "Plug",
        "Reducer",
        "Repair Coupling",
        "Service Lateral Fitting",
        "Sleeve",
        "Tapping Sleeve",
        "Tapping Saddle",
        "Tee",
        "Transition Coupling",
        "WYE",
        "Other",
        "Unknown Fitting",
        "Vertical",
        "Cap, Tapped",
        "Stub",
        "Cap"
    ],
    "Subtype Reclaimed Meter": [
        "Control Meter",
        "Major Meter",
        "Minor Meter",
        "Plant Meter"
    ],
    "Subtype Reclaimed Pipe": [
        "Augmentation Main",
        "Hydrant Lateral",
        "Reclaimed Main",
        "Service Lateral"
    ],
    "Subtype Reclaimed Valve": [
        "Valve",
        "Backflow Preventor",
        "Hydrant Valve"
    ],
    "Subtype Sewer Customer Point": [
        "Customer Point",
        "Sewer Flow Meter"
    ],
    "Subtype Sewer Fitting": [
        "Cleanout",
        "Cross",
        "Elbow 11.25",
        "Elbow 22.5",
        "Elbow 45",
        "Elbow 90",
        "Lateral Main Connection",
        "Other",
        "Plug",
        "Reducer",
        "Repair Coupling",
        "Service Lateral Fitting",
        "Sleeve",
        "Stub",
        "Tapping Sleeve",
        "Tapping Saddle",
        "Tee",
        "Transition Coupling",
        "Unknown Fitting",
        "Vertical",
        "WYE",
        "Cap, Tapped",
        "Cap"
    ],
    "Subtype Sewer Gravity Pipe": [
        "Collection Main",
        "Trunk Main",
        "Collection Lateral"
    ],
    "Subtype Sewer Pressure Pipe": [
        "Force Main",
        "Low Pressure Main",
        "Vacuum Main",
        "Sludge Main",
        "Effluent Main",
        "Plant Pipe",
        "Low Pressure Lateral",
        "Vacuum Lateral"
    ],
    "Subtype Sewer Valve": [
        "Valve",
        "Pump Out",
        "Air Release Valve"
    ],
    "Subtype Water Fitting": [
        "Cross",
        "Elbow 11.25",
        "Elbow 22.5",
        "Elbow 45",
        "Elbow 90",
        "Lateral Main Connection",
        "Plug",
        "Reducer",
        "Repair Coupling",
        "Service Lateral Fitting",
        "Sleeve",
        "Tapping Sleeve",
        "Tapping Saddle",
        "Tee",
        "Transition Coupling",
        "Vertical",
        "WYE",
        "Other",
        "Unknown Fitting",
        "Cap, Tapped",
        "Stub",
        "Cap"
    ],
    "Subtype Water Meter": [
        "Interconnect",
        "Major Meter",
        "Minor Meter",
        "Plant Meter",
        "Irrigation Meter",
        "Fire Meter"
    ],
    "Subtype Water Pipe": [
        "Distribution Main",
        "Fire Line Main",
        "Raw Water Main",
        "Transmission Main",
        "Service Lateral",
        "Hydrant Lateral"
    ],
    "Subtype Water Valve": [
        "Valve",
        "Backflow Preventor",
        "Hydrant Valve",
        "Air Release Valve"
    ],
    "Chilled Pipe Class": [
        "CL50",
        "CL51",
        "DR11",
        "DR14",
        "DR17",
        "DR18",
        "DR25",
        "PC150",
        "PC250",
        "N/A",
        "Other",
        "Unknown"
    ],
    "Chilled Pipe Role": [
        "Return",
        "Supply"
    ],
    "County": [
        "Clay",
        "Duval",
        "Nassau",
        "St Johns"
    ],
    "Crossing Pipe Type": [
        "Potable Water",
        "Gravity Sewer",
        "Force Main",
        "Vacuum Sewer",
        "Reclaimed",
        "Storm"
    ],
    "Facility Owner": [
        "JEA",
        "Private",
        "Unknown"
    ],
    "Fitting Manufacturers": [
        "American Cast Iron Pipe Company",
        "Cascade Waterworks Mfg",
        "Charlotte Pipe and Foundry Co",
        "Chemtrol/NIBCO",
        "Clow Valve",
        "Dresser Inc/GE",
        "FERNCO",
        "Ford Meter Box",
        "Galaxy Plastics",
        "Georg Fisher Sloane Manufacturing",
        "GPK Products Inc",
        "Harco Inc",
        "Harrington Corporation (HARCO)",
        "Ipex",
        "JCM Industries Inc",
        "Lasco Fittings Inc",
        "M&H Valve Company",
        "Mueller",
        "Mueller Aqua Grip",
        "Mueller Company",
        "Multi-Fittings",
        "Other",
        "Plastic Trends (Royal Building Projects)",
        "Power Seal",
        "Romac",
        "Romac Industries Inc",
        "Sigma Corp (Russell Pipe)",
        "SIP Industries",
        "Smith-Blair",
        "Spears Manufacturing",
        "Star Pipe Products",
        "TigreADS USA",
        "TPS Hymax",
        "Tyler Union",
        "Unknown",
        "US Pipe"
    ],
    "Hydrant Model": [
        "American Darling",
        "American Flow",
        "AVK",
        "Clow",
        "Kennedy",
        "M&H",
        "Matthews",
        "Mueller",
        "US Pipe",
        "Waterous",
        "Other",
        "Unknown"
    ],
    "Manhole Drop Type": [
        "Outside",
        "Inside",
        "Unknown"
    ],
    "Manhole Exterior Joint Tape Manufacturer": [
        "Con Seal",
        "Rub-R-Nek/Henry Company",
        "Wrapid Seal (CCI Pipeline systems)",
        "Other",
        "Unknown"
    ],
    "Manhole Lining Material": [
        "Polyethylene",
        "Polyurethane",
        "Epoxy",
        "Fiberglass",
        "Fosroc",
        "Polyurea",
        "Spectrashield",
        "Other",
        "Unknown",
        "N/A"
    ],
    "Manhole Manufacturer": [
        "Armorock",
        "Del Zotto Precast",
        "Old Castle",
        "Rinker Materials",
        "American Precast",
        "Other",
        "Unknown"
    ],
    "Manhole Material": [
        "Brick Masonry",
        "Concrete Block",
        "Precast",
        "Cast In Place",
        "Fiberglass",
        "Polymer Concrete",
        "Unknown"
    ],
    "Manhole Type": [
        "A",
        "B",
        "C",
        "D",
        "E",
        "F",
        "G",
        "H",
        "I",
        "J",
        "Junction",
        "Special",
        "Special Meter",
        "Unknown"
    ],
    "Meter Box Manufacturer": [
        "Glassmasters",
        "Southern Meter Box",
        "Pentek",
        "Other",
        "Unknown"
    ],
    "Meter Box Material": [
        "Polymer",
        "Concrete",
        "Other",
        "Unknown"
    ],
    "Meter Size Inches": [
        "0.75",
        "1",
        "1.25",
        "1.5",
        "1.75",
        "2",
        "2.25",
        "2.5",
        "3",
        "3.5",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "10",
        "12",
        "14",
        "15",
        "16",
        "18",
        "20",
        "21",
        "22",
        "24",
        "27",
        "30",
        "36",
        "42",
        "48",
        "50",
        "54",
        "57",
        "60",
        "66",
        "72",
        "78",
        "84",
        "102",
        "120",
        "-998",
        "-999",
        "Existing"
    ],
    "Pipe and Fitting Material": [
        "Asbestos Cement",
        "Brass",
        "Brick Masonry",
        "Cast Iron",
        "Concrete",
        "Copper",
        "Ductile Iron",
        "Galvanized",
        "High Density Polyethylene",
        "Orangeburg",
        "Polybutylene",
        "Polyethylene",
        "PVC",
        "Reinforced Concrete",
        "Stainless Steel",
        "Steel",
        "Vitrified Clay",
        "Other",
        "Unknown"
    ],
    "Pipe Location": [
        "Point of Connection",
        "Top of Pipe Shot",
        "Top of Casing"
    ],
    "Pipe Manufacturers": [
        "Accord Industries",
        "Advanced Drainage System",
        "American Cast Iron Pipe Company",
        "Charlotte Pipe and Foundry Co",
        "Charter Plastics",
        "Diamond Plastics",
        "Endot Yardley",
        "Grinnell Corporation",
        "HAWK Plastics Corporation",
        "Ipex",
        "JM Eagle Manufacturing",
        "McWane Ductile",
        "National Pipe & Plastics/National PVC",
        "North American Pipe Co (NAPCO)",
        "Phillips Driscopipe/Performance Pipe",
        "Sanderson Pipe Corporation",
        "Silver-Line Plastics",
        "Universal 100 / Accord",
        "U.S. Pipe",
        "Wheatland Tube",
        "Westlake Pipe and Fittings Corporation",
        "Other",
        "Unknown"
    ],
    "Orientation": [
        "Underground",
        "Aboveground"
    ],
    "Sewer Pipe Class": [
        "CL50",
        "CL51",
        "CL52",
        "CL53",
        "CL55",
        "DR11",
        "DR14",
        "DR17",
        "DR18",
        "DR19",
        "DR25",
        "SCH40",
        "SCH80",
        "SDR21",
        "SDR35",
        "SDR26 / PR160",
        "N/A",
        "Other",
        "Unknown"
    ],
    "Sewer Pipe Lining Material": [
        "Cured in Place",
        "Epoxy",
        "Fiber Reinforced Polyester Resin",
        "Polyethylene",
        "Polyurethane",
        "N/A",
        "Unknown"
    ],
    "Size Feet": [
        "2",
        "2.67",
        "3",
        "3.5",
        "4",
        "5",
        "5.5",
        "6",
        "8",
        "10",
        "12",
        "-998",
        "-999"
    ],
    "Size Inches": [
        "0.75",
        "1",
        "1.25",
        "1.5",
        "1.75",
        "2",
        "2.25",
        "2.5",
        "3",
        "3.5",
        "4",
        "5",
        "6",
        "7",
        "8",
        "9",
        "10",
        "12",
        "14",
        "15",
        "16",
        "18",
        "20",
        "21",
        "22",
        "24",
        "27",
        "30",
        "36",
        "42",
        "48",
        "50",
        "54",
        "57",
        "60",
        "66",
        "72",
        "78",
        "84",
        "102",
        "120",
        "-998",
        "-999"
    ],
    "Valve Manufacturer": [
        "American Darling",
        "American Flow Control",
        "Ames",
        "ARI",
        "AVK",
        "Bermad",
        "Clow",
        "Dezurik",
        "H-TEC",
        "Insert-A-Valve",
        "Insta-Valve",
        "Kennedy",
        "Keystone",
        "M&H",
        "Matco-Norca",
        "Milliken",
        "Mueller",
        "NIBCO",
        "Pratt",
        "Romac",
        "US Pipe",
        "United Water Product",
        "Val-Matic",
        "Vent-O-Mat",
        "Waterous",
        "Other",
        "Unknown",
        "Crispin"
    ],
    "Valve Open Direction": [
        "Left",
        "Right",
        "N/A",
        "Unknown"
    ],
    "Valve Type": [
        "ARV",
        "BFP",
        "Ball",
        "Blow Off",
        "Butterfly",
        "Check",
        "Control Valve",
        "Corp Stop",
        "Flapper",
        "Double Disk Gate",
        "DCDA",
        "Flushing Hydrant",
        "Pitometer Gauge Point",
        "Plug",
        "Pressure Regulating",
        "Pump-Out Assembly",
        "RPDA",
        "RPZ",
        "Resilient Seat Wedge Gate",
        "Tapping",
        "Unknown"
    ],
    "Water/Reclaimed Pipe Class": [
        "CL50",
        "CL51",
        "CL52",
        "CL53",
        "CL54",
        "DR11",
        "DR14",
        "DR17",
        "DR18",
        "DR25",
        "PC150",
        "PC250",
        "PC350",
        "SCH40",
        "SCH80",
        "SDR9",
        "SDR21",
        "SDR35",
        "SDR26 / PR160",
        "N/A",
        "Other",
        "Unknown"
    ],
    "Water/Reclaimed/Chilled Pipe Lining Material": [
        "Cementitious",
        "Cured In Place",
        "N/A",
        "Unknown"
    ]
};

    const RULES = {
    "Pipe Crossing Table": [
        {
            "column": "Crossing Number",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Upper Pipe  Type",
            "rule": "Validation List: Crossing Pipe Type",
            "note": ""
        },
        {
            "column": "Upper Pipe  Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Upper Pipe  Top Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Cover to Top of Upper Pipe (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Upper Pipe  Bottom Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Lower Pipe  Type",
            "rule": "Validation List: Crossing Pipe Type",
            "note": ""
        },
        {
            "column": "Lower Pipe  Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Lower Pipe  Top Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Cover to Top of Lower Pipe (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Separation Between Pipes (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "X Coord  (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord  (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Water Pipe Run": [
        {
            "column": "Pipe Run Number (WM#)",
            "rule": "Open Text",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Subtype",
            "rule": "Validation List: Subtype Water Pipe",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Class",
            "rule": "Validation List: Water/Reclaimed Pipe Class",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Manufacturer",
            "rule": "Validation List: Pipe Manufacturers",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Lining Manufacturer",
            "rule": "Open Text",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Lining Material",
            "rule": "Validation List: Water/Reclaimed Pipe Lining Material",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Measured Length (Feet)",
            "rule": "Decimal Value",
            "note": "Note: This Table is Optional"
        }
    ],
    "Water Points along Pipe": [
        {
            "column": "Pipe Location Number (WPOC#, WPOL#, etc)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Pipe Location",
            "rule": "Validation List: Pipe Location",
            "note": ""
        },
        {
            "column": "Pipe Subtype",
            "rule": "Validation List: Subtype Water Pipe",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Pipe Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Pipe Orientation",
            "rule": "Validation List: Orientation",
            "note": ""
        },
        {
            "column": "Pipe Class",
            "rule": "Validation List: Water/Reclaimed Pipe Class",
            "note": ""
        },
        {
            "column": "Pipe Manufacturer",
            "rule": "Validation List: Pipe Manufacturers",
            "note": ""
        },
        {
            "column": "Pipe Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": ""
        },
        {
            "column": "Pipe Lining Manufacturer",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Pipe Lining Material",
            "rule": "Validation List: Water/Reclaimed Pipe Lining Material",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Pipe Top Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Pipe Cover (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Water Fitting": [
        {
            "column": "Fitting Number (WF#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Fitting Subtype",
            "rule": "Validation List: Subtype Water Fitting",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Fitting Size Primary (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Fitting Size Secondary (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Manufacturer",
            "rule": "Validation List: Fitting Manufacturers",
            "note": ""
        },
        {
            "column": "Fitting Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": ""
        },
        {
            "column": "Lining Manufacturer",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Lining Material",
            "rule": "Validation List: Water/Reclaimed Pipe Lining Material",
            "note": ""
        },
        {
            "column": "Fitting Top Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Fitting Depth (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Water Valve": [
        {
            "column": "Valve Number (WV#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Valve Subtype",
            "rule": "Validation List: Subtype Water Valve",
            "note": ""
        },
        {
            "column": "Valve Type",
            "rule": "Validation List: Valve Type",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Valve Size",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Valve Orientation",
            "rule": "Validation List: Orientation",
            "note": ""
        },
        {
            "column": "Valve Open Direction",
            "rule": "Validation List: Valve Open Direction",
            "note": ""
        },
        {
            "column": "Turns to Open",
            "rule": "Decimal Value",
            "note": "Use -999 if not applicable. (Example: BFP\'s)"
        },
        {
            "column": "Valve Nut Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Depth to Nut (Feet)",
            "rule": "Decimal Value",
            "note": "Use -999 if not applicable. (Example: BFP\'s above ground)"
        },
        {
            "column": "Valve Manufacturer",
            "rule": "Validation List: Valve Manufacturer",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Water Hydrants": [
        {
            "column": "Hydrant Number (WH#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Hydrant Manufacture Date (Year)",
            "rule": "Year - Whole Number > 2000",
            "note": ""
        },
        {
            "column": "Hydrant Manufacturer",
            "rule": "Validation List: Hydrant Model",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        },
        {
            "column": "RFID/Barcode Number",
            "rule": "Open Text",
            "note": ""
        }
    ],
    "Water Meter": [
        {
            "column": "Meter Box Number (WM#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Proposed Meter Size",
            "rule": "Validation List: Meter Size Inches",
            "note": ""
        },
        {
            "column": "Meter Box Subtype",
            "rule": "Validation List: Subtype Water Meter",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Meter Box Orientation",
            "rule": "Validation List: Orientation",
            "note": ""
        },
        {
            "column": "Meter Box Manufacturer/Supplier",
            "rule": "Validation List: Meter Box Manufacturer",
            "note": ""
        },
        {
            "column": "Meter Box Material",
            "rule": "Validation List: Meter Box Material",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Water Locate Box": [
        {
            "column": "Locate Box Number (WL#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Locate Box Subtype",
            "rule": "Validation List: Subtype Locate Box",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "WW Gravity Pipe Run": [
        {
            "column": "Sewer Pipe Run Number (GM#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Sewer Pipe Subtype",
            "rule": "Validation List: Subtype Sewer Gravity Pipe",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Pipe Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Pipe Class",
            "rule": "Validation List: Sewer Pipe Class",
            "note": ""
        },
        {
            "column": "Pipe Manufacturer",
            "rule": "Validation List: Pipe Manufacturers",
            "note": ""
        },
        {
            "column": "Pipe Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": ""
        },
        {
            "column": "Pipe Lining Manufacturer",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Pipe Lining Material",
            "rule": "Validation List: Sewer Pipe Lining Material",
            "note": ""
        },
        {
            "column": "Pipe Run Length (feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Downstream Pipe Invert Elevation (feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Downstream Grade Elevation at Invert (feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Upstream Pipe Invert Elevation (feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Upstream Grade Elevation at Invert (feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Slope (percent)",
            "rule": "Decimal Value",
            "note": ""
        }
    ],
    "WW Pressure Pipe Run": [
        {
            "column": "Pipe Run Number (FM#)",
            "rule": "Open Text",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Subtype",
            "rule": "Validation List: Subtype Sewer Pressure Pipe",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Class",
            "rule": "Validation List: Sewer Pipe Class",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Manufacturer",
            "rule": "Validation List: Pipe Manufacturers",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Lining Manufacturer",
            "rule": "Open Text",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Lining Material",
            "rule": "Validation List: Sewer Pipe Lining Material",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Measured Length (Feet)",
            "rule": "Decimal Value",
            "note": "Note: This Table is Optional"
        }
    ],
    "WW Points along Pipe": [
        {
            "column": "Pipe Location Number (WWPOC, WWPOL#, etc)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Pipe Location",
            "rule": "Validation List: Pipe Location",
            "note": ""
        },
        {
            "column": "Pipe Subtype",
            "rule": "Validation List: Subtype Sewer Pressure Pipe",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Pipe Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Pipe Orientation",
            "rule": "Validation List: Orientation",
            "note": ""
        },
        {
            "column": "Pipe Class",
            "rule": "Validation List: Sewer Pipe Class",
            "note": ""
        },
        {
            "column": "Pipe Manufacturer",
            "rule": "Validation List: Pipe Manufacturers",
            "note": ""
        },
        {
            "column": "Pipe Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": ""
        },
        {
            "column": "Pipe Lining Manufacturer",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Pipe Lining Material",
            "rule": "Validation List: Sewer Pipe Lining Material",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Pipe Top Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Pipe Cover (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "WW Fitting": [
        {
            "column": "Fitting Number (WWF# or FMF#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Fitting Subtype",
            "rule": "Validation List: Subtype Sewer Fitting",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Fitting Size Primary (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Fitting Size Secondary (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Manufacturer",
            "rule": "Validation List: Fitting Manufacturers",
            "note": ""
        },
        {
            "column": "Fitting Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": ""
        },
        {
            "column": "Lining Manufacturer",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Lining Material",
            "rule": "Validation List: Sewer Pipe Lining Material",
            "note": ""
        },
        {
            "column": "Fitting Top Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Fitting Depth (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Manhole": [
        {
            "column": "Manhole Number (MH#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Manhole Subtype",
            "rule": "Validation List: Subtype Manhole",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Manhole Type",
            "rule": "Validation List: Manhole Type",
            "note": ""
        },
        {
            "column": "Manhole Drop Type",
            "rule": "Validation List: Manhole Drop Type",
            "note": ""
        },
        {
            "column": "Manufacturer or Supplier",
            "rule": "Validation List: Manhole Manufacturer",
            "note": ""
        },
        {
            "column": "Manhole Size (Feet)",
            "rule": "Validation List: Size Feet",
            "note": ""
        },
        {
            "column": "Manhole Material",
            "rule": "Validation List: Manhole Material",
            "note": ""
        },
        {
            "column": "Manhole Lining Material",
            "rule": "Validation List: Manhole Lining Material",
            "note": ""
        },
        {
            "column": "Manhole Lining Manufacturer",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Rim Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Invert Elevations (Feet) with Directions",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Lowest Invert Elevation (feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Exterior Joint Tape Type",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Exterior Joint Tape Manufacturer",
            "rule": "Validation List: Manhole Exterior Joint Tape Manufacturer",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        },
        {
            "column": "RFID/Barcode Number",
            "rule": "Open Text",
            "note": ""
        }
    ],
    "WW Service Point & Meter": [
        {
            "column": "Wastewater Service Point Number (WWSP# or WWM#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Service Point Subtype",
            "rule": "Validation List: Subtype Sewer Customer Point",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation at Service Point",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Top of Pipe Elevation at Service Point (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Depth of Cover (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "WW Valve": [
        {
            "column": "Valve Number (WWV#)",
            "rule": "Open Text (WWV-#)",
            "note": ""
        },
        {
            "column": "Valve Subtype",
            "rule": "Validation List: Subtype Sewer Valve",
            "note": ""
        },
        {
            "column": "Valve Type",
            "rule": "Validation List: Valve Type",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Valve Size",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Valve Orientation",
            "rule": "Validation List: Orientation",
            "note": ""
        },
        {
            "column": "Valve Open Direction",
            "rule": "Validation List: Valve Open Direction",
            "note": ""
        },
        {
            "column": "Turns to Open",
            "rule": "Decimal Value",
            "note": "Use -999 if not applicable. (Example: BFP\'s)"
        },
        {
            "column": "Valve Nut Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Depth to Nut (Feet)",
            "rule": "Decimal Value",
            "note": "Use -999 if not applicable. (Example: BFP\'s above ground)"
        },
        {
            "column": "Valve Manufacturer",
            "rule": "Validation List: Valve Manufacturer",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "WW Locate Box": [
        {
            "column": "Locate Box Number (WWL#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Locate Box Subtype",
            "rule": "Validation List: Subtype Locate Box",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Reclaimed Pipe Run": [
        {
            "column": "Pipe Run Number (RM#)",
            "rule": "Open Text",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Subtype",
            "rule": "Validation List: Subtype Reclaimed Pipe",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Class",
            "rule": "Validation List: Water/Reclaimed Pipe Class",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Manufacturer",
            "rule": "Validation List: Pipe Manufacturers",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Lining Manufacturer",
            "rule": "Open Text",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Lining Material",
            "rule": "Validation List: Water/Reclaimed Pipe Lining Material",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Measured Length (Feet)",
            "rule": "Decimal Value",
            "note": "Note: This Table is Optional"
        }
    ],
    "Reclaimed Points along Pipe": [
        {
            "column": "Pipe Location Number (RPOC#, RPOL#, etc)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Pipe Location",
            "rule": "Validation List: Pipe Location",
            "note": ""
        },
        {
            "column": "Pipe Subtype",
            "rule": "Validation List: Subtype Reclaimed Pipe",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Pipe Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Pipe Orientation",
            "rule": "Validation List: Orientation",
            "note": ""
        },
        {
            "column": "Pipe Class",
            "rule": "Validation List: Water/Reclaimed Pipe Class",
            "note": ""
        },
        {
            "column": "Pipe Manufacturer",
            "rule": "Validation List: Pipe Manufacturers",
            "note": ""
        },
        {
            "column": "Pipe Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": ""
        },
        {
            "column": "Pipe Lining Manufacturer",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Pipe Lining Material",
            "rule": "Validation List: Water/Reclaimed Pipe Lining Material",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Pipe Top Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Pipe Cover (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Reclaimed Fitting": [
        {
            "column": "Fitting Number (RF#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Fitting Subtype",
            "rule": "Validation List: Subtype Reclaimed Fitting",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Fitting Size Primary (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Fitting Size Secondary (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Manufacturer",
            "rule": "Validation List: Fitting Manufacturers",
            "note": ""
        },
        {
            "column": "Fitting Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": ""
        },
        {
            "column": "Lining Manufacturer",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Lining Material",
            "rule": "Validation List: Water/Reclaimed Pipe Lining Material",
            "note": ""
        },
        {
            "column": "Fitting Top Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Depth (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Reclaimed Valve": [
        {
            "column": "Valve Number (RV#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Valve Subtype",
            "rule": "Validation List: Subtype Reclaimed Valve",
            "note": ""
        },
        {
            "column": "Valve Type",
            "rule": "Validation List: Valve Type",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Valve Size",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Valve Orientation",
            "rule": "Validation List: Orientation",
            "note": ""
        },
        {
            "column": "Valve Open Direction",
            "rule": "Validation List: Valve Open Direction",
            "note": ""
        },
        {
            "column": "Turns to Open",
            "rule": "Decimal Value",
            "note": "Use -999 if not applicable. (Example: BFP\'s)"
        },
        {
            "column": "Valve Nut Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Depth to Nut (Feet)",
            "rule": "Decimal Value",
            "note": "Use -999 if not applicable. (Example: BFP\'s above ground)"
        },
        {
            "column": "Valve Manufacturer",
            "rule": "Validation List: Valve Manufacturer",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Reclaimed Hydrant": [
        {
            "column": "Hydrant Number (RH#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Hydrant Manufacture Date (Year)",
            "rule": "Year - Whole Number > 2000",
            "note": ""
        },
        {
            "column": "Hydrant Manufacturer",
            "rule": "Validation List: Hydrant Model",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        },
        {
            "column": "RFID/Barcode Number",
            "rule": "Open Text",
            "note": ""
        }
    ],
    "Reclaimed Meter": [
        {
            "column": "Meter Box Number (RM#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Proposed Meter Size",
            "rule": "Validation List: Meter Size Inches",
            "note": ""
        },
        {
            "column": "Meter Box Subtype",
            "rule": "Validation List: Subtype Reclaimed Meter",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Meter Box Orientation",
            "rule": "Validation List: Orientation",
            "note": ""
        },
        {
            "column": "Meter Box Manufacturer/Supplier",
            "rule": "Validation List: Meter Box Manufacturer",
            "note": ""
        },
        {
            "column": "Meter Box Material",
            "rule": "Validation List: Meter Box Material",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Reclaimed Locate Box": [
        {
            "column": "Locate Box Number (RL#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Locate Box Subtype",
            "rule": "Validation List: Subtype Locate Box",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Chilled Pipe Run": [
        {
            "column": "Pipe Run Number (CM#)",
            "rule": "Open Text",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Role",
            "rule": "Validation List: Chilled Pipe Role",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Class",
            "rule": "Validation List: Chilled Pipe Class",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Manufacturer",
            "rule": "Validation List: Pipe Manufacturers",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Lining Manufacturer",
            "rule": "Open Text",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Pipe Lining Material",
            "rule": "Validation List: Water/Reclaimed Pipe Lining Material",
            "note": "Note: This Table is Optional"
        },
        {
            "column": "Measured Length (Feet)",
            "rule": "Decimal Value",
            "note": "Note: This Table is Optional"
        }
    ],
    "Chilled Points along Pipe": [
        {
            "column": "Pipe Location Number (CPOC#, CPOL#, etc)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Pipe Location",
            "rule": "Validation List: Pipe Location",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Pipe Size (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Pipe Orientation",
            "rule": "Validation List: Orientation",
            "note": ""
        },
        {
            "column": "Pipe Class",
            "rule": "Validation List: Chilled Pipe Class",
            "note": ""
        },
        {
            "column": "Pipe Manufacturer",
            "rule": "Validation List: Pipe Manufacturers",
            "note": ""
        },
        {
            "column": "Pipe Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": ""
        },
        {
            "column": "Pipe Lining Manufacturer",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Pipe Lining Material",
            "rule": "Validation List: Water/Reclaimed Pipe Lining Material",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Pipe Top Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Pipe Cover (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Chilled Fitting": [
        {
            "column": "Fitting Number (CF#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Fitting Subtype",
            "rule": "Validation List: Subtype Chilled Fitting",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Fitting Size Primary (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Fitting Size Secondary (Inches)",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Manufacturer",
            "rule": "Validation List: Fitting Manufacturers",
            "note": ""
        },
        {
            "column": "Fitting Material",
            "rule": "Validation List: Pipe and Fitting Material",
            "note": ""
        },
        {
            "column": "Lining Manufacturer",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Lining Material",
            "rule": "Water/Reclaimed/Chilled Pipe Lining Material",
            "note": ""
        },
        {
            "column": "Fitting Top Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Fitting Depth (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Chilled Valve": [
        {
            "column": "Valve Number (CV#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Valve Type",
            "rule": "Validation List: Valve Type",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "Valve Size",
            "rule": "Validation List: Size Inches",
            "note": ""
        },
        {
            "column": "Valve Orientation",
            "rule": "Validation List: Orientation",
            "note": ""
        },
        {
            "column": "Valve Open Direction",
            "rule": "Validation List: Valve Open Direction",
            "note": ""
        },
        {
            "column": "Turns to Open",
            "rule": "Decimal Value",
            "note": "Use -999 if not applicable. (Example: BFP\'s)"
        },
        {
            "column": "Valve Nut Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Finished Grade Elevation (Feet)",
            "rule": "Decimal Value",
            "note": ""
        },
        {
            "column": "Depth to Nut (Feet)",
            "rule": "Decimal Value",
            "note": "Use -999 if not applicable. (Example: BFP\'s above ground)"
        },
        {
            "column": "Valve Manufacturer",
            "rule": "Validation List: Valve Manufacturer",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Chilled Meter": [
        {
            "column": "Meter Room Number (CM#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Proposed Meter Size",
            "rule": "Validation List: Meter Size Inches",
            "note": ""
        },
        {
            "column": "Facility Owner",
            "rule": "Validation List: Facility Owner",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ],
    "Chilled Locate Box": [
        {
            "column": "Locate Box Number (CL#)",
            "rule": "Open Text",
            "note": ""
        },
        {
            "column": "Locate Box Subtype",
            "rule": "Validation List: Subtype Locate Box",
            "note": ""
        },
        {
            "column": "X Coord (State Plane Easting Feet)",
            "rule": "Decimal Value > 320,000 and < 590,000",
            "note": ""
        },
        {
            "column": "Y Coord (State Plane Northing Feet)",
            "rule": "Decimal Value > 1,920,000 and < 2,370,000",
            "note": ""
        },
        {
            "column": "Latitude (Decimal Degrees)",
            "rule": "Decimal Value > 29 and < 31",
            "note": ""
        },
        {
            "column": "Longitude (Decimal Degrees)",
            "rule": "Decimal Value > -83 and < -80",
            "note": ""
        }
    ]
};

    const BLOCK_DEFS = {
        JEA_VALVE: ["SUBTYPE", "VALVE_TYPE", "SIZE", "MATERIAL", "MANUFACTURER", "OPEN_DIR", "STATUS", "ELEVATION"],
        JEA_MANHOLE: ["SUBTYPE", "MANHOLE_TYPE", "RIM_ELEV", "INVERT_IN", "INVERT_OUT", "DEPTH", "DIAMETER", "MATERIAL", "MANUFACTURER", "LINING"],
        JEA_HYDRANT: ["SUBTYPE", "MODEL", "MANUFACTURER", "VALVE_SIZE", "BURY_DEPTH", "ELEVATION"],
        JEA_FITTING: ["SUBTYPE", "SIZE", "MATERIAL", "MANUFACTURER", "ELEVATION"],
        JEA_METER: ["SUBTYPE", "SIZE", "BOX_MFR", "BOX_MAT", "ELEVATION", "ACCOUNT_NO"],
        JEA_LOCATE_BOX: ["SUBTYPE", "ELEVATION", "COLOR"],
        JEA_CROSSING: ["CROSS_NO", "UPPER_TYPE", "UPPER_SIZE", "UPPER_BOT_ELEV", "LOWER_TYPE", "LOWER_SIZE", "LOWER_TOP_ELEV", "CLEARANCE_INCHES", "COMPLIANT"]
    };

    // Layer names real as-built drawings use instead of the template layers above. INFERRED from
    // the layer names in sample JEA / consultant drawings (POWM = potable water main, PSAN = sanitary,
    // STRU = structure, …) — NOT taken from a JEA publication. They only stop a recognisable as-built
    // layer being called "non-standard" and let its linework be extracted; every use is reported as
    // "inferred" so it can be confirmed with JEA. Edit this table, not the auditor, to add or fix one.
    const LAYER_ALIASES = [
        { match: /^_AB POWM PIPE\s+LN$/i, layer: "W-MAIN",  system: "Water" },
        { match: /^_AB PSAN PIPE\s+LN$/i, layer: "SS-GRAV", system: "Sewer" },
        { match: /^_AB PSAN STRU\s+LN$/i, layer: "SS-MANH", system: "Sewer" },
        { match: /^AB-FIRE LINE$/i,        layer: "W-MAIN",  system: "Water" },
        { match: /^AB-WTR-VALVES$/i,       layer: "W-VALV",  system: "Water" },
        { match: /^AB-WTR-FITTINGS$/i,     layer: "W-FITT",  system: "Water" },
        { match: /^AB-GRAVITY-LINE$/i,     layer: "SS-GRAV", system: "Sewer" },
        { match: /^AB-REUSE-LINE$/i,       layer: "RW-MAIN", system: "Reclaimed" },
        { match: /^AB-REUSE-FITTINGS$/i,   layer: "RW-FITT", system: "Reclaimed" }
    ];

    window.Jea24Data = { BOUNDS, CLIENT_TEMPLATE, LAYERS, LAYER_ALIASES, DOMAINS, RULES, BLOCK_DEFS, crossingRequirement, setCrossingMinimums, CROSSING_MINIMUMS_JEA_2026, CROSSING_RULE_SOURCE, ACCURACY };
})();
