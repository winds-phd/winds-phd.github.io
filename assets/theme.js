// Light / Dark / Auto theme, chosen by each person and remembered on this device.
// Loaded in <head> (not deferred) so the chosen theme applies before the page appears.
(function () {
  var KEY = "winds.theme";
  function saved() { try { return localStorage.getItem(KEY) || "auto"; } catch (e) { return "auto"; } }
  function apply(mode) {
    var root = document.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode);
    else root.removeAttribute("data-theme");   // Auto: follow the device setting
  }
  apply(saved());

  function build() {
    var box = document.createElement("div");
    box.className = "theme-switch"; box.setAttribute("role", "group"); box.setAttribute("aria-label", "Colour theme");
    [["light", "☀", "Light"], ["dark", "☾", "Dark"], ["auto", "◐", "Auto"]].forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button"; b.dataset.mode = o[0]; b.title = o[2] + " theme";
      b.innerHTML = '<span aria-hidden="true">' + o[1] + "</span> " + o[2];
      b.onclick = function () {
        try { localStorage.setItem(KEY, o[0]); } catch (e) { /* storage blocked: still applies for this visit */ }
        apply(o[0]); mark();
      };
      box.appendChild(b);
    });
    function mark() { var m = saved(); Array.prototype.forEach.call(box.children, function (b) { b.setAttribute("aria-pressed", String(b.dataset.mode === (document.documentElement.getAttribute("data-theme") || "auto"))); }); }
    mark();
    var bar = document.querySelector(".userbar");
    if (bar) bar.insertBefore(box, bar.firstChild);
    else { box.classList.add("floating"); document.body.appendChild(box); }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build); else build();
  // another tab changed it
  window.addEventListener("storage", function (e) { if (e.key === KEY) location.reload(); });
})();
