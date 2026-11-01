/**
 * BoundaryQC & FDOT Civil3D Security, Cryptography & PKI Compliance Engine
 * Enterprise Edition v2.6.0
 *
 * Statutory Compliance:
 * - Florida Administrative Code (F.A.C.) Rule 61G15-23.004 (PE Seal & Digital Signature)
 * - Florida Administrative Code (F.A.C.) Rule 5J-17.062 (PSM Seal & Digital Signature)
 * - FDOT Electronic Delivery Guidelines (EDG) Topic No. 625-050-001
 * - NIST SP 800-63 IAL2/AAL3 PKI Standards & PAdES-LTV (Long-Term Validation)
 * - RFC 3161 Cryptographic Time-Stamp Authority (TSA) Protocols
 * - FIPS 180-4 SHA-256 hash-linked audit chain integrity verification
 * - OWASP Top 10 Enterprise Input Hardening & XSS Defense
 *
 * FIX LOG (v2.6.0):
 * - [P0] Replaced FNV-1a _fallbackSHA256 with FIPS 180-4 compliant pure-JS SHA-256
 * - [P1] Strengthened CA exact-match (case-insensitive equality, not substring)
 * - [P1] Implemented real navigator.credentials.get() WebAuthn authentication
 */

class BoundaryQCSecurityEngine {
    constructor() {
        this.signatureNoticePE = "THE OFFICIAL RECORD OF THIS SHEET IS THE ELECTRONIC FILE. DIGITALLY SIGNED AND SEALED UNDER RULE 61G15-23.004, F.A.C.";
        this.signatureNoticePSM = "THE OFFICIAL RECORD OF THIS SHEET IS THE ELECTRONIC FILE. DIGITALLY SIGNED AND SEALED UNDER RULE 5J-17.062, F.A.C.";
        // FIX [P1]: Use exact canonical names for matching (see verifyPKICertificate)
        this.approvedCAs = [
            "identrust aces business ca",
            "identros digital seal ca",
            "digicert pki platform ca",
            "entrust authority qualified ca",
            "globalsign gcc r6 digital seal ca"
        ];
        this.approvedTSAs = [
            "digicert sha256 rfc3161 time-stamp authority",
            "identrust commercial timestamping service",
            "sectigo rfc3161 qualified tsa"
        ];

        // FIPS 180-4 SHA-256 constants (first 32 bits of fractional parts of cube roots of first 64 primes)
        this._K = [
            0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
            0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
            0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
            0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
            0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
        ];
    }

