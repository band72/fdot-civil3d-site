/**
 * Plugin: landxml (LandXML 1.2 / 2.0 Studio & Interop)
 * plugins/landxml/landxml.js
 *
 * Implements pure-JavaScript parsing, geometry extraction, and schema-compliant
 * LandXML 1.2 generation for Civil 3D alignments, parcels, surfaces, and survey
 * points (<CgPoints>, <Parcels>, <Alignments>, <Surfaces>).
 *
 * Bridges seamlessly with plugins/linework/linework.js and core/cogo.js.
 *
 * Registers via window.PluginRegistry.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "landxml",
        version: "1.0.0",
        description: "LandXML 1.2/2.0 geometry exchange: parse, inspect, 2D preview, and export parcels, alignments, and survey points.",
        tab: "tab-landxml",
        icon: "fa-code-fork",
        tier: "Free",
        // Uses window.COGO, but that's core/cogo.js (a <script> loaded before any plugin,
        // not a registered plugin) — "cogo" isn't a name any plugin registers under, so this
        // would be a silent no-op in _resolveDependencyOrder(). No dependency to declare.
        dependencies: []
    };

    const clean = window.cleanText; // core/safe-dom.js — shared across every plugin that sanitizes text before interpolation

    // window.App is never defined anywhere in this app — ctx.showToast (always real,
    // threaded through from PluginRegistry.initAll()) is the only path that ever fires.
    function notify(ctx, msg, isWarn = false) {
        if (ctx && typeof ctx.showToast === "function") ctx.showToast(msg, isWarn);
    }

    // ── XML Parsing Engine ──────────────────────────────────────────────────

    /**
     * Parses a LandXML string into a structured model.
     * Uses browser DOMParser when available; falls back to robust regex extraction
     * in headless / Node test environments.
     */
    function parseLandXML(xmlStr) {
        const text = String(xmlStr || "").trim();
        if (!text) throw new Error("Empty LandXML input");

        const result = {
            version: "1.2",
            project: { name: "", desc: "" },
            units: { linearUnit: "USSurveyFoot", angularUnit: "decimal degrees", areaUnit: "squareFoot" },
            coordinateSystem: { desc: "Florida State Plane East Zone NAD83", epsgCode: "2236" },
            points: [],
            parcels: [],
            alignments: [],
            surfaces: []
        };

        // Try DOMParser if available
        let doc = null;
        if (typeof DOMParser !== "undefined") {
            try {
                const parser = new DOMParser();
                const d = parser.parseFromString(text, "text/xml");
                if (!d.querySelector("parsererror")) {
                    doc = d;
                }
            } catch (e) {
                doc = null;
            }
        }

        if (doc) {
            parseFromDOM(doc, result);
        } else {
            parseFromRegex(text, result);
        }

        return result;
    }

    function parseFromDOM(doc, res) {
        const root = doc.querySelector("LandXML") || doc.documentElement;
        if (root) {
            res.version = root.getAttribute("version") || "1.2";
        }

        // Units
        const u = doc.querySelector("Units Imperial, Units Metric, Units");
        if (u) {
            res.units.linearUnit = u.getAttribute("linearUnit") || res.units.linearUnit;
            res.units.angularUnit = u.getAttribute("angularUnit") || res.units.angularUnit;
            res.units.areaUnit = u.getAttribute("areaUnit") || res.units.areaUnit;
        }

        // Coordinate System
        const cs = doc.querySelector("CoordinateSystem");
        if (cs) {
            res.coordinateSystem.desc = cs.getAttribute("desc") || res.coordinateSystem.desc;
            res.coordinateSystem.epsgCode = cs.getAttribute("epsgCode") || res.coordinateSystem.epsgCode;
        }

        // Project
        const prj = doc.querySelector("Project");
        if (prj) {
            res.project.name = prj.getAttribute("name") || "";
            res.project.desc = prj.getAttribute("desc") || prj.getAttribute("description") || "";
        }

        // CgPoints
        const pts = doc.querySelectorAll("CgPoint");
        pts.forEach(p => {
            const raw = (p.textContent || "").trim().split(/\s+/).map(Number);
            if (raw.length >= 2 && !isNaN(raw[0]) && !isNaN(raw[1])) {
                res.points.push({
                    name: p.getAttribute("name") || String(res.points.length + 1),
                    code: p.getAttribute("code") || p.getAttribute("desc") || "",
                    northing: raw[0],
                    easting: raw[1],
                    elev: raw.length > 2 && !isNaN(raw[2]) ? raw[2] : 0
                });
            }
        });

        // Parcels
        const parcels = doc.querySelectorAll("Parcel");
        parcels.forEach(prc => {
            const parcelObj = {
                name: prc.getAttribute("name") || `Parcel_${res.parcels.length + 1}`,
                desc: prc.getAttribute("desc") || prc.getAttribute("description") || "",
                area: parseFloat(prc.getAttribute("area") || "0"),
                parcelType: prc.getAttribute("parcelType") || "Property",
                lines: [],
                curves: [],
                vertices: []
            };

            const lines = prc.querySelectorAll("CoordGeom > Line");
            lines.forEach(l => {
                const s = parseCoordNode(l.querySelector("Start"));
                const e = parseCoordNode(l.querySelector("End"));
                if (s && e) {
                    parcelObj.lines.push({
                        start: s,
                        end: e,
                        dir: parseFloat(l.getAttribute("dir") || "0"),
                        length: parseFloat(l.getAttribute("length") || Math.hypot(e.e - s.e, e.n - s.n).toFixed(3))
                    });
                    if (!parcelObj.vertices.length) parcelObj.vertices.push(s);
                    parcelObj.vertices.push(e);
                }
            });

            const curves = prc.querySelectorAll("CoordGeom > Curve");
            curves.forEach(c => {
                const s = parseCoordNode(c.querySelector("Start"));
                const e = parseCoordNode(c.querySelector("End"));
                const ctr = parseCoordNode(c.querySelector("Center"));
                if (s && e) {
                    parcelObj.curves.push({
                        start: s,
                        end: e,
                        center: ctr,
                        rot: (c.getAttribute("rot") || "cw").toLowerCase(),
                        radius: parseFloat(c.getAttribute("radius") || "0"),
                        length: parseFloat(c.getAttribute("length") || "0"),
                        delta: parseFloat(c.getAttribute("delta") || "0"),
                        chord: parseFloat(c.getAttribute("chord") || Math.hypot(e.e - s.e, e.n - s.n).toFixed(3))
                    });
                    if (!parcelObj.vertices.length) parcelObj.vertices.push(s);
                    parcelObj.vertices.push(e);
                }
            });

            // Compute area if missing
            if ((!parcelObj.area || parcelObj.area <= 0) && parcelObj.vertices.length >= 3 && window.COGO?.shoelaceArea) {
                parcelObj.area = window.COGO.shoelaceArea(parcelObj.vertices);
            }

            res.parcels.push(parcelObj);
        });

        // Alignments
        const alignments = doc.querySelectorAll("Alignment");
        alignments.forEach(al => {
            const alObj = {
                name: al.getAttribute("name") || `Alignment_${res.alignments.length + 1}`,
                length: parseFloat(al.getAttribute("length") || "0"),
                staStart: parseFloat(al.getAttribute("staStart") || "0"),
                lines: [],
                curves: [],
                vertices: []
            };

            al.querySelectorAll("CoordGeom > Line").forEach(l => {
                const s = parseCoordNode(l.querySelector("Start"));
                const e = parseCoordNode(l.querySelector("End"));
                if (s && e) {
                    alObj.lines.push({ start: s, end: e });
                    if (!alObj.vertices.length) alObj.vertices.push(s);
                    alObj.vertices.push(e);
                }
            });

            al.querySelectorAll("CoordGeom > Curve").forEach(c => {
                const s = parseCoordNode(c.querySelector("Start"));
                const e = parseCoordNode(c.querySelector("End"));
                const ctr = parseCoordNode(c.querySelector("Center"));
                if (s && e) {
                    alObj.curves.push({
                        start: s,
                        end: e,
                        center: ctr,
                        rot: (c.getAttribute("rot") || "cw").toLowerCase(),
                        radius: parseFloat(c.getAttribute("radius") || "0"),
                        length: parseFloat(c.getAttribute("length") || "0")
                    });
                    if (!alObj.vertices.length) alObj.vertices.push(s);
                    alObj.vertices.push(e);
                }
            });

            res.alignments.push(alObj);
        });

        // Surfaces
        doc.querySelectorAll("Surface").forEach(sf => {
            const pnts = sf.querySelectorAll("Definition Pnts P");
            const faces = sf.querySelectorAll("Definition Faces F");
            res.surfaces.push({
                name: sf.getAttribute("name") || `Surface_${res.surfaces.length + 1}`,
                pointsCount: pnts.length,
                facesCount: faces.length
            });
        });
    }

    function parseCoordNode(node) {
        if (!node) return null;
        const parts = (node.textContent || "").trim().split(/\s+/).map(Number);
        if (parts.length >= 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
            return { n: parts[0], e: parts[1], z: parts.length > 2 && !isNaN(parts[2]) ? parts[2] : 0 };
        }
        return null;
    }

    /** Fast regex-based fallback parser for environments without DOMParser */
    function parseFromRegex(txt, res) {
        // Version
        const vm = txt.match(/<LandXML[^>]*version=["']([^"']+)["']/i);
        if (vm) res.version = vm[1];

        // Units
        const um = txt.match(/<(?:Units|Imperial|Metric)[^>]*linearUnit=["']([^"']+)["']/i);
        if (um) res.units.linearUnit = um[1];
        const am = txt.match(/<(?:Units|Imperial|Metric)[^>]*angularUnit=["']([^"']+)["']/i);
        if (am) res.units.angularUnit = am[1];
        const arm = txt.match(/<(?:Units|Imperial|Metric)[^>]*areaUnit=["']([^"']+)["']/i);
        if (arm) res.units.areaUnit = arm[1];

        // CoordinateSystem
        const csm = txt.match(/<CoordinateSystem[^>]*desc=["']([^"']+)["'][^>]*epsgCode=["']([^"']+)["']/i);
        if (csm) {
            res.coordinateSystem.desc = csm[1];
            res.coordinateSystem.epsgCode = csm[2];
        }

        // Project
        const prjm = txt.match(/<Project[^>]*name=["']([^"']+)["']/i);
        if (prjm) res.project.name = prjm[1];

        // CgPoints
        const ptRe = /<CgPoint\b([^>]*)>([^<]+)<\/CgPoint>/gi;
        let pm;
        while ((pm = ptRe.exec(txt)) !== null) {
            const attrs = pm[1];
            const nameMatch = attrs.match(/name=["']([^"']+)["']/i);
            const codeMatch = attrs.match(/(?:code|desc)=["']([^"']+)["']/i);
            const coords = pm[2].trim().split(/\s+/).map(Number);
            if (coords.length >= 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
                res.points.push({
                    name: nameMatch ? nameMatch[1] : String(res.points.length + 1),
                    code: codeMatch ? codeMatch[1] : "",
                    northing: coords[0],
                    easting: coords[1],
                    elev: coords.length > 2 && !isNaN(coords[2]) ? coords[2] : 0
                });
            }
        }

        // Parcels
        const parcelRe = /<Parcel\b([^>]*)>([\s\S]*?)<\/Parcel>/gi;
        let prcm;
        while ((prcm = parcelRe.exec(txt)) !== null) {
            const attrs = prcm[1];
            const body = prcm[2];
            const nameM = attrs.match(/name=["']([^"']+)["']/i);
            const areaM = attrs.match(/area=["']([^"']+)["']/i);
            const descM = attrs.match(/(?:desc|description)=["']([^"']+)["']/i);

            const parcelObj = {
                name: nameM ? nameM[1] : `Parcel_${res.parcels.length + 1}`,
                desc: descM ? descM[1] : "",
                area: areaM ? parseFloat(areaM[1]) : 0,
                lines: [],
                curves: [],
                vertices: []
            };

            // Lines in parcel
            const lineRe = /<Line\b([^>]*)>[\s\S]*?<Start>([^<]+)<\/Start>[\s\S]*?<End>([^<]+)<\/End>[\s\S]*?<\/Line>/gi;
            let lm;
            while ((lm = lineRe.exec(body)) !== null) {
                const s = parseCoordString(lm[2]);
                const e = parseCoordString(lm[3]);
                if (s && e) {
                    parcelObj.lines.push({ start: s, end: e });
                    if (!parcelObj.vertices.length) parcelObj.vertices.push(s);
                    parcelObj.vertices.push(e);
                }
            }

            // Curves in parcel
            const crvRe = /<Curve\b([^>]*)>[\s\S]*?<Start>([^<]+)<\/Start>[\s\S]*?<Center>([^<]+)<\/Center>[\s\S]*?<End>([^<]+)<\/End>[\s\S]*?<\/Curve>/gi;
            let cm;
            while ((cm = crvRe.exec(body)) !== null) {
                const cAttrs = cm[1];
                const s = parseCoordString(cm[2]);
                const ctr = parseCoordString(cm[3]);
                const e = parseCoordString(cm[4]);
                const radM = cAttrs.match(/radius=["']([^"']+)["']/i);
                const rotM = cAttrs.match(/rot=["']([^"']+)["']/i);
                if (s && e) {
                    parcelObj.curves.push({
                        start: s,
                        end: e,
                        center: ctr,
                        rot: rotM ? rotM[1].toLowerCase() : "cw",
                        radius: radM ? parseFloat(radM[1]) : 0
                    });
                    if (!parcelObj.vertices.length) parcelObj.vertices.push(s);
                    parcelObj.vertices.push(e);
                }
            }

            if ((!parcelObj.area || parcelObj.area <= 0) && parcelObj.vertices.length >= 3 && window.COGO?.shoelaceArea) {
                parcelObj.area = window.COGO.shoelaceArea(parcelObj.vertices);
            }

            res.parcels.push(parcelObj);
        }

        // Alignments
        const alRe = /<Alignment\b([^>]*)>([\s\S]*?)<\/Alignment>/gi;
        let alm;
        while ((alm = alRe.exec(txt)) !== null) {
            const attrs = alm[1];
            const body = alm[2];
            const nameM = attrs.match(/name=["']([^"']+)["']/i);
            const lenM = attrs.match(/length=["']([^"']+)["']/i);
            const staM = attrs.match(/staStart=["']([^"']+)["']/i);

            const alObj = {
                name: nameM ? nameM[1] : `Alignment_${res.alignments.length + 1}`,
                length: lenM ? parseFloat(lenM[1]) : 0,
                staStart: staM ? parseFloat(staM[1]) : 0,
                lines: [],
                curves: [],
                vertices: []
            };

            const lineRe = /<Line\b([^>]*)>[\s\S]*?<Start>([^<]+)<\/Start>[\s\S]*?<End>([^<]+)<\/End>[\s\S]*?<\/Line>/gi;
            let lm;
            while ((lm = lineRe.exec(body)) !== null) {
                const s = parseCoordString(lm[2]);
                const e = parseCoordString(lm[3]);
                if (s && e) {
                    alObj.lines.push({ start: s, end: e });
                    if (!alObj.vertices.length) alObj.vertices.push(s);
                    alObj.vertices.push(e);
                }
            }

            res.alignments.push(alObj);
        }

        // Surfaces
        const sfRe = /<Surface\b([^>]*)>([\s\S]*?)<\/Surface>/gi;
        let sfm;
        while ((sfm = sfRe.exec(txt)) !== null) {
            const nameM = sfm[1].match(/name=["']([^"']+)["']/i);
            const pCount = (sfm[2].match(/<P\b/gi) || []).length;
            const fCount = (sfm[2].match(/<F\b/gi) || []).length;
            res.surfaces.push({
                name: nameM ? nameM[1] : `Surface_${res.surfaces.length + 1}`,
                pointsCount: pCount,
                facesCount: fCount
            });
        }
    }

    function parseCoordString(s) {
        if (!s) return null;
        const c = s.trim().split(/\s+/).map(Number);
        if (c.length >= 2 && !isNaN(c[0]) && !isNaN(c[1])) {
            return { n: c[0], e: c[1], z: c.length > 2 && !isNaN(c[2]) ? c[2] : 0 };
        }
        return null;
    }

    // ── LandXML 1.2 Document Exporter ───────────────────────────────────────

    /**
     * Builds a schema-compliant LandXML 1.2 XML string.
     * @param {Object} model { project, units, coordinateSystem, points, parcels, alignments }
     */
    function buildLandXML(model, options = {}) {
        const dateStr = new Date().toISOString().split("T")[0];
        const timeStr = new Date().toTimeString().split(" ")[0];
        const prjName = clean(model?.project?.name || options.projectName || "FDOT-Project");
        const prjDesc = clean(model?.project?.desc || options.projectDesc || "Exported from FDOT Civil3D Standards Suite");

        const points = model?.points || [];
        const parcels = model?.parcels || [];
        const alignments = model?.alignments || [];

        let xml = `<?xml version="1.0" encoding="utf-8"?>\n`;
        xml += `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" version="1.2" date="${dateStr}" time="${timeStr}" readSpec="FDOT-Civil3D-Standards">\n`;
        xml += `  <Units>\n`;
        xml += `    <Imperial linearUnit="USSurveyFoot" areaUnit="squareFoot" volumeUnit="cubicYard" temperatureUnit="fahrenheit" pressureUnit="inHG" angularUnit="decimal degrees" directionUnit="decimal degrees"/>\n`;
        xml += `  </Units>\n`;
        xml += `  <CoordinateSystem desc="Florida State Plane East Zone NAD83 US Survey Feet" epsgCode="2236"/>\n`;
        xml += `  <Project name="${prjName}" description="${prjDesc}"/>\n`;
        xml += `  <Application name="FDOT Civil3D Standards Suite" version="2.6.0" manufacturer="BoundaryQC"/>\n`;

        // Points
        if (points.length > 0) {
            xml += `  <CgPoints>\n`;
            points.forEach((p, idx) => {
                const name = clean(p.name || String(idx + 1));
                const codeAttr = p.code ? ` code="${clean(p.code)}"` : (p.desc ? ` desc="${clean(p.desc)}"` : "");
                const n = Number(p.northing ?? p.n ?? 0).toFixed(4);
                const e = Number(p.easting ?? p.e ?? 0).toFixed(4);
                const z = Number(p.elev ?? p.z ?? 0).toFixed(4);
                xml += `    <CgPoint name="${name}"${codeAttr}>${n} ${e} ${z}</CgPoint>\n`;
            });
            xml += `  </CgPoints>\n`;
        }

        // Parcels
        if (parcels.length > 0) {
            xml += `  <Parcels>\n`;
            parcels.forEach((prc, idx) => {
                const name = clean(prc.name || `PARCEL_${idx + 1}`);
                const area = Number(prc.area || 0).toFixed(2);
                const descAttr = prc.desc ? ` desc="${clean(prc.desc)}"` : "";
                xml += `    <Parcel name="${name}" area="${area}"${descAttr} parcelType="${clean(prc.parcelType || "Property")}">\n`;
                xml += `      <CoordGeom>\n`;

                if (prc.lines && prc.lines.length > 0) {
                    prc.lines.forEach(l => {
                        const sN = Number(l.start.n).toFixed(4), sE = Number(l.start.e).toFixed(4);
                        const eN = Number(l.end.n).toFixed(4), eE = Number(l.end.e).toFixed(4);
                        const len = Math.hypot(l.end.e - l.start.e, l.end.n - l.start.n).toFixed(4);
                        xml += `        <Line length="${len}">\n`;
                        xml += `          <Start>${sN} ${sE}</Start>\n`;
                        xml += `          <End>${eN} ${eE}</End>\n`;
                        xml += `        </Line>\n`;
                    });
                } else if (prc.vertices && prc.vertices.length >= 2) {
                    for (let i = 0; i < prc.vertices.length - 1; i++) {
                        const s = prc.vertices[i], e = prc.vertices[i + 1];
                        const len = Math.hypot(e.e - s.e, e.n - s.n).toFixed(4);
                        xml += `        <Line length="${len}">\n`;
                        xml += `          <Start>${Number(s.n).toFixed(4)} ${Number(s.e).toFixed(4)}</Start>\n`;
                        xml += `          <End>${Number(e.n).toFixed(4)} ${Number(e.e).toFixed(4)}</End>\n`;
                        xml += `        </Line>\n`;
                    }
                }

                if (prc.curves && prc.curves.length > 0) {
                    prc.curves.forEach(c => {
                        const sN = Number(c.start.n).toFixed(4), sE = Number(c.start.e).toFixed(4);
                        const eN = Number(c.end.n).toFixed(4), eE = Number(c.end.e).toFixed(4);
                        const rad = Number(c.radius || 0).toFixed(4);
                        const rot = clean(c.rot || "cw");
                        xml += `        <Curve rot="${rot}" radius="${rad}">\n`;
                        xml += `          <Start>${sN} ${sE}</Start>\n`;
                        if (c.center) {
                            xml += `          <Center>${Number(c.center.n).toFixed(4)} ${Number(c.center.e).toFixed(4)}</Center>\n`;
                        }
                        xml += `          <End>${eN} ${eE}</End>\n`;
                        xml += `        </Curve>\n`;
                    });
                }

                xml += `      </CoordGeom>\n`;
                xml += `    </Parcel>\n`;
            });
            xml += `  </Parcels>\n`;
        }

        // Alignments
        if (alignments.length > 0) {
            xml += `  <Alignments>\n`;
            alignments.forEach((al, idx) => {
                const name = clean(al.name || `ALIGNMENT_${idx + 1}`);
                const len = Number(al.length || 0).toFixed(4);
                const sta = Number(al.staStart || 0).toFixed(4);
                xml += `    <Alignment name="${name}" length="${len}" staStart="${sta}">\n`;
                xml += `      <CoordGeom>\n`;
                (al.lines || []).forEach(l => {
                    const sN = Number(l.start.n).toFixed(4), sE = Number(l.start.e).toFixed(4);
                    const eN = Number(l.end.n).toFixed(4), eE = Number(l.end.e).toFixed(4);
                    xml += `        <Line>\n`;
                    xml += `          <Start>${sN} ${sE}</Start>\n`;
                    xml += `          <End>${eN} ${eE}</End>\n`;
                    xml += `        </Line>\n`;
                });
                xml += `      </CoordGeom>\n`;
                xml += `    </Alignment>\n`;
            });
            xml += `  </Alignments>\n`;
        }

        xml += `</LandXML>\n`;
        return xml;
    }

    // ── Linework Figures Bridge ─────────────────────────────────────────────

    /**
     * Converts parsed LandXML parcels into Linework Editor compatible figures.
     */
    function toFiguresModel(parsedLandXML) {
        if (!parsedLandXML || !parsedLandXML.parcels) return { figures: [] };

        const figures = parsedLandXML.parcels.map((prc, fIdx) => {
            const pts = [];
            const arcs = [];
            let ptIdCounter = (fIdx + 1) * 100 + 1;

            (prc.vertices || []).forEach((v, vIdx) => {
                // Avoid adjacent duplicate points
                if (vIdx > 0) {
                    const prev = pts[pts.length - 1];
                    if (Math.hypot(v.e - prev.e, v.n - prev.n) < 0.0001) return;
                }
                pts.push({
                    id: ptIdCounter++,
                    n: v.n,
                    e: v.e,
                    z: v.z || 0,
                    code: `${prc.name} ${vIdx + 1}`
                });
            });

            return {
                id: fIdx + 1,
                name: prc.name || `PARCEL_${fIdx + 1}`,
                layer: "SURV_BNDY_PROP",
                closed: true,
                pts,
                arcs
            };
        });

        return { figures };
    }

    /**
     * Converts a Linework Editor / EFB figures model to LandXML format.
     */
    function fromFiguresModel(figures, projectName = "Exported_Linework") {
        const points = [];
        const parcels = [];
        let pId = 1;

        (figures || []).forEach((f, fIdx) => {
            const vertices = (f.pts || []).map(p => {
                const ptObj = {
                    name: String((p.ptNum != null && p.ptNum !== "") ? p.ptNum : (p.id || pId++)),
                    northing: p.n,
                    easting: p.e,
                    elev: p.z || 0,
                    code: p.code || f.layer || "SURV",
                    desc: p.desc || ""
                };
                points.push(ptObj);
                return { n: p.n, e: p.e, z: p.z || 0 };
            });

            if (f.closed && vertices.length >= 3) {
                let area = 0;
                if (window.COGO?.shoelaceArea) area = window.COGO.shoelaceArea(vertices);
                parcels.push({
                    name: f.name || `FIGURE_${fIdx + 1}`,
                    area,
                    desc: f.layer || "Survey Boundary",
                    parcelType: "Property",
                    vertices
                });
            }
        });

        return buildLandXML({ project: { name: projectName }, points, parcels });
    }

    // ── Sample FDOT LandXML Dataset ─────────────────────────────────────────

    function sampleLandXML() {
        return `<?xml version="1.0" encoding="utf-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="2026-09-11" time="07:00:00" readSpec="FDOT-Civil3D-Standards">
  <Units>
    <Imperial linearUnit="USSurveyFoot" areaUnit="squareFoot" volumeUnit="cubicYard" angularUnit="decimal degrees"/>
  </Units>
  <CoordinateSystem desc="Florida State Plane East Zone NAD83 US Survey Feet" epsgCode="2236"/>
  <Project name="FDOT SR-50 Right-of-Way" description="State Road 50 Corridor Boundary Acquisition Parcel Survey"/>
  <Application name="FDOT Civil3D Standards Suite" version="2.6.0" manufacturer="BoundaryQC"/>
  <CgPoints>
    <CgPoint name="101" code="POB" desc="FDOT Iron Rod &amp; Cap">540120.5500 621450.1200 45.2000</CgPoint>
    <CgPoint name="102" code="RW" desc="Found Concrete Monument">540420.5500 621450.1200 46.1000</CgPoint>
    <CgPoint name="103" code="RW" desc="FDOT Disk in Concrete">540420.5500 621850.1200 47.5000</CgPoint>
    <CgPoint name="104" code="RW" desc="Found Pin">540120.5500 621850.1200 45.8000</CgPoint>
  </CgPoints>
  <Parcels>
    <Parcel name="PARCEL_101_FEE" area="120000.00" desc="Fee Simple Right-of-Way Acquisition" parcelType="Property">
      <CoordGeom>
        <Line length="300.0000">
          <Start>540120.5500 621450.1200</Start>
          <End>540420.5500 621450.1200</End>
        </Line>
        <Line length="400.0000">
          <Start>540420.5500 621450.1200</Start>
          <End>540420.5500 621850.1200</End>
        </Line>
        <Line length="300.0000">
          <Start>540420.5500 621850.1200</Start>
          <End>540120.5500 621850.1200</End>
        </Line>
        <Line length="400.0000">
          <Start>540120.5500 621850.1200</Start>
          <End>540120.5500 621450.1200</End>
        </Line>
      </CoordGeom>
    </Parcel>
  </Parcels>
  <Alignments>
    <Alignment name="BL_SR50" length="2500.0000" staStart="1000.0000">
      <CoordGeom>
        <Line>
          <Start>540000.0000 620000.0000</Start>
          <End>540000.0000 622500.0000</End>
        </Line>
      </CoordGeom>
    </Alignment>
  </Alignments>
</LandXML>`;
    }

    // ── UI Controller & Canvas Rendering ────────────────────────────────────

    let _lastParsed = null;

    function renderUI(ctx) {
        const root = document.getElementById("landxml-controls");
        if (!root) return;

        window.setSafeHTML(root, `
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1.5rem; margin-top:1rem;">
                <!-- Left: Input & Actions -->
                <div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.5rem;">
                        <label style="font-weight:600; font-size:0.85rem;"><i class="fa-solid fa-code"></i> LandXML Data (Paste or Drop .xml / .landxml)</label>
                        <button class="btn btn-secondary btn-sm" id="btn-landxml-sample"><i class="fa-solid fa-vial"></i> Load FDOT Sample</button>
                    </div>
                    <textarea id="landxml-input" aria-label="LandXML markup" rows="12" placeholder="Paste LandXML 1.0, 1.1, 1.2 or 2.0 markup here..." style="width:100%; box-sizing:border-box; font-family:var(--font-mono); font-size:0.8rem; padding:0.75rem; background:var(--bg-secondary); border:1px solid var(--glass-border); border-radius:var(--radius-sm); color:var(--text-primary);"></textarea>
                    
                    <div style="display:flex; gap:0.5rem; margin-top:0.75rem; flex-wrap:wrap;">
                        <button class="btn btn-primary" id="btn-landxml-parse"><i class="fa-solid fa-play"></i> Parse &amp; Inspect</button>
                        <button class="btn btn-secondary" id="btn-landxml-send"><i class="fa-solid fa-paper-plane"></i> Send to Linework Editor</button>
                        <button class="btn btn-secondary" id="btn-landxml-download"><i class="fa-solid fa-download"></i> Download .xml</button>
                    </div>
                </div>

                <!-- Right: Stats & 2D Preview -->
                <div>
                    <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:0.5rem; margin-bottom:0.75rem;">
                        <div class="glass-panel" style="padding:0.75rem; text-align:center;">
                            <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Points</div>
                            <div id="stat-landxml-points" style="font-size:1.2rem; font-weight:700; color:var(--primary);">0</div>
                        </div>
                        <div class="glass-panel" style="padding:0.75rem; text-align:center;">
                            <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Parcels</div>
                            <div id="stat-landxml-parcels" style="font-size:1.2rem; font-weight:700; color:var(--accent);">0</div>
                        </div>
                        <div class="glass-panel" style="padding:0.75rem; text-align:center;">
                            <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Alignments</div>
                            <div id="stat-landxml-alignments" style="font-size:1.2rem; font-weight:700; color:var(--success);">0</div>
                        </div>
                        <div class="glass-panel" style="padding:0.75rem; text-align:center;">
                            <div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">Surfaces</div>
                            <div id="stat-landxml-surfaces" style="font-size:1.2rem; font-weight:700; color:var(--warning);">0</div>
                        </div>
                    </div>

                    <div class="glass-panel" style="position:relative; height:240px; background:#0b1120; border-radius:var(--radius-sm); overflow:hidden;">
                        <canvas id="landxml-canvas" width="500" height="240" style="width:100%; height:100%; display:block;"></canvas>
                        <div id="landxml-hud" style="position:absolute; bottom:6px; right:8px; font-size:0.72rem; color:var(--text-muted); font-family:var(--font-mono);">Ready</div>
                    </div>
                </div>
            </div>

            <!-- Parcels & Points Grid -->
            <div id="landxml-tables" style="margin-top:1.5rem;" class="hidden">
                <div style="display:grid; grid-template-columns: 1fr 1fr; gap:1.5rem;">
                    <div>
                        <h4 style="font-size:0.9rem; margin-bottom:0.5rem; color:var(--accent);"><i class="fa-solid fa-draw-polygon"></i> Parcels &amp; Boundaries</h4>
                        <div id="landxml-parcels-list" style="max-height:220px; overflow-y:auto; border:1px solid var(--glass-border); border-radius:var(--radius-sm);"></div>
                    </div>
                    <div>
                        <h4 style="font-size:0.9rem; margin-bottom:0.5rem; color:var(--primary);"><i class="fa-solid fa-location-dot"></i> Survey COGO Points (<span id="landxml-points-count">0</span>)</h4>
                        <div id="landxml-points-list" style="max-height:220px; overflow-y:auto; border:1px solid var(--glass-border); border-radius:var(--radius-sm);"></div>
                    </div>
                </div>
            </div>
        `);

        bindEvents(ctx);
    }

    function bindEvents(ctx) {
        const root = document.getElementById("landxml-controls");
        if (!root) return;

        root.querySelector("#btn-landxml-sample")?.addEventListener("click", () => {
            const ta = root.querySelector("#landxml-input");
            if (ta) ta.value = sampleLandXML();
            processText(ta.value, ctx);
        });

        root.querySelector("#btn-landxml-parse")?.addEventListener("click", () => {
            const ta = root.querySelector("#landxml-input");
            if (ta) processText(ta.value, ctx);
        });

        root.querySelector("#btn-landxml-send")?.addEventListener("click", () => {
            if (!_lastParsed || !_lastParsed.parcels.length) {
                notify(ctx, "Parse a LandXML file with parcels first.", true);
                return;
            }
            const figModel = toFiguresModel(_lastParsed);
            if (window.Linework?.loadFigures) {
                window.Linework.loadFigures(figModel.figures);
                notify(ctx, `Sent ${figModel.figures.length} LandXML parcel(s) to Linework Editor.`);
                document.querySelector('.nav-btn[data-tab="tab-linework"]')?.click();
            } else {
                notify(ctx, "Linework Editor is not available.", true);
            }
        });

        root.querySelector("#btn-landxml-download")?.addEventListener("click", () => {
            const ta = root.querySelector("#landxml-input");
            const content = ta ? ta.value.trim() : "";
            if (!content) {
                notify(ctx, "No LandXML content to download.", true);
                return;
            }
            if (window.COGO?.downloadText) {
                window.COGO.downloadText("export.xml", content, "application/xml");
            }
        });
    }

    function processText(text, ctx) {
        try {
            const parsed = parseLandXML(text);
            _lastParsed = parsed;

            // Update stats
            document.getElementById("stat-landxml-points").textContent = parsed.points.length;
            document.getElementById("stat-landxml-parcels").textContent = parsed.parcels.length;
            document.getElementById("stat-landxml-alignments").textContent = parsed.alignments.length;
            document.getElementById("stat-landxml-surfaces").textContent = parsed.surfaces.length;

            const tables = document.getElementById("landxml-tables");
            if (tables) tables.classList.remove("hidden");

            // Render tables
            renderParcelsList(parsed.parcels);
            renderPointsList(parsed.points);

            // Draw canvas
            drawCanvas(parsed);

            notify(ctx, `Parsed LandXML: ${parsed.parcels.length} parcel(s), ${parsed.points.length} point(s).`);
        } catch (err) {
            notify(ctx, `LandXML parse error: ${err.message}`, true);
        }
    }

    function renderParcelsList(parcels) {
        const el = document.getElementById("landxml-parcels-list");
        if (!el) return;

        if (!parcels.length) {
            window.setSafeHTML(el, `<div style="padding:0.75rem; color:var(--text-muted); font-size:0.8rem;">No parcels in this LandXML document.</div>`);
            return;
        }

        const rows = parcels.map(p => `
            <div style="padding:0.5rem 0.75rem; border-bottom:1px solid var(--glass-border); font-size:0.8rem; display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <strong style="color:var(--text-primary);">${clean(p.name)}</strong>
                    <div style="font-size:0.72rem; color:var(--text-muted);">${clean(p.desc || p.parcelType)}</div>
                </div>
                <div style="text-align:right;">
                    <div style="font-weight:600; color:var(--accent);">${Number(p.area).toLocaleString()} SF</div>
                    <div style="font-size:0.72rem; color:var(--text-muted);">${(p.area / 43560).toFixed(3)} AC</div>
                </div>
            </div>
        `).join("");

        window.setSafeHTML(el, rows);
    }

    function renderPointsList(points) {
        const el = document.getElementById("landxml-points-list");
        const countEl = document.getElementById("landxml-points-count");
        if (countEl) countEl.textContent = points.length;
        if (!el) return;

        if (!points.length) {
            window.setSafeHTML(el, `<div style="padding:0.75rem; color:var(--text-muted); font-size:0.8rem;">No CgPoints found.</div>`);
            return;
        }

        const rows = points.slice(0, 50).map(p => `
            <div style="padding:0.35rem 0.6rem; border-bottom:1px solid var(--glass-border); font-size:0.75rem; font-family:var(--font-mono); display:flex; justify-content:space-between;">
                <span><strong>#${clean(p.name)}</strong> ${clean(p.code)}</span>
                <span style="color:var(--text-muted);">N:${Number(p.northing).toFixed(2)} E:${Number(p.easting).toFixed(2)}</span>
            </div>
        `).join("");

        const footer = points.length > 50 ? `<div style="padding:0.4rem; font-size:0.72rem; color:var(--text-muted); text-align:center;">Showing first 50 of ${points.length} points</div>` : "";
        window.setSafeHTML(el, rows + footer);
    }

    function drawCanvas(parsed) {
        const cvs = document.getElementById("landxml-canvas");
        if (!cvs || !cvs.getContext) return;
        const ctx = cvs.getContext("2d");
        const w = cvs.width, h = cvs.height;
        ctx.clearRect(0, 0, w, h);

        // Collect all coordinates to compute bounding box
        const coords = [];
        (parsed.points || []).forEach(p => coords.push({ x: p.easting, y: p.northing }));
        (parsed.parcels || []).forEach(prc => (prc.vertices || []).forEach(v => coords.push({ x: v.e, y: v.n })));
        (parsed.alignments || []).forEach(al => (al.vertices || []).forEach(v => coords.push({ x: v.e, y: v.n })));

        if (!coords.length) return;

        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        coords.forEach(c => {
            if (c.x < minX) minX = c.x;
            if (c.x > maxX) maxX = c.x;
            if (c.y < minY) minY = c.y;
            if (c.y > maxY) maxY = c.y;
        });

        const spanX = Math.max(maxX - minX, 10);
        const spanY = Math.max(maxY - minY, 10);
        const pad = 25;
        const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);

        const toScreen = (e, n) => ({
            x: pad + (e - minX) * scale,
            y: h - pad - (n - minY) * scale
        });

        // Draw grid lines
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.lineWidth = 1;
        for (let gx = 0; gx < w; gx += 40) {
            ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
        }
        for (let gy = 0; gy < h; gy += 40) {
            ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
        }

        // Draw Parcels
        ctx.strokeStyle = "#38bdf8"; // Sky blue
        ctx.fillStyle = "rgba(56, 189, 248, 0.12)";
        ctx.lineWidth = 2;

        (parsed.parcels || []).forEach(prc => {
            if (!prc.vertices || prc.vertices.length < 2) return;
            ctx.beginPath();
            const start = toScreen(prc.vertices[0].e, prc.vertices[0].n);
            ctx.moveTo(start.x, start.y);
            for (let i = 1; i < prc.vertices.length; i++) {
                const pt = toScreen(prc.vertices[i].e, prc.vertices[i].n);
                ctx.lineTo(pt.x, pt.y);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
        });

        // Draw Alignments
        ctx.strokeStyle = "#f59e0b"; // Amber
        ctx.lineWidth = 2.5;
        (parsed.alignments || []).forEach(al => {
            if (!al.vertices || al.vertices.length < 2) return;
            ctx.beginPath();
            const start = toScreen(al.vertices[0].e, al.vertices[0].n);
            ctx.moveTo(start.x, start.y);
            for (let i = 1; i < al.vertices.length; i++) {
                const pt = toScreen(al.vertices[i].e, al.vertices[i].n);
                ctx.lineTo(pt.x, pt.y);
            }
            ctx.stroke();
        });

        // Draw CgPoints
        ctx.fillStyle = "#ef4444"; // Red
        (parsed.points || []).forEach(p => {
            const sc = toScreen(p.easting, p.northing);
            ctx.beginPath();
            ctx.arc(sc.x, sc.y, 3.5, 0, 2 * Math.PI);
            ctx.fill();
        });

        const hud = document.getElementById("landxml-hud");
        if (hud) hud.textContent = `Bounding box: ${minX.toFixed(0)}..${maxX.toFixed(0)} E, ${minY.toFixed(0)}..${maxY.toFixed(0)} N`;
    }

    // ── Plugin Object & Public API ──────────────────────────────────────────

    const Plugin = {
        init(ctx) {
            renderUI(ctx);
        },
        onTabActivate(ctx) {
            renderUI(ctx);
        }
    };

    window.LandXML = {
        parseLandXML,
        buildLandXML,
        toFiguresModel,
        fromFiguresModel,
        sampleLandXML,
        getLastParsed: () => _lastParsed
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);
})();
