# FDOT Civil 3D tools — public test build

This repository only hosts the published, built copy of the app:
**<https://band72.github.io/fdot-civil3d-site/>**. It is regenerated automatically on every
release, so changes made here directly are overwritten.

Found a problem? Use the **Report a problem** link at the bottom of any page, or
[open an issue](../../issues/new?template=problem.yml). Reference data in the app is
illustrative and unverified — no output is design-ready.

## Test file

Want to try the JEA As-Built checks on a real job? Download the Connect Church test package:
**[Connect-Church-QC.zip](https://band72.github.io/fdot-civil3d-site/docs/Connect-Church-QC.zip)**
(8.5 MB). It holds the as-built drawing (`.dwg` and the `.dxf` exported from it), the JEA
as-built workbook (`.xlsx`), the signed plan set (`.pdf`), and the results of running the checks
on them — a readiness report, a findings CSV and `JEA-QC-Steps-and-Results.txt`, which walks
through loading the files in **JEA As-Built 2026 → Reverse-Read DXF Auditor** step by step.

---

*The app's README follows.*

---


# FDOT Civil3D Standards Suite

A **client-side, no-build** web app — a set of surveying / CADD tools for
FDOT (Florida DOT) Civil 3D workflows:

- **CADD standards:** standards compare + auto-correct, DXF project / tables /
  batch auditing, JEA As-Built 2024 auditing, LandXML interop.
- **Survey & COGO:** traverse closure, legal-description QC with a deed plot,
  PLSS section breakdown, parcel → DXF, the Linework Editor and Electronic
  Field Book, and **DXF → Code File** (DXF linework to a Civil 3D field book —
  survey script or Autodesk Field Book syntax — with SCOPE limits, elevations
  from a survey point file and a conversion report).
- **Reference:** FDOT layers, pay items, survey keys, blocks, subassemblies,
  sheets, hydrology (Rational Method, exfiltration trench), sign QTO, and
  **Materials** (JEA template materials, pipe sizes in imperial and metric,
  water / sewer / gas fittings and appurtenances).
- A Reports Hub and system log, plus a demo CMS / billing layer (local only,
  hidden on the public site).

## Try it online

**Public test site: <https://band72.github.io/fdot-civil3d-site/>** — the
current `master` build, redeployed automatically on every push (see
Deploy). Nothing to install; everything runs in your browser and
nothing you load leaves it. The source repository is private; the site repo
`band72/fdot-civil3d-site` holds
only the built static files.

Quick things to try (no files of your own needed — use the sample / demo
buttons, or the drawings in `example_dxfs/`):

| Try | Where | What to look for |
|---|---|---|
| Standards check + auto-correct | **Start · Standards Compare** → *Load Demo Target & Template* | layer issues, geometry diff overlay, corrected `.dxf` |
| DXF audit | **DXF Project Auditor** → open a file from `example_dxfs/` | compliance score, bow-tie / zero-length flags, fix `.scr` |
| DXF → Code File | **DXF → Code File** → *Load sample DXF* | `LW001…` figures, NEZ points, PC / OC / PT curve points, per-scope blocks when the DXF has `SCOPE*` layers, `.fbk` + conversion report + figure CSV downloads |
| Deed plot + closure | **Legal Description QC** → *Parse & Check* | call table, plotted boundary (true arcs), misclosure / area |
| Traverse | **QC & Traverse Auditor** | closure, precision ratio, Shoelace area |
| Field linework | **Linework Editor** → *Load sample field data* · **Electronic Field Book** | figures from a point file or chain list, interactive editing |
| Batch audit | **Batch Project Auditor** → *Load Demo Project Batch* | compliance matrix + master scorecard |
| JEA as-built workbook | **JEA As-Built 2024** → *Reverse-Read DXF Auditor* → pick a JEA As-Built `.xlsx` | items imported per kind, workbook self-check findings (lat/lon vs SPC, top + depth vs grade, duplicates), findings CSV, the audit of the drawing built from it |
| Materials | **Materials** → pick a utility, units and sizing system | JEA template material lists, pipe sizes in inches and mm, appurtenances and fittings |

Please report anything that looks wrong — use **Report a problem** at the bottom
of any page (it opens an issue form with the build filled in). A value that
doesn't match your own computation is exactly what public testing is for. Remember the
reference-data caveat below: no output here is design-ready.

Everything runs in the browser, no build or bundler. Every asset is
self-hosted under `vendor/` — DOMPurify, Font Awesome (solid +
brands) and the Inter / JetBrains Mono web fonts — so the CSP allows no
third-party origin at all, and every script is deferred. Storage is `localStorage` by default; an **optional**
local PostgreSQL bridge (`server.py` + `db/`) lets the
Admin Dashboard sync CMS data to a real relational database — see
`docs/cms_arch.md` and the Plugins
table below (`db-sync` / `db-settings`). Nothing requires it; the app runs
exactly as before with the plain static server.

> ⚠ **Reference data is illustrative and unverified.** Layer colours, the
> 11 IDF-zone coefficients, Manning's `n`, pay-item mappings and similar
> values in `core/data.js` were authored for the demo and
> have **not** been checked against a current FDOT CADD Manual, Basis of
> Estimates, or Drainage Manual. Do not use any computed quantity for
> production design without confirming the inputs against the
> authoritative FDOT source.
>
>
> Hydrology: enter the rainfall intensity read from the official FDOT IDF
> curve (the zone curve is a labelled fallback only). The exfiltration-trench
> sizer uses the SFWMD / FDOT trench equation — confirm its form and inputs
> against the current FDOT Drainage Design Guide / SFWMD criteria. Blank or
> out-of-range inputs are rejected, never replaced with defaults.
>
> Closure threshold: 1:10,000 is the default QC preference (set per client
> template) — current Rule 5J-17.051 sets no single statutory ratio.
>
> Materials: outside diameters, classes and standards are reference values
> from published tables — verify against the governing standard, the
> utility's current specifications and the manufacturer before design or
> procurement. Millimetre values are computed from the inch values.
>
> The Commercial / Enterprise / CMS tabs are **demo builds** — sign-in,
> licensing, seals and payments are browser-local and enforce nothing. The
> public test site leaves them out entirely.

## Run it

Serve it over HTTP (a `file://` open breaks the CSP and some fetches). The
recommended way is the bundled server, which serves **only** the public app
files (never `.bridge_token`, `.db_config.json`, `.git/`, `server.py`, `db/`
or `scripts/`):

```bash
npm start          # python3 server.py 8085 — open http://localhost:8085
```

`python3 -m http.server` also works for the static tools, but it serves
*every* file in the folder, dotfiles included — don't use it in a checkout
that holds a `.bridge_token` or `.db_config.json`.

To also use the PostgreSQL sync features (Admin Dashboard → Database):

```bash
npm run db:start      # start a local PostgreSQL cluster (scripts/pg_ctl.sh)
npm run db:init       # apply db/schema.sql (+ idempotent migrations) and seed demo rows
npm run db:app-role   # optional, recommended: create a least-privilege 'fdot_app' role
npm start
```

### Bridge security model

`server.py` is a **single-user, loopback-only** bridge:

- binds to `127.0.0.1`; rejects any request whose `Host` header isn't its own
  loopback address (blocks DNS-rebinding) or whose `Origin` is another site;
- static files come from an allowlist (`index.html`, `landing.html`, `home.html`,
  `style.css`, `favicon.svg`, `core/`, `plugins/`, `vendor/`, `example_dxfs/`, `docs/`, `assets/`);
  dotfiles are never served and directory listing is off;
- every data endpoint needs the `X-Bridge-Token`, which `/api/db/token` only
  hands to the app's own origin;
- request bodies are capped (`BRIDGE_MAX_BODY_MB`, default 25); errors are
  generic, details go to the server console;
- the **audit chain is append-only**: the server recomputes every entry's
  SHA-256, checks it links to the stored chain, never overwrites a stored
  entry, and a database trigger blocks `UPDATE`/`DELETE`/`TRUNCATE`;
- sync never stores invented values (no `VERIFIED_PASSED`, `1:50,000` or
  all-zero hashes) and never stores password hashes.

`tenantId` is supplied by the browser, so it scopes queries but is **not**
tenant isolation — that needs real per-user authentication on a server.

## Test

Node-only, zero dependencies, no build:

```bash
npm test                    # everything (no server/DB required)
node tests/run.js cogo dxf  # named suites only
npm run test:py             # server.py unit tests (stdlib only, no DB)
npm run lint                # ruff (Python) + node --check (every JS file)
npm run test:db             # PostgreSQL suite — needs the bridge server + DB above running
npm run test:coverage       # per-file coverage floors; DXF → Code File engine + DXF parser at 100% (CI gate)
npm run test:stress         # Easy Button on a 20,000-shot field file + 10 MB template, timed (CI gate)
npm run test:e2e            # full-app browser suite in headless Chrome (needs npm start)
npm run test:e2e:dcf        # DXF → Code File UI in headless Chrome, every UI block must run (needs npm start)
npm run test:e2e:site       # public build, accessibility, phone layout, no third-party requests (needs npm start)
npm run test:e2e:tools      # Linework / Reports / layer tables / Parcel → DXF / Materials UI, combined Node+browser coverage floors (needs npm start)
```

CI (`.github/workflows/ci.yml`) runs all of the
above — including the DB suite against a PostgreSQL service container and the
four headless-Chrome suites against `server.py` — on every pull request and
every push.

~5,400 assertions across the default suites, plus about 200 checks in the
four browser suites. Coverage is gated: `tests/coverage.js` holds per-file
floors for the engines (DXF → Code File and the DXF parser at 100%), and
`tests/e2e-tools.js` gates the screen-heavy tools on combined Node + browser
coverage. Floors only go up. `tests/_env.js` loads every
`core/*.js` and `plugins/**/*.js` file into a shimmed browser-ish global
and exposes the site globals; `tests/README.md` maps each suite. `db` is
deliberately **not** part of the default `npm test` run — see
`tests/db.test.js`'s header.

## Architecture

- **Plugin registry** (`core/loader.js`) —
  each plugin is an IIFE that self-registers via
  `window.PluginRegistry.register(manifest, module)` at script load;
  `core/app.js` calls `initAll(ctx)` on `DOMContentLoaded`
  and passes a shared `ctx` (state + modal/toast helpers). Init order is
  a topological sort over `manifest.dependencies`.
- **Everything is a `window.*` global.** No modules, no bundler. Script
  load order in `index.html` must satisfy the dependency
  graph (globals are created at eval time).
- **Shared geometry kernel** (`core/cogo.js`) — bearing
  parsing (rejects impossible bearings such as `N 95 E` or 75 minutes),
  `runTraverse` (area includes each curve's arc-to-chord segment when its
  radius and turn direction are known, and reports curves it couldn't
  include), Shoelace area, self-intersection, DXF builder, PNEZD export. Reused by the linework, legal-desc, PLSS, plat2dxf and
  traverse plugins.
- **DOM safety** (`core/safe-dom.js`) — every dynamic
  write goes through `setSafeHTML` / `setSafeRows` → DOMPurify, with a
  text-only fallback if DOMPurify fails to load (neither ever falls back to
  raw markup). A CSP `<meta>` (`script-src 'self'`) blocks inline scripts.
- **Reference data** (`core/data.js`) — `window.FDOT_DATA`:
  layers, pay items, IDF zones, subassemblies, sheet standards, QC
  checklist. (See the caveat above.)
- **Public build** (`core/build-info.js`) — a development
  copy is checked in; the deploy stamps `publicBuild: true` with the version,
  commit and build time. In a public build `core/app.js` removes every
  `data-demo` element (demo sign-in, checkout, Commercial / Enterprise / Admin
  Dashboard) before plugins initialise, the database bridge is never
  contacted, the demo modules stay quiet, and the footer shows the build next
  to a **Report a problem** link.
- **Self-hosted assets** (`vendor/`) — DOMPurify, Font Awesome and
  the web fonts; the CSP (`default-src 'self'`) names no other origin, and the
  privacy notice and tests assert it.
- **Optional PostgreSQL bridge** (`server.py`,
  `db/schema.sql`) — a small stdlib HTTP server that serves
  the static app *and* a `/api/db/*` REST bridge to Postgres. The `db-sync`
  plugin is the only thing that talks to it; it translates between the
  DB's column shape and `cms-engine`'s object shape so `cms-engine` stays
  storage-agnostic (see that plugin's own comment header). Everything else
  keeps working unmodified if the bridge/DB isn't running.

## Plugins (`plugins/<name>/`)

| Plugin | Tab | Does |
|---|---|---|
| `stdn-compare` | **Start** · Standards Compare + Auto-Correct | The landing tab. Check a DXF against the built-in **FDOT 2026 layer standard**, an uploaded JSON standard, and/or a master-template DXF (its LAYER/LTYPE/STYLE tables + BLOCKS); tolerance geometry diff vs. a reference drawing with a pan/zoom SVG overlay; safe **auto-correction** to a corrected `.dxf`; HTML / Markdown reports. Ported from the `standardcompare-plugin` project (server half dropped). Supersedes the old layer-table-only "Template Compare". |
| `dxf-auditor` | DXF Project Auditor | Parse an FDOT DXF, score CADD-standards compliance, flag geometry errors (bow-tie, zero-length, out-of-envelope), export an auto-fix `.scr`; canvas renderer + spatial-index telemetry. |
| `layer-stds` | Layer Standards / Pay Items / Survey Keys | Filterable reference tables. |
| `materials` | Materials | Every material / equipment list in the JEA As-Built template (2026 lists) (read live from its data, nothing copied); pipe sizes in imperial and metric — nominal, DN and outside diameter by sizing system (IPS, DIPS, PVC sewer, CTS) plus the JEA size list; pipe systems, appurtenances and typical fittings for water, sewer and gas service lines, with governing standards. Search, utility and units filters; CSV export. Reference values — verify before use. |
| `pipe-crossings` | — (used by Easy Button) | Finds where pipes cross in plan; interpolates each pipe's invert at the crossing, computes top (invert + OD from the Materials size tables, or + nominal size), separation and the separation check (JEA Standards 2026 §350: by pipe type where a water main is in the crossing, else your minimum), estimates finished grade and cover from nearby shots; lays out crossing tables in the JEA Pipe Crossing Table format for the drawing and CSV. Values it can't compute are "not scored". |
| `dxf-template` | — (used by Easy Button) | Reads a template DXF's layers and symbols (block definitions with attribute fields), ranks template layers / symbols for a feature, and writes linework, symbols with attributes, points and labels into the template in place — keeping its tables, styles, symbols and existing entities, adding missing layers, and giving every new object a handle in R2000+ drawings. |
| `easy-button` | Easy Button | Guided field-data-to-drawing workflow that orchestrates the other tools: (1) a client code list CSV (code, description, our code; optional size, material, class) matched to the standard code list and saved as a reusable profile — in the browser, the PostgreSQL database (bridge) or a JSON file; (2) a P,N,E,Z,D field file (optional per-shot SIZE column) translated and built into figures with the Linework engine; (3) handed to the Linework Editor, with a Civil 3D linework script and figure-prefix list for survey databases; (4) codes matched to the client template's layers and symbols and the drawing written into the template via `dxf-template` (attributes left at their default reported); (5) pipe crossings via `pipe-crossings`, with per-code materials and an interpolation-distance flag, and JEA crossing tables in boxes drawn on a plan. The template is remembered in the browser. |
| `subdivision` | Subdivision | Concept lot layout for a boundary (calls, N/E coordinates, an uploaded P,N,E,Z,D point file with an optional description filter, the sample tract or a closed Linework figure): number of lots, minimum frontage (width) / depth / sq ft / acres (or a City of Jacksonville RLD preset) and maximum lot depth; one road, or two parallel straight roads, entering from the frontage street — straight, one curve or a reverse curve (radius, deflection, direction, tangents) — ending in a cul-de-sac, running through (ingress + egress) or, with two roads, joined in a loop by a back connector, with width, position and allowable area; front/side/rear setbacks with a building envelope and minimum buildable area (RLD presets fill them), corner lots with extra width and sight triangles, front/rear easements, merging of failing end lots, construction phases; retention ponds behind the lots, parallel to the road (fixed width at the back — sized by volume with side slopes and freeboard — or a strip along the road), sized from the impervious surface (40% default) or typed in, with pond count and connectivity (series / to the road / none); green space as a % of gross. Lot lines are perpendicular to the road and radial on curves and around the bulb; lots never overlap. Road, ponds and green space toggle on and off; every setting redraws live, the road can be dragged and a boundary edge clicked to become the frontage. Recommended starting values, per-lot and overall checks, saved scenarios compared side by side, a metric boundary converted to feet, the boundary taken from Easy Button's BND figure; DXF, one-page PDF and LandXML parcel export, or the layout sent to the Linework Editor. A yield study, not a plat or drainage design. |
| `overlay` | — (Linework toolbar) | Optional background basemap behind the Linework Editor: street map (OpenStreetMap, Carto) or USGS aerial / topo tiles, with an on/off toggle, basemap selector, opacity, and a coordinate-system picker — State Plane for all 50 states plus statewide alternates (e.g. Texas Centric, Wyoming Lambert), Puerto Rico / Virgin Islands, Caribbean WGS 84 UTM, and Canada (NAD83 UTM, MTM, Quebec / Ontario / Alberta / BC / Yukon / national grids) — 192 zones generated from the EPSG registry (Transverse Mercator, Lambert, Albers and oblique Mercator), in meters, US survey feet or international feet (a zone's customary unit is preselected). Off by default — tiles are only requested from the chosen provider while it is on. Coordinates outside the selected zone/unit are not mapped. |
| `sign-qto` | Sign Assemblies & QTO | Sign catalog + MUTCD surface-area → pay-item solver. |
| `ssa-hydro` | SSA Hydrology & IDF | Rational Method `Q = CiA` from the 11 IDF zones + exfiltration-trench sizer. |
| `traverse-cogo` | QC & Traverse Auditor | Lat/dep closure, precision ratio, Shoelace area, bow-tie detection, Map Check report. |
| `linework` | Linework Editor | Import field data (PNEZD or bearing/distance), run field-data checks, edit vertices/courses on an SVG canvas, fit real curves from field codes. |
| `tmplt-jea2024` Imports JEA's own *JEA As Built Template 2026* (one table per sheet, Pipe Crossing Table → crossings) as well as firms' titled workbooks. Lat/lon and depth checks use JEA's positional accuracy (0.5 ft / 0.1 ft, §501 II.1.7). JEA's standards set no CAD layer names, so layer notes cost no score. Also checks horizontal separation (§350 III.4.2–III.4.3), recorded points every 100 ft (§501 III.1.3), gravity run slopes (§501 IV.1.4), manhole inverts with directions (§501 III.2.6) and JEA's pump station attribute worksheet; every result is stamped with the rules it used, and crossing minimums can be set in Settings. Outputs: the workbook back with lat/lon filled from State Plane, JEA 2026 asset tables (.xlsx) from the model, a readiness report, pre-filled §501 transmittal and checklist drafts, a move-to-State-Plane script, Civil 3D zoom commands, and a batch package check. It also checks every feature against the survey shots (§501 II.1.17), published control against NGS datasheets (§501 II.1.6), PDF sheet size and signatures, and resubmittals against the previous workbook and JEA's comments; writes a fully fixed workbook copy, an overlay DXF and a submittal zip; maps the findings; and keeps a review status per finding. | JEA As-Built 2024 Imports JEA's own *JEA As Built Template 2026* (one table per sheet, Pipe Crossing Table → crossings) as well as firms' titled workbooks. Lat/lon and depth checks use JEA's positional accuracy (0.5 ft / 0.1 ft, §501 II.1.7). JEA's standards set no CAD layer names, so layer notes cost no score. Also checks horizontal separation (§350 III.4.2–III.4.3), recorded points every 100 ft (§501 III.1.3), gravity run slopes (§501 IV.1.4), manhole inverts with directions (§501 III.2.6) and JEA's pump station attribute worksheet; every result is stamped with the rules it used, and crossing minimums can be set in Settings. Outputs: the workbook back with lat/lon filled from State Plane, JEA 2026 asset tables (.xlsx) from the model, a readiness report, pre-filled §501 transmittal and checklist drafts, a move-to-State-Plane script, Civil 3D zoom commands, and a batch package check. It also checks every feature against the survey shots (§501 II.1.17), published control against NGS datasheets (§501 II.1.6), PDF sheet size and signatures, and resubmittals against the previous workbook and JEA's comments; writes a fully fixed workbook copy, an overlay DXF and a submittal zip; maps the findings; and keeps a review status per finding. | JEA 2024 As-Built Standards: builds a sample Civil 3D-ready DXF, reverse-reads a DXF and audits it against the 45 JEA 2026 picklists, State Plane East bounds and the JEA §350 pipe-crossing separations, generates JEA tables, and saves the result as a client template / Reports Hub entry. Imports the JEA As-Built Excel workbook (`jea-xlsx.js`, no dependencies) with a self-check of its own values and a findings CSV. The audit reads model space only, names entity handles, and reports "not scored" when a drawing has no JEA blocks or JEA layers to check. Real as-built layer names (`_AB POWM PIPE LN`, `AB-GRAVITY-LINE`…) map through an editable `LAYER_ALIASES` table that is **inferred, not from a JEA publication**; *Extract Pipe Network* pulls their linework into the model (geometry only; curves, old-style polylines and elevations kept). *Check Package* (`jea-package.js`) checks the drawing's sheets and certification fields (JEA Standards 2026 §501 II.1 and the V.3 As-Built Checklist), whether it sits on State Plane, every workbook ID against the drawing's labels and tables, pipe-length labels against the drawn runs, and — with the PDF set and eTransmit transmittal added — PDF pages, missing files and xrefs. A *Settings* sub-tab holds the decisions that belong to the surveyor or JEA: confirmed layer mappings, the self-check tolerances, which repeated row to keep, and picklists loaded from a JEA template workbook. Imports JEA's own *JEA As Built Template 2026* (one table per sheet, Pipe Crossing Table → crossings) as well as firms' titled workbooks. Lat/lon and depth checks use JEA's positional accuracy (0.5 ft / 0.1 ft, §501 II.1.7). JEA's standards set no CAD layer names, so layer notes cost no score. Also checks horizontal separation (§350 III.4.2–III.4.3), recorded points every 100 ft (§501 III.1.3), gravity run slopes (§501 IV.1.4), manhole inverts with directions (§501 III.2.6) and JEA's pump station attribute worksheet; every result is stamped with the rules it used, and crossing minimums can be set in Settings. Outputs: the workbook back with lat/lon filled from State Plane, JEA 2026 asset tables (.xlsx) from the model, a readiness report, pre-filled §501 transmittal and checklist drafts, a move-to-State-Plane script, Civil 3D zoom commands, and a batch package check. It also checks every feature against the survey shots (§501 II.1.17), published control against NGS datasheets (§501 II.1.6), PDF sheet size and signatures, and resubmittals against the previous workbook and JEA's comments; writes a fully fixed workbook copy, an overlay DXF and a submittal zip; maps the findings; and keeps a review status per finding. |
| `efbk` | Electronic Field Book | FDOT EFB point/reference naming, P/C curve geometry (3-point arc, 4+-point smooth curve, tangent-solved single-C arc), and the chain-list mini-language — builds a figures model for DXF/script export or the Linework Editor. |
| `dxf-code-file` | DXF → Code File | Reads a DXF's linework (LINE, ARC, CIRCLE, LWPOLYLINE, 2D/3D POLYLINE; optional joining of exploded LINE / ARC pieces — drawn polylines are never fused) and writes a Civil 3D survey code file (.fbk): `NEZ` points plus `FIG BEGIN/PT/CLOSE/END` figures named `LW###`, curves as PC / OC / PT points; output as the survey command script or **Autodesk Field Book** syntax (`BEG` / `NE SS` / `C3` / `END`, for Civil 3D's Import Field Book); **SCOPE layers** (any layer whose first five characters are `SCOPE`, case-insensitive — `SCOPE01`, `scope02`, …) limit the linework: a closed shape on the layer is the boundary (else its bounding box), each scope is written as its own commented block, and figures running over a limit are commented for manual editing; every figure gets its own points (coincident points allowed; sharing optional); TEXT on chosen layers becomes points; optional **elevations from the survey point file** (PNEZD), matched by position and code, each `NEZ` commented with its Z source; a **conversion report** (.txt, also saved to the Reports Hub: settings, results, items to review, figure and curve tables, survey-point accounting) and a figure table (.csv); reports every entity type it did not convert. |
| `legal-desc` | Legal Description QC | Parse metes-and-bounds, chord-trace closure, plot of the deed linework (true arcs, direction of travel, closing gap & crossings flagged), BoundaryQC QC rules, PNEZD + Map Check export. |
| `fdot-survey` | Survey & Desckeys (FDOT survey checks panel) | FDOT's published Survey Feature Codes (4/24/2025, 502 codes) to search and export; point-file codes and drawing survey levels checked against them; a survey report checked against the FDOT Surveying and Mapping Handbook (Feb 28, 2025) Appendix E format. Legal Description QC's opt-in FDOT right of way rules (handbook §31.4 parcel numbers, §31.6.2 area format) live in `legal-desc`. |
| `plss-breakdown` | PLSS Section Breakdown | Subdivide an ideal government section from an aliquot description. |
| `plat2dxf` | Parcel → DXF / Points / COGO | Bearing/distance call list → ASCII DXF, PNEZD, AutoCAD COGO script. |
| `spatial-engine` | — | Recursive Guttman R-tree 2D index + Euler-spiral (Fresnel) solver. |
| `security-pki` | — | Pure-JS FIPS 180-4 SHA-256, F.A.C. PKI/TSA gate checks, hash-chain verifier, WebAuthn (fail-closed). |
| `cms-engine` / `billing` | — | **Demo** data/auth layer (`window.BoundaryQCCMS`): PBKDF2 sign-in + sessions + per-user templates + audit chain; tier limits + ephemeral ECDSA JWTs. No UI of its own — not a security boundary; knows nothing about the optional PostgreSQL bridge (see `db-sync`). |
| `security` | Account menu (modal) | The sign-in / register modal, header account indicator, change-password, sign-out, WebAuthn. UI split out of `cms-engine`. Not the same plugin as `security-pki` (the crypto/PKI engine). |
| `dashboard` | Admin Dashboard | Client master templates, DOT projects & submittal vault, transaction ledger, team directory / user management (RBAC), hash-chained audit log viewer. UI split out of `cms-engine`; the Database panel on this tab is `db-settings`, not this plugin. |
| `db-sync` | — | `window.DatabaseService`: fetch client for the optional `server.py` PostgreSQL bridge (status, push/pull sync, linework session save/load). Translates between Postgres's column shape and `cms-engine`'s object shape — `cms-engine` itself stays storage-agnostic. |
| `db-settings` | Admin Dashboard (Database panel) | The DB connection status badge/counts, Sync-to-DB / Pull-from-DB buttons, cloud-sync JSON export, and the local/remote connection settings modal — split out of `dashboard` so it doesn't need to know how the Postgres bridge works. |
| `tables` | Tables Drawing Auditor | Audits a DXF's LAYER (and LINETYPE / STYLE) tables with no entities required — for Civil 3D "tables" drawings or DWG conversions whose geometry didn't come across. |
| `landxml` | LandXML Studio & Interop | Parse/inspect/preview LandXML 1.2/2.0 (points, parcels, alignments, surfaces); export a schema-compliant LandXML document; bridges to the Linework Editor's figures model. |
| `batchprocess` | Multi-Sheet Batch Project Auditor | Audit a batch of DXF/LandXML drawings against FDOT CADD standards at once; a submittal compliance matrix, consolidated auto-fix `.scr`, and an HTML/Markdown master scorecard. |
| `reports` | Reports Hub | Centralized store for reports generated across the suite (Standards Compare, DXF audits, batch scorecards, system logs, ...) with filtering, preview, and a master bundle export. |
| `logging` | System Diagnostics & Error Audit Hub | Centralized `window.Logging` event log (info/warn/error/debug) with source/level filtering, a live stream, and export to a `.log`/`.json` file or the Reports Hub. |
| `help` | Help & User Manual | Per-tab usage, input formats, limits. |

Reference tabs rendered directly by `core/app.js` from
`window.FDOT_DATA` (no plugin of their own): **FDOT 2026 Layer Standards**,
**Civil 3D Block Libraries**, **Pay Item Takeoff**, **Survey Description
Keys**, **Subassemblies & PKT**, **Sheet Standards & DWT**, **State Kit
Inspector**, and the **Commercial / Enterprise** demo pages. All of it is
illustrative data (see the caveat at the top).

There is also a Civil 3D C# ribbon add-in scaffold under
`plugins/civil3d-addin/` — licensing/ribbon
scaffold only; the audit routines are not included in this distribution.
Leases are honoured only when signed by the licensing server (RSA-SHA256,
public key in `LicensingPublicKeyXml` — empty here, so it fails closed) and
bound to the machine; the offline copy is stored with Windows DPAPI (the
.NET 8 build needs the `System.Security.Cryptography.ProtectedData` package).

## JavaScript API

Every plugin exposes its pure functions on a `window.<Name>` global — that is
what the test suite calls, and it is handy from the browser console on the
test site. Render / DOM code
stays private. `#name` = a class method (`new FDOTDXFInspector(window.FDOT_DATA).name(...)`).

| Global | Source | Functions |
|---|---|---|
| `PluginRegistry` | `core/loader.js` | `register`, `get`, `getAll`, `initAll`, `notifyTabActivate`, `onTabActivate`, `status` |
| `COGO` | `core/cogo.js` | `parseBearing`, `azimuthToBearing`, `advance`, `distanceBetween`, `azimuthDegBetween`, `includedAngleDeg`, `chordFromArc`, `deltaDegFromArc`, `shoelaceArea`, `signedShoelaceArea`, `circularSegmentArea`, `curveDirection`, `directionFromConcavity`, `bulge`, `normalizeDMS`, `runTraverse`, `pnezd`, `selfIntersects`, `buildDxf`, `downloadText`, `latLonToStatePlane`, `statePlaneToLatLon`, `elevationFactor`, `combinedScaleFactor`, `groundToGridDistance`, `gridToGroundDistance` |
| `setSafeHTML`, `setSafeRows`, `safeHTML`, `cleanText` | `core/safe-dom.js` | DOMPurify-backed writes with a text-only fallback |
| `FDOT_DATA` | `core/data.js` | reference data (layers, pay items, IDF zones, subassemblies, sheets, QC checklist) — illustrative |
| `FDOTDXFInspector` | `plugins/dxf-auditor/dxf-parser.js` | `#tokenizeDXF`, `#parseDXF`, `#inspectProject`, `#checkPolylineBowtie`, `#linesIntersect`, `#generateFixScript` |
| `StdnEngine` | `plugins/stdn-compare/stdn-engine.js` | `parseDxf`, `tokenize`, `checkStandards`, `diffGeometry`, `anchorPoint`, `standardFromMasterDxf`, `mergeStandards`, `checkPatternSafety`, `assertStandardPatternsAreSafe`, `DxfDocument`, `indexDocument`, `splitLines`, `normalizeDxfLines`, `healDxf`, `buildSvgOverlay`, `buildReport`, `orchestrateCompare`, `parseTolerancesField`, `defaultResolveBuiltInStandard`, `CompareError`, `buildReportModel`, `renderHtml`, `renderMarkdown`, `suggestFilename` |
| `StdnCompare` | `plugins/stdn-compare/stdn-compare.js` | `runCheck`, `runHeal`, `executeGridComparison`, `renderResultsGrid`, `loadDemoPair`, `resetGridUI`, `setTargetFile`, `setTemplateFile` |
| `SSAHydro` | `plugins/ssa-hydro/ssa-hydro.js` | `frequencyFactor`, `idfIntensity`, `rationalQ`, `trenchLength` |
| `TraverseCogo` | `plugins/traverse-cogo/traverse.js` | `parseCourses`, `computeClosure`, `buildTraverseScript` |
| `LegalDesc` | `plugins/legal-desc/legal-desc.js` | `parse`, `qc`, `mapCheckReport`, `buildSurveyScript`, `arcGeometry`, `plotGeometry` |
| `PlssBreakdown` | `plugins/plss-breakdown/plss.js` | `analyze`, `computeBox`, `analyzeParcel`, `parseFractions` |
| `LineworkEngine` | `plugins/linework/linework-engine.js` | `nz`, `tokenizeLine`, `parsePointFile`, `applyCodesetProfile`, `inSet`, `classifyToken`, `splitDesc`, `defaultLayer`, `byNum`, `circumcircle`, `fitCircle`, `resolveGeometry`, `buildFigures`, `parseCalls`, `segsProperlyCross`, `selfIntersection`, `checkModel` |
| `Linework` | `plugins/linework/linework.js` | `parsePointFile`, `buildFigures`, `parseCalls`, `checkModel`, `splitDesc`, `resolveGeometry`, `circumcircle`, `fitCircle`, `buildLineworkScript`, `applyCodesetProfile`, `exportCSV`, `exportLandXML`, `saveSession`, `loadSavedSession`, `loadSavedSessionFromDb`; editor interface for other plugins: `loadFigures`, `getFigures`, `onChange`, `redraw` (don't use `_Ed`) |
| `EFBK` | `plugins/efbk/efbk.js` | `splitPointName`, `formatPointName`, `parseStationValue`, `parseReferenceName`, `parseFeatureCode`, `parseHVDFeatureCode`, `resolveFeatureAlias`, `parseEfbRow`, `parseEfbPoints`, `splitTrailingDigits`, `resolveChainToken`, `resolveChainList`, `circleTangentThroughPoint`, `densifySmoothRun`, `resolveChainCurves`, `buildFiguresFromChains`, `flattenForExport`, `loadPreset`, `getLastModel` |
| `DxfCodeFile` | `plugins/dxf-code-file/dxf-code-file.js` | `figureName`, `readOptions`, `bulgeArc`, `entityToPath`, `tidyPath`, `reversePath`, `joinPaths`, `countEntityTypes`, `extractLinework`, `buildCodeFile`, `isScopeLayer`, `densifyPath`, `inRing`, `buildScopeLimits`, `insideLimit`, `relateToLimit`, `parseElevationFile`, `makeMatcher`, `buildReport`, `buildFigureCsv`, `surveyAccounting` |
| `Jea24` / `Jea24Data` | `plugins/tmplt-jea2024/` | `getSampleNetwork`, `buildJeaDxf`, `parseDxf`, `auditDrawing`, `resolveLayer`, `extractPipeNetwork`, `generateJeaTables`, `exportAuditReportToReports`, `syncTemplateWithDb`, `addAsClientTemplate`, `importXlsxFile`, `getSettings`, `setSettings`, `resetSettings`, `validateSettings` (+ `Jea24Data` reference data incl. `LAYER_ALIASES`) |
| `JeaXlsx` | `plugins/tmplt-jea2024/jea-xlsx.js` | `readWorkbook`, `findTables`, `workbookToModel`, `importWorkbook`, `qcStructures`, `parseDms`, `findingsToCsv`, `extractPicklists`, `pumpStationSheet`, `checkPumpStationWorksheet`, `parseDmsDetail`, `writeXlsx`, `patchWorkbook`, `fillLatLon`, `fixWorkbook`, `modelToJeaWorkbook`, `QC_DEFAULTS` |
| `JeaPackage` | `plugins/tmplt-jea2024/jea-package.js` | `collectDrawingText`, `checkSheets`, `georeference`, `reconcile`, `checkPipeLabels`, `checkPointSpacing`, `checkHorizontalSeparation`, `moveScript`, `readinessReport`, `draftSubmittalForms`, `parseShots`, `checkSurveyedPoints`, `parseNgsDatasheet`, `checkPublishedControl`, `compareSubmittals`, `overlayModel`, `packageZip`, `pdfPageCount`, `parseTransmittal`, `checkPackageFiles`, `cleanMText`, `normId`, `SHEET_FIELDS` |
| `FdotSurvey` / `FdotFeatureCodes` | `plugins/fdot-survey/` | `lookup`, `search`, `checkPointCodes`, `checkSurveyLevels`, `checkFdotLayerNames`, `checkSurveyReport`, `docxText`, `REPORT_ITEMS` (+ `FdotFeatureCodes.rows`: FDOT's 4/24/2025 list) |
| `Materials` / `MaterialsData` | `plugins/materials/` | `jeaMaterialGroups`, `jeaSizeRows`, `sizeRows`, `nominalToDN`, `inToMm`, `formatNominal`, `filterRows`, `toCsv` (+ `MaterialsData`: `DN`, `SIZE_SYSTEMS`, `PIPE_SYSTEMS`, `APPURTENANCES`, `FITTINGS`) |
| `PipeCrossings` | `plugins/pipe-crossings/` | `findCrossings`, `TOP_CALCS`, `WALLS`, `DI_CLASS`, `parseMaterial`, `wallThickness`, `outsideDiameter`, `sizeToken`, `estimateGrade`, `columns`, `tableRows`, `toCsv`, `boxDrawing`, `crossingAttribs` |
| `DxfTemplate` | `plugins/dxf-template/` | `readTemplate` (layers, symbols with ATTDEFs, version, handles), `rank`, `attribValues`, `writeInto` (POLYLINE 2D/3D, INSERT + ATTRIB, POINT, TEXT; new layers; handles / owners / subclass markers / $HANDSEED in R2000+), `verify` |
| `EasyEngine` / `EasyButton` | `plugins/easy-button/` | `OUR_CODES`, `parseCsv`, `parseCodeList`, `suggest`, `controlClash`, `mappingOf`, `translateDesc`, `buildFromField`, `translatedPnezd`, `ourCodesCsv`, `mappingCsv`, `makeProfile`, `rowsFromProfile`, `templateMapFromProfile`, `codesInUse`, `suggestTemplateMap`, `figurePoints`, `drawingFromBuild` (step 5's UI is `easy-crossings-ui.js` → `EasyCrossingsUI.create`) |
| `SubdivisionEngine` / `Subdivision` | `plugins/subdivision/` | `parseBoundary`, `recommended`, `validate`, `layout`, `bestLots`, `maxLots`, `pondAreaRequired`, `roadPosAt`, `PRESETS`, `applyPreset`, `toDxf`, `toPdf`, `toLandXml` (+ `area`, `clip`, `clipConvex`, `mergePieces`, `lineIntervals`, `apportion`) |
| `Overlay` | `plugins/overlay/` | `toLonLat`, `fromLonLat` (cs = `{zone, unit}`), `tilesForView`, `tileMatrix`, `tileUrl`, `chooseZoom`, `inZone`, `render` (+ `ZONES`, `UNITS`, `BASEMAPS`); zone data in `overlay-zones.js`, regenerated by `scripts/gen_overlay_zones.py` |
| `DxfAuditor` | `plugins/dxf-auditor/dxf-auditor.js` | `scoreBand`, `buildAuditLog`, `entityExtents`, `fitTransform`, `entityStyle` |
| `LayerStds` | `plugins/layer-stds/layer-stds.js` | `filterLayers`, `filterPayItems`, `filterSurveyKeys` |
| `Plat2Dxf` | `plugins/plat2dxf/plat2dxf.js` | `SAMPLE_CALLS`, `parseCalls`, `build`, `toDxf`, `toCogoScript` |
| `Tables` | `plugins/tables/tables.js` | `auditTables`, `getSampleTablesDxf`, `exportToReports`, `getLastResult` |
| `LandXML` | `plugins/landxml/landxml.js` | `parseLandXML`, `buildLandXML`, `toFiguresModel`, `fromFiguresModel`, `sampleLandXML`, `getLastParsed` |
| `BatchProcess` | `plugins/batchprocess/batchprocess.js` | `auditSingleFile`, `auditBatch`, `generateBatchFixScript`, `generateMasterReport`, `getDemoProjectBatch`, `getLastResult` |
| `Reports` | `plugins/reports/reports.js` | `addReport`, `getReports`, `getReport`, `deleteReport`, `clearAll`, `exportReport`, `downloadBundle`, `formatUnifiedHeader` |
| `Logging` | `plugins/logging/logging.js` | `log`, `info`, `warn`, `error`, `debug`, `getLogs`, `clearLogs`, `getStats`, `exportLogs`, `exportToReportsHub`, `subscribe` |
| `BoundaryQCWASM` | `plugins/spatial-engine/spatial.js` | `processDXFSpatialStream`, `queryViewportSpatial`, `solveSpiralFresnel` |
| `BoundaryQCSecurity` | `plugins/security-pki/security-pki.js` | `computeSHA256`, `computeTextSHA256`, `computeTextSHA256Sync`, `sanitizeInput`, `sanitizeString`, `generateFDOTSubmittalManifest`, `verifyPKICertificate`, `verifyRFC3161Timestamp`, `verifyAuditHashChain`, `authenticateHardwareToken`, `getPrivacyDiagnostics`, `generateSubmittalCertificate` |
| `BoundaryQCCMS` *(demo)* | `plugins/cms-engine/cms-engine.js` | users & sessions (`registerUser`, `loginUser`, `logoutUser`, `changePassword`, `impersonate`, `getCurrentUser`, `isAuthenticated`, `getUsers`, `deleteUser`, `updateUserRole`), client templates (`getTemplates`, `createTemplate`, `updateTemplate`, `deleteTemplate`, `getActiveTemplate`, `setActiveTemplate`, `getActiveTemplateId`, `getActiveTemplateSetting`, `getTemplateLimit`, `getTemplateUpgrade`), projects & submittals (`getProjects`, `createProject`, `getSubmittals`, `addSubmittal`), ledger (`getTransactions`, `recordTransaction`, `processStripeWebhook`), audit chain (`addAuditLog`, `getAuditLogs`, `verifyAuditIntegrity`, `replaceAuditChain`), sync (`initStorageDefaults`, `getOrganizations`, `generateCloudSyncPayload`, `mergeOrganizations`, `mergeProjects`, `mergeTemplates`, `mergeSubmittals`, `mergeTransactions`, `mergeUsers`) |
| `BoundaryQCBilling` *(demo)* | `plugins/billing/billing.js` | `getLimits`, `getTemplateLimit`, `nextTierForTemplates`, `assertSeatAvailable`, `setTier`, `getStripeConfig`, `saveStripeConfig`, `getSubscription`, `saveSubscription`, `cancelSubscription`, `processCheckout`, `generateEntitlementJwt`, `getActiveJwt`, `isFeatureAllowed`, `updateUIForTier` |
| `Security` | `plugins/security/security.js` | `openModal`, `closeModal`, `renderHeader`, `refreshAll`, `impersonate` |
| `Dashboard` | `plugins/dashboard/dashboard.js` | `render`, `renderTemplates` |
| `DatabaseService` | `plugins/db-sync/db-sync.js` | `getStatus`, `getLastStatus`, `configureDatabase`, `syncToDatabase`, `pullFromDatabase`, `saveLinework`, `loadLinework`, `ensureToken`, `getAuthHeaders`, `onStatusChange` (needs the local `server.py` bridge — not available on the public site) |
| `DbSettings` | `plugins/db-settings/db-settings.js` | `refresh`, `renderStatus`, `configure` |

## Deploy

`.github/workflows/pages.yml` runs the test
suite on every push to `master`, then — **only when the repo variable
`DEPLOY_PAGES` is `true`** — packages the static site and force-pushes it as a
single commit to the public repo
`band72/fdot-civil3d-site`,
which serves it with GitHub Pages at <https://band72.github.io/fdot-civil3d-site/>.
This lets the source repo stay private. The push authenticates with the
`SITE_DEPLOY_KEY` secret (an SSH deploy key with write access on the site repo).

The deploy also stamps `core/build-info.js` with `publicBuild: true`, the version,
commit and build time — the public build hides every `data-demo` element (demo
sign-in, checkout, Commercial / Enterprise / Admin Dashboard) and shows the build
in the footer — and adds `deploy/site-repo/`: the site repo's own
README and the tester **Report a problem** issue form the footer links to.
Release notes: `CHANGELOG.md`.

## Contributing

- Match the surrounding style: vanilla ES, IIFE per plugin, `setSafeHTML`
  for every dynamic write, `window.COGO` for geometry.
- Add a suite (or extend one) in `tests/` for anything with logic; wire
  new suites into `tests/run.js`'s `SUITES` and `tests/_env.js`'s file
  list. A suite that needs infrastructure `npm test` can't assume (a
  server, a database, network) goes in `OPTIONAL_SUITES` instead, with its
  own opt-in `npm run test:<name>` script — see `db`/`test:db`.
- Plugin names are ≤ 15 characters (`core/loader.js` rejects longer).
- Keep coverage floors passing (`npm run test:coverage`, `npm run test:e2e:tools`);
  raise a floor when a file's coverage improves — never lower one.
- Demo-only UI carries `data-demo` (removed on the public site); every
  visible control needs an accessible name; load nothing from a third-party
  origin — `tests/e2e-site.js` checks all three.
- Never present an invented value: missing input is an error or "not
  provided", never a plausible default.
