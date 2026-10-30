/**
 * JEA As-Built workbook (.xlsx) reader.
 *
 * Reads the JEA As-Built Excel template (sheets such as PG-1…PG-4, WATER, SEWER — each holding
 * titled detail tables: MANHOLE DETAIL, WATER VALVE DETAIL, WATER HYDRANTS, WATER METER BOXES,
 * WATER LOCATE WIRE BOX, WATER FITTING, SEWER FITTING) and maps the rows to the Jea24 network
 * model ({ structures: [...] }) so they can be built to DXF or audited like any other input.
 *
 * No dependencies: a minimal ZIP reader (DecompressionStream "deflate-raw") + regex XML scan of
 * the handful of SpreadsheetML parts needed. Pure functions only; the UI lives in tmplt-jea2024.js.
 */
(function () {
    "use strict";

    // ── ZIP ──────────────────────────────────────────────────────────────
    async function inflateRaw(bytes) {
        if (typeof DecompressionStream !== "function") throw new Error("This browser cannot decompress .xlsx files (no DecompressionStream).");
        const ds = new DecompressionStream("deflate-raw");
        const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
        return new Uint8Array(await out.arrayBuffer());
    }

    /** Returns { [entryName]: () => Promise<string> } for every entry of a zip. */
    function openZip(buf) {
        const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let eocd = -1;
        for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error("Not a valid .xlsx file (zip directory not found).");
        const count = dv.getUint16(eocd + 10, true);
        let p = dv.getUint32(eocd + 16, true);
        const dec = new TextDecoder("utf-8");
        const entries = {};
        for (let k = 0; k < count; k++) {
            if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Corrupt .xlsx file (bad zip directory).");
            const method = dv.getUint16(p + 10, true);
            const csize = dv.getUint32(p + 20, true);
            const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
            const lho = dv.getUint32(p + 42, true);
            const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
            const bytes = async () => {
                const dataStart = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
                const raw = u8.subarray(dataStart, dataStart + csize);
                if (method === 0) return raw;
                if (method === 8) return inflateRaw(raw);
                throw new Error("Unsupported zip compression method " + method + ".");
            };
            entries[name] = async () => dec.decode(await bytes());
            entries[name].bytes = bytes; // the entry as bytes (images, printer settings…)
            p += 46 + nlen + xlen + clen;
        }
        return entries;
    }

    // ── SpreadsheetML ────────────────────────────────────────────────────
    function unesc(s) {
        return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
            .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
            .replace(/&amp;/g, "&");
    }

    function textOf(xml) {
        const noPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
        let s = "";
        noPhonetic.replace(/<t\b[^>]*>([\s\S]*?)<\/t>/g, (m, t) => { s += t; return m; });
        return unesc(s);
    }

    function colIndex(ref) {
        const letters = ref.match(/^[A-Z]+/)[0];
        let n = 0;
        for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
        return n - 1;
    }

    function parseSharedStrings(xml) {
        const out = [];
        xml.replace(/<si\b[^>]*>([\s\S]*?)<\/si>/g, (m, si) => { out.push(textOf(si)); return m; });
        return out;
    }

    /** Sheet XML → array of rows; each row is a sparse array of cell values (string | number). */
    function parseSheet(xml, shared) {
        const rows = [];
        xml.replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, (m, attrs, body) => {
            if (body == null) return m;
            const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
            if (!ref) return m;
            const type = (/\bt="([^"]*)"/.exec(attrs) || [])[1];
            let val = null;
            if (type === "inlineStr") {
                val = textOf(body);
            } else {
                const v = /<v>([\s\S]*?)<\/v>/.exec(body);
                if (!v) return m;
                if (type === "s") val = shared[+v[1]];
                else if (type === "str" || type === "e") val = unesc(v[1]);
                else if (type === "b") val = v[1] === "1";
                else val = Number(v[1]);
            }
            if (val === null || val === undefined || val === "") return m;
            const r = +ref[2] - 1;
            (rows[r] = rows[r] || [])[colIndex(ref[1])] = val;
            return m;
        });
        return rows;
    }

    /** ArrayBuffer of an .xlsx → { sheets: [{ name, rows }] } (rows is sparse). */
    async function readWorkbook(buf) {
        const zip = openZip(buf);
        if (!zip["xl/workbook.xml"]) throw new Error("Not an Excel workbook (xl/workbook.xml missing).");
        const wb = await zip["xl/workbook.xml"]();
        const rels = zip["xl/_rels/workbook.xml.rels"] ? await zip["xl/_rels/workbook.xml.rels"]() : "";
        const relTarget = {};
        rels.replace(/<Relationship\b([^>]*)\/?>/g, (m, a) => {
            const id = /\bId="([^"]*)"/.exec(a), tg = /\bTarget="([^"]*)"/.exec(a);
            if (id && tg) relTarget[id[1]] = tg[1];
            return m;
        });
        const shared = zip["xl/sharedStrings.xml"] ? parseSharedStrings(await zip["xl/sharedStrings.xml"]()) : [];
        const sheets = [];
        const refs = [];
        wb.replace(/<sheet\b([^>]*)\/?>/g, (m, a) => {
            const name = /\bname="([^"]*)"/.exec(a), rid = /\br:id="([^"]*)"/.exec(a);
            if (name && rid) refs.push({ name: unesc(name[1]), rid: rid[1] });
            return m;
        });
        for (const s of refs) {
            let target = relTarget[s.rid];
            if (!target) continue;
            target = target.replace(/^\//, "");
            const path = target.startsWith("xl/") ? target : "xl/" + target;
            if (!zip[path]) continue;
            sheets.push({ name: s.name, path, rows: parseSheet(await zip[path](), shared) });
        }
        return { sheets };
    }

    // ── Table detection ──────────────────────────────────────────────────
    const norm = v => String(v == null ? "" : v).replace(/\s+/g, " ").trim().toUpperCase();

    /** "19.07'" → 19.07, "20.3 BASE PLATE" → 20.3, "6X4" → null. */
    function num(v) {
        if (typeof v === "number") return isFinite(v) ? v : null;
        const m = /^\s*(-?\d*\.?\d+)\s*(?:'|"|FT|IN)?\s*(?:[A-Z ]*)$/i.exec(String(v == null ? "" : v));
        return m ? parseFloat(m[1]) : null;
    }
    const r4 = n => String(Math.round(n * 10000) / 10000);

    // header text → field key (first column to claim a key wins)
    // Header wording from firms' own as-built workbooks ("NUMBER", "TOP PIPE ELEVATION(FT)") and from
    // JEA's As Built Template 2026 ("Valve Number (WV#)", "Valve Nut Elevation (Feet)", "Latitude
    // (Decimal Degrees)", one table per sheet). First matching rule wins, first column claims a key.
    const FIELD_RULES = [
        ["id", /^(?:[A-Z&/ ]+ )?NUMBER(?: \(.*\))?$/],
        ["subtype", /(?:^| )SUB ?TYPE$/],
        ["type", /^(?:(?:VALVE|MANHOLE) )?TYPE$/],
        ["owner", /^FACILT?I?TY OWNER$/],
        ["northing", /NORTHING/],
        ["easting", /EASTING/],
        ["lat", /^LATITUDE\b/],
        ["lon", /^LONGITUDE\b/],
        ["rim", /^RIM ELEV/],
        ["invertDirs", /^INVERT ELEVATIONS? .*DIRECTION/],
        ["invertLow", /^LOWEST INVERT/],
        ["invert", /^INVERT ELEV/],
        ["upType", /^UPPER PIPE TYPE$/], ["upSize", /^UPPER PIPE SIZE/], ["upTop", /^UPPER PIPE TOP ELEV/], ["upBot", /^UPPER PIPE BOTTOM ELEV/],
        ["loType", /^LOWER PIPE TYPE$/], ["loSize", /^LOWER PIPE SIZE/], ["loTop", /^LOWER PIPE TOP ELEV/], ["sep", /^SEPARATION BETWEEN PIPES/],
        ["runLen", /^(?:PIPE RUN|MEASURED) LENGTH/], ["dnInv", /^DOWNSTREAM PIPE INVERT/], ["dnGrade", /^DOWNSTREAM GRADE/],
        ["upInv", /^UPSTREAM PIPE INVERT/], ["upGrade", /^UPSTREAM GRADE/], ["slope", /^SLOPE\b/],
        ["pipeTop", /^(?:PIPE TOP|TOP OF PIPE) ELEVATION/], ["cover", /^(?:PIPE COVER|DEPTH OF COVER)/], ["pipeLoc", /^PIPE LOCATION$/],
        ["topPipe", /^TOP PIPE ELEV/],
        ["finalGrade", /^FINAL GRADE( ELEV\w*)?(\(FT\))?$/],
        ["utilTop", /^UTILITY TOP ELEV/],
        ["utilSize", /^UTILITY SIZE/],
        ["topElev", /^(?:TOP ELEVATION|FITTING TOP ELEVATION|VALVE NUT ELEVATION)\b/],
        ["gradeElev", /^(?:FINISHED )?GRADE ELEVATION\b/],
        ["depth", /^(?:FITTING )?DEPTH(?: \(FEET\))?$|^DEPTH TO NUT/],
        ["size", /^(?:FITTING |VALVE |MANHOLE |PIPE |PROPOSED METER )?SIZE(?: PRIMARY)?(?: ?\(?(?:FT|IN|INCHES|FEET)\)?)?$/],
        ["size2", /SIZE SECONDARY/],
        ["openDir", /OPEN DIRECTION/],
        ["turns", /^TURNS (?:REQUIRED|TO OPEN)/],
        ["material", /^(?:FITTING |MANHOLE |METER BOX )?MATERIAL$/],
        ["lining", /^(?:MANHOLE )?LINING MATERIAL$/],
        ["liningMfr", /^(?:MANHOLE )?LINING MANUFACTURER$/],
        ["mfr", /^(?:MANUFACTURER|MANUFACTURE|SUPPLIER|VALVE MANUFACTURER|HYDRANT MANUFACTURER|MANUFACTURER OR SUPPLIER|METER BOX MANUFACTURER\/SUPPLIER)$/],
        ["mfrYear", /^(?:MANUFACTURE YEAR|HYDRANT MANUFACTURE DATE)/],
        ["trunk", /^TRUNK$/],
        ["drop", /^DROP$/]
    ];

    function mapHeader(row) {
        const cols = {};
        row.forEach((h, i) => {
            const t = norm(h);
            if (!t) return;
            for (const [key, re] of FIELD_RULES) {
                if (re.test(t) && cols[key] === undefined) { cols[key] = i; break; }
            }
        });
        return cols;
    }

    const isHeader = row => row && /^(?:[A-Z&/ ]+ )?NUMBER(?: \(.*\))?$/.test(norm(row[0])) && row.filter(c => c != null && c !== "").length >= 4;
    const filled = row => (row || []).filter(c => c != null && c !== "").length;

    /** Section title → kind. */
    function kindFromTitle(t) {
        if (/CROSSING/.test(t)) return "crossing";
        if (/POINTS? ALONG PIPE/.test(t)) return "pipepoint";   // pipe points / runs: not structures
        if (/PIPE RUN/.test(t)) return "piperun";
        if (/MANHOLE/.test(t)) return "manhole";
        if (/VALVE/.test(t) && !/BOX/.test(t)) return "valve";
        if (/HYDRANT/.test(t)) return "hydrant";
        if (/METER/.test(t)) return "meter";
        if (/LOCATE|WIRE BOX/.test(t)) return "locate";
        if (/FITTING/.test(t)) return "fitting";
        return null;
    }

    /** Row-level kind override (sewer fitting tables mix manholes/valves/wire boxes in one list). */
    function kindFromRow(kind, st) {
        if (kind !== "fitting") return kind;
        if (/MAN ?HOLE/.test(st)) return "manhole";
        if (/WIRE BOX|LOCATE/.test(st)) return "locate";
        if (/VALVE|GATE/.test(st)) return "valve";
        return "fitting";
    }

    /**
     * Walks a sheet and returns its tables: [{ title, status, kind, header: cols, rows: [{ r, cells }] }].
     * A table is a header row (A = NUMBER) plus the rows below it until a blank row or a new
     * single-cell title row. The nearest title above a header names the table.
     */
    function findTables(sheet) {
        const tables = [];
        // JEA's 2026 template has one table per sheet, named for it ("WW Valve", "Pipe Crossing Table").
        let title = kindFromTitle(norm(sheet.name)) ? norm(sheet.name) : "", status = "";
        const rows = sheet.rows;
        for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            if (!row || !filled(row)) continue;
            if (isHeader(row)) {
                const t = { title, status, sheet: sheet.name, kind: kindFromTitle(title), cols: mapHeader(row), headerRow: r + 1, rows: [] };
                let q = r + 1;
                for (; q < rows.length; q++) {
                    const d = rows[q];
                    if (!d || !filled(d) || isHeader(d)) break;
                    if (filled(d) === 1 && typeof d[0] === "string" && kindFromTitle(norm(d[0])) !== null && !/^[A-Z]{1,4}-?\d/.test(norm(d[0]))) break;
                    t.rows.push({ r: q + 1, cells: d });
                }
                if (/EXISTING/.test(title)) t.status = "EXISTING";
                else if (/INSTALLED|PROPOSED/.test(title)) t.status = "INSTALLED";
                tables.push(t);
                title = ""; // a table with no title of its own must not inherit the previous one
                r = q - 1;
                continue;
            }
            if (filled(row) === 1 && typeof row[0] === "string") {
                const t = norm(row[0]);
                if (t === "EXISTING" || t === "INSTALLED" || t === "PROPOSED") status = t;
                else title = t;
            }
        }
        return tables;
    }

    // ── Rows → Jea24 model ───────────────────────────────────────────────
    /**
     * @param {{sheets:Array}} workbook  from readWorkbook()
     * @param {object} [opts]  { domains, bounds, includeExisting (default true), projectName, county,
     *                            duplicates: "first" (default) | "last" — which row of a repeated ID is kept, qc }
     * @returns {{ model, findings, warnings: string[], stats }}
     *   findings: [{ severity: "error"|"warning"|"info", rule, id, where, message }] — import problems
     *   plus the workbook self-check (qcStructures); warnings is the same list as plain strings.
     */
    function workbookToModel(workbook, opts) {
        opts = opts || {};
        const DOM = opts.domains || {};
        const B = opts.bounds || null;
        const findings = [];
        // JEA 2026 template: "Use -999 if not applicable" (Turns to Open, Depth to Nut) — never a value.
        const nv = v => { const x = num(v); return x === -999 ? null : x; };
        const flag = (severity, rule, id, where, message) => findings.push({ severity, rule, id, where, message });
        const policy = opts.duplicates === undefined ? "first" : opts.duplicates;
        if (policy !== "first" && policy !== "last") throw new Error(`duplicates must be "first" or "last", not "${policy}".`);
        const structures = [];
        const seen = new Map();
        const stats = { tables: 0, rows: 0, imported: 0, duplicates: 0, skipped: 0, notImported: 0, byKind: {} };
        const crossings = [], runs = [], pipePoints = [];

        // Case-insensitive match to a picklist entry ("COLLECTION" → "Collection"); else tidy-case.
        const pick = (domainKey, v) => {
            if (v == null || v === "") return "";
            const s = String(v).trim();
            const list = DOM[domainKey] || [];
            const hit = list.find(x => String(x).trim().toLowerCase() === s.toLowerCase());
            return hit !== undefined ? String(hit) : s;
        };
        const sizeStr = v => {
            if (v == null || v === "") return "";
            const n = num(v);
            return n != null ? String(n) : String(v).trim();
        };

        for (const sheet of workbook.sheets) {
            // JEA's template carries reference sheets alongside the tables; they hold no asset data.
            if (/^(?:INSTRUCTIONS|VERSION HISTORY|VALIDATION (?:RULES|LISTS)|DOCUMENTATION|JEA ONLY\b|AS BUILT INFO)/i.test(sheet.name.trim())) continue;
            const sewerSheet = /SEWER|^SS|^WW\b|MANHOLE/i.test(sheet.name);
            for (const tbl of findTables(sheet)) {
                stats.tables++;
                if (opts.includeExisting === false && tbl.status === "EXISTING") continue;
                const c = tbl.cols;
                const at = (cells, k) => (c[k] === undefined ? undefined : cells[c[k]]);
                const sewerTable = sewerSheet || /SEWER|MANHOLE/.test(tbl.title);
                const sys = /RECLAIM/i.test(sheet.name + " " + tbl.title) ? "Reclaimed" : /CHILL/i.test(sheet.name + " " + tbl.title) ? "Chilled" : sewerTable ? "Sewer" : "Water";
                if (tbl.kind === "piperun") {
                    // Pipe runs aren't structures. A gravity run carries its inverts, length and slope, which
                    // must agree (JEA Standards 2026 §501 IV.1.4); the run is kept for the record.
                    tbl.rows.forEach(({ r, cells }) => {
                        const id = String(at(cells, "id") == null ? "" : at(cells, "id")).trim();
                        if (!id) return;
                        stats.notImported++;
                        const where = `${sheet.name}!A${r}`;
                        const L = nv(at(cells, "runLen")), up = nv(at(cells, "upInv")), dn = nv(at(cells, "dnInv")), sl = nv(at(cells, "slope"));
                        const ug = nv(at(cells, "upGrade")), dg = nv(at(cells, "dnGrade"));
                        runs.push({ id, sheet: sheet.name, row: r, system: sys, length: L, upInvert: up, downInvert: dn, slopePct: sl });
                        if (L != null && L <= 0) flag("error", "Pipe run length", id, where, `length ${L} ft — a run must be longer than 0.`);
                        if (up != null && dn != null && up < dn - 1e-9) flag("warning", "Gravity run runs uphill", id, where, `upstream invert ${up} is below downstream invert ${dn}.`);
                        if (up != null && ug != null && ug < up) flag("warning", "Invert above grade", id, where, `upstream invert ${up} is above its grade ${ug}.`);
                        if (dn != null && dg != null && dg < dn) flag("warning", "Invert above grade", id, where, `downstream invert ${dn} is above its grade ${dg}.`);
                        if (L > 0 && up != null && dn != null && sl != null) {
                            const calc = (up - dn) / L * 100;
                            const dec = (String(at(cells, "slope")).split(".")[1] || "").length;
                            const tol = Math.max(0.01, 0.5 * Math.pow(10, -dec)) + 1e-9;
                            if (Math.abs(calc - sl) > tol) {
                                flag("warning", "Slope doesn't match", id, where, `(${up} − ${dn}) ÷ ${L} ft = ${calc.toFixed(2)}%, but the table says ${sl}% (§501 IV.1.4).`);
                            }
                        }
                    });
                    continue;
                }
                if (tbl.kind === "pipepoint") {
                    // Points along pipe (points of connection, top of pipe every ≤100 ft — §501 III.1.3) are
                    // not structures; they're kept for the spacing check and checked like other points.
                    tbl.rows.forEach(({ r, cells }) => {
                        const id = String(at(cells, "id") == null ? "" : at(cells, "id")).trim();
                        if (!id) return;
                        stats.notImported++;
                        const n = nv(at(cells, "northing")), e = nv(at(cells, "easting"));
                        if (n == null || e == null) { flag("error", "Missing coordinates", id, `${sheet.name}!A${r}`, "no usable northing/easting."); return; }
                        const top = nv(at(cells, "pipeTop")), grade = nv(at(cells, "gradeElev")), cover = nv(at(cells, "cover"));
                        const src = { sheet: sheet.name, row: r, system: sys, location: at(cells, "pipeLoc") != null ? String(at(cells, "pipeLoc")).trim() : "" };
                        if (at(cells, "lat")) src.lat = String(at(cells, "lat"));
                        if (at(cells, "lon")) src.lon = String(at(cells, "lon"));
                        if (top != null && grade != null && cover != null) Object.assign(src, { top, grade, depth: cover });
                        pipePoints.push({ id, kind: "pipepoint", e, n, z: top, attribs: {}, source: src });
                    });
                    continue;
                }

                for (const { r, cells } of tbl.rows) {
                    const id = String(at(cells, "id") == null ? "" : at(cells, "id")).trim();
                    if (!id) continue;
                    stats.rows++;
                    const where = `${sheet.name}!A${r}`;
                    const typeTxt = norm(at(cells, "type"));
                    const subTxt = norm(at(cells, "subtype"));

                    let kind = tbl.kind;
                    if (!kind) {
                        // Untitled table (e.g. PG-1 "WS1 WATER VALVE / TEE"): decide from the TYPE column.
                        kind = /VALVE/.test(typeTxt) ? "valve" : /HYDRANT/.test(typeTxt) ? "hydrant" : /MAN ?HOLE/.test(typeTxt) ? "manhole" : "fitting";
                    }
                    kind = kindFromRow(kind, subTxt + " " + typeTxt);

                    const n = nv(at(cells, "northing")), e = nv(at(cells, "easting"));
                    if (n == null || e == null) {
                        flag("error", "Missing coordinates", id, where, "no usable northing/easting — skipped.");
                        stats.skipped++;
                        continue;
                    }
                    if (B && (e < B.eastingMin || e > B.eastingMax || n < B.northingMin || n > B.northingMax)) {
                        flag("error", "Outside FL East bounds", id, where, `coordinate (E ${e}, N ${n}) is outside the Florida East bounds — check for a typo.`);
                    }

                    if (kind === "crossing") {
                        // JEA Pipe Crossing Table row → a JEA_CROSSING, checked against §350 here too.
                        const up = nv(at(cells, "upBot")), lo = nv(at(cells, "loTop")), sep = nv(at(cells, "sep"));
                        const ca = {
                            CROSS_NO: id, UPPER_TYPE: pick("Crossing Pipe Type", at(cells, "upType")), UPPER_SIZE: sizeStr(at(cells, "upSize")),
                            UPPER_BOT_ELEV: up != null ? r4(up) : "", LOWER_TYPE: pick("Crossing Pipe Type", at(cells, "loType")),
                            LOWER_SIZE: sizeStr(at(cells, "loSize")), LOWER_TOP_ELEV: lo != null ? r4(lo) : "", SEPARATION_FT: sep != null ? r4(sep) : ""
                        };
                        const clr = up != null && lo != null ? (up - lo) * 12 : sep != null ? sep * 12 : null;
                        if (clr != null) ca.CLEARANCE_INCHES = clr.toFixed(1);
                        if (up != null && lo != null && sep != null && Math.abs(up - lo - sep) > 0.1) {
                            flag("warning", "Crossing separation doesn't add up", id, where, `upper bottom ${up} − lower top ${lo} = ${(up - lo).toFixed(2)} ft, but the table says ${sep} ft.`);
                        }
                        const R = typeof window !== "undefined" && window.Jea24Data && window.Jea24Data.crossingRequirement;
                        if (R && clr != null) {
                            const req = R(ca.UPPER_TYPE, ca.LOWER_TYPE);
                            if (req.applies && clr < req.minInches - 1e-9) {
                                flag("error", "JEA crossing separation", id, where, `${clr.toFixed(1)} in with the water main ${req.waterAbove ? "above" : "below"}: at least ${req.minInches} in is required (${req.source}, ${req.rule}).`);
                            }
                        }
                        Object.keys(ca).forEach(k => { if (ca[k] === "" || ca[k] === undefined) delete ca[k]; });
                        crossings.push({ id, block: "JEA_CROSSING", layer: "UTIL-CROSS", e, n, z: up, attribs: ca, source: { sheet: sheet.name, row: r, status: tbl.status || "" } });
                        stats.imported++;
                        stats.byKind.JEA_CROSSING = (stats.byKind.JEA_CROSSING || 0) + 1;
                        continue;
                    }

                    // A number cell that also holds words ("20.3 BASE PLATE") is read as its number; say so.
                    for (const k of ["rim", "invert", "topPipe", "finalGrade", "utilTop", "topElev", "gradeElev", "depth", "northing", "easting"]) {
                        const v = at(cells, k);
                        if (typeof v === "string" && /[A-Z]{2,}/i.test(v.replace(/\b(FT|IN)\b/gi, "")) && num(v) != null) {
                            flag("info", "Text in a number cell", id, where, `"${v}" (${k}) was read as ${num(v)}.`);
                        }
                    }

                    const owner = at(cells, "owner");
                    const a = {};
                    let block, layer, z = null, invertsList = null;
                    const sizeV = at(cells, "size") !== undefined ? at(cells, "size") : at(cells, "utilSize");

                    if (kind === "manhole") {
                        block = "JEA_MANHOLE"; layer = "SS-MANH";
                        const rim = nv(at(cells, "rim"));
                        const invLow = nv(at(cells, "invertLow")), inv = invLow != null ? invLow : nv(at(cells, "invert"));
                        z = rim != null ? rim : nv(at(cells, "gradeElev"));
                        a.SUBTYPE = pick("Subtype Manhole", at(cells, "subtype") || "Collection");
                        if (z != null) a.RIM_ELEV = r4(z);
                        // The workbook records one invert; it is written as INVERT_OUT (the field the audit requires).
                        // Tables with no invert column leave it blank so the audit flags it rather than inventing one.
                        if (inv != null) a.INVERT_OUT = r4(inv);
                        if (z != null && inv != null) a.DEPTH = r4(z - inv);
                        // "Invert Elevations (Feet) with Directions" — every invert with its direction (§501 III.2.6)
                        const dirsTxt = at(cells, "invertDirs");
                        if (dirsTxt != null && String(dirsTxt).trim()) {
                            const t = String(dirsTxt).toUpperCase();
                            const withDir = [], re = /\b(NE|NW|SE|SW|N|E|S|W|NORTH|SOUTH|EAST|WEST)\b\s*[:=-]?\s*(?:INV\.?\s*)?(-?\d+(?:\.\d+)?)/g;
                            let m;
                            while ((m = re.exec(t))) withDir.push({ dir: m[1], z: Number(m[2]) });
                            const allNums = (t.match(/-?\d+(?:\.\d+)?/g) || []).length;
                            if (!withDir.length) flag("warning", "Manhole inverts", id, where, `"${dirsTxt}" — no invert with a direction (N, E, S, W…) could be read (§501 III.2.6).`);
                            else {
                                if (allNums > withDir.length) flag("warning", "Manhole inverts", id, where, `"${dirsTxt}" — ${allNums - withDir.length} invert(s) without a direction (§501 III.2.6 asks for the direction of each invert).`);
                                const low = Math.min(...withDir.map(w => w.z));
                                if (invLow != null && Math.abs(low - invLow) > 0.005) flag("warning", "Manhole inverts", id, where, `the lowest of "${dirsTxt}" is ${low}, but Lowest Invert Elevation says ${invLow}.`);
                                if (rim != null && withDir.some(w => w.z > rim)) flag("warning", "Manhole inverts", id, where, `an invert in "${dirsTxt}" is above the rim (${rim}).`);
                                invertsList = withDir;
                            }
                        }
                        a.DIAMETER = sizeStr(sizeV);
                        a.MATERIAL = pick("Manhole Material", at(cells, "material"));
                        a.MANUFACTURER = pick("Manhole Manufacturer", at(cells, "mfr"));
                        a.LINING = pick("Manhole Lining Material", at(cells, "lining"));
                    } else if (kind === "valve") {
                        block = "JEA_VALVE"; layer = sys === "Reclaimed" ? "RW-VALV" : sewerTable ? "SS-VALV" : "W-VALV";
                        z = nv(at(cells, "topPipe") !== undefined ? at(cells, "topPipe") : at(cells, "topElev"));
                        a.SUBTYPE = "Valve";
                        const vt = at(cells, "subtype") || at(cells, "type");
                        if (vt) a.VALVE_TYPE = pick("Valve Type", String(vt).trim());
                        a.SIZE = sizeStr(sizeV);
                        a.MATERIAL = pick("Pipe and Fitting Material", at(cells, "material"));
                        a.MANUFACTURER = pick("Valve Manufacturer", at(cells, "mfr"));
                        if (at(cells, "openDir")) a.OPEN_DIR = pick("Valve Open Direction", at(cells, "openDir"));
                        if (z != null) a.ELEVATION = r4(z);
                    } else if (kind === "hydrant") {
                        block = "JEA_HYDRANT"; layer = sys === "Reclaimed" ? "RW-HYDR" : "W-HYDR";
                        z = nv(at(cells, "finalGrade"));
                        a.SUBTYPE = "Hydrant";
                        a.MANUFACTURER = pick("Valve Manufacturer", at(cells, "mfr"));
                        a.VALVE_SIZE = sizeStr(sizeV);
                        if (z != null) a.ELEVATION = r4(z);
                    } else if (kind === "meter") {
                        block = "JEA_METER"; layer = sys === "Reclaimed" ? "RW-METR" : sewerTable ? "SS-METR" : "W-METR";
                        z = nv(at(cells, "finalGrade"));
                        a.SUBTYPE = pick("Subtype Water Meter", at(cells, "subtype") || at(cells, "type"));
                        a.SIZE = sizeStr(sizeV);
                        a.BOX_MFR = pick("Meter Box Manufacturer", at(cells, "mfr"));
                        a.BOX_MAT = pick("Meter Box Material", at(cells, "material"));
                        if (z != null) a.ELEVATION = r4(z);
                    } else if (kind === "locate") {
                        block = "JEA_LOCATE_BOX"; layer = sewerTable ? "SS-LOC8" : "W-LOC8";
                        a.SUBTYPE = pick("Subtype Locate Box", at(cells, "subtype") || "Wire Box");
                    } else {
                        block = "JEA_FITTING"; layer = sys === "Reclaimed" ? "RW-FITT" : sewerTable ? "SS-FITT" : "W-FITT";
                        z = nv(at(cells, "topElev") !== undefined ? at(cells, "topElev") : (at(cells, "topPipe") !== undefined ? at(cells, "topPipe") : at(cells, "utilTop")));
                        a.SUBTYPE = String(at(cells, "subtype") || at(cells, "type") || "").trim();
                        a.SIZE = sizeStr(sizeV);
                        a.MATERIAL = pick("Pipe and Fitting Material", at(cells, "material"));
                        a.MANUFACTURER = pick("Fitting Manufacturers", at(cells, "mfr"));
                        if (z != null) a.ELEVATION = r4(z);
                    }

                    // Keep source fields the block has no tag for, so nothing is silently dropped.
                    const extra = {};
                    if (invertsList) extra.inverts = invertsList;
                    if (owner) extra.owner = String(owner).trim();
                    if (at(cells, "lat")) extra.lat = String(at(cells, "lat"));
                    if (at(cells, "lon")) extra.lon = String(at(cells, "lon"));
                    if (at(cells, "finalGrade") !== undefined && nv(at(cells, "finalGrade")) != null) extra.finalGrade = nv(at(cells, "finalGrade"));
                    // Raw elevations for the TOP + DEPTH = GRADE check (fitting tables carry all three).
                    const topV0 = nv(at(cells, "topElev")), depthV0 = nv(at(cells, "depth"));
                    const topV = topV0 != null ? topV0 : nv(at(cells, "pipeTop")), gradeV = nv(at(cells, "gradeElev")), depthV = depthV0 != null ? depthV0 : nv(at(cells, "cover"));
                    if (topV != null && gradeV != null && depthV != null) Object.assign(extra, { top: topV, grade: gradeV, depth: depthV });

                    Object.keys(a).forEach(k => { if (a[k] === "" || a[k] === undefined) delete a[k]; });
                    const item = { id, block, layer, e, n, z, attribs: a, source: { sheet: sheet.name, row: r, status: tbl.status || "", system: sys, ...extra } };

                    // IDs are unique within a package, so a repeat of one is the same structure — whatever
                    // block it maps to. The first (or, by choice, the last) row wins; any disagreement is
                    // reported, never silently dropped.
                    const key = id.toUpperCase();
                    const prev = seen.get(key);
                    if (prev) {
                        stats.duplicates++;
                        const at0 = `${prev.source.sheet}!A${prev.source.row}`;
                        const kept = policy === "last" ? where : at0;
                        if (prev.block !== block) {
                            flag("warning", "Same ID, different kind", id, where,
                                `is a ${block.replace("JEA_", "").toLowerCase()}${a.SUBTYPE ? " (" + a.SUBTYPE + ")" : ""} here but a ${prev.block.replace("JEA_", "").toLowerCase()}${prev.attribs.SUBTYPE ? " (" + prev.attribs.SUBTYPE + ")" : ""} at ${at0} — kept ${kept}; confirm which is right.`);
                        } else {
                            const diffs = [];
                            if (Math.abs(prev.e - e) > 0.01 || Math.abs(prev.n - n) > 0.01) diffs.push(`coordinates (E ${e}, N ${n} vs E ${prev.e}, N ${prev.n})`);
                            new Set([...Object.keys(prev.attribs), ...Object.keys(a)]).forEach(k => {
                                const x = prev.attribs[k], y = a[k];
                                if (x !== undefined && y !== undefined && String(x).toUpperCase() !== String(y).toUpperCase()) diffs.push(`${k} "${y}" vs "${x}"`);
                            });
                            if (diffs.length) {
                                flag("warning", "Conflicting duplicate", id, where, `disagrees with ${at0} on ${diffs.join(", ")} — kept ${kept}.`);
                            }
                        }
                        if (policy === "last") {
                            structures[structures.indexOf(prev)] = item;
                            seen.set(key, item);
                            stats.byKind[prev.block]--;
                            if (!stats.byKind[prev.block]) delete stats.byKind[prev.block];
                            stats.byKind[block] = (stats.byKind[block] || 0) + 1;
                        }
                        continue;
                    }
                    seen.set(key, item);
                    structures.push(item);
                    stats.imported++;
                    stats.byKind[block] = (stats.byKind[block] || 0) + 1;
                }
            }
        }
        qcStructures(structures, opts).forEach(f => findings.push(f));
        // points along pipe: lat/lon and top + cover = grade, but not "two IDs, one point" (a point of
        // connection can share a fitting's coordinates)
        if (pipePoints.length) qcStructures(pipePoints, Object.assign({}, opts, { skipSamePoint: true, skipOutlier: true })).forEach(f => findings.push(f));
        // County is not in the workbook; it is only set when the caller knows it (never assumed).
        const model = { projectName: opts.projectName || "Imported As-Built Workbook", structures, pipes: [], crossings, runs, pipePoints };
        if (opts.county) model.county = opts.county;
        return {
            model,
            findings,
            warnings: findings.map(f => `${f.where} ${f.id}: ${f.message}`),
            stats
        };
    }

    // ── Workbook self-check ──────────────────────────────────────────────
    /** 'N30° 28\' 16.32"' / "W81 36 53.66" / "-81.61" → signed decimal degrees, or null. */
    function parseDms(v) { const d = parseDmsDetail(v); return d ? d.deg : null; }

    /** parseDms + the half-unit of the last digit recorded, in degrees (rounding the value can't escape). */
    function parseDmsDetail(v) {
        if (typeof v === "number") return isFinite(v) ? { deg: v, halfUnitDeg: 0 } : null;
        const t = String(v == null ? "" : v).trim().toUpperCase();
        if (!t) return null;
        const m = /^([NSEW])?\s*(-?\d+(?:\.\d+)?)(?:\s*°|\s+)?\s*(?:(\d+(?:\.\d+)?)\s*['′]?)?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|″|'')?)?\s*([NSEW])?$/.exec(t);
        if (!m) return null;
        let deg = Math.abs(+m[2]) + (m[3] ? +m[3] / 60 : 0) + (m[4] ? +m[4] / 3600 : 0);
        const hemi = m[1] || m[5];
        if ((hemi === "S" || hemi === "W") || +m[2] < 0) deg = -deg;
        const dec = x => (String(x).split(".")[1] || "").length;
        const halfUnitDeg = m[4] != null ? 0.5 * Math.pow(10, -dec(m[4])) / 3600
            : m[3] != null ? 0.5 * Math.pow(10, -dec(m[3])) / 60 : 0.5 * Math.pow(10, -dec(m[2]));
        return { deg, halfUnitDeg };
    }

    const QC_DEFAULTS = {
        // JEA Water and Wastewater Standards 2026, §501 II.1.7: positional accuracy within 0.5 ft
        // horizontally and 0.1 ft vertically. The lat/lon check adds the rounding of the recorded
        // figure (half its last digit: 0.01″ of latitude ≈ 0.5 ft), so rounding alone never fails it.
        latLonTolFt: 0.5,
        // TOP + DEPTH vs GRADE — JEA's 0.1 ft vertical accuracy (§501 II.1.7).
        depthTolFt: 0.1,
        // Two different IDs this close are one point recorded twice.
        samePointTolFt: 0.05,
        // A point this far from the middle of the job (and 10× the typical spread) is probably a typo.
        outlierFt: 5280
    };

    /**
     * Cross-checks the imported structures against themselves (pure; no DOM):
     *  - lat/lon recorded in the sheet vs. the position computed from its SPC N/E (FL East, US ft)
     *  - TOP + DEPTH = GRADE on rows that carry all three
     *  - different IDs at the same coordinate
     *  - a point far from the rest of the job (an in-bounds coordinate typo the bounds check misses)
     * Tolerances can be overridden through opts.qc; each must be a positive number.
     */
    function qcStructures(structures, opts) {
        const tol = Object.assign({}, QC_DEFAULTS);
        const skipSame = !!(opts && opts.skipSamePoint), skipOut = !!(opts && opts.skipOutlier);
        Object.keys((opts && opts.qc) || {}).forEach(k => {
            const v = opts.qc[k];
            if (!(k in QC_DEFAULTS)) throw new Error(`Unknown QC tolerance "${k}".`);
            if (typeof v !== "number" || !isFinite(v) || v <= 0) throw new Error(`QC tolerance "${k}" must be a positive number.`);
            tol[k] = v;
        });
        const out = [];
        const flag = (severity, rule, s, message) => out.push({ severity, rule, id: s.id, where: `${s.source.sheet}!A${s.source.row}`, message });
        const toGeo = typeof window !== "undefined" && window.COGO && window.COGO.statePlaneToLatLon;
        const f1 = n => n.toFixed(1), f2 = n => n.toFixed(2);

        structures.forEach(s => {
            const src = s.source || {};
            if (toGeo && (src.lat || src.lon)) {
                const latD = parseDmsDetail(src.lat), lonD = parseDmsDetail(src.lon);
                const lat = latD && latD.deg, lon = lonD && lonD.deg;
                if (lat == null || lon == null) {
                    flag("info", "Lat/lon unreadable", s, `latitude/longitude "${src.lat || ""}" / "${src.lon || ""}" could not be read, so it was not checked.`);
                } else {
                    const g = toGeo(s.n, s.e, "FL_EAST", "sft");
                    const ftPerDegLat = 364000;
                    const dN = (lat - g.latDeg) * ftPerDegLat;
                    const dE = (lon - g.lonDeg) * ftPerDegLat * Math.cos(g.latDeg * Math.PI / 180);
                    const d = Math.hypot(dN, dE);
                    const rounding = Math.hypot(latD.halfUnitDeg * ftPerDegLat, lonD.halfUnitDeg * ftPerDegLat * Math.cos(g.latDeg * Math.PI / 180));
                    if (d > tol.latLonTolFt + rounding) {
                        flag("error", "Lat/lon vs SPC", s, `the recorded latitude/longitude is ${f1(d)} ft from the position its northing/easting gives (${g.latDeg.toFixed(6)}, ${g.lonDeg.toFixed(6)}) — more than JEA's 0.5 ft${rounding > 0.05 ? ` plus ${rounding.toFixed(2)} ft for the recorded figure's rounding` : ""}. One of them is wrong.`);
                    }
                }
            }
            if (src.top != null && src.grade != null && src.depth != null) {
                const miss = src.top + src.depth - src.grade;
                if (src.top > src.grade + tol.depthTolFt) {
                    flag("warning", "Top above grade", s, `top ${f2(src.top)} is above grade ${f2(src.grade)} — the two may be swapped.`);
                } else if (Math.abs(miss) > tol.depthTolFt) {
                    flag("warning", "Top + depth ≠ grade", s, `top ${f2(src.top)} + depth ${f2(src.depth)} = ${f2(src.top + src.depth)}, but grade is ${f2(src.grade)} (off by ${f2(miss)} ft).`);
                }
            }
        });

        // Different IDs on one point.
        if (!skipSame) {
            const sorted = structures.slice().sort((a, b) => a.e - b.e);
            for (let i = 0; i < sorted.length; i++) {
                for (let j = i + 1; j < sorted.length && sorted[j].e - sorted[i].e <= tol.samePointTolFt; j++) {
                    const a = sorted[i], b = sorted[j];
                    if (Math.hypot(a.e - b.e, a.n - b.n) <= tol.samePointTolFt) {
                        flag("warning", "Two IDs, one point", b, `has the same coordinates as ${a.id} (${a.source.sheet}!A${a.source.row}).`);
                    }
                }
            }
        }

        // Far from the rest of the job.
        if (!skipOut && structures.length >= 4) {
            const med = arr => { const v = arr.slice().sort((x, y) => x - y); const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };
            const cE = med(structures.map(s => s.e)), cN = med(structures.map(s => s.n));
            const dist = structures.map(s => Math.hypot(s.e - cE, s.n - cN));
            const typical = med(dist);
            structures.forEach((s, i) => {
                if (dist[i] > tol.outlierFt && dist[i] > 10 * typical) {
                    flag("error", "Far from the job", s, `is ${Math.round(dist[i]).toLocaleString("en-US")} ft from the middle of the other points (typical spread ${Math.round(typical)} ft) — likely a coordinate typo.`);
                }
            });
        }
        return out;
    }

    async function importWorkbook(buf, opts) {
        const wb = await readWorkbook(buf);
        return workbookToModel(wb, opts);
    }

    /**
     * Picklists from a JEA template workbook: any cell whose text is a known list name (or
     * "Validation List: <name>") heads a column of values that runs down to the first blank cell.
     * @param {{sheets}} workbook  from readWorkbook()
     * @param {string[]} names  the list names to look for (e.g. Object.keys(Jea24.DOMAINS))
     * @returns {{ lists: {name: string[]}, foundAt: {name: "Sheet!C1"}, missing: string[] }}
     */
    function extractPicklists(workbook, names) {
        const wanted = new Map(names.map(n => [norm(n), n]));
        const col = i => { let s = ""; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = (i - 1 - r) / 26; } return s; };
        const keyOf = v => typeof v === "string" ? norm(v).replace(/^VALIDATION LIST:\s*/, "") : null;
        // A list's header is best found in a HEADER ROW — a row naming several lists (JEA's
        // "Validation Lists" sheet). A lone "Validation List: X" cell elsewhere is usually a rule
        // that points at the list (the "Validation Rules" sheet), not the list itself.
        const candidates = [];
        for (const sheet of workbook.sheets) {
            sheet.rows.forEach((row, r) => {
                const hits = (row || []).map((v, c) => ({ c, name: wanted.get(keyOf(v)) })).filter(h => h.name);
                const headerRow = hits.length >= 3 || /VALIDATION\s+LISTS?$|^LISTS?$/i.test(sheet.name.trim());
                hits.forEach(h => candidates.push({ sheet, r, c: h.c, name: h.name, rank: headerRow ? 0 : 1 }));
            });
        }
        candidates.sort((a, b) => a.rank - b.rank); // stable: header rows first, then sheet order
        const lists = {}, foundAt = {};
        for (const cand of candidates) {
            if (lists[cand.name]) continue;
            const vals = [];
            for (let q = cand.r + 1; q < cand.sheet.rows.length; q++) {
                const cell = cand.sheet.rows[q] && cand.sheet.rows[q][cand.c];
                if (cell == null || cell === "") break;
                if (typeof cell === "string" && wanted.has(keyOf(cell))) break; // the next list's header
                vals.push(String(cell).trim());
            }
            if (vals.length) { lists[cand.name] = Array.from(new Set(vals)); foundAt[cand.name] = `${cand.sheet.name}!${col(cand.c)}${cand.r + 1}`; }
        }
        return { lists, foundAt, missing: names.filter(n => !lists[n]) };
    }

    // ── Pump station attribute worksheet ─────────────────────────────────

    const PS_TITLE = /STANDARD ATTRIBUTE WORKSHEET\s*-\s*NEW JEA PUMP STATION/i;
    /** The sheet holding JEA's "Standard Attribute Worksheet - New JEA Pump Station", or null. */
    function pumpStationSheet(workbook) {
        return (workbook.sheets || []).find(sh => sh.rows.slice(0, 5).some(r => (r || []).some(c => typeof c === "string" && PS_TITLE.test(c)))) || null;
    }

    /**
     * Completeness of JEA's pump station attribute worksheet (2026): the header block (project, address,
     * lat/lon, meters, service…) and, for each asset, every field its header row names (manufacturer,
     * model, serial, sizes…). Assets listed under "ADDITIONAL ASSETS THAT MAY BE UTILIZED" are optional:
     * left wholly blank they are noted, not flagged. JEA Standards 2026 §501 I.6.2.5 / III.5.2 require
     * the equipment attribute forms with the submittal.
     * @returns {{ header: {label: value|null}, assets: [{ id, description, missing, optional, row }], findings }}
     */
    function checkPumpStationWorksheet(workbook) {
        const sh = pumpStationSheet(workbook);
        if (!sh) throw new Error("This isn't JEA's pump station attribute worksheet.");
        const findings = [];
        const flag = (severity, rule, id, where, message) => findings.push({ severity, rule, id, where, message });
        const cellAt = (r, c) => { const row = sh.rows[r]; const v = row ? row[c] : null; return v == null || (typeof v === "string" && !v.trim().replace(/_+/g, "")) ? null : v; };
        const colL = c => { let s0 = ""; c++; while (c) { const m = (c - 1) % 26; s0 = String.fromCharCode(65 + m) + s0; c = (c - 1 - m) / 26; } return s0; };
        const header = {};
        let r = 0;
        // header block: label cells in two columns with their value to the right, until the asset table
        for (; r < sh.rows.length; r++) {
            const row = sh.rows[r] || [];
            if (row.some(c => typeof c === "string" && /ASSET DESCRIPTIONS|ASSET ID/i.test(c))) break;
            row.forEach((v, c) => {
                if (typeof v !== "string" || PS_TITLE.test(v) || !/^[A-Z0-9 #\/&().-]{3,}$/.test(v.trim())) return;
                let val = null;
                for (let k = c + 1; k < c + 6 && k < row.length; k++) {
                    const x = cellAt(r, k);
                    if (x != null && !(typeof x === "string" && /^[A-Z0-9 #\/&().-]{3,}$/.test(x.trim()) && /[A-Z]{3}/.test(x) && k > c + 1)) { val = x; break; }
                    if (typeof x === "string" && /^[A-Z #\/&().-]{4,}$/.test(x.trim())) break; // the next label
                }
                header[v.trim()] = val;
                if (val == null) flag("warning", "Worksheet header blank", "", `${sh.name}!${colL(c)}${r + 1}`, `${v.trim()} is blank (enter N/A if it doesn't apply).`);
            });
        }
        const latLbl = Object.keys(header).find(k => /^LATITUDE/.test(k)), lonLbl = Object.keys(header).find(k => /^LONGITUDE/.test(k));
        const lat = latLbl && header[latLbl] != null ? parseDms(header[latLbl]) : null, lon = lonLbl && header[lonLbl] != null ? parseDms(header[lonLbl]) : null;
        if (lat != null && (lat < 29 || lat > 31)) flag("warning", "Worksheet latitude", "", sh.name, `latitude ${header[latLbl]} is outside JEA's 29–31° N.`);
        if (lon != null && (lon > -80 || lon < -83)) flag("warning", "Worksheet longitude", "", sh.name, `longitude ${header[lonLbl]} is outside JEA's 80–83° W (west is negative in decimal degrees).`);
        // asset table: header rows name the fields; rows under them are assets
        const assets = [];
        let fields = null, idCol = -1, optional = false;
        for (; r < sh.rows.length; r++) {
            const row = sh.rows[r] || [];
            if (row.some(c => typeof c === "string" && /ADDITIONAL ASSETS THAT MAY BE UTILIZED/i.test(c))) optional = true;
            const hc = row.findIndex(c => typeof c === "string" && /^(?:PARENT OR CHILD )?ASSET ID$/i.test(c.trim()));
            if (hc >= 0) { idCol = hc; fields = row.map((c, i) => ({ i, name: typeof c === "string" ? c.replace(/\s+/g, " ").trim() : "" })).filter(f => f.i > hc + 1 && f.name); continue; }
            if (!fields) continue;
            const id = cellAt(r, idCol), desc = cellAt(r, idCol + 1);
            if (typeof id !== "string" || !desc || /ASSET|ASSEMBLY$/i.test(id) && !/-/.test(id)) continue;
            const missing = fields.filter(f => !/^CAPITAL/i.test(f.name) && cellAt(r, f.i) == null).map(f => f.name);
            const filled = fields.filter(f => !/^CAPITAL/i.test(f.name) && cellAt(r, f.i) != null).length; // CAPITAL comes pre-filled
            assets.push({ id: id.trim(), description: String(desc).trim(), missing, optional, filled, row: r + 1 });
        }
        assets.forEach(a => {
            if (!a.missing.length) return;
            const where = `${sh.name}!${colL(idCol)}${a.row}`;
            if (a.optional && a.filled === 0) {
                flag("info", "Optional asset not filled", a.id, where, `${a.description}: ${a.missing.length} field(s) blank — optional ("additional assets that may be utilized"); fill it if the station has one.`);
            } else {
                flag("warning", "Asset field blank", a.id, where, `${a.description}: ${a.missing.join(", ")}.`);
            }
        });
        flag("info", "Pump station worksheet", "", sh.name, `${Object.keys(header).length} header field(s), ${assets.length} asset row(s): ${assets.filter(a => !a.missing.length).length} complete (JEA Standards 2026 §501 I.6.2.5 / III.5.2: equipment attribute forms with the submittal).`);
        return { header, assets, findings };
    }

    // ── Writing .xlsx ────────────────────────────────────────────────────
    // A zip of stored (uncompressed) entries — valid for Excel and every reader — so no compressor is
    // needed. Cells are written as numbers or inline strings; no shared-string table to keep in step.

    const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
    function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

    /** entries: [{ name, data: Uint8Array }] → zip bytes (stored). */
    function zipStore(entries) {
        const enc = new TextEncoder();
        const parts = [], central = [];
        let off = 0;
        entries.forEach(({ name, data }) => {
            const nm = enc.encode(name), crc = crc32(data);
            const lh = new DataView(new ArrayBuffer(30));
            lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
            lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, nm.length, true);
            parts.push(new Uint8Array(lh.buffer), nm, data);
            const ch = new DataView(new ArrayBuffer(46));
            ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
            ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, nm.length, true); ch.setUint32(42, off, true);
            central.push(new Uint8Array(ch.buffer), nm);
            off += 30 + nm.length + data.length;
        });
        const cdLen = central.reduce((a, b) => a + b.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
        end.setUint32(12, cdLen, true); end.setUint32(16, off, true);
        const all = parts.concat(central, [new Uint8Array(end.buffer)]);
        const out = new Uint8Array(all.reduce((a, b) => a + b.length, 0));
        let p = 0;
        all.forEach(b => { out.set(b, p); p += b.length; });
        return out;
    }

    const xmlEsc = v => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const colName = i => { let s0 = ""; i++; while (i) { const m = (i - 1) % 26; s0 = String.fromCharCode(65 + m) + s0; i = (i - 1 - m) / 26; } return s0; };
    const cellXml = (ref, v, style) => {
        const st = style ? ` s="${style}"` : "";
        if (typeof v === "number" && isFinite(v)) return `<c r="${ref}"${st}><v>${v}</v></c>`;
        return `<c r="${ref}"${st} t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    };

    /** sheets: [{ name, rows: [[value…]] }] → .xlsx bytes. Row 1 is written bold (style 1). */
    function writeXlsx(sheets) {
        const enc = new TextEncoder();
        const safe = n => String(n).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet";
        const files = [];
        files.push({ name: "[Content_Types].xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`) });
        files.push({ name: "_rels/.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) });
        files.push({ name: "xl/workbook.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((sh, i) => `<sheet name="${xmlEsc(safe(sh.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`) });
        files.push({ name: "xl/_rels/workbook.xml.rels", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) });
        files.push({ name: "xl/styles.xml", data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs></styleSheet>`) });
        sheets.forEach((sh, i) => {
            const body = sh.rows.map((row, r) => `<row r="${r + 1}">${(row || []).map((v, c) => v == null || v === "" ? "" : cellXml(`${colName(c)}${r + 1}`, v, r === 0 ? 1 : 0)).join("")}</row>`).join("");
            files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`) });
        });
        return zipStore(files);
    }

    /**
     * A copy of a workbook with some cells replaced — every other part kept byte for byte (formats,
     * other sheets, formulas). edits: { "<sheet xml path>": { "Q11": value, … } }.
     */
    async function patchWorkbook(buf, edits) {
        const zip = openZip(buf);
        const enc = new TextEncoder();
        const entries = [];
        for (const name of Object.keys(zip)) {
            if (name.endsWith("/")) continue; // folder entries
            let data;
            if (edits[name]) {
                let xml = await zip[name]();
                Object.entries(edits[name]).forEach(([ref, v]) => { xml = setCell(xml, ref, v); });
                data = enc.encode(xml);
            } else {
                data = new Uint8Array(await zip[name].bytes()); // every other part byte for byte
            }
            entries.push({ name, data });
        }
        // Excel recalculates from scratch without a stale calculation chain
        return zipStore(entries);
    }

    /** Replace (or insert) one cell in a sheet's XML, keeping its style. */
    function setCell(xml, ref, v) {
        const m = /^([A-Z]+)(\d+)$/.exec(ref);
        if (!m) throw new Error(`Bad cell reference ${ref}.`);
        const row = m[2], colIdx = colIndex(ref);
        const cellRe = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
        const found = cellRe.exec(xml);
        if (found) {
            const style = (/\bs="(\d+)"/.exec(found[1]) || [])[1];
            return xml.slice(0, found.index) + cellXml(ref, v, style) + xml.slice(found.index + found[0].length);
        }
        const rowRe = new RegExp(`<row r="${row}"([^>]*?)(?:/>|>([\\s\\S]*?)</row>)`);
        const rf = rowRe.exec(xml);
        if (!rf) throw new Error(`Row ${row} not found for ${ref}.`);
        const inner = rf[2] || "";
        // insert in column order
        const cells = [];
        inner.replace(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, (c0, col, at) => { cells.push({ c0, idx: colIndex(col + "1"), at }); return c0; });
        const after = cells.find(c => c.idx > colIdx);
        const ins = cellXml(ref, v);
        const newInner = after ? inner.slice(0, after.at) + ins + inner.slice(after.at) : inner + ins;
        const openTag = `<row r="${row}"${rf[1]}>`;
        return xml.slice(0, rf.index) + openTag + newInner + "</row>" + xml.slice(rf.index + rf[0].length);
    }

    // ── Fill / correct lat/lon from State Plane ──────────────────────────

    /** 30.471352 → "N30° 28' 16.87\"" (seconds to `dec` places). */
    function toDms(deg, isLat, dec) {
        const h = isLat ? (deg < 0 ? "S" : "N") : (deg < 0 ? "W" : "E");
        let a = Math.abs(deg), d = Math.floor(a), m = Math.floor((a - d) * 60), sec = ((a - d) * 60 - m) * 60;
        sec = Number(sec.toFixed(dec));
        if (sec >= 60) { sec -= 60; m++; }
        if (m >= 60) { m -= 60; d++; }
        return `${h}${d}° ${m}' ${sec.toFixed(dec)}"`;
    }

    /**
     * A corrected copy of an as-built workbook: every row with a northing/easting gets the
     * latitude/longitude its FL East State Plane position gives, where the cell is blank or disagrees
     * by more than `tolFt` (default JEA's 0.5 ft). The cell's own format is kept — decimal degrees
     * (7 places, west negative — JEA's 2026 template) or the DMS text the firm used.
     * @returns {Promise<{ bytes: Uint8Array|null, changes: [{ sheet, cell, id, was, now, offFt }],
     *                    suspects: [{ sheet, row, id, n, e, fromLatLon }] }>}  suspects = rows whose
     *   northing/easting look wrong (their lat/lon is on the job, their SPC isn't) — left unchanged
     */
    async function fillLatLon(buf, opts) {
        return fixWorkbook(buf, Object.assign({ latlon: true, depth: false, slope: false, renames: null }, opts || {}));
    }

    /**
     * fillLatLon plus, by option: depth = grade − top where depth is blank (fitting / valve / points along
     * pipe tables); a gravity run's slope from (upstream − downstream invert) ÷ length where blank or off
     * by more than its rounding (§501 IV.1.4); and ID renames ({ "WW10": "WWS10" }) in the ID column. Each
     * change is listed; every other part of the file is kept byte for byte.
     */
    async function fixWorkbook(buf, opts) {
        opts = Object.assign({ latlon: true, depth: true, slope: true, renames: null }, opts || {});
        const toGeo = window.COGO && window.COGO.statePlaneToLatLon;
        if (!toGeo) throw new Error("The State Plane converter (COGO) is not loaded.");
        const tolFt = opts.tolFt || 0.5;
        const wb = await readWorkbook(buf);
        const edits = {}, changes = [], suspects = [];
        const fromGeo = window.COGO.latLonToStatePlane;
        const skip = /^(?:INSTRUCTIONS|VERSION HISTORY|VALIDATION (?:RULES|LISTS)|DOCUMENTATION|JEA ONLY\b|AS BUILT INFO)/i;
        const all = [];
        wb.sheets.forEach(sheet => {
            if (skip.test(sheet.name.trim())) return;
            findTables(sheet).forEach(tbl => {
                const c = tbl.cols;
                if (c.northing === undefined || c.easting === undefined || c.lat === undefined || c.lon === undefined) return;
                tbl.rows.forEach(({ r, cells }) => all.push({ sheet, tbl, r, cells }));
            });
        });
        // The middle of the job, to tell which of a disagreeing pair is wrong: a State Plane position far
        // from the job whose lat/lon IS on the job means the northing/easting is the typo — then the
        // lat/lon is left alone and the row reported.
        const pos = all.map(x => ({ n: num(x.cells[x.tbl.cols.northing]), e: num(x.cells[x.tbl.cols.easting]) })).filter(p => p.n != null && p.e != null);
        const med = a => { const v = a.slice().sort((x, y) => x - y); const m = v.length >> 1; return v.length ? (v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2) : null; };
        const cN = med(pos.map(p => p.n)), cE = med(pos.map(p => p.e));
        const spread = med(pos.map(p => Math.hypot(p.n - cN, p.e - cE))) || 0;
        const farLimit = Math.max(1000, 10 * spread);
        if (opts.latlon) all.forEach(({ sheet, tbl, r, cells }) => {
                    const c = tbl.cols;
                    const n = num(cells[c.northing]), e = num(cells[c.easting]);
                    if (n == null || e == null) return;
                    const g = toGeo(n, e, "FL_EAST", "sft");
                    const id = String(cells[c.id] == null ? "" : cells[c.id]).trim();
                    const la = parseDms(cells[c.lat]), lo = parseDms(cells[c.lon]);
                    if (la != null && lo != null && fromGeo && cN != null) {
                        const sp = fromGeo(la, lo, "FL_EAST", "sft");
                        const spcFar = Math.hypot(n - cN, e - cE) > farLimit, llNear = Math.hypot(sp.northing - cN, sp.easting - cE) <= farLimit;
                        if (spcFar && llNear) {
                            suspects.push({ sheet: sheet.name, row: r, id, n, e, fromLatLon: { n: Number(sp.northing.toFixed(2)), e: Number(sp.easting.toFixed(2)) } });
                            return;
                        }
                    }
                    [["lat", g.latDeg, true], ["lon", g.lonDeg, false]].forEach(([k, deg, isLat]) => {
                        const was = cells[c[k]];
                        const d = parseDmsDetail(was);
                        const ftPerDeg = isLat ? 364000 : 364000 * Math.cos(g.latDeg * Math.PI / 180);
                        const off = d ? Math.abs(d.deg - deg) * ftPerDeg : Infinity;
                        const rounding = d ? d.halfUnitDeg * ftPerDeg : 0;
                        if (off <= tolFt + rounding) return;
                        const isDmsText = typeof was === "string" && /[°'"NSEW]/i.test(was);
                        const now = isDmsText ? toDms(deg, isLat, 2) : Number(deg.toFixed(7));
                        const ref = `${colName(c[k])}${r}`;
                        (edits[sheet.path] = edits[sheet.path] || {})[ref] = now;
                        changes.push({ sheet: sheet.name, cell: ref, id, was: was == null ? "" : String(was), now: String(now), offFt: isFinite(off) ? Number(off.toFixed(1)) : null, kind: "lat/lon" });
                    });
        });
        // depth, slope and renames, over every data table
        const norm2 = v => String(v == null ? "" : v).toUpperCase().replace(/[\s_-]+/g, "");
        const renames = opts.renames ? new Map(Object.entries(opts.renames).map(([a, b]) => [norm2(a), b])) : null;
        wb.sheets.forEach(sheet => {
            if (skip.test(sheet.name.trim())) return;
            findTables(sheet).forEach(tbl => {
                const c = tbl.cols, put = (ref, v) => { (edits[sheet.path] = edits[sheet.path] || {})[ref] = v; };
                tbl.rows.forEach(({ r, cells }) => {
                    const id = String(cells[c.id] == null ? "" : cells[c.id]).trim();
                    if (!id) return;
                    if (renames && renames.has(norm2(id))) {
                        const to = renames.get(norm2(id)), ref = `${colName(c.id)}${r}`;
                        put(ref, to);
                        changes.push({ sheet: sheet.name, cell: ref, id, was: id, now: to, kind: "rename" });
                    }
                    const topK = c.topElev !== undefined ? "topElev" : c.pipeTop !== undefined ? "pipeTop" : null;
                    const depK = c.depth !== undefined ? "depth" : c.cover !== undefined ? "cover" : null;
                    if (opts.depth && topK && depK && c.gradeElev !== undefined && (cells[c[depK]] == null || cells[c[depK]] === "")) {
                        const top = num(cells[c[topK]]), grade = num(cells[c.gradeElev]);
                        if (top != null && grade != null && top !== -999 && grade !== -999 && grade >= top) {
                            const ref = `${colName(c[depK])}${r}`, v = Number((grade - top).toFixed(2));
                            put(ref, v);
                            changes.push({ sheet: sheet.name, cell: ref, id, was: "", now: String(v), kind: "depth" });
                        }
                    }
                    if (opts.slope && tbl.kind === "piperun" && c.slope !== undefined && c.runLen !== undefined && c.upInv !== undefined && c.dnInv !== undefined) {
                        const L = num(cells[c.runLen]), up = num(cells[c.upInv]), dn = num(cells[c.dnInv]), sl = num(cells[c.slope]);
                        if (L > 0 && up != null && dn != null) {
                            const calc = Number(((up - dn) / L * 100).toFixed(2));
                            const dec = (String(cells[c.slope]).split(".")[1] || "").length;
                            if (sl == null || Math.abs(calc - sl) > Math.max(0.01, 0.5 * Math.pow(10, -dec)) + 1e-9) {
                                const ref = `${colName(c.slope)}${r}`;
                                put(ref, calc);
                                changes.push({ sheet: sheet.name, cell: ref, id, was: sl == null ? "" : String(sl), now: String(calc), kind: "slope" });
                            }
                        }
                    }
                });
            });
        });
        return { bytes: changes.length ? await patchWorkbook(buf, edits) : null, changes, suspects };
    }

    // ── JEA 2026 asset tables from a model ───────────────────────────────

    /** Which JEA 2026 template sheet a structure belongs on. */
    function jeaTableFor(item) {
        const sys = (item.source && item.source.system) || (/^SS-/.test(item.layer || "") ? "Sewer" : /^RW-/.test(item.layer || "") ? "Reclaimed" : /^CW-/.test(item.layer || "") ? "Chilled" : "Water");
        const pre = sys === "Sewer" ? "WW" : sys === "Reclaimed" ? "Reclaimed" : sys === "Chilled" ? "Chilled" : "Water";
        switch (item.block) {
            case "JEA_VALVE": return `${pre} Valve`;
            case "JEA_FITTING": return `${pre} Fitting`;
            case "JEA_HYDRANT": return sys === "Reclaimed" ? "Reclaimed Hydrant" : "Water Hydrant";
            case "JEA_METER": return sys === "Sewer" ? "WW Service Point & Meter" : `${pre} Meter`;
            case "JEA_LOCATE_BOX": return `${pre} Locate Box`;
            case "JEA_MANHOLE": return "Manhole";
            case "JEA_CROSSING": return "Pipe Crossing Table";
            default: return null;
        }
    }

    /**
     * The model's structures, crossings and points along pipe as JEA's 2026 asset tables — one sheet per
     * table, columns in the template's order (rules = Jea24Data.RULES). A cell is filled only from a value
     * the model holds; anything it doesn't is left blank, never guessed. Lat/lon are computed from the
     * State Plane position (decimal degrees, 7 places).
     * @returns {{ bytes, sheets: [{ name, rows }], counts: {table: n} }}
     */
    function modelToJeaWorkbook(model, rules) {
        if (!rules) throw new Error("The JEA template rules are not loaded.");
        const toGeo = window.COGO && window.COGO.statePlaneToLatLon;
        const tables = {};
        // the template's sheet is "Water Hydrant"; its rules tab says "Water Hydrants"
        const ruleFor = t => rules[t] || rules[t + "s"] || null;
        const add = (t, item) => { if (t && ruleFor(t)) (tables[t] = tables[t] || []).push(item); };
        (model.structures || []).forEach(s0 => add(jeaTableFor(s0), s0));
        (model.crossings || []).forEach(c0 => add("Pipe Crossing Table", Object.assign({ block: "JEA_CROSSING" }, c0)));
        (model.pipePoints || []).forEach(p0 => { const sys = (p0.source && p0.source.system) || "Water"; add(`${sys === "Sewer" ? "WW" : sys} Points along Pipe`, p0); });
        const n2 = v => (v == null || v === "" || !isFinite(Number(v)) ? "" : Number(Number(v).toFixed(2)));
        const value = (col, it) => {
            const k = col.replace(/\s+/g, " ").trim().toUpperCase(), a = it.attribs || {}, src = it.source || {};
            const geo = toGeo && isFinite(it.n) && isFinite(it.e) ? toGeo(it.n, it.e, "FL_EAST", "sft") : null;
            if (/NUMBER\b/.test(k) && !/RFID|BARCODE/.test(k)) return it.id;
            if (/^UPPER PIPE TYPE/.test(k)) return a.UPPER_TYPE || "";
            if (/^LOWER PIPE TYPE/.test(k)) return a.LOWER_TYPE || "";
            if (/^UPPER PIPE SIZE/.test(k)) return a.UPPER_SIZE != null ? n2(a.UPPER_SIZE) : "";
            if (/^LOWER PIPE SIZE/.test(k)) return a.LOWER_SIZE != null ? n2(a.LOWER_SIZE) : "";
            if (/^UPPER PIPE BOTTOM/.test(k)) return n2(a.UPPER_BOT_ELEV);
            if (/^LOWER PIPE TOP/.test(k)) return n2(a.LOWER_TOP_ELEV);
            if (/^SEPARATION/.test(k)) return a.SEPARATION_FT != null ? n2(a.SEPARATION_FT) : a.CLEARANCE_INCHES != null ? n2(Number(a.CLEARANCE_INCHES) / 12) : "";
            if (/SUBTYPE$/.test(k)) return a.SUBTYPE || "";
            if (/^VALVE TYPE$/.test(k)) return a.VALVE_TYPE || "";
            if (/^MANHOLE TYPE$/.test(k)) return a.MANHOLE_TYPE || "";
            if (/^FACILITY OWNER$/.test(k)) return src.owner || "";
            if (/^(?:FITTING SIZE PRIMARY|VALVE SIZE|PROPOSED METER SIZE)/.test(k)) return a.SIZE != null ? n2(a.SIZE) === "" ? a.SIZE : n2(a.SIZE) : "";
            if (/^MANHOLE SIZE/.test(k)) return a.DIAMETER != null ? n2(a.DIAMETER) : "";
            if (/^(?:MANUFACTURER|VALVE MANUFACTURER|HYDRANT MANUFACTURER|MANUFACTURER OR SUPPLIER)$/.test(k)) return a.MANUFACTURER || "";
            if (/^METER BOX MANUFACTURER/.test(k)) return a.BOX_MFR || "";
            if (/^METER BOX MATERIAL$/.test(k)) return a.BOX_MAT || "";
            if (/^(?:FITTING |MANHOLE )?MATERIAL$/.test(k)) return a.MATERIAL || "";
            if (/^(?:MANHOLE )?LINING MATERIAL$/.test(k)) return a.LINING || "";
            if (/OPEN DIRECTION/.test(k)) return a.OPEN_DIR || "";
            if (/^(?:FITTING TOP|VALVE NUT) ELEVATION/.test(k)) return n2(it.z != null ? it.z : a.ELEVATION);
            if (/^PIPE TOP ELEVATION/.test(k)) return n2(it.z != null ? it.z : src.top);
            if (/^FINISHED GRADE ELEVATION/.test(k)) return n2(src.grade != null ? src.grade : src.finalGrade);
            if (/^(?:FITTING )?DEPTH|^DEPTH TO NUT|^PIPE COVER/.test(k)) return n2(src.depth);
            if (/^RIM ELEVATION/.test(k)) return n2(a.RIM_ELEV);
            if (/^LOWEST INVERT/.test(k)) return n2(a.INVERT_OUT);
            if (/^INVERT ELEVATIONS .*DIRECTION/.test(k)) return (src.inverts || []).map(v => `${v.dir} ${Number(v.z).toFixed(2)}`).join(", ");
            if (/^PIPE LOCATION$/.test(k)) return src.location || "";
            if (/^X COORD/.test(k)) return n2(it.e);
            if (/^Y COORD/.test(k)) return n2(it.n);
            if (/^LATITUDE/.test(k)) return geo ? Number(geo.latDeg.toFixed(7)) : "";
            if (/^LONGITUDE/.test(k)) return geo ? Number(geo.lonDeg.toFixed(7)) : "";
            return "";
        };
        const order = Object.keys(rules).map(t => (tables[t] ? t : tables[t.replace(/s$/, "")] ? t.replace(/s$/, "") : null)).filter(Boolean);
        const sheets = order.map(t => {
            const cols = ruleFor(t).map(c => c.column);
            return { name: t, rows: [cols.map(c => c.replace(/\s+/g, " ").trim())].concat(tables[t].map(it => cols.map(c => value(c, it)))) };
        });
        if (!sheets.length) throw new Error("The model has no structures, crossings or points along pipe to write.");
        const counts = {};
        sheets.forEach(sh => { counts[sh.name] = sh.rows.length - 1; });
        sheets.unshift({ name: "About", rows: [["Generated by the FDOT Civil 3D Tools — JEA As-Built 2026"], ["Columns follow the JEA As Built Template 2026; cells the model has no value for are left blank — fill or check them before submitting."], ["Latitude / Longitude computed from FL East State Plane (US ft), decimal degrees."], ["Generated", new Date().toISOString()]] });
        return { bytes: writeXlsx(sheets), sheets, counts };
    }

    /** findings → CSV text (for the QC download). */
    function findingsToCsv(findings) {
        const q = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
        return [["Severity", "Rule", "ID", "Cell", "Finding"].map(q).join(",")]
            .concat(findings.map(f => [f.severity, f.rule, f.id, f.where, f.message].map(q).join(",")))
            .join("\r\n");
    }

    window.JeaXlsx = { openZip, readWorkbook, findTables, workbookToModel, importWorkbook, qcStructures, parseDms, findingsToCsv, extractPicklists, QC_DEFAULTS, num, parseDmsDetail, pumpStationSheet, checkPumpStationWorksheet,
        crc32, zipStore, writeXlsx, patchWorkbook, setCell, toDms, fillLatLon, fixWorkbook, jeaTableFor, modelToJeaWorkbook };
})();
