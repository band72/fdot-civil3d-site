/**
 * Plugin: help (Help & User Manual)
 * plugins/help/help.js
 *
 * Renders the in-app user manual into the Help tab. Content is inline (the app
 * runs from file:// and CSP blocks fetch, so an external .md/.html cannot be
 * loaded). Also binds "?" / F1 to jump to Help, and offers a printable copy.
 *
 * Registers via window.PluginRegistry.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "help",
        version: "1.0.0",
        description: "In-app user manual: every tab, the input formats it accepts, what it computes, exports, a glossary, and the limits of this demo build.",
        tab: "tab-help",
        icon: "fa-circle-question",
        tier: "Free",
        dependencies: []
    };

    // ── Manual content ───────────────────────────────────────────────────────
    // Each section: { id, title, html }. Rendered with a table of contents.

    const SECTIONS = [
        {
            id: "quick-start",
            title: "Quick start",
            html: `
                <p>Pick a tool on the left, try its <em>Load sample</em> / <em>Load demo</em> button first, then load your own file and use the tool's download buttons. Everything runs in this browser; files never leave your computer.</p>
                <h4>Files the tools read</h4>
                <p>ASCII DXF, LandXML, CSV and point files (P,N,E,Z,D), and Excel <code>.xlsx</code> for the JEA tools. <strong>Not DWG</strong> — convert it first:</p>
                <ul>
                    <li><strong>One drawing:</strong> in Civil 3D / AutoCAD run <code>DXFOUT</code> (or <em>Save As</em> → <em>AutoCAD 2018 DXF</em>) and keep the default ASCII format.</li>
                    <li><strong>Many drawings:</strong> the free <em>ODA File Converter</em> (Open Design Alliance) converts a folder of DWG files to DXF in one pass — choose output <em>ACAD2018</em>, <em>DXF</em>.</li>
                </ul>
                <h4>Checking a JEA as-built package</h4>
                <ol>
                    <li><strong>Workbook:</strong> <em>JEA As-Built 2026</em> → <em>Reverse-Read DXF Auditor</em> → pick the As-Built <code>.xlsx</code>. Work through the workbook-check findings (lat/lon vs State Plane, top + depth vs grade, duplicates, coordinate typos); <em>Download findings CSV</em>; fix the sheet and import it again.</li>
                    <li><strong>Drawing:</strong> pick the drawing's <code>.dxf</code> in the same picker. A score appears only when it has JEA blocks or pipes on JEA layers — most consultant drawings show <em>NOT SCORED</em>, which is expected.</li>
                    <li><strong>Package:</strong> add the PDF set and the eTransmit <code>.txt</code> under <em>Package files</em>, then click <em>Check Package</em>: sheet and certification fields, the drawing's State Plane position, every workbook ID against the drawing, and PDF pages / missing files.</li>
                    <li><strong>Optional:</strong> <em>Extract Pipe Network</em> and <em>Drawing Builder</em> make a drawing on JEA layers with JEA blocks.</li>
                    <li><strong>Once:</strong> in <em>Settings</em>, confirm the as-built layer names you use, set the tolerances, and load the current JEA template's picklists.</li>
                </ol>
                <h4>When something looks wrong</h4>
                <table class="help-table">
                    <thead><tr><th>You see</th><th>Do this</th></tr></thead>
                    <tbody>
                        <tr><td>A <code>.dwg</code> won't load</td><td>Convert it to DXF (above)</td></tr>
                        <tr><td><em>NOT SCORED</em> on a JEA audit</td><td>Import the workbook, extract the pipe network, or confirm the drawing's layer names in JEA <em>Settings</em></td></tr>
                        <tr><td>Many "outside the Florida East bounds" errors</td><td>The drawing is in local coordinates or other units; <em>Check Package</em> reports the shift</td></tr>
                        <tr><td>A value flagged that you know is right</td><td>Lat/lon and depth tolerances are JEA's (0.5 ft horizontal, 0.1 ft vertical — Standards 2026 §501 II.1.7); the other two are this tool's. Change a tolerance in <em>Settings</em> or note the finding as reviewed</td></tr>
                        <tr><td>Settings gone</td><td>They're kept in one browser only — use the same browser, not a private window</td></tr>
                    </tbody>
                </table>
                <p>Every result is a QC aid, not a certification; reference values are illustrative until checked against the current FDOT / JEA publication. Use <em>Report a problem</em> at the bottom of the page for anything that looks wrong.</p>`
        },
        {
            id: "overview",
            title: "1. Overview",
            html: `
                <p>The <strong>FDOT Civil3D Standards Suite</strong> is a browser tool for surveyors and civil designers working to FDOT CADD standards. It runs entirely in your browser — there is no server, no upload, and no account. Files you drop in are read locally and never leave the machine.</p>
                <p>The app is organized into tabs on the left. Each tab is an independent plugin. The three groups are:</p>
                <ul>
                    <li><strong>Reference</strong> — Layer Standards, Pay Item Takeoff, Survey Description Keys, Block Libraries, Subassemblies, Sheet Standards, State Kit Inspector. Read-only catalogs.</li>
                    <li><strong>Tools</strong> — DXF Project Auditor, QC Checklist &amp; Traverse Auditor, Legal Description QC, PLSS Section Breakdown, Parcel → DXF, Sign QTO, SSA Hydrology, Linework Editor, Electronic Field Book, LandXML Studio, Multi-Sheet Batch Auditor, Centralized Reports Hub, System Diagnostics, and JEA As-Built Standards 2024. These take input and compute results you can export.</li>
                    <li><strong>Demo</strong> — Commercial SaaS Plans, Enterprise &amp; C3D Plugin, CMS Control Panel. These illustrate a product shell; see <a href="#limits" data-goto="limits">Section 8, Limits</a>.</li>
                </ul>
                <div class="help-note help-note--warn">
                    <strong>Demo build.</strong> Anything about licensing, sign-in, payments, PKI seal validation, or multi-tenant isolation is illustrative only and enforced by nothing. Do not rely on it. The calculation tools (closure, area, DXF audit, PLSS math) are real.
                </div>`
        },
        {
            id: "navigation",
            title: "2. Navigation & shortcuts",
            html: `
                <table class="help-table">
                    <thead><tr><th>Action</th><th>How</th></tr></thead>
                    <tbody>
                        <tr><td>Switch tab</td><td>Click a button in the left sidebar</td></tr>
                        <tr><td>Focus the global search</td><td><kbd>Ctrl</kbd>+<kbd>K</kbd> (or <kbd>⌘</kbd>+<kbd>K</kbd>)</td></tr>
                        <tr><td>Search layers / pay items / survey keys</td><td>Type in the header search box — it filters all three reference tables and jumps you to Layer Standards</td></tr>
                        <tr><td>Open this Help</td><td><kbd>?</kbd> or <kbd>F1</kbd> (when not typing in a field)</td></tr>
                        <tr><td>Light / dark theme</td><td>The sun/moon button in the header</td></tr>
                        <tr><td>Dismiss a dialog</td><td><kbd>Esc</kbd></td></tr>
                    </tbody>
                </table>`
        },
        {
            id: "stdn-compare",
            title: "3.1  Start page — Standards Compare + Auto-Correct",
            html: `
                <p><em>Purpose:</em> check a drawing against a drafting standard, diff its geometry against a reference drawing, and auto-correct the deficiencies that are safe to fix. Runs entirely in the browser — nothing is uploaded. (This replaces the older layer-table-only "Template Compare".)</p>
                <h4>Check mode</h4>
                <p>Drop the <strong>drawing to check</strong>, then supply one or more of:</p>
                <ul>
                    <li><strong>A standard</strong> — the built-in <em>FDOT 2026 Layer Standard</em>, another built-in, or your own uploaded <code>.json</code> spec (layers, colours, linetypes, naming regex, required/prohibited layers, text-style whitelist, units, ByLayer policy). Pick <em>(none)</em> for a geometry-only diff.</li>
                    <li><strong>A master template DXF</strong> — its LAYER / LTYPE / STYLE tables and BLOCKS <em>become</em> the rules; merged on top of the JSON standard if you supply both.</li>
                    <li><strong>A reference drawing DXF</strong> — a drawing with real design content to tolerance-diff the geometry against (added / removed / modified entities, with a pan/zoom SVG overlay: gray = unchanged, blue = added, red = removed, orange = modified).</li>
                </ul>
                <p>The result shows a pass/fail verdict, a severity-filtered <strong>violations</strong> table, a geometry <strong>diff</strong> breakdown, and a downloadable <strong>HTML</strong> or <strong>Markdown</strong> report.</p>
                <h4>Auto-correct mode</h4>
                <p>Give a <strong>target</strong> + a <strong>master template</strong>. The tool auto-fixes what's safe — wrong layer colours / linetypes / lineweights, missing layers / linetypes / styles copied from the master, stray entity colour overrides reverted to ByLayer — and hands back a corrected <code>.dxf</code>. Renames, prohibited-layer removal, unit changes and (opt-in) missing blocks are listed for manual review, never guessed. ByBlock colour (code 0) is left untouched — it's a legitimate mode, not an error.</p>`
        },
        {
            id: "dxf-auditor",
            title: "3.2  DXF Project Auditor",
            html: `
                <p><em>Purpose:</em> score an FDOT project DXF against CADD standards and flag geometry / scripting errors before submittal.</p>
                <p><strong>Input:</strong> drag an ASCII DXF onto the drop zone, click <em>Browse DXF File</em>, or load one of the three bundled samples (SR-50 corridor, Jacksonville bow-tie, non-compliant drainage). Binary DXF is not supported — save as ASCII/plain DXF from Civil 3D.</p>
                <p><strong>What it checks:</strong></p>
                <ul>
                    <li>Entities on <code>Layer 0</code> or <code>DEFPOINTS</code> (should be on FDOT discipline layers / <code>ROAD_NOPLOT_WORK</code>).</li>
                    <li>Layer names that do not start with an FDOT discipline prefix (<code>ROAD_ DRAIN_ SURV_ UTIL_ STR_ RW_ ENV_ TRAF_ LIGHT_</code>).</li>
                    <li>Layer color that does not match the FDOT standard ACI for that layer name.</li>
                    <li>Zero-length lines; unclosed boundary polylines (gap between first and last vertex on <code>SURV_BND*</code> / <code>RW_LINE*</code>).</li>
                    <li>Self-intersecting ("bow-tie") polylines — every non-adjacent segment pair is tested, including the closing segment of a closed polyline.</li>
                    <li>Coordinates outside the Florida State Plane NAD83 (US ft) envelope.</li>
                </ul>
                <p><strong>Output:</strong> a compliance score (100 minus weighted deductions), a layer / entity count, an itemized issue list by severity, a canvas preview of the geometry with the bow-tie marked, and an <em>auto-fix <code>.scr</code></em> — an AutoCAD script that runs <code>AUDIT</code>, resets non-standard layer colors to the FDOT ACI, purges, and overkills. <strong>Review the script in a scratch copy before running it on a production drawing.</strong></p>
                <p>Hover the preview to read live NAD83 coordinates. The R-Tree line reports how many entities were indexed and the parse time — informational only.</p>`
        },
        {
            id: "layers",
            title: "3.3  Layer Standards / Pay Items / Survey Keys",
            html: `
                <p><em>Purpose:</em> the FDOT 2026 reference catalogs.</p>
                <ul>
                    <li><strong>Layer Standards</strong> — name, color swatch + ACI, discipline, linetype, lineweight, plot status, description. Filter by discipline pill or the plot-status dropdown. The header search box also filters this table. Click the copy button to put a layer name on the clipboard.</li>
                    <li><strong>Pay Item Takeoff</strong> — FDOT pay item number, description, unit, category, and the Civil 3D layer the item maps to for quantity takeoff. Copy button copies the item number.</li>
                    <li><strong>Survey Description Keys</strong> — point-code pattern, style block, target layer, point group, description, and format string.</li>
                </ul>`
        },
        {
            id: "qc-traverse",
            title: "3.4  QC Checklist & Traverse Auditor",
            html: `
                <p><em>Purpose:</em> the pre-submittal QA checklist plus a real traverse calculator.</p>
                <p><strong>QC checklist</strong> — the 7-item Map Check specification (mathematical closure &amp; area, curve node labels PC/PT/PRC, surveyor certification, legal-description congruency, adjoining road / R-O-W, acreage annotation, and Map Check Report generation). Read the objective and pass/fail logic for each.</p>
                <p><strong>Traverse Auditor</strong> — paste bearing/distance calls, one per line (see <a href="#fmt-bearings" data-goto="fmt-bearings">Section 5, bearing formats</a>). Click <em>Run Bow-tie Verification</em>. It computes, per course, the latitude (N·cos az) and departure (E·sin az); sums them; the residual vector back to the POB is the <strong>linear misclosure</strong>. <strong>Precision ratio</strong> = perimeter ÷ misclosure; the tool flags anything below <strong>1:10,000</strong> by default — a QC preference you can change per client template, not a statutory number (current Rule 5J-17.051 ties accuracy to the survey type and its expected use). It also plots the polygon and tests it for self-intersection, and reports the area in acres. For legal descriptions, the area includes the arc-to-chord segment of every curve whose turn direction (left/right, or a concavity) is stated; curves without one are flagged as chord-only.</p>
                <p><strong>2D or 3D closure</strong> — with bearing and distance only, the closure is 2D (horizontal) and the points get Z 0.000. End <em>every</em> call with a vertical part for a 3D closure: <code>DZ +1.25</code> for record data (horizontal distance and the rise, negative for a fall) or <code>ZA 89-30-00</code> for field data (the distance is then the slope distance, reduced by the zenith angle). A 3D traverse needs the starting (POB) elevation; the misclosure is then √(ΔLat² + ΔDep² + ΔZ²) over the slope perimeter, the vertical misclosure is reported on its own, and the points carry their real elevations. Mixing calls with and without a vertical part is an error. Area is always horizontal.</p>
                <p><em>Generate Map Check Report</em> downloads a <code>.log</code> with the course list, closure statistics, area, self-intersection result, and a P,N,E,Z,D coordinate block (points from 500, "COGO POB / COGO P1 …").</p>`
        },
        {
            id: "linework",
            title: "3.5  Linework Editor",
            html: `
                <p><em>Purpose:</em> import linework from <strong>field data</strong>, check it for the common blunders, and correct it interactively. (Linework already inside a DXF is corrected in the DXF Project Auditor.)</p>
                <h4>Import</h4>
                <ul>
                    <li><strong>File Upload &amp; Drag-and-Drop</strong> — Drop or browse point coordinate files (<code>.txt</code>, <code>.csv</code>, <code>.pts</code>, <code>.pnt</code>, <code>.dat</code>) or bearing/distance call lists directly into the upload dropzone. Supports quote-aware CSV parsing (preserving commas in descriptions such as <code>"CURB B, R10"</code>) and automatic header detection (e.g. <code>Point,Northing,Easting,...</code>). Malformed or corrupt rows are flagged in the interactive diagnostics panel and logged with line numbers and reasons to the <strong>System Logs</strong> plugin.</li>
                    <li><strong>Point file</strong> — a P,N,E,Z,D coordinate file (comma, tab, or space delimited; Z optional). Set the coordinate order (P,N,E,… or P,E,N,…). Descriptions carry linework codes after the feature code, matching the Civil 3D Linework Code Set: <code>B</code> begin a figure, <code>C</code> continue an interrupted figure, <code>E</code> end it (no closing segment), <code>CLS</code> close it (draws the segment back to the start), plus an optional figure number (so <code>EP 2 B</code> starts a second EP line). <strong>Curve codes are resolved into real geometry:</strong> <code>BC</code>…<code>EC</code> (or <code>PC</code>…<code>PT</code>) fits a circular arc through the bracketed shots — reported with radius and fit residual, exported as a DXF bulge; <code>CIR</code> makes the whole figure a circle from 2 shots (centre + radius) or 3 shots (through-points); <code>RECT</code> completes a rectangle from 3 shots. The remaining line codes (<code>RT</code> right-turn, <code>X</code> extend, <code>RPN</code>/<code>CPN</code> recall/connect, <code>H&lt;n&gt;</code>/<code>V&lt;n&gt;</code>/<code>SO</code> offsets) are recognized and listed but must be applied in CAD.</li>
                    <li><strong>Build linework</strong> — <em>By description code</em> connects points that share a code, in point-number order. <em>By figure</em> also splits on a trailing figure number (so <code>EP 1</code> and <code>EP 2</code> are separate lines). <em>Single line</em> connects every point in order.</li>
                    <li><strong>Bearing/distance calls</strong> — paste a traverse (one course per line) and <em>Import as calls</em>. This figure is treated as a traverse, so misclosure and precision are checked.</li>
                    <li><em>Load sample field data</em> gives you a set with a normal boundary, a re-shot POB, a duplicate shot, and a bow-tie to see the checks fire.</li>
                </ul>
                <h4>Checks</h4>
                <p>Run automatically on import and after every edit: coincident / zero-length courses, spike / backtrack vertices (a course that reverses on itself — usually a mis-sequenced shot), near-coincident vertices (merge candidates), self-intersection (bow-tie), traverse misclosure and precision (calls only), duplicate point numbers, coordinates outside the Florida State Plane envelope, and figures that cross each other. Each finding has <em>Go to</em> (select and pan to it) and, where possible, <em>Fix</em> (delete the vertex, merge, snap to POB, or auto-untangle a bow-tie).</p>
                <h4>Playback</h4>
                <p>The bar under the canvas walks the shots <strong>in field-collection order</strong>. Drag the slider, use ◀ ▶ (or the <kbd>←</kbd> <kbd>→</kbd> keys), or press play (<kbd>Space</kbd>) to animate. Points and courses up to the cursor are drawn bright, the rest dimmed, and the readout shows the current shot number, code, and coordinates — a fast way to find the exact shot where the linework goes wrong. Clicking a vertex moves the slider to it.</p>
                <h4>Editing</h4>
                <ul>
                    <li><strong>Navigate</strong> — use <em>Zoom In (+)</em>, <em>Zoom Out (-)</em>, and <em>Fit (F)</em> buttons (or floating on-canvas controls), mouse wheel to zoom, drag background to pan, <kbd>+</kbd> / <kbd>-</kbd> / <kbd>F</kbd> shortcut keys.</li>
                    <li><strong>Vertex</strong> — click a red dot to select; drag to move (it snaps to a nearby vertex). The Selection panel gives numeric E/N, <em>Snap to nearest</em>, <em>Swap with next</em> (point-order bow-tie fix), and <em>Delete</em>. <kbd>Delete</kbd> removes the selected vertex.</li>
                    <li><strong>Course</strong> — click a segment to select; edit its bearing and distance numerically. <em>Traverse edit</em> (checkbox) shifts every downstream vertex with the course; otherwise only the far vertex moves. <em>Flip E/W</em> / <em>Flip N/S</em> fix a bearing entered in the wrong quadrant; <em>Insert vertex</em> splits the course.</li>
                    <li><strong>Figure</strong> — rename, set the target layer (defaulted from the description code and your active client template), toggle closed, reverse point order, delete, or add a new empty figure.</li>
                    <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> undo / redo.</li>
                </ul>
                <h4>Export</h4>
                <p><strong>DXF</strong> (closed/open polylines on the assigned layers), <strong>P,N,E,Z,D</strong> point file, <strong>Linework Script (.fbk)</strong> (Civil 3D Survey Command Language batch script with <code>FIG BEGIN/PT/CLOSE/END</code> and <code>NEZ</code>), <strong>Calls</strong> (bearing/distance per figure), and a <strong>Map Check</strong> report (perimeter, misclosure/precision for closed figures, area, self-intersection, and the full check list).</p>`
        },
        {
            id: "survey-cmd-lang",
            title: "3.6  Civil 3D Survey Command Language & Field Book Reference",
            html: `
                <p><em>Purpose:</em> reference and export guide for the text-based command interpreter built into <strong>Autodesk Civil 3D</strong> (Survey Toolspace &gt; Survey Database &gt; Networks &gt; Survey Command Window) and Autodesk Field Book (<code>.fbk</code>) files.</p>
                <h4>Core Syntax &amp; Bearings</h4>
                <ul>
                    <li><strong>Quadrant Bearings:</strong> <code>1 = NE</code>, <code>2 = SE</code>, <code>3 = SW</code>, <code>4 = NW</code>. Angles are entered in <code>DD.MMSS</code> notation (e.g. <code>1 45.3020</code> = N 45°30'20" E).</li>
                    <li><strong>Point Creation (COGO):</strong>
                        <code>NEZ [pt] [N] [E] [elev] (desc)</code> direct coordinate insertion;
                        <code>BD [pt] [quad] [bearing] [dist] (desc)</code> bearing &amp; distance from station;
                        <code>AD [pt] [angle] [dist]</code> angle &amp; distance;
                        <code>AZ [pt] [azimuth] [dist]</code> azimuth &amp; distance.
                    </li>
                    <li><strong>Figures &amp; Linework:</strong>
                        <code>FIG BEGIN [name]</code> starts a figure;
                        <code>FIG PT [pt]</code> appends a vertex;
                        <code>FIG CLOSE</code> closes back to POB;
                        <code>FIG END</code> finishes the figure.
                    </li>
                    <li><strong>Field Book Observations (.FBK):</strong>
                        <code>UNIT FOOT DMS</code> sets units;
                        <code>STN [pt] [HI]</code> occupies instrument station;
                        <code>BS [pt] [azimuth]</code> sets backsight reference;
                        <code>FS [pt] [angle] [dist] [zenith] [rod]</code> foresight traverse shot;
                        <code>SS [pt] [angle] [dist] [zenith] [rod]</code> sideshot topography.
                    </li>
                    <li><strong>Traverse &amp; Adjustments:</strong>
                        <code>TRV OPEN [name]</code>, <code>TRV COMP [name]</code> (misclosure calculation), <code>COMPASS</code> (Bowditch / compass-rule balance), <code>TRANSIT</code>, <code>CRANDALL</code>.
                    </li>
                </ul>
                <p>The suite automatically generates production-ready <code>.fbk</code> scripts from the <strong>Linework Editor</strong>, <strong>Legal Description QC</strong>, and <strong>Traverse &amp; COGO Auditor</strong> tabs.</p>`
        },
        {
            id: "materials-doc",
            title: "2.6  Materials (JEA materials, pipe sizes, fittings)",
            html: `
                <p><em>Purpose:</em> one reference for utility materials. Reference values — verify sizes, classes and standards against the governing standard, the utility's current specifications and the manufacturer before design or procurement.</p>
                <ul>
                    <li><strong>JEA template materials:</strong> every material and equipment list in the JEA As-Built template (2026 lists) — pipe and fitting materials, pipe classes and linings, pipe types, fitting / valve / meter subtypes, valve types, hydrant models, manhole materials and linings, meter boxes, manufacturers and the standard sizes. Read live from the template, so it always matches.</li>
                    <li><strong>Pipe sizes:</strong> pick a sizing system — IPS (steel, PVC Sch 40/80, HDPE IPS), DIPS (ductile iron, C900 PVC), PVC gravity sewer (D3034 / F679) or CTS (service tubing). Each row gives the nominal size, its DN designation, and the outside diameter in inches and millimetres. Choose <em>Imperial</em>, <em>Metric</em> or both. Millimetres are computed (× 25.4); DN is a size label, not a measurement, and sizes without a standard DN show "—".</li>
                    <li><strong>Pipe systems, appurtenances, fittings:</strong> water main and service, gravity sewer, force main and lateral, and gas service — material, governing standard, sizes and classes; valves, hydrants, manholes, meters, corporation / curb stops, excess-flow valves and risers; and the typical fittings for each.</li>
                    <li><strong>Filters and export:</strong> search, utility (Water / Sewer / Gas) and units; <em>Export shown rows</em> writes what's on screen to CSV.</li>
                </ul>`
        },
        {
            id: "easy-button-doc",
            title: "1.5  Easy Button (field data to drawing)",
            html: `
                <p><em>Purpose:</em> one guided path from a crew's field file to linework on the right layers. Easy Button runs the other tools in order — it doesn't change them.</p>
                <ol>
                    <li><strong>Code list:</strong> upload a CSV with three columns — <em>code</em> (what the crew types), <em>description</em>, and <em>our code</em> (the standard code it means; download our code list from the tab). A header row is optional. Codes whose our code is blank get a suggestion from the code and description (abbreviations such as INLT → inlet count); a typo'd our code is flagged with a "did you mean". Every row can be changed in the table. Codes that are also linework control words (B, E, CL, PC…) are warned about — shots using them may start, end or close figures. Save the list as a <em>profile</em> to reuse it on every job: in this browser, in the PostgreSQL database (<em>Save to database</em> / <em>Load from database</em> — needs the bridge server, <code>npm start</code>; profiles are kept per organization), or as a JSON file (<em>Export</em> / <em>Import</em>). The template drawing is remembered in this browser too — with the profile it was used with, and the last one used — so it needn't be uploaded every session.</li>
                    <li><strong>Field data:</strong> a P,N,E,Z,D point file in the crew's codes. Each shot's code is translated to ours (begin / end / close words, figure numbers and curve codes are kept), then figures are built with the Linework engine — lines on our default layers (JEA layers for water, sewer and reclaimed), point codes kept as point features with their symbol (JEA_VALVE, JEA_HYDRANT…). On pipe shots, Z is the <em>invert</em>, kept on every vertex. Codes with no match go on layer EB-UNMAPPED and are listed, with a button to add them to the code list.</li>
                    <li><strong>Edit:</strong> open the linework in the Linework Editor to fix vertices and close figures — step 4 writes what's in the editor. Or download the translated P,N,E,Z,D file, the point features, or the code list with our codes filled in. For a Civil 3D survey database: the <em>Civil 3D linework script</em> (NEZ points, then FIG BEGIN / PT / CLOSE / END — figures named by our codes) and a <em>figure prefix list</em> (name, layer — your template's once matched — breakline, lot line) to set up the matching figure prefixes. Pipes aren't breaklines: their elevations are inverts, not ground.</li>
                    <li><strong>Template &amp; drawing:</strong> upload your template drawing (ASCII DXF with your layers and symbols), or use the JEA template. Each of our codes is matched to a template layer, and point codes to a symbol, by name — including National CAD Standard layer names (C-UTIL-WATR, C-UTIL-SSWR-MANH, V-PROP-LINE…). Change any match; matches are saved with the profile. <em>Write DXF into the template</em> downloads your template with the survey drawn into it: its layers, linetypes, text styles, symbols and existing entities are kept; pipes are 3D polylines that keep every invert; other linework is 2D with arcs kept; symbols are inserted with their attributes filled — point number, elevation / invert / rim, description, code — and other attributes keep the template's defaults. A code with no symbol is drawn as a point and label; layers the template lacks are added. In R2000-and-later templates every new object gets its own handle. The written file is checked: every layer and symbol it uses must be defined.</li>
                    <li><strong>Pipe crossings:</strong> <em>Find crossings</em> finds every place two pipes cross in plan. At each one the pipe inverts are interpolated between their shots; by default the top of each pipe is invert + inside diameter + wall and the bottom is invert − wall, using the outside diameters in the Materials size tables and published wall thicknesses — ductile iron at its minimum pressure class (ACIPCO: PC 350 to 12 in, PC 250 14–20 in, PC 200 24 in) or C900 PVC DR 18 (wall = OD ÷ 18) for water, reclaimed and force main; PVC SDR 35 (ASTM D3034, wall = OD ÷ 35 — table values from the 2000 edition, 8 in checked against current product listings; the 2024 edition, D3034-24e1, wasn't checked size by size) for gravity sewer; reinforced concrete pipe ASTM C76 Wall B (Iowa DOT table) for storm, sized by inside diameter. A size with no published wall falls back to invert + outside diameter and says so. You can also choose invert + outside diameter, or invert + nominal size. These are representative published values for a concept check — confirm against the project's pipe specification. Separation = upper pipe bottom − lower pipe top. Where a water main is in the crossing it is checked against JEA Standards 2026 §350 III.4.4–III.4.5: at least 6 in above (12 in preferred) or 12 in below a gravity or vacuum sewer or a storm sewer, and 12 in above or below a force main or reclaimed main. Other crossings use the <em>Minimum separation where no water main</em> you set. Finished grade is estimated from non-pipe shots within the radius you set; cover = grade − top of pipe. Pipe size comes from a <em>SIZE</em> column in the field file (with a header row), else the shot's description written as <code>8IN</code> (a bare 8 is a figure number, and a CSV point file drops the quote from 8"), else the code list's optional <em>Size</em> column, else the defaults you set per pipe type; with none, the crossing is "not scored", never guessed. The code list's optional <em>Material</em> (DI, C900 DR14/18/25, PVC SDR 26/35, RCP) and <em>Class</em> (ductile-iron pressure class 200–350) columns set each code's wall, overriding the step 5 default; a material with no published wall data (e.g. HDPE) is warned about and the default is used. A crossing whose invert was interpolated farther from a shot than the limit you set is flagged "check" — it's still scored, but the separation is only as good as that interpolation. <em>Drag a box</em> on the plan around crossings that need a table (wheel to zoom, double-click for the whole site, click a box to remove it, or <em>Box every crossing</em>). Each box gets a crossing table in the JEA Pipe Crossing Table format beside it, and each boxed crossing a JEA_CROSSING-style symbol (if the template has one) with its attributes filled. <em>Crossing table CSV</em> downloads the rows in JEA column order.</li>
                </ol>`
        },
        {
            id: "subdivision-doc",
            title: "2.8  Subdivision (concept lot layout)",
            html: `
                <p><em>Purpose:</em> a quick yield study. Divide a boundary into lots with a new road, retention ponds and green space, and see straight away how many lots meet your minimums. It is a concept layout — not a plat and not a drainage design: lot lines aren't dimensioned, and utilities and grading aren't modelled; setbacks, easements and pond side slopes are simple planning checks, not a design.</p>
                <ul>
                    <li><strong>Boundary:</strong> paste bearing/distance calls (they must close) or N, E coordinates, <em>upload a point file</em> (P, N, E, Z, D — a header row is skipped; elevation and description are read but the outline uses the points in file order; type a word such as BND in <em>Only points whose description contains</em> to use just the boundary shots of a larger field file), load the sample tract, take the largest closed figure from the Linework Editor, or take Easy Button's boundary (the largest closed BND figure it built). Set <em>Units</em> to metres for a metric boundary — it's converted to US survey feet (× 3937/1200), since every setting is in feet. Pick the <em>frontage edge</em> — the existing street — from the list, or click an edge in the plan.</li>
                    <li><strong>Lot standard:</strong> pick a City of Jacksonville / Duval County residential low-density district (RLD-40 … RLD-100B, Ordinance Code §656.305) to fill the minimum frontage, lot size and acres — verify against the current code text — or keep Custom and type them.</li>
                    <li><strong>Lots:</strong> number of lots, minimum frontage (width, ft), minimum depth (ft — each lot's average depth, area ÷ frontage; 100 ft to start), minimum size (sq ft), minimum size required (acres) and maximum lot depth (ft). Lots front the road with equal frontage; lot lines are perpendicular to the road and radial around curves and the cul-de-sac. Land behind the lot depth is remainder. A lot that misses a minimum is drawn red, with the reason in the table. <em>Use max</em> sets the largest count where every lot passes.</li>
                    <li><strong>Corner lots:</strong> the first and last lot on a street corner (at the frontage street, and at the far end of a through or loop road) must be <em>Corner lot extra width</em> wider (10 ft to start), and each corner gets a <em>sight triangle</em> (legs along both streets, 25 ft to start — check the local sight-distance rule) that is kept clear of buildings. Corner lots are marked in the table.</li>
                    <li><strong>Easements:</strong> a front utility easement (10 ft to start) and an optional rear easement are drawn on each lot (grey, dashed). They push the building envelope back where they're wider than the setback.</li>
                    <li><strong>Merge failing end lots:</strong> when the first or last lot on a road side misses a minimum, it's folded into its neighbour — fewer, bigger lots. The checks say how many were merged.</li>
                    <li><strong>Phases:</strong> split the lots into 1–20 construction phases, in order along each road. The phase is in the table and on the DXF lot labels (PH n).</li>
                    <li><strong>Setbacks & building envelope:</strong> turn it on to draw each lot's buildable area (orange, dashed) — front, side and rear setbacks inside the lot, outside the sight triangles and the easements — and check it against a minimum buildable area. The RLD presets fill the setbacks too (front / side / rear, from the City's zoning summary).</li>
                    <li><strong>Road:</strong> turn it on or off. It enters from the frontage street (ingress) at the position you set — type it, use the slider, or drag the road in the plan. <em>Alignment</em>: straight, one curve, or a reverse curve (S-curve) — set the straight before the first curve, each curve's centreline radius and deflection, which way it turns — the <em>Left / Right</em> toggle beside Alignment (driving in from the frontage; a reverse curve's second curve turns the other way) — and the straight between the curves. <em>Number of roads</em>: one, or two parallel straight roads entering from the frontage at their own positions (drag either one) — the lots on the sides facing each other share the gap between them, and ponds go behind the outer lots only. A <em>cul-de-sac</em> runs the length you set and ends in a turnaround bulb of the given radius; a <em>through road</em> runs to the back boundary for a second access (egress); a <em>loop</em> (two roads) joins the two roads at the road length you set, with a connector road across the back — the lots behind the connector front it. Lots on the inside of a curve can't be deeper than its inside radius (centreline radius less half the road width), or they would overlap — the tool says so. The road's area is checked against the allowable road area.</li>
                    <li><strong>Retention ponds:</strong> turn them on or off. By default the required pond area is sized from the impervious surface: gross area × impervious % (40% by default) × runoff to retain (1.0 in) ÷ average pond depth (3 ft). Switch the sizing off to type the required square footage instead. Set the number of ponds and how they connect: in series (pond to pond, then to the road), each pond piped to the road, or not connected — the pipe length is reported. Ponds run behind the lots, parallel to the road, starting at the lot depth: either <em>fixed width</em> (the default, 40 ft) and only as long as needed, from the back end of each side — compact ponds — or a <em>strip along the whole road</em> whose width is solved to hold the required area. They're split into the number of ponds you set (a pond never straddles a road). A fixed-width pond is sized by volume: the required volume (gross × impervious × runoff) fills a pond with the <em>side slopes</em> (4:1 to start) and <em>freeboard</em> (1 ft) you set, so it's longer than a vertical-sided one. Check the sizing against your water management district's rules.</li>
                    <li><strong>Green space:</strong> turn it on or off. It's taken off the back of the parcel at the required percentage of the gross area (a through road crossing it doesn't count as green).</li>
                    <li><strong>Recommended settings:</strong> 60 ft frontage, 7,500 sq ft / 0.17 ac lots up to 150 ft deep, a straight 50 ft road with a 50 ft cul-de-sac radius, road area up to 25% of gross, 40% impervious with two ponds in series, 10% green space, and the most lots that pass. They are typical starting values — check them against the governing codes.</li>
                    <li><strong>Scenarios:</strong> <em>Save</em> the current settings and results under a name to compare layouts side by side (lots, average lot, road, pond, remainder, all passing). <em>Load</em> brings a scenario's boundary and settings back. Scenarios are kept in this browser.</li>
                    <li><strong>Export:</strong> <em>DXF</em> (layers SUBD-BOUNDARY, SUBD-LOT, SUBD-ROAD-ROW, SUBD-ROAD-CL, SUBD-GREEN, SUBD-POND, SUBD-POND-HATCH, SUBD-POND-PIPE, SUBD-BUILDABLE, SUBD-EASEMENT, SUBD-SIGHT, SUBD-TEXT), a one-page <em>PDF</em> with the plan, summary, checks and lot table, <em>LandXML</em> parcels (lots, right-of-way, open space and ponds) for Civil 3D, or <em>To Linework</em> — the lot lines, road edges and centrelines sent to the Linework Editor as figures.</li>
                </ul>`
        },
        {
            id: "overlay-doc",
            title: "2.7  Basemap overlay (Linework Editor)",
            html: `
                <p><em>Purpose:</em> shows a street map or aerial image behind the linework so you can check field data against the ground while editing.</p>
                <ul>
                    <li><strong>Basemap checkbox:</strong> turns the map on or off. It is off by default, and no tile provider is contacted until you turn it on.</li>
                    <li><strong>Basemap type:</strong> OpenStreetMap or Carto Light (streets); USGS imagery (aerial) or USGS topo. Use the opacity slider to keep the linework readable.</li>
                    <li><strong>Zone and units:</strong> the map is placed assuming your coordinates are NAD83 State Plane grid coordinates. Pick the zone (all 50 states and their statewide alternates, Puerto Rico / Virgin Islands, Caribbean WGS 84 UTM zones and Canadian UTM / MTM / provincial grids are listed) and the units (meters, US survey feet or international feet) to match your data — choosing a zone preselects its customary unit. If the coordinates fall outside the zone (or are local, or feet were read as meters), the map is not drawn rather than shown in the wrong place.</li>
                    <li>Imagery is for orientation only — grid coordinates are not scaled to ground and the tiles are not survey-grade.</li>
                </ul>`
        },
        {
            id: "dxf-code-file-doc",
            title: "3.6a  DXF → Code File (LW### figures)",
            html: `
                <p><em>Purpose:</em> turns a DXF's linework into a Civil 3D survey code file (<code>.fbk</code>) in this suite's script style: every vertex planted once with <code>NEZ pt N E Z "desc"</code>, then one <code>FIG BEGIN LW001</code> / <code>FIG PT</code> / <code>FIG CLOSE</code> / <code>FIG END</code> block per figure. Figures are numbered LW001, LW002, … in drawing order.</p>
                <h4>What is read</h4>
                <ul>
                    <li><strong>Converted:</strong> LINE, ARC, CIRCLE, LWPOLYLINE, 2D and 3D POLYLINE (model space). DXF X → Easting, Y → Northing, drawing units unchanged; Z from the entity (polyline elevation, 3D vertex Z).</li>
                    <li><strong>Curves:</strong> written as <code>PC</code> / <code>OC</code> (mid-arc) / <code>PT</code> points; the OC line's comment gives R, Δ, L and the turn. A circle is a closed figure of two semicircles.</li>
                    <li><strong>Join:</strong> optional — loose LINE / ARC pieces (exploded linework) on the same layer whose ends meet within the tolerance become one figure. Polylines and circles are left exactly as drawn, so two polylines that only share an endpoint (parallel offsets, say) stay separate figures.</li>
                    <li><strong>Repairs:</strong> repeated vertices (zero-length segments) are removed and reported in the results and the file header.</li>
                    <li><strong>Points:</strong> every figure vertex is its own point by default — several points may occupy the same spot (two figures meeting at a corner each get a point there). Tick <em>Share one point number where vertices coincide</em> to reuse one number instead.</li>
                    <li><strong>TEXT → points:</strong> TEXT on the layers you tick becomes standalone <code>NEZ</code> points at the text's insertion point, with the text as the description (layers named POINTS / PNTS / PTS are ticked by default).</li>
                    <li><strong>Elevations from a point file:</strong> optionally load the P,N,E,Z,D survey file the drawing came from. Each vertex and TEXT point takes the Z of the survey point on the same spot, within the match tolerance; when several survey points share the spot, the one whose code matches the figure's layer (or the TEXT) wins. Every <code>NEZ</code> line says where its Z came from (<code>// Z from survey pt 10000</code>, <code>// no survey point here — Z from DXF</code>, <code>// Z = mean of PC/PT</code>); unmatched points are listed by layer. Rows without an elevation are ignored.</li>
                    <li><strong>Conversion report (.txt):</strong> source files and every setting used; results (figures, points, elevations, length by layer); <em>items to review</em> (points without a survey match, ambiguous elevations, figures over a scope limit or dropped, repeated vertices removed, entities not converted); a figure table (point range, curves, length, area of closed figures, Z range); a curve table (PC/OC/PT, R, Δ, arc, chord); and, with a point file, survey-point accounting — which points were not used and why (repeat shot, outside the drawing extents, distance from the linework). Facts only, no grades. It is also saved to the Reports Hub. <strong>Figure table (.csv)</strong> has the same figure rows for a spreadsheet.</li>
                    <li><strong>Not converted (and listed):</strong> SPLINE, ELLIPSE, block INSERTs (explode first), text, paper-space and zero-length entities.</li>
                </ul>
                <h4>SCOPE layers — limits</h4>
                <ul>
                    <li>Any layer whose <strong>first five characters are <code>SCOPE</code></strong> (case-insensitive: <code>SCOPE</code>, <code>scope01</code>, <code>Scope12</code> …) is a limit, not linework — it is never written as a figure.</li>
                    <li>A closed shape on the layer (closed polyline, circle, or exploded lines that join closed) is the boundary; with only open linework on it, the layer's bounding box is used. The file says which.</li>
                    <li>Each figure goes to the first scope (natural order: SCOPE2 before SCOPE10) that any part of it is inside or crosses. A figure that runs over a limit is kept whole and its <code>FIG BEGIN</code> line says so — trim it by hand. Linework outside every scope is not written and is counted.</li>
                    <li>Each scope is its own block, opened by a banner comment (<code>// SCOPE SCOPE01 — …</code>) followed by that scope's NEZ points and figures, so blocks can be edited or removed separately. Untick <em>Limit linework to the SCOPE layers</em> to ignore them.</li>
                </ul>`
        },
        {
            id: "efbk-doc",
            title: "3.7  Electronic Field Book (EFB) & Chain Lists",
            html: `
                <p><em>Purpose:</em> models the planimetric surveying architecture specified in the <strong>FDOT EFB User’s Handbook</strong> and <strong>EFBP Processing Handbook</strong>. Bridges FDOT raw field data collector points and chain lists directly into Civil 3D figures.</p>
                <h4>Point Format (9 Columns)</h4>
                <p><code>NAME, N, E, Z, GEOM, ATTR, ZONE, REFNAME, FEATURE</code></p>
                <ul>
                    <li><strong>NAME:</strong> Prefix + trailing numeric suffix (e.g. <code>TAN19</code>, <code>A1</code>).</li>
                    <li><strong>GEOM:</strong> Point geometry flag: <code>P</code> (Point / straight) or <code>C</code> (Curve).</li>
                    <li><strong>ATTR:</strong> Optional attribute (per the EFB handbook): <code>G</code> (Ground — elevation is on the surface), <code>X</code> (Cross-section / HVD — station+offset to a baseline), <code>F</code> (Feature — planimetric only, elevation excluded from the TIN/surface model), <code>U</code> (User — not surface data, has a project-specific meaning e.g. utilities).</li>
                    <li><strong>ZONE:</strong> Optional elevation zone (1–9).</li>
                    <li><strong>REFNAME:</strong> Optional reference station name (leading period <code>.</code> marks a newly established control monument).</li>
                    <li><strong>FEATURE:</strong> Code and optional description separated by a dash (e.g. <code>TREE-48" OAK</code>, or <code>99-TEXT ONLY</code>).</li>
                </ul>
                <h4>Chain-List Mini-Language</h4>
                <ul>
                    <li><code>LOT1, BND, A1-4, A1</code> connects points A1 through A4 in sequence, closing back to A1.</li>
                    <li><code>-TAN</code> reverses the point numbering order.</li>
                    <li>Empty tokens (<code>,,</code>) break chains into separate disconnected runs.</li>
                </ul>
                <h4>P/C Curve Rules</h4>
                <ul>
                    <li><strong>Isolated C point:</strong> Solves the unique circular arc tangent to the two exterior back/ahead lines defined by bounding P points.</li>
                    <li><strong>3 C points:</strong> Standard circular arc (PC, POC, PT).</li>
                    <li><strong>4+ C points:</strong> Smooth continuous spline, densified via Catmull-Rom interpolation for DXF/CAD compatibility.</li>
                </ul>
                <p>Outputs can be exported directly as DXF, Civil 3D survey batch scripts, or sent into the Linework Editor for interactive visual verification.</p>`
        },
        {
            id: "legal-desc",
            title: "3.8  Legal Description QC",
            html: `
                <p><em>Purpose:</em> parse a written metes-and-bounds legal description and check it, without hand-keying each call.</p>
                <div class="help-note"><strong>FDOT legal descriptions — what the procedure itself requires.</strong> <a href="https://pdl.fdot.gov/api/procedures/downloadProcedure/550-030-101" rel="noopener">FDOT Procedure 550-030-101-d, Surveying and Mapping</a> (effective May 14, 2019), §2.2.3: the point of commencement should be outside the required right of way where practical; each description must be compared with the right of way map so everything it references can be found on the map; and each parcel's description must be certified (signed, sealed and dated) by a professional surveyor and mapper. This tool checks closure and the calls — those three are yours to confirm.</div>
                <div class="help-note"><strong>FDOT right of way description</strong> (tick the box under the text): adds the rules of the FDOT <em>Surveying and Mapping Handbook</em> (February 28, 2025). §31.6.2 — the area is stated once, in acres to 3 decimal places when it is half an acre or more, otherwise in square feet to the nearest foot, followed by "more or less"; the stated area is compared with the computed one (beyond the stated figure's rounding). §31.4 — parcel numbers: 1–99 reserved, 100–699 fee, 700–799 temporary easements, 800–899 perpetual easements, 900–999 license agreements (a series past its range adds 1000). Leave the box off for a private boundary description: these rules are FDOT's, not Rule 5J-17's.</div>
                <p><strong>Input:</strong> paste the narrative text. The parser splits on <code>THENCE</code> / <code>COMMENCE</code> / <code>BEGINNING</code> and recognizes:</p>
                <ul>
                    <li><strong>Line calls</strong> — a bearing (compact <code>N 45°12'30" E</code> or spelled-out "North 45 degrees 12 minutes 30 seconds East") followed by a distance ("a distance of 150.00 feet", "150.00 feet", "150.00'").</li>
                    <li><strong>Curve calls</strong> — "radius of R feet", "arc distance of A feet", "chord bearing of …", "chord distance of C feet", "concave to the …", "central angle / delta …". If the chord distance is missing it is back-solved from R and A (chord = 2R·sin(Δ/2)).</li>
                </ul>
                <p><strong>Checks (from the BoundaryQC rule set):</strong> fewer than 3 calls; non-positive line distance; non-positive curve radius/arc/chord; unparseable chord bearing; <strong>curve geometry inconsistency</strong> (computed chord vs stated chord differs by &gt; 0.1 ft — usually a swapped radius/arc or a delta in the wrong units); a <code>LESS AND EXCEPT</code> clause (computed acreage is then the <em>gross</em> area only); closure failure or sub-1:10,000 precision; and self-intersection of the plotted boundary.</p>
                <p><strong>Output:</strong> a parsed-calls table, closure + Shoelace area, an issue list, and two downloads — a <em>P,N,E,Z,D</em> coordinate file and a <em>Map Check Report</em>.</p>`
        },
        {
            id: "fdot-survey",
            title: "3.8a  FDOT survey checks (Survey & Desckeys tab)",
            html: `
                <p><em>Purpose:</em> check survey deliverables against FDOT's own published documents. The panel sits under the description-key table on <em>Survey &amp; Desckeys</em>.</p>
                <ul>
                    <li><strong>Feature codes:</strong> the 502 codes of the FDOT Survey Feature Codes spreadsheet (4/24/2025, also Appendix G of the Surveying and Mapping Handbook, Feb 28, 2025) — code, CADD level, description, point or line, zone. Search them, or download them as CSV. (The description-key table above them is illustrative; these are FDOT's.)</li>
                    <li><strong>Point file:</strong> a P,N,E,Z,D file's codes (the first word of each description) against the list: codes not on it, with their point numbers; a line code with only one shot; points with no code. A code with a figure number on it (<code>AP2</code>) is read as <code>AP</code>.</li>
                    <li><strong>Survey drawing:</strong> the DXF's layers against the FDOT survey levels: layers named like survey levels (ending <code>_ep</code> / <code>_ex</code>) that are not on the list are reported, and a level spelled with different capitals is noted. Other layers are counted, not judged.</li>
                    <li><strong>Survey report:</strong> a <code>.docx</code>, a <code>.txt</code> or pasted text checked for the items of the handbook's Appendix E survey report format — project information (firm, Financial Project Number, project name, State Road number, Roadway Section ID, limits, survey dates, units), type of survey, methodology, horizontal and vertical datum and control, sources, general notes, legend and abbreviations, files list, and the certification (5J-17, licence number). Elevations not on NAVD 88 are flagged (handbook §1.3: another datum needs the DSMO's written authorization). A missing item may be on the map instead — the handbook allows notes on the map or in the report.</li>
                </ul>
                <p>PDF reports can't be read for text here; save the report as <code>.docx</code> or <code>.txt</code>, or paste it.</p>
                <p><strong>FDOT layer names:</strong> the drawing check also applies the FDOT CADD Manual 2025 naming convention (§5.10.1.1): <code>object_sv</code>, at most 18 characters, state p / d / e and view p / r / x / m (no suffix = proposed plan); entities on layer 0 are noted (§5.10.1.3). FDOT's full level list ships in its state-kit templates rather than as a download, so names are checked against the convention, not the list.</p>`
        },
        {
            id: "plss",
            title: "3.9  PLSS Section Breakdown",
            html: `
                <p><em>Purpose:</em> resolve an aliquot ("quarter-quarter") description into a rectangle, dimensions, and acreage.</p>
                <p><strong>Input:</strong> an aliquot description, e.g. <code>S 1/2 of the SE 1/4 of the NE 1/4 of Section 8, Township 7 North, Range 7 East</code>. Put one parcel per line for a multi-parcel description. Spelled-out compass words ("Northeast 1/4") and abbreviations ("NE 1/4") both work.</p>
                <p><strong>How it computes:</strong> starting from an ideal <strong>5,280 ft × 5,280 ft</strong> section, it applies each fraction from the outermost (largest) inward — a quarter takes one corner of the current box, a half splits it on the center line. It reports the resulting rectangle's E-W and N-S dimensions, the computed area (width × height ÷ 43,560), the ideal aliquot acreage from the standard table (640 / 160 / 40 / 10 / 2.5 …), and a mismatch flag against any stated acreage.</p>
                <p>The four sides are true cardinal bearings (N 00°, N 90° E, etc.) and an ideal section closes exactly.</p>
                <div class="help-note help-note--warn">
                    <strong>Qualified descriptions.</strong> Text like "That part of … which lies northerly of …", "within 50 feet of the Quarter Section line", or "EXCEPTING any part …" describes an irregular strip or trimmed parcel, <em>not</em> the full aliquot rectangle. The tool detects this and warns you; the rectangle it shows is only the gross parent container.
                </div>
                <p><strong>Output:</strong> per-parcel cards, a P,N,E,Z,D file, and a breakdown report.</p>`
        },
        {
            id: "plat2dxf",
            title: "3.10  Parcel → DXF / Points / COGO",
            html: `
                <p><em>Purpose:</em> turn a bearing/distance call list into CAD-ready files. <strong>There is no image tracing in this build</strong> — the earlier "computer vision" wording was a mockup.</p>
                <p><strong>Input:</strong> a call list (one <code>N 45-12-30 E 150.00</code> per line) in the box, or leave it empty to use the bundled sample parcel. Click <em>Build Parcel DXF / Points</em>.</p>
                <p><strong>Output (three downloads):</strong></p>
                <ul>
                    <li><code>parcel_boundary.dxf</code> — a valid ASCII DXF: a closed LWPOLYLINE on <code>AI-PROP-BNDY</code> plus bearing/distance and point labels on <code>AI-NODE-TEXT</code>.</li>
                    <li><code>parcel_coordinates.txt</code> — P,N,E,Z,D point file, points from 500.</li>
                    <li><code>parcel_cogo.scr</code> — an AutoCAD script that draws the boundary polyline from the calls.</li>
                </ul>`
        },
        {
            id: "signs-ssa",
            title: "3.11  Sign QTO & SSA Hydrology",
            html: `
                <p><strong>Sign Assemblies &amp; QTO</strong> — the FDOT sign assembly catalog (code, size, block, target pay item). The calculator takes a sign width and height (inches), computes the panel area in square feet, and classifies the pay item: ≤ 12 SF → <code>0700-1-11</code>, 12–20 SF → <code>0700-1-12</code>, &gt; 20 SF → <code>0700-1-14</code>.</p>
                <p><strong>SSA Hydrology &amp; IDF</strong> — pick one of the 11 FDOT IDF zones, enter drainage area (acres), runoff coefficient C, and time of concentration t<sub>c</sub> (minutes). It computes rainfall intensity i = a / (t<sub>c</sub> + b)<sup>c</sup> and peak discharge <strong>Q = C·i·A</strong> (cfs). The trench sizer estimates exfiltration trench length from treatment volume and the hydraulic conductivity k (FDOT Drainage Manual Ch. 7).</p>`
        },
        {
            id: "reference-tabs",
            title: "3.12  Block Libraries / Subassemblies / Sheet Standards / State Kit Inspector",
            html: `
                <p>Static reference cards:</p>
                <ul>
                    <li><strong>Block Libraries</strong> — FDOT block name, source drawing, discipline, target layer, associated pay item.</li>
                    <li><strong>Subassemblies &amp; PKT</strong> — corridor subassembly reference with the input parameters each one exposes.</li>
                    <li><strong>Sheet Standards &amp; DWT</strong> — sheet template name, title, layout size, and viewport plot scale.</li>
                    <li><strong>State Kit Inspector</strong> — the reverse-engineered FDOT Civil 3D State Kit folder tree.</li>
                </ul>`
        },
        {
            id: "landxml-doc",
            title: "3.13  LandXML Studio & Interop",
            html: `
                <p><em>Purpose:</em> ingest, validate, visualize, and generate schema-compliant <strong>LandXML 1.0, 1.1, 1.2, and 2.0</strong> geometry files for parcels, alignments, surfaces, and survey points without requiring Autodesk Civil 3D.</p>
                <h4>Capabilities</h4>
                <ul>
                    <li><strong>Parsing:</strong> Extracts coordinate metadata (EPSG 2236 Florida State Plane, US Survey Feet), <code>&lt;CgPoints&gt;</code>, <code>&lt;Parcels&gt;</code> (with line and circular curve geometry, computed vs stated acreage), <code>&lt;Alignments&gt;</code> (centerline curves and tangents), and <code>&lt;Surfaces&gt;</code> (TIN vertices and faces).</li>
                    <li><strong>2D Interactive Canvas:</strong> Renders boundary parcel polylines (blue), highway alignment centerlines (amber), and survey points (red) in real-time with state plane coordinate bounding boxes.</li>
                    <li><strong>Linework Editor Bridge:</strong> Click <em>Send to Linework Editor</em> to instantly convert LandXML parcels into editable survey figures with preserved point names and circular arc bulges.</li>
                    <li><strong>Export:</strong> Generate strict LandXML 1.2 XML files directly from Linework Editor models, EFB chains, or imported survey traverses.</li>
                </ul>`
        },
        {
            id: "batchprocess-doc",
            title: "3.14  Multi-Sheet Batch Project Auditor",
            html: `
                <p><em>Purpose:</em> audit entire electronic submittal packages of 10 to 100+ DXF and LandXML drawings simultaneously against FDOT CADD standards.</p>
                <h4>Batch Workflow</h4>
                <ul>
                    <li><strong>Multi-File Ingestion:</strong> Drag and drop multiple drawing files simultaneously, or browse an entire submittal folder tree. Click <em>Load Demo Project Batch</em> for an instant 4-sheet sample audit.</li>
                    <li><strong>Compliance Matrix:</strong> Evaluates every sheet in parallel for layer naming/color compliance, zero-length entities, unclosed boundary gaps, bow-tie self-intersections, and off-grid coordinates. Categorizes sheets into <strong>PASS</strong>, <strong>WARN</strong>, or <strong>FAIL</strong>.</li>
                    <li><strong>Project Grade &amp; Verdict:</strong> Aggregates sheet metrics into an overall project compliance score (%) with readiness verdicts (<em>SUBMITTAL READY</em>, <em>REVISION REQUIRED</em>, or <em>SUBMITTAL BLOCKED</em>).</li>
                    <li><strong>Consolidated Deliverables:</strong> Download a master AutoCAD batch script (<code>fdot_batch_fix.scr</code>) that automatically executes <code>AUDIT</code>, layer color normalization, <code>PURGE</code>, and <code>OVERKILL</code> across all project drawings, plus printable HTML and Markdown Master Submittal Reports.</li>
                </ul>`
        },
        {
            id: "reports-doc",
            title: "3.15  Centralized Reports Hub & Submittal QA/QC Repository",
            html: `
                <p><em>Purpose:</em> unified central repository for all engineering and survey QA/QC audit logs, closure computations, mapchecks, and compliance scorecards generated across the entire FDOT suite.</p>
                <h4>Unified Standards & Automation</h4>
                <ul>
                    <li><strong>Automated Ingestion:</strong> Whenever you run a Traverse closure, Legal Description mapcheck, Linework boundary audit, PLSS breakdown, DXF Project Audit, Standards baseline comparison, or Batch submittal, the generated report automatically registers with the Reports Hub.</li>
                    <li><strong>FDOT Standard Headers:</strong> Every report is formatted with official FDOT metadata: Project, State Road / County, FPID, Surveyor / Engineer, Discipline, Standard Reference (FAC 5J-17 / 61G15 / Topic 625-050-001), and ISO timestamp.</li>
                    <li><strong>Persistent Storage:</strong> Reports persist across browser sessions in local storage. Live badges on the navigation bar alert you to the active report count.</li>
                    <li><strong>Filter &amp; Search:</strong> Filter instantaneously by category (<em>COGO</em>, <em>Legal</em>, <em>PLSS</em>, <em>DXF</em>, <em>Standards</em>) or search across report titles, FPIDs, authors, and summary contents.</li>
                    <li><strong>In-App Preview &amp; Deliverables:</strong> View full raw logs or formatted HTML reports inside the preview modal with one-click <strong>Copy to Clipboard</strong>, <strong>Print / PDF</strong>, and <strong>Direct Download</strong>. Export all stored reports into a single consolidated master zip/bundle.</li>
                </ul>`
        },
        {
            id: "logging-doc",
            title: "3.16  System Diagnostics, Error Logging & Real-Time Event Stream",
            html: `
                <p><em>Purpose:</em> centralized runtime event logger and diagnostic auditor across all plugins, parsing engines, file loaders, and background tasks.</p>
                <h4>Features &amp; Capabilities</h4>
                <ul>
                    <li><strong>Global Logging API (<code>window.Logging</code>):</strong> Standalone plugin providing <code>info()</code>, <code>warn()</code>, <code>error()</code>, and <code>debug()</code> event logging with source attribution and structured metadata.</li>
                    <li><strong>Linework File Upload &amp; Error Logging:</strong> Supports drag-and-drop and manual upload of point and call files (<code>.txt</code>, <code>.csv</code>, <code>.pts</code>, <code>.pnt</code>, <code>.dat</code>). Quote-aware CSV parsing correctly handles commas within description fields (e.g. <code>"CURB B, R10"</code>). Header rows are automatically detected and skipped. Malformed rows (insufficient tokens, non-numeric coordinates) are logged to the System Logs stream with line numbers and diagnostic reasons, and displayed in an interactive in-tab diagnostics panel with one-click navigation to System Logs.</li>
                    <li><strong>Automatic Exception Monitoring:</strong> Subscribes to global <code>window.onerror</code> and <code>window.onunhandledrejection</code> events, preventing silent failures and alerting users via a persistent navbar badge.</li>
                    <li><strong>Live Error Badge:</strong> Displays real-time error counts in the sidebar navigation menu.</li>
                    <li><strong>Filtering &amp; Real-Time Search:</strong> Filter logs by severity level (<em>ALL</em>, <em>ERROR</em>, <em>WARN</em>, <em>INFO</em>, <em>DEBUG</em>) or originating subsystem (<em>linework</em>, <em>batchprocess</em>, <em>landxml</em>, <em>dxf</em>, <em>reports</em>, <em>system</em>), with instant search filtering.</li>
                    <li><strong>Reports Hub Integration:</strong> One-click <em>Send to Reports Hub</em> packages the formatted audit log into an official FDOT QA/QC System Diagnostics report stored in the Reports Hub repository.</li>
                    <li><strong>Export Formats:</strong> Download raw logs as formatted text (<code>.log</code>) or structured JSON (<code>.json</code>).</li>
                </ul>`
        },
        {
            id: "jea-asbuilt-doc",
            title: "3.17  JEA As-Built Standards 2026 (tmp_jea24) & Utility As-Built Manual",
            html: `
                <p><em>Purpose:</em> complete engineering workflow, drawing builder, and automated QA/QC compliance auditing system for <strong>JEA As-Built Standards 2026</strong> (governing Potable Water, Wastewater, Reclaimed Water, Chilled Water, and Utility Crossing installations across Duval, Clay, St. Johns, and Nassau counties).</p>

                <h4>1. Regulatory &amp; Geodetic Authority</h4>
                <ul>
                    <li><strong>Standard Specification:</strong> <em>JEA As Built Template 2026.xlsx</em> and the JEA Water and Wastewater Standards (rev. January 1, 2026) and associated Civil 3D CADD deliverables.</li>
                    <li><strong>Projection &amp; Coordinate System:</strong> Florida State Plane Coordinate System 1983 (SPCS83), East Zone (FIPS 0901 / EPSG 2236), US Survey Feet.</li>
                    <li><strong>Geographic Bounding Envelope:</strong> Easting <code>320,000</code> to <code>590,000</code> ft; Northing <code>1,920,000</code> to <code>2,370,000</code> ft (encompassing Greater Jacksonville, Beaches, Orange Park, St. Augustine, and Nassau utility service corridors).</li>
                    <li><strong>Ground-Truthed Natural GPS (WGS84):</strong> Exact physical WGS84 GPS coordinates (29.0° N to 31.0° N, -83.0° W to -80.0° W) computed via rigorous Transverse Mercator forward/inverse reductions (<code>COGO.statePlaneToLatLon(northing, easting, "FL_EAST", "sft")</code>) with zero artificial coordinate fudging or synthetic offsets.</li>
                </ul>

                <h4>2. End-to-End Operational Workflow</h4>
                <div class="help-note" style="border-left-color:var(--accent); background:rgba(2,132,199,0.06); font-family:var(--font-mono); font-size:0.78rem; line-height:1.6;">
                    [Field Survey Shots (P,N,E,Z,D)]<br>
                    &nbsp;&nbsp;&nbsp;&nbsp;&darr;<br>
                    [Linework Editor / Network Model (JSON)] or [JEA As-Built Excel workbook (.xlsx) + self-check] &rarr; [JEA Drawing Builder]<br>
                    &nbsp;&nbsp;&nbsp;&nbsp;&darr;<br>
                    [Civil 3D Compliant DXF] (W-MAIN, SS-GRAV, JEA_VALVE, JEA_MANHOLE, JEA_CROSSING with ATTRIB tags)<br>
                    &nbsp;&nbsp;&nbsp;&nbsp;&darr;<br>
                    [Reverse-Read DXF Auditor Engine] &larr; (Upload .dxf or .xlsx / Paste ASCII DXF)<br>
                    &nbsp;&nbsp;&nbsp;&nbsp;&darr;<br>
                    [5-Point QA/QC Standards Check]:<br>
                    &nbsp;&nbsp;&bull; State Plane East Bounding Envelope Check<br>
                    &nbsp;&nbsp;&bull; Standard Layer Validation (W-MAIN, SS-GRAV, UTIL-CROSS)<br>
                    &nbsp;&nbsp;&bull; 45 Picklist Domains Verification (Subtypes, Materials, Sizes, Manufacturers, Linings)<br>
                    &nbsp;&nbsp;&bull; Mandatory Attribute Fields (Elevations, Rim/Invert, Diameters)<br>
                    &nbsp;&nbsp;&bull; Pipe crossing separation by pipe type (JEA §350 III.4.4–III.4.5)<br>
                    &nbsp;&nbsp;&nbsp;&nbsp;&darr;<br>
                    [Deliverables &amp; Output]:<br>
                    &nbsp;&nbsp;&bull; JEA Pipe Crossing Table (CSV) and workbook findings (CSV)<br>
                    &nbsp;&nbsp;&bull; Local PostgreSQL Database Master Template (tpl_jea_2024)<br>
                    &nbsp;&nbsp;&bull; QA/QC audit report in the Reports Hub — a QC aid, not a certification; the surveyor of record remains responsible
                </div>

                <h4>3. Detailed Operator Manual — Sub-Panels</h4>
                <h5>A. Linework &amp; Drawing Builder (<code>#jea-sub-gen</code>)</h5>
                <ul>
                    <li><strong>Import As-Built Excel workbook:</strong> pick a JEA As-Built <code>.xlsx</code> — JEA's own <em>JEA As Built Template 2026</em> (one table per sheet: Water Valve, WW Fitting, Manhole, Reclaimed Hydrant, Pipe Crossing Table…), or a firm's workbook with titled tables (sheets such as PG-1…, WATER, SEWER with MANHOLE / WATER VALVE / HYDRANT / METER BOX / LOCATE WIRE BOX / FITTING tables). Pipe Crossing Table rows become crossings, checked against §350; pipe-run and points-along-pipe rows are counted, not imported; the template's reference sheets are skipped. Every row with a northing and easting becomes a <code>JEA_*</code> block in the model below; the import notes list what came in and the workbook self-check (section E). Size, material and other values are matched to the JEA picklists by spelling only — a value that isn't in a picklist is kept as written so the audit can flag it. Nothing missing is filled in: no invert is invented, and the county is left blank.</li>
                    <li><strong>Network Model:</strong> Enter or edit the utility linework JSON structure containing <code>pipes</code> (layer, subtype, diameter, material, class, lining, 3D vertices), <code>structures</code> (block name, coordinates, elevation, attributes map), and <code>crossings</code>.</li>
                    <li><strong>Build &amp; Download Civil 3D DXF:</strong> Click <em>Build &amp; Download Civil 3D DXF</em> to generate a valid AutoCAD 2004+ ASCII DXF (<code>JEA_AsBuilt_2026.dxf</code>) with native <code>BLOCK</code> symbol definitions, <code>ATTDEF</code> tags, <code>LWPOLYLINE</code> runs, and <code>INSERT</code> records.</li>
                    <li><strong>Export JEA CSV Tables:</strong> Downloads the Pipe Crossing Table (<code>JEA_Pipe_Crossing_Table.csv</code>) in the 2024 template's column layout.</li>
                    <li><strong>Send to Linework Editor:</strong> Bridges utility pipe runs straight into the interactive Linework Editor for vertex adjustment and closure diagnostics.</li>
                </ul>

                <h5>B. Reverse-Read DXF Auditor (<code>#jea-sub-audit</code>)</h5>
                <ul>
                    <li><strong>File Upload &amp; Text Ingestion:</strong> pick an ASCII <code>.dxf</code>, or paste DXF text into the auditor text area. A JEA As-Built <code>.xlsx</code> is imported, built into a JEA drawing and audited, with the workbook self-check shown above the results. A <code>.dwg</code> can't be read in a browser: in Civil 3D run <code>DXFOUT</code>, save as <em>AutoCAD 2018 DXF</em>, and load that.</li>
                    <li><strong>Check Package:</strong> reads the text of the loaded drawing (model space, every layout, and label/leader blocks) and reports three things — see section F. Load the drawing as a <code>.dxf</code> (or paste it); load the workbook too to compare the two.</li>
                    <li><strong>Extract Pipe Network:</strong> pulls the pipe linework (lines, polylines — including old-style <code>POLYLINE</code>s — arcs and splines on JEA layers or on recognised as-built layers) out of the DXF in the text area and makes it the Drawing Builder's model, so it can be rebuilt on JEA layers or sent to the Linework Editor. Curves stay curves (polyline arcs are kept exactly; standalone arcs are drawn at 5° steps; a spline with no fit points is marked approximate). Elevations come from the polyline's elevation, a 3D polyline's vertices or a line's end points; an elevation of exactly 0 is treated as "not set". Size, material and class aren't carried by the linework and are left blank.</li>
                    <li><strong>Run JEA Standards Audit:</strong> Executes the reverse-read parser, extracts all block inserts with child <code>ATTRIB</code> entities, and runs the 5-point verification engine.</li>
                    <li><strong>Interactive Samples:</strong>
                        <ul>
                            <li><em>Load Compliant Sample:</em> Loads a fully compliant JEA water, gravity sewer, and crossing model (100% score).</li>
                            <li><em>Load Violation Sample (water main 7" under a sewer):</em> Loads a sample with a water main 7.0" below a gravity sewer (JEA §350 III.4.4 requires 12" when the water main is below) and an invalid valve subtype to demonstrate automated violation detection.</li>
                        </ul>
                    </li>
                    <li><strong>Audit Results &amp; Issue Log:</strong> a score (0–100%) and a <em>COMPLIANT</em> / <em>NON-COMPLIANT</em> badge, the entity, error and warning counts, and an issues table with the entity (and its DXF handle, to find it in Civil 3D), layer and coordinates. A line under the score says what was checked and what wasn't.</li>
                    <li><strong>"Not scored":</strong> a drawing with no <code>JEA_*</code> blocks and no pipes on the template layers (<code>W-MAIN</code>, <code>SS-GRAV</code>…) has nothing the standard applies to, so it shows <em>NOT SCORED</em> and the reason instead of a number. Most consultant drawings are like this; import the workbook, or extract the pipe network, to get something to score.</li>
                    <li><strong>What is audited:</strong> model space only — title blocks, viewports and other paper-space entities, and AutoCAD's anonymous <code>*U</code> blocks (dimensions, leaders), are skipped — and listed: a <em>Not checked: paper space</em> finding gives the count by layer and entity type, <em>Not checked: anonymous blocks</em> gives their count, and a <code>JEA_*</code> block found in paper space is a warning (it belongs in model space). Findings are rolled up: one per polyline for out-of-bounds vertices, one per layer for non-standard layer names.</li>
                    <li><strong>Inferred layer mapping:</strong> real as-built drawings use their own layer names (<code>_AB POWM PIPE LN</code>, <code>_AB PSAN PIPE LN</code>, <code>AB-GRAVITY-LINE</code>, <code>AB-FIRE LINE</code>, <code>AB-WTR-VALVES</code>…). These map to the JEA layers through the <code>LAYER_ALIASES</code> table in <code>jea-data.js</code>. The table is <strong>inferred from the layer names, not taken from a JEA publication</strong>: each use is listed as an <em>info</em> finding, and a mapped layer alone never earns a score. Confirm it with JEA, and edit the table to add or correct a name.</li>
                    <li><strong>Save to Reports Hub:</strong> Packages the audit results into a formal Markdown/HTML inspection certificate stored in the Centralized Reports Hub.</li>
                </ul>

                <h5>C. 45 JEA Validation Domains Browser (<code>#jea-sub-domains</code>)</h5>
                <ul>
                    <li>Browse and search all 45 official JEA validation lists from the JEA As Built Template 2026 (including <em>Subtype Water Valve</em>, <em>Subtype Manhole</em>, <em>Crossing Pipe Type</em>, <em>Pipe and Fitting Material</em>, <em>Size Inches</em>, <em>Valve Manufacturer</em>, and <em>Manhole Lining Material</em>).</li>
                    <li>Use the real-time search box to find valid picklist values or verify allowed casing, spelling, and nomenclature.</li>
                </ul>

                <h5>D. PostgreSQL Template Sync (<code>#jea-sub-dbsync</code>)</h5>
                <ul>
                    <li>Synchronizes the master JEA template (<code>tpl_jea_2024</code>) with your local PostgreSQL relational database (<code>fdot_survey_db / client_templates</code>).</li>
                    <li>Click <em>Sync Template to PostgreSQL</em> to push or refresh client settings, projection bounds, and crossing clearance rules.</li>
                </ul>

                <h5>E. Workbook self-check</h5>
                <p>Every workbook import checks the workbook's own values. Each finding names the ID, the sheet and cell (e.g. <code>SEWER!A21</code>) and what's wrong; <em>Download findings CSV</em> saves them all.</p>
                <table class="help-table">
                    <thead><tr><th>Check</th><th>Finds</th><th>Severity</th></tr></thead>
                    <tbody>
                        <tr><td>Lat/lon vs SPC</td><td>The recorded latitude/longitude is more than JEA's 0.5 ft horizontal accuracy (§501 II.1.7) from the position its northing/easting gives (FL East, US ft), plus the rounding of the recorded figure. The sheet rounds lat/lon to 0.01&Prime; (about 1 ft).</td><td>Error</td></tr>
                        <tr><td>Far from the job</td><td>A point more than a mile from the middle of the others (and 10&times; their typical spread) — an easting or northing typo that is still inside the FL East bounds.</td><td>Error</td></tr>
                        <tr><td>Outside FL East bounds / Missing coordinates</td><td>A coordinate outside the zone, or a row with no usable northing/easting (skipped).</td><td>Error</td></tr>
                        <tr><td>Top + depth &ne; grade</td><td>On rows with top (or valve nut), grade and depth: top + depth differs from grade by more than JEA's 0.1 ft vertical accuracy (§501 II.1.7). <code>-999</code> (JEA's "not applicable") is skipped.</td><td>Warning</td></tr>
                        <tr><td>Top above grade</td><td>Top is higher than grade — the two may be swapped.</td><td>Warning</td></tr>
                        <tr><td>Two IDs, one point</td><td>Different IDs at the same coordinate.</td><td>Warning</td></tr>
                        <tr><td>Same ID, different kind / Conflicting duplicate</td><td>An ID repeated across sheets as a different kind (e.g. a wire box on one sheet, a tap on another), or with different coordinates or values. The first row is kept and the conflict is listed.</td><td>Warning</td></tr>
                        <tr><td>Text in a number cell</td><td>A number cell that also holds words (<code>20.3 BASE PLATE</code>) is read as its number.</td><td>Note</td></tr>
                    </tbody>
                </table>
                <p>The lat/lon and depth tolerances are JEA's positional accuracy (Standards 2026 §501 II.1.7); "one point" and "far from the job" are this tool's (<code>JeaXlsx.QC_DEFAULTS</code>). The check says the values disagree; which one is right is the surveyor's call.</p>

                <h5>F. Package check (<em>Check Package</em>)</h5>
                <ul>
                    <li><strong>Sheets &amp; certifications</strong> — from JEA Water and Wastewater Standards 2026 §501 II.1 and the V.3 As-Built Submittal Check List. <em>On every layout (sheet):</em> the "AS-BUILT" / "RECORD DRAWING" label, the surveyor's certification (5J-17.051/.052), a PSM number, the contractor's certification and State Utilities License number, a JEA Availability or Capital Project Number, and a graphic scale. <em>On the cover (at least once):</em> the datum (Florida East Zone, NAD 83, NAVD 88), the vicinity map marked "Project Location", the date of utility installation completion, the legend, surveyor notes, general notes and the date of field survey. It also reports values that differ between layouts (PSM, Availability or Project number), a surveyor's name spelled differently, <code>SHEET x OF y</code> totals that disagree, and layouts that certify to different parties (a sign the drawing holds layouts from other jobs). The north arrow, title block, match lines, 1-inch AS-BUILT lettering and 24" × 36" sheets are drawn, not text — they are listed to check by eye. A record drawing (minor maintenance) carries the JEA project manager's certification instead (§501 I.5.2).</li>
                    <li><strong>State Plane position:</strong> coordinate labels (<code>N=… E=…</code>) and workbook IDs labelled in the drawing are compared with where they sit. A drawing can be inside the FL East bounds and still be shifted off State Plane; the shift is reported in feet. Labels that fall into several groups mean the plan is drawn more than once (e.g. once per sheet); labels that agree with no group are usually insets or details drawn out of place. Table cells are left out — a table sits away from the work.</li>
                    <li><strong>Workbook vs drawing</strong> (with a workbook loaded): every ID is <em>in both</em>, <em>workbook only</em>, <em>drawing only</em>, or <em>written differently</em> (the drawing's <code>WWS10</code> for the workbook's <code>WW10</code>). Drawing table rows are compared with the workbook: a northing or easting more than 0.05 ft apart is an error, and a row whose type words (valve, tee, bend, wire box, hydrant…) don't match the workbook's is a note. A table drawn twice is reported once.</li>
                    <li><strong>Pipe-length labels:</strong> labels such as <code>43.1 LF</code> or <code>±79 LF</code> are compared with the drawn pipe run they sit on (within 5 ft). A label longer than the whole run is flagged; a label shorter than the run usually names one piece between fittings, which the linework can't measure, so it is only counted.</li>
                    <li><strong>Package files:</strong> add the PDF set and the eTransmit transmittal (<code>.txt</code>) under <em>Package files</em>. The PDF's page count is compared with the drawing's <code>SHEET x OF y</code>; files eTransmit could not locate (fonts, xrefs) and files it left out are listed; an xref the drawing uses that the transmittal doesn't carry is flagged.</li>
                    <li><strong>Horizontal separation</strong> (JEA Standards 2026 §350 III.4.2–III.4.3): water mains against sanitary gravity sewers and force mains (at least 6 ft, 10 ft preferred) and reclaimed mains (3 ft if regulated under Part III of 62.610, F.A.C., otherwise 6 ft), measured between the drawn centerlines — a centerline closer than the minimum is a definite violation. Stretches within 10 ft of a crossing are skipped; storm drains, structures (§350 III.4.10) and the 3 ft gravity exception aren't checked.</li>
                    <li><strong>Recorded points every 100 ft</strong> (§501 III.1.3, with a workbook loaded): along each drawn pressure main, the workbook's fittings, valves, hydrants, meters, crossings and points along pipe within 5 ft of it are put in order, and gaps over 100 ft — and run ends with no recorded point — are reported. It runs only when the workbook's points sit on the drawn pipes (the same coordinates).</li>
                    <li>Multileader labels count too, placed where their arrow points.</li>
                    <li><em>Download findings CSV</em> saves every section.</li>
                </ul>

                <h5>F2. More workbook checks</h5>
                <ul>
                    <li><strong>Gravity sewer runs</strong> (WW Gravity Pipe Run, §501 IV.1.4): slope = (upstream invert − downstream invert) ÷ run length, against the stated slope; runs that go uphill; inverts above their grade.</li>
                    <li><strong>Manhole inverts</strong> (§501 III.2.6): "Invert Elevations (Feet) with Directions" is read — every invert needs its direction (N, E, S, W, NE…), the lowest must equal "Lowest Invert Elevation", and none may be above the rim.</li>
                    <li><strong>Points along pipe</strong> are read for the 100 ft spacing check and checked for lat/lon and top + cover = grade.</li>
                    <li><strong>Pump station attribute worksheet:</strong> pick JEA's <em>Standard Attribute Worksheet – New JEA Pump Station</em> in either file picker and it is checked for completeness instead of imported: blank header fields (project, addresses, meters, service), latitude/longitude outside 29–31° N / 80–83° W, and every blank nameplate field per asset. Assets under "Additional assets that may be utilized" are optional — left wholly blank they're a note.</li>
                    <li><strong>Rules applied:</strong> every audit, workbook check and package check starts with the rules it used — the JEA standards revision, the crossing minimums, the picklist source and the tolerances — so a report can't be mistaken for one made under other rules.</li>
                </ul>

                <h5>F3. Outputs — fix it, don't just find it</h5>
                <ul>
                    <li><strong>Copy with lat/lon filled</strong> (after importing a workbook): a copy of your workbook with Latitude / Longitude filled or corrected from each row's State Plane position (FL East, US ft) — decimal degrees for JEA's 2026 template, DMS text where the workbook used it — beyond JEA's 0.5 ft. Everything else in the file is kept as it was. A row whose northing/easting is the likely typo (far from the job while its lat/lon is on it) is left alone and listed. A CSV lists every change.</li>
                    <li><strong>Download JEA 2026 asset tables (.xlsx)</strong> (Drawing Builder): the model's structures, crossings and points along pipe written into JEA's 2026 template layout — one sheet per table, JEA's columns in order, lat/lon computed. Cells the model has no value for are left blank to fill.</li>
                    <li><strong>Readiness report</strong> (package check): one printable page — a verdict, every finding from the workbook check, drawing audit and package check by section, and the rules used. Also saved to the Reports Hub.</li>
                    <li><strong>Transmittal &amp; checklist draft</strong>: JEA's §501 V.2 transmittal and V.3 checklist pre-filled from the checks (JEA numbers, PSM, utilities) with each requirement marked found / missing / check by eye — verify and initial it yourself.</li>
                    <li><strong>Move-to-State-Plane script</strong> (when the drawing is shifted): an AutoCAD script that moves model space by the shift. Run it on a copy, then check the drawing again.</li>
                    <li><strong>Zoom</strong> beside a finding with coordinates gives the Civil 3D command (<code>_.ZOOM _C e,n 50</code>) to paste at the command line.</li>
                    <li><strong>Batch</strong>: pick several drawings and workbooks at once; they're paired by file name and each pair gets the full check — one summary table and CSV.</li>
                    <li>Drawings over about 2 MB are read in the background so the page stays responsive.</li>
                    <li><strong>Copy with all fixes</strong>: lat/lon as above, plus depth = grade − top where blank, gravity slopes from inverts and length (§501 IV.1.4), and — if you tick it in the package check — workbook IDs renamed to the drawing's spelling. Every change goes in a CSV.</li>
                    <li><strong>Overlay DXF</strong>: the workbook's points as JEA blocks in the drawing's own coordinates (the shift applied) on layer <code>JEA-OVERLAY</code> — XREF it over the drawing in Civil 3D.</li>
                    <li><strong>Submittal package (.zip)</strong>: the PDF set, the workbook, the readiness report, the findings CSV and the checklist draft in one file for JEA's W&amp;S As-Built Submittal Mailbox. (The DWG isn't included — the browser only has the DXF.)</li>
                    <li><strong>Map</strong>: the drawing's pipes, the workbook's points and every finding with a position, on one plan.</li>
                    <li><strong>Review</strong>: each finding has a status (OK / Fix / N/A), kept in this browser per drawing and shown in the readiness report with a tally — for a QC lead or a reviewer working through a package.</li>
                </ul>
                <h5>F4. More package checks</h5>
                <ul>
                    <li><strong>Every feature surveyed</strong> (§501 II.1.17): load the survey point file (P,N,E,Z,D — P,E,N is recognised) and each workbook point must sit on a field shot within 0.5 ft; one that doesn't was likely taken from the design. Elevations more than 0.1 ft from the shot are noted (the shot may be on the nut, rim or pipe).</li>
                    <li><strong>Published control</strong> (§501 II.1.4, II.1.6): the drawing must cite published marks or benchmarks. Paste the NGS datasheets to check each mark is named and its elevation (0.1 ft) and position (0.5 ft) agree.</li>
                    <li><strong>PDF sheets</strong>: page sizes against 24" × 36" (§501 II.1.1) and digital signatures (§501 I.5.1, 5J-17.062) — reported as present with the signer's name, not validated (open the PDF to check the certificate).</li>
                    <li><strong>Resubmittal</strong> (§501 I.6.3): load the previous submittal's workbook and paste JEA's comments; the check lists IDs added, removed and changed, findings resolved, still open and new, and whether each comment's IDs changed.</li>
                </ul>

                <h5>G. Settings (<code>#jea-sub-settings</code>)</h5>
                <p>Decisions that belong to you or to JEA, not to this tool. They are saved in this browser only.</p>
                <ul>
                    <li><strong>As-built layer mapping:</strong> the built-in inferred mappings (<code>_AB POWM PIPE LN</code> → <code>W-MAIN</code> …) and your own (an exact layer name → a JEA layer). Tick <em>Confirmed</em> once JEA (or your own standard) confirms one: its linework then counts toward the score like a JEA layer. Unconfirmed mappings are reported and never earn a score.</li>
                    <li><strong>Workbook check tolerances:</strong> the four tolerances of the workbook self-check (section E). Every box must hold a positive number; <em>Back to this tool's defaults</em> restores 2 / 0.05 / 0.05 / 5280 ft.</li>
                    <li><strong>Pipe crossing minimums:</strong> JEA 2026's 6 in above / 12 in below a gravity or storm sewer (12 in preferred above) and 12 in from a force main or reclaimed main. Change them only for a newer JEA edition or a client's stricter rule; every report then says which figures it used.</li>
                    <li><strong>Repeated rows:</strong> when an ID appears on more than one sheet, keep the first or the last row. Every disagreement between the rows is listed either way.</li>
                    <li><strong>Picklists:</strong> load the lists from a JEA template workbook (e.g. the 2026 template). Any column headed by one of the 45 list names (or <code>Validation List: &lt;name&gt;</code>) replaces that list for the audit, the import and the Domains browser; lists the workbook doesn't have keep the built-in values (the 2026 template's). The panel says which lists were found, which differ and which are missing; <em>Back to the built-in 2026 lists</em> undoes it.</li>
                </ul>

                <h4>4. Technical Standards &amp; Clearance Formulas</h4>
                <h5>Pipe Crossing Vertical Separation (JEA Standards 2026 §350 III.4)</h5>
                <div class="help-note">
                    <code>Separation (inches) = (Upper_Pipe_Bottom_Elevation − Lower_Pipe_Top_Elevation) &times; 12</code>
                </div>
                <table class="help-table">
                    <thead><tr><th>Crossing</th><th>Water main above</th><th>Water main below</th><th>Source</th></tr></thead>
                    <tbody>
                        <tr><td>Water main × gravity or vacuum sewer, or storm sewer</td><td>&ge; 6 in (12 in preferred)</td><td>&ge; 12 in</td><td>§350 III.4.4</td></tr>
                        <tr><td>Water main × force main, pressure sewer or reclaimed main</td><td>&ge; 12 in</td><td>&ge; 12 in</td><td>§350 III.4.5</td></tr>
                        <tr><td>No water main in the crossing</td><td colspan="2">no vertical separation rule — reported as <em>not checked</em></td><td>—</td></tr>
                    </tbody>
                </table>
                <p>Separations are outside of pipe to outside of pipe (JEA Water and Wastewater Standards, Vol. 1, rev. January 1, 2026; the same figures as Rule 62-555.314, F.A.C.). Earlier versions of this tool applied one 18-inch minimum to every crossing; that figure is not in JEA's standards. JEA's standards also set horizontal separations (§350 III.4.2–III.4.3, III.4.10), which this tool does not check.</p>
                <h5>Layers</h5>
                <p>JEA's 2026 standards (Section 501 and the As-Built Checklist) do not specify CAD layer names. The layers below are this tool's template; a drawing on other layers gets a note, not a finding against JEA.</p>

                <h5>Standard Layer Specifications</h5>
                <table class="help-table">
                    <thead><tr><th>Layer</th><th>Color</th><th>Discipline / Description</th></tr></thead>
                    <tbody>
                        <tr><td><code>W-MAIN</code></td><td>Color 4 (Cyan)</td><td>Water Distribution &amp; Transmission Mains</td></tr>
                        <tr><td><code>W-VALV</code></td><td>Color 5 (Blue)</td><td>Water Gate, Butterfly, and Air Release Valves</td></tr>
                        <tr><td><code>W-HYDR</code></td><td>Color 2 (Yellow)</td><td>Fire Hydrant Assemblies</td></tr>
                        <tr><td><code>W-FITT</code></td><td>Color 6 (Magenta)</td><td>Water Bends, Tees, Crosses, and Reducers</td></tr>
                        <tr><td><code>W-METR</code></td><td>Color 3 (Green)</td><td>Water Meters &amp; Backflow Preventers</td></tr>
                        <tr><td><code>W-LOC8</code></td><td>Color 1 (Red)</td><td>Water Locate Wire Boxes &amp; Marker Balls</td></tr>
                        <tr><td><code>SS-GRAV</code></td><td>Color 3 (Green)</td><td>Sanitary Gravity Sewer Mains</td></tr>
                        <tr><td><code>SS-FM</code></td><td>Color 30 (Orange)</td><td>Sanitary Sewer Force Mains</td></tr>
                        <tr><td><code>SS-MANH</code></td><td>Color 1 (Red)</td><td>Sanitary Sewer Manholes</td></tr>
                        <tr><td><code>SS-VALV</code></td><td>Color 5 (Blue)</td><td>Sewer Plug Valves &amp; Air Release Valves</td></tr>
                        <tr><td><code>SS-FITT</code></td><td>Color 6 (Magenta)</td><td>Sewer Fittings &amp; Cleanouts</td></tr>
                        <tr><td><code>SS-LOC8</code></td><td>Color 1 (Red)</td><td>Sewer Locate Wire Boxes</td></tr>
                        <tr><td><code>RW-MAIN</code></td><td>Color 210 (Purple)</td><td>Reclaimed Water Distribution Mains</td></tr>
                        <tr><td><code>UTIL-CROSS</code></td><td>Color 7 (White)</td><td>Pipe Crossing Symbols &amp; Clearance Annotations</td></tr>
                    </tbody>
                </table>

                <h5>Civil 3D Standard Block Schema</h5>
                <table class="help-table">
                    <thead><tr><th>Block Name</th><th>Mandatory Attributes (ATTDEF)</th><th>Standard Picklist Domain</th></tr></thead>
                    <tbody>
                        <tr><td><code>JEA_VALVE</code></td><td><code>SUBTYPE</code>, <code>VALVE_TYPE</code>, <code>SIZE</code>, <code>MATERIAL</code>, <code>MANUFACTURER</code>, <code>OPEN_DIR</code>, <code>STATUS</code>, <code>ELEVATION</code></td><td>Subtype Water Valve, Valve Type, Size Inches, Valve Manufacturer</td></tr>
                        <tr><td><code>JEA_MANHOLE</code></td><td><code>SUBTYPE</code>, <code>MANHOLE_TYPE</code>, <code>RIM_ELEV</code>, <code>INVERT_IN</code>, <code>INVERT_OUT</code>, <code>DEPTH</code>, <code>DIAMETER</code>, <code>MATERIAL</code>, <code>MANUFACTURER</code>, <code>LINING</code></td><td>Subtype Manhole, Manhole Type, Size Feet, Manhole Manufacturer, Manhole Lining Material</td></tr>
                        <tr><td><code>JEA_HYDRANT</code></td><td><code>SUBTYPE</code>, <code>MODEL</code>, <code>MANUFACTURER</code>, <code>VALVE_SIZE</code>, <code>BURY_DEPTH</code>, <code>ELEVATION</code></td><td>Hydrant Model, Valve Manufacturer, Size Inches</td></tr>
                        <tr><td><code>JEA_FITTING</code></td><td><code>SUBTYPE</code>, <code>SIZE</code>, <code>MATERIAL</code>, <code>MANUFACTURER</code>, <code>ELEVATION</code></td><td>Subtype Water Fitting, Size Inches, Fitting Manufacturers</td></tr>
                        <tr><td><code>JEA_METER</code></td><td><code>SUBTYPE</code>, <code>SIZE</code>, <code>BOX_MFR</code>, <code>BOX_MAT</code>, <code>ELEVATION</code>, <code>ACCOUNT_NO</code></td><td>Subtype Water Meter, Meter Size Inches, Meter Box Manufacturer, Meter Box Material</td></tr>
                        <tr><td><code>JEA_LOCATE_BOX</code></td><td><code>SUBTYPE</code>, <code>ELEVATION</code>, <code>COLOR</code></td><td>Subtype Locate Box</td></tr>
                        <tr><td><code>JEA_CROSSING</code></td><td><code>CROSS_NO</code>, <code>UPPER_TYPE</code>, <code>UPPER_SIZE</code>, <code>UPPER_BOT_ELEV</code>, <code>LOWER_TYPE</code>, <code>LOWER_SIZE</code>, <code>LOWER_TOP_ELEV</code>, <code>CLEARANCE_INCHES</code>, <code>COMPLIANT</code></td><td>Crossing Pipe Type, Size Inches</td></tr>
                    </tbody>
                </table>`
        },
        {
            id: "accounts",
            title: "4. Accounts, sign-in & client templates (CMS tab)",
            html: `
                <h4>Sign in</h4>
                <p>Open the CMS Control Panel tab (or <em>Switch Account</em>). Sign in with an email + password. Passwords are salted and hashed with <strong>PBKDF2-SHA-256</strong> (SubtleCrypto) — the plaintext is never stored. After 5 wrong attempts the account is locked for 60 seconds. A session lasts 8 hours, or 30 days with <em>Keep me signed in</em>. Sign out from the header.</p>
                <p>The three bundled demo accounts all use the password <code>Fdot2026!</code>:</p>
                <ul>
                    <li><code>jane.doe@kimley-horn.com</code> — PSM Surveyor</li>
                    <li><code>robert.vance@kimley-horn.com</code> — PE Engineer</li>
                    <li><code>sarah.c@kimley-horn.com</code> — Firm Admin</li>
                </ul>
                <p><em>Create Account</em> registers a new user (min 8-char password with a letter and a digit). <em>Change password</em> is on the CMS profile card. The team directory's <em>Switch</em> button changes the active account within the workspace without re-entering a password — it is a convenience, and every switch is written to the audit log.</p>
                <h4>Client master templates</h4>
                <p>Each user keeps their own set of <strong>master templates</strong> — one per client. A template stores the defaults you use for that client: discipline, IDF zone, sheet template (DWT), closure pass ratio, FPID prefix, county, and district.</p>
                <ul>
                    <li><strong>Create</strong> — <em>New Template</em> opens the form. Fill in at least a client name and Save.</li>
                    <li><strong>Activate</strong> — the <em>Active</em> dropdown at the top of the panel selects which template is current. The active client shows as a badge on your profile and drives defaults elsewhere: the SSA Hydrology tab pre-selects the template's IDF zone, and the Traverse Auditor / Legal Description QC use its closure pass ratio instead of the default 1:10,000.</li>
                    <li><strong>Edit / Delete</strong> — buttons on each row. Deleting the active template moves "active" to the next one.</li>
                </ul>
                <h4>License limit &amp; Stripe billing</h4>
                <p>The <strong>Free</strong> and <strong>Pro</strong> plans allow <strong>5 templates per user</strong>. Creating a sixth is blocked with an upgrade prompt. <strong>Firm</strong> ($199/mo) raises the cap to 25; <strong>Enterprise</strong> ($499/mo) is unlimited.</p>
                <h4>Stripe Billing &amp; Subscription Portal</h4>
                <p>Manage subscriptions from the <strong>Commercial SaaS Plans</strong> tab:</p>
                <ul>
                    <li><strong>Live Stripe vs. Simulation:</strong> Configure your publishable key (<code>pk_test_...</code> / <code>pk_live_...</code>) or custom Stripe Payment Links per tier in the Stripe Gateway Configuration panel. In simulation mode, checkouts run instantly in-browser with ASC 606 revenue-recognition ledgering and signed tier tokens.</li>
                    <li><strong>Modal Checkout:</strong> Click any plan CTA (<em>Upgrade to Pro</em>, <em>Upgrade to Firm</em>, <em>Contact / Upgrade Enterprise</em>) to open the Stripe checkout modal. Choose between direct card entry (Elements emulation) or external Stripe Payment Links.</li>
                    <li><strong>Self-Serve Management &amp; Cancellation:</strong> The Active Subscription Portal displays current tier badges, next renewal date, billing email, and seat counts. Click <em>Cancel Subscription</em> at any time to downgrade immediately back to the Free plan with recorded <code>customer.subscription.deleted</code> webhook auditing.</li>
                </ul>
                <div class="help-note help-note--warn">
                    <strong>All of this runs in your browser.</strong> The password hashing, sessions, lockout, per-user isolation, and the template limit are real code, but there is no server — a determined user can edit <code>localStorage</code> from devtools and bypass any of it. Treat it as a UX model, not a security boundary.
                </div>`
        },
        {
            id: "fmt",
            title: "5. Input format reference",
            html: `
                <h4 id="fmt-bearings" data-sec="fmt-bearings">Bearings</h4>
                <p>Quadrant bearings only. All of these parse to the same course:</p>
                <ul>
                    <li><code>N 45-12-30 E 150.00</code></li>
                    <li><code>N45°12'30"E 150'</code></li>
                    <li><code>North 45 degrees 12 minutes 30 seconds East, a distance of 150.00 feet</code></li>
                </ul>
                <p>Quadrant is <code>N|S</code> then <code>E|W</code>. Minutes and seconds are optional (<code>N 45 E 150</code> works). Seconds may be decimal. The degree mark can be any non-digit character (handles Word / OCR artifacts).</p>
                <h4>Call lists (Traverse Auditor, Parcel → DXF)</h4>
                <p>One course per line: <code>&lt;bearing&gt; &lt;distance&gt;</code>. The distance is the last number on the line; "feet"/"ft"/"'" are optional.</p>
                <h4>PLSS aliquot descriptions</h4>
                <p>Fractions separated by "of", largest last, then the section header:</p>
                <p><code>N 1/2 of the SW 1/4 of Section 14, Township 2 South, Range 27 East</code></p>
                <p>Quarters: <code>NE NW SE SW</code> (+ "1/4" or "quarter"). Halves: <code>N S E W</code> (+ "1/2" or "half"). Header: "Section N, Township N N/S, Range N E/W" or "T N N., R N E.".</p>
                <h4>DXF</h4>
                <p>ASCII (plain) DXF, R12 or later. Binary DXF is rejected. The auditor reads the LAYER table and LINE / LWPOLYLINE / ARC / CIRCLE / TEXT / MTEXT / INSERT / POINT entities.</p>
                <h4>JEA Utility Network JSON</h4>
                <p>JSON structure used by the JEA As-Built Drawing Builder (<code>#tab-jea24</code>). Requires a <code>pipes</code> array with 3D coordinate vertices, a <code>structures</code> array with block names (<code>JEA_VALVE</code>, <code>JEA_MANHOLE</code>, etc.) and attribute dictionaries, and a <code>crossings</code> array with upper and lower pipe elevations.</p>`
        },
        {
            id: "exports",
            title: "6. Exports",
            html: `
                <table class="help-table">
                    <thead><tr><th>File</th><th>From</th><th>Contents</th></tr></thead>
                    <tbody>
                        <tr><td><code>*_fix.scr</code></td><td>DXF Auditor</td><td>AutoCAD script: AUDIT, layer-color resets, PURGE, OVERKILL, QSAVE</td></tr>
                        <tr><td><code>FDOT_EDG_Signed_Manifest.json</code></td><td>DXF Auditor</td><td>SHA-256 file digest manifest (demo signing)</td></tr>
                        <tr><td><code>*_mapcheck.log</code></td><td>Traverse, Legal Description</td><td>Courses, closure &amp; area, self-intersection, P,N,E,Z,D block</td></tr>
                        <tr><td><code>*_coordinates.txt</code></td><td>Traverse, Legal Description, PLSS, Parcel→DXF</td><td>P,N,E,Z,D point file — Point,Northing,Easting,Elev,Desc; points from 500; "COGO POB", "COGO P1", …</td></tr>
                        <tr><td><code>*_survey.fbk / linework_script.fbk / efbk_script.fbk</code></td><td>Linework, Legal Description, Traverse, EFB</td><td>Civil 3D Survey Command Language batch script &amp; Field Book (<code>FIG BEGIN/PT/CLOSE/END</code>, <code>NEZ</code>, <code>BD</code>, <code>STN</code>)</td></tr>
                        <tr><td><code>parcel_boundary.dxf / efbk.dxf</code></td><td>Parcel → DXF, EFB</td><td>Closed LWPOLYLINE + labels on AI-PROP-BNDY / AI-NODE-TEXT or EFB figure layers</td></tr>
                        <tr><td><code>parcel_cogo.scr</code></td><td>Parcel → DXF</td><td>AutoCAD PLINE script from the calls</td></tr>
                        <tr><td><code>plss_breakdown_report.log</code></td><td>PLSS</td><td>Per-parcel dimensions, acreage, courses, coordinates</td></tr>
                        <tr><td><code>export.xml / *.landxml</code></td><td>LandXML Studio</td><td>Schema-compliant LandXML 1.2 geometry with <code>&lt;Parcels&gt;</code>, <code>&lt;Alignments&gt;</code>, and <code>&lt;CgPoints&gt;</code></td></tr>
                        <tr><td><code>fdot_batch_fix.scr</code></td><td>Batch Auditor</td><td>Consolidated AutoCAD batch script running AUDIT, color resets, PURGE, and OVERKILL across all project drawings</td></tr>
                        <tr><td><code>fdot_master_submittal_report.html / .md</code></td><td>Batch Auditor</td><td>Consolidated project QA/QC submittal scorecard and sheet compliance matrix</td></tr>
                        <tr><td><code>fdot_reports_bundle.json / fdot_reports_manifest.txt</code></td><td>Reports Hub</td><td>Consolidated export bundle containing all active survey, engineering, DXF, and standards QA/QC submittal reports with unified FDOT metadata</td></tr>
                        <tr><td><code>JEA_AsBuilt_2026.dxf</code></td><td>JEA As-Built Standards</td><td>Civil 3D AutoCAD DXF with JEA layers, BLOCK symbols, ATTRIB metadata, and 3D pipe runs</td></tr>
                        <tr><td><code>JEA_Pipe_Crossing_Table.csv</code></td><td>JEA As-Built Standards</td><td>Tabular pipe crossing dataset matching official JEA As-Built 2024 spreadsheet format</td></tr>
                        <tr><td><code>&lt;drawing&gt;_package_check.csv</code></td><td>JEA As-Built Standards</td><td>Package check findings: severity, section and rule, ID, location, finding</td></tr>
                        <tr><td><code>&lt;workbook&gt;_workbook_QC.csv</code></td><td>JEA As-Built Standards</td><td>Workbook self-check findings: severity, rule, ID, sheet!cell, finding</td></tr>
                    </tbody>
                </table>`
        },
        {
            id: "glossary",
            title: "7. Glossary",
            html: `
                <dl class="help-dl">
                    <dt>Aliquot part</dt><dd>A PLSS subdivision by repeated halving/quartering of a section (e.g. "SW 1/4 of the NE 1/4").</dd>
                    <dt>Azimuth</dt><dd>Direction measured clockwise from north, 0–360°. Used internally; displayed as a quadrant bearing.</dd>
                    <dt>Bow-tie</dt><dd>A polygon whose boundary crosses itself — a topological error, usually from an inverted bearing quadrant or an out-of-order call.</dd>
                    <dt>Departure</dt><dd>The east–west component of a course: distance × sin(azimuth).</dd>
                    <dt>JEA</dt><dd>JEA — the community-owned utility providing water, wastewater, reclaimed water, and electric utility services in Northeast Florida.</dd>
                    <dt>Latitude</dt><dd>The north–south component of a course: distance × cos(azimuth).</dd>
                    <dt>Linear misclosure</dt><dd>The straight-line gap between the computed end of a traverse and its point of beginning.</dd>
                    <dt>P,N,E,Z,D</dt><dd>Point file format: Point number, Northing, Easting, Z (elevation), Description.</dd>
                    <dt>PC / PT / PRC / PCC</dt><dd>Point of Curvature / Tangency / Reverse Curvature / Compound Curvature — curve node labels expected on a plat.</dd>
                    <dt>Pipe Crossing Separation</dt><dd>The vertical distance between the bottom of the upper pipe and the top of the lower pipe at a crossing. JEA's minimum depends on the pipes: a water main at least 6 in above (12 in preferred) or 12 in below a gravity or storm sewer, and 12 in from a force main or reclaimed main (JEA Standards 2026 §350 III.4.4–III.4.5).</dd>
                    <dt>POB</dt><dd>Point of Beginning.</dd>
                    <dt>Precision ratio</dt><dd>Perimeter ÷ linear misclosure, written 1:X. Higher is better; ≥ 1:10,000 is survey grade for boundary work.</dd>
                    <dt>Shoelace formula</dt><dd>Polygon area from vertex coordinates: ½·|Σ (x_j + x_i)(y_j − y_i)|.</dd>
                    <dt>SPCS83 East Zone</dt><dd>State Plane Coordinate System of 1983, Florida East Zone (FIPS 0901, EPSG 2236) in US Survey Feet.</dd>
                </dl>`
        },
        {
            id: "limits",
            title: "8. Limits of this build",
            html: `
                <ul>
                    <li><strong>No server.</strong> Sign-in uses real salted PBKDF2 password hashing, sessions, and lockout, and the template limit is enforced in code — but it all lives in <code>localStorage</code> on this device and can be bypassed from devtools. Subscription tier is just a stored value, "Stripe webhooks" and PKI seal validation are simulated, and the CMS audit log is a local hash chain (tamper-evident for in-place edits only — not an external notarization).</li>
                    <li><strong>The C# Civil 3D add-in</strong> in <code>plugins/civil3d-addin/</code> is a licensing/ribbon scaffold. The audit, layer-purge, and manifest commands are stubs; they do not read the drawing.</li>
                    <li><strong>No image / plat tracing.</strong> Parcel → DXF works from typed calls, not scanned plats.</li>
                    <li><strong>Ideal PLSS only.</strong> The breakdown assumes a perfect 5,280 ft section. Real retracement must honor the GLO plat, found corners, and fractional lots.</li>
                    <li><strong>Curve traverse legs</strong> are approximated by their chord when computing closure and area.</li>
                    <li>The bundled reference data (layers, pay items, keys) is a representative subset, not the complete FDOT release.</li>
                </ul>
                <p>Reference: FDOT CADD Manual Topic No. 625-050-001; F.A.C. Rules 61G15-23.004 (PE) and 5J-17.062 (PSM). This tool does not replace professional review.</p>`
        }
    ];

    const STYLE_CSS = `
        .help-wrap { max-width: 60rem; }
        .help-wrap h2 { font-size: 1.3rem; margin-bottom: 0.25rem; }
        .help-wrap h3 { font-size: 1rem; margin: 1.5rem 0 0.5rem; color: var(--primary); border-top: 1px solid var(--glass-border); padding-top: 1rem; }
        .help-wrap h4 { font-size: 0.9rem; margin: 1rem 0 0.35rem; color: var(--accent); }
        .help-wrap p, .help-wrap li, .help-wrap dd { font-size: 0.88rem; line-height: 1.55; color: var(--text-secondary); }
        .help-wrap ul { margin: 0.4rem 0 0.4rem 1.1rem; }
        .help-wrap li { margin: 0.2rem 0; }
        .help-wrap code { font-family: var(--font-mono); font-size: 0.82em; background: var(--bg-secondary); padding: 0.1em 0.35em; border-radius: 3px; color: var(--accent); }
        .help-wrap kbd { font-family: var(--font-mono); font-size: 0.78em; background: var(--bg-secondary); border: 1px solid var(--glass-border); border-bottom-width: 2px; border-radius: 4px; padding: 0.1em 0.4em; }
        .help-wrap a { color: var(--primary); }
        .help-toc { background: var(--bg-secondary); border: 1px solid var(--glass-border); border-radius: var(--radius-sm); padding: 0.9rem 1.1rem; margin: 1rem 0 1.5rem; columns: 2; column-gap: 2rem; }
        .help-toc a { display: block; font-size: 0.82rem; padding: 0.15rem 0; }
        .help-table { width: 100%; border-collapse: collapse; margin: 0.5rem 0; font-size: 0.82rem; }
        .help-table th, .help-table td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid var(--glass-border); vertical-align: top; }
        .help-table th { color: var(--text-muted); text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.03em; }
        .help-dl dt { font-weight: 700; color: var(--text-main); font-size: 0.85rem; margin-top: 0.5rem; }
        .help-dl dd { margin: 0.1rem 0 0 0; }
        .help-note { border-left: 3px solid var(--primary); background: rgba(2,132,199,0.08); padding: 0.7rem 0.9rem; border-radius: var(--radius-sm); margin: 0.8rem 0; font-size: 0.84rem; }
        .help-note--warn { border-left-color: var(--warning); background: rgba(245,158,11,0.1); }`;

    function ensureStyle() {
        if (document.getElementById("help-plugin-style")) return;
        const el = document.createElement("style");
        el.id = "help-plugin-style";
        el.textContent = STYLE_CSS;   // static, author-controlled CSS — safe to inject directly
        document.head.appendChild(el);
    }

    function renderInto(rootId) {
        ensureStyle();
        const root = document.getElementById(rootId);
        if (!root) return;
        // TOC + headings use data-* attributes (always preserved by the sanitizer) so
        // in-pane navigation does not depend on id / href#fragment surviving.
        const toc = SECTIONS.map(s => `<a href="#${s.id}" data-goto="${s.id}">${s.title}</a>`).join("");
        const body = SECTIONS.map(s => `<section><h3 id="${s.id}" data-sec="${s.id}">${s.title}</h3>${s.html}</section>`).join("");
        window.setSafeHTML(root, `
            <div class="glass-panel help-wrap" style="padding:1.5rem;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; flex-wrap:wrap;">
                    <div>
                        <h2><i class="fa-solid fa-circle-question" style="color:var(--primary);"></i> User Manual</h2>
                        <p style="font-size:0.85rem; color:var(--text-muted);">FDOT Civil3D Standards Suite — v2.6.0. Press <kbd>?</kbd> anywhere to return here.</p>
                    </div>
                    <button class="btn btn-secondary" data-help-print><i class="fa-solid fa-print"></i> Print / Save PDF</button>
                </div>
                <div class="help-toc">${toc}</div>
                ${body}
            </div>`);

        root.querySelector("[data-help-print]")?.addEventListener("click", () => window.print());
        root.querySelectorAll("a[data-goto]").forEach(a => {
            a.addEventListener("click", e => {
                e.preventDefault();
                const el = root.querySelector('[data-sec="' + a.getAttribute("data-goto") + '"]');
                if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
            });
        });
    }

    const Plugin = {
        init() {
            renderInto("help-root");
        },
        setupEvents() {
            // "?" or F1 jumps to the Help tab (unless typing in a field).
            window.addEventListener("keydown", e => {
                const tag = (e.target.tagName || "").toLowerCase();
                if (tag === "input" || tag === "textarea" || e.target.isContentEditable) return;
                if (e.key === "?" || e.key === "F1") {
                    e.preventDefault();
                    document.querySelector('.nav-btn[data-tab="tab-help"]')?.click();
                }
            });
        },
        onTabActivate() {
            renderInto("help-root");
        }
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);
})();
