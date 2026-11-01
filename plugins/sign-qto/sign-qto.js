/**
 * Plugin: sign-qto (Sign Assemblies & QTO)
 * plugins/sign-qto/sign-qto.js
 *
 * FDOT Sign Assembly catalog cards and MUTCD QTO surface-area calculator.
 * Registers via window.PluginRegistry.
 */
(function () {
    const MANIFEST = {
        name: "sign-qto",
        version: "2.6.0",
        description: "FDOT sign assembly catalog and MUTCD QTO surface-area pay-item classifier.",
        tab: "tab-signs",
        icon: "fa-triangle-exclamation",
        tier: "Free",
        dependencies: []
    };

    function renderSignAssemblies() {
        const grid = document.getElementById("signs-grid");
        if (!grid) return;
        grid.replaceChildren();
        (window.FDOT_DATA?.signAssemblies || []).forEach(sign => {
            const card = document.createElement("div");
            card.className = "pkt-card glass-panel";
            window.setSafeHTML(card, `
                <div class="pkt-card-header">
                    <h3><i class="fa-solid fa-triangle-exclamation" style="color:${sign.color};"></i> ${sign.code} ${sign.title}</h3>
                    <span class="tag tag-discipline">${sign.shape}</span>
                </div>
                <div style="font-family:var(--font-mono); font-size:0.85rem; color:var(--accent);">${sign.size} | Block: ${sign.blockName}</div>
                <p style="font-size:0.85rem; color:var(--text-secondary); flex:1;">${sign.description}</p>
                <div style="border-top:1px solid var(--glass-border); padding-top:0.5rem; margin-top:0.5rem;">
                    <small style="color:var(--text-muted); font-weight:700; text-transform:uppercase;">FDOT Target Pay Item</small>
                    <div style="font-weight:700; color:var(--success); font-size:0.9rem;">${sign.payItem}</div>
                </div>`);
            grid.appendChild(card);
        });
    }

    const Plugin = {
        init() {
            renderSignAssemblies();
        },

        setupEvents(ctx) {
            document.getElementById("btn-calc-sign-payitem")?.addEventListener("click", () => {
                const w = parseFloat(document.getElementById("sign-width")?.value) || 36;
                const h = parseFloat(document.getElementById("sign-height")?.value) || 36;
                const sf = (w * h) / 144.0;
                const payItem = sf <= 12
                    ? "0700-1-11 (Single Post Ground Mount <12 SF)"
                    : (sf <= 20 ? "0700-1-12 (Heavy Single Post 12-20 SF)" : "0700-1-14 (Multi-Post Ground Mount)");
                const box = document.getElementById("sign-calc-result");
                if (!box) return;
                box.classList.remove("hidden");
                window.setSafeHTML(box, `
                    <h4 style="color:var(--success);">Calculated Surface Area: ${sf.toFixed(2)} SF</h4>
                    <div style="font-weight:700; color:var(--primary); margin-top:4px;">Resolved Pay Item: ${payItem}</div>`);
            });
        }
    };

    window.PluginRegistry.register(MANIFEST, Plugin);
})();
