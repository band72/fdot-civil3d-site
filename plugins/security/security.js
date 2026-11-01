/**
 * Plugin: security (Sign-In / Account)
 * plugins/security/security.js
 *
 * The sign-in / register modal, the header's signed-in-user indicator,
 * change-password, WebAuthn, and sign-out. No tab of its own — it owns
 * the global `#modal-auth` overlay, opened from the header's account
 * button (and, cross-plugin, from the Dashboard's "Switch Account" /
 * "Add Team Member" buttons via window.Security.openModal()).
 *
 * NOT the same plugin as `security-pki` (plugins/security-pki/security-pki.js,
 * window.BoundaryQCSecurity) — that one is the crypto/PKI engine (SHA-256,
 * F.A.C. seal/timestamp gates, WebAuthn plumbing, sanitizeInput). This
 * plugin USES that one (for the WebAuthn button) but is the login UI, split
 * out of what used to be plugins/cms-engine/cms-engine.js's own DOM code.
 * The account data/auth logic itself lives in window.BoundaryQCCMS
 * (plugins/cms-engine/cms-engine.js) — this plugin is UI only.
 *
 * Registers via window.PluginRegistry. Depends on cms-engine (the account
 * data) and security-pki (WebAuthn).
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "security",
        version: "1.0.0",
        description: "Sign-in / registration modal, header account indicator, change-password, sign-out, and WebAuthn — the account UI split out of cms-engine.",
        icon: "fa-user-shield",
        tier: "Free",
        dependencies: ["cms-engine", "security-pki"],
    };

    /** Update the header's signed-in-user indicator (name/role badge). Called
     *  on init and after every auth state change here or in the Dashboard. */
    function renderHeader() {
        const cms = window.BoundaryQCCMS;
        const headerName = document.getElementById("header-user-name");
        const headerRole = document.getElementById("header-user-role");
        if (!cms) return;
        const user = cms.getCurrentUser();
        if (!user) {
            if (headerName) headerName.textContent = "Signed out";
            if (headerRole) headerRole.textContent = "—";
            return;
        }
        if (headerName) headerName.textContent = user.fullName;
        if (headerRole) headerRole.textContent = user.role.split("_")[0];
    }

    /** Populate the login modal's quick-account-switch <select> from every
     *  seeded/registered user, with the current one pre-selected. */
    function renderQuickSelect() {
        const cms = window.BoundaryQCCMS;
        const quickSelect = document.getElementById("login-quick-select");
        if (!cms || !quickSelect) return;
        const user = cms.getCurrentUser();
        const allUsers = cms.getUsers();
        window.setSafeHTML(quickSelect, allUsers.map(u => `
            <option value="${u.email}" ${user && u.email.toLowerCase() === user.email.toLowerCase() ? "selected" : ""}>
                ${u.fullName} (${u.email}) - ${cms.roles[u.role]?.name || u.role}
            </option>
        `).join(""));
    }

    /** Refresh everything this plugin owns, then let the Dashboard (if
     *  loaded and currently rendered) refresh too — auth state changed. */
    function refreshAll(ctx) {
        renderHeader();
        renderQuickSelect();
        if (window.Dashboard && typeof window.Dashboard.render === "function") window.Dashboard.render(ctx);
    }

    /** Open the auth modal, optionally forcing the Sign In or Register tab.
     *  Exposed for other plugins (the Dashboard's "Switch Account" / "Add
     *  Team Member" buttons) so they don't have to know #modal-auth's DOM. */
    function openModal(which) {
        renderQuickSelect();
        document.getElementById("modal-auth")?.classList.remove("hidden");
        if (which === "register") document.getElementById("tab-btn-register")?.click();
        else if (which === "login") document.getElementById("tab-btn-login")?.click();
    }
    function closeModal() { document.getElementById("modal-auth")?.classList.add("hidden"); }

    /** Switch the active session to another user without re-authenticating —
     *  the Team Directory's per-row "Switch" convenience. Every session/
     *  identity mutation (login, register, logout, impersonate) routes
     *  through this plugin; other plugins (the Dashboard's user table) call
     *  this instead of touching window.BoundaryQCCMS.impersonate directly. */
    function impersonate(email, ctx) {
        const user = window.BoundaryQCCMS.impersonate(email);
        refreshAll(ctx);
        return user;
    }

    const Plugin = {
        init() { renderHeader(); renderQuickSelect(); },

        setupEvents(ctx) {
            document.getElementById("btn-open-auth-modal")?.addEventListener("click", () => openModal());

            document.getElementById("btn-close-auth")?.addEventListener("click", closeModal);

            document.getElementById("btn-header-logout")?.addEventListener("click", () => {
                window.BoundaryQCCMS.logoutUser();
                ctx.showToast("Logged out of active session.");
                refreshAll(ctx);
                openModal("login");
            });

            document.getElementById("btn-webauthn-login")?.addEventListener("click", async () => {
                const email = document.getElementById("login-email")?.value || "user@boundaryqc.com";
                if (!window.BoundaryQCSecurity) return;
                const result = await window.BoundaryQCSecurity.authenticateHardwareToken(email);
                ctx.showToast(result.success ? "Authenticator responded. (Demo: the response is not verified and does not sign you in.)" : `WebAuthn: ${result.error || "Authentication cancelled."}`, !result.success);
            });

            document.getElementById("login-quick-select")?.addEventListener("change", e => {
                const loginEmailInput = document.getElementById("login-email");
                if (loginEmailInput) loginEmailInput.value = e.target.value;
            });

            // Sign In / Register tab toggle within the modal.
            const tabBtnLogin = document.getElementById("tab-btn-login");
            const tabBtnReg = document.getElementById("tab-btn-register");
            const formLogin = document.getElementById("form-auth-login");
            const formReg = document.getElementById("form-auth-register");
            tabBtnLogin?.addEventListener("click", () => {
                tabBtnLogin.style.background = "var(--primary)"; tabBtnLogin.style.color = "#fff";
                tabBtnReg.style.background = "transparent"; tabBtnReg.style.color = "var(--text-muted)";
                formLogin?.classList.remove("hidden"); formReg?.classList.add("hidden");
            });
            tabBtnReg?.addEventListener("click", () => {
                tabBtnReg.style.background = "var(--primary)"; tabBtnReg.style.color = "#fff";
                tabBtnLogin.style.background = "transparent"; tabBtnLogin.style.color = "var(--text-muted)";
                formReg?.classList.remove("hidden"); formLogin?.classList.add("hidden");
            });

            const loginBtn = document.getElementById("btn-do-login");
            loginBtn?.addEventListener("click", async () => {
                const email = document.getElementById("login-email")?.value;
                const password = document.getElementById("login-password")?.value || "";
                const remember = !!document.getElementById("login-remember")?.checked;
                if (!email) { ctx.showToast("Enter your account email.", true); return; }
                loginBtn.disabled = true;
                try {
                    const user = await window.BoundaryQCCMS.loginUser(email, password, remember);
                    const pw = document.getElementById("login-password"); if (pw) pw.value = "";
                    closeModal();
                    refreshAll(ctx);
                    ctx.showToast(`Signed in as ${user.fullName}.`);
                } catch (err) {
                    ctx.showToast(err.message, true);
                } finally {
                    loginBtn.disabled = false;
                }
            });

            const regBtn = document.getElementById("btn-do-register");
            regBtn?.addEventListener("click", async () => {
                const name = document.getElementById("reg-name")?.value;
                const email = document.getElementById("reg-email")?.value;
                const role = document.getElementById("reg-role")?.value;
                const license = document.getElementById("reg-license")?.value;
                const company = document.getElementById("reg-company")?.value;
                const password = document.getElementById("reg-password")?.value || "";
                const password2 = document.getElementById("reg-password2")?.value || "";
                if (!name || !email) { ctx.showToast("Name and email are required.", true); return; }
                if (password !== password2) { ctx.showToast("Passwords do not match.", true); return; }
                regBtn.disabled = true;
                try {
                    const user = await window.BoundaryQCCMS.registerUser(name, email, role, license, company, password);
                    ["reg-password", "reg-password2"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
                    closeModal();
                    refreshAll(ctx);
                    ctx.showToast(`Account created — signed in as ${user.fullName}.`);
                } catch (err) {
                    ctx.showToast(`Registration Error: ${err.message}`, true);
                } finally {
                    regBtn.disabled = false;
                }
            });

            document.getElementById("btn-cms-change-pw")?.addEventListener("click", async () => {
                if (!window.BoundaryQCCMS.isAuthenticated()) { ctx.showToast("Sign in first.", true); return; }
                const oldPw = await ctx.showInputModal("Current password:", "");
                if (oldPw == null) return;
                const newPw = await ctx.showInputModal("New password (min 8, 1 letter + 1 digit):", "");
                if (newPw == null) return;
                const confirmPw = await ctx.showInputModal("Confirm new password:", "");
                if (confirmPw == null) return;
                if (newPw !== confirmPw) { ctx.showToast("New passwords do not match.", true); return; }
                try {
                    await window.BoundaryQCCMS.changePassword(oldPw, newPw);
                    ctx.showToast("Password updated.");
                } catch (err) {
                    ctx.showToast(err.message, true);
                }
            });
        },
    };

    window.Security = { openModal, closeModal, renderHeader, refreshAll, impersonate };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);
})();
