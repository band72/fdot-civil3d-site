/**
 * Plugin: db-sync (PostgreSQL Database Client & Cloud Sync Bridge)
 * plugins/db-sync/db-sync.js
 *
 * Provides bidirectional synchronization between the client workspace (CMS,
 * templates, submittals, linework models, audit logs) and the PostgreSQL
 * database (supporting both local PostgreSQL and remote/cloud database instances).
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "db-sync",
        version: "1.0.0",
        description: "PostgreSQL database client & sync bridge for local and remote relational data storage.",
        icon: "fa-database",
        tier: "Free",
        dependencies: ["cms-engine"]
    };

    let _lastStatus = { ok: false, connected: false };
    const _listeners = new Set();

    let _apiUrl = "http://localhost:8085/api/db";
    let _bridgeToken = null;

    function _resolveUrl(subpath) {
        let base = _apiUrl;
        if (typeof window !== "undefined" && window.location && window.location.origin && window.location.origin !== "null" && window.location.protocol.startsWith("http")) {
            base = window.location.origin + "/api/db";
        }
        const rel = subpath.startsWith("/api/db") ? subpath.slice("/api/db".length) : subpath;
        return base.replace(/\/+$/, "") + (rel.startsWith("/") ? rel : "/" + rel);
    }

    // The PostgreSQL bridge only exists when the app is served by server.py. The public test
    // build (core/build-info.js publicBuild) is static hosting, so never contact /api/db there.
    const NO_BRIDGE = "The database bridge isn't available on the public test site — run the app locally with server.py to use database sync.";
    function _bridgeFetch(url, opts) {
        if (window.BUILD_INFO && window.BUILD_INFO.publicBuild) return Promise.reject(new Error(NO_BRIDGE));
        return fetch(url, opts);
    }

    async function ensureToken() {
        if (_bridgeToken) return _bridgeToken;
        try {
            const url = _resolveUrl("/token");
            const res = await _bridgeFetch(url, { cache: "no-store" });
            if (res.ok) {
                const data = await res.json();
                if (data.ok && data.token) {
                    _bridgeToken = data.token;
                }
            }
        } catch (e) {
            // Bridge might not be running or token endpoint not available
        }
        return _bridgeToken;
    }

    function _getHeaders(extra = {}) {
        const headers = Object.assign({}, extra);
        if (_bridgeToken) {
            headers["X-Bridge-Token"] = _bridgeToken;
        }
        return headers;
    }

    async function getStatus() {
        try {
            await ensureToken();
            const url = _resolveUrl("/status");
            const res = await _bridgeFetch(url, { cache: "no-store", headers: _getHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            _lastStatus = await res.json();
        } catch (err) {
            _lastStatus = {
                ok: false,
                connected: false,
                error: err.message || "Failed to reach database bridge server."
            };
        }
        notifyListeners();
        return _lastStatus;
    }

    function notifyListeners() {
        for (const fn of _listeners) {
            try { fn(_lastStatus); } catch (e) { console.error("[db-sync] Listener error:", e); }
        }
    }

    async function configureDatabase(urlOrReset) {
        await ensureToken();
        const body = typeof urlOrReset === "string" ? { database_url: urlOrReset } : { reset_default: true };
        const res = await _bridgeFetch(_resolveUrl("/config"), {
            method: "POST",
            headers: _getHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) return { ok: false, error: data.error || "Failed to configure database." };
        await getStatus();
        return data;
    }

    async function syncToDatabase(overridePayload) {
        await ensureToken();
        let payload = overridePayload;
        if (!payload) {
            if (!window.BoundaryQCCMS) throw new Error("CMS Engine is not loaded.");
            payload = window.BoundaryQCCMS.generateCloudSyncPayload();
        }
        const res = await _bridgeFetch(_resolveUrl("/sync/push"), {
            method: "POST",
            headers: _getHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Database push failed.");
        await getStatus();
        return data;
    }

    // Postgres/server.py wire-shape -> cms-engine's own camelCase object shape. This translation
    // lives here (not in cms-engine.js) because cms-engine is the local data/auth engine and has
    // no business knowing this app's Postgres column names — db-sync is the thing that talks to
    // Postgres, so it owns the adapter. See db/schema.sql and server.py's handle_sync_pull.
    const ROW_MAPPERS = {
        organizations: o => ({ id: o.id, name: o.name, plan: o.tier, purchasedSeats: o.license_cap, createdAt: o.created_at }),
        projects: p => ({
            id: p.id, orgId: p.org_id, fpid: p.fpid, name: p.name, county: p.county,
            district: p.district, status: p.status, metadata: p.metadata,
            createdAt: p.created_at, updatedAt: p.updated_at
        }),
        // ownerId is cms-engine's field for what the DB calls user_id.
        client_templates: t => ({
            id: t.id, ownerId: t.user_id, clientName: t.client_name, label: t.label,
            settings: typeof t.settings === "string" ? JSON.parse(t.settings) : t.settings,
            createdAt: t.created_at, updatedAt: t.updated_at
        }),
        submittals: s => ({
            id: s.id, projectId: s.project_id, fileName: s.file_name, submittedBy: s.submitted_by,
            sha256: s.sha256, precisionRatio: s.precision_ratio, status: s.status,
            metadata: s.metadata, timestamp: s.created_at
        }),
        transactions: tx => ({
            id: tx.id, orgId: tx.org_id, description: tx.description, amount: Number(tx.amount),
            status: tx.status, receiptUrl: tx.ref_id, timestamp: tx.timestamp
        }),
        audit_chain: a => ({
            sequence: a.sequence, prevHash: a.prev_hash, hash: a.hash,
            actor: a.actor, action: a.action, details: a.details, timestamp: a.timestamp
        }),
        users: u => ({
            id: u.id, orgId: u.org_id, email: u.email, fullName: u.full_name, role: u.role,
            licenseNumber: u.license_number, licenseState: u.license_state, company: u.company,
            createdAt: u.created_at
        })
    };

    async function pullFromDatabase(customTenantId) {
        await ensureToken();
        const cms = window.BoundaryQCCMS;
        let tenantId = customTenantId || "org_kh_01";
        if (!customTenantId && cms && typeof cms.getCurrentUser === "function") {
            const user = cms.getCurrentUser();
            if (user && user.orgId) tenantId = user.orgId;
        }

        const res = await _bridgeFetch(_resolveUrl(`/sync/pull?tenantId=${encodeURIComponent(tenantId)}`), {
            cache: "no-store",
            headers: _getHeaders()
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Database pull failed.");

        const tables = data.tables || {};
        const mapped = key => (Array.isArray(tables[key]) ? tables[key].map(ROW_MAPPERS[key]) : []);

        // Ingest every pulled table into the real cms-engine collections (localStorage-backed,
        // under the actual bqc_cms_* keys). merge*() upserts by id so a pull never drops a
        // not-yet-synced local row; replaceAuditChain() is the one exception (see its own doc).
        if (cms) {
            if (tables.organizations) cms.mergeOrganizations(mapped("organizations"));
            if (tables.users) cms.mergeUsers(mapped("users"));
            if (tables.projects) cms.mergeProjects(mapped("projects"));
            if (tables.client_templates) cms.mergeTemplates(mapped("client_templates"));
            if (tables.submittals) cms.mergeSubmittals(mapped("submittals"));
            if (tables.transactions) cms.mergeTransactions(mapped("transactions"));
            if (tables.audit_chain) cms.replaceAuditChain(mapped("audit_chain"));
        }

        await getStatus();
        return Object.assign({ ok: true }, tables);
    }

    // The bridge scopes linework sessions to a tenant (org). Use the signed-in user's org unless
    // the caller already set one.
    function _currentTenant() {
        const cms = window.BoundaryQCCMS;
        const user = cms && typeof cms.getCurrentUser === "function" ? cms.getCurrentUser() : null;
        return (user && user.orgId) || "org_kh_01";
    }

    async function saveLinework(session) {
        await ensureToken();
        const body = Object.assign({}, session);
        if (!body.tenantId) body.tenantId = _currentTenant();
        const res = await _bridgeFetch(_resolveUrl("/linework/save"), {
            method: "POST",
            headers: _getHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Failed to save linework session to database.");
        return data;
    }

    async function loadLinework(id) {
        await ensureToken();
        const tenant = encodeURIComponent(_currentTenant());
        const sub = id ? `/linework/load?id=${encodeURIComponent(id)}&tenantId=${tenant}` : `/linework/load?tenantId=${tenant}`;
        const res = await _bridgeFetch(_resolveUrl(sub), {
            cache: "no-store",
            headers: _getHeaders()
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Failed to load linework session from database.");
        return data;
    }

    /** Save an Easy Button profile for the current tenant (replaces one with the same name). */
    async function saveEasyProfile(profile) {
        await ensureToken();
        const res = await _bridgeFetch(_resolveUrl("/easy/profile/save"), {
            method: "POST",
            headers: _getHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ tenantId: _currentTenant(), profile })
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Failed to save the profile to the database.");
        return data;
    }

    /** List the current tenant's Easy Button profiles ({ name, updated_at }), or load one by name. */
    async function easyProfiles(name) {
        await ensureToken();
        const q = `tenantId=${encodeURIComponent(_currentTenant())}` + (name ? `&name=${encodeURIComponent(name)}` : "");
        const res = await _bridgeFetch(_resolveUrl(`/easy/profiles?${q}`), { cache: "no-store", headers: _getHeaders() });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || "Failed to read profiles from the database.");
        return data;
    }

    // db-sync owns no tab of its own (no MANIFEST.tab), so PluginRegistry.notifyTabActivate()
    // — which only calls onTabActivate on the plugin that owns the activated tab — would never
    // fire here even if defined; the Dashboard tab re-checks status on its own onTabActivate,
    // via window.DatabaseService.getStatus(), instead of relying on this plugin to push it.
    const Plugin = {
        init(ctx) {
            getStatus().catch(() => {});
        }
    };

    window.DatabaseService = {
        get apiUrl() { return _apiUrl; },
        set apiUrl(v) { _apiUrl = String(v); },
        getStatus,
        getLastStatus: () => _lastStatus,
        configureDatabase,
        syncToDatabase,
        pullFromDatabase,
        saveLinework,
        loadLinework,
        saveEasyProfile,
        easyProfiles,
        ensureToken,
        getAuthHeaders: _getHeaders,
        get token() { return _bridgeToken; },
        set token(v) { _bridgeToken = v; },
        onStatusChange(fn) {
            _listeners.add(fn);
            fn(_lastStatus);
            return () => _listeners.delete(fn);
        }
    };

    if (window.PluginRegistry) {
        window.PluginRegistry.register(MANIFEST, Plugin);
    }
})();
