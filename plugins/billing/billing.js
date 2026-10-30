/**
 * BoundaryQC & FDOT Civil3D Commercial Billing, Subscription & Feature Gating Engine
 * Enterprise Edition v2.6.0
 *
 * Features:
 * - Stripe Webhook Simulation with Double-Entry ASC 606 Ledger Sync
 * - Asymmetric Cryptographic JWT License Token Generator (SubtleCrypto ECDSA P-256)
 * - Seat Metering & Dynamic Feature Gating (Auto-Fix SCR, 9-Section QC, Civil 3D Add-in)
 *
 * FIX LOG (v2.6.0):
 * - [P0] JWT signature now uses SubtleCrypto ECDSA P-256 sign() — replaces fake char-code hex
 * - [P1] JWT stored in sessionStorage (ephemeral) instead of localStorage
 * - [P2] Seat quota enforced — throws SeatQuotaExceededError if org seats exhausted
 */

class BillingPortalEngine {
    constructor() {
        this.currentTier = localStorage.getItem("bqc_user_tier") || "Free";
        this.userEmail = localStorage.getItem("bqc_user_email") || "surveyor@kimley-horn.com";
        this.companyName = localStorage.getItem("bqc_company_name") || "Kimley-Horn & Associates, Inc.";

        // `clientTemplates` = how many per-client master templates a user may keep.
        // The base plans allow 5; more requires a higher tier.
        this.tierLimits = {
            Free:       { seats: 1,  platExtractions: 3,    clientTemplates: 5,   autoFixSCR: false, fullQCReport: false, c3dPlugin: false, apiAccess: false },
            Pro:        { seats: 1,  platExtractions: 50,   clientTemplates: 5,   autoFixSCR: true,  fullQCReport: true,  c3dPlugin: false, apiAccess: false },
            Firm:       { seats: 25, platExtractions: 9999, clientTemplates: 25,  autoFixSCR: true,  fullQCReport: true,  c3dPlugin: true,  apiAccess: true  },
            Enterprise: { seats: 50, platExtractions: 9999, clientTemplates: 999, autoFixSCR: true,  fullQCReport: true,  c3dPlugin: true,  apiAccess: true  }
        };

        // Monthly price per tier — used for upsell copy.
        this.tierPrice = { Free: 0, Pro: 49, Firm: 199, Enterprise: 499 };
        this.tierOrder = ["Free", "Pro", "Firm", "Enterprise"];

        // Generate an ECDSA P-256 key pair for JWT signing on construction.
        // NOTE (demo): a fresh key pair is created per page load, so these tokens are only
        // self-consistent within one session — there is no stable published public key for an
        // external verifier to trust. Real licensing must sign server-side with a fixed key.
        this._keyPair = null;
        this._keyReady = this._initCryptoKeyPair();

        // The public test build has no billing UI at all (core/build-info.js), so the notice
        // would only be noise in a tester's console there.
        if (!(window.BUILD_INFO && window.BUILD_INFO.publicBuild)) {
            console.warn(
                "[BillingPortal] Demo build: subscription tier is read from localStorage and JWTs are " +
                "signed with an ephemeral in-browser key. Nothing here gates a feature or verifies a payment."
            );
        }
    }

    /**
     * Generate an ECDSA P-256 key pair asynchronously.
     * The private key signs JWT tokens; the public key verifies them in the C# plugin.
     * FIX [P0]: This replaces the previous char-code hex fake "signature".
     */
    async _initCryptoKeyPair() {
        if (!window.crypto || !window.crypto.subtle) {
            console.warn('[BillingPortal] SubtleCrypto unavailable — JWT signing in simulation mode (non-HTTPS context).');
            return null;
        }
        try {
            this._keyPair = await window.crypto.subtle.generateKey(
                { name: "ECDSA", namedCurve: "P-256" },
                true,   // extractable — allows public key export for embedding in C# plugin
                ["sign", "verify"]
            );
            // Export the public key as JWK for embedding in the C# plugin
            const pubJwk = await window.crypto.subtle.exportKey("jwk", this._keyPair.publicKey);
            sessionStorage.setItem("bqc_ecdsa_pubkey_jwk", JSON.stringify(pubJwk));
        } catch (e) {
            console.warn('[BillingPortal] ECDSA key generation failed:', e.message);
        }
    }

