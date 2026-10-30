/**
 * BoundaryQC & FDOT Civil3D Standards — Core Application Coordinator
 * core/app.js
 *
 * Coordinates global state, non-blocking modal system, tab routing,
 * core catalog renderers, and dispatches lifecycle events to all
 * registered feature plugins via window.PluginRegistry.
 */

document.addEventListener("DOMContentLoaded", () => {
    // Public test build: the demo sign-in / checkout / admin UI is removed before any
    // plugin initialises (core/build-info.js; pages.yml sets publicBuild: true).
    if (window.BUILD_INFO && window.BUILD_INFO.publicBuild) {
        document.querySelectorAll("[data-demo]").forEach(el => el.remove());
    }

    // Footer: version · commit · build date, and a "Report a problem" link that pre-fills the
    // issue form on the public site repo with this build (DOM API only — no HTML parsing).
    (function renderFooter() {
        const footer = document.getElementById("app-footer");
        if (!footer) return;
        const b = window.BUILD_INFO || {};
        const build = [b.version ? `v${b.version}` : null, b.commit || "dev", b.builtAt ? String(b.builtAt).slice(0, 10) : null].filter(Boolean).join(" · ");
        const span = document.createElement("span");
        span.textContent = `Build ${build}`;
        const link = document.createElement("a");
        link.href = "https://github.com/band72/fdot-civil3d-site/issues/new?template=problem.yml&build=" + encodeURIComponent(build);
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = "Report a problem";
        const log = document.createElement("a");
        log.href = "https://github.com/band72/fdot-civil3d-site/blob/main/CHANGELOG.md";
        log.target = "_blank";
        log.rel = "noopener";
        log.textContent = "What's new";
        const note = document.createElement("span");
        note.textContent = "Reference data is illustrative — not design-ready.";
        footer.replaceChildren(span, link, log, note);
    })();

    // Narrow screens: nav buttons show icons only, so give each a tooltip from its label, and let
    // the Menu button expand the rail with full names (closes on a pick, Escape or outside click).
    (function navForNarrowScreens() {
        document.querySelectorAll(".nav-btn").forEach(btn => {
            const label = btn.querySelector("span:not(.badge)");
            if (label && !btn.title) btn.title = label.textContent.trim();
        });
        const toggle = document.getElementById("btn-menu-toggle"), sidebar = document.getElementById("app-sidebar");
        if (!toggle || !sidebar) return;
        const set = open => {
            sidebar.classList.toggle("expanded", open);
            toggle.setAttribute("aria-expanded", String(open));
            toggle.setAttribute("aria-label", open ? "Hide tool names" : "Show tool names");
        };
        toggle.addEventListener("click", e => { e.stopPropagation(); set(!sidebar.classList.contains("expanded")); });
        sidebar.addEventListener("click", e => { if (e.target.closest(".nav-btn")) set(false); });
        document.addEventListener("keydown", e => { if (e.key === "Escape") set(false); });
        document.addEventListener("click", e => { if (!sidebar.contains(e.target) && e.target !== toggle) set(false); });
    })();

    // Data caveat banner: dismissible per viewer (a convenience only — storage may be unavailable).
    (function dataBanner() {
        const banner = document.getElementById("data-banner");
        if (!banner) return;
        let dismissed = false;
        try { dismissed = localStorage.getItem("dataBannerDismissed") === "1"; } catch (e) { /* storage blocked */ }
        if (dismissed) banner.remove();
        document.getElementById("btn-dismiss-data-banner")?.addEventListener("click", () => {
            try { localStorage.setItem("dataBannerDismissed", "1"); } catch (e) { /* storage blocked */ }
            banner.remove();
        });
    })();
    // ── Application State ─────────────────────────────────────────────────────
    const state = {
        activeTab: "tab-stdn-compare",
        selectedDiscipline: "ALL",
        plotFilter: "ALL",
        searchQuery: "",
        selectedPayItem: null,
        theme: "dark",
        currentDXFAudit: null
    };

    // Per-tab header text. [title, subtitle]
    const PAGE_TITLES = {
        "tab-dxf-inspector":  ["DXF Project Auditor", "Upload an FDOT project DXF to score CADD-standards compliance, flag geometry errors, and export an auto-fix script."],
        "tab-stdn-compare":   ["Standards Compare + Auto-Correct", "Check a DXF against a standard, tolerance-diff its geometry against a reference drawing, and auto-correct the safe-to-fix deficiencies into a corrected .dxf — all in the browser."],
        "tab-layers":         ["FDOT 2026 Layer Standards", "Browse the discipline layer list with color, linetype, lineweight, and plot status. Filter by discipline or plot status; copy names."],
        "tab-signs":          ["Sign Assemblies & QTO", "FDOT sign assembly catalog and a MUTCD surface-area calculator that resolves the pay item from sign width x height."],
        "tab-ssa":            ["SSA Hydrology & IDF Zones", "Rational Method peak discharge (Q = CiA) from the 11 FDOT IDF zones, and a Drainage Manual Ch. 7 exfiltration trench sizer."],
        "tab-blocks-lib":     ["Civil 3D Block Libraries", "FDOT block catalog with source drawing, target layer, and associated pay item."],
        "tab-materials":      ["Materials", "JEA template material lists, pipe sizes in imperial and metric, and pipe systems, appurtenances and fittings for water, sewer and gas service lines. Reference values — verify before use."],
        "tab-payitems":       ["Pay Item Takeoff", "FDOT 2026 pay item catalog with unit, category, and the Civil 3D layer each item maps to for QTO."],
        "tab-survey":         ["Survey Description Keys", "FDOT description key sets: point code patterns, style blocks, target layers, point groups, and format strings."],
        "tab-subassemblies":  ["Subassemblies & PKT", "FDOT corridor subassembly reference with input parameters (lane, curb, shoulder, ditch)."],
        "tab-sheets":         ["Sheet Standards & DWT", "FDOT sheet templates with layout size, drawing template name, and viewport plot scale."],
        "tab-easy-button":    ["Easy Button", "Your code list → field data → linework on the right layers, ready to edit. Save a client profile once and reuse it on every job."],
        "tab-subdivision":    ["Subdivision", "Concept lot layout for a boundary: number, frontage, size and depth of lots; a straight, curved or reverse-curved road ending in a cul-de-sac or running through; retention ponds and green space — live checks, PDF and DXF export. A yield study, not a plat."],
        "tab-plat2dxf":       ["Parcel -> DXF / Points / COGO", "Turn a bearing/distance call list (or the bundled sample) into a valid ASCII DXF, a P,N,E,Z,D point file, and an AutoCAD COGO script."],
        "tab-qc":             ["QC Checklist & Traverse Auditor", "The 7-item Map Check QA checklist plus a traverse calculator: latitude/departure closure, precision ratio, Shoelace area, and self-intersection detection."],
        "tab-linework":       ["Linework Editor", "Import linework from a field point file (P,N,E,Z,D) or bearing/distance calls, run the field-data checks (zero-length, spike, bow-tie, non-closure, out-of-envelope), and edit vertices and courses interactively."],
        "tab-dxf-code-file":  ["DXF -> Code File", "Read a DXF's linework and write a Civil 3D survey code file (.fbk) — NEZ points and FIG BEGIN/PT/CLOSE/END figures named LW###, curves as PC/OC/PT points."],
        "tab-efbk":           ["Electronic Field Book", "FDOT EFB point/reference naming, P/C curve geometry and the chain-list mini-language — builds figures for the Linework Editor, or exports DXF / a Civil 3D linework script directly."],
        "tab-jea24":          ["JEA As-Built Standards 2026", "Civil 3D drawing builder, reverse-read DXF auditor, and validation against the 45 JEA 2026 picklists & 18-inch clearance rules."],
        "tab-tables":         ["Tables Drawing Auditor", "Audit a Civil 3D tables/styles-only drawing (layer, linetype, and text/table style definitions, no entities) against the FDOT 2026 layer standard."],
        "tab-batchprocess":   ["Batch Project Auditor", "Audit multiple DXF drawings and LandXML files simultaneously against FDOT CADD standards."],
        "tab-landxml":        ["LandXML Studio", "Inspect LandXML surfaces, alignments, parcels, and pipe networks with interactive 3D/2D visualization."],
        "tab-reports":        ["Reports Hub", "Centralized repository for all generated survey, audit, closure, and takeoff reports across all plugins."],
        "tab-logging":        ["System & Error Logs", "Real-time diagnostic event stream, error tracking, uncaught exception monitoring, and log export."],
        "tab-legal-desc":     ["Legal Description QC", "Parse a narrative metes-and-bounds description into line and curve calls, run a chord-trace closure, and apply BoundaryQC QC rules."],
        "tab-plss":           ["PLSS Section Breakdown", "Subdivide an ideal government section from an aliquot description; report rectangle dimensions, computed vs ideal acreage, and cardinal courses."],
        "tab-inspector":      ["State Kit Inspector", "Reference view of the reverse-engineered FDOT Civil 3D State Kit folder structure."],
        "tab-commercial":     ["Commercial SaaS Plans (Demo)", "Subscription tiers and an ASC 606 ledger model. Client-side demo — tier is read from localStorage; nothing gates a feature or takes a payment."],
        "tab-enterprise":     ["Enterprise & C3D Plugin (Demo)", "Civil 3D C# Ribbon add-in scaffold and portal manager. Demo build — licensing, seals, and portals are not enforced."],
        "tab-cms":            ["Admin Dashboard (Demo)", "Per-user client master templates (5 on the base plan), DOT projects & submittal vault, transaction ledger, team directory / user management (RBAC), and a hash-chained audit log. Sign-in/registration is in the account menu (Security plugin). Browser-local — not a security boundary."],
        "tab-help":           ["Help & User Manual", "How every tab works, the input formats they accept, what they compute, and the limits of this demo build."]
    };

    // ── Core DOM Elements ─────────────────────────────────────────────────────
    const navButtons = document.querySelectorAll(".nav-btn[data-tab]");   // the Home link has no tab
    const tabPanes = document.querySelectorAll(".tab-pane");
    const subassembliesGrid = document.getElementById("subassemblies-grid");
    const sheetsGrid = document.getElementById("sheets-grid");
    const themeToggleBtn = document.getElementById("theme-toggle");
    const globalSearchInput = document.getElementById("global-search");

    // ── Non-Blocking UI Helpers (Modal & Toast) ───────────────────────────────

    function showToast(message, isError = false) {
        const toastContainer = document.getElementById("toast-container");
        if (!toastContainer) return;
        const toast = document.createElement("div");
        toast.className = "toast";
        const icon = document.createElement("i");
        icon.className = isError
            ? "fa-solid fa-triangle-exclamation"
            : "fa-solid fa-circle-check";
        icon.style.color = isError ? "var(--danger)" : "var(--success)";
        const text = document.createElement("span");
        text.textContent = message;           // untrusted — never parsed as HTML
        toast.append(icon, " ", text);
        toastContainer.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = "0";
            setTimeout(() => toast.remove(), 300);
        }, 2500);
    }

    function showInputModal(title, defaultValue = "") {
        return new Promise(resolve => {
            const overlay = document.createElement("div");
            overlay.className = "modal-overlay";
            overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:10000;";

            window.setSafeHTML(overlay, `
                <div class="glass-panel" style="width:90%;max-width:420px;padding:1.75rem;background:var(--bg-primary);border:1px solid var(--primary);border-radius:var(--radius-md);">
                    <h3 style="margin-bottom:1rem;color:var(--text-main);font-size:1rem;">
                        <i class="fa-solid fa-pen-to-square" style="color:var(--primary);"></i> <span id="_input_modal_title"></span>
                    </h3>
                    <input id="_input_modal_field" type="text"
                        style="width:100%;padding:0.65rem;background:var(--bg-secondary);border:1px solid var(--glass-border);color:var(--text-primary);border-radius:var(--radius-sm);margin-bottom:1rem;box-sizing:border-box;" />
                    <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                        <button id="_input_modal_cancel" class="btn btn-secondary">Cancel</button>
                        <button id="_input_modal_ok" class="btn btn-primary">OK</button>
                    </div>
                </div>
            `);
            document.body.appendChild(overlay);

            overlay.querySelector("#_input_modal_title").textContent = title;
            const input = overlay.querySelector("#_input_modal_field");
            input.value = defaultValue;        // set as a property, never interpolated into markup
            input.focus(); input.select();

            const finish = (val) => { overlay.remove(); resolve(val); };
            overlay.querySelector("#_input_modal_ok").addEventListener("click", () => finish(input.value.trim() || null));
            overlay.querySelector("#_input_modal_cancel").addEventListener("click", () => finish(null));
            input.addEventListener("keydown", e => { if (e.key === "Enter") finish(input.value.trim() || null); if (e.key === "Escape") finish(null); });
        });
    }

    function showConfirmModal(message) {
        return new Promise(resolve => {
            const overlay = document.createElement("div");
            overlay.className = "modal-overlay";
            overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:10000;";

            window.setSafeHTML(overlay, `
                <div class="glass-panel" style="width:90%;max-width:380px;padding:1.75rem;background:var(--bg-primary);border:1px solid var(--danger);border-radius:var(--radius-md);">
                    <h3 style="margin-bottom:0.75rem;color:var(--danger);font-size:1rem;">
                        <i class="fa-solid fa-triangle-exclamation"></i> Confirm Action
                    </h3>
                    <p id="_confirm_modal_msg" style="color:var(--text-secondary);font-size:0.9rem;margin-bottom:1.25rem;"></p>
                    <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                        <button id="_confirm_modal_cancel" class="btn btn-secondary">Cancel</button>
                        <button id="_confirm_modal_ok" class="btn btn-primary" style="background:var(--danger);">Confirm</button>
                    </div>
                </div>
            `);
            document.body.appendChild(overlay);
            overlay.querySelector("#_confirm_modal_msg").textContent = message;

            // Escape closes the modal. The overlay isn't focusable, so listen on the
            // document and detach the handler when the modal goes away.
            const onKey = (e) => { if (e.key === "Escape") finish(false); };
            const finish = (val) => {
                document.removeEventListener("keydown", onKey);
                overlay.remove();
                resolve(val);
            };
            document.addEventListener("keydown", onKey);
            overlay.querySelector("#_confirm_modal_ok").addEventListener("click", () => finish(true));
            overlay.querySelector("#_confirm_modal_cancel").addEventListener("click", () => finish(false));
            overlay.addEventListener("click", e => { if (e.target === overlay) finish(false); });  // click backdrop = cancel
            overlay.querySelector("#_confirm_modal_cancel").focus();
        });
    }

    function showCopyModal(title, value) {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:10000;";
        window.setSafeHTML(overlay, `
            <div class="glass-panel" style="width:90%;max-width:520px;padding:1.75rem;background:var(--bg-primary);border:1px solid var(--primary);border-radius:var(--radius-md);">
                <h3 style="margin-bottom:0.75rem;color:var(--text-main);font-size:1rem;">
                    <i class="fa-solid fa-key" style="color:var(--accent);"></i> <span id="_copy_modal_title"></span>
                </h3>
                <textarea id="_copy_modal_value" rows="4" readonly
                    style="width:100%;padding:0.65rem;background:var(--bg-secondary);border:1px solid var(--glass-border);color:var(--accent);font-family:var(--font-mono);font-size:0.75rem;border-radius:var(--radius-sm);margin-bottom:1rem;resize:none;box-sizing:border-box;"></textarea>
                <div style="display:flex;gap:0.75rem;justify-content:flex-end;">
                    <button id="_copy_modal_copy" class="btn btn-accent"><i class="fa-solid fa-copy"></i> Copy to Clipboard</button>
                    <button id="_copy_modal_close" class="btn btn-secondary">Close</button>
                </div>
            </div>
        `);
        document.body.appendChild(overlay);
        overlay.querySelector("#_copy_modal_title").textContent = title;
        overlay.querySelector("#_copy_modal_value").value = value;

        const onKey = (e) => { if (e.key === "Escape") close(); };
        const close = () => { document.removeEventListener("keydown", onKey); overlay.remove(); };
        document.addEventListener("keydown", onKey);

        overlay.querySelector("#_copy_modal_copy").addEventListener("click", () => {
            navigator.clipboard.writeText(value).then(() => showToast("Copied to clipboard!")).catch(() => {});
        });
        overlay.querySelector("#_copy_modal_close").addEventListener("click", close);
        overlay.addEventListener("click", e => { if (e.target === overlay) close(); });
        overlay.querySelector("#_copy_modal_close").focus();
    }

    function showSubmittalCertificateModal(cert) {
        const modal = document.getElementById("modal-certificate");
        const container = document.getElementById("cert-sheet-container");
        if (!modal || !container || !cert) return;

        const clean = s => window.BoundaryQCSecurity ? window.BoundaryQCSecurity.sanitizeString(String(s ?? "")) : String(s ?? "");

        const sigRows = (cert.signerName || cert.signerLicense || cert.signerFirm)
            ? `<tr><th>Reviewed by:</th><td>${clean(cert.signerName) || "—"}${cert.signerLicense ? " (" + clean(cert.signerLicense) + ")" : ""}${cert.signerFirm ? " · " + clean(cert.signerFirm) : ""}</td></tr>`
            : "";

        window.setSafeHTML(container, `
            <div class="cert-sheet">
                <div class="cert-header">
                    <h2>CADD Self-Check Summary</h2>
                    <h4>Generated in-browser · not an FDOT submittal</h4>
                </div>

                <div class="cert-disclaimer" style="background:var(--warning-light); border:1px solid var(--warning); border-radius:var(--radius-sm); padding:0.6rem 0.85rem; font-size:0.78rem; color:var(--text-primary); margin:0 0 1rem;">
                    <i class="fa-solid fa-triangle-exclamation" style="color:var(--warning);"></i>
                    ${clean(cert.disclaimer)}
                </div>

                <div class="cert-grid">
                    <div>
                        <table class="cert-table">
                            <tbody>
                                <tr><th>Drawing:</th><td><strong>${clean(cert.filename)}</strong></td></tr>
                                <tr><th>Ruleset used:</th><td>${clean(cert.standardName)}</td></tr>
                                <tr><th>Summary ID:</th><td>${clean(cert.summaryId || cert.certId)}</td></tr>
                                <tr><th>Generated:</th><td>${clean(cert.timestamp)}</td></tr>
                                ${sigRows}
                                <tr><th>Drawing contents:</th><td>${cert.layersCount == null ? "n/a" : cert.layersCount} layers / ${cert.entitiesCount == null ? "n/a" : cert.entitiesCount} entities</td></tr>
                                ${cert.scoreBasis ? `<tr><th>Score basis:</th><td>${clean(cert.scoreBasis)}</td></tr>` : ""}
                                <tr><th>Issues flagged:</th><td>${cert.violationsCount} (${cert.violationsCount === 0 ? "none" : (cert.autoHealReady ? "auto-correct available" : "manual review needed")})</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="cert-badge-box">
                        <div style="font-size:0.72rem; font-weight:700; color:var(--text-muted); text-transform:uppercase; margin-bottom:0.25rem;">Self-check score</div>
                        <div class="cert-grade" style="color:${cert.gradeColor || 'var(--primary)'};">${clean(cert.grade)}</div>
                        <div style="font-size:1.15rem; font-weight:800; color:${cert.gradeColor || 'var(--primary)'}; margin-bottom:0.25rem;">${cert.score === null || cert.score === undefined ? "not scored" : cert.score + "%"}</div>
                        <div style="font-size:0.75rem; font-weight:700; color:var(--text-secondary); padding:2px 8px; border-radius:12px; background:var(--bg-surface-elevated);">${clean(cert.statusText)}</div>
                    </div>
                </div>

                <div style="background:var(--bg-surface-elevated); border:1px solid var(--border-subtle); border-radius:4px; padding:0.6rem 0.8rem; font-family:var(--font-mono); font-size:0.72rem; word-break:break-all; margin-top:1rem;">
                    <span style="font-weight:700; color:var(--primary);"><i class="fa-solid fa-fingerprint"></i> SHA-256 of the drawing text:</span><br>
                    <span style="color:var(--text-primary); font-size:0.78rem;">${cert.sha256 ? clean(cert.sha256) : "not hashed (no drawing content)"}</span>
                </div>

                <div class="cert-footer" style="margin-top:1rem;">
                    <div style="font-size:0.7rem; color:var(--text-muted);">FDOT Civil3D Standards Suite · client-side self-check · banks.land</div>
                </div>
            </div>
        `);

        modal.classList.remove("hidden");

        const closeCert = () => {
            modal.classList.add("hidden");
            document.getElementById("btn-close-cert")?.removeEventListener("click", closeCert);
            document.getElementById("btn-close-cert-btn")?.removeEventListener("click", closeCert);
            document.getElementById("btn-print-cert")?.removeEventListener("click", onPrint);
            document.getElementById("btn-copy-cert-hash")?.removeEventListener("click", onCopy);
        };
        const onPrint = () => window.print();
        const onCopy = () => cert.sha256 && navigator.clipboard.writeText(cert.sha256).then(() => showToast("Copied SHA-256.")).catch(() => {});
        document.getElementById("btn-close-cert")?.addEventListener("click", closeCert);
        document.getElementById("btn-close-cert-btn")?.addEventListener("click", closeCert);
        document.getElementById("btn-print-cert")?.addEventListener("click", onPrint);
        document.getElementById("btn-copy-cert-hash")?.addEventListener("click", onCopy);
    }

    window.showSubmittalCertificateModal = showSubmittalCertificateModal;

    // ── Core Standard Kit Catalog Renderers ───────────────────────────────────

    function updateBadges() {
        if (!window.FDOT_DATA) return;
        const setBadge = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        setBadge("layer-count-badge", window.FDOT_DATA.layers?.length || 0);
        setBadge("payitem-count-badge", window.FDOT_DATA.payItems?.length || 0);
        setBadge("survey-count-badge", window.FDOT_DATA.surveyKeys?.length || 0);
        setBadge("assembly-count-badge", window.FDOT_DATA.subassemblies?.length || 0);
        setBadge("stat-payitems-total", window.FDOT_DATA.payItems?.length || 0);
    }

    function renderSubassemblies() {
        if (!subassembliesGrid || !window.FDOT_DATA?.subassemblies) return;
        subassembliesGrid.replaceChildren();
        window.FDOT_DATA.subassemblies.forEach(sub => {
            const card = document.createElement("div");
            card.className = "pkt-card glass-panel";
            window.setSafeHTML(card, `
                <div class="pkt-card-header">
                    <h3>${sub.name}</h3>
                    <span class="tag tag-discipline">${sub.category}</span>
                </div>
                <p style="font-size:0.85rem; color:var(--text-secondary); flex:1;">${sub.description}</p>
                <div style="border-top: 1px solid var(--glass-border); padding-top:0.5rem; margin-top:0.5rem;">
                    <small style="color:var(--text-muted); font-weight:700; text-transform:uppercase;">Input Parameters</small>
                    <ul class="pkt-params-list">
                        ${sub.params.map(p => `<li><i class="fa-solid fa-gear"></i> ${p}</li>`).join("")}
                    </ul>
                </div>
            `);
            subassembliesGrid.appendChild(card);
        });
    }

    function renderSheetStandards() {
        if (!sheetsGrid || !window.FDOT_DATA?.sheetStandards) return;
        sheetsGrid.replaceChildren();
        window.FDOT_DATA.sheetStandards.forEach(sheet => {
            const card = document.createElement("div");
            card.className = "pkt-card glass-panel";
            window.setSafeHTML(card, `
                <div class="pkt-card-header">
                    <h3><i class="fa-solid fa-file-pdf" style="color:var(--danger);"></i> ${sheet.title}</h3>
                    <span class="tag tag-discipline">${sheet.layout}</span>
                </div>
                <div style="font-family:var(--font-mono); font-size:0.85rem; color:var(--accent);">${sheet.dwt}</div>
                <p style="font-size:0.85rem; color:var(--text-secondary); flex:1;">${sheet.description}</p>
                <div style="border-top: 1px solid var(--glass-border); padding-top:0.5rem; margin-top:0.5rem;">
                    <small style="color:var(--text-muted); font-weight:700; text-transform:uppercase;">Viewport Plot Scale</small>
                    <div style="font-weight:700; color:var(--success); font-size:0.9rem;">${sheet.scale}</div>
                </div>
            `);
            sheetsGrid.appendChild(card);
        });
    }

    function renderBlockLibraries() {
        const grid = document.getElementById("blocks-library-grid");
        if (!grid || !window.FDOT_DATA?.blocks) return;
        grid.replaceChildren();
        window.FDOT_DATA.blocks.forEach(b => {
            const card = document.createElement("div");
            card.className = "pkt-card glass-panel";
            window.setSafeHTML(card, `
                <div class="pkt-card-header">
                    <h3><i class="fa-solid fa-cube" style="color:var(--primary);"></i> ${b.name}</h3>
                    <span class="tag tag-discipline">${b.discipline}</span>
                </div>
                <div style="font-family:var(--font-mono); font-size:0.85rem; color:var(--accent);">${b.dwg}</div>
                <p style="font-size:0.85rem; color:var(--text-secondary); flex:1;">${b.description}</p>
                <div style="border-top: 1px solid var(--glass-border); padding-top:0.5rem; margin-top:0.5rem;">
                    <small style="color:var(--text-muted); font-weight:700; text-transform:uppercase;">Target Layer & Pay Item</small>
                    <div style="font-weight:700; color:var(--success); font-size:0.85rem;">${b.layer} (${b.payItem})</div>
                </div>
            `);
            grid.appendChild(card);
        });
    }

    function renderStateKitTree() {
        const treeContainer = document.getElementById("state-kit-tree");
        if (!treeContainer) return;
        window.setSafeHTML(treeContainer, `
            <div style="font-family: var(--font-mono); font-size: 0.85rem; line-height: 1.8; color: var(--text-secondary);">
                <div>📁 <strong style="color: var(--primary);">FDOT2026.C3D (State Kit Root)</strong></div>
                <div style="padding-left: 1.5rem;">├── 📁 <strong>Data</strong> (289 XML schema configs, FDOT Pay Items, Survey Description Key Sets)</div>
                <div style="padding-left: 1.5rem;">├── 📁 <strong>Template</strong> (87 Sheet DWT drawing files: CombinedLayers.dwt, CSCOVR.dwt, keysht_WithoutMap.dwt)</div>
                <div style="padding-left: 1.5rem;">├── 📁 <strong>Subassemblies</strong> (38 ATC Tool Palettes, CdRtGsaCore.dll, Custom PKT Corridor Assemblies)</div>
                <div style="padding-left: 1.5rem;">├── 📁 <strong>Support</strong> (1,169 block PNG previews, Fonts, Linetypes fdot.lin, Plotter PST styles)</div>
                <div style="padding-left: 1.5rem;">├── 📁 <strong>Apps & Plugins</strong> (209 DLLs, ProjectValidator.exe, QuantityTakeoffManagerCore.exe)</div>
                <div style="padding-left: 1.5rem;">└── 📜 <strong>FDOT2026Civil3DStateKitInstallationUserGuide.pdf</strong></div>
            </div>
        `);
    }

    // ── Setup Core Event Listeners ─────────────────────────────────────────────

    function setupCoreEvents(ctx) {
        // Ctrl+K Global Search Focus
        window.addEventListener("keydown", (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                globalSearchInput?.focus();
            }
        });

        // Set the header title/subtitle from PAGE_TITLES for a given tab.
        function applyPageMeta(tabId) {
            const titleEl = document.getElementById("page-title");
            const subEl = document.getElementById("page-subtitle");
            const meta = PAGE_TITLES[tabId];
            if (titleEl && subEl && meta) {
                titleEl.textContent = meta[0];
                subEl.textContent = meta[1];
            }
        }

        // Header title reflects the tab that is active on first paint (not just
        // after a click) — otherwise it shows a stale generic string on load.
        applyPageMeta(state.activeTab);

        // Tab Navigation
        navButtons.forEach(btn => {
            btn.addEventListener("click", () => {
                const targetTab = btn.getAttribute("data-tab");
                navButtons.forEach(b => b.classList.remove("active"));
                tabPanes.forEach(p => p.classList.remove("active"));

                btn.classList.add("active");
                const targetPane = document.getElementById(targetTab);
                if (targetPane) targetPane.classList.add("active");
                state.activeTab = targetTab;

                applyPageMeta(targetTab);

                // Notify plugins of tab switch
                if (window.PluginRegistry) {
                    window.PluginRegistry.notifyTabActivate(targetTab, ctx);
                }
            });
        });

        // Checkout Modal Triggers
        const modalCheckout = document.getElementById("modal-checkout");
        const modalPlanTitle = document.getElementById("modal-plan-title");

        document.querySelectorAll(".trigger-checkout").forEach(btn => {
            btn.addEventListener("click", () => {
                const plan = btn.getAttribute("data-plan") || "Pro";
                const price = btn.getAttribute("data-price") || "49";
                if (modalCheckout) {
                    modalCheckout.dataset.plan = plan;
                    modalCheckout.dataset.price = price;
                }
                if (modalPlanTitle) {
                    window.setSafeHTML(modalPlanTitle, `<i class="fa-solid fa-credit-card" style="color:var(--primary);"></i> Activate ${plan} Tier ($${price}/mo)`);
                }
                if (modalCheckout) modalCheckout.classList.remove("hidden");
            });
        });

        document.getElementById("btn-open-checkout-top")?.addEventListener("click", () => {
            if (modalCheckout) modalCheckout.classList.remove("hidden");
        });

        // Theme Toggle
        themeToggleBtn?.addEventListener("click", () => {
            state.theme = state.theme === "dark" ? "light" : "dark";
            document.body.className = `${state.theme}-theme`;
            window.setSafeHTML(themeToggleBtn, state.theme === "dark" ? `<i class="fa-solid fa-moon"></i>` : `<i class="fa-solid fa-sun"></i>`);
        });

        // Buttons that previously relied on inline onclick handlers (blocked by the page CSP).
        document.getElementById("btn-download-c3d-plugin")?.addEventListener("click", () => {
            showToast("Demo build — the Civil 3D .msi installer is not distributed in this repository.", true);
        });
        document.getElementById("btn-verify-cname")?.addEventListener("click", () => {
            const domain = document.getElementById("custom-domain-input")?.value.trim() || "(none)";
            showToast(`Demo build — CNAME for "${domain}" was not provisioned. Portal hosting is not part of this repo.`, true);
        });

        // "How your data is handled" modal — plain, accurate description.
        const modalPrivacy = document.getElementById("modal-privacy-guarantee");
        const closePrivacy = () => modalPrivacy?.classList.add("hidden");
        document.getElementById("btn-privacy-guarantee")?.addEventListener("click", () => {
            if (!modalPrivacy) return;
            const diagList = document.getElementById("privacy-diag-list");
            if (diagList && window.BoundaryQCSecurity) {
                const diag = window.BoundaryQCSecurity.getPrivacyDiagnostics();
                const row = (label, val) => `<li><strong>${label}:</strong> ${val}</li>`;
                window.setSafeHTML(diagList,
                    row("Where drawings are processed", diag.drawingProcessing) +
                    row("Can this app send my drawing anywhere", diag.appNetworkAccess) +
                    row("Third-party asset hosts", diag.staticAssetHosts.length ? diag.staticAssetHosts.join("; ") : `None — ${diag.assetHosting}`) +
                    row("Analytics / tracking", diag.analytics) +
                    row("Hashing", diag.cryptoEngine) +
                    row("Storage", diag.storageType) +
                    row("Secure context", diag.isSecureContext ? "yes" : "no (served over " + diag.protocol + ")")
                );
            }
            modalPrivacy.classList.remove("hidden");
        });
        document.getElementById("btn-close-privacy")?.addEventListener("click", closePrivacy);
        document.getElementById("btn-privacy-ok")?.addEventListener("click", closePrivacy);
        document.getElementById("btn-copy-privacy-attestation")?.addEventListener("click", () => {
            const diag = window.BoundaryQCSecurity ? window.BoundaryQCSecurity.getPrivacyDiagnostics() : {};
            const text = [
                "FDOT Civil3D Standards Suite — how it handles an opened drawing",
                "",
                "- Processing: " + (diag.drawingProcessing || "in-page only; nothing is uploaded"),
                "- App network access: " + (diag.appNetworkAccess || "CSP connect-src 'self' blocks cross-origin requests from the app's code"),
                "- Third-party asset hosts: " + ((diag.staticAssetHosts || []).join("; ") || `none (${diag.assetHosting})`),
                "- Analytics/tracking: " + (diag.analytics || "none"),
                "- Storage: " + (diag.storageType || "browser-local only"),
                "",
                "This is a plain description of the client-side app, not a formal security attestation or a compliance claim."
            ].join("\n");
            navigator.clipboard.writeText(text).then(() => showToast("Copied.")).catch(() => {});
        });
    }

    // ── Application Initialization ────────────────────────────────────────────

    function init() {
        console.info("[BoundaryQC Core] Initializing core application...");

        // Render base static content
        updateBadges();
        renderSubassemblies();
        renderSheetStandards();
        renderBlockLibraries();
        renderStateKitTree();

        // Build shared plugin context
        const ctx = {
            state,
            showToast,
            showInputModal,
            showConfirmModal,
            showCopyModal,
            showSubmittalCertificateModal,
            updateBadges
        };

        // Wire core navigation & controls
        setupCoreEvents(ctx);

        // Initialize all registered plugins
        if (window.PluginRegistry) {
            window.PluginRegistry.initAll(ctx);
            window.PluginRegistry.status();
        } else {
            console.warn("[BoundaryQC Core] PluginRegistry not loaded.");
        }

        console.info("[BoundaryQC Core] ✓ Core application and plugins initialized.");
    }

    init();
});
