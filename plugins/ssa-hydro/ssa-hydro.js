/**
 * Plugin: ssa-hydro (SSA Hydrology & IDF)
 * plugins/ssa-hydro/ssa-hydro.js
 *
 * Rational Method peak discharge (Q = Cf·C·i·A) and an exfiltration-trench length sizer.
 * Registers via window.PluginRegistry. Pure math is exposed on window.SSAHydro for tests.
 *
 * Honesty notes (see README):
 *  - The per-zone IDF a/b/c coefficients in core/data.js are illustrative, single-curve
 *    values with no return period. For design, read the intensity off the current official
 *    FDOT IDF curve for your zone, return period and Tc and enter it as the intensity override.
 *  - The trench equation is the SFWMD / FDOT exfiltration-trench equation as commonly
 *    published; confirm its form and the design inputs (K from field tests, water-table depth,
 *    safety factor) against the current FDOT Drainage Design Guide / SFWMD ERP Applicant's
 *    Handbook before relying on it.
 *  - Blank, zero or out-of-range inputs are rejected — never silently replaced by a default.
 */
(function () {
    const MANIFEST = {
        name: "ssa-hydro",
        version: "2.7.0",
        description: "Rational Method Q solver and exfiltration trench sizer.",
        tab: "tab-ssa",
        icon: "fa-cloud-showers-heavy",
        tier: "Free",
        dependencies: []
    };

    /** 1 acre-inch in cubic feet (43,560 ft² × 1/12 ft). */
    const CF_PER_ACRE_INCH = 3630;

    /**
     * Rational-method frequency factor Cf for less-frequent storms (C·Cf capped at 1.0).
     * Commonly tabulated: ≤10-yr 1.00, 25-yr 1.10, 50-yr 1.20, 100-yr 1.25.
     */
    function frequencyFactor(returnPeriodYr) {
        const T = Number(returnPeriodYr);
        if (!(T > 0)) return null;
        if (T <= 10) return 1.0;
        if (T <= 25) return 1.1;
        if (T <= 50) return 1.2;
        return 1.25;
    }

    /** Parse a numeric form value; returns NaN for blank/non-numeric (never a default). */
    function num(v) {
        if (v === null || v === undefined) return NaN;
        const s = String(v).trim();
        if (s === "") return NaN;
        const n = Number(s);
        return isFinite(n) ? n : NaN;
    }

    /** Intensity (in/hr) from an a/(Tc+b)^c curve. */
    function idfIntensity(zone, tcMin) {
        if (!zone || !(tcMin > 0)) return NaN;
        return zone.a / Math.pow(tcMin + zone.b, zone.c);
    }

    /**
     * Rational Method. Inputs: { areaAc, c, tcMin, returnPeriodYr, intensity? , zone? }.
     * Uses `intensity` (in/hr) when given, otherwise the zone's illustrative curve.
     * Returns { ok, errors[], q, intensity, cf, cEff, intensitySource }.
     */
    function rationalQ(inp) {
        const errors = [];
        const A = num(inp.areaAc), C = num(inp.c), tc = num(inp.tcMin), T = num(inp.returnPeriodYr);
        const iOverride = num(inp.intensity);
        if (!(A > 0)) errors.push("Drainage area must be a number greater than 0 acres.");
        if (!(C > 0 && C <= 1)) errors.push("Runoff coefficient C must be greater than 0 and at most 1.0.");
        if (!(T > 0)) errors.push("Return period must be a number of years greater than 0.");
        let intensity, source;
        if (!isNaN(iOverride)) {
            if (!(iOverride > 0)) errors.push("Intensity override must be greater than 0 in/hr (or leave it blank).");
            intensity = iOverride; source = "entered intensity";
        } else {
            if (!(tc > 0)) errors.push("Time of concentration must be greater than 0 minutes.");
            if (!inp.zone) errors.push("Select a rainfall zone, or enter an intensity from the official IDF curve.");
            intensity = idfIntensity(inp.zone, tc);
            source = "illustrative zone curve (not design data)";
        }
        if (errors.length) return { ok: false, errors };
        const cf = frequencyFactor(T);
        const cEff = Math.min(1, C * cf);
        // Q (cfs) = C·i·A with i in in/hr and A in acres (the 1.008 unit factor is taken as 1).
        return { ok: true, errors: [], q: cEff * intensity * A, intensity, cf, cEff, intensitySource: source };
    }

    /**
     * Exfiltration trench length (ft), SFWMD / FDOT form:
     *   L = FS·V / [ K·(H2·W + 2·H2·Du − Du² + 2·H2·Ds) + 1.39×10⁻⁴·W·Du ]
     * V  volume to exfiltrate (acre-inches)        K  hydraulic conductivity (cfs/ft²-ft of head)
     * H2 depth to water table / head (ft)          W  trench width (ft)
     * Du non-saturated trench depth (ft)           Ds saturated trench depth (ft)
     * FS safety factor (commonly 2.0)
     * Inputs: { volumeCf, k, h2, w, du, ds, fs }. Returns { ok, errors[], lengthFt, volumeAcIn, denom }.
     */
    function trenchLength(inp) {
        const errors = [];
        const Vcf = num(inp.volumeCf), K = num(inp.k), H2 = num(inp.h2), W = num(inp.w),
              Du = num(inp.du), Ds = num(inp.ds), FS = num(inp.fs);
        if (!(Vcf > 0)) errors.push("Volume must be greater than 0 ft³.");
        if (!(K > 0)) errors.push("Hydraulic conductivity K must be greater than 0 (from field tests).");
        if (!(H2 > 0)) errors.push("Depth to water table H2 must be greater than 0 ft.");
        if (!(W > 0)) errors.push("Trench width W must be greater than 0 ft.");
        if (!(Du >= 0)) errors.push("Non-saturated trench depth Du must be 0 ft or more.");
        if (!(Ds >= 0)) errors.push("Saturated trench depth Ds must be 0 ft or more.");
        if (Du + Ds <= 0) errors.push("Trench depth (Du + Ds) must be greater than 0 ft.");
        if (!(FS >= 1)) errors.push("Safety factor must be at least 1.0.");
        if (errors.length) return { ok: false, errors };
        const V = Vcf / CF_PER_ACRE_INCH;
        const denom = K * (H2 * W + 2 * H2 * Du - Du * Du + 2 * H2 * Ds) + 1.39e-4 * W * Du;
        if (!(denom > 0)) return { ok: false, errors: ["Inputs give a non-positive exfiltration capacity — check H2, Du, Ds and W."] };
        return { ok: true, errors: [], lengthFt: FS * V / denom, volumeAcIn: V, denom };
    }

    function val(id) {
        const el = document.getElementById(id);
        return el ? el.value : "";
    }

    function errorHtml(errors) {
        return `<h4 style="color:var(--danger);">Cannot compute</h4><ul style="margin:0.25rem 0 0 1rem;">${
            errors.map(e => `<li>${window.cleanText ? window.cleanText(e) : e}</li>`).join("")}</ul>`;
    }

    function renderIDFOptions() {
        const select = document.getElementById("select-idf-zone");
        if (!select) return;
        select.replaceChildren();
        (window.FDOT_DATA?.idfZones || []).forEach(z => {
            const opt = document.createElement("option");
            opt.value = z.zone;
            opt.textContent = `Zone ${z.zone}: ${z.counties}`;
            select.appendChild(opt);
        });
        // Default the zone from the active client master template, if one is set.
        const zone = window.BoundaryQCCMS && window.BoundaryQCCMS.getActiveTemplateSetting
            ? window.BoundaryQCCMS.getActiveTemplateSetting("idfZone", null) : null;
        if (zone != null && select.querySelector(`option[value="${zone}"]`)) select.value = String(zone);
    }

    const Plugin = {
        init() {
            renderIDFOptions();
        },

        onTabActivate() {
            renderIDFOptions();
        },

        setupEvents() {
            document.getElementById("btn-calc-hydrology")?.addEventListener("click", () => {
                const box = document.getElementById("hydrology-results");
                if (!box) return;
                box.classList.remove("hidden");
                const zoneId = parseInt(val("select-idf-zone"), 10);
                const zone = (window.FDOT_DATA?.idfZones || []).find(z => z.zone === zoneId) || null;
                const r = rationalQ({
                    areaAc: val("hyd-area"), c: val("hyd-c"), tcMin: val("hyd-tc"),
                    returnPeriodYr: val("hyd-return-period"), intensity: val("hyd-intensity"), zone
                });
                if (!r.ok) return window.setSafeHTML(box, errorHtml(r.errors));
                const warn = r.intensitySource.startsWith("illustrative")
                    ? `<p style="color:var(--warning); font-size:0.75rem; margin-top:0.4rem;">Intensity came from the illustrative zone curve (no return period). For design, enter the intensity read from the official FDOT IDF curve.</p>` : "";
                window.setSafeHTML(box, `
                    <h4 style="color:var(--success);">Intensity i = ${r.intensity.toFixed(2)} in/hr <small style="color:var(--text-muted);">(${r.intensitySource})</small></h4>
                    <div style="font-size:0.8rem; color:var(--text-muted);">C = ${num(val("hyd-c")).toFixed(2)} × Cf ${r.cf.toFixed(2)} → ${r.cEff.toFixed(2)} · A = ${num(val("hyd-area")).toFixed(2)} ac</div>
                    <div style="font-weight:700; color:var(--primary); font-size:1.1rem; margin-top:4px;">Peak Discharge Q = ${r.q.toFixed(2)} cfs</div>${warn}`);
            });

            document.getElementById("btn-calc-trench")?.addEventListener("click", () => {
                const box = document.getElementById("trench-results");
                if (!box) return;
                box.classList.remove("hidden");
                const r = trenchLength({
                    volumeCf: val("trench-vol"), k: val("trench-k"), h2: val("trench-h2"), w: val("trench-w"),
                    du: val("trench-du"), ds: val("trench-ds"), fs: val("trench-fs")
                });
                if (!r.ok) return window.setSafeHTML(box, errorHtml(r.errors));
                window.setSafeHTML(box, `
                    <h4 style="color:var(--success);">Required Exfiltration Trench Length: ${Math.ceil(r.lengthFt)} FT</h4>
                    <small style="color:var(--text-muted);">V = ${r.volumeAcIn.toFixed(3)} ac-in · safety factor ${num(val("trench-fs")).toFixed(1)} · L = FS·V / [K(H2·W + 2H2·Du − Du² + 2H2·Ds) + 1.39×10⁻⁴·W·Du]. Verify the equation and inputs against the current FDOT Drainage Design Guide / SFWMD criteria before design use.</small>`);
            });
        }
    };

    window.SSAHydro = { frequencyFactor, idfIntensity, rationalQ, trenchLength, CF_PER_ACRE_INCH };
    window.PluginRegistry.register(MANIFEST, Plugin);
})();
