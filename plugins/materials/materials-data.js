/**
 * Materials reference data — plugins/materials/materials-data.js
 *
 * Pipe sizes (imperial + metric), pipe systems, appurtenances and typical
 * fittings for water, sewer and gas service lines. The JEA template's own
 * material lists are NOT copied here: plugins/materials/materials.js reads
 * them live from window.Jea24Data.DOMAINS so they can never drift.
 *
 * Reference values only — like core/data.js, verify sizes, classes and
 * standards against the governing standard, the utility's current
 * specifications and the manufacturer before design or procurement.
 * Outside diameters are the published nominal ODs for each sizing system;
 * every metric (mm) value is computed from the inch value (× 25.4), never
 * entered separately.
 *
 * Exposes window.MaterialsData.
 */
(function () {
    "use strict";

    // Nominal pipe size (inches) → metric DN designation (ISO 6708 / EN convention).
    // DN is a size label, not a measured diameter — the computed mm column shows the exact conversion.
    const DN = {
        "0.5": 15, "0.75": 20, "1": 25, "1.25": 32, "1.5": 40, "2": 50, "2.5": 65, "3": 80, "3.5": 90,
        "4": 100, "5": 125, "6": 150, "8": 200, "10": 250, "12": 300, "14": 350, "15": 375, "16": 400,
        "18": 450, "20": 500, "21": 525, "24": 600, "27": 675, "30": 750, "36": 900, "42": 1050,
        "48": 1200, "54": 1350, "60": 1500, "66": 1650, "72": 1800, "78": 1950, "84": 2100,
        "102": 2550, "120": 3000
    };

    // Sizing systems: nominal size (in) → published outside diameter (in).
    const SIZE_SYSTEMS = [
        {
            id: "IPS", name: "IPS — Iron Pipe Size",
            standard: "ASME B36.10M (steel); ASTM D1785 PVC Sch 40/80; HDPE IPS (AWWA C906 / ASTM D3035)",
            usedFor: "Steel pipe, PVC Schedule 40/80, HDPE IPS water / gas / force main",
            od: { "0.5": 0.840, "0.75": 1.050, "1": 1.315, "1.25": 1.660, "1.5": 1.900, "2": 2.375, "2.5": 2.875, "3": 3.500,
                  "4": 4.500, "6": 6.625, "8": 8.625, "10": 10.750, "12": 12.750, "14": 14.000, "16": 16.000, "18": 18.000,
                  "20": 20.000, "24": 24.000 }
        },
        {
            id: "DIPS", name: "DIPS / CIOD — Ductile Iron Pipe Size",
            standard: "AWWA C151 (ductile iron); AWWA C900 PVC (CIOD); HDPE DIPS (AWWA C906)",
            usedFor: "Ductile iron and C900 PVC water mains and force mains",
            od: { "3": 3.96, "4": 4.80, "6": 6.90, "8": 9.05, "10": 11.10, "12": 13.20, "14": 15.30, "16": 17.40, "18": 19.50,
                  "20": 21.60, "24": 25.80, "30": 32.00, "36": 38.30, "42": 44.50, "48": 50.80, "54": 57.56, "60": 61.61, "64": 65.67 }
        },
        {
            id: "PVC-SEWER", name: "PVC gravity sewer (PSM / F679)",
            standard: "ASTM D3034 (4–15 in, SDR 35 / SDR 26); ASTM F679 (18 in and larger)",
            usedFor: "PVC gravity sewer mains and laterals",
            od: { "4": 4.215, "6": 6.275, "8": 8.400, "10": 10.500, "12": 12.500, "15": 15.300, "18": 18.701, "21": 22.047,
                  "24": 24.803, "27": 27.953, "30": 32.000, "36": 38.300, "42": 44.500, "48": 50.800 }
        },
        {
            id: "CTS", name: "CTS — Copper Tube Size",
            standard: "ASTM B88 (copper Type K / L); ASTM D2737 & AWWA C901 (PE tubing); ASTM D2513 (PE gas, CTS)",
            usedFor: "Water service tubing (copper, PE), small PE gas services",
            od: { "0.5": 0.625, "0.75": 0.875, "1": 1.125, "1.25": 1.375, "1.5": 1.625, "2": 2.125 }
        }
    ];

    // Pipe systems by utility. `system` links to SIZE_SYSTEMS for outside diameters.
    const PIPE_SYSTEMS = [
        // Water
        { utility: "Water", use: "Main", material: "Ductile iron (cement-mortar lined)", standard: "AWWA C151 / C104 lining / C111 joints", sizes: "3–64 in", classes: "Pressure Class 150–350; thickness Class 50–56 (JEA CL50–CL54)", system: "DIPS" },
        { utility: "Water", use: "Main", material: "PVC pressure pipe", standard: "AWWA C900", sizes: "4–60 in", classes: "DR 14, DR 18, DR 25", system: "DIPS" },
        { utility: "Water", use: "Main", material: "Molecularly oriented PVC (PVCO)", standard: "AWWA C909", sizes: "4–24 in", classes: "Pressure Class 165–235", system: "DIPS" },
        { utility: "Water", use: "Main", material: "HDPE (PE 4710)", standard: "AWWA C906", sizes: "4–65 in", classes: "DR 7–DR 17 (DR 11 common)", system: "DIPS" },
        { utility: "Water", use: "Main", material: "Steel (lined & coated)", standard: "AWWA C200", sizes: "6 in and larger", classes: "per design pressure", system: "IPS" },
        { utility: "Water", use: "Service", material: "Copper tubing, Type K (soft)", standard: "ASTM B88 / AWWA C800 fittings", sizes: "3/4–2 in", classes: "Type K", system: "CTS" },
        { utility: "Water", use: "Service", material: "Polyethylene tubing (PE 4710)", standard: "AWWA C901 / ASTM D2737", sizes: "3/4–2 in", classes: "DR 9 (200 psi)", system: "CTS" },
        { utility: "Water", use: "Service", material: "Cross-linked polyethylene (PEX)", standard: "AWWA C904", sizes: "3/4–2 in", classes: "SDR 9", system: "CTS" },
        { utility: "Water", use: "Service", material: "PVC Schedule 40 / 80", standard: "ASTM D1785", sizes: "1/2–2 in (services, irrigation)", classes: "Sch 40, Sch 80", system: "IPS" },
        // Sewer — gravity
        { utility: "Sewer", use: "Gravity main", material: "PVC gravity sewer", standard: "ASTM D3034", sizes: "4–15 in", classes: "SDR 35, SDR 26", system: "PVC-SEWER" },
        { utility: "Sewer", use: "Gravity main", material: "PVC gravity sewer (large diameter)", standard: "ASTM F679", sizes: "18–60 in", classes: "PS 46, PS 115", system: "PVC-SEWER" },
        { utility: "Sewer", use: "Gravity main", material: "Ductile iron (lined for sewer)", standard: "ASTM A746 / AWWA C151", sizes: "4–64 in", classes: "Class 50–52; interior lining required", system: "DIPS" },
        { utility: "Sewer", use: "Gravity main", material: "Reinforced concrete pipe", standard: "ASTM C76", sizes: "12–144 in", classes: "Class I–V", system: null },
        { utility: "Sewer", use: "Gravity main", material: "Vitrified clay pipe", standard: "ASTM C700", sizes: "4–42 in", classes: "Extra strength", system: null },
        // Sewer — force main
        { utility: "Sewer", use: "Force main", material: "PVC pressure pipe", standard: "AWWA C900", sizes: "4–60 in", classes: "DR 18, DR 25", system: "DIPS" },
        { utility: "Sewer", use: "Force main", material: "Ductile iron (lined for sewer)", standard: "AWWA C151", sizes: "4–64 in", classes: "Pressure Class 250–350", system: "DIPS" },
        { utility: "Sewer", use: "Force main", material: "HDPE (PE 4710)", standard: "AWWA C906", sizes: "2–65 in", classes: "DR 11, DR 17", system: "DIPS" },
        // Sewer — service lateral
        { utility: "Sewer", use: "Service lateral", material: "PVC gravity sewer", standard: "ASTM D3034", sizes: "4–6 in", classes: "SDR 35, SDR 26", system: "PVC-SEWER" },
        { utility: "Sewer", use: "Service lateral", material: "PVC Schedule 40 DWV", standard: "ASTM D2665 / D1785", sizes: "4–6 in", classes: "Sch 40", system: "IPS" },
        // Gas — service lines
        { utility: "Gas", use: "Service", material: "Polyethylene gas pipe (PE 2708 / PE 4710)", standard: "ASTM D2513; 49 CFR Part 192", sizes: "1/2–2 in (CTS and IPS)", classes: "SDR 11 common", system: "IPS" },
        { utility: "Gas", use: "Service", material: "Polyethylene gas tubing, CTS", standard: "ASTM D2513; 49 CFR Part 192", sizes: "1/2–1 in CTS", classes: "SDR 11 / 0.090 in wall", system: "CTS" },
        { utility: "Gas", use: "Service", material: "Steel (coated, cathodically protected)", standard: "ASTM A53 / API 5L; 49 CFR Part 192", sizes: "3/4–2 in", classes: "Sch 40", system: "IPS" },
        { utility: "Gas", use: "Main", material: "Polyethylene gas pipe (PE 2708 / PE 4710)", standard: "ASTM D2513; 49 CFR Part 192", sizes: "2–8 in IPS", classes: "SDR 11", system: "IPS" }
    ];

    // Appurtenances — the valves, structures and assemblies on a line.
    const APPURTENANCES = [
        // Water main
        { utility: "Water", line: "Main", name: "Resilient-seated gate valve", standard: "AWWA C509 / C515", note: "Isolation valve on mains 4–12 in; with valve box." },
        { utility: "Water", line: "Main", name: "Butterfly valve", standard: "AWWA C504", note: "Isolation on larger mains (typically 16 in and up)." },
        { utility: "Water", line: "Main", name: "Air release / combination air valve (ARV)", standard: "AWWA C512", note: "At high points; in a vault or box." },
        { utility: "Water", line: "Main", name: "Fire hydrant assembly", standard: "AWWA C502", note: "Hydrant, isolation valve, tee and lead." },
        { utility: "Water", line: "Main", name: "Tapping sleeve and valve", standard: "AWWA C223 (sleeve); C509 / C515 (valve)", note: "Live tap onto an existing main." },
        { utility: "Water", line: "Main", name: "Blow-off / flushing assembly", standard: "Utility standard detail", note: "At dead ends for flushing and sampling." },
        { utility: "Water", line: "Main", name: "Valve box and cover", standard: "Utility standard detail", note: "Adjustable cast-iron or composite box over buried valves." },
        { utility: "Water", line: "Main", name: "Restrained joints / thrust restraint", standard: "AWWA C111 / C600; manufacturer tables", note: "At bends, tees, reducers and dead ends." },
        { utility: "Water", line: "Main", name: "Backflow preventer (RPZ / double check)", standard: "AWWA C511 (RPZ) / C510 (DCVA)", note: "Containment on fire lines and commercial services." },
        { utility: "Water", line: "Main", name: "Tracer wire, warning tape and locate box", standard: "Utility standard detail", note: "Locating non-metallic mains." },
        // Water service
        { utility: "Water", line: "Service", name: "Corporation stop", standard: "AWWA C800", note: "Valve at the main tap." },
        { utility: "Water", line: "Service", name: "Service saddle", standard: "AWWA C800", note: "Clamp for tapping PVC / DIP mains." },
        { utility: "Water", line: "Service", name: "Curb stop / ball valve", standard: "AWWA C800", note: "Shut-off at or near the property line." },
        { utility: "Water", line: "Service", name: "Meter setter (yoke) and meter", standard: "AWWA C700 (meter)", note: "Inside the meter box." },
        { utility: "Water", line: "Service", name: "Meter box and lid", standard: "Utility standard detail", note: "Polymer or concrete (JEA: Meter Box Material domain)." },
        // Sewer gravity
        { utility: "Sewer", line: "Gravity main", name: "Precast concrete manhole", standard: "ASTM C478", note: "Base, riser and cone or flat top; lined where specified." },
        { utility: "Sewer", line: "Gravity main", name: "Manhole frame and cover", standard: "ASTM A48 / AASHTO M306", note: "Traffic-rated where in pavement." },
        { utility: "Sewer", line: "Gravity main", name: "Flexible pipe-to-manhole connector (boot)", standard: "ASTM C923", note: "Watertight pipe penetrations." },
        { utility: "Sewer", line: "Gravity main", name: "Drop connection (inside / outside)", standard: "Utility standard detail", note: "Where the incoming invert is well above the outlet." },
        // Sewer force main
        { utility: "Sewer", line: "Force main", name: "Plug valve", standard: "AWWA C517", note: "Isolation on force mains." },
        { utility: "Sewer", line: "Force main", name: "Sewage air release valve", standard: "AWWA C512", note: "At force-main high points; in a vault." },
        { utility: "Sewer", line: "Force main", name: "Check valve", standard: "AWWA C508", note: "At pump stations to prevent back-flow." },
        // Sewer service
        { utility: "Sewer", line: "Service lateral", name: "Cleanout", standard: "Utility standard detail", note: "At the property line and at changes in direction." },
        { utility: "Sewer", line: "Service lateral", name: "Backwater valve", standard: "Plumbing code / utility standard", note: "Where fixtures are below the upstream manhole rim." },
        // Gas service
        { utility: "Gas", line: "Service", name: "Excess flow valve (EFV)", standard: "49 CFR 192.383", note: "Required on new and replaced single-family services." },
        { utility: "Gas", line: "Service", name: "Curb valve / service shut-off", standard: "49 CFR 192.363–192.365", note: "Accessible shut-off on the service line." },
        { utility: "Gas", line: "Service", name: "Service riser (anodeless)", standard: "ASTM D2513 / F1973; 49 CFR 192", note: "PE-to-steel transition up to the meter." },
        { utility: "Gas", line: "Service", name: "Meter set and service regulator", standard: "Utility standard / 49 CFR 192.197", note: "Pressure regulation and metering at the building." },
        { utility: "Gas", line: "Service", name: "Tracer wire and warning tape", standard: "49 CFR 192.321", note: "Locating plastic gas lines." }
    ];

    // Typical fittings for each system.
    const FITTINGS = [
        // Water (ductile iron mechanical-joint fittings fit DIP and C900 PVC — DIPS OD)
        { utility: "Water", line: "Main", name: "Tee (MJ × MJ × MJ)", standard: "AWWA C153 (compact) / C110", note: "Branch connection." },
        { utility: "Water", line: "Main", name: "Cross", standard: "AWWA C153 / C110", note: "Four-way junction." },
        { utility: "Water", line: "Main", name: "Bends 11¼°, 22½°, 45°, 90°", standard: "AWWA C153 / C110", note: "Changes in direction; restrain." },
        { utility: "Water", line: "Main", name: "Reducer", standard: "AWWA C153 / C110", note: "Change in main size." },
        { utility: "Water", line: "Main", name: "Solid sleeve / repair coupling", standard: "AWWA C153 / C219", note: "Joining plain ends; repairs." },
        { utility: "Water", line: "Main", name: "Cap / plug (tapped or solid)", standard: "AWWA C153 / C110", note: "Dead ends; tapped for blow-offs." },
        { utility: "Water", line: "Main", name: "Offset", standard: "AWWA C110", note: "Vertical or horizontal offset around conflicts." },
        { utility: "Water", line: "Main", name: "Transition coupling", standard: "AWWA C219", note: "Joining pipes with different ODs (e.g. IPS to DIPS)." },
        { utility: "Water", line: "Service", name: "Compression couplings and adapters", standard: "AWWA C800", note: "Copper / PE service connections." },
        { utility: "Water", line: "Service", name: "Service tee / bends", standard: "AWWA C800", note: "Service branch and direction changes." },
        // Sewer gravity (PVC gasketed fittings to ASTM D3034 / F1336)
        { utility: "Sewer", line: "Gravity main", name: "Wye (main × lateral)", standard: "ASTM D3034 / F1336", note: "Service connection on the main." },
        { utility: "Sewer", line: "Gravity main", name: "Tee-wye / sanitary tee", standard: "ASTM D3034 / F1336", note: "Branch connection." },
        { utility: "Sewer", line: "Gravity main", name: "Bends 11¼°, 22½°, 45°", standard: "ASTM D3034 / F1336", note: "Long-sweep where possible; 90° avoided on mains." },
        { utility: "Sewer", line: "Gravity main", name: "Inserta-tee / saddle tap", standard: "ASTM F1336 / manufacturer", note: "New service onto an existing main." },
        { utility: "Sewer", line: "Gravity main", name: "Repair coupling / transition coupling", standard: "ASTM C1173", note: "Joining dissimilar pipes (e.g. VCP to PVC)." },
        { utility: "Sewer", line: "Gravity main", name: "Plug / cap", standard: "ASTM D3034", note: "Stubs and abandoned laterals." },
        { utility: "Sewer", line: "Force main", name: "MJ fittings (tee, bends, reducer)", standard: "AWWA C153 / C110, lined", note: "As for water, with an interior lining for sewage." },
        { utility: "Sewer", line: "Service lateral", name: "Long-sweep 45° / 90° bends", standard: "ASTM D3034 / D2665", note: "Changes in direction on the lateral." },
        { utility: "Sewer", line: "Service lateral", name: "Cleanout wye and riser", standard: "ASTM D3034 / D2665", note: "Cleanout at the property line." },
        // Gas service (PE heat-fusion and mechanical fittings to ASTM D2513 / F1055)
        { utility: "Gas", line: "Service", name: "Service tapping tee (heat-fusion or electrofusion)", standard: "ASTM D2513 / F1055", note: "Connects the service to the main." },
        { utility: "Gas", line: "Service", name: "Electrofusion coupling", standard: "ASTM F1055", note: "Joining PE pipe and tubing." },
        { utility: "Gas", line: "Service", name: "Butt / socket fusion fittings (tee, elbow, reducer)", standard: "ASTM D2513 / D3261", note: "Heat-fusion joints." },
        { utility: "Gas", line: "Service", name: "Mechanical compression coupling", standard: "ASTM D2513 / F1948", note: "Category I mechanical fitting." },
        { utility: "Gas", line: "Service", name: "Transition fitting (PE × steel)", standard: "ASTM F1973", note: "Joining PE to steel." },
        { utility: "Gas", line: "Service", name: "Cap / end closure", standard: "ASTM D2513", note: "Temporary or permanent end of a service." }
    ];

    window.MaterialsData = { DN, SIZE_SYSTEMS, PIPE_SYSTEMS, APPURTENANCES, FITTINGS };
})();
