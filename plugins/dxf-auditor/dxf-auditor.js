/**
 * Plugin: dxf-auditor (DXF Project Auditor)
 * plugins/dxf-auditor/dxf-auditor.js
 *
 * FDOT DXF file dropzone, audit pipeline, canvas geometry renderer,
 * bowtie visual marker, NAD83 coordinate HUD, and sample DXF loaders.
 * Registers via window.PluginRegistry.
 *
 * Dependencies: spatial-engine, security-pki
 */
(function () {
    const MANIFEST = {
        name: "dxf-auditor",
        version: "2.6.0",
        description: "FDOT DXF CADD compliance auditor with canvas renderer and bowtie detector.",
        tab: "tab-dxf-inspector",
        icon: "fa-file-circle-check",
        tier: "Free",
        dependencies: ["spatial-engine", "security-pki", "cms-engine"]
    };

    let _ctx = null;
    let _inspector = null;
    let _currentCanvasTransform = null;

    // ── Pure helpers (exposed as window.DxfAuditor for the test suite) ──────────

    /** Score band shared by the dashboard colour and the CMS submittal status. */
    function scoreBand(score) {
        if (score >= 80) return { status: "PASSED", color: "var(--success)" };
        if (score >= 50) return { status: "NEEDS REVIEW", color: "var(--warning)" };
        return { status: "FAILED", color: "var(--danger)" };
    }

    /** Plain-text audit log stored in the Reports Hub. */
    function buildAuditLog(filename, audit) {
        let log = `=== FDOT DXF Project Audit Report ===\r\n`;
        log += `File: ${filename}\r\n`;
        log += `Compliance Score: ${audit.score}%\r\n`;
        log += `Layers: ${audit.layersCount} | Entities: ${audit.entitiesCount}\r\n`;
        log += `Total Issues Flagged: ${audit.issues.length}\r\n\r\n`;
        log += `--- Itemized Issues ---\r\n`;
        audit.issues.forEach(iss => {
            log += `[${iss.severity}] ${iss.title}: ${iss.description} (Layer: ${iss.layer || 'N/A'})\r\n`;
        });
        return log;
    }

    /** Drawing extents over every entity with finite coordinates; null when there are none. */
    function entityExtents(entities) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        const stretch = (x, y) => {
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        };
        entities.forEach(ent => {
            if (ent.type === "LINE") {
                stretch(ent.startX, ent.startY);
                stretch(ent.endX, ent.endY);
            } else if (ent.type === "ARC" || ent.type === "CIRCLE") {
                const r = ent.radius || 0;
                stretch(ent.startX - r, ent.startY - r);
                stretch(ent.startX + r, ent.startY + r);
            } else if (ent.vertices && ent.vertices.length) {
                ent.vertices.forEach(v => stretch(v.x, v.y));
            } else {
                // TEXT / MTEXT / INSERT / POINT — single insertion point
                stretch(ent.startX, ent.startY);
            }
        });
        return minX === Infinity ? null : { minX, minY, maxX, maxY };
    }

    /** World → canvas transform that fits `box` in a w × h canvas with `pad` px margins (y up). */
    function fitTransform(box, w, h, pad) {
        const dx = (box.maxX - box.minX) || 1, dy = (box.maxY - box.minY) || 1;
        const scale = Math.min((w - pad * 2) / dx, (h - pad * 2) / dy);
        return { minX: box.minX, minY: box.minY, scale, pad, w, h,
            sx: x => pad + (x - box.minX) * scale, sy: y => h - (pad + (y - box.minY) * scale) };
    }

    /** Stroke colour / width for an entity: layer 0 red, roads blue, boundaries green (red on a bow-tie), else amber. */
    function entityStyle(layer, hasBowtie) {
        const isLayer0 = layer === "0";
        const isRoad = layer.startsWith("ROAD_") || layer.includes("ALIGN");
        const isBoundary = layer.includes("BND") || layer.includes("BOUNDARY") || layer.includes("R/W");
        return {
            stroke: isLayer0 ? "#ef4444" : (isRoad ? "#38bdf8" : (isBoundary ? (hasBowtie ? "#f43f5e" : "#34d399") : "#f59e0b")),
            width: isBoundary ? 2.5 : 1.75
        };
    }

    // ── Audit Pipeline ───────────────────────────────────────────────────────

    async function auditDXFText(dxfText, filename) {
        if (!_inspector) return;
        // window.App is never defined anywhere in this app; _ctx.showToast is the real path.
        if (_ctx?.showToast) _ctx.showToast(`Auditing DXF file: ${filename}...`);

        const parsed = _inspector.parseDXF(dxfText);
        const audit  = _inspector.inspectProject(parsed);
        if (_ctx && _ctx.state) _ctx.state.currentDXFAudit = { filename, parsed, audit, rawContent: dxfText };

        // Feed entities into spatial engine
        if (window.BoundaryQCWASM?.processDXFSpatialStream) {
            const telemetry = window.BoundaryQCWASM.processDXFSpatialStream(dxfText, parsed.entities);
            const hud = document.getElementById("dxf-wasm-hud");
            if (hud && telemetry) {
                window.setSafeHTML(hud, `<i class="fa-solid fa-microchip"></i> R-Tree: ${telemetry.entitiesIndexed} entities indexed in ${telemetry.parseTimeMs} ms`);
            }
        }

        const dashboard = document.getElementById("dxf-audit-dashboard");
        if (dashboard) dashboard.classList.remove("hidden");

        const scoreEl = document.getElementById("stat-dxf-score");
        if (scoreEl) {
            scoreEl.textContent = `${audit.score}%`;
            scoreEl.style.color = scoreBand(audit.score).color;
        }
        const countsEl = document.getElementById("stat-dxf-counts");
        if (countsEl) countsEl.textContent = `${audit.layersCount} Layers / ${audit.entitiesCount} Entities`;
        const issuesEl = document.getElementById("stat-dxf-issues-count");
        if (issuesEl) issuesEl.textContent = audit.issues.length;

        renderDXFCanvas(parsed.entities, audit.issues);
        renderDXFIssues(audit.issues);

        if (window.Reports?.addReport) {
            const log = buildAuditLog(filename, audit);
            window.Reports.addReport({
                id: `dxf_audit_${filename.replace(/\W+/g, "_")}`,
                title: `DXF Audit: ${filename}`,
                type: "dxf-audit",
                category: "dxf",
                format: "log",
                filename: `${filename.replace(/\.dxf$/i, "")}_audit.log`,
                content: log,
                metadata: { score: audit.score, issuesCount: audit.issues.length }
            });
        }

        await recordAuditToCMS(filename, audit, dxfText);
    }

    /**
     * Record this audit — whether the drawing came from a live upload or from
     * clicking a bundled sample — into the CMS Submittal Vault (see
     * plugins/cms-engine/cms-engine.js), so real usage shows up next to the
     * seeded demo project/submittal records instead of never appearing there.
     * No-op when signed out; never invents a submitter or a fake precision.
     */
    async function recordAuditToCMS(filename, audit, dxfText) {
        if (!window.BoundaryQCCMS || !window.BoundaryQCCMS.isAuthenticated()) return;
        const bowtieDetected = audit.issues.some(i => i.category === "Bow-Tie / Self-Intersection");
        const sha256 = window.BoundaryQCSecurity ? await window.BoundaryQCSecurity.computeTextSHA256(dxfText) : "";
        const status = scoreBand(audit.score).status;
        window.BoundaryQCCMS.addSubmittal(
            null, filename, status, audit.score,
            "n/a — layer/geometry audit only, no traverse closure computed",
            bowtieDetected, sha256
        );
    }

    function renderDXFIssues(issues) {
        const container = document.getElementById("dxf-issues-container");
        if (!container) return;
        container.replaceChildren();
        if (issues.length === 0) {
            window.setSafeHTML(container, `<div style="color:var(--success); padding:1rem; text-align:center;"><i class="fa-solid fa-circle-check"></i> No compliance issues detected.</div>`);
            return;
        }
        issues.forEach(issue => {
            const div = document.createElement("div");
            div.className = `qc-item ${issue.severity?.toLowerCase() || "warn"}`;
            // issue.title / .category / .description embed DXF-supplied layer names — sanitize before injecting.
            window.setSafeHTML(div, `
                <div class="qc-item-icon"><i class="fa-solid ${issue.severity === "ERROR" ? "fa-xmark" : "fa-triangle-exclamation"}"></i></div>
                <div class="qc-item-content">
                    <h4>${issue.title} <span class="tag tag-discipline">${issue.category}</span></h4>
                    <p>${issue.description}</p>
                </div>`);
            container.appendChild(div);
        });
    }

    function renderDXFCanvas(entities, issues = []) {
        const canvas = document.getElementById("dxf-canvas");
        if (!canvas) return;
        const rect = canvas.parentElement.getBoundingClientRect();
        const dpr  = window.devicePixelRatio || 1;
        canvas.width  = (rect.width  || 600) * dpr;
        canvas.height = (rect.height || 400) * dpr;
        const ctx = canvas.getContext("2d");
        ctx.scale(dpr, dpr);
        const w = rect.width  || 600;
        const h = rect.height || 400;

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "#030712";
        ctx.fillRect(0, 0, w, h);

        if (!entities.length) {
            ctx.fillStyle = "#64748b";
            ctx.font = "500 14px 'Inter', sans-serif";
            ctx.fillText("No CAD geometry entities found in DXF.", w / 2 - 120, h / 2);
            return;
        }

        // A drawing whose entities carry no finite coordinates still gets a (blank) view frame.
        const box = entityExtents(entities) || { minX: 0, minY: 0, maxX: 500, maxY: 300 };
        const tf = fitTransform(box, w, h, 50);
        _currentCanvasTransform = { minX: tf.minX, minY: tf.minY, scale: tf.scale, pad: tf.pad, w, h };
        const sx = tf.sx, sy = tf.sy;

        // CAD grid
        ctx.strokeStyle = "rgba(56,189,248,0.06)"; ctx.lineWidth = 1;
        for (let x = 0; x < w; x += 30) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
        for (let y = 0; y < h; y += 30) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }

        ctx.strokeStyle = "rgba(56,189,248,0.15)";
        ctx.beginPath(); ctx.moveTo(w/2,0); ctx.lineTo(w/2,h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0,h/2); ctx.lineTo(w,h/2); ctx.stroke();

        ctx.lineCap = "round"; ctx.lineJoin = "round";
        const hasBowtie = issues.some(i => i.category === "Bow-Tie / Self-Intersection");

        entities.forEach(ent => {
            const style = entityStyle(ent.layer, hasBowtie);
            ctx.strokeStyle = style.stroke;
            ctx.lineWidth = style.width;

            if (ent.type === "LINE") {
                ctx.beginPath(); ctx.moveTo(sx(ent.startX), sy(ent.startY)); ctx.lineTo(sx(ent.endX), sy(ent.endY)); ctx.stroke();
            }
            if (ent.type === "LWPOLYLINE" && ent.vertices?.length > 1) {
                ctx.beginPath(); ctx.moveTo(sx(ent.vertices[0].x), sy(ent.vertices[0].y));
                for (let i = 1; i < ent.vertices.length; i++) ctx.lineTo(sx(ent.vertices[i].x), sy(ent.vertices[i].y));
                if (ent.closed) ctx.closePath();
                ctx.stroke();
                ent.vertices.forEach(v => {
                    ctx.fillStyle = hasBowtie ? "#e11d48" : "#ef4444";
                    ctx.beginPath(); ctx.arc(sx(v.x), sy(v.y), 4.5, 0, Math.PI * 2); ctx.fill();
                    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
                });
            }
        });

        if (hasBowtie) {
            ctx.fillStyle = "rgba(225,29,72,0.25)";
            ctx.beginPath(); ctx.arc(w/2, h/2, 32, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = "#f43f5e"; ctx.lineWidth = 2; ctx.stroke();
            ctx.fillStyle = "#fff"; ctx.font = "bold 11px 'JetBrains Mono', monospace";
            ctx.fillText("BOWTIE SELF-INTERSECTION", w/2 - 85, h/2 - 38);
        }
    }

    // ── Sample DXF Generators ────────────────────────────────────────────────

    const SR50_DXF = `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n5\n0\nLAYER\n2\nDESIGN_R/W\n70\n0\n62\n3\n6\nCONTINUOUS\n0\nLAYER\n2\nROAD_EOP_PR\n70\n0\n62\n1\n6\nCONTINUOUS\n0\nLAYER\n2\nPROP_BOUNDARY\n70\n0\n62\n2\n6\nCONTINUOUS\n0\nLAYER\n2\nALIGNMENT\n70\n0\n62\n4\n6\nCENTER2\n0\nLAYER\n2\nDRAIN_POND_PR\n70\n0\n62\n5\n6\nCONTINUOUS\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\nDESIGN_R/W\n90\n4\n70\n1\n43\n0.0\n10\n500000.00\n20\n1500000.00\n10\n500740.58\n20\n1500000.00\n10\n500740.58\n20\n1500921.20\n10\n500000.00\n20\n1500921.20\n0\nENDSEC\n0\nEOF`;

    const BOWTIE_DXF = `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n9\n$INSUNITS\n70\n6\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n2\n0\nLAYER\n2\nPROP_BOUNDARY\n70\n0\n62\n2\n6\nCONTINUOUS\n0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\nPROP_BOUNDARY\n90\n5\n70\n1\n43\n0.0\n10\n1000.00\n20\n1000.00\n10\n1500.00\n20\n1500.00\n10\n1500.00\n20\n1000.00\n10\n1000.00\n20\n1500.00\n10\n1000.00\n20\n1000.00\n0\nENDSEC\n0\nEOF`;

    // Non-compliant drainage basin: entities on Layer 0, a bad layer prefix, a wrong ACI color,
    // a Defpoints layer, a zero-length line, and coordinates outside the Florida State Plane envelope.
    const NONCOMPLIANT_DXF = `0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n2\nLAYER\n70\n4\n0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n0\nLAYER\n2\nDEFPOINTS\n70\n0\n62\n7\n6\nCONTINUOUS\n0\nLAYER\n2\nBASIN_STUFF\n70\n0\n62\n42\n6\nCONTINUOUS\n0\nLAYER\n2\nDRAIN_PIPE_PR\n70\n0\n62\n1\n6\nCONTINUOUS\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\n0\n90\n4\n70\n0\n43\n0.0\n10\n10.00\n20\n20.00\n10\n480.00\n20\n20.00\n10\n480.00\n20\n900.00\n10\n10.00\n20\n900.00\n0\nLINE\n8\nBASIN_STUFF\n10\n250.00\n20\n250.00\n11\n250.00\n21\n250.00\n0\nLINE\n8\nDRAIN_PIPE_PR\n10\n100.00\n20\n100.00\n11\n300.00\n21\n140.00\n0\nENDSEC\n0\nEOF`;

    // Expose DXF samples globally for other plugins and tests
    window.__dxfSamples = { SR50_DXF, BOWTIE_DXF, NONCOMPLIANT_DXF };

    // ── Plugin API ───────────────────────────────────────────────────────────

    const Plugin = {
        init(ctx) {
            _ctx = ctx;
            _inspector = window.FDOTDXFInspector ? new window.FDOTDXFInspector(window.FDOT_DATA) : null;
            // Expose auditDXFText globally so the core app can call it from sample buttons
            window.__dxfAudit = auditDXFText;
        },

        setupEvents(ctx) {
            const dropzone    = document.getElementById("dxf-dropzone");
            const fileInput   = document.getElementById("dxf-file-input");
            const canvas      = document.getElementById("dxf-canvas");

            if (dropzone) {
                dropzone.addEventListener("dragover", e => {
                    e.preventDefault();
                    dropzone.style.borderColor = "var(--accent)";
                    dropzone.style.background  = "var(--accent-light)";
                });
                dropzone.addEventListener("dragleave", () => {
                    dropzone.style.borderColor = "var(--primary)";
                    dropzone.style.background  = "var(--primary-light)";
                });
                dropzone.addEventListener("drop", e => {
                    e.preventDefault();
                    dropzone.style.borderColor = "var(--primary)";
                    dropzone.style.background  = "var(--primary-light)";
                    if (e.dataTransfer.files.length > 0) _readFile(e.dataTransfer.files[0]);
                });
            }

            fileInput?.addEventListener("change", e => {
                if (e.target.files.length > 0) _readFile(e.target.files[0]);
            });

            // "Browse" button + click-anywhere on the dropzone (inline onclick was blocked by CSP).
            document.getElementById("btn-browse-dxf")?.addEventListener("click", () => fileInput?.click());
            dropzone?.addEventListener("click", e => {
                if (e.target.closest("button")) return; // let real buttons handle their own clicks
                fileInput?.click();
            });

            document.getElementById("btn-load-sample-sr50")?.addEventListener("click", () => {
                auditDXFText(SR50_DXF, "fdot_sr50.dxf");
                ctx.showToast("Loaded fdot_sr50.dxf sample.");
            });
            document.getElementById("btn-load-sample-bowtie")?.addEventListener("click", () => {
                auditDXFText(BOWTIE_DXF, "fdot_bowtie.dxf");
                ctx.showToast("Loaded Jacksonville Heights bow-tie sample.");
            });
            document.getElementById("btn-load-sample-drainage")?.addEventListener("click", () => {
                auditDXFText(NONCOMPLIANT_DXF, "fdot_drain.dxf");
                ctx.showToast("Loaded non-compliant drainage basin sample.");
            });

            // NAD83 coordinate HUD on canvas mousemove
            canvas?.addEventListener("mousemove", e => {
                if (!_currentCanvasTransform) return;
                const r = canvas.getBoundingClientRect();
                const t = _currentCanvasTransform;
                const easting  = t.minX + (e.clientX - r.left  - t.pad) / t.scale;
                const northing = t.minY + (t.h - (e.clientY - r.top) - t.pad) / t.scale;
                const hud = document.getElementById("dxf-coord-hud");
                if (hud) window.setSafeHTML(hud, `<i class="fa-solid fa-crosshairs"></i> NAD83 FL: (${easting.toFixed(2)}, ${northing.toFixed(2)}) ft`);
            });

            // Submittal manifest export
            document.getElementById("btn-export-dscr")?.addEventListener("click", async () => {
                const audit = ctx.state.currentDXFAudit;
                if (window.BoundaryQCSecurity && audit) {
                    const manifest = await window.BoundaryQCSecurity.generateFDOTSubmittalManifest(
                        "432109-1-52-01",
                        [{ fileName: audit.filename, content: audit.rawContent || "DXF Content", category: "roadway" }],
                        { name: "Jane Doe, PE", license: "PE12345", rule: "61G15-23.004" }
                    );
                    const blob = new Blob([manifest.manifestJson], { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url; a.download = "FDOT_EDG_Signed_Manifest.json"; a.click();
                    URL.revokeObjectURL(url);
                    ctx.showToast(`Generated Signed Manifest (SHA-256: ${manifest.masterHash.substring(0, 12)}...)`);
                } else {
                    ctx.showToast("Exported FDOT Rules!");
                }
            });

            // CADD self-check summary generator (unofficial — see security-pki.generateSubmittalCertificate)
            document.getElementById("btn-dxf-submittal-cert")?.addEventListener("click", async () => {
                const audit = ctx.state.currentDXFAudit;
                if (!audit) {
                    ctx.showToast("Run or load a DXF audit first.", true);
                    return;
                }
                if (window.BoundaryQCSecurity) {
                    const cert = await window.BoundaryQCSecurity.generateSubmittalCertificate({
                        filename: audit.filename,
                        content: audit.rawContent || "",
                        score: audit.audit.score,
                        violationsCount: audit.audit.issues.length,
                        layersCount: audit.audit.layersCount,
                        entitiesCount: audit.audit.entitiesCount,
                        standardName: "FDOT 2026 CADD State Kit Standard",
                        autoHealReady: audit.audit.issues.length > 0
                    });
                    if (ctx.showSubmittalCertificateModal) {
                        ctx.showSubmittalCertificateModal(cert);
                    } else if (window.showSubmittalCertificateModal) {
                        window.showSubmittalCertificateModal(cert);
                    }
                }
            });
        }
    };

    function _readFile(file) {
        const reader = new FileReader();
        reader.onload = e => auditDXFText(e.target.result, file.name);
        reader.readAsText(file);
    }

    window.PluginRegistry.register(MANIFEST, Plugin);

    window.DxfAuditor = { scoreBand, buildAuditLog, entityExtents, fitTransform, entityStyle };
})();
