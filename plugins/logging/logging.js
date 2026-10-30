/**
 * Plugin: logging (System Diagnostics & Error Audit Hub)
 * plugins/logging/logging.js
 *
 * Centralized logging engine for recording, filtering, inspecting, and exporting
 * error logs, warnings, and diagnostic telemetry across all plugins.
 *
 * Registers via window.PluginRegistry.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "logging",
        version: "1.0.0",
        description: "Centralized diagnostics, error logging, and telemetry repository for all suite plugins.",
        tab: "tab-logging",
        icon: "fa-terminal",
        tier: "Free",
        dependencies: []
    };

    const STORAGE_KEY = "fdot_system_logs_v1";
    const MAX_STORED_LOGS = 1000;
    const clean = window.cleanText; // core/safe-dom.js — shared across every plugin that sanitizes text before interpolation

    // ── In-Memory Log Buffer & Persistence ───────────────────────────────────

    let _logs = [];
    const _subscribers = new Set();

    function loadLogs() {
        try {
            if (typeof localStorage !== "undefined") {
                const raw = localStorage.getItem(STORAGE_KEY);
                if (raw) {
                    _logs = JSON.parse(raw) || [];
                }
            }
        } catch (e) {
            _logs = [];
        }
        return _logs;
    }

    function saveLogs() {
        try {
            if (typeof localStorage !== "undefined") {
                if (_logs.length > MAX_STORED_LOGS) {
                    _logs = _logs.slice(0, MAX_STORED_LOGS);
                }
                localStorage.setItem(STORAGE_KEY, JSON.stringify(_logs));
            }
        } catch (e) {
            console.warn("[Logging] Could not persist logs to localStorage:", e);
        }
        updateBadge();
    }

    function updateBadge() {
        const badge = document.getElementById("logging-error-badge");
        if (badge) {
            const errorCount = _logs.filter(l => l.level === "ERROR" || l.level === "CRITICAL").length;
            badge.textContent = errorCount;
            badge.style.display = errorCount > 0 ? "inline-block" : "none";
        }
    }

    // ── Public Logging API ───────────────────────────────────────────────────

    function addEntry(level, source, message, details = null) {
        const id = `log_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        const timestamp = new Date().toISOString();

        const entry = {
            id,
            timestamp,
            level: String(level || "INFO").toUpperCase(),
            source: String(source || "System"),
            message: String(message || ""),
            details: details ? (typeof details === "object" ? details : { info: details }) : null
        };

        _logs.unshift(entry);
        saveLogs();

        // Notify subscribers
        _subscribers.forEach(cb => {
            try { cb(entry); } catch (e) { console.error("[Logging] Subscriber error:", e); }
        });

        // Re-render UI if tab active
        if (document.getElementById("tab-logging")?.classList.contains("active")) {
            renderList();
        }

        return entry;
    }

    function _norm(arg1, arg2, arg3) {
        let source = "System";
        let message = "";
        let details = null;

        if (typeof arg2 === "string") {
            source = arg1 || "System";
            message = arg2 || "";
            details = arg3 || null;
        } else {
            message = String(arg1 || "");
            if (arg2 && typeof arg2 === "object") {
                if (arg2.source) source = arg2.source;
                details = arg2;
            } else if (arg2 !== undefined) {
                details = arg2;
            }
        }
        return { source, message, details };
    }

    function log(level, arg1, arg2, arg3) {
        const { source, message, details } = _norm(arg1, arg2, arg3);
        return addEntry(level, source, message, details);
    }

    function info(arg1, arg2, arg3) {
        const { source, message, details } = _norm(arg1, arg2, arg3);
        return addEntry("INFO", source, message, details);
    }

    function warn(arg1, arg2, arg3) {
        const { source, message, details } = _norm(arg1, arg2, arg3);
        return addEntry("WARN", source, message, details);
    }

    function error(arg1, arg2, arg3) {
        const { source, message, details } = _norm(arg1, arg2, arg3);
        return addEntry("ERROR", source, message, details);
    }

    function debug(arg1, arg2, arg3) {
        const { source, message, details } = _norm(arg1, arg2, arg3);
        return addEntry("DEBUG", source, message, details);
    }

    function getLogs(filter = {}) {
        let list = [..._logs];

        if (filter.level && filter.level !== "all") {
            const target = filter.level.toUpperCase();
            list = list.filter(l => l.level === target);
        }
        if (filter.source && filter.source !== "all") {
            const src = filter.source.toLowerCase();
            list = list.filter(l => l.source.toLowerCase() === src);
        }
        const query = filter.query || filter.search || filter.q;
        if (query) {
            const q = query.toLowerCase();
            list = list.filter(l =>
                l.message.toLowerCase().includes(q) ||
                l.source.toLowerCase().includes(q) ||
                l.level.toLowerCase().includes(q) ||
                (l.details && JSON.stringify(l.details).toLowerCase().includes(q))
            );
        }

        return list;
    }

    function clearLogs() {
        _logs = [];
        saveLogs();
        if (document.getElementById("tab-logging")?.classList.contains("active")) {
            renderList();
        }
    }

    function getStats() {
        const total = _logs.length;
        const errors = _logs.filter(l => l.level === "ERROR" || l.level === "CRITICAL").length;
        const warnings = _logs.filter(l => l.level === "WARN").length;
        const infos = _logs.filter(l => l.level === "INFO").length;
        const debugs = _logs.filter(l => l.level === "DEBUG").length;
        return {
            total,
            errors,
            warnings,
            info: infos,
            infos,
            debug: debugs,
            debugs
        };
    }

    // An empty log still downloads: "no events recorded" is a result worth keeping.
    function exportLogs(format = "txt") {
        let content = "";
        let mime = "text/plain";
        let filename = `fdot_system_logs_${new Date().toISOString().slice(0, 10)}.log`;

        if (format === "json") {
            content = JSON.stringify(_logs, null, 2);
            mime = "application/json";
            filename = `fdot_system_logs_${new Date().toISOString().slice(0, 10)}.json`;
        } else {
            content = [
                `================================================================================`,
                `  FDOT Civil3D Standards Suite - System Diagnostics & Error Audit Log`,
                `  Generated: ${new Date().toISOString()}`,
                `  Total Records: ${_logs.length}`,
                `================================================================================\n`
            ].join("\n");

            if (!_logs.length) content += "No events recorded.\n";
            _logs.forEach((l, i) => {
                content += `[${l.timestamp}] [${l.level.padEnd(5)}] [${l.source}] ${l.message}\n`;
                if (l.details) {
                    content += `  Details: ${JSON.stringify(l.details)}\n`;
                }
            });
        }

        if (typeof window !== "undefined" && window.COGO?.downloadText) {
            window.COGO.downloadText(filename, content, mime);
        }
        return content;
    }

    // Like exportLogs, an empty log is still sent: it records a clean run.
    function exportToReportsHub() {
        const stats = getStats();
        let logText = [
            `================================================================================`,
            `  STATE OF FLORIDA DEPARTMENT OF TRANSPORTATION (FDOT)`,
            `  SYSTEM DIAGNOSTICS & ERROR AUDIT REPORT`,
            `================================================================================`,
            `  Generated:      ${new Date().toISOString()}`,
            `  Total Records:  ${stats.total}`,
            `  Errors Flagged: ${stats.errors}`,
            `  Warnings:       ${stats.warnings}`,
            `  Information:    ${stats.info}`,
            `================================================================================\n`,
            `--- Itemized Log Stream ---\n`
        ].join("\n");

        if (!_logs.length) logText += "No events recorded.\n";
        _logs.forEach(l => {
            logText += `[${l.timestamp}] [${l.level.padEnd(5)}] [${l.source}] ${l.message}\n`;
            if (l.details) {
                logText += `  └ Details: ${JSON.stringify(l.details)}\n`;
            }
        });

        let rep = null;
        if (typeof window !== "undefined" && window.Reports?.addReport) {
            rep = window.Reports.addReport({
                id: `sys_log_${Date.now()}`,
                title: `System Diagnostics & Error Audit (${stats.errors} Errors, ${stats.warnings} Warnings)`,
                type: "system-logs",
                category: "standards",
                format: "log",
                filename: "fdot_system_audit.log",
                content: logText,
                metadata: { total: stats.total, errors: stats.errors, warnings: stats.warnings }
            });
        }
        return rep;
    }

    function subscribe(cb) {
        if (typeof cb === "function") {
            _subscribers.add(cb);
            return () => _subscribers.delete(cb);
        }
        return () => {};
    }

    // ── Global Error Catching ────────────────────────────────────────────────

    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
        window.addEventListener("error", ev => {
            error("Runtime", ev.message || "Uncaught runtime exception", {
                filename: ev.filename,
                lineno: ev.lineno,
                colno: ev.colno,
                error: ev.error ? String(ev.error) : null
            });
        });

        window.addEventListener("unhandledrejection", ev => {
            error("Promise", `Unhandled rejection: ${ev.reason ? (ev.reason.message || String(ev.reason)) : "Unknown"}`, {
                reason: ev.reason ? String(ev.reason) : null
            });
        });
    }

    // ── UI Controller ────────────────────────────────────────────────────────

    let _currentLevelFilter = "all";
    let _currentSourceFilter = "all";
    let _searchQuery = "";

    function renderUI(ctx) {
        const root = document.getElementById("logging-root");
        if (!root) return;

        const stats = getStats();

        window.setSafeHTML(root, `
            <div class="glass-panel" style="padding:1.5rem; margin-bottom:1.5rem;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem;">
                    <div>
                        <h2><i class="fa-solid fa-terminal" style="color:var(--primary);"></i> System Diagnostics &amp; Error Logging</h2>
                        <p class="subtitle">Live diagnostic stream tracking parser events, data validation issues, and uncaught exceptions across all suite plugins.</p>
                    </div>
                    <div style="display:flex; gap:0.5rem; flex-wrap:wrap;">
                        <button class="btn btn-secondary btn-sm" id="btn-logging-export-hub"><i class="fa-solid fa-clipboard-check"></i> Send to Reports Hub</button>
                        <button class="btn btn-secondary btn-sm" id="btn-logging-export-txt"><i class="fa-solid fa-download"></i> Export Log (.log)</button>
                        <button class="btn btn-secondary btn-sm" id="btn-logging-export-json"><i class="fa-solid fa-file-code"></i> JSON</button>
                        <button class="btn btn-secondary btn-sm" id="btn-logging-clear" style="color:var(--danger);"><i class="fa-solid fa-trash-can"></i> Clear</button>
                    </div>
                </div>

                <!-- Diagnostics Stat Cards -->
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:0.75rem; margin-top:1.25rem;">
                    <div class="glass-panel" style="padding:0.75rem; text-align:center; background:rgba(255,255,255,0.02);">
                        <div style="font-size:0.72rem; color:var(--text-muted); text-transform:uppercase; font-weight:700;">Total Logs</div>
                        <div id="stat-log-total" style="font-size:1.4rem; font-weight:800; color:var(--text-primary);">${stats.total}</div>
                    </div>
                    <div class="glass-panel" style="padding:0.75rem; text-align:center; background:rgba(239,68,68,0.05); border:1px solid rgba(239,68,68,0.2);">
                        <div style="font-size:0.72rem; color:var(--danger); text-transform:uppercase; font-weight:700;">Errors</div>
                        <div id="stat-log-errors" style="font-size:1.4rem; font-weight:800; color:var(--danger);">${stats.errors}</div>
                    </div>
                    <div class="glass-panel" style="padding:0.75rem; text-align:center; background:rgba(245,158,11,0.05); border:1px solid rgba(245,158,11,0.2);">
                        <div style="font-size:0.72rem; color:var(--warning); text-transform:uppercase; font-weight:700;">Warnings</div>
                        <div id="stat-log-warnings" style="font-size:1.4rem; font-weight:800; color:var(--warning);">${stats.warnings}</div>
                    </div>
                    <div class="glass-panel" style="padding:0.75rem; text-align:center; background:rgba(56,189,248,0.05); border:1px solid rgba(56,189,248,0.2);">
                        <div style="font-size:0.72rem; color:var(--primary); text-transform:uppercase; font-weight:700;">Info</div>
                        <div id="stat-log-infos" style="font-size:1.4rem; font-weight:800; color:var(--primary);">${stats.infos}</div>
                    </div>
                </div>

                <!-- Filters & Search -->
                <div style="display:flex; justify-content:space-between; align-items:center; margin-top:1rem; flex-wrap:wrap; gap:0.75rem;">
                    <div style="display:flex; gap:0.4rem; flex-wrap:wrap;" id="logging-level-pills">
                        <button class="btn btn-sm btn-primary filter-pill-log" data-lvl="all">All</button>
                        <button class="btn btn-sm btn-secondary filter-pill-log" data-lvl="ERROR" style="color:var(--danger);">Errors Only</button>
                        <button class="btn btn-sm btn-secondary filter-pill-log" data-lvl="WARN" style="color:var(--warning);">Warnings</button>
                        <button class="btn btn-sm btn-secondary filter-pill-log" data-lvl="INFO">Info</button>
                    </div>

                    <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
                        <select id="logging-source-select" aria-label="Filter logs by source" style="padding:0.35rem 0.6rem; background:var(--bg-secondary); border:1px solid var(--glass-border); border-radius:var(--radius-sm); color:var(--text-primary); font-size:0.8rem;">
                            <option value="all">All Sources</option>
                            <option value="Linework">Linework</option>
                            <option value="BatchProcess">BatchProcess</option>
                            <option value="LandXML">LandXML</option>
                            <option value="EFBK">EFBK</option>
                            <option value="Reports">Reports</option>
                            <option value="Runtime">Runtime</option>
                            <option value="System">System</option>
                        </select>

                        <div style="position:relative; min-width:200px;">
                            <input type="text" id="logging-search-input" aria-label="Search log messages" placeholder="Search log messages..." style="width:100%; padding:0.35rem 0.6rem 0.35rem 1.8rem; background:var(--bg-secondary); border:1px solid var(--glass-border); border-radius:var(--radius-sm); color:var(--text-primary); font-size:0.8rem;">
                            <i class="fa-solid fa-magnifying-glass" style="position:absolute; left:0.6rem; top:0.5rem; color:var(--text-muted); font-size:0.72rem;"></i>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Log Stream Console Container -->
            <div class="glass-panel" style="padding:0; overflow-x:auto; background:#080c14; border:1px solid var(--glass-border);">
                <div style="padding:0.5rem 1rem; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--glass-border); font-size:0.75rem; color:var(--text-muted); display:flex; justify-content:space-between; align-items:center;">
                    <span><i class="fa-solid fa-terminal"></i> Log Event Stream</span>
                    <span id="logging-stream-count" style="font-family:var(--font-mono);">0 events shown</span>
                </div>
                <div id="logging-stream-body" style="max-height:550px; overflow-y:auto; font-family:var(--font-mono); font-size:0.78rem; padding:0.5rem 0;">
                    <!-- Injected dynamically -->
                </div>
            </div>
        `);

        bindEvents(ctx);
        renderList();
        updateBadge();
    }

    function bindEvents(ctx) {
        const root = document.getElementById("logging-root");
        if (!root) return;

        // Level filter pills
        root.querySelectorAll(".filter-pill-log").forEach(btn => {
            btn.addEventListener("click", () => {
                root.querySelectorAll(".filter-pill-log").forEach(b => {
                    b.classList.remove("btn-primary");
                    b.classList.add("btn-secondary");
                });
                btn.classList.remove("btn-secondary");
                btn.classList.add("btn-primary");
                _currentLevelFilter = btn.dataset.lvl;
                renderList();
            });
        });

        // Source filter
        const srcSel = root.querySelector("#logging-source-select");
        srcSel?.addEventListener("change", e => {
            _currentSourceFilter = e.target.value;
            renderList();
        });

        // Search input
        const sInput = root.querySelector("#logging-search-input");
        sInput?.addEventListener("input", e => {
            _searchQuery = e.target.value.trim();
            renderList();
        });

        // Action buttons
        root.querySelector("#btn-logging-clear")?.addEventListener("click", () => {
            if (!_logs.length) return;
            if (confirm("Are you sure you want to clear all diagnostics logs?")) {
                clearLogs();
                if (ctx?.showToast) ctx.showToast("Diagnostics logs cleared.");
            }
        });

        root.querySelector("#btn-logging-export-txt")?.addEventListener("click", () => {
            exportLogs("txt");
            if (ctx?.showToast) ctx.showToast(`Exported system log file (${_logs.length} record${_logs.length === 1 ? "" : "s"}).`);
        });

        root.querySelector("#btn-logging-export-json")?.addEventListener("click", () => {
            exportLogs("json");
            if (ctx?.showToast) ctx.showToast(`Exported system log JSON (${_logs.length} record${_logs.length === 1 ? "" : "s"}).`);
        });

        root.querySelector("#btn-logging-export-hub")?.addEventListener("click", () => {
            const rep = exportToReportsHub();
            if (ctx?.showToast) {
                ctx.showToast(rep ? `System log sent to Reports Hub (${_logs.length} record${_logs.length === 1 ? "" : "s"}).` : "Reports Hub is not available.", !rep);
            }
        });
    }

    function renderList() {
        const stream = document.getElementById("logging-stream-body");
        if (!stream) return;

        const filtered = getLogs({
            level: _currentLevelFilter,
            source: _currentSourceFilter,
            query: _searchQuery
        });

        const countEl = document.getElementById("logging-stream-count");
        if (countEl) countEl.textContent = `${filtered.length} event(s) shown`;

        if (filtered.length === 0) {
            window.setSafeHTML(stream, `
                <div style="padding:2.5rem; text-align:center; color:var(--text-muted);">
                    <i class="fa-solid fa-square-check" style="font-size:1.8rem; margin-bottom:0.5rem; opacity:0.3; display:block;"></i>
                    No log events match the current filter criteria.
                </div>
            `);
            return;
        }

        const lines = filtered.map(l => {
            const timeStr = new Date(l.timestamp).toLocaleTimeString("en-US", {
                hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"
            });
            const badgeStyle = getLevelStyle(l.level);
            const detailsHtml = l.details ? `
                <div style="margin-top:0.25rem; font-size:0.72rem; color:var(--text-muted); background:rgba(255,255,255,0.03); padding:0.25rem 0.5rem; border-radius:3px; overflow-x:auto;">
                    <code>${clean(JSON.stringify(l.details))}</code>
                </div>` : "";

            return `
                <div style="padding:0.4rem 1rem; border-bottom:1px solid rgba(255,255,255,0.03); display:flex; flex-direction:column; gap:0.15rem; transition:background 0.15s;">
                    <div style="display:flex; align-items:center; gap:0.6rem; flex-wrap:wrap;">
                        <span style="color:var(--text-muted); font-size:0.72rem;">${timeStr}</span>
                        <span style="padding:0.1rem 0.4rem; border-radius:3px; font-size:0.68rem; font-weight:700; ${badgeStyle}">${clean(l.level)}</span>
                        <span style="padding:0.1rem 0.35rem; border-radius:3px; font-size:0.68rem; background:rgba(255,255,255,0.06); color:var(--text-secondary);">${clean(l.source)}</span>
                        <span style="color:#e2e8f0; word-break:break-word; flex:1;">${clean(l.message)}</span>
                    </div>
                    ${detailsHtml}
                </div>
            `;
        }).join("");

        window.setSafeHTML(stream, lines);
    }

    function getLevelStyle(level) {
        switch (level) {
            case "CRITICAL":
            case "ERROR":
                return "background:rgba(239,68,68,0.2); color:#ef4444; border:1px solid rgba(239,68,68,0.4);";
            case "WARN":
                return "background:rgba(245,158,11,0.2); color:#f59e0b; border:1px solid rgba(245,158,11,0.4);";
            case "DEBUG":
                return "background:rgba(168,85,247,0.2); color:#a855f7; border:1px solid rgba(168,85,247,0.4);";
            case "INFO":
            default:
                return "background:rgba(2,132,199,0.2); color:#38bdf8; border:1px solid rgba(2,132,199,0.4);";
        }
    }

    // ── Plugin Object ────────────────────────────────────────────────────────

    const Plugin = {
        init(ctx) {
            loadLogs();
            renderUI(ctx);
        },
        onTabActivate(ctx) {
            renderUI(ctx);
        }
    };

    window.Logging = {
        log: addEntry,
        info,
        warn,
        error,
        debug,
        getLogs,
        clearLogs,
        getStats,
        exportLogs,
        exportToReportsHub,
        subscribe
    };

    loadLogs();

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);
})();
