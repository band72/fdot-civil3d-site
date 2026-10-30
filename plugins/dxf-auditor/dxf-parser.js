/* FDOT Civil3D Standards - DXF Parser & CADD Scripting Inspector Engine */

class FDOTDXFInspector {
    constructor(fdotStandardsData) {
        this.standards = fdotStandardsData;
        this.fdotLayerMap = new Map();
        this.fdotStandardsDataLayers = fdotStandardsData.layers || [];
        
        this.fdotStandardsDataLayers.forEach(l => {
            this.fdotLayerMap.set(l.name.toUpperCase(), l);
        });
    }

    /**
     * Split a DXF text stream into (groupCode, value) pairs.
     *
     * DXF is a flat stream where every group code sits on its own line followed by
     * its value on the next. Walking it pair-by-pair (rather than stepping a fixed
     * even/odd index) means a stray blank line, a trailing newline, leading
     * whitespace on a code line, CRLF endings, or a corrupt line can't shift every
     * subsequent pair out of phase — the reader just resynchronises on the next
     * line that looks like a group code.
     * @param {string} dxfText
     * @returns {Array<[number, string]>}
     */
    tokenizeDXF(dxfText) {
        const raw = String(dxfText == null ? "" : dxfText).split(/\r?\n/);
        const pairs = [];
        let i = 0;
        while (i < raw.length) {
            // Find the next group-code line, skipping blanks / non-numeric noise.
            let code = null;
            while (i < raw.length) {
                const tok = raw[i].trim();
                i++;
                if (tok === "") continue;                       // blank line between records
                if (!/^[-+]?\d{1,4}$/.test(tok)) continue;      // not a group code — resync
                code = parseInt(tok, 10);
                break;
            }
            if (code === null || i >= raw.length) break;        // out of input / dangling code
            pairs.push([code, raw[i].trim()]);                  // value may legitimately be ""
            i++;
        }
        return pairs;
    }

