/**
 * BoundaryQC / FDOT Civil3D Standards — Plugin Registry & Loader
 * core/loader.js
 *
 * Provides a lightweight plugin system:
 *  - Plugins self-register at script load via window.PluginRegistry.register()
 *  - Core app calls PluginRegistry.initAll(ctx) after DOM is ready
 *  - Plugins receive a shared context object (state, toast helpers, etc.)
 *
 * Rule: Plugin names must be ≤ 15 characters.
 */

class PluginRegistry {
    constructor() {
        /** @type {Map<string, {manifest: Object, module: Object}>} */
        this._plugins = new Map();
        this._loadOrder = [];
    }

    /**
     * Register a plugin. Called automatically by each plugin's entry script.
     * @param {Object} manifest - { name, version, description, tab, icon, tier, dependencies }
     * @param {Object} module   - { init(ctx), setupEvents(ctx) }
     */
    register(manifest, module) {
        const name = manifest.name;
        if (typeof name !== 'string' || name.length > 15) {
            console.error(`[PluginRegistry] Plugin name "${name}" exceeds 15-character limit. Rejected.`);
            return false;
        }
        if (this._plugins.has(name)) {
            console.warn(`[PluginRegistry] Plugin "${name}" already registered. Skipping duplicate.`);
            return false;
        }
        this._plugins.set(name, { manifest, module });
        this._loadOrder.push(name);
        console.info(`[PluginRegistry] ✓ Registered plugin: ${name} v${manifest.version}`);
        return true;
    }

    /**
     * Retrieve a single registered plugin by name.
     * @param {string} name
     * @returns {{manifest: Object, module: Object}|undefined}
     */
    get(name) {
        return this._plugins.get(name);
    }

    /**
     * Return all registered plugins in registration order.
     * @returns {Array<{manifest: Object, module: Object}>}
     */
    getAll() {
        return this._loadOrder.map(n => this._plugins.get(n)).filter(Boolean);
    }

    /**
     * Initialize all registered plugins in dependency-resolved order.
     * Calls module.init(ctx) then module.setupEvents(ctx) for each plugin.
     * @param {Object} ctx - Shared context: { state, showToast, showInputModal, showConfirmModal, showCopyModal }
     */
    initAll(ctx) {
        this._lastCtx = ctx || {};
        const ordered = this._resolveDependencyOrder();
        for (const name of ordered) {
            const entry = this._plugins.get(name);
            if (!entry) continue;
            try {
                if (typeof entry.module.init === 'function') {
                    entry.module.init(ctx);
                }
                if (typeof entry.module.setupEvents === 'function') {
                    entry.module.setupEvents(ctx);
                }
                console.info(`[PluginRegistry] ↑ Initialized plugin: ${name}`);
            } catch (e) {
                console.error(`[PluginRegistry] ✗ Plugin "${name}" init failed:`, e);
            }
        }
    }

    /**
     * Notify a specific plugin of a tab activation event.
     * @param {string} tabId - e.g. "tab-dxf-inspector"
     * @param {Object} [ctx]
     */
    notifyTabActivate(tabId, ctx) {
        const context = ctx || this._lastCtx || {};
        for (const entry of this._plugins.values()) {
            if (entry.manifest.tab === tabId && typeof entry.module.onTabActivate === 'function') {
                try { entry.module.onTabActivate(context); } catch (e) {}
            }
        }
    }

    /**
     * Alias for notifyTabActivate
     */
    onTabActivate(tabId, ctx) {
        return this.notifyTabActivate(tabId, ctx);
    }

    /**
     * Resolve plugin initialization order using Kahn's topological sort.
     * Plugins with no dependencies come first; those with dependencies come after.
     * @private
     */
    _resolveDependencyOrder() {
        const inDegree = new Map();
        const adj = new Map();

        for (const name of this._loadOrder) {
            inDegree.set(name, 0);
            adj.set(name, []);
        }

        for (const name of this._loadOrder) {
            const { manifest } = this._plugins.get(name);
            const deps = manifest.dependencies || [];
            for (const dep of deps) {
                if (this._plugins.has(dep)) {
                    adj.get(dep).push(name);
                    inDegree.set(name, (inDegree.get(name) || 0) + 1);
                }
            }
        }

        const queue = this._loadOrder.filter(n => (inDegree.get(n) || 0) === 0);
        const result = [];

        while (queue.length > 0) {
            const node = queue.shift();
            result.push(node);
            for (const neighbor of (adj.get(node) || [])) {
                const deg = (inDegree.get(neighbor) || 1) - 1;
                inDegree.set(neighbor, deg);
                if (deg === 0) queue.push(neighbor);
            }
        }

        // Append any remaining (cyclic deps — shouldn't happen, but safe fallback)
        for (const name of this._loadOrder) {
            if (!result.includes(name)) result.push(name);
        }

        return result;
    }

    /**
     * Print a summary table of all registered plugins to the console.
     */
    status() {
        console.group('[PluginRegistry] Registered Plugins');
        for (const { manifest } of this.getAll()) {
            console.log(`  ${manifest.name.padEnd(16)} v${manifest.version}  tier:${manifest.tier || 'Free'}  tab:${manifest.tab || 'n/a'}`);
        }
        console.groupEnd();
    }
}

// Global singleton — available before any plugins load
window.PluginRegistry = new PluginRegistry();
