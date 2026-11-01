/* Web Worker: splits a DXF into group-code pairs off the page thread, so a 40–50 MB drawing doesn't
 * freeze the page while it's read. Uses the same resilient tokenizer as everything else
 * (dxf-parser.js); the page falls back to reading on its own thread when workers aren't available. */
/* global importScripts */
self.window = self; // dxf-parser.js registers itself on window
importScripts("dxf-parser.js");
self.onmessage = e => {
    const { id, text } = e.data || {};
    try {
        const pairs = self.FDOTDXFInspector.prototype.tokenizeDXF.call(null, text);
        self.postMessage({ id, pairs });
    } catch (err) {
        self.postMessage({ id, error: String((err && err.message) || err) });
    }
};
