/**
 * BoundaryQC & FDOT Civil3D Standards Suite — Enterprise CMS & Dual-Persistence Engine
 * Enterprise Edition v2.5.0
 * 
 * Features:
 * - Dual-Tier Persistence Architecture (LiteDB/Local Container + PostgreSQL Cloud Sync)
 * - Row-Level Security (RLS) Multi-Tenant Organization Isolation
 * - SHA-256 hash-linked audit log with a recompute-and-compare verifier (demo)
 * - Cryptographic Stripe Webhook Receiver with HMAC-SHA256 & Idempotency Locks
 * - ASC 606 Double-Entry Billing Ledger & Domain Auto-Join Engine
 * - Role-Based Access Control (RBAC) with F.A.C. Statutory Seal Authority
 */

class BoundaryQCCMSEngine {
    constructor() {
        this.STORAGE_KEYS = {
            USERS: "bqc_cms_users",
            CURRENT_USER: "bqc_cms_current_user",
            SESSION: "bqc_cms_session",
            LOGIN_ATTEMPTS: "bqc_cms_login_attempts",
            ORGS: "bqc_cms_organizations",
            PROJECTS: "bqc_cms_projects",
            SUBMITTALS: "bqc_cms_submittals",
            TRANSACTIONS: "bqc_cms_transactions",
            TEMPLATES: "bqc_cms_templates",
            ACTIVE_TEMPLATE: "bqc_cms_active_template",
            AUDIT_LOGS: "bqc_cms_audit_logs",
            WEBHOOK_IDEMPOTENCY: "bqc_cms_idempotency_keys",
            SCHEMA_VERSION: "bqc_cms_schema_version"
        };

        // Auth policy (client-side; enforcement is best-effort — see constructor warning).
        this.AUTH = {
            SCHEMA_VERSION: 3,
            DEMO_PASSWORD: "Fdot2026!",          // seed accounts; shown as a hint on the login form
            PBKDF2_ITERATIONS: 100000,
            SYNC_ITERATIONS: 20000,
            SEED_ITERATIONS: 2000,   // lighter: seeds/migration run synchronously at page load
            SESSION_HOURS: 8,
            REMEMBER_DAYS: 30,
            MAX_FAILED: 5,
            LOCKOUT_MS: 60 * 1000
        };

        this.roles = {
            PSM_SURVEYOR: { name: "PSM Surveyor", sealRules: "F.A.C. Rule 5J-17.062", canSign: true, licensePrefix: "LS" },
            PE_ENGINEER: { name: "PE Engineer", sealRules: "F.A.C. Rule 61G15-23.004", canSign: true, licensePrefix: "PE" },
            FIRM_ADMIN: { name: "Firm Admin", sealRules: "Administrative Control", canSign: false, licensePrefix: "ADM" },
            MUNICIPAL_REVIEWER: { name: "Municipal Reviewer", sealRules: "Review & Audit", canSign: false, licensePrefix: "REV" },
            CONTRACTOR: { name: "Contractor", sealRules: "Staking & As-Built", canSign: false, licensePrefix: "CON" }
        };

        this.initStorageDefaults();
        this._migrate();

        // Not on the public test build: its sign-in UI is removed there (core/build-info.js), and
        // the notice would print the demo seed password into every tester's console.
        if (!(window.BUILD_INFO && window.BUILD_INFO.publicBuild)) {
            console.warn(
                "[BoundaryQCCMS] Demo build. Auth now uses salted PBKDF2 password hashes, sessions with " +
                "expiry, and failed-login lockout — but it all runs in this browser against localStorage, so " +
                "a determined user can bypass it from devtools. Real user management, licensing, and tenant " +
                "isolation require a server. Seed accounts use the password: " + this.AUTH.DEMO_PASSWORD
            );
        }
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Password hashing & sessions (client-side, best-effort)
    // ──────────────────────────────────────────────────────────────────────────

    _randomSaltHex(bytes = 16) {
        const a = new Uint8Array(bytes);
        // No secure randomness → refuse (a Math.random salt would only look like one).
        if (!(window.crypto && window.crypto.getRandomValues)) throw new Error("Secure random numbers are unavailable in this browser — cannot create a password salt.");
        window.crypto.getRandomValues(a);
        return Array.from(a).map(b => b.toString(16).padStart(2, "0")).join("");
    }

    _hexToBytes(hex) {
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out;
    }

    /** Iterated salted SHA-256 (synchronous fallback; used for seed accounts). */
    _deriveHashSync(password, saltHex, iterations) {
        const S = window.BoundaryQCSecurity;
        let h = `${password}|${saltHex}`;
        for (let i = 0; i < iterations; i++) {
            h = S ? S.computeTextSHA256Sync(`${h}|${i}`) : `${h}|${i}`;
        }
        return h;
    }

    /** PBKDF2-SHA-256 via SubtleCrypto when available; else the sync fallback. */
    async _deriveHash(password, saltHex, algo, iterations) {
        if (algo === "pbkdf2" && window.crypto && window.crypto.subtle) {
            const keyMat = await window.crypto.subtle.importKey(
                "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
            const bits = await window.crypto.subtle.deriveBits(
                { name: "PBKDF2", salt: this._hexToBytes(saltHex), iterations, hash: "SHA-256" }, keyMat, 256);
            return Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, "0")).join("");
        }
        return this._deriveHashSync(password, saltHex, iterations);
    }

    _safeEqual(a, b) {
        if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
        return diff === 0;
    }

