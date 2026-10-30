/**
 * Plugin: db-settings (PostgreSQL Sync Status, Actions & Connection Settings)
 * plugins/db-settings/db-settings.js
 *
 * The Admin Dashboard's "Database" panel: the connection status badge + row
 * counts, the Sync-to-DB / Pull-from-DB buttons, the cloud-sync JSON export,
 * and the connection settings modal (test/save a local or remote PostgreSQL
 * URL). All of this lives physically inside the "tab-cms" DOM (see
 * index.html), same as plugins/security/security.js reaching into the
 * header — it's split out into its own plugin so plugins/dashboard/
 * dashboard.js stays about the CMS data (profile, templates, projects,
 * submittals, transactions, team directory, audit log) and doesn't also
 * have to know how the Postgres bridge's status/config flow works.
 *
 * Split out of plugins/dashboard/dashboard.js. Depends on plugins/db-sync/
 * db-sync.js (window.DatabaseService, the fetch layer talking to server.py)
 * and cms-engine (generateCloudSyncPayload for the JSON export). No tab of
 * its own — PluginRegistry.notifyTabActivate() only calls onTabActivate on
 * the plugin that OWNS the activated tab, so dashboard.js calls
 * window.DbSettings.refresh() from its own onTabActivate instead (the same
 * cross-plugin pattern security.js/dashboard.js already use for refreshAll).
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "db-settings",
        version: "1.0.0",
        description: "Admin Dashboard's PostgreSQL status badge, sync push/pull, cloud-sync export, and connection settings modal.",
        icon: "fa-database",
        tier: "Firm",
        dependencies: ["db-sync", "cms-engine"],
    };

    /** Refresh the status badge, connection blurb, and per-table row counts from the last-known
     *  DatabaseService status (does not itself hit the network — see refresh()). */
    function renderStatus() {
        const dbBadge = document.getElementById("db-status-badge");
        const dbInfo = document.getElementById("db-connection-info");
        if (!dbBadge || !window.DatabaseService) return;

        const st = window.DatabaseService.getLastStatus();
        if (st && st.connected) {
            const isLocal = !!st.is_local;
            const label = isLocal ? "Local PostgreSQL" : "Remote PostgreSQL";
            window.setSafeHTML(dbBadge, `<i class="fa-solid fa-circle-check"></i> ${label} Connected`);
            dbBadge.style.background = isLocal ? "rgba(16, 185, 129, 0.15)" : "rgba(14, 165, 233, 0.15)";
            dbBadge.style.borderColor = isLocal ? "var(--success)" : "var(--primary)";
            dbBadge.style.color = isLocal ? "var(--success)" : "var(--primary)";

            if (dbInfo) {
                dbInfo.textContent = `Connected to ${isLocal ? "local cluster" : "remote host"} (${st.host}:${st.port}/${st.database})`;
            }

            const counts = st.counts || {};
            const setCnt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = (v != null ? String(v) : "—"); };
            setCnt("db-cnt-projects", counts.projects);
            setCnt("db-cnt-templates", counts.client_templates);
            setCnt("db-cnt-submittals", counts.submittals);
            setCnt("db-cnt-transactions", counts.transactions);
            setCnt("db-cnt-audit", counts.audit_chain);
            setCnt("db-cnt-linework", counts.linework_sessions);
            setCnt("db-cnt-pts", counts.survey_points);
        } else {
            window.setSafeHTML(dbBadge, `<i class="fa-solid fa-circle-xmark"></i> Database Disconnected`);
            dbBadge.style.background = "rgba(239, 68, 68, 0.15)";
            dbBadge.style.borderColor = "var(--danger)";
            dbBadge.style.color = "var(--danger)";
            if (dbInfo) {
                dbInfo.textContent = st?.error ? `Database error: ${st.error}` : "PostgreSQL service is offline or unreachable. Working in local memory mode.";
            }
        }
    }

    /** DatabaseService.configureDatabase() reports a failed connect as {ok:false, error}
     *  rather than throwing — turn that into a throw so no caller shows it as success. */
    async function configure(urlOrReset) {
        const res = await window.DatabaseService.configureDatabase(urlOrReset);
        if (!res || res.ok === false) throw new Error((res && res.error) || "Failed to configure database.");
        return res;
    }

    /** Fetch a fresh status from the bridge server, then render it. Exposed for the Dashboard
     *  tab (which owns "tab-cms" and this panel's DOM) to call on every visit. */
    function refresh() {
        if (!window.DatabaseService) return Promise.resolve();
        return window.DatabaseService.getStatus().then(renderStatus).catch(() => {});
    }

    const Plugin = {
        init() {
            if (window.DatabaseService) window.DatabaseService.onStatusChange(renderStatus);
            refresh();
        },

        setupEvents(ctx) {
            document.getElementById("btn-export-cloud-sync")?.addEventListener("click", () => {
                if (!window.BoundaryQCCMS) return;
                const payload = window.BoundaryQCCMS.generateCloudSyncPayload();
                window.COGO.downloadText("fdot_postgresql_cloud_sync_schema.json", JSON.stringify(payload, null, 2), "application/json");
                ctx.showToast("Exported PostgreSQL RLS Cloud Schema (`fdot_postgresql_cloud_sync_schema.json`)!");
            });

            document.getElementById("btn-db-sync-push")?.addEventListener("click", async () => {
                if (!window.DatabaseService) return;
                const btn = document.getElementById("btn-db-sync-push");
                if (btn) btn.disabled = true;
                try {
                    await window.DatabaseService.syncToDatabase();
                    ctx.showToast(`✓ Synchronized state to PostgreSQL`);
                } catch (err) {
                    ctx.showToast(`Sync Error: ${err.message}`, true);
                } finally {
                    if (btn) btn.disabled = false;
                }
            });

            document.getElementById("btn-db-sync-pull")?.addEventListener("click", async () => {
                if (!window.DatabaseService) return;
                const btn = document.getElementById("btn-db-sync-pull");
                if (btn) btn.disabled = true;
                try {
                    const res = await window.DatabaseService.pullFromDatabase();
                    // pullFromDatabase() flattens the pulled tables onto the result itself
                    // (Object.assign({ok:true}, tables)) — there is no res.tables wrapper.
                    const nProj = res.projects?.length || 0;
                    const nTpl = res.client_templates?.length || 0;
                    ctx.showToast(`✓ Pulled records from PostgreSQL (${nProj} projects, ${nTpl} templates)`);
                    // A pull can change projects/templates/submittals/etc. that the Dashboard
                    // tab itself renders — ask it to refresh, mirroring security.js<->dashboard.js.
                    if (window.Dashboard) window.Dashboard.render(ctx);
                } catch (err) {
                    ctx.showToast(`Pull Error: ${err.message}`, true);
                } finally {
                    if (btn) btn.disabled = false;
                }
            });

            // Database Settings Modal
            const modalDb = document.getElementById("modal-db-settings");
            const inputUrl = document.getElementById("input-db-url");
            const testFeedback = document.getElementById("db-test-feedback");

            document.getElementById("btn-db-configure")?.addEventListener("click", () => {
                const st = window.DatabaseService?.getLastStatus();
                if (inputUrl && st?.database_url_masked) {
                    inputUrl.value = st.database_url_masked;
                }
                if (testFeedback) testFeedback.style.display = "none";
                modalDb?.classList.remove("hidden");
            });

            document.getElementById("btn-close-db-modal")?.addEventListener("click", () => {
                modalDb?.classList.add("hidden");
            });

            document.getElementById("radio-db-local")?.addEventListener("change", e => {
                if (e.target.checked && inputUrl) {
                    inputUrl.value = "postgresql://postgres@localhost:5432/fdot_survey_db";
                }
            });

            document.getElementById("radio-db-remote")?.addEventListener("change", e => {
                if (e.target.checked && inputUrl && inputUrl.value.includes("localhost")) {
                    inputUrl.value = "postgresql://survey_user:PASSWORD@remote-db.cloud.provider:5432/fdot_survey_db?sslmode=require";
                    inputUrl.focus();
                }
            });

            document.getElementById("btn-db-reset-default")?.addEventListener("click", async () => {
                if (!window.DatabaseService) return;
                try {
                    const res = await configure(null);
                    ctx.showToast("Reset to default local PostgreSQL configuration.");
                    if (inputUrl) inputUrl.value = res.database_url_masked || "postgresql://postgres@localhost:5432/fdot_survey_db";
                    if (testFeedback) {
                        testFeedback.style.display = "block";
                        testFeedback.style.background = "rgba(16, 185, 129, 0.15)";
                        testFeedback.style.color = "var(--success)";
                        testFeedback.textContent = "✓ Connected to local PostgreSQL server.";
                    }
                } catch (err) {
                    ctx.showToast(err.message, true);
                }
            });

            document.getElementById("btn-db-test-conn")?.addEventListener("click", async () => {
                const url = inputUrl?.value?.trim();
                if (!url) { ctx.showToast("Enter a PostgreSQL connection URL.", true); return; }
                const testBtn = document.getElementById("btn-db-test-conn");
                if (testBtn) testBtn.disabled = true;
                if (testFeedback) {
                    testFeedback.style.display = "block";
                    testFeedback.style.background = "rgba(51, 103, 145, 0.15)";
                    testFeedback.style.color = "var(--primary)";
                    window.setSafeHTML(testFeedback, `<i class="fa-solid fa-spinner fa-spin"></i> Testing connection...`);
                }
                try {
                    const res = await configure(url);
                    if (testFeedback) {
                        testFeedback.style.background = "rgba(16, 185, 129, 0.15)";
                        testFeedback.style.color = "var(--success)";
                        testFeedback.textContent = `✓ Connection successful: ${res.version ? res.version.split(" on ")[0] : "PostgreSQL Connected"}`;
                    }
                    ctx.showToast("Database connection test succeeded!");
                } catch (err) {
                    if (testFeedback) {
                        testFeedback.style.background = "rgba(239, 68, 68, 0.15)";
                        testFeedback.style.color = "var(--danger)";
                        testFeedback.textContent = `✗ Connection failed: ${err.message}`;
                    }
                } finally {
                    if (testBtn) testBtn.disabled = false;
                }
            });

            document.getElementById("btn-db-save-conn")?.addEventListener("click", async () => {
                const url = inputUrl?.value?.trim();
                if (!url) { ctx.showToast("Enter a PostgreSQL connection URL.", true); return; }
                try {
                    await configure(url);
                    modalDb?.classList.add("hidden");
                    ctx.showToast("Database configuration saved and active!");
                } catch (err) {
                    ctx.showToast(`Error saving configuration: ${err.message}`, true);
                }
            });
        },
    };

    window.DbSettings = { refresh, renderStatus, configure };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);
})();