    getLimits() {
        return this.tierLimits[this.currentTier] || this.tierLimits.Free;
    }

    /** Max per-client master templates allowed on the current tier. */
    getTemplateLimit() {
        return this.getLimits().clientTemplates || 5;
    }

    /** The cheapest tier above the current one that raises the template cap, for upsell copy. */
    nextTierForTemplates() {
        const current = this.getTemplateLimit();
        const idx = this.tierOrder.indexOf(this.currentTier);
        for (let i = Math.max(0, idx) + 1; i < this.tierOrder.length; i++) {
            const name = this.tierOrder[i];
            const cap = this.tierLimits[name].clientTemplates;
            if (cap > current) return { name, price: this.tierPrice[name], limit: cap };
        }
        return null;
    }

    /**
     * Check if an org has available seats before registration.
     * FIX [P2]: Enforces seat quota from billing tier. Throws if exhausted.
     * @param {Object} org The matched organization object
     */
    assertSeatAvailable(org) {
        if (!org) return; // No org constraint for individual plans
        const tierKey = org.plan
            ? org.plan.charAt(0).toUpperCase() + org.plan.slice(1).toLowerCase()
            : "Free";
        const limit = this.tierLimits[tierKey] || this.tierLimits.Free;
        const maxSeats = org.purchasedSeats || limit.seats;
        if (org.allocatedSeats >= maxSeats) {
            throw new Error(
                `Seat quota exceeded: ${org.name} has allocated all ${maxSeats} purchased seats. ` +
                `Contact your Firm Admin to upgrade the subscription or release an inactive seat.`
            );
        }
    }

    /**
     * Activate a commercial tier, record ASC 606 billing entry, and mint a cryptographic license JWT.
     * FIX [P0]: Uses async ECDSA signing via SubtleCrypto.
     */
    async setTier(tier, company, email) {
        if (!this.tierLimits[tier]) return;
        this.currentTier = tier;
        if (company) this.companyName = company;
        if (email) this.userEmail = email;

        localStorage.setItem("bqc_user_tier", this.currentTier);
        localStorage.setItem("bqc_company_name", this.companyName);
        localStorage.setItem("bqc_user_email", this.userEmail);

        // FIX [P0]: Generate a real cryptographic JWT and store in sessionStorage (not localStorage)
        const jwtToken = await this.generateEntitlementJwt(this.currentTier, this.companyName, this.userEmail);
        // FIX [P1]: sessionStorage — ephemeral, not accessible after tab close, not in localStorage
        sessionStorage.setItem("bqc_c3d_jwt_token", jwtToken);

        // Synchronize with Enterprise CMS engine if present
        if (window.BoundaryQCCMS && window.BoundaryQCCMS.processStripeWebhook) {
            window.BoundaryQCCMS.processStripeWebhook({
                plan: tier.toLowerCase(),
                amount: tier === "Enterprise" ? 499.00 : (tier === "Firm" ? 199.00 : (tier === "Pro" ? 49.00 : 0.00))
            });
        }

        this.updateUIForTier();
        return jwtToken;
    }

    /**
     * Get or initialize Stripe gateway configuration (simulation vs live).
     */
    getStripeConfig() {
        const raw = localStorage.getItem("bqc_stripe_config");
        const def = {
            publishableKey: "pk_test_51MockBoundaryQCFDOTCivil3D2026Key",
            mode: "simulation", // "simulation" | "live"
            paymentLinks: {
                pro: "https://buy.stripe.com/test_pro_49",
                firm: "https://buy.stripe.com/test_firm_199",
                enterprise: "https://buy.stripe.com/test_enterprise_499"
            },
            prices: {
                pro: "price_1MockPro49Monthly",
                firm: "price_1MockFirm199Monthly",
                enterprise: "price_1MockEnterprise499Monthly"
            }
        };
        if (!raw) return def;
        try { return { ...def, ...JSON.parse(raw) }; } catch (e) { return def; }
    }

    saveStripeConfig(cfg) {
        const cur = this.getStripeConfig();
        const merged = { ...cur, ...cfg };
        localStorage.setItem("bqc_stripe_config", JSON.stringify(merged));
        return merged;
    }