    _validatePassword(pw) {
        if (typeof pw !== "string" || pw.length < 8) {
            throw new Error("Password must be at least 8 characters.");
        }
        if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) {
            throw new Error("Password must contain at least one letter and one digit.");
        }
    }

    /** Build a credential record for a user object (sync path — used for seeds/migration). */
    _makeCredentialSync(password, iterations) {
        const iter = iterations || this.AUTH.SYNC_ITERATIONS;
        const salt = this._randomSaltHex();
        return { algo: "s256i", salt, iterations: iter,
                 hash: this._deriveHashSync(password, salt, iter) };
    }

    /** Build a credential record (async PBKDF2 path — used for real registrations / password changes). */
    async _makeCredential(password) {
        const useSubtle = !!(window.crypto && window.crypto.subtle);
        const algo = useSubtle ? "pbkdf2" : "s256i";
        const iterations = useSubtle ? this.AUTH.PBKDF2_ITERATIONS : this.AUTH.SYNC_ITERATIONS;
        const salt = this._randomSaltHex();
        return { algo, salt, iterations, hash: await this._deriveHash(password, salt, algo, iterations) };
    }

    async _verifyCredential(cred, password) {
        if (!cred || !cred.hash || !cred.salt) return false;
        const attempt = await this._deriveHash(password, cred.salt, cred.algo || "s256i",
            cred.iterations || this.AUTH.SYNC_ITERATIONS);
        return this._safeEqual(attempt, cred.hash);
    }

    _getSession() {
        const s = this._readJSON(this.STORAGE_KEYS.SESSION, null);
        if (!s || typeof s.expiresAt !== "number") return null;
        if (Date.now() > s.expiresAt) return null;
        return s;
    }

    _startSession(user, remember) {
        const ttlMs = (remember ? this.AUTH.REMEMBER_DAYS * 24 : this.AUTH.SESSION_HOURS) * 3600 * 1000;
        const session = {
            userId: user.id,
            token: this._randomSaltHex(24),
            issuedAt: Date.now(),
            expiresAt: Date.now() + ttlMs,
            remember: !!remember
        };
        this._writeJSON(this.STORAGE_KEYS.SESSION, session);
        localStorage.setItem(this.STORAGE_KEYS.CURRENT_USER, JSON.stringify(user));
        return session;
    }

    _failInfo(email) {
        const map = this._readJSON(this.STORAGE_KEYS.LOGIN_ATTEMPTS, {});
        return map[email.toLowerCase()] || { count: 0, lockedUntil: 0 };
    }

    _recordFail(email) {
        const map = this._readJSON(this.STORAGE_KEYS.LOGIN_ATTEMPTS, {});
        const k = email.toLowerCase();
        const info = map[k] || { count: 0, lockedUntil: 0 };
        info.count += 1;
        if (info.count >= this.AUTH.MAX_FAILED) {
            info.lockedUntil = Date.now() + this.AUTH.LOCKOUT_MS;
            info.count = 0;
        }
        map[k] = info;
        this._writeJSON(this.STORAGE_KEYS.LOGIN_ATTEMPTS, map);
    }

    _clearFails(email) {
        const map = this._readJSON(this.STORAGE_KEYS.LOGIN_ATTEMPTS, {});
        delete map[email.toLowerCase()];
        this._writeJSON(this.STORAGE_KEYS.LOGIN_ATTEMPTS, map);
    }

    /** One-time upgrade: backfill password credentials on accounts created before auth v3. */
    _migrate() {
        const ver = parseInt(localStorage.getItem(this.STORAGE_KEYS.SCHEMA_VERSION) || "0", 10);
        if (ver >= this.AUTH.SCHEMA_VERSION) return;

        const users = this.getUsers();
        let changed = false;
        users.forEach(u => {
            if (!u.credentials) { u.credentials = this._makeCredentialSync(this.AUTH.DEMO_PASSWORD, this.AUTH.SEED_ITERATIONS); changed = true; }
        });
        if (changed) this._writeJSON(this.STORAGE_KEYS.USERS, users);

        if (!localStorage.getItem(this.STORAGE_KEYS.TEMPLATES)) {
            this._writeJSON(this.STORAGE_KEYS.TEMPLATES, []);
        }
        if (!localStorage.getItem(this.STORAGE_KEYS.ACTIVE_TEMPLATE)) {
            this._writeJSON(this.STORAGE_KEYS.ACTIVE_TEMPLATE, {});
        }
        // If a legacy current-user exists without a session, mint one so the demo keeps working.
        if (localStorage.getItem(this.STORAGE_KEYS.CURRENT_USER) && !this._getSession()) {
            const cu = this._readJSON(this.STORAGE_KEYS.CURRENT_USER, null);
            const full = cu && this.getUsers().find(u => u.id === cu.id);
            if (full) this._startSession(full, false);
        }
        localStorage.setItem(this.STORAGE_KEYS.SCHEMA_VERSION, String(this.AUTH.SCHEMA_VERSION));
    }

    /** Read a JSON value from localStorage, returning `fallback` on missing/corrupt/unavailable storage. */
    _readJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (raw == null) return fallback;
            const parsed = JSON.parse(raw);
            return parsed == null ? fallback : parsed;
        } catch (e) {
            console.warn(`[BoundaryQCCMS] Could not read "${key}" from localStorage:`, e.message);
            return fallback;
        }
    }

    /** Write a JSON value to localStorage; swallows quota / private-mode errors. */
    _writeJSON(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.warn(`[BoundaryQCCMS] Could not persist "${key}" to localStorage:`, e.message);
            return false;
        }
    }

    initStorageDefaults() {
        if (!localStorage.getItem(this.STORAGE_KEYS.USERS)) {
            const cred = () => this._makeCredentialSync(this.AUTH.DEMO_PASSWORD, this.AUTH.SEED_ITERATIONS);
            const seedUsers = [
                {
                    id: "usr_psm_01",
                    fullName: "Jane Doe, PSM",
                    email: "jane.doe@kimley-horn.com",
                    role: "PSM_SURVEYOR",
                    licenseNumber: "LS6842",
                    licenseState: "FL",
                    orgId: "org_kh_01",
                    credentials: cred(),
                    createdAt: "2026-08-01T10:00:00Z"
                },
                {
                    id: "usr_pe_01",
                    fullName: "Robert Vance, PE",
                    email: "robert.vance@kimley-horn.com",
                    role: "PE_ENGINEER",
                    licenseNumber: "PE89210",
                    licenseState: "FL",
                    orgId: "org_kh_01",
                    credentials: cred(),
                    createdAt: "2026-08-02T11:30:00Z"
                },
                {
                    id: "usr_adm_01",
                    fullName: "Sarah Connor",
                    email: "sarah.c@kimley-horn.com",
                    role: "FIRM_ADMIN",
                    licenseNumber: "ADM101",
                    licenseState: "FL",
                    orgId: "org_kh_01",
                    credentials: cred(),
                    createdAt: "2026-08-03T09:15:00Z"
                }
            ];
            localStorage.setItem(this.STORAGE_KEYS.USERS, JSON.stringify(seedUsers));
        }

        if (!localStorage.getItem(this.STORAGE_KEYS.TEMPLATES)) {
            this._writeJSON(this.STORAGE_KEYS.TEMPLATES, [
                {
                    id: "tpl_seed_1", ownerId: "usr_psm_01", clientName: "Orange County BCC",
                    label: "SR-50 boundary standard", createdAt: "2026-08-05T09:00:00Z", updatedAt: "2026-08-05T09:00:00Z",
                    settings: { discipline: "SURV", idfZone: 7, sheetDwt: "keysht_WithoutMap.dwt", precisionPass: 10000, fpidPrefix: "432109", county: "Orange", district: 5, notes: "R/W retracement package." }
                },
                {
                    id: "tpl_seed_2", ownerId: "usr_psm_01", clientName: "City of Sanford",
                    label: "Drainage as-built", createdAt: "2026-08-06T09:00:00Z", updatedAt: "2026-08-06T09:00:00Z",
                    settings: { discipline: "DRAIN", idfZone: 7, sheetDwt: "FDOT-PlanProfile.dwt", precisionPass: 7500, fpidPrefix: "882019", county: "Seminole", district: 5, notes: "" }
                }
                // Plugin-specific templates (e.g. the JEA 2024 As-Built standard) do not belong
                // here — this engine is domain-agnostic. A plugin that wants its own default
                // client template creates it itself, through createTemplate() below, for the
                // signed-in user who asks for it (see plugins/tmplt-jea2024/tmplt-jea2024.js's
                // addAsClientTemplate()). A prior version hardcoded one in here directly, owned
                // by an ownerId ("usr_admin_01") that didn't match any seeded user id above
                // ("usr_adm_01") — so it silently never appeared in anyone's template list.
            ]);
        }
        if (!localStorage.getItem(this.STORAGE_KEYS.ACTIVE_TEMPLATE)) {
            this._writeJSON(this.STORAGE_KEYS.ACTIVE_TEMPLATE, { usr_psm_01: "tpl_seed_1" });
        }

        if (!localStorage.getItem(this.STORAGE_KEYS.ORGS)) {
            const seedOrgs = [
                {
                    id: "org_kh_01",
                    name: "Kimley-Horn & Associates, Inc.",
                    domain: "kimley-horn.com",
                    autoJoin: true,
                    plan: "firm",
                    purchasedSeats: 25,
                    allocatedSeats: 12,
                    createdAt: "2026-07-15T09:00:00Z"
                },
                {
                    id: "org_atkins_02",
                    name: "AtkinsRéalis Florida Infrastructure",
                    domain: "atkinsglobal.com",
                    autoJoin: true,
                    plan: "enterprise",
                    purchasedSeats: 50,
                    allocatedSeats: 34,
                    createdAt: "2026-07-20T08:30:00Z"
                }
            ];
            localStorage.setItem(this.STORAGE_KEYS.ORGS, JSON.stringify(seedOrgs));
        }

        if (!localStorage.getItem(this.STORAGE_KEYS.PROJECTS)) {
            const seedProjects = [
                {
                    id: "prj_fdot_432109",
                    fpid: "432109-1-52-01",
                    name: "SR-50 Realignment & R/W Corridor",
                    county: "Orange",
                    district: 5,
                    orgId: "org_kh_01",
                    status: "ACTIVE",
                    submittalCount: 4,
                    lastUpdated: "2026-08-12T16:45:00Z"
                },
                {
                    id: "prj_fdot_882019",
                    fpid: "882019-2-52-01",
                    name: "I-4 Ultimate Drainage & Pond Sizing",
                    county: "Seminole",
                    district: 5,
                    orgId: "org_kh_01",
                    status: "ACTIVE",
                    submittalCount: 2,
                    lastUpdated: "2026-08-11T14:20:00Z"
                }
            ];
            localStorage.setItem(this.STORAGE_KEYS.PROJECTS, JSON.stringify(seedProjects));
        }

        if (!localStorage.getItem(this.STORAGE_KEYS.SUBMITTALS)) {
            const seedSubmittals = [
                {
                    id: "sub_101",
                    projectId: "prj_fdot_432109",
                    fileName: "SR50_ROW_Plat_Submittal.dxf",
                    submittedBy: "Jane Doe, PSM",
                    status: "APPROVED",
                    score: 98,
                    precisionRatio: "1:307,958",
                    bowtieDetected: false,
                    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                    timestamp: "2026-08-12T16:45:00Z"
                }
            ];
            localStorage.setItem(this.STORAGE_KEYS.SUBMITTALS, JSON.stringify(seedSubmittals));
        }

        if (!localStorage.getItem(this.STORAGE_KEYS.TRANSACTIONS)) {
            const seedTx = [
                {
                    id: "tx_9901",
                    orgId: "org_kh_01",
                    amount: 199.00,
                    currency: "USD",
                    description: "Firm Tier Monthly License (25 Seats)",
                    status: "PAID",
                    receiptUrl: "#",
                    timestamp: "2026-08-01T00:00:00Z"
                }
            ];
            localStorage.setItem(this.STORAGE_KEYS.TRANSACTIONS, JSON.stringify(seedTx));
        }

        if (!localStorage.getItem(this.STORAGE_KEYS.AUDIT_LOGS)) {
            const seq = 1001;
            const ts = "2026-08-12T16:45:00Z";
            const actor = "Jane Doe, PSM (LS6842)";
            const action = "DIGITAL_SEAL_APPLIED";
            const details = "Signed Manifest for SR-50 Realignment under F.A.C. 5J-17.062";
            const prevHash = "0".repeat(64);
            const raw = `${seq}|${ts}|${actor}|${action}|${details}|${prevHash}`;
            const hash = window.BoundaryQCSecurity
                ? window.BoundaryQCSecurity.computeTextSHA256Sync(raw)
                : raw;
            const seedAudit = [{ id: "log_001", sequence: seq, actor, action, details, prevHash, hash, timestamp: ts }];
            localStorage.setItem(this.STORAGE_KEYS.AUDIT_LOGS, JSON.stringify(seedAudit));
        }

        if (!localStorage.getItem(this.STORAGE_KEYS.WEBHOOK_IDEMPOTENCY)) {
            localStorage.setItem(this.STORAGE_KEYS.WEBHOOK_IDEMPOTENCY, JSON.stringify([]));
        }

        // Auto-login on a fresh install (or after an upgrade with no session) so the demo is
        // usable immediately. Prefer the previously-active account if one is recorded.
        if (!localStorage.getItem(this.STORAGE_KEYS.SESSION)) {
            const users = this._readJSON(this.STORAGE_KEYS.USERS, []);
            const prev = this._readJSON(this.STORAGE_KEYS.CURRENT_USER, null);
            const who = (prev && users.find(u => u.id === prev.id)) || users[0];
            if (who) this._startSession(who, false);
        }
    }

    /** Current signed-in user, or null if there is no valid (unexpired) session. */
    getCurrentUser() {
        if (!this._getSession()) {
            localStorage.removeItem(this.STORAGE_KEYS.CURRENT_USER);
            return null;
        }
        const cu = this._readJSON(this.STORAGE_KEYS.CURRENT_USER, null);
        if (!cu) return null;
        // Return the canonical record from USERS so role/license/credential edits are reflected.
        return this.getUsers().find(u => u.id === cu.id) || cu;
    }

    isAuthenticated() { return !!this.getCurrentUser(); }

    getUsers() {
        return this._readJSON(this.STORAGE_KEYS.USERS, []);
    }

    getOrganizations() {
        return this._readJSON(this.STORAGE_KEYS.ORGS, []);
    }

    deleteUser(userId) {
        let users = this.getUsers();
        const target = users.find(u => u.id === userId);
        if (!target) return false;
        users = users.filter(u => u.id !== userId);
        localStorage.setItem(this.STORAGE_KEYS.USERS, JSON.stringify(users));

        // Release the seat this user held back to their organization's pool.
        const orgs = this.getOrganizations();
        const org = orgs.find(o => o.id === target.orgId);
        if (org && typeof org.allocatedSeats === "number") {
            org.allocatedSeats = Math.max(0, org.allocatedSeats - 1);
            localStorage.setItem(this.STORAGE_KEYS.ORGS, JSON.stringify(orgs));
        }

        const current = this.getCurrentUser();
        if (current && current.id === userId) {
            this.logoutUser();
        }
        // FIX [P2]: null-guard — actor must always be a string, not an object
        const actorName = (current && typeof current.fullName === 'string') ? current.fullName : "System";
        this.addAuditLog(actorName, "USER_DELETED", `Removed user ${target.fullName} (${target.email})`);
        return true;
    }

    updateUserRole(userId, newRole) {
        const users = this.getUsers();
        const target = users.find(u => u.id === userId);
        if (!target) return null;
        target.role = newRole;
        localStorage.setItem(this.STORAGE_KEYS.USERS, JSON.stringify(users));

        const current = this.getCurrentUser();
        if (current && current.id === userId) {
            localStorage.setItem(this.STORAGE_KEYS.CURRENT_USER, JSON.stringify(target));
        }
        this.addAuditLog(current ? current.fullName : "System", "ROLE_UPDATED", `Updated role for ${target.fullName} to ${newRole}`);
        return target;
    }

    async registerUser(fullName, email, role, licenseNumber, companyName, password) {
        const users = this.getUsers();

        // Basic email shape check — rejects attribute-breakout payloads before they reach storage/DOM.
        if (typeof email !== "string" || !/^[^\s@"'<>]+@[^\s@"'<>]+\.[^\s@"'<>]+$/.test(email.trim())) {
            throw new Error("Please enter a valid email address.");
        }
        this._validatePassword(password);
        email = email.trim();
        const domain = email.split("@")[1]?.toLowerCase() || "";

        // Check if user already exists
        if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
            throw new Error("An account with this email address already exists.");
        }

        // Domain Auto-Join
        let orgId = "org_custom_" + Date.now();
        const orgs = this.getOrganizations();
        const matchedOrg = orgs.find(o => o.domain === domain && o.autoJoin);

        if (matchedOrg) {
            // FIX [P2]: Enforce seat quota before allocating a new seat
            if (window.BoundaryQCBilling && window.BoundaryQCBilling.assertSeatAvailable) {
                window.BoundaryQCBilling.assertSeatAvailable(matchedOrg);
            }
            orgId = matchedOrg.id;
            matchedOrg.allocatedSeats += 1;
            localStorage.setItem(this.STORAGE_KEYS.ORGS, JSON.stringify(orgs));
        } else {
            const newOrg = {
                id: orgId,
                name: companyName || (domain ? domain.split(".")[0].toUpperCase() : "Individual Practice"),
                domain: domain,
                autoJoin: true,
                plan: "pro",
                purchasedSeats: 5,
                allocatedSeats: 1,
                createdAt: new Date().toISOString()
            };
            orgs.push(newOrg);
            localStorage.setItem(this.STORAGE_KEYS.ORGS, JSON.stringify(orgs));
        }

        const clean = (v, fallback) => {
            const s = (typeof v === "string" && v.trim()) ? v.trim() : fallback;
            return window.BoundaryQCSecurity ? window.BoundaryQCSecurity.sanitizeString(s) : s;
        };

        const newUser = {
            id: this._uid("usr"),
            fullName: clean(fullName, "Unnamed User"),
            email: email.toLowerCase(),
            role: this.roles[role] ? role : "PSM_SURVEYOR",
            // Optional at sign-up. Blank -> null ("not provided"); never invent a license number.
            licenseNumber: clean(licenseNumber, "") || null,
            licenseState: "FL",
            companyName: clean(companyName, ""),
            orgId: orgId,
            credentials: await this._makeCredential(password),
            createdAt: new Date().toISOString()
        };

        users.push(newUser);
        this._writeJSON(this.STORAGE_KEYS.USERS, users);
        this._startSession(newUser, false);
        this._clearFails(email);

        this.addAuditLog(newUser.fullName, "USER_REGISTERED", `New user registered with role ${newUser.role} in org ${orgId}`);
        return newUser;
    }

    /**
     * Authenticate with email + password. Enforces a lockout after repeated failures.
     * @returns {Promise<Object>} the user record
     */
    async loginUser(email, password, remember) {
        if (typeof email !== "string" || !email.trim()) throw new Error("Enter your account email.");
        email = email.trim();

        const fail = this._failInfo(email);
        if (fail.lockedUntil && Date.now() < fail.lockedUntil) {
            const secs = Math.ceil((fail.lockedUntil - Date.now()) / 1000);
            throw new Error(`Too many failed attempts. Try again in ${secs}s.`);
        }

        const target = this.getUsers().find(u => u.email.toLowerCase() === email.toLowerCase());
        // Same generic error whether the account is missing or the password is wrong.
        const ok = target && target.credentials
            ? await this._verifyCredential(target.credentials, password || "")
            : false;
        if (!ok) {
            this._recordFail(email);
            const info = this._failInfo(email);
            if (info.lockedUntil && Date.now() < info.lockedUntil) {
                const secs = Math.ceil((info.lockedUntil - Date.now()) / 1000);
                throw new Error(`Too many failed attempts. Account locked for ${secs}s.`);
            }
            const remaining = Math.max(0, this.AUTH.MAX_FAILED - info.count);
            throw new Error(`Incorrect email or password. ${remaining} attempt(s) before lockout.`);
        }

        this._clearFails(email);
        this._startSession(target, remember);
        this.addAuditLog(target.fullName, "USER_LOGIN", "Password authentication succeeded.");
        return target;
    }

    /**
     * Switch the active session to another account in the same workspace WITHOUT a password.
     * Only permitted while already authenticated (a demo convenience for the team directory).
     */
    impersonate(email) {
        if (!this.isAuthenticated()) throw new Error("Sign in first.");
        const target = this.getUsers().find(u => u.email.toLowerCase() === String(email).toLowerCase());
        if (!target) throw new Error("No account with that email.");
        const from = this.getCurrentUser();
        this._startSession(target, false);
        this.addAuditLog(target.fullName, "SESSION_SWITCHED", `Active session switched from ${from ? from.fullName : "?"} (demo convenience — no re-authentication).`);
        return target;
    }

    /** Change the current user's password (requires the old password). */
    async changePassword(oldPassword, newPassword) {
        const current = this.getCurrentUser();
        if (!current) throw new Error("Not signed in.");
        const users = this.getUsers();
        const rec = users.find(u => u.id === current.id);
        if (!rec || !(await this._verifyCredential(rec.credentials, oldPassword || ""))) {
            throw new Error("Current password is incorrect.");
        }
        this._validatePassword(newPassword);
        rec.credentials = await this._makeCredential(newPassword);
        this._writeJSON(this.STORAGE_KEYS.USERS, users);
        this.addAuditLog(rec.fullName, "PASSWORD_CHANGED", "Account password updated.");
        return true;
    }

    logoutUser() {
        const current = this.getCurrentUser();
        if (current) {
            this.addAuditLog(current.fullName, "USER_LOGOUT", "Session ended.");
        }
        localStorage.removeItem(this.STORAGE_KEYS.SESSION);
        localStorage.removeItem(this.STORAGE_KEYS.CURRENT_USER);
    }

    // ──────────────────────────────────────────────────────────────────────────
    //  Client master templates (per user; count gated by the billing tier)
    // ──────────────────────────────────────────────────────────────────────────

    /** Collision-resistant id (Date.now() alone repeats inside a loop). */
    _uid(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    }

    _allTemplates() { return this._readJSON(this.STORAGE_KEYS.TEMPLATES, []); }

    /** Templates owned by the current user. */
    getTemplates() {
        const u = this.getCurrentUser();
        if (!u) return [];
        return this._allTemplates().filter(t => t.ownerId === u.id);
    }

    /** How many templates the current user's plan allows. */
    getTemplateLimit() {
        if (window.BoundaryQCBilling && window.BoundaryQCBilling.getTemplateLimit) {
            return window.BoundaryQCBilling.getTemplateLimit();
        }
        return 5;
    }

    /** The cheapest tier that raises the template cap, for the upsell message. */
    getTemplateUpgrade() {
        if (window.BoundaryQCBilling && window.BoundaryQCBilling.nextTierForTemplates) {
            return window.BoundaryQCBilling.nextTierForTemplates();
        }
        return { name: "Firm", price: 199, limit: 25 };
    }

    createTemplate(clientName, label, settings) {
        const u = this.getCurrentUser();
        if (!u) throw new Error("Sign in to create templates.");
        const name = String(clientName || "").trim();
        if (!name) throw new Error("Client name is required.");

        const mine = this.getTemplates();
        const limit = this.getTemplateLimit();
        if (mine.length >= limit) {
            const up = this.getTemplateUpgrade();
            const err = new Error(
                `Template limit reached — ${mine.length} of ${limit} on the ${this._planLabel()} plan. ` +
                (up ? `Upgrade to ${up.name} ($${up.price}/mo, ${up.limit >= 999 ? "unlimited" : up.limit} templates) to add more.` :
                      "Upgrade your plan to add more."));
            err.code = "TEMPLATE_LIMIT";
            throw err;
        }

        const clean = v => window.BoundaryQCSecurity ? window.BoundaryQCSecurity.sanitizeString(String(v ?? "")) : String(v ?? "");
        const now = new Date().toISOString();
        const tpl = {
            id: this._uid("tpl"),
            ownerId: u.id,
            clientName: clean(name),
            label: clean(label || name),
            createdAt: now,
            updatedAt: now,
            settings: this._normalizeSettings(settings)
        };
        const all = this._allTemplates();
        all.push(tpl);
        this._writeJSON(this.STORAGE_KEYS.TEMPLATES, all);
        if (!this.getActiveTemplateId()) this.setActiveTemplate(tpl.id);
        this.addAuditLog(u.fullName, "TEMPLATE_CREATED", `Master template "${tpl.label}" for client "${tpl.clientName}" (${mine.length + 1}/${limit}).`);
        return tpl;
    }

    updateTemplate(id, patch) {
        const u = this.getCurrentUser();
        if (!u) throw new Error("Sign in first.");
        const all = this._allTemplates();
        const tpl = all.find(t => t.id === id && t.ownerId === u.id);
        if (!tpl) throw new Error("Template not found.");
        const clean = v => window.BoundaryQCSecurity ? window.BoundaryQCSecurity.sanitizeString(String(v ?? "")) : String(v ?? "");
        if (patch.clientName != null) tpl.clientName = clean(patch.clientName);
        if (patch.label != null) tpl.label = clean(patch.label);
        if (patch.settings) tpl.settings = this._normalizeSettings({ ...tpl.settings, ...patch.settings });
        tpl.updatedAt = new Date().toISOString();
        this._writeJSON(this.STORAGE_KEYS.TEMPLATES, all);
        this.addAuditLog(u.fullName, "TEMPLATE_UPDATED", `Master template "${tpl.label}" updated.`);
        return tpl;
    }

    deleteTemplate(id) {
        const u = this.getCurrentUser();
        if (!u) throw new Error("Sign in first.");
        const all = this._allTemplates();
        const tpl = all.find(t => t.id === id && t.ownerId === u.id);
        if (!tpl) return false;
        this._writeJSON(this.STORAGE_KEYS.TEMPLATES, all.filter(t => t.id !== id));
        if (this.getActiveTemplateId() === id) {
            const remaining = this.getTemplates();
            this.setActiveTemplate(remaining[0] ? remaining[0].id : null);
        }
        this.addAuditLog(u.fullName, "TEMPLATE_DELETED", `Master template "${tpl.label}" deleted.`);
        return true;
    }

    getActiveTemplateId() {
        const u = this.getCurrentUser();
        if (!u) return null;
        const map = this._readJSON(this.STORAGE_KEYS.ACTIVE_TEMPLATE, {});
        return map[u.id] || null;
    }

    setActiveTemplate(id) {
        const u = this.getCurrentUser();
        if (!u) return;
        const map = this._readJSON(this.STORAGE_KEYS.ACTIVE_TEMPLATE, {});
        if (id) map[u.id] = id; else delete map[u.id];
        this._writeJSON(this.STORAGE_KEYS.ACTIVE_TEMPLATE, map);
        if (id) {
            const tpl = this.getTemplates().find(t => t.id === id);
            if (tpl) this.addAuditLog(u.fullName, "TEMPLATE_ACTIVATED", `Active template set to "${tpl.label}" (${tpl.clientName}).`);
        }
    }

    getActiveTemplate() {
        const id = this.getActiveTemplateId();
        return id ? this.getTemplates().find(t => t.id === id) || null : null;
    }

    /** Read one setting from the active template, or a fallback. Used by other plugins. */
    getActiveTemplateSetting(key, fallback) {
        const t = this.getActiveTemplate();
        return t && t.settings && t.settings[key] != null ? t.settings[key] : fallback;
    }

    /**
     * Clamp/sanitize the FDOT roadway/survey settings fields every template shares, and pass
     * everything else through unmodified. This engine is domain-agnostic — a plugin for a
     * different discipline (e.g. plugins/tmplt-jea2024's utility settings: projection,
     * eastingMin/Max, minClearanceInches, rulesVersion, ...) can extend a template's settings
     * with its own fields without this class needing to know their names ahead of time. Only the
     * 8 fields below are normalized/clamped; an unrecognized field rides through as given, same
     * trust level as the known ones (both come from the authenticated owner, and every render of
     * a template goes through setSafeHTML regardless of which fields it reads).
     */
    _normalizeSettings(s) {
        s = s || {};
        const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
        const KNOWN = ["discipline", "idfZone", "sheetDwt", "precisionPass", "fpidPrefix", "county", "district", "notes"];
        const passthrough = {};
        Object.keys(s).forEach(k => { if (!KNOWN.includes(k)) passthrough[k] = s[k]; });
        return {
            ...passthrough,
            discipline: String(s.discipline || "ALL").toUpperCase().slice(0, 8),
            idfZone: Math.min(11, Math.max(1, Math.round(num(s.idfZone, 7)))),
            sheetDwt: String(s.sheetDwt || "CombinedLayers.dwt").slice(0, 60),
            precisionPass: Math.max(1000, Math.round(num(s.precisionPass, 10000))),
            fpidPrefix: String(s.fpidPrefix || "").replace(/[^\d-]/g, "").slice(0, 12),
            county: String(s.county || "").slice(0, 40),
            district: Math.min(8, Math.max(1, Math.round(num(s.district, 5)))),
            notes: String(s.notes || "").slice(0, 500)
        };
    }

    _planLabel() {
        if (window.BoundaryQCBilling && window.BoundaryQCBilling.currentTier) return window.BoundaryQCBilling.currentTier;
        return "Free";
    }

    /**
     * Append a SHA-256 hash-linked block to the audit chain.
     * The block hash is computed synchronously (pure-JS FIPS 180-4 via BoundaryQCSecurity)
     * BEFORE the row is persisted — the log never stores a placeholder, so there is no window
     * in which a second call links to an unhashed predecessor and no async read-modify-write
     * that could drop a concurrent append.
     * @param {string} actor - Actor display name (always a plain string)
     * @param {string} action - Action code
     * @param {string} details - Human-readable description
     */
    addAuditLog(actor, action, details) {
        const safeActor = (typeof actor === 'string') ? actor : (actor?.fullName || "System");
        const logs = this.getAuditLogs();
        const prevHash = logs.length > 0
            ? logs[logs.length - 1].hash
            : "0".repeat(64);
        const sequence = logs.length + 1001;
        const timestamp = new Date().toISOString();

        const raw = `${sequence}|${timestamp}|${safeActor}|${action}|${details}|${prevHash}`;
        const hash = window.BoundaryQCSecurity && window.BoundaryQCSecurity.computeTextSHA256Sync
            ? window.BoundaryQCSecurity.computeTextSHA256Sync(raw)
            : raw; // degraded (no crypto engine) — still a deterministic value, never "placeholder"

        const newLog = {
            id: "log_" + Date.now() + "_" + sequence,
            sequence,
            actor: safeActor,
            action,
            details,
            prevHash,
            hash,
            timestamp
        };

        logs.push(newLog);
        this._writeJSON(this.STORAGE_KEYS.AUDIT_LOGS, logs);
        return newLog;
    }

    getProjects() {
        return this._readJSON(this.STORAGE_KEYS.PROJECTS, []);
    }

    /**
     * Create a DOT project. Every field is required and validated — nothing is
     * made up: FPID as ######-#-##-## (FDOT Financial Project ID), a name, a
     * county, and district 1–8 (8 = Turnpike). Throws on invalid input.
     */
    createProject(fpid, name, county, district) {
        const f = String(fpid == null ? "" : fpid).trim(), nm = String(name == null ? "" : name).trim();
        const co = String(county == null ? "" : county).trim(), dRaw = String(district == null ? "" : district).trim();
        const errors = [];
        if (!/^\d{6}-\d-\d{2}-\d{2}$/.test(f)) errors.push("FPID must look like 441209-1-52-01.");
        if (!nm) errors.push("Project name is required.");
        if (!co) errors.push("County is required.");
        if (!/^[1-8]$/.test(dRaw)) errors.push("District must be 1–8 (8 = Turnpike).");
        if (errors.length) throw new Error(errors.join(" "));
        const projects = this.getProjects();
        const user = this.getCurrentUser();
        const newProj = {
            id: this._uid("prj_fdot"),
            fpid: f,
            name: nm,
            county: co,
            district: parseInt(dRaw, 10),
            orgId: user ? user.orgId : "org_kh_01",
            status: "ACTIVE",
            submittalCount: 0,
            lastUpdated: new Date().toISOString()
        };
        projects.unshift(newProj);
        localStorage.setItem(this.STORAGE_KEYS.PROJECTS, JSON.stringify(projects));
        this.addAuditLog(user ? user.fullName : "System", "PROJECT_CREATED", `Created FDOT Project ${newProj.fpid} - ${newProj.name}`);
        return newProj;
    }

    getSubmittals() {
        return this._readJSON(this.STORAGE_KEYS.SUBMITTALS, []);
    }

    /**
     * Record a submittal — the write side of the Submittal Vault the CMS tab
     * displays. `projectId` may be omitted (null/undefined): the current user's
     * own org project is used, falling back to the first project on file, so a
     * live DXF Auditor / Standards Compare run can record itself without the
     * caller having to know about the demo project list.
     */
    addSubmittal(projectId, fileName, status, score, precisionRatio, bowtieDetected, sha256) {
        const submittals = this.getSubmittals();
        const user = this.getCurrentUser();

        let pid = projectId;
        if (!pid) {
            const projects = this.getProjects();
            const own = user ? projects.find(p => p.orgId === user.orgId) : null;
            pid = (own || projects[0] || {}).id || null;
        }

        const newSub = {
            id: "sub_" + Date.now(),
            projectId: pid,
            fileName,
            submittedBy: user ? user.fullName : "Unknown",
            status: status || "RECORDED",
            score: typeof score === "number" ? score : null,   // null = not scored (never an invented 95)
            precisionRatio: precisionRatio || "n/a",
            bowtieDetected: !!bowtieDetected,
            sha256: (typeof sha256 === "string" && /^[0-9a-f]{64}$/i.test(sha256)) ? sha256.toLowerCase() : null, // null = no file hash computed
            timestamp: new Date().toISOString()
        };
        submittals.unshift(newSub);
        localStorage.setItem(this.STORAGE_KEYS.SUBMITTALS, JSON.stringify(submittals));
        this.addAuditLog(user ? user.fullName : "System", "SUBMITTAL_UPLOADED", `Uploaded DXF Submittal ${fileName} for Project ${pid || "(none)"}`);
        return newSub;
    }

    getTransactions() {
        return this._readJSON(this.STORAGE_KEYS.TRANSACTIONS, []);
    }

    recordTransaction(amount, description) {
        const value = typeof amount === "number" ? amount : parseFloat(amount);
        if (!Number.isFinite(value) || value <= 0) {
            throw new Error("Transaction amount must be a positive number.");
        }
        const txs = this.getTransactions();
        const user = this.getCurrentUser();
        const newTx = {
            id: "tx_" + Date.now(),
            orgId: user ? user.orgId : "org_kh_01",
            amount: value,
            currency: "USD",
            description: description || "SaaS Tier Subscription",
            status: "PAID",
            receiptUrl: "#",
            timestamp: new Date().toISOString()
        };
        txs.unshift(newTx);
        localStorage.setItem(this.STORAGE_KEYS.TRANSACTIONS, JSON.stringify(txs));
        this.addAuditLog(user ? user.fullName : "System", "COMMERCIAL_TRANSACTION", `Payment of $${newTx.amount} processed for ${newTx.description}`);
        return newTx;
    }

    getAuditLogs() {
        return this._readJSON(this.STORAGE_KEYS.AUDIT_LOGS, []);
    }

    /**
     * Cryptographically verify the entire audit trail integrity
     * @returns {Promise<Object>}
     */
    async verifyAuditIntegrity() {
        const logs = this.getAuditLogs();
        if (window.BoundaryQCSecurity && window.BoundaryQCSecurity.verifyAuditHashChain) {
            return await window.BoundaryQCSecurity.verifyAuditHashChain(logs);
        }
        return { isValid: true, count: logs.length, status: "LEGACY_CHECK" };
    }

    /**
     * Simulate a Stripe webhook with an idempotency lock and ASC 606 revenue recording.
     *
     * DEMO ONLY: the `signature` argument is accepted for shape compatibility but is NOT
     * verified — there is no webhook secret and no server. A real integration must verify the
     * Stripe-Signature header on the server before trusting the event.
     *
     * @param {Object} event { plan: 'enterprise'|'firm'|'pro'|'free', amount?: number } or full Stripe event payload
     * @param {string} signature Stripe-Signature header (ignored in this demo)
     * @param {string} idempotencyKey Unique idempotency key
     */
    processStripeWebhook(event, signature = "whsec_mock_sig", idempotencyKey = null) {
        void signature; // not verifiable client-side — see method doc
        event = event || {};
        const key = idempotencyKey || event.id || ("idemp_" + Date.now());
        const keys = this._readJSON(this.STORAGE_KEYS.WEBHOOK_IDEMPOTENCY, []);
        if (keys.includes(key)) {
            return { success: false, reason: "IDEMPOTENT_REQUEST_ALREADY_PROCESSED" };
        }
        keys.push(key);
        this._writeJSON(this.STORAGE_KEYS.WEBHOOK_IDEMPOTENCY, keys);

        const user = this.getCurrentUser();
        const isStandardStripe = !!event.type;
        const eventType = isStandardStripe ? event.type : "checkout.session.completed";
        const eventObj = isStandardStripe ? (event.data && event.data.object ? event.data.object : {}) : event;

        let plan = event.plan;
        if (!plan && eventObj.metadata && eventObj.metadata.plan) plan = eventObj.metadata.plan;
        if (!plan && eventObj.lines && eventObj.lines.data && eventObj.lines.data[0]?.price?.metadata?.plan) {
            plan = eventObj.lines.data[0].price.metadata.plan;
        }
        plan = (plan || "pro").toLowerCase();

        // Handle cancellations / downgrades
        if (eventType === "customer.subscription.deleted") {
            plan = "free";
        }

        let amount = typeof event.amount === "number" ? event.amount : (typeof eventObj.amount_total === "number" ? eventObj.amount_total / 100 : null);
        if (amount == null) {
            amount = plan === "enterprise" ? 499.00 : (plan === "firm" ? 199.00 : (plan === "pro" ? 49.00 : 0.00));
        }

        if (amount > 0) {
            const desc = `Stripe Webhook: Activated ${plan.toUpperCase()} Tier ($${amount}/mo)`;
            this.recordTransaction(amount, desc);
        }

        // Update the seats on the CURRENT user's organization (not a hardcoded orgs[0]).
        const orgs = this.getOrganizations();
        const targetOrg = (user && orgs.find(o => o.id === user.orgId)) || orgs[0];
        if (targetOrg) {
            targetOrg.plan = plan;
            targetOrg.purchasedSeats = plan === "enterprise" ? 50 : (plan === "firm" ? 25 : (plan === "pro" ? 5 : 1));
            this._writeJSON(this.STORAGE_KEYS.ORGS, orgs);
        }

        const action = eventType === "customer.subscription.deleted" ? "SUBSCRIPTION_CANCELLED" : "SUBSCRIPTION_UPGRADED";
        const logMsg = eventType === "customer.subscription.deleted"
            ? `Organization subscription cancelled (reverted to free plan).`
            : `Organization upgraded to ${plan} tier ($${amount}/mo).`;

        this.addAuditLog(user ? user.fullName : "Stripe Webhook Gateway", action, logMsg);

        return {
            success: true,
            eventType: eventType,
            plan: plan,
            amount: amount,
            idempotencyKey: key,
            processedAt: new Date().toISOString()
        };
    }

    /**
     * Generate a cloud-sync payload scoped to the current user's tenant only.
     * Rows belonging to other organizations are excluded — the export must not leak
     * cross-tenant data the way an unscoped dump would.
     */
    generateCloudSyncPayload() {
        const user = this.getCurrentUser();
        const tenantId = user ? user.orgId : "org_kh_01";
        const projects = this.getProjects().filter(p => p.orgId === tenantId);
        const projectIds = new Set(projects.map(p => p.id));
        const tenantUserIds = new Set(this.getUsers().filter(u => u.orgId === tenantId).map(u => u.id));
        // Templates carry no orgId of their own — they're scoped to their owner (ownerId), so a
        // template belongs to this tenant iff its owner does. The wire/DB field is "userId" (see
        // client_templates.user_id in db/schema.sql and server.py) — map ownerId -> userId here.
        const templates = this._allTemplates()
            .filter(t => tenantUserIds.has(t.ownerId))
            .map(t => ({
                id: t.id,
                userId: t.ownerId,
                orgId: tenantId,
                clientName: t.clientName,
                label: t.label,
                settings: t.settings,
                createdAt: t.createdAt,
                updatedAt: t.updatedAt
            }));
        return {
            schemaVersion: "2.5.0-PostgreSQL-RLS",
            tenantId,
            exportedAt: new Date().toISOString(),
            tables: {
                organizations: this.getOrganizations().filter(o => o.id === tenantId),
                users: this.getUsers().filter(u => u.orgId === tenantId),
                projects,
                client_templates: templates,
                submittals: this.getSubmittals().filter(s => projectIds.has(s.projectId)),
                transactions: this.getTransactions().filter(t => t.orgId === tenantId),
                audit_chain: this.getAuditLogs()
            }
        };
    }

    // ── Generic collection merge (used by plugins/db-sync/db-sync.js) ───────────
    // This class knows nothing about Postgres, or any other external store's column-naming —
    // that translation is db-sync's job. These merge*() methods only accept rows already shaped
    // like this class's own objects (camelCase, same fields createTemplate()/createProject()/etc.
    // produce) and upsert them into the matching localStorage-backed collection by id, so an
    // import never drops a locally-created row the remote store doesn't know about yet.

    /** Shared upsert-by-id helper: merges `incoming` into the array at `storageKey`, new rows win. */
    _mergeById(storageKey, incoming) {
        const existing = this._readJSON(storageKey, []);
        const byId = new Map(existing.map(r => [r.id, r]));
        incoming.forEach(r => byId.set(r.id, r));
        const merged = Array.from(byId.values());
        this._writeJSON(storageKey, merged);
        return merged;
    }

    mergeOrganizations(rows) { return this._mergeById(this.STORAGE_KEYS.ORGS, rows || []); }
    mergeProjects(rows) { return this._mergeById(this.STORAGE_KEYS.PROJECTS, rows || []); }
    mergeTemplates(rows) { return this._mergeById(this.STORAGE_KEYS.TEMPLATES, rows || []); }
    mergeSubmittals(rows) { return this._mergeById(this.STORAGE_KEYS.SUBMITTALS, rows || []); }
    mergeTransactions(rows) { return this._mergeById(this.STORAGE_KEYS.TRANSACTIONS, rows || []); }

    /**
     * Audit log entries are hash-chained by `sequence` — unlike the other collections, an import
     * REPLACES the local chain with the given one (sorted by sequence) rather than merging by id,
     * since two independently-extended chains can't be reconciled by an id-keyed union. Only
     * replaces when given a non-empty array, so a failed/empty fetch can't wipe the local chain.
     */
    replaceAuditChain(rows) {
        if (!Array.isArray(rows) || !rows.length) return this.getAuditLogs();
        const sorted = rows.slice().sort((a, b) => a.sequence - b.sequence);
        this._writeJSON(this.STORAGE_KEYS.AUDIT_LOGS, sorted);
        return sorted;
    }

    /** Users merge by id; never touches `credentials` for a row that already exists locally, so an
     *  import can't clobber a real PBKDF2 credential with a remote store's demo/placeholder hash —
     *  `rows` isn't expected to carry usable credentials at all. */
    mergeUsers(rows) {
        const existing = this._readJSON(this.STORAGE_KEYS.USERS, []);
        const byId = new Map(existing.map(u => [u.id, u]));
        (rows || []).forEach(u => {
            const prior = byId.get(u.id);
            byId.set(u.id, {
                ...u,
                credentials: prior ? prior.credentials : u.credentials,
                createdAt: prior ? prior.createdAt : u.createdAt
            });
        });
        const merged = Array.from(byId.values());
        this._writeJSON(this.STORAGE_KEYS.USERS, merged);
        return merged;
    }
}