    /**
     * Pure-JS FIPS 180-4 SHA-256 implementation.
     * Produces identical output to SubtleCrypto SHA-256 in all environments.
     * @param {Uint8Array} data
     * @returns {string} 64-char lowercase hex string
     */
    _pureSHA256(data) {
        const K = this._K;
        // Initial hash values (first 32 bits of fractional parts of square roots of first 8 primes)
        let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
        let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

        // Pre-processing: padding
        const msgLen = data.length;
        const bitLen = msgLen * 8;

        // Total length must be a multiple of 64 bytes (512 bits) with room for 1 byte (0x80) + 8 bytes (bit length)
        const totalLen = Math.ceil((msgLen + 9) / 64) * 64;
        const padded = new Uint8Array(totalLen);
        padded.set(data);
        padded[msgLen] = 0x80;

        // Append original length as 64-bit big-endian
        for (let i = 7; i >= 0; i--) {
            padded[totalLen - 1 - i] = (bitLen / Math.pow(2, i * 8)) & 0xff;
        }

        // Process each 512-bit (64-byte) chunk
        for (let chunkStart = 0; chunkStart < totalLen; chunkStart += 64) {
            const w = new Uint32Array(64);
            for (let i = 0; i < 16; i++) {
                w[i] = ((padded[chunkStart + i * 4] << 24) |
                         (padded[chunkStart + i * 4 + 1] << 16) |
                         (padded[chunkStart + i * 4 + 2] << 8) |
                          padded[chunkStart + i * 4 + 3]) >>> 0;
            }
            for (let i = 16; i < 64; i++) {
                const s0 = (this._rotr32(w[i - 15], 7) ^ this._rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
                const s1 = (this._rotr32(w[i - 2], 17) ^ this._rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
            }

            let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;

            for (let i = 0; i < 64; i++) {
                const S1 = (this._rotr32(e, 6) ^ this._rotr32(e, 11) ^ this._rotr32(e, 25)) >>> 0;
                const ch = ((e & f) ^ (~e & g)) >>> 0;
                const temp1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
                const S0 = (this._rotr32(a, 2) ^ this._rotr32(a, 13) ^ this._rotr32(a, 22)) >>> 0;
                const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
                const temp2 = (S0 + maj) >>> 0;

                hh = g; g = f; f = e;
                e = (d + temp1) >>> 0;
                d = c; c = b; b = a;
                a = (temp1 + temp2) >>> 0;
            }

            h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0;
            h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
            h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0;
            h6 = (h6 + g) >>> 0; h7 = (h7 + hh) >>> 0;
        }

        return [h0, h1, h2, h3, h4, h5, h6, h7]
            .map(v => (v >>> 0).toString(16).padStart(8, '0'))
            .join('');
    }

    _rotr32(x, n) {
        return ((x >>> n) | (x << (32 - n))) >>> 0;
    }

    /**
     * Compute SHA-256 digest for an ArrayBuffer or Uint8Array.
     * Uses SubtleCrypto when available (HTTPS), falls back to pure-JS FIPS 180-4.
     * @param {ArrayBuffer|Uint8Array} buffer
     * @returns {Promise<string>} Hex-encoded SHA-256 hash string
     */
    async computeSHA256(buffer) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        if (window.crypto && window.crypto.subtle) {
            try {
                const hashBuffer = await window.crypto.subtle.digest("SHA-256", bytes);
                return Array.from(new Uint8Array(hashBuffer))
                    .map(b => b.toString(16).padStart(2, '0')).join('');
            } catch (e) {
                // SubtleCrypto unavailable in this context — fall through
            }
        }
        // FIX [P0]: Pure-JS FIPS 180-4 SHA-256 — produces identical output to SubtleCrypto
        return this._pureSHA256(bytes);
    }

    /**
     * Compute SHA-256 for a plain text string.
     * @param {string} text
     * @returns {Promise<string>}
     */
    async computeTextSHA256(text) {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        return await this.computeSHA256(data);
    }

    /**
     * Synchronous SHA-256 for a plain text string (pure-JS FIPS 180-4, no SubtleCrypto).
     * Used where a hash must be produced before a value is persisted — e.g. the audit log,
     * which must never store a placeholder that a later verifier would have to trust.
     * @param {string} text
     * @returns {string} 64-char lowercase hex
     */
    computeTextSHA256Sync(text) {
        return this._pureSHA256(new TextEncoder().encode(text));
    }

    /**
     * Sanitize user-supplied input strings against XSS injection.
     * @param {string} str
     * @returns {string} Sanitized string
     */
    sanitizeInput(str) {
        if (typeof str !== 'string') return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;')
            .replace(/\//g, '&#x2F;');
    }

    sanitizeString(str) {
        return this.sanitizeInput(str);
    }

    /**
     * Generate an FDOT-Compliant Cryptographic Submittal Manifest.
     * @param {string} projectNumber FDOT Financial Project ID (e.g. 432109-1-52-01)
     * @param {Array<{fileName: string, content: string|ArrayBuffer, category: string}>} files
     * @param {Object} licenseeInfo { name: "Jane Doe, PSM", license: "LS6842", rule: "5J-17.062" }
     * @returns {Promise<Object>}
     */
    async generateFDOTSubmittalManifest(projectNumber, files, licenseeInfo) {
        const sanitizedProj = this.sanitizeInput(projectNumber);
        const timestamp = new Date().toISOString();
        const fileManifests = [];

        for (const file of files) {
            let buffer;
            if (typeof file.content === 'string') {
                buffer = new TextEncoder().encode(file.content);
            } else {
                buffer = file.content;
            }
            const hash = await this.computeSHA256(buffer);
            fileManifests.push({
                fileName: this.sanitizeInput(file.fileName),
                category: this.sanitizeInput(file.category || 'roadway'),
                sizeBytes: buffer.byteLength || buffer.length || 0,
                sha256: hash
            });
        }

        const isSurveyor = licenseeInfo.rule === "5J-17.062" ||
            (licenseeInfo.license && licenseeInfo.license.startsWith("LS"));

        const manifestObj = {
            submittalId: `FDOT-FIN-${sanitizedProj}`,
            timestamp: timestamp,
            specification: "FDOT Electronic Delivery Guidelines Topic No. 625-050-001",
            licensee: {
                name: this.sanitizeInput(licenseeInfo.name),
                licenseNumber: this.sanitizeInput(licenseeInfo.license),
                statute: isSurveyor
                    ? "Chapter 472, F.S. / F.A.C. 5J-17.062 (PSM)"
                    : "Chapter 471, F.S. / F.A.C. 61G15-23.004 (PE)",
                statutoryNotice: isSurveyor ? this.signatureNoticePSM : this.signatureNoticePE,
                sealAuthority: isSurveyor ? "Professional Surveyor and Mapper" : "Professional Engineer"
            },
            files: fileManifests
        };

        const manifestJson = JSON.stringify(manifestObj, null, 2);
        const masterHash = await this.computeTextSHA256(manifestJson);

        return {
            manifest: manifestObj,
            manifestJson: manifestJson,
            masterHash: masterHash
        };
    }

    /**
     * Pre-check a PKI digital seal's issuing CA against the approved-CA allowlist.
     * Exact case-insensitive equality match — no substring spoofing.
     * This is a NAME check only: no certificate is parsed, no chain is built and no
     * OCSP/CRL revocation query is made. A rejection is definitive (`valid: false`);
     * passing the allowlist is not verification, so `valid` is `null` ("not verified").
     * @param {string} certificateCA
     * @param {boolean} isLTVEnabled Caller's claim that the signature embeds LTV data
     * @returns {Object}
     */
    verifyPKICertificate(certificateCA, isLTVEnabled = true) {
        const normalizedInput = String(certificateCA || "").trim().toLowerCase();
        const isApproved = this.approvedCAs.some(ca => normalizedInput === ca);
        if (!isApproved) {
            return {
                valid: false,
                allowlisted: false,
                reason: "NON-COMPLIANT: Certificate Authority is not on this tool's approved-CA allowlist.",
                status: "CRITICAL_SECURITY_REJECTION",
                fdotCompliant: false
            };
        }
        if (!isLTVEnabled) {
            return {
                valid: false,
                allowlisted: true,
                reason: "NON-COMPLIANT: Signature was reported as lacking embedded PAdES-LTV (OCSP/CRL) revocation data.",
                status: "LTV_MISSING",
                fdotCompliant: false
            };
        }
        return {
            valid: null,
            allowlisted: true,
            reason: "NOT VERIFIED: the CA name is on the allowlist, but no certificate, chain or revocation status was checked. Verify the seal in a PKI-capable reader (e.g. Adobe Acrobat).",
            status: "ALLOWLISTED_NOT_VERIFIED",
            fdotCompliant: null,
            certificateAuthority: certificateCA,
            revocationCheckedAt: null
        };
    }

    /**
     * Pre-check an RFC 3161 Time-Stamp Authority name against the approved-TSA allowlist.
     * This is a NAME check only: no time-stamp token is parsed, so the message imprint
     * and the certified time are unknown (`null`). An unapproved TSA is definitive
     * (`timestampValid: false`); an approved one is `null` ("not verified").
     * @param {string} manifestHash SHA-256 digest of the submittal manifest
     * @param {string} [tsaProvider] Optional TSA provider name
     * @returns {Promise<Object>}
     */
    async verifyRFC3161Timestamp(manifestHash, tsaProvider = "DigiCert SHA256 RFC3161 Time-Stamp Authority") {
        const normalizedProvider = String(tsaProvider || "").trim().toLowerCase();
        const isApprovedTSA = this.approvedTSAs.some(tsa => normalizedProvider === tsa);

        return {
            timestampValid: isApprovedTSA ? null : false,
            providerAllowlisted: isApprovedTSA,
            tsaProvider: tsaProvider,
            certifiedTime: null,
            messageImprintMatch: null,
            manifestHash: manifestHash,
            status: isApprovedTSA ? "ALLOWLISTED_NOT_VERIFIED" : "UNTRUSTED_TSA",
            complianceNote: "No time-stamp token was parsed — this checks the TSA name only and is not evidence of a trusted timestamp."
        };
    }

    /**
     * Recompute and verify an entire hash-linked (blockchain-style) audit log chain.
     * Hash formula: SHA256(seq | timestamp | actor | action | details | prevHash)
     * @param {Array<Object>} auditLogs
     * @returns {Promise<Object>} Verification outcome with tamper detection
     */
    async verifyAuditHashChain(auditLogs) {
        if (!auditLogs || auditLogs.length === 0) {
            return { isValid: true, count: 0, rootHash: "EMPTY_LEDGER", message: "Audit log is currently empty." };
        }

        let expectedPrevHash = "0000000000000000000000000000000000000000000000000000000000000000";

        for (let i = 0; i < auditLogs.length; i++) {
            const block = auditLogs[i];

            // 1. Verify previous hash link
            if (block.prevHash !== expectedPrevHash) {
                return {
                    isValid: false,
                    tamperedBlockIndex: i,
                    blockSequence: block.sequence,
                    errorType: "PREV_HASH_MISMATCH",
                    message: `Cryptographic link broken at Sequence #${block.sequence}! Expected prevHash ${expectedPrevHash.substring(0, 10)}... but found ${block.prevHash.substring(0, 10)}...`
                };
            }

            // 2. Recompute the block hash and require an exact match — no placeholder is trusted.
            const raw = `${block.sequence}|${block.timestamp}|${block.actor}|${block.action}|${block.details}|${block.prevHash}`;
            const computedHash = await this.computeTextSHA256(raw);

            if (block.hash !== computedHash) {
                return {
                    isValid: false,
                    tamperedBlockIndex: i,
                    blockSequence: block.sequence,
                    errorType: "BLOCK_CONTENT_TAMPERED",
                    message: `Block payload altered at Sequence #${block.sequence}! Content hash does not match the recomputed digest.`
                };
            }

            expectedPrevHash = block.hash;
        }

        return {
            isValid: true,
            totalBlocksVerified: auditLogs.length,
            rootHash: auditLogs[auditLogs.length - 1].hash,
            verifiedAt: new Date().toISOString(),
            status: "HASH_CHAIN_INTACT",
            note: "Every block digest was recomputed and every prevHash link checked. This proves the local " +
                  "log has not been edited in place; it is not an external notarization or a tamper-proof store."
        };
    }

    /**
     * Initiate WebAuthn / FIDO2 Hardware Key Authentication via real navigator.credentials.get().
     * Falls back to a simulated flow if WebAuthn is unavailable in the current environment.
     * FIX [P1]: Now calls real browser WebAuthn API instead of always resolving success.
     * @param {string} userEmail
     * @returns {Promise<Object>}
     */
    async authenticateHardwareToken(userEmail) {
        if (!navigator.credentials || !window.PublicKeyCredential) {
            // WebAuthn not available (non-HTTPS, old browser). Fail closed — do NOT report success.
            console.warn('[BoundaryQCSecurity] WebAuthn unavailable — hardware-token step cannot be satisfied here.');
            return {
                success: false,
                user: this.sanitizeInput(userEmail),
                error: "WebAuthn is unavailable in this context. A FIDO2/WebAuthn hardware token requires HTTPS (or localhost) and a compatible authenticator.",
                errorName: "WebAuthnUnavailable"
            };
        }

        // Random, unpredictable challenge. NOTE: this is a client-only demo — there is no
        // relying-party server, so the returned assertion's signature is never verified.
        // `success` means "an authenticator responded", not "the user is authenticated".
        const challengeBytes = window.crypto.getRandomValues(new Uint8Array(32));

        try {
            const credential = await navigator.credentials.get({
                publicKey: {
                    challenge: challengeBytes,
                    rpId: window.location.hostname || 'localhost',
                    allowCredentials: [], // Discoverable resident key
                    userVerification: "preferred",
                    timeout: 60000
                }
            });

            const credId = credential
                ? Array.from(new Uint8Array(credential.rawId))
                    .map(b => b.toString(16).padStart(2, '0')).join('')
                : "unknown";

            return {
                success: true,
                user: this.sanitizeInput(userEmail),
                verified: false,   // no server-side signature verification in this static app
                credentialId: credId,
                authMethod: "FIDO2 / WebAuthn authenticator",
                authenticatorAttachment: credential?.authenticatorAttachment || "cross-platform",
                respondedAt: new Date().toISOString()
            };
        } catch (err) {
            // User cancelled or no authenticator available
            if (err.name === 'NotAllowedError') {
                return {
                    success: false,
                    user: this.sanitizeInput(userEmail),
                    error: "WebAuthn authentication was cancelled or timed out.",
                    errorName: err.name
                };
            }
            return {
                success: false,
                user: this.sanitizeInput(userEmail),
                error: err.message,
                errorName: err.name
            };
        }
    }

    /**
     * Report how this app handles a drawing you open — stated accurately, not
     * marketed. The real property worth knowing: the app's own code cannot send
     * an opened drawing anywhere (CSP `connect-src 'self'` blocks every
     * cross-origin fetch/XHR/WebSocket), and all parsing/diffing/auto-correcting/hashing
     * happens in this tab. Every static asset (DOMPurify, Font Awesome, web fonts)
     * is self-hosted, and the CSP allows no third-party origin for scripts,
     * styles, fonts or connections — so `staticAssetHosts` is honestly empty.
     * (It is still not "air-gapped": the page itself is fetched from its host.)
     */
    getPrivacyDiagnostics() {
        const hasSubtle = Boolean(window.crypto && window.crypto.subtle);
        return {
            clientSideExecution: true,
            drawingProcessing: "In-page only — drawings are parsed, diffed, auto-corrected and hashed in this browser tab. Nothing is uploaded.",
            appNetworkAccess: "Blocked to third parties by CSP connect-src 'self' — this app's JavaScript cannot fetch, XHR or open a WebSocket to any other origin, so an opened drawing cannot be transmitted by it.",
            staticAssetHosts: [],
            assetHosting: "Self-hosted — DOMPurify, Font Awesome and the web fonts are served from this site; the CSP allows no third-party script, style, font or connection origin.",
            analytics: "None — no analytics, tracking, or beacon scripts are loaded.",
            cryptoEngine: hasSubtle
                ? "SubtleCrypto SHA-256, with a pure-JS FIPS 180-4 fallback"
                : "Pure-JS FIPS 180-4 SHA-256",
            storageType: "Browser-local only (sessionStorage / localStorage) — never sent anywhere.",
            cspActive: true,
            isSecureContext: Boolean(window.isSecureContext),
            protocol: (window.location && window.location.protocol) || "https:"
        };
    }

    /**
     * Build an UNOFFICIAL CADD self-check summary from an audit result.
     *
     * This is NOT an FDOT submittal, an F.A.C. compliance certificate, or a
     * substitute for a licensed review / professional seal. The score and grade
     * come from this tool's own demo heuristics run against unverified reference
     * data (see core/data.js). It exists so a user can save/print a record of
     * what the tool checked — clearly labelled as such by the modal's disclaimer.
     *
     * No default licensee/firm is invented — signatory fields are blank unless
     * the caller supplies real ones.
     *
     * @param {Object} auditData
     * @param {Object} [signatory]  { name, license, firm } — optional, caller-supplied
     * @returns {Promise<Object>}
     */
    async generateSubmittalCertificate(auditData = {}, signatory = {}) {
        const filename = this.sanitizeInput(auditData.filename || "drawing.dxf");
        const rawContent = auditData.rawContent || auditData.content || "";
        // No content and no supplied digest -> not hashed. Never present the empty-input digest as the file's.
        const hash = auditData.sha256 || (rawContent ? await this.computeTextSHA256(rawContent) : null);

        // No score supplied -> not scored. Never invent one (this used to default to 85 / 100).
        const score = typeof auditData.score === "number" && isFinite(auditData.score) ? Math.max(0, Math.min(100, Math.round(auditData.score))) : null;
        let grade = "F";
        let statusText = "FAILS THE CHECKS";
        let gradeColor = "var(--danger)";
        if (score === null) { grade = "N/A"; statusText = "NOT SCORED"; gradeColor = "var(--text-muted)"; }
        else if (score >= 95) { grade = "A+"; statusText = "PASSES ALL CHECKS"; gradeColor = "var(--success)"; }
        else if (score >= 90) { grade = "A"; statusText = "PASSES"; gradeColor = "var(--success)"; }
        else if (score >= 80) { grade = "B"; statusText = "MINOR ISSUES"; gradeColor = "var(--accent)"; }
        else if (score >= 70) { grade = "C"; statusText = "NEEDS REVIEW"; gradeColor = "var(--warning)"; }

        const timestamp = new Date().toISOString();
        const summaryId = `SELFCHK-${Date.now().toString(36).toUpperCase()}-${hash ? hash.substring(0, 8).toUpperCase() : "UNHASHED"}`;
        const standardName = this.sanitizeInput(auditData.standardName || "FDOT 2026 CADD State Kit Standard (demo ruleset)");

        return {
            summaryId,
            certId: summaryId,   // back-compat alias for callers/tests
            filename,
            sha256: hash,
            fingerprint: hash ? hash.substring(0, 16).toUpperCase() : null,
            score,
            grade,
            gradeColor,
            statusText,
            timestamp,
            // Only populated if the caller passes real values — nothing invented.
            signerName: this.sanitizeInput(signatory.name || ""),
            signerLicense: this.sanitizeInput(signatory.license || ""),
            signerFirm: this.sanitizeInput(signatory.firm || ""),
            standardName,
            disclaimer: "Unofficial self-check. Produced in this browser from this tool's demo rules and unverified reference data — not an FDOT submittal, an F.A.C. compliance certificate, or a substitute for a licensed review or professional seal.",
            violationsCount: auditData.violationsCount ?? (auditData.issues ? auditData.issues.length : 0),
            scoreBasis: auditData.scoreBasis ? this.sanitizeInput(auditData.scoreBasis) : null,
            layersCount: auditData.layersCount ?? null,
            entitiesCount: auditData.entitiesCount ?? null,
            autoHealReady: Boolean(auditData.autoHealReady)
        };
    }
}

// Global Security Engine Singleton
window.BoundaryQCSecurity = new BoundaryQCSecurityEngine();

if (window.PluginRegistry) {
    window.PluginRegistry.register({
        name: "security-pki",
        version: "2.6.0",
        description: "FIPS 180-4 SHA-256, F.A.C. PKI CA/TSA validation, hash-chain audit verifier, and WebAuthn.",
        tab: null,
        icon: "fa-shield-halved",
        tier: "Free",
        dependencies: []
    }, {
        init(ctx) {},
        setupEvents(ctx) {}
    });
}