    /**
     * Get the active subscription details from storage.
     */
    getSubscription() {
        const raw = localStorage.getItem("bqc_stripe_subscription");
        if (!raw) {
            return {
                tier: this.currentTier,
                status: this.currentTier === "Free" ? "none" : "active",
                customerId: "cus_demo_" + (this.userEmail ? this.userEmail.replace(/[^a-zA-Z0-9]/g, "") : "anonymous"),
                subscriptionId: "sub_demo_" + this.currentTier.toLowerCase(),
                interval: "month",
                currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
                cardLast4: "4242"
            };
        }
        try { return JSON.parse(raw); } catch (e) { return null; }
    }

    saveSubscription(sub) {
        localStorage.setItem("bqc_stripe_subscription", JSON.stringify(sub));
    }

    /**
     * Cancel the active subscription and revert to the Free tier.
     */
    async cancelSubscription() {
        const sub = this.getSubscription();
        if (sub) {
            sub.status = "canceled";
            this.saveSubscription(sub);
        }
        await this.setTier("Free");
        if (window.BoundaryQCCMS && window.BoundaryQCCMS.processStripeWebhook) {
            window.BoundaryQCCMS.processStripeWebhook({
                id: "sub_del_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
                type: "customer.subscription.deleted",
                plan: "free",
                amount: 0
            });
        }
        this.updateUIForTier();
        return { success: true };
    }

    /**
     * Process checkout for a chosen tier with Stripe simulation or live payment link redirect.
     */
    async processCheckout({ plan, company, email, cardLast4, paymentLink }) {
        if (!plan) plan = "Pro";
        const tierName = plan.charAt(0).toUpperCase() + plan.slice(1).toLowerCase();
        const amount = tierName === "Enterprise" ? 499 : (tierName === "Firm" ? 199 : (tierName === "Pro" ? 49 : 0));

        const cfg = this.getStripeConfig();
        if (cfg.mode === "live" && paymentLink) {
            window.open(paymentLink, "_blank");
        }

        // 1. Activate commercial tier and mint cryptographic ECDSA JWT
        const jwt = await this.setTier(tierName, company, email);

        // 2. Save active subscription metadata
        const customerId = "cus_" + Math.random().toString(36).slice(2, 11);
        const subscriptionId = "sub_" + Math.random().toString(36).slice(2, 11);
        const subRecord = {
            tier: tierName,
            status: "active",
            customerId,
            subscriptionId,
            plan: tierName.toLowerCase(),
            amount,
            interval: "month",
            cardLast4: cardLast4 || "4242",
            createdAt: new Date().toISOString(),
            currentPeriodEnd: new Date(Date.now() + 30 * 86400000).toISOString()
        };
        this.saveSubscription(subRecord);

        // 3. Post full Stripe checkout event to CMS engine
        if (window.BoundaryQCCMS && window.BoundaryQCCMS.processStripeWebhook) {
            window.BoundaryQCCMS.processStripeWebhook({
                id: "evt_ch_" + Date.now(),
                type: "checkout.session.completed",
                plan: tierName.toLowerCase(),
                amount: amount,
                data: {
                    object: {
                        id: "cs_test_" + Date.now(),
                        customer: customerId,
                        subscription: subscriptionId,
                        amount_total: amount * 100,
                        customer_email: email,
                        metadata: { plan: tierName.toLowerCase(), company }
                    }
                }
            });
        }

        this.updateUIForTier();
        return { success: true, tier: tierName, jwt, subscription: subRecord };
    }

