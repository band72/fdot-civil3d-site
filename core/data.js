/* FDOT Civil3D Standards Project Master Dataset
 *
 * ⚠  ILLUSTRATIVE / UNVERIFIED reference data. Layer colours & linetypes, the
 *    11 IDF-zone a/b/c coefficients, Manning's n values, pay-item mappings, and
 *    sign→pay-item resolution below were hand/LLM-authored for the demo and have
 *    NOT been checked against a current FDOT CADD Manual, Basis of Estimates, or
 *    Drainage Manual. Do not use these numbers for production design — confirm
 *    every value against the authoritative FDOT source first.
 */

const FDOT_DATA = {
    disciplines: [
        { id: "ALL", name: "All Disciplines" },
        { id: "ROAD", name: "Roadway (ROAD)" },
        { id: "DRAIN", name: "Drainage (DRAIN)" },
        { id: "SURV", name: "Survey & Topo (SURV)" },
        { id: "UTIL", name: "Utilities (UTIL)" },
        { id: "STR", name: "Structures (STR)" },
        { id: "RW", name: "Right of Way (RW)" },
        { id: "ENV", name: "Environmental (ENV)" },
        { id: "TRAF", name: "Traffic & Signal (TRAF)" },
        { id: "LIGHT", name: "Lighting (LIGHT)" }
    ],

    // FDOT 11 IDF Zones Data
    idfZones: [
        { zone: 1, counties: "Escambia, Santa Rosa, Okaloosa", a: 52.4, b: 18.5, c: 0.78 },
        { zone: 2, counties: "Walton, Holmes, Washington, Bay, Jackson, Calhoun, Gulf", a: 50.1, b: 17.8, c: 0.77 },
        { zone: 3, counties: "Gadsden, Liberty, Franklin, Leon, Wakulla, Jefferson", a: 48.2, b: 17.2, c: 0.76 },
        { zone: 4, counties: "Madison, Taylor, Hamilton, Suwannee, Lafayette, Dixie", a: 46.5, b: 16.8, c: 0.75 },
        { zone: 5, counties: "Columbia, Baker, Union, Bradford, Clay, Duval, Nassau", a: 45.2, b: 16.5, c: 0.75 },
        { zone: 6, counties: "St. Johns, Putnam, Flagler, Alachua, Levy, Gilchrist", a: 44.0, b: 16.2, c: 0.74 },
        { zone: 7, counties: "Marion, Volusia, Lake, Seminole, Orange, Osceola", a: 43.1, b: 16.0, c: 0.74 },
        { zone: 8, counties: "Citrus, Sumter, Hernando, Pasco, Pinellas, Hillsborough", a: 42.5, b: 15.8, c: 0.73 },
        { zone: 9, counties: "Polk, Manatee, Hardee, Highlands, Sarasota, DeSoto", a: 41.8, b: 15.5, c: 0.73 },
        { zone: 10, counties: "Charlotte, Glades, Lee, Hendry, Collier", a: 41.0, b: 15.2, c: 0.72 },
        { zone: 11, counties: "Indian River, Okeechobee, St. Lucie, Martin, Palm Beach, Broward, Miami-Dade, Monroe", a: 40.2, b: 15.0, c: 0.72 }
    ],

    // Traffic Sign Assemblies Dataset
    signAssemblies: [
        { code: "R1-1", title: "STOP Sign", size: "36\"x36\"", payItem: "0700-1-11", shape: "OCTAGON", color: "#cc0000", blockName: "R01-01", description: "Standard Octagonal Stop Sign Assembly" },
        { code: "R1-2", title: "YIELD Sign", size: "36\"x36\"", payItem: "0700-1-11", shape: "TRIANGLE_INV", color: "#cc0000", blockName: "R01-02", description: "Inverted Triangular Yield Sign Assembly" },
        { code: "R2-1", title: "SPEED LIMIT Sign", size: "30\"x36\"", payItem: "0700-1-11", shape: "RECTANGLE", color: "#ffffff", blockName: "R02-01", description: "Regulatory Speed Limit Sign (Dynamic Speed Input)" },
        { code: "M1-1", title: "Interstate Route Shield", size: "24\"x24\"", payItem: "0700-1-11", shape: "SHIELD_I", color: "#003399", blockName: "M1-01", description: "Official FDOT Interstate Route Shield Assembly" },
        { code: "M1-5", title: "State Road Badge", size: "24\"x24\"", payItem: "0700-1-11", shape: "CIRCLE", color: "#ffffff", blockName: "M1-05", description: "FDOT State Road Number Badge Assembly" },
        { code: "M1-6", title: "County Road Shield", size: "24\"x24\"", payItem: "0700-1-11", shape: "PENTAGON", color: "#002244", blockName: "M1-06", description: "FDOT County Road Shield Assembly" }
    ],

    // Blocks Dataset
    blocks: [
        { name: "FDOT_SIGN_SINGLE", dwg: "signalization.dwg", discipline: "TRAF", layer: "TRAF_SIGN_PR", payItem: "0700-1-11", annotative: true, description: "Single Post Sign Assembly Ground Mount" },
        { name: "FDOT_DR_INLET_P5", dwg: "DrainXS.dwg", discipline: "DRAIN", layer: "DRAIN_STR_PR", payItem: "0425-1-351", annotative: false, description: "Curb Inlet Type P-5" },
        { name: "FDOT_LIGHT_POLE", dwg: "lighting.dwg", discipline: "LIGHT", layer: "DSGNLT_POLE_PR", payItem: "0715-1-11", annotative: false, description: "Standard Light Pole Assembly" },
        { name: "FDOT_SOIL_BORING", dwg: "geotech.dwg", discipline: "SURV", layer: "SURV_CTRL_PT", payItem: "N/A", annotative: true, description: "Geotechnical SPT Soil Boring Location" },
        { name: "FDOT_MONUMENT_PRM", dwg: "ROW.dwg", discipline: "RW", layer: "SURV_MONUMENT", payItem: "N/A", annotative: true, description: "Permanent Reference Monument (PRM)" }
    ],

    // Pipes Catalog
    pipesCatalog: [
        { family: "RCP Round", shape: "Circular", material: "Reinforced Concrete", minSize: "18\"", maxSize: "84\"", n: 0.012, c3dLayer: "DRAIN_PIPE_PR" },
        { family: "HDPE Smooth Interior", shape: "Circular", material: "High Density Polyethylene", minSize: "12\"", maxSize: "60\"", n: 0.010, c3dLayer: "DRAIN_PIPE_PR" },
        { family: "Horizontal ECP", shape: "Elliptical", material: "Concrete Elliptical", minSize: "14\"x23\"", maxSize: "68\"x106\"", n: 0.012, c3dLayer: "DRAIN_PIPE_PR" },
        { family: "Box Culvert", shape: "Box", material: "Precast Concrete", minSize: "3'x3'", maxSize: "12'x12'", n: 0.012, c3dLayer: "DRAIN_PIPE_PR" }
    ],

    layers: [
        { name: "ROAD_ALIGN_PR", discipline: "ROAD", color: 4, colorHex: "#00ffff", colorName: "Cyan (4)", linetype: "CENTER", lineweight: "0.50", plot: true, description: "Proposed Roadway Centerline Alignment & Stationing Lines" },
        { name: "ROAD_ALIGN_EX", discipline: "ROAD", color: 2, colorHex: "#ffff00", colorName: "Yellow (2)", linetype: "HIDDEN", lineweight: "0.25", plot: true, description: "Existing Centerline Alignment & Survey Baseline" },
        { name: "ROAD_EOP_PR", discipline: "ROAD", color: 7, colorHex: "#ffffff", colorName: "White (7)", linetype: "CONTINUOUS", lineweight: "0.35", plot: true, description: "Proposed Edge of Pavement (Travel Way Limit)" },
        { name: "ROAD_EOP_EX", discipline: "ROAD", color: 252, colorHex: "#848484", colorName: "Gray (252)", linetype: "CONTINUOUS", lineweight: "0.18", plot: true, description: "Existing Edge of Pavement Line" },
        { name: "ROAD_CURB_PR", discipline: "ROAD", color: 3, colorHex: "#00ff00", colorName: "Green (3)", linetype: "CONTINUOUS", lineweight: "0.35", plot: true, description: "Proposed Curb and Gutter Lip & Back of Curb" },
        { name: "ROAD_SWK_PR", discipline: "ROAD", color: 1, colorHex: "#ff0000", colorName: "Red (1)", linetype: "CONTINUOUS", lineweight: "0.25", plot: true, description: "Proposed Concrete Sidewalk & ADA Detectable Warning Ramps" },
        { name: "ROAD_MEDIAN_PR", discipline: "ROAD", color: 6, colorHex: "#ff00ff", colorName: "Magenta (6)", linetype: "CONTINUOUS", lineweight: "0.35", plot: true, description: "Proposed Median Curb & Traffic Separator Lines" },
        { name: "ROAD_TOPO_SLOPE", discipline: "ROAD", color: 253, colorHex: "#adadad", colorName: "Light Gray (253)", linetype: "FDOT_SLOPE", lineweight: "0.18", plot: true, description: "Cut and Fill Slope Hatching Lines (Daylight Limit)" },
        { name: "ROAD_NOPLOT_WORK", discipline: "ROAD", color: 211, colorHex: "#9b00ff", colorName: "Purple (211)", linetype: "CONTINUOUS", lineweight: "0.18", plot: false, description: "Construction Scratch Lines & Corridor Boundaries (Non-Plotting)" },

        { name: "DRAIN_PIPE_PR", discipline: "DRAIN", color: 5, colorHex: "#0000ff", colorName: "Blue (5)", linetype: "CONTINUOUS", lineweight: "0.70", plot: true, description: "Proposed Storm Sewer Culvert Pipes & Outfall Runs" },
        { name: "DRAIN_PIPE_EX", discipline: "DRAIN", color: 140, colorHex: "#007f7f", colorName: "Teal (140)", linetype: "HIDDEN", lineweight: "0.35", plot: true, description: "Existing Drainage Pipe Run" },
        { name: "DRAIN_STR_PR", discipline: "DRAIN", color: 5, colorHex: "#0000ff", colorName: "Blue (5)", linetype: "CONTINUOUS", lineweight: "0.50", plot: true, description: "Proposed Curb Inlets, Junction Boxes, Catch Basins & Manholes" },
        { name: "DRAIN_STR_EX", discipline: "DRAIN", color: 140, colorHex: "#007f7f", colorName: "Teal (140)", linetype: "CONTINUOUS", lineweight: "0.25", plot: true, description: "Existing Stormwater Inlets & Structures" },
        { name: "DRAIN_POND_PR", discipline: "DRAIN", color: 130, colorHex: "#00007f", colorName: "Dark Blue (130)", linetype: "CONTINUOUS", lineweight: "0.35", plot: true, description: "Proposed Stormwater Treatment Pond Top of Bank & Maintenance Berm" },
        { name: "DRAIN_FLOW_DIR", discipline: "DRAIN", color: 4, colorHex: "#00ffff", colorName: "Cyan (4)", linetype: "CONTINUOUS", lineweight: "0.25", plot: true, description: "Drainage Basin Boundaries & Flow Direction Vectors" },

        { name: "SURV_BND_PR", discipline: "SURV", color: 1, colorHex: "#ff0000", colorName: "Red (1)", linetype: "PHANTOM", lineweight: "0.70", plot: true, description: "Project Survey Limit & Property Boundary Polygon" },
        { name: "SURV_CTRL_PT", discipline: "SURV", color: 3, colorHex: "#00ff00", colorName: "Green (3)", linetype: "CONTINUOUS", lineweight: "0.35", plot: true, description: "FDOT Horizontal & Vertical Control Benchmark Monuments" },
        { name: "SURV_MONUMENT", discipline: "SURV", color: 1, colorHex: "#ff0000", colorName: "Red (1)", linetype: "CONTINUOUS", lineweight: "0.35", plot: true, description: "Found Permanent Reference Monuments (PRM / PCP / Iron Pipe)" },
        { name: "SURV_DTM_TIN", discipline: "SURV", color: 251, colorHex: "#545454", colorName: "Dark Gray (251)", linetype: "CONTINUOUS", lineweight: "0.09", plot: false, description: "Existing Ground Surface TIN Triangulation Mesh" },
        { name: "SURV_MAJ_CONT", discipline: "SURV", color: 2, colorHex: "#ffff00", colorName: "Yellow (2)", linetype: "CONTINUOUS", lineweight: "0.25", plot: true, description: "Major Elevation Contour Lines (5ft / 10ft interval)" },
        { name: "SURV_MIN_CONT", discipline: "SURV", color: 253, colorHex: "#adadad", colorName: "Light Gray (253)", linetype: "CONTINUOUS", lineweight: "0.13", plot: true, description: "Minor Elevation Contour Lines (1ft / 2ft interval)" },

        { name: "UTIL_ELEC_EX", discipline: "UTIL", color: 30, colorHex: "#ff7f00", colorName: "Orange (30)", linetype: "FDOT_UTIL_ELEC", lineweight: "0.35", plot: true, description: "Existing Underground & Overhead Electric Lines" },
        { name: "UTIL_WATER_EX", discipline: "UTIL", color: 150, colorHex: "#0000ff", colorName: "Blue (150)", linetype: "FDOT_UTIL_WATER", lineweight: "0.35", plot: true, description: "Existing Potable Water Main & Fire Hydrant Lines" },
        { name: "UTIL_GAS_EX", discipline: "UTIL", color: 2, colorHex: "#ffff00", colorName: "Yellow (2)", linetype: "FDOT_UTIL_GAS", lineweight: "0.35", plot: true, description: "Existing Natural Gas Main Lines" },
        { name: "UTIL_COMM_EX", discipline: "UTIL", color: 210, colorHex: "#7f00ff", colorName: "Violet (210)", linetype: "FDOT_UTIL_FIBER", lineweight: "0.35", plot: true, description: "Existing Fiber Optic & Telecommunication Lines" },
        { name: "UTIL_SAN_EX", discipline: "UTIL", color: 3, colorHex: "#00ff00", colorName: "Green (3)", linetype: "FDOT_UTIL_SEWER", lineweight: "0.35", plot: true, description: "Existing Sanitary Sewer Force Main & Gravity Lines" },

        { name: "STR_PIER_PR", discipline: "STR", color: 7, colorHex: "#ffffff", colorName: "White (7)", linetype: "CONTINUOUS", lineweight: "0.50", plot: true, description: "Proposed Bridge Pier Foundations & Bent Columns" },
        { name: "STR_DECK_PR", discipline: "STR", color: 4, colorHex: "#00ffff", colorName: "Cyan (4)", linetype: "CONTINUOUS", lineweight: "0.70", plot: true, description: "Bridge Superstructure Deck Outlines & Girders" },
        { name: "STR_ABUT_PR", discipline: "STR", color: 3, colorHex: "#00ff00", colorName: "Green (3)", linetype: "CONTINUOUS", lineweight: "0.50", plot: true, description: "Proposed Bridge Abutment & Wingwall Outlines" },

        { name: "RW_LINE_PR", discipline: "RW", color: 1, colorHex: "#ff0000", colorName: "Red (1)", linetype: "FDOT_RW_LINE", lineweight: "0.70", plot: true, description: "Proposed Right-of-Way Line (FDOT Property Acquisition Boundary)" },
        { name: "RW_EASE_PR", discipline: "RW", color: 2, colorHex: "#ffff00", colorName: "Yellow (2)", linetype: "DASHED", lineweight: "0.35", plot: true, description: "Proposed Temporary Construction & Utility Easements" },

        { name: "ENV_WETL_EX", discipline: "ENV", color: 84, colorHex: "#408000", colorName: "Dark Green (84)", linetype: "FDOT_WETLAND", lineweight: "0.50", plot: true, description: "Existing Jurisdictional Wetland Boundary Limit" },
        { name: "TRAF_SIGN_PR", discipline: "TRAF", color: 2, colorHex: "#ffff00", colorName: "Yellow (2)", linetype: "CONTINUOUS", lineweight: "0.35", plot: true, description: "Proposed Highway Sign Assemblies & Overhead Trusses" },
        { name: "TRAF_MARK_PR", discipline: "TRAF", color: 7, colorHex: "#ffffff", colorName: "White (7)", linetype: "CONTINUOUS", lineweight: "0.35", plot: true, description: "Proposed Thermoplastic Pavement Markings & Arrows" },

        { name: "DSGNLT_POLE_PR", discipline: "LIGHT", color: 30, colorHex: "#ff7f00", colorName: "Orange (30)", linetype: "CONTINUOUS", lineweight: "0.35", plot: true, description: "Proposed Roadway Lighting Pole & Luminaire Assembly Locations" },
        { name: "DSGNLT_COND_PR", discipline: "LIGHT", color: 30, colorHex: "#ff7f00", colorName: "Orange (30)", linetype: "DASHED", lineweight: "0.25", plot: true, description: "Proposed Lighting Conduit & Pull Box Runs" }
    ],

    payItems: [
        { code: "0102-1-", description: "Maintenance of Traffic", unit: "LS", category: "Roadway", c3dLayer: "ROAD_NOPLOT_WORK", notes: "Lump Sum item covering MOT devices, message boards, and temporary barrier." },
        { code: "0110-1-1", description: "Clearing and Grubbing", unit: "AC", category: "Roadway", c3dLayer: "ROAD_TOPO_SLOPE", notes: "Acreage calculated from daylight slope limits." },
        { code: "0120-1-", description: "Regular Excavation", unit: "CY", category: "Earthwork", c3dLayer: "SURV_DTM_TIN", notes: "Cut volume calculated from TinVolume Surfaces." },
        { code: "0120-6-", description: "Embankment", unit: "CY", category: "Earthwork", c3dLayer: "SURV_DTM_TIN", notes: "Fill volume calculated from Corridor QTO." },
        { code: "0285-701-", description: "Optional Base Group 01", unit: "SY", category: "Base", c3dLayer: "ROAD_EOP_PR", notes: "Limerock / Cemented Coquina base under pavement." },
        { code: "0334-1-13", description: "Superpave Asphaltic Concrete, Traffic C", unit: "TN", category: "Pavement", c3dLayer: "ROAD_EOP_PR", notes: "Structural asphalt tonnage calculator." },
        { code: "0400-2-11", description: "Concrete Class II, Bridge Deck", unit: "CY", category: "Structure", c3dLayer: "STR_DECK_PR", notes: "Mapped to 3D solid corridor bridge deck shapes." },
        { code: "0425-1-351", description: "Inlets, Curb Inlet Type P-5, <10'", unit: "EA", category: "Drainage", c3dLayer: "DRAIN_STR_PR", notes: "Civil 3D Pipe Network structure catalog item." },
        { code: "0430-175-118", description: "Pipe Culvert, Optional Material, Round, 18\" S", unit: "LF", category: "Drainage", c3dLayer: "DRAIN_PIPE_PR", notes: "Civil 3D Pipe Network pipe catalog item." },
        { code: "0520-1-10", description: "Concrete Curb & Gutter, Type F", unit: "LF", category: "Roadway", c3dLayer: "ROAD_CURB_PR", notes: "Mapped to FDOTCurbGutterTypeF subassembly baseline length." },
        { code: "0522-1-", description: "Concrete Sidewalk and Driveways, 4\" Thick", unit: "SY", category: "Roadway", c3dLayer: "ROAD_SWK_PR", notes: "Concrete sidewalk shape area." },
        { code: "0700-1-11", description: "Single Post Sign, F&I Ground Mount, <12 SF", unit: "AS", category: "Traffic", c3dLayer: "TRAF_SIGN_PR", notes: "Block point insertion count." }
    ],

    surveyKeys: [
        { code: "MONU*", block: "FDOT_MONUMENT_PRM", layer: "SURV_MONUMENT", group: "Monuments", description: "Permanent Reference Monument Found", format: "PRM $%" },
        { code: "BENCH*", block: "FDOT_BENCHMARK", layer: "SURV_CTRL_PT", group: "Control", description: "FDOT Survey Benchmark Elevation Monument", format: "BM Elev $1" },
        { code: "CL*", block: "FDOT_CENTERLINE_PT", layer: "ROAD_ALIGN_EX", group: "Alignment", description: "Centerline Survey Point", format: "CL POB $%" },
        { code: "MH_STR*", block: "FDOT_DRAIN_MANHOLE", layer: "DRAIN_STR_EX", group: "Drainage", description: "Storm Sewer Manhole Top Rim", format: "MH Rim Elev $1" },
        { code: "INLET*", block: "FDOT_DRAIN_INLET", layer: "DRAIN_STR_EX", group: "Drainage", description: "Existing Inlet Structure Curb Throat", format: "Inlet Grate $1" },
        { code: "EOP*", block: "FDOT_POINT_EOP", layer: "ROAD_EOP_EX", group: "Roadway", description: "Existing Edge of Pavement Shot", format: "EOP $%" },
        { code: "TREE*", block: "FDOT_TREE_EX", layer: "ENV_WETL_EX", group: "Topo", description: "Individual Oak/Pine Tree Location & Caliper", format: "Tree $1in $2" },
        { code: "FH*", block: "FDOT_UTIL_FIRE_HYDRANT", layer: "UTIL_WATER_EX", group: "Utilities", description: "Fire Hydrant Top Operating Nut", format: "FH $%" }
    ],

    subassemblies: [
        { name: "FDOTLaneWithWidening", category: "Lanes", description: "Multi-layer roadway lane supporting automatic superelevation, widening rules, and variable pavement cross-slopes.", params: ["Width (12 ft)", "Default Slope (-2%)", "Struct Depth (0.25 ft)", "Base Depth (0.67 ft)"] },
        { name: "FDOTCurbGutterTypeF", category: "Curbs", description: "Official FDOT Type F curb & gutter profile matching Standard Plan 520-001 with subbase extensions.", params: ["Subgrade Slope (-2%)", "Gutter Width (2.0 ft)", "Curb Height (6 in)"] },
        { name: "FDOTShoulderBase", category: "Shoulders", description: "Paved and unpaved shoulder subassembly with optional daylight subbase extensions.", params: ["Paved Width (5.0 ft)", "Paved Slope (-5%)", "Base Depth (0.67 ft)"] },
        { name: "FDOTDitchTrapezoidal", category: "Daylight", description: "FDOT standard roadside ditch with configurable foreslope, flat bottom width, and backslope daylighting to existing surface.", params: ["Foreslope Ratio (4:1)", "Ditch Bottom (5.0 ft)", "Backslope Ratio (3:1)"] }
    ],

    sheetStandards: [
        { dwt: "CombinedLayers.dwt", title: "Master FDOT Civil 3D Template", scale: "Variable", layout: "Master DWT (5.7 MB)", description: "Pre-loaded with 1,000+ FDOT layers, text styles, dimension styles, and Civil 3D object styles." },
        { dwt: "FDOT-PlanProfile.dwt", title: "Plan & Profile Sheet (1\"=40')", scale: "1\" = 40'", layout: "ANSI D (22x34)", description: "Standard FDOT roadway plan view on top split with profile grid on bottom." },
        { dwt: "FDOT-CrossSection.dwt", title: "Roadway Cross Section Sheet", scale: "1\" = 10' Horiz / 1\" = 5' Vert", layout: "ANSI D (22x34)", description: "Corridor cross section grid sheets with earthwork volume tables." },
        { dwt: "keysht_WithoutMap.dwt", title: "Key Sheet (Title Page)", scale: "N.T.S.", layout: "ANSI D (22x34)", description: "Official project Key Sheet containing FPID number, location map, and index of sheets." },
        { dwt: "FDOT-TypicalSection.dwt", title: "Typical Section Sheet", scale: "N.T.S.", layout: "ANSI D (22x34)", description: "Roadway cross-sectional design template with pavement structure callouts." }
    ],

    boundaryQcEngine: {
        algorithms: [
            { name: "Moore-Neighbor Contour Tracing", description: "Traces outer perimeter of highlighted masks, placing red dot nodes strictly on outer tangent corner vertices." },
            { name: "Topological Sequence Checker", description: "Prevents out-of-order calls by physically re-tracing perimeter segments from StartPoint to EndPoint." },
            { name: "Bow-Tie & Self-Intersection Prevention", description: "Detects crossing polygon boundary lines and auto-suggests quadrant inversions (N/S E/W flips)." },
            { name: "Left vs Right Curve Direction Solver", description: "Vehicle tangent analogy determining arc concave direction (Left vs Right bulging)." },
            { name: "Curve Tangent Backsolving", description: "Deduces missing chord bearings and delta angles from following tangent lines." },
            { name: "Meander Tie-Line Backsolving", description: "Calculates missing geometric tie vectors from meandering water and boundary limits to close polygons." }
        ],
        sampleTraverse: "N 45-12-30 E 150.00\nS 44-47-30 E 200.00\nS 45-12-30 W 150.00\nN 44-47-30 W 200.00"
    },

    // COGO / boundary QC heuristics rendered on the Traverse & COGO tab.
    heuristics: [
        { rule: "Quadrant sanity", description: "A bearing quadrant (NE/SE/SW/NW) that repeats or reverses out of sequence usually means an inverted call — re-check N/S and E/W before plotting." },
        { rule: "Latitude/Departure closure", description: "Sum the northings and eastings of every course; the residual vector back to the POB is the linear misclosure. Perimeter ÷ misclosure is the precision ratio." },
        { rule: "Closure threshold (configurable)", description: "This tool flags closures below 1:10,000 by default. That is a QC preference, not a statutory number — current Rule 5J-17.051 ties accuracy to the survey type and its expected use, and FDOT/client contracts may set their own. Set the threshold per client in the master template." },
        { rule: "Self-intersection = bow-tie", description: "Plot the polygon from the courses and test every non-adjacent segment pair, including the closing segment. Any crossing is a topological error." },
        { rule: "Curve backsolving", description: "A missing chord bearing or delta can often be recovered from the adjacent tangent lines and the known radius." },
        { rule: "Meander tie-lines", description: "Close a meandering water boundary with computed tie vectors between the last located point and the POB rather than digitizing the meander itself." }
    ],

    // 7-item Map Check QA checklist — aligned to the BoundaryQC desktop app's
    // Checklist_Specifications.md (mathematical closure, curve node labels, certification,
    // legal-description congruency, adjoining R/W, acreage annotation, report generation).
    qcChecklist: [
        { id: "qc-1", title: "Mathematical Closure & Area Verification", category: "Geometry", desc: "Parse the boundary calls, compute the raw linear misclosure (POB to end of final call) and the Shoelace area, and confirm the computed acreage is within 1% of the surveyor's labeled area. Report the precision ratio (1:X); survey grade is ≥ 1:10,000." },
        { id: "qc-2", title: "Curve Node Annotations (PC, PT, PRC, PCC)", category: "Geometry", desc: "For every curve on the boundary, verify that PC / PT / PRC / PCC text labels exist within a 50-ft tolerance of the arc endpoints. Flag any arc missing its start or end node label." },
        { id: "qc-3", title: "Surveyor Certification & Signatures", category: "Legal", desc: "Confirm the plat carries a professional seal, a signature, the surveyor's name and license number, and the date of survey." },
        { id: "qc-4", title: "Legal Description matches map geometry", category: "Congruency", desc: "Convert the narrative metes-and-bounds legal description into a sequential array of bearing/distance calls and compare it line-by-line against the drafted line/curve table. Flag transposed digits, sequence breaks, or values outside tolerance (e.g. map L3 = 50.00', legal = 50.05')." },
        { id: "qc-5", title: "Adjoining Road Names & Right-of-Way", category: "Context", desc: "Verify adjoining public roads are named and that Right-of-Way widths are annotated where applicable. Warn if the parcel appears landlocked with no easement or road labeled." },
        { id: "qc-6", title: "Acreage specified on map", category: "Quantities", desc: "Flag if the overall area label is missing from the face of the plat." },
        { id: "qc-7", title: "Generate Map Check Report", category: "Output", desc: "Aggregate the section headers, data logs, and PASS/FAIL statuses from items 1–6 into a formatted Map Check Report and attach it to the diagnostic/QA output file." }
    ]
};

// Global export for explicit window access
window.FDOT_DATA = FDOT_DATA;
