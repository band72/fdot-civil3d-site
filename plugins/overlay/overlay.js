/**
 * Overlay plugin — background basemap (street map / aerial imagery) for the Linework Editor.
 * plugins/overlay/overlay.js
 *
 * Linework coordinates are taken to be grid coordinates in a chosen zone (State Plane for all 50 states,
 * Puerto Rico / Virgin Is., Caribbean UTM, Canadian UTM / MTM / provincial grids — generated into
 * overlay-zones.js from the EPSG registry) and unit (metres, US survey or
 * international feet). Each web-map
 * tile is placed in the editor by projecting three of its corners (lon/lat → State Plane) and
 * giving the <image> the affine transform through them, so the tiles line up with the linework.
 * Off by default: no tile host is contacted until the user turns the basemap on.
 *
 * Exposes window.Overlay = { ZONES, UNITS, BASEMAPS, toLonLat, fromLonLat, tileUrl, chooseZoom,
 *   tilesForView, tileMatrix, render, ... } — projection/tile maths are pure. A coordinate system is
 *   passed as cs = { zone: "<EPSG id>", unit: "m" | "usft" | "ift" }.
 */
(function () {
    "use strict";

    const MANIFEST = {
        name: "overlay",
        version: "1.0.0",
        description: "Background street map / aerial imagery (open tile providers) behind the Linework Editor, with an on/off toggle and basemap selector.",
        tab: null,
        icon: "fa-map",
        tier: "Pro",
        dependencies: ["linework"]
    };

    const SVGNS = "http://www.w3.org/2000/svg";
    const DEG = Math.PI / 180;
    const A = 6378137, F = 1 / 298.257222101;   // GRS80
    const E2 = F * (2 - F), E1 = Math.sqrt(E2);
    const MAX_TILES = 64;
    const STORE_KEY = "overlay.settings.v1";

    // Metres per coordinate unit. Zones are defined in metres; the unit only scales E/N in and out.
    const UNITS = {
        m:    { label: "Meters", m: 1 },
        usft: { label: "US survey feet", m: 1200 / 3937 },
        ift:  { label: "International feet", m: 0.3048 }
    };

    // State Plane zones for the 50 states, Puerto Rico / Virgin Is. + Caribbean UTM, and Canadian grids, keyed by EPSG id (data: overlay-zones.js).
    const ZONES = {};
    (window.OverlayZones || []).forEach(z => { ZONES[z.id] = z; });
    const LEGACY_ZONES = { FL_EAST: "26958", FL_WEST: "26959", FL_NORTH: "26960" };   // keys saved by the first version

    const BASEMAPS = {
        osm:  { label: "Street map — OpenStreetMap", url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png", maxZoom: 19,
                attribution: "© OpenStreetMap contributors" },
        carto: { label: "Street map — Carto Light", url: "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", maxZoom: 19,
                attribution: "© OpenStreetMap contributors © CARTO" },
        usgsimg: { label: "Aerial imagery — USGS", url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}", maxZoom: 16,
                attribution: "USGS The National Map: Orthoimagery (public domain)" },
        usgstopo: { label: "Topographic — USGS", url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}", maxZoom: 16,
                attribution: "USGS The National Map: US Topo (public domain)" }
    };

    // ── Projection (pure) ────────────────────────────────────────────────────

    const N3 = F / (2 - F);
    const TM_A = A / (1 + N3) * (1 + N3 * N3 / 4 + Math.pow(N3, 4) / 64);
    const TM_ALPHA = [N3 / 2 - 2 * N3 * N3 / 3 + 5 * Math.pow(N3, 3) / 16, 13 * N3 * N3 / 48 - 3 * Math.pow(N3, 3) / 5, 61 * Math.pow(N3, 3) / 240];
    const TM_BETA = [N3 / 2 - 2 * N3 * N3 / 3 + 37 * Math.pow(N3, 3) / 96, N3 * N3 / 48 + Math.pow(N3, 3) / 15, 17 * Math.pow(N3, 3) / 480];
    const TM_DELTA = [2 * N3 - 2 * N3 * N3 / 3 - 2 * Math.pow(N3, 3), 7 * N3 * N3 / 3 - 8 * Math.pow(N3, 3) / 5, 56 * Math.pow(N3, 3) / 15];

    const conformalLat = phi => Math.atan(Math.sinh(Math.atanh(Math.sin(phi)) - E1 * Math.atanh(E1 * Math.sin(phi))));

    function tmForward(z, lon, lat) {
        const lam = (lon - z.lon0) * DEG, chi = conformalLat(lat * DEG);
        const xi1 = Math.atan2(Math.tan(chi), Math.cos(lam));
        const eta1 = Math.atanh(Math.cos(chi) * Math.sin(lam));
        let xi = xi1, eta = eta1;
        TM_ALPHA.forEach((al, i) => {
            const j = 2 * (i + 1);
            xi += al * Math.sin(j * xi1) * Math.cosh(j * eta1);
            eta += al * Math.cos(j * xi1) * Math.sinh(j * eta1);
        });
        return { x: z.fe + z.k0 * TM_A * eta, y: z.fn + z.k0 * TM_A * (xi - tmXi0(z)) };
    }
    function tmXi0(z) {
        const chi = conformalLat(z.lat0 * DEG);
        let xi = chi;
        TM_ALPHA.forEach((al, i) => { xi += al * Math.sin(2 * (i + 1) * chi); });
        return xi;
    }
    function tmInverse(z, x, y) {
        const xi = (y - z.fn) / (z.k0 * TM_A) + tmXi0(z), eta = (x - z.fe) / (z.k0 * TM_A);
        let xi1 = xi, eta1 = eta;
        TM_BETA.forEach((b, i) => {
            const j = 2 * (i + 1);
            xi1 -= b * Math.sin(j * xi) * Math.cosh(j * eta);
            eta1 -= b * Math.cos(j * xi) * Math.sinh(j * eta);
        });
        const chi = Math.asin(Math.sin(xi1) / Math.cosh(eta1));
        let phi = chi;
        TM_DELTA.forEach((d, i) => { phi += d * Math.sin(2 * (i + 1) * chi); });
        return { lon: z.lon0 + Math.atan2(Math.sinh(eta1), Math.cos(xi1)) / DEG, lat: phi / DEG };
    }

    const lccM = p => Math.cos(p) / Math.sqrt(1 - E2 * Math.sin(p) * Math.sin(p));
    const lccT = p => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - E1 * Math.sin(p)) / (1 + E1 * Math.sin(p)), E1 / 2);
    function lccConsts(z) {
        const p1 = z.lat1 * DEG, p2 = z.lat2 * DEG, p0 = z.lat0 * DEG;
        // Tangent cone (both parallels equal, as in the registry's Kentucky definition): n = sin(lat1).
        const n = Math.abs(p1 - p2) < 1e-12 ? Math.sin(p1) : (Math.log(lccM(p1)) - Math.log(lccM(p2))) / (Math.log(lccT(p1)) - Math.log(lccT(p2)));
        const Fc = lccM(p1) / (n * Math.pow(lccT(p1), n));
        return { n, aF: A * Fc, rho0: A * Fc * Math.pow(lccT(p0), n) };
    }
    function lccForward(z, lon, lat) {
        const c = lccConsts(z), rho = c.aF * Math.pow(lccT(lat * DEG), c.n), th = c.n * (lon - z.lon0) * DEG;
        return { x: z.fe + rho * Math.sin(th), y: z.fn + c.rho0 - rho * Math.cos(th) };
    }
    function lccInverse(z, x, y) {
        const c = lccConsts(z), dx = x - z.fe, dy = c.rho0 - (y - z.fn);
        const rho = Math.sign(c.n) * Math.hypot(dx, dy), t = Math.pow(rho / c.aF, 1 / c.n);
        let phi = Math.PI / 2 - 2 * Math.atan(t);
        for (let i = 0; i < 12; i++) {
            const nx = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - E1 * Math.sin(phi)) / (1 + E1 * Math.sin(phi)), E1 / 2));
            if (Math.abs(nx - phi) < 1e-13) { phi = nx; break; }
            phi = nx;
        }
        return { lon: z.lon0 + Math.atan2(dx, dy) / c.n / DEG, lat: phi / DEG };
    }

    // Albers equal-area conic, ellipsoidal (Snyder) — BC / Yukon / Conus / Alaska Albers.
    const albQ = p => { const sp = Math.sin(p); return (1 - E2) * (sp / (1 - E2 * sp * sp) - Math.log((1 - E1 * sp) / (1 + E1 * sp)) / (2 * E1)); };
    function albConsts(z) {
        const p1 = z.lat1 * DEG, p2 = z.lat2 * DEG, m1 = lccM(p1), m2 = lccM(p2);
        // Both parallels equal → n = sin(lat1).
        const n = Math.abs(p1 - p2) < 1e-12 ? Math.sin(p1) : (m1 * m1 - m2 * m2) / (albQ(p2) - albQ(p1));
        const C = m1 * m1 + n * albQ(p1);
        return { n, C, rho0: A * Math.sqrt(C - n * albQ(z.lat0 * DEG)) / n };
    }
    function albForward(z, lon, lat) {
        const c = albConsts(z), rho = A * Math.sqrt(c.C - c.n * albQ(lat * DEG)) / c.n, th = c.n * (lon - z.lon0) * DEG;
        return { x: z.fe + rho * Math.sin(th), y: z.fn + c.rho0 - rho * Math.cos(th) };
    }
    function albInverse(z, x, y) {
        const c = albConsts(z), dx = x - z.fe, dy = c.rho0 - (y - z.fn);
        const rho = Math.sign(c.n) * Math.hypot(dx, dy), q = (c.C - Math.pow(rho * c.n / A, 2)) / c.n;
        let phi = Math.asin(Math.max(-1, Math.min(1, q / 2)));
        for (let i = 0; i < 20; i++) {
            const sp = Math.sin(phi), d = Math.pow(1 - E2 * sp * sp, 2) / (2 * Math.cos(phi)) * (q / (1 - E2) - sp / (1 - E2 * sp * sp) + Math.log((1 - E1 * sp) / (1 + E1 * sp)) / (2 * E1));
            phi += d;
            if (Math.abs(d) < 1e-14) break;
        }
        return { lon: z.lon0 + Math.atan2(dx, dy) / c.n / DEG, lat: phi / DEG };
    }

    // Hotine oblique Mercator, variant A (EPSG 9812) — Alaska zone 1.
    function omConsts(z) {
        const phic = z.lat0 * DEG, sp = Math.sin(phic), cp = Math.cos(phic);
        const B = Math.sqrt(1 + E2 * Math.pow(cp, 4) / (1 - E2));
        const Aa = A * B * z.k0 * Math.sqrt(1 - E2) / (1 - E2 * sp * sp);
        const t0 = Math.tan(Math.PI / 4 - phic / 2) / Math.pow((1 - E1 * sp) / (1 + E1 * sp), E1 / 2);
        let D = B * Math.sqrt(1 - E2) / (cp * Math.sqrt(1 - E2 * sp * sp));
        D = Math.max(D, 1);
        const Fo = D + Math.sign(phic || 1) * Math.sqrt(D * D - 1), H = Fo * Math.pow(t0, B), G = (Fo - 1 / Fo) / 2;
        const g0 = Math.asin(Math.sin(z.az * DEG) / D), lam0 = z.lon0 * DEG - Math.asin(G * Math.tan(g0)) / B;
        return { B, Aa, H, g0, lam0, gc: z.gamma * DEG };
    }
    function omForward(z, lon, lat) {
        const c = omConsts(z), phi = lat * DEG, sp = Math.sin(phi);
        const t = Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - E1 * sp) / (1 + E1 * sp), E1 / 2);
        const Q = c.H / Math.pow(t, c.B), S = (Q - 1 / Q) / 2, T = (Q + 1 / Q) / 2, dl = lon * DEG - c.lam0, V = Math.sin(c.B * dl);
        const U = (-V * Math.cos(c.g0) + S * Math.sin(c.g0)) / T;
        const v = c.Aa * Math.log((1 - U) / (1 + U)) / (2 * c.B), u = c.Aa * Math.atan2(S * Math.cos(c.g0) + V * Math.sin(c.g0), Math.cos(c.B * dl)) / c.B;
        return { x: z.fe + v * Math.cos(c.gc) + u * Math.sin(c.gc), y: z.fn + u * Math.cos(c.gc) - v * Math.sin(c.gc) };
    }
    function omInverse(z, x, y) {
        const c = omConsts(z), dx = x - z.fe, dy = y - z.fn;
        const v = dx * Math.cos(c.gc) - dy * Math.sin(c.gc), u = dy * Math.cos(c.gc) + dx * Math.sin(c.gc);
        const Q = Math.exp(-c.B * v / c.Aa), S = (Q - 1 / Q) / 2, T = (Q + 1 / Q) / 2, V = Math.sin(c.B * u / c.Aa);
        const U = (V * Math.cos(c.g0) + S * Math.sin(c.g0)) / T;
        const t = Math.pow(c.H / Math.sqrt((1 + U) / (1 - U)), 1 / c.B);
        let phi = Math.PI / 2 - 2 * Math.atan(t);
        for (let i = 0; i < 12; i++) {
            const nx = Math.PI / 2 - 2 * Math.atan(t * Math.pow((1 - E1 * Math.sin(phi)) / (1 + E1 * Math.sin(phi)), E1 / 2));
            if (Math.abs(nx - phi) < 1e-13) { phi = nx; break; }
            phi = nx;
        }
        const lam = c.lam0 - Math.atan2(S * Math.cos(c.g0) - V * Math.sin(c.g0), Math.cos(c.B * u / c.Aa)) / c.B;
        return { lon: lam / DEG, lat: phi / DEG };
    }

    const FORWARD = { tm: tmForward, lcc: lccForward, albers: albForward, om: omForward };
    const INVERSE = { tm: tmInverse, lcc: lccInverse, albers: albInverse, om: omInverse };

    function csOf(cs) {
        const z = cs && ZONES[cs.zone], u = cs && UNITS[cs.unit];
        if (!z) throw new Error("Unknown State Plane zone: " + (cs && cs.zone));
        if (!u) throw new Error("Unknown unit: " + (cs && cs.unit));
        return { z, k: u.m };
    }
    /** State Plane (E, N in cs.unit) → { lon, lat } degrees. */
    function toLonLat(cs, e, n) {
        const { z, k } = csOf(cs);
        return INVERSE[z.m](z, e * k, n * k);
    }
    /** { lon, lat } degrees → State Plane { e, n } in cs.unit. */
    function fromLonLat(cs, lon, lat) {
        const { z, k } = csOf(cs), p = FORWARD[z.m](z, lon, lat);
        return { e: p.x / k, n: p.y / k };
    }

    // ── Tiles (pure) ─────────────────────────────────────────────────────────

    const tileLon = (x, z) => x / Math.pow(2, z) * 360 - 180;
    const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI - 2 * Math.PI * y / Math.pow(2, z))) / DEG;
    function lonLatToTile(lon, lat, z) {
        const n = Math.pow(2, z), s = Math.sin(lat * DEG);
        return { x: (lon + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
    }

    /** Is a lon/lat inside the zone's area of use (± 0.3°)? Guards against the wrong zone / local coordinates. */
    function inZone(zone, ll) {
        const z = typeof zone === "string" ? ZONES[zone] : zone;
        if (!z) return false;
        const [w, s, e, n] = z.bbox, m = 0.3;
        if (ll.lat < s - m || ll.lat > n + m) return false;
        if (w <= e) return ll.lon > w - m && ll.lon < e + m;
        return ll.lon > w - m || ll.lon < e + m;   // zone spans the antimeridian (Aleutians)
    }

    function tileUrl(basemap, z, x, y) {
        const b = typeof basemap === "string" ? BASEMAPS[basemap] : basemap;
        if (!b) throw new Error("Unknown basemap: " + basemap);
        return b.url.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    }

    /** Web-map zoom whose tile pixels are about one screen pixel across the view. */
    function chooseZoom(viewWidthM, pxWidth, latDeg, maxZoom) {
        if (!(viewWidthM > 0) || !(pxWidth > 0)) return null;
        const mpp = viewWidthM / pxWidth;
        const z = Math.round(Math.log2(156543.03392 * Math.cos(latDeg * DEG) / mpp));
        return Math.max(1, Math.min(maxZoom || 19, z));
    }

    /**
     * Tiles covering an editor view ({x,y,w,h}; svg y = -northing). Returns { status, z, tiles[], center }
     * where status is "ok" | "outside" (view not in the zone/Florida) | "empty" (no usable size).
     */
    function tilesForView(cs, view, pxWidth, maxZoom) {
        const corners = [[view.x, -view.y], [view.x + view.w, -view.y], [view.x, -(view.y + view.h)], [view.x + view.w, -(view.y + view.h)]];
        const lls = corners.map(c => toLonLat(cs, c[0], c[1]));
        if (!lls.every(ll => isFinite(ll.lat) && isFinite(ll.lon) && inZone(cs.zone, ll))) return { status: "outside", z: null, tiles: [] };
        const midLat = lls.reduce((s, l) => s + l.lat, 0) / lls.length;
        let z = chooseZoom(view.w * csOf(cs).k, pxWidth, midLat, maxZoom);
        if (z == null) return { status: "empty", z: null, tiles: [] };
        for (; z >= 1; z--) {
            const t = lls.map(l => lonLatToTile(l.lon, l.lat, z));
            const x0 = Math.floor(Math.min(...t.map(p => p.x))), x1 = Math.floor(Math.max(...t.map(p => p.x)));
            const y0 = Math.floor(Math.min(...t.map(p => p.y))), y1 = Math.floor(Math.max(...t.map(p => p.y)));
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_TILES) continue;
            const tiles = [];
            for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push({ z, x, y });
            return { status: "ok", z, tiles };
        }
        return { status: "empty", z: null, tiles: [] };
    }

    /** SVG matrix(a b c d e f) mapping a 256×256 tile image onto its State Plane footprint (svg y = -northing). */
    function tileMatrix(cs, tile) {
        const pt = (x, y) => { const p = fromLonLat(cs, tileLon(x, tile.z), tileLat(y, tile.z)); return { x: p.e, y: -p.n }; };
        const tl = pt(tile.x, tile.y), tr = pt(tile.x + 1, tile.y), bl = pt(tile.x, tile.y + 1);
        return [(tr.x - tl.x) / 256, (tr.y - tl.y) / 256, (bl.x - tl.x) / 256, (bl.y - tl.y) / 256, tl.x, tl.y];
    }

    // ── State & rendering ────────────────────────────────────────────────────

    const IMG_CACHE_MAX = 200;
    const imgCache = new Map();
    const state = { on: false, basemap: "osm", zone: "26958", unit: "usft", opacity: 0.8, status: "off" };

    function loadSettings() {
        try {
            const s = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
            if (!s) return;
            if (BASEMAPS[s.basemap]) state.basemap = s.basemap;
            const zone = LEGACY_ZONES[s.zone] || s.zone;
            if (ZONES[zone]) state.zone = zone;
            state.unit = UNITS[s.unit] ? s.unit : (LEGACY_ZONES[s.zone] ? "usft" : state.unit);
            if (typeof s.opacity === "number" && s.opacity >= 0.2 && s.opacity <= 1) state.opacity = s.opacity;
            state.on = s.on === true;
        } catch (e) { /* storage unavailable — defaults */ }
    }
    function saveSettings() {
        try { localStorage.setItem(STORE_KEY, JSON.stringify({ on: state.on, basemap: state.basemap, zone: state.zone, unit: state.unit, opacity: state.opacity })); } catch (e) { /* ignore */ }
    }

    /**
     * Draw the basemap into the editor <svg> (call first, so linework lands on top).
     * @param {SVGElement} svg  @param {{x,y,w,h}} view  @param {number} pxWidth on-screen width of the editor
     */
    function render(svg, view, pxWidth) {
        if (!state.on) { setStatus("off"); return state; }
        const bm = BASEMAPS[state.basemap];
        const r = tilesForView(state, view, pxWidth, bm.maxZoom);
        if (r.status !== "ok") { setStatus(r.status); return state; }
        const g = document.createElementNS(SVGNS, "g");
        g.setAttribute("data-overlay", "basemap");
        g.setAttribute("opacity", String(state.opacity));
        g.style.pointerEvents = "none";
        r.tiles.forEach(t => {
            // Reuse the <image> node per tile so panning doesn't blank loaded tiles while they re-fetch.
            const key = state.basemap + "|" + state.zone + "|" + state.unit + "|" + t.z + "/" + t.x + "/" + t.y;
            let im = imgCache.get(key);
            if (!im) {
                im = document.createElementNS(SVGNS, "image");
                im.setAttribute("href", tileUrl(bm, t.z, t.x, t.y));
                im.setAttribute("width", "256");
                im.setAttribute("height", "256");
                im.setAttribute("preserveAspectRatio", "none");
                im.setAttribute("transform", "matrix(" + tileMatrix(state, t).join(" ") + ")");
                im.addEventListener("error", () => { setStatus("failed"); imgCache.delete(key); });
                if (imgCache.size >= IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
                imgCache.set(key, im);
            }
            g.appendChild(im);
        });
        svg.insertBefore(g, svg.firstChild);
        setStatus("ok", bm.attribution);
        return state;
    }

    const STATUS_TEXT = {
        off: "",
        outside: "Coordinates are outside the selected State Plane zone — pick the right zone and units (local/unknown coordinates can't be mapped).",
        empty: "Zoom level can't be mapped.",
        failed: "Some basemap tiles failed to load (offline, blocked, or no coverage at this zoom)."
    };
    function setStatus(status, attribution) {
        state.status = status;
        const el = document.getElementById("lw-ov-status");
        if (el) el.textContent = status === "ok" ? attribution : (STATUS_TEXT[status] || "");
        if (el) el.style.color = status === "outside" || status === "failed" ? "var(--warning, #f59e0b)" : "var(--text-muted)";
    }

    function redraw() {
        if (window.Linework && typeof window.Linework.redraw === "function") window.Linework.redraw();
    }

    const Plugin = {
        init() { loadSettings(); },
        setupEvents() {
            const $ = id => document.getElementById(id);
            const on = $("lw-ov-on"), bm = $("lw-ov-basemap"), zn = $("lw-ov-zone"), un = $("lw-ov-unit"), op = $("lw-ov-opacity");
            if (bm) bm.textContent = "";
            if (bm) Object.keys(BASEMAPS).forEach(k => { const o = document.createElement("option"); o.value = k; o.textContent = BASEMAPS[k].label; bm.appendChild(o); });
            if (zn) zn.textContent = "";
            if (zn) {
                // United States (A–Z), nationwide, Caribbean, then Canada; each group is an <optgroup>.
                const groups = {}, rank = { us: 0, "us-wide": 1, caribbean: 2, canada: 3 };
                Object.values(ZONES).forEach(z => {
                    if (!groups[z.group]) { groups[z.group] = { rank: rank[z.region], el: document.createElement("optgroup") }; groups[z.group].el.label = z.group; }
                    const o = document.createElement("option"); o.value = z.id; o.textContent = z.name; groups[z.group].el.appendChild(o);
                });
                Object.keys(groups).sort((x, y) => groups[x].rank - groups[y].rank || x.localeCompare(y)).forEach(k => zn.appendChild(groups[k].el));
            }
            if (un) un.textContent = "";
            if (un) Object.keys(UNITS).forEach(k => { const o = document.createElement("option"); o.value = k; o.textContent = UNITS[k].label; un.appendChild(o); });
            if (on) on.checked = state.on;
            if (bm) bm.value = state.basemap;
            if (zn) zn.value = state.zone;
            if (un) un.value = state.unit;
            if (op) op.value = String(state.opacity);
            const sync = () => {
                if (bm) bm.disabled = !state.on;
                if (zn) zn.disabled = !state.on;
                if (un) un.disabled = !state.on;
                if (op) op.disabled = !state.on;
            };
            sync();
            const change = () => { saveSettings(); sync(); redraw(); };
            on?.addEventListener("change", () => { state.on = on.checked; change(); });
            bm?.addEventListener("change", () => { if (BASEMAPS[bm.value]) { state.basemap = bm.value; change(); } });
            // Picking a zone also selects that zone's customary unit (US survey / international ft or metres); override it with the units list.
            zn?.addEventListener("change", () => { if (ZONES[zn.value]) { state.zone = zn.value; state.unit = ZONES[zn.value].unit; if (un) un.value = state.unit; change(); } });
            un?.addEventListener("change", () => { if (UNITS[un.value]) { state.unit = un.value; change(); } });
            op?.addEventListener("input", () => { const v = parseFloat(op.value); if (v >= 0.2 && v <= 1) { state.opacity = v; change(); } });
        }
    };

    if (window.PluginRegistry) window.PluginRegistry.register(MANIFEST, Plugin);

    window.Overlay = {
        ZONES, UNITS, BASEMAPS, state, toLonLat, fromLonLat, tileUrl, chooseZoom, tilesForView, tileMatrix,
        lonLatToTile, tileLon, tileLat, inZone, render
    };
})();