    /**
     * Generate an ECDSA P-256 signed JWT entitlement token.
     * FIX [P0]: Uses SubtleCrypto.sign() with actual ECDSA P-256 private key.
     * Falls back to a clearly-labeled simulated token if SubtleCrypto is unavailable.
     * @param {string} tier
     * @param {string} company
     * @param {string} email
     * @returns {Promise<string>} JWT string (header.payload.signature in base64url)
     */
    async generateEntitlementJwt(tier, company, email) {
        const headerObj = { alg: "ES256", typ: "JWT" };
        const payloadObj = {
            sub: email,
            org: company,
            tier: tier === "Enterprise" ? "B2BEnterprise" : tier,
            seats: this.tierLimits[tier]?.seats || 1,
            features: ["CMD_ADVANCED_QC", "CMD_AUTOPURGE", "CMD_FDOT_MANIFEST", "CMD_BOWTIE_SOLVER"],
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + (365 * 24 * 3600) // 1-year lease
        };

        const b64url = obj => btoa(JSON.stringify(obj))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

        const header = b64url(headerObj);
        const payload = b64url(payloadObj);
        const signingInput = `${header}.${payload}`;

        // Wait for the one-time key generation kicked off in the constructor so the first
        // mint after page load produces a real signature rather than falling back to the sim token.
        try { await this._keyReady; } catch (e) { /* fall through to simulation */ }

        // Attempt real ECDSA P-256 signing via SubtleCrypto
        if (this._keyPair && window.crypto && window.crypto.subtle) {
            try {
                const encoder = new TextEncoder();
                const sigBytes = await window.crypto.subtle.sign(
                    { name: "ECDSA", hash: { name: "SHA-256" } },
                    this._keyPair.privateKey,
                    encoder.encode(signingInput)
                );
                // IEEE P1363 raw signature (64 bytes for P-256) → base64url
                const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBytes)))
                    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                return `${signingInput}.${sigB64}`;
            } catch (e) {
                console.warn('[BillingPortal] ECDSA sign() failed:', e.message);
            }
        }

        // Fallback simulation (clearly labeled for non-HTTPS dev environments)
        const simSig = btoa(`SIM_UNSIGNED_DEV_ONLY_${tier}_${Date.now()}`)
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return `${signingInput}.${simSig}`;
    }

    /**
     * Retrieve the currently active Civil 3D JWT token from sessionStorage.
     * FIX [P1]: Reads from sessionStorage (ephemeral) not localStorage.
     * @returns {string|null}
     */
    getActiveJwt() {
        return sessionStorage.getItem("bqc_c3d_jwt_token");
    }

    isFeatureAllowed(featureName) {
        const limits = this.getLimits();
        return limits[featureName] === true || limits[featureName] > 0;
    }

    updateUIForTier() {
        const badge = document.getElementById("active-tier-badge");
        if (badge) {
            badge.textContent = `${this.currentTier.toUpperCase()} PLAN ACTIVE`;
            badge.className = `badge badge-tier-${this.currentTier.toLowerCase()}`;
        }

        // Subscription Portal status bar updates
        const planNameEl = document.getElementById("billing-current-plan-name");
        if (planNameEl) planNameEl.textContent = this.currentTier;

        const sub = this.getSubscription();
        const cusEl = document.getElementById("billing-stripe-cus-id");
        if (cusEl && sub) cusEl.textContent = sub.customerId || "cus_demo";

        const cancelBtn = document.getElementById("btn-cancel-subscription");
        if (cancelBtn) {
            cancelBtn.style.display = this.currentTier === "Free" ? "none" : "inline-flex";
        }

        // Pricing Cards CTA buttons sync
        document.querySelectorAll(".trigger-checkout").forEach(btn => {
            const btnPlan = btn.getAttribute("data-plan");
            if (btnPlan === this.currentTier) {
                btn.textContent = "Current Active Plan";
                btn.classList.remove("btn-primary", "btn-accent");
                btn.classList.add("btn-secondary");
                btn.disabled = true;
            } else {
                btn.disabled = false;
                const price = btn.getAttribute("data-price") || "0";
                const isUpgrade = this.tierOrder.indexOf(btnPlan) > this.tierOrder.indexOf(this.currentTier);
                btn.textContent = btnPlan === "Free" 
                    ? "Downgrade to Free" 
                    : (isUpgrade ? `Upgrade to ${btnPlan} ($${price}/mo)` : `Switch to ${btnPlan} ($${price}/mo)`);
                btn.classList.remove("btn-secondary");
                if (btnPlan === "Firm") btn.classList.add("btn-accent");
                else if (btnPlan === "Enterprise") btn.classList.add("btn-primary");
                else btn.classList.add("btn-primary");
            }
        });
    }
}

// Global Singleton
window.BoundaryQCBilling = new BillingPortalEngine();