    parseDXF(dxfText) {
        let inEntities = false;
        let inTables = false;
        let currentSection = "";

        const layers = [];
        const entities = [];
        let currentEntity = null;
        let currentLayer = null;
        let openPolyline = null;    // old-style POLYLINE header while its VERTEX children stream in
        let inLayerTable = false;   // true only between `0/TABLE 2/LAYER` and `0/ENDTAB`
        let expectTableName = false;

        const pushed = new WeakSet();
        const pushEntity = (e) => {
            if (e && e.type !== "VERTEX" && !pushed.has(e)) { pushed.add(e); entities.push(e); }
        };

        for (const [code, value] of this.tokenizeDXF(dxfText)) {
            if (code === 0 && value === "SECTION") {
                currentSection = "";
                continue;
            }

            if (code === 2 && currentSection === "") {
                currentSection = value;
                if (currentSection === "ENTITIES") inEntities = true;
                if (currentSection === "TABLES") inTables = true;
                continue;
            }

            if (code === 0 && value === "ENDSEC") {
                inEntities = false;
                inTables = false;
                inLayerTable = false;
                currentSection = "";
                continue;
            }

            // Track which table we are inside — only the LAYER table feeds the layer list.
            if (inTables && code === 0 && value === "TABLE") {
                expectTableName = true;
                continue;
            }
            if (inTables && expectTableName && code === 2) {
                inLayerTable = value === "LAYER";
                expectTableName = false;
                continue;
            }
            if (inTables && code === 0 && value === "ENDTAB") {
                if (currentLayer) { layers.push(currentLayer); currentLayer = null; }
                inLayerTable = false;
                continue;
            }

            // Parse Layer Table records
            if (inLayerTable && code === 0 && value === "LAYER") {
                if (currentLayer) layers.push(currentLayer);
                currentLayer = { name: "", color: 7, linetype: "CONTINUOUS", lineweight: null, plot: true };
                continue;
            }

            if (inLayerTable && currentLayer) {
                if (code === 2) currentLayer.name = value;
                if (code === 62) currentLayer.color = Math.abs(parseInt(value, 10));
                if (code === 6) currentLayer.linetype = value;
                if (code === 290) currentLayer.plot = value === "1";
                if (code === 370) currentLayer.lineweight = parseInt(value, 10); // 1/100 mm, or -1/-2/-3
            }

            // Parse Entities Section
            if (inEntities && code === 0) {
                // SEQEND closes an old-style POLYLINE — its VERTEX children are already attached.
                if (value === "SEQEND") {
                    pushEntity(currentEntity);
                    currentEntity = null;
                    openPolyline = null;
                    continue;
                }

                // A VERTEX belongs to the currently-open POLYLINE, not a standalone entity.
                if (value === "VERTEX" && openPolyline) {
                    const v = { x: 0, y: 0 };
                    openPolyline.vertices.push(v);
                    currentEntity = { type: "VERTEX", __vertex: v };
                    continue;
                }

                pushEntity(currentEntity);

                const entityType = value;
                if (["LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "TEXT", "MTEXT", "INSERT", "POINT"].includes(entityType)) {
                    // Normalise the old heavy POLYLINE to LWPOLYLINE so every downstream
                    // consumer (auditor, spatial index, canvas) treats them the same.
                    const isOldPoly = entityType === "POLYLINE";
                    currentEntity = {
                        type: isOldPoly ? "LWPOLYLINE" : entityType,
                        layer: "0",
                        color: 256, // BYLAYER
                        vertices: [],
                        startX: 0, startY: 0, endX: 0, endY: 0,
                        radius: 0, text: "", closed: false
                    };
                    if (isOldPoly) {
                        // A heavy POLYLINE is emitted now — its VERTEX children mutate it
                        // by reference, so it is complete by the time SEQEND arrives.
                        currentEntity.__heavy = true;
                        openPolyline = currentEntity;
                        pushEntity(currentEntity);
                    }
                } else {
                    currentEntity = null;
                }
                openPolyline = (currentEntity && currentEntity.__heavy) ? openPolyline : null;
                continue;
            }

            if (inEntities && currentEntity && currentEntity.type === "VERTEX") {
                if (code === 10) currentEntity.__vertex.x = parseFloat(value);
                if (code === 20) currentEntity.__vertex.y = parseFloat(value);
                if (code === 30) currentEntity.__vertex.z = parseFloat(value);
                if (code === 42) currentEntity.__vertex.bulge = parseFloat(value);
                continue;
            }

            if (inEntities && currentEntity) {
                if (code === 8) currentEntity.layer = value.toUpperCase();
                if (code === 62) currentEntity.color = Math.abs(parseInt(value, 10));
                if (code === 67) currentEntity.paperSpace = value === "1";
                if (code === 230) currentEntity.extrusionZ = parseFloat(value);   // OCS normal Z (−1 = mirrored)

                if (currentEntity.type === "LINE") {
                    if (code === 10) currentEntity.startX = parseFloat(value);
                    if (code === 20) currentEntity.startY = parseFloat(value);
                    if (code === 11) currentEntity.endX = parseFloat(value);
                    if (code === 21) currentEntity.endY = parseFloat(value);
                    if (code === 30) currentEntity.startZ = parseFloat(value);
                    if (code === 31) currentEntity.endZ = parseFloat(value);
                }

                if (currentEntity.type === "LWPOLYLINE") {
                    if (code === 70) {
                        currentEntity.flags = parseInt(value, 10);              // bit 8 = 3D polyline
                        currentEntity.closed = (currentEntity.flags & 1) === 1;
                    }
                    if (code === 38) currentEntity.elevation = parseFloat(value);   // LWPOLYLINE elevation
                    if (code === 30 && currentEntity.__heavy) currentEntity.elevation = parseFloat(value); // 2D POLYLINE header Z
                    // The heavy POLYLINE header carries a dummy 10/20/30 — ignore it; the
                    // real geometry arrives as VERTEX children.
                    if (!currentEntity.__heavy) {
                        if (code === 10) {
                            currentEntity.vertices.push({ x: parseFloat(value), y: 0 });
                        }
                        if (code === 20 && currentEntity.vertices.length > 0) {
                            currentEntity.vertices[currentEntity.vertices.length - 1].y = parseFloat(value);
                        }
                        if (code === 42 && currentEntity.vertices.length > 0) {
                            currentEntity.vertices[currentEntity.vertices.length - 1].bulge = parseFloat(value);
                        }
                    }
                }

                if (currentEntity.type === "ARC" || currentEntity.type === "CIRCLE") {
                    if (code === 10) currentEntity.startX = parseFloat(value);
                    if (code === 20) currentEntity.startY = parseFloat(value);
                    if (code === 30) currentEntity.startZ = parseFloat(value);   // centre Z
                    if (code === 40) currentEntity.radius = parseFloat(value);
                    if (code === 50) currentEntity.startAngle = parseFloat(value);
                    if (code === 51) currentEntity.endAngle = parseFloat(value);
                }

                if (currentEntity.type === "TEXT" || currentEntity.type === "MTEXT") {
                    if (code === 1) currentEntity.text = value;
                    if (code === 10) currentEntity.startX = parseFloat(value);
                    if (code === 20) currentEntity.startY = parseFloat(value);
                    if (code === 30) currentEntity.startZ = parseFloat(value);
                }

                if (currentEntity.type === "INSERT") {
                    if (code === 2) currentEntity.text = value; // Block Name
                    if (code === 10) currentEntity.startX = parseFloat(value);
                    if (code === 20) currentEntity.startY = parseFloat(value);
                }
            }
        }

        if (currentLayer) layers.push(currentLayer);
        pushEntity(currentEntity);

        // Drop the internal bookkeeping markers before handing entities back.
        entities.forEach(e => { delete e.__heavy; delete e.__vertex; });

        return { layers, entities };
    }

    inspectProject(parsedDXF) {
        const { layers, entities } = parsedDXF;
        const issues = [];
        let score = 100;

        const disciplinePrefixes = ["ROAD_", "DRAIN_", "SURV_", "UTIL_", "STR_", "RW_", "ENV_", "TRAF_", "LIGHT_"];
        const entityLayerCounts = {};

        // Every valid DXF has a layer named "0" — the DXF spec requires it and no CAD
        // application lets you delete it. So this can't be "layer 0 exists", only "something
        // is actually drawn on it" (entities is already destructured above for this).
        const hasEntityOnLayerZero = entities.some(e => String(e.layer).toUpperCase() === "0");

        // 1. Audit Layers
        layers.forEach(layer => {
            const layerName = layer.name.toUpperCase();

            if (layerName === "0") {
                if (hasEntityOnLayerZero) {
                    issues.push({
                        severity: "CRITICAL",
                        category: "CADD Standards",
                        title: "Entities on Layer 0",
                        description: "Layer 0 should not contain project design elements. Move entities to FDOT discipline layers.",
                        layer: "0"
                    });
                    score -= 10;
                }
            } else if (layerName === "DEFPOINTS") {
                issues.push({
                    severity: "WARNING",
                    category: "CADD Standards",
                    title: "Defpoints Layer Usage",
                    description: "Defpoints layer detected. FDOT standards mandate using `ROAD_NOPLOT_WORK` for non-plotting geometry.",
                    layer: "DEFPOINTS"
                });
                score -= 5;
            } else {
                const hasValidPrefix = disciplinePrefixes.some(prefix => layerName.startsWith(prefix));
                if (!hasValidPrefix) {
                    issues.push({
                        severity: "HIGH",
                        category: "Naming Convention",
                        title: "Non-Compliant FDOT Layer Prefix",
                        description: `Layer \`${layer.name}\` does not start with an official FDOT discipline prefix (e.g. ROAD_, DRAIN_, SURV_).`,
                        layer: layer.name
                    });
                    score -= 8;
                }

                // Check standard color match
                const stdLayer = this.fdotLayerMap.get(layerName);
                if (stdLayer && layer.color !== 256 && layer.color !== stdLayer.color) {
                    issues.push({
                        severity: "MEDIUM",
                        category: "Symbology Error",
                        title: "Non-Standard Layer Color",
                        description: `Layer \`${layer.name}\` color (ACI ${layer.color}) does not match FDOT standard color (ACI ${stdLayer.color}).`,
                        layer: layer.name,
                        stdColor: stdLayer.color
                    });
                    score -= 4;
                }
            }
        });

        // 2. Audit Entities (Scripting & Geometry Errors)
        entities.forEach((ent, idx) => {
            entityLayerCounts[ent.layer] = (entityLayerCounts[ent.layer] || 0) + 1;

            if (ent.layer === "0") {
                issues.push({
                    severity: "CRITICAL",
                    category: "Entity Standard",
                    title: `Entity ${ent.type} placed on Layer 0`,
                    description: `${ent.type} (Entity #${idx+1}) is assigned to Layer 0. Move to an FDOT discipline layer.`,
                    layer: "0"
                });
                score -= 3;
            }

            // Zero-Length Line Check
            if (ent.type === "LINE") {
                const len = Math.hypot(ent.endX - ent.startX, ent.endY - ent.startY);
                if (len < 0.001) {
                    issues.push({
                        severity: "HIGH",
                        category: "Scripting / Geometry Error",
                        title: "Zero-Length Line Detected",
                        description: `Zero-length line entity found at (${ent.startX.toFixed(2)}, ${ent.startY.toFixed(2)}).`,
                        layer: ent.layer
                    });
                    score -= 5;
                }
            }

            // Unclosed Boundary Polyline Check
            if (ent.type === "LWPOLYLINE") {
                const isBoundaryLayer = ent.layer.includes("SURV_BND") || ent.layer.includes("RW_LINE");
                if (isBoundaryLayer && !ent.closed && ent.vertices.length > 2) {
                    // Check if end matches start
                    const first = ent.vertices[0];
                    const last = ent.vertices[ent.vertices.length - 1];
                    const gap = Math.hypot(last.x - first.x, last.y - first.y);
                    
                    if (gap > 0.01) {
                        issues.push({
                            severity: "CRITICAL",
                            category: "Topological Error",
                            title: "Unclosed Boundary Polyline (Gap)",
                            description: `Boundary polygon on layer \`${ent.layer}\` has an unclosed gap of ${gap.toFixed(3)} ft at endpoint.`,
                            layer: ent.layer
                        });
                        score -= 10;
                    }
                }

                // Self-Intersection / Bow-Tie Detection
                if (ent.vertices.length >= 4) {
                    const isSelfIntersecting = this.checkPolylineBowtie(ent.vertices, ent.closed);
                    if (isSelfIntersecting) {
                        issues.push({
                            severity: "CRITICAL",
                            category: "Bow-Tie / Self-Intersection",
                            title: "Self-Intersecting Polyline (Bow-Tie Warning)",
                            description: `Polyline on layer \`${ent.layer}\` crosses over itself, creating a bow-tie topological error.`,
                            layer: ent.layer
                        });
                        score -= 12;
                    }
                }
            }

            // Florida State Plane Datum Coordinate Check
            const px = ent.startX || (ent.vertices.length > 0 ? ent.vertices[0].x : 0);
            const py = ent.startY || (ent.vertices.length > 0 ? ent.vertices[0].y : 0);
            // Skip only when the entity has no position at all (both coords zero). A real
            // Florida State Plane entity never has E==0 or N==0, so `||` still catches a
            // point that sits exactly on one axis.
            if (px !== 0 || py !== 0) {
                if (px < 50000 || px > 3500000 || py < 50000 || py > 4500000) {
                    issues.push({
                        severity: "WARNING",
                        category: "Coordinate Datum",
                        title: "Out-of-Bounds Coordinate Range",
                        description: `Entity at (${px.toFixed(1)}, ${py.toFixed(1)}) falls outside typical Florida State Plane NAD83 US Survey Feet coordinate envelope.`,
                        layer: ent.layer
                    });
                    score -= 3;
                }
            }
        });

        score = Math.max(0, Math.min(100, Math.round(score)));

        return {
            score,
            layersCount: layers.length,
            entitiesCount: entities.length,
            issues,
            entityLayerCounts
        };
    }

    checkPolylineBowtie(vertices, closed = false) {
        // Build the ordered vertex ring. For a closed polyline, append the start point
        // so the final (last -> first) segment is tested for self-intersection too.
        const pts = closed ? vertices.concat([vertices[0]]) : vertices.slice();
        const segCount = pts.length - 1;
        for (let i = 0; i < segCount; i++) {
            for (let j = i + 2; j < segCount; j++) {
                // Skip segments that share a vertex (adjacent, or the wrap-around pair on a ring).
                if (i === 0 && j === segCount - 1 && closed) continue;
                const p1 = pts[i], p2 = pts[i + 1];
                const p3 = pts[j], p4 = pts[j + 1];
                if (this.linesIntersect(p1, p2, p3, p4)) {
                    return true;
                }
            }
        }
        return false;
    }

    linesIntersect(p1, p2, p3, p4) {
        // Orientation-sign epsilon. Kept in step with core/cogo.js's selfIntersects
        // so the DXF auditor and the COGO tools agree on what counts as a crossing.
        const EPS = 1e-9;
        function crossProduct(A, B, C) {
            return (C.y - A.y) * (B.x - A.x) - (B.y - A.y) * (C.x - A.x);
        }
        const cp1 = crossProduct(p1, p2, p3);
        const cp2 = crossProduct(p1, p2, p4);
        const cp3 = crossProduct(p3, p4, p1);
        const cp4 = crossProduct(p3, p4, p2);

        if (((cp1 > EPS && cp2 < -EPS) || (cp1 < -EPS && cp2 > EPS)) &&
            ((cp3 > EPS && cp4 < -EPS) || (cp3 < -EPS && cp4 > EPS))) {
            return true;
        }
        return false;
    }

    generateFixScript(issues) {
        // AutoCAD script (.scr): one command sequence per line, tokens separated by spaces.
        // Leading `_` forces English command names; leading `.` bypasses command redefinition.
        const q = s => `"${String(s).replace(/"/g, "")}"`; // layer names never contain quotes
        let scr = `; FDOT Civil3D Standards - Automated Fix Script (.scr)\n`;
        scr += `; Generated by FDOT Civil3D Standards Inspector\n`;
        scr += `; Review in a scratch copy before running against a production drawing.\n\n`;
        scr += `_.AUDIT _Yes\n`;

        if (issues.some(i => i.layer === "0")) {
            scr += `; Move design geometry off Layer 0 with the Layer Translator (interactive).\n`;
            scr += `_.LAYTRANS\n`;
        }

        // Reset non-standard layer colors to their FDOT ACI value.
        issues.filter(i => i.category === "Symbology Error" && i.stdColor).forEach(issue => {
            scr += `_.-LAYER _Color ${issue.stdColor} ${q(issue.layer)}  _Exit\n`;
        });

        scr += `_.-PURGE _All * _No\n`;
        scr += `_.OVERKILL _All \n`; // opens the OVERKILL dialog on the full selection
        scr += `_.QSAVE\n`;
        return scr;
    }
}

// Global export for explicit window access
window.FDOTDXFInspector = FDOTDXFInspector;
