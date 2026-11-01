/* home.html behaviour: mobile menu and the workflow tabs. No inline script (CSP: script-src 'self'). */
(function () {
    "use strict";

    var btn = document.getElementById("menu-btn");
    var menu = document.getElementById("mobile-menu");
    if (btn && menu) {
        btn.addEventListener("click", function () {
            var open = menu.classList.toggle("open");
            btn.setAttribute("aria-expanded", open ? "true" : "false");
        });
        menu.addEventListener("click", function (e) {
            if (e.target.tagName === "A") { menu.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }
        });
    }

    var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
    function select(tab) {
        tabs.forEach(function (t) {
            var on = t === tab;
            t.setAttribute("aria-selected", on ? "true" : "false");
            t.tabIndex = on ? 0 : -1;
            document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
        });
    }
    tabs.forEach(function (t, i) {
        t.tabIndex = i === 0 ? 0 : -1;
        t.addEventListener("click", function () { select(t); });
        t.addEventListener("keydown", function (e) {
            var k = e.key, j = k === "ArrowDown" || k === "ArrowRight" ? i + 1 : k === "ArrowUp" || k === "ArrowLeft" ? i - 1 : -1;
            if (j < 0) return;
            e.preventDefault();
            var next = tabs[(j + tabs.length) % tabs.length];
            select(next); next.focus();
        });
    });
})();