if (window.PluginRegistry) {
    window.PluginRegistry.register({
        name: "billing",
        version: "2.6.0",
        description: "Stripe billing integration, ASC 606 double-entry ledger, subscription management, and ephemeral ECDSA P-256 JWT minting.",
        tab: "tab-commercial",
        icon: "fa-credit-card",
        tier: "Pro",
        dependencies: ["security-pki"]
    }, {
        init(ctx) {
            window.BoundaryQCBilling.updateUIForTier();
        },
        setupEvents(ctx) {
            const modalCheckout = document.getElementById("modal-checkout");
            const closeModal = () => {
                if (modalCheckout) modalCheckout.classList.add("hidden");
            };

            document.getElementById("btn-close-checkout")?.addEventListener("click", closeModal);
            document.getElementById("btn-cancel-checkout")?.addEventListener("click", closeModal);

            // Checkout Tabs: Card vs Stripe Payment Link
            const btnTabCard = document.getElementById("btn-checkout-tab-card");
            const btnTabLink = document.getElementById("btn-checkout-tab-link");
            const cardSec = document.getElementById("checkout-card-section");
            const linkSec = document.getElementById("checkout-link-section");

            btnTabCard?.addEventListener("click", () => {
                btnTabCard.classList.replace("btn-secondary", "btn-primary");
                btnTabLink?.classList.replace("btn-primary", "btn-secondary");
                cardSec?.classList.remove("hidden");
                linkSec?.classList.add("hidden");
            });

            btnTabLink?.addEventListener("click", () => {
                btnTabLink.classList.replace("btn-secondary", "btn-primary");
                btnTabCard?.classList.replace("btn-primary", "btn-secondary");
                linkSec?.classList.remove("hidden");
                cardSec?.classList.add("hidden");
            });

            // Open Checkout Modal from Top Button
            document.getElementById("btn-open-checkout-top")?.addEventListener("click", () => {
                const plan = "Pro";
                openCheckout(plan, "49");
            });

            // Open Checkout Modal from Pricing Cards
            document.querySelectorAll(".trigger-checkout").forEach(btn => {
                btn.addEventListener("click", () => {
                    const plan = btn.getAttribute("data-plan") || "Pro";
                    const price = btn.getAttribute("data-price") || "49";
                    openCheckout(plan, price);
                });
            });

            function openCheckout(plan, price) {
                if (!modalCheckout) return;
                modalCheckout.dataset.plan = plan;
                modalCheckout.dataset.price = price;

                const titleEl = document.getElementById("modal-plan-title");
                if (titleEl) {
                    window.setSafeHTML(titleEl, `<i class="fa-solid fa-credit-card" style="color:var(--primary);"></i> Activate ${plan} Tier ($${price}/mo)`);
                }
                const bannerName = document.getElementById("checkout-banner-name");
                if (bannerName) bannerName.textContent = `${plan} Tier Subscription`;
                const bannerPrice = document.getElementById("checkout-banner-price");
                if (bannerPrice) {
                    window.setSafeHTML(bannerPrice, `$${price}<span style="font-size:0.8rem; font-weight:400; color:var(--text-muted);">/mo</span>`);
                }

                // Pre-populate company and email from currently active session
                const user = window.BoundaryQCCMS ? window.BoundaryQCCMS.getCurrentUser() : null;
                const emailInput = document.getElementById("checkout-user-email");
                const compInput = document.getElementById("checkout-company-name");
                if (emailInput && user) emailInput.value = user.email;
                if (compInput && user) compInput.value = user.companyName || compInput.value;

                // Pre-populate Payment Link if configured
                const cfg = window.BoundaryQCBilling.getStripeConfig();
                const linkInput = document.getElementById("checkout-stripe-link-input");
                if (linkInput && cfg.paymentLinks) {
                    linkInput.value = cfg.paymentLinks[plan.toLowerCase()] || "";
                }

                modalCheckout.classList.remove("hidden");
            }

            // Stripe Checkout Form Submission
            document.getElementById("form-stripe-demo")?.addEventListener("submit", async (e) => {
                e.preventDefault();
                const plan = modalCheckout.dataset.plan || "Pro";
                const company = document.getElementById("checkout-company-name")?.value.trim() || "Kimley-Horn & Associates, Inc.";
                const email = document.getElementById("checkout-user-email")?.value.trim() || "surveyor@kimley-horn.com";
                const cardRaw = document.getElementById("checkout-card-number")?.value || "4242";
                const cardDigits = cardRaw.replace(/\D/g, "");
                const cardLast4 = cardDigits.slice(-4) || "4242";
                const paymentLink = document.getElementById("checkout-stripe-link-input")?.value.trim();

                const submitBtn = document.getElementById("checkout-submit-btn");
                if (submitBtn) {
                    submitBtn.disabled = true;
                    window.setSafeHTML(submitBtn, `<i class="fa-solid fa-spinner fa-spin"></i> Processing Stripe Payment...`);
                }

                try {
                    await window.BoundaryQCBilling.processCheckout({
                        plan,
                        company,
                        email,
                        cardLast4,
                        paymentLink
                    });
                    closeModal();
                    ctx.showToast(`🎉 ${plan} Tier Activated via Stripe! Subscription live.`);
                } catch (err) {
                    ctx.showToast(`Checkout failed: ${err && err.message ? err.message : err}`, true);
                } finally {
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        window.setSafeHTML(submitBtn, `<i class="fa-solid fa-lock"></i> Confirm &amp; Activate Plan`);
                    }
                }
            });

            // Subscription Management Buttons
            document.getElementById("btn-cancel-subscription")?.addEventListener("click", async () => {
                const ok = await ctx.showConfirmModal(
                    "Cancel Subscription",
                    "Are you sure you want to cancel your paid subscription and revert to the Free plan? You will retain standard layer access."
                );
                if (ok) {
                    await window.BoundaryQCBilling.cancelSubscription();
                    ctx.showToast("Subscription cancelled. Organization reverted to Free plan.");
                }
            });

            // Toggle Stripe Config Panel
            document.getElementById("btn-manage-stripe-portal")?.addEventListener("click", () => {
                const panel = document.getElementById("stripe-config-panel");
                if (!panel) return;
                panel.classList.toggle("hidden");
                if (!panel.classList.contains("hidden")) {
                    const cfg = window.BoundaryQCBilling.getStripeConfig();
                    const pubInput = document.getElementById("stripe-pubkey-input");
                    const modeSelect = document.getElementById("stripe-mode-select");
                    if (pubInput) pubInput.value = cfg.publishableKey || "";
                    if (modeSelect) modeSelect.value = cfg.mode || "simulation";
                }
            });

            // Save Stripe Config
            document.getElementById("btn-save-stripe-config")?.addEventListener("click", () => {
                const pubKey = document.getElementById("stripe-pubkey-input")?.value.trim();
                const mode = document.getElementById("stripe-mode-select")?.value;
                window.BoundaryQCBilling.saveStripeConfig({ publishableKey: pubKey, mode: mode });
                document.getElementById("stripe-config-panel")?.classList.add("hidden");
                ctx.showToast("Stripe gateway settings saved.");
            });

            // View Invoices / Receipts
            document.getElementById("btn-view-invoices")?.addEventListener("click", () => {
                const logs = window.BoundaryQCCMS ? window.BoundaryQCCMS.getTransactions() : [];
                const count = logs.length;
                ctx.showToast(`Showing ${count} transaction ledger receipts in CMS audit log.`);
                document.querySelector('.nav-btn[data-tab="tab-cms"]')?.click();
            });

            // Mint Civil 3D License Token using real async ECDSA JWT
            document.getElementById("btn-mint-c3d-jwt")?.addEventListener("click", async () => {
                const user = window.BoundaryQCCMS ? window.BoundaryQCCMS.getCurrentUser() : null;
                const companyName = user ? (user.companyName || "Kimley-Horn & Associates, Inc.") : "Kimley-Horn & Associates, Inc.";
                const email = user ? user.email : "surveyor@kimley-horn.com";

                const token = await window.BoundaryQCBilling.generateEntitlementJwt(
                    window.BoundaryQCBilling.currentTier,
                    companyName,
                    email
                );
                sessionStorage.setItem("bqc_c3d_jwt_token", token);

                if (navigator.clipboard?.writeText) {
                    navigator.clipboard.writeText(token).then(() => {
                        ctx.showToast("Copied Civil 3D ECDSA License JWT Token to Clipboard!");
                    }).catch(() => {
                        ctx.showCopyModal("Civil 3D ECDSA License JWT Token", token);
                    });
                } else {
                    ctx.showCopyModal("Civil 3D ECDSA License JWT Token", token);
                }
            });
        }
    });
}