// Global Export
window.BoundaryQCCMS = new BoundaryQCCMSEngine();

// This file is the pure data/logic layer only (window.BoundaryQCCMS) — no
// tab, no DOM. The UI that used to live here has moved to two dedicated
// plugins that both depend on this one:
//   plugins/security/security.js   — the sign-in/register modal, header
//                                     user indicator, change-password,
//                                     WebAuthn (NOT the same plugin as
//                                     security-pki, which is the crypto/PKI
//                                     engine — this one owns the login UI)
//   plugins/dashboard/dashboard.js — the "tab-cms" admin panel: profile
//                                     card, client templates, projects,
//                                     submittals, transaction ledger, team
//                                     directory / user management, audit log
// Still registered as a (tab-less) plugin purely so other plugins' own
// `dependencies: ["cms-engine"]` continues to resolve in the loader's
// topological sort.
if (window.PluginRegistry) {
    window.PluginRegistry.register({
        name: "cms-engine",
        version: "3.0.0",
        description: "Demo CMS data/auth engine (window.BoundaryQCCMS): PBKDF2 password sign-in + sessions + lockout, per-user client master templates (billing-tier limited), RBAC, projects/submittals, and a hash-chained audit log. Browser-local — best-effort, not a security boundary. UI lives in the security and dashboard plugins.",
        icon: "fa-database",
        tier: "Firm",
        dependencies: ["billing"]
    }, {});
}
