# Changelog

What changed in each release of the FDOT Civil 3D tools. The build shown at the
bottom of every page (version · commit · date) tells you which release you're using.

## Unreleased

**JEA: survey, control, resubmittal, review**
- Every feature surveyed (§501 II.1.17): workbook points against the field shots (0.5 ft).
- Published control (§501 II.1.6): cited NGS marks, and with pasted datasheets their elevations and
  positions; PDF sheet sizes (24" × 36", §501 II.1.1) and digital signatures (present, not validated).
- Resubmittal compare (§501 I.6.3) with JEA's comments; *Copy with all fixes* (lat/lon, depth, slope,
  optional ID renames); overlay DXF; submittal package zip; findings map; per-finding review status
  in the readiness report.
- Easy Button: JEA 2026 asset tables from field data, and *Send to JEA package check* with its shots.

**JEA: outputs that fix the deliverable**
- *Copy with lat/lon filled*: the workbook back with Latitude / Longitude filled or corrected from
  State Plane (JEA's 0.5 ft), the rest of the file untouched; rows whose coordinates look wrong are
  left alone and listed; every change in a CSV.
- *Download JEA 2026 asset tables (.xlsx)*: the model written into JEA's 2026 template layout
  (blank where the model has no value). New dependency-free .xlsx writer.
- *Readiness report* (HTML, also in the Reports Hub), *Transmittal & checklist draft* (§501 V.2 / V.3,
  pre-filled), *Move-to-State-Plane script*, per-finding Civil 3D *Zoom* command, batch package check.
- Big drawings are read in a background worker. The Reports Hub flags reports made under other rules
  or before the Oct 28, 2026 crossing correction; a banner reminds of JEA's Jan 1, 2027 update.
- FDOT survey panel: layer names checked against the FDOT CADD Manual 2025 convention (§5.10.1.1).
- `npm run test:private`: a regression run over real packages kept outside the repository.

**JEA: more checks from the 2026 standards, rules stamp, 2026 labels**
- New checks: horizontal separation of water mains from sewers / force mains / reclaimed (§350
  III.4.2–III.4.3, centerlines), recorded points at least every 100 ft along pressure mains (§501
  III.1.3), gravity sewer run slope vs inverts and length (§501 IV.1.4), manhole inverts with
  directions (§501 III.2.6), and the pump station attribute worksheet's completeness.
- Every audit, workbook check and package check is stamped with the rules it used (JEA standards
  revision, crossing minimums, picklist source, tolerances).
- Crossing minimums can be set in JEA Settings (default JEA 2026: 6 / 12 / 12 in).
- Easy Button's crossings show how many were judged by JEA §350 and how many by your minimum.
- The JEA tab, page title, reports and template label say 2026; a notice on the tab records the
  October 28, 2026 correction of the crossing rule.

**JEA 2026 standards (from JEA's published 2026 documents)**
- **Crossing separation corrected.** Earlier versions applied one 18-inch minimum to every pipe
  crossing; that figure isn't in JEA's standards. Crossings are now checked by pipe type, per JEA
  Water and Wastewater Standards (rev. Jan 1, 2026) §350 III.4.4–III.4.5: a water main at least 6 in
  above (12 in preferred) or 12 in below a gravity/vacuum/storm sewer, and 12 in above or below a
  force main or reclaimed main. Crossings without a water main are reported as not checked. Applies
  to the audit, the drawing builder's labels, the crossing table and Easy Button's crossings.
- Picklists updated to the JEA As Built Template 2026 (Manhole Manufacturer, Valve Type changed;
  "-999 = not applicable" notes on valve Turns to Open / Depth to Nut, and -999 is never a value).
- The workbook import reads JEA's own 2026 template (one table per sheet; Pipe Crossing Table rows
  become checked crossings; pipe-run / points-along-pipe rows counted; reference sheets skipped).
  Template list loading now reads the "Validation Lists" sheet, not the rule references.
- Workbook check tolerances are JEA's positional accuracy: lat/lon 0.5 ft (plus the recorded
  figure's rounding), depth 0.1 ft (§501 II.1.7).
- The sheet / certification check follows JEA's §501 II.1 and V.3 As-Built Submittal Check List
  (every sheet: label, surveyor and contractor certifications, PSM, JEA number, graphic scale; cover:
  datum, vicinity map, completion date, legend, surveyor and general notes, field survey date), with
  drawn items listed to check by eye.
- JEA's standards set no CAD layer names, so non-template layers are notes and no longer cost score.

**FDOT survey checks from FDOT's published documents**
- *Survey & Desckeys* gains an FDOT survey panel: the 502 official FDOT Survey Feature Codes
  (4/24/2025) to search and download, a point-file check (codes not on the list, line codes with one
  shot), a drawing check (survey-style layers not on the FDOT level list), and a survey report check
  against the Surveying and Mapping Handbook's (Feb 28, 2025) Appendix E format and §1.3 NAVD 88 rule
  (.docx, .txt or pasted text).
- Legal Description QC: an opt-in *FDOT right of way description* box adds the handbook's §31.6.2
  area rules (acres to 3 decimals at half an acre or more, else square feet; "more or less"; one unit;
  stated vs computed area) and §31.4 parcel-number series.

**JEA package check: files, pipe labels, multileaders; Help quick start**
- *Check Package* now also checks the package files: add the PDF set and the eTransmit transmittal
  (.txt) to compare PDF pages with "SHEET x OF y", list files eTransmit couldn't find or left out,
  and flag drawing xrefs the transmittal doesn't carry.
- Pipe-length labels ("43.1 LF", "±79 LF") are compared with the drawn run they sit on; a label
  longer than its whole run is flagged, the rest are counted (agree / can't be checked).
- Multileader text is read, placed at its arrowhead, so more labels and ID callouts count.
- Help: a Quick start at the top (files, DWG to DXF, the JEA package steps, common problems), the
  FDOT 550-030-101 legal-description requirements beside Legal Description QC, and "JEA" used as the
  utility's name.

**JEA As-Built: package checks and settings**
- *Check Package*: per-layout sheet and certification fields (observed in sample packages, not
  JEA's checklist), whether the drawing sits on State Plane (coordinate labels and ID callouts vs
  their position), and every workbook ID against the drawing — in both / workbook only / drawing
  only / written differently, plus drawing table rows whose coordinates or type disagree.
- *Settings* sub-tab (saved per browser): confirm built-in or your own as-built layer mappings
  (confirmed ones count toward the score), the workbook-check tolerances, which repeated row to
  keep, and picklists loaded from a JEA template workbook (e.g. 2026), with a reset to 2024.
- The DXF reader keeps curves (polyline bulges, arcs, splines), reads old-style POLYLINE/VERTEX
  entities, and carries elevations into extracted pipes (0 is read as "not set").
- Fixed: on the JEA tab each sub-tab switch added another set of click handlers, so one click could
  run its action many times (128 CSV downloads in the new browser test).

**JEA As-Built: Excel workbook, self-check and real-drawing audits**
- The JEA tab imports the As-Built Excel workbook (.xlsx): the auditor builds and audits a JEA
  drawing from it, and the Drawing Builder loads it as its model. Picklist values are matched,
  rows repeated across sheets are merged once per ID, and nothing missing (an invert, the county)
  is invented.
- Workbook self-check, with a findings CSV: lat/lon vs. the SPC position, TOP + DEPTH = GRADE,
  top above grade, two IDs on one point, a point far from the rest of the job, the same ID as two
  kinds or with conflicting values, text in a number cell.
- The DXF audit reads model space only, skips AutoCAD's anonymous blocks, rolls findings up per
  polyline / per layer, names entity handles, and reports "not scored" (with the reason and what
  was and wasn't checked) when a drawing has nothing JEA-specific to check — it used to show a
  pass computed from nothing.
- What the audit skips is listed, not dropped: paper-space entities by layer and type, the count of
  anonymous blocks, and a warning for any JEA block placed in paper space.
- As-built layer names seen in real drawings (`_AB POWM PIPE LN`, `AB-GRAVITY-LINE`…) are mapped
  through an editable, clearly *inferred* table; "Extract Pipe Network" pulls their linework into
  the model. Picking a .dwg explains how to export a DXF.
- COGO: an unknown State Plane zone or unit is now an error instead of quietly using FL East / metres.

**Traverse 3D closure**
- Traverse calls can carry a vertical part — `DZ ±x` (record: horizontal distance and rise) or
  `ZA d-m-s` (field: slope distance and zenith angle). With one on every call and a POB elevation,
  the closure is 3D (misclosure √(ΔLat² + ΔDep² + ΔZ²) over the slope perimeter, vertical
  misclosure reported) and the point file and Civil 3D script carry the real elevations. Without,
  it stays the 2D closure. Mixed calls, a bad zenith / DZ or a missing POB elevation are errors.

**Recommendations round**
- Easy Button: per-code pipe Material (DI, C900 DR14/18/25, PVC SDR 26/35, RCP) and ductile-iron
  pressure Class columns in the code list; a SIZE column per shot in the field file; crossings
  whose invert was interpolated far from a shot are flagged "check".
- Easy Button: after writing a DXF, attributes that kept the template's default are listed per
  symbol; more attribute tag names are recognised.
- Easy Button: profiles saved to / loaded from the PostgreSQL database (bridge server); the
  template drawing is remembered in the browser per profile.
- Easy Button: Civil 3D linework script (figures named by our codes) and a Figure Prefix Database
  starter CSV.
- Subdivision: fixed-width ponds (compact, at the back of each road side); a second parallel road;
  City of Jacksonville RLD lot-standard presets (§656.305).
- Subdivision: draw the boundary from an uploaded point file (P, N, E, Z, D — header skipped, optional
  description filter such as BND); a minimum lot depth (average depth = area ÷ frontage, 100 ft to
  start) alongside the minimum width; the curve direction is a visible Left / Right toggle.
- Subdivision: setbacks with a building envelope and minimum buildable area (RLD presets fill
  them); corner lots with extra width and sight triangles; front / rear easements; a loop road
  (two roads joined at the back); merging failing end lots; construction phases; fixed-width ponds
  sized by volume with side slopes and freeboard.
- Subdivision: save named scenarios and compare them side by side; LandXML parcel export; send the
  layout to the Linework Editor; take the boundary from Easy Button's BND figure; metric boundaries
  converted to feet. Settings that don't validate no longer leave the previous layout exportable.
- Easy Button: a stress test (20,000 shots, 10 MB template) runs in CI. It found a crash writing a
  big job into a template (fixed), and finding crossings on a large job is about 5× faster (same
  results). The crossing step's UI is its own file.
- Linework Editor: public loadFigures / getFigures / onChange / redraw interface — Easy Button,
  Subdivision, Overlay, JEA template, EFB and LandXML use it instead of the editor's internals.
- CI: browser suites wait up to 30 s for Chrome and retry once only when it never starts.

**Easy Button** (new tab, phases 1–3)
- Load a client code list (code, description, our code) once: it's matched to the standard code
  list — given codes first, then suggestions from the code, description and common abbreviations —
  with typos, duplicates and control-word clashes flagged. Save it as a reusable profile, or export
  / import it as JSON.
- Translate a crew's field file to the standard codes and build linework on the right layers
  (JEA layers for water, sewer and reclaimed); valves, hydrants, manholes and other point codes are
  kept as point features with their symbols; pipe inverts are kept on every vertex. Unmatched codes
  are listed and can be added to the code list.
- Open the result in the Linework Editor, or download the translated point file, the point
  features, or the completed code list.
- Template & drawing: upload your template DXF (or use the JEA template). Our codes are matched to
  its layers and symbols by name — National CAD Standard names included — and the matches are
  saved with the profile. The final DXF is your template with the survey drawn in: pipes as 3D
  polylines keeping their inverts, symbols with attributes filled (point number, elevation / invert
  / rim, description), and everything checked against the template's layers and symbols.
  Template reading and writing live in a new reusable plugin, `dxf-template`.
- Pipe crossings: every place two pipes cross is found, with each pipe's invert interpolated, its
  top and bottom from published wall thicknesses (top = invert + inside diameter + wall, bottom =
  invert − wall: ductile iron (ACIPCO minimum pressure class) or C900 PVC DR 18 for water, PVC
  SDR 35 for sewer, RCP ASTM C76 Wall B for storm), the separation and
  the 18 in JEA minimum checked, and grade / cover estimated from nearby shots. Drag boxes on the
  plan around crossings that need a table: each box gets a crossing table in the JEA Pipe Crossing
  Table format in the DXF, plus JEA_CROSSING symbols with their attributes; or download the table
  as CSV. Pipe sizes come from the shot (8IN), an optional Size column in the code list, or a
  default per pipe type — without one a crossing is "not scored". New reusable plugin:
  `pipe-crossings`.

**Subdivision** (new tab)
- Concept lot layout for a boundary: number of lots, minimum frontage, lot size (sq ft and acres),
  maximum lot depth, road width / position / allowable area, and required green space.
- The road enters from the frontage street and runs straight, through one curve, or through a
  reverse curve (radius, deflection, direction and tangents set per curve). It either ends in a
  cul-de-sac or runs through to the back boundary for ingress and egress. Lot lines follow the
  road — perpendicular on straights, radial on curves and around the bulb — and never overlap.
- Retention ponds behind the lots, parallel to the road (a strip from the lot depth outward,
  hatched in blue), sized from the impervious surface (40% by default, with the runoff depth and
  pond depth adjustable) or from a typed square footage; number of ponds, and connectivity in
  series, each to the road, or none, with the pipe length reported.
- Road, ponds and green space toggle on and off. Live and interactive: every setting redraws the
  plan, the road can be dragged, a boundary edge clicked to become the frontage, and lots hovered
  or selected. Recommended starting values, a "use max" lot count that keeps every lot passing,
  and per-lot and overall checks.
- Export as DXF (SUBD-* layers) or a one-page PDF.

**Home page** (`home.html`)
- New FieldIQ-styled home page next to `landing.html`: hero, a workflow explorer for the tools that
  exist in the app, capabilities, and numbers read from the app's own data. Fully self-hosted
  (no CDN, strict CSP); the hero image and script live in `assets/`. Unverified claims from the
  draft (compliance, uptime, accuracy figures, pricing) were left out.

**Overlay** (Linework Editor)
- Optional street-map / aerial-imagery basemap behind the linework, with an on/off toggle and
  basemap selector (OpenStreetMap, Carto, USGS imagery, USGS topo). Off by default; the CSP
  allows only these tile hosts, and only for images.
- Placed from NAD83 State Plane: a zone list covering all 50 states, statewide alternates, Puerto Rico / Virgin Islands,
  Caribbean UTM and Canada (UTM, MTM, provincial and national grids — 192 zones) and a units
  list (meters, US survey feet, international feet). Picking a zone preselects its customary
  unit. Coordinates outside the chosen zone/unit are not drawn rather than misplaced.

## 2.9.0 — 2026-10-24

**Materials** (new tab)
- Every material and equipment list in the JEA As-Built Standards 2024 template, read live
  from the template.
- Pipe sizes in imperial and metric: nominal size, DN and outside diameter (in and mm) for IPS,
  DIPS, PVC gravity sewer and copper-tube-size systems, plus the JEA standard size list.
- Pipe systems, appurtenances and typical fittings for water, sewer and gas service lines, each
  with its governing standard.
- Search, utility and units filters, section links, and CSV export of what's shown.

## 2.8.1 — 2026-10-24

**Fixes**
- Reports Hub: HTML reports previewed as a blank pane and "View Source" threw an error (the
  preview frame was stripped by the sanitizer); they now render in a sandboxed frame. Copying
  shows a message instead of a blocking pop-up; deleting a report (and clearing all) asks first.
- Report headers no longer fill in a district, county, FPID or evaluator that wasn't provided.
- Parcel → DXF: calls that don't return to the POB were silently closed with an invented side
  (and lost their last point); they're now drawn open, exactly as called, with a warning.
- Linework Editor: a circle figure's script referenced a point number that was never written.
- Layer / pay-item / survey-key tables: blank fields showed "undefined"; "Copied" was shown even
  when the clipboard was blocked.
- Public site: the demo modules' console notices (one printed the demo password) are gone.

## 2.8.0 — 2026-10-24

**Public test site**
- Demo-only pages (sign-in, the mock checkout, Commercial / Enterprise / Admin
  Dashboard) are no longer part of the public build.
- Every page shows its build and has a **Report a problem** link that opens a
  pre-filled issue form.
- A site-wide notice that reference data is illustrative and not design-ready.
- Favicon; this changelog.

**DXF → Code File**
- New **Autodesk Field Book** output (`BEG` / `NE SS` / `C3` / `END`) for Civil 3D's
  Import Field Book, alongside the survey command script.

**Fixes**
- JEA As-Built: drawings containing a blank or stray line were misread (layer names
  lost); the parser now resynchronises like the other DXF readers.
- Scale-factor helpers and new DOT projects no longer fill in missing values
  (scale factor 1.0, county, district, a random FPID) — missing input is an error.
- Accessibility: every input has a label, icon-only buttons have names, and the
  layout fits a phone screen.
- Faster page load.

## 2.7.0 — 2026-10-24

**DXF → Code File** (new tool)
- Reads a DXF's linework (lines, arcs, circles, 2D/3D polylines) and writes a code
  file with figures named LW001, LW002, …; curves as PC / OC / PT points.
- SCOPE layers limit the linework, one commented block per scope.
- Each figure has its own points (points may share a spot); TEXT becomes points;
  elevations from a survey point file, matched by position and code.
- Conversion report (.txt) and figure table (.csv).
- Joining only rebuilds loose LINE / ARC pieces — drawn polylines are never fused.

**Legal Description QC**
- Plot of the deed linework (true arcs, direction of travel, closing gap and
  crossing calls flagged).

**Testing**
- 100% engine coverage gate, property-based fuzzing and a browser end-to-end test
  for DXF → Code File.

## Earlier

- Hardening: no invented results (scores, hashes, precision ratios); validated
  engineering inputs; consolidated security fixes.
