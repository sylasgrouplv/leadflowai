/**
 * LeadFlow AI — embeddable website chat widget.
 *
 * Vanilla JavaScript, zero dependencies, no build step. Served as a single
 * static file from the LeadFlow origin (GET /widget.js) and dropped into any
 * website with:
 *
 *   <script src="https://ec0c9049136e611575389c2647ca7b85.ctonew.app/widget.js" data-business-id="BUSINESS_ID"></script>
 *
 * Behavior:
 *   - Reads data-business-id (required) from its own script tag; optional
 *     data-position / data-primary-color / data-welcome-message overrides.
 *   - Fetches per-business branding + welcome from GET /api/widget/config.
 *   - Renders a chat bubble + window in a SHADOW ROOT so host-site CSS can
 *     neither break the widget nor be broken by it.
 *   - Messages POST to the public /api/widget/chat endpoint, which auto-creates
 *     the lead (source: website_widget), persists the thread, and returns
 *     KB-grounded AI replies. The server's message list is the source of truth.
 *   - Mobile-friendly (full-width window on small screens).
 *
 * Host-site CSP note: hosts with a restrictive script-src must allowlist this
 * origin; the widget uses no inline <script>, only a stylesheet injected into
 * its own shadow root.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.document) return;

  // ---------------------------------------------------------------- boot ----
  function findScript() {
    var scripts = document.getElementsByTagName("script");
    for (var i = 0; i < scripts.length; i++) {
      var src = scripts[i].src || "";
      if (/\/widget\.js(\?|#|$)/.test(src)) return scripts[i];
    }
    return document.currentScript || scripts[scripts.length - 1];
  }

  var script = findScript();
  var businessId = (script && script.getAttribute("data-business-id")) || "";
  var scriptSrc = script && script.src ? script.src : "";
  var origin = scriptSrc ? new URL(scriptSrc, window.location.href).origin : window.location.origin;

  if (!businessId) {
    if (window.console) console.warn("[LeadFlow widget] Missing data-business-id attribute on the widget script tag.");
    return;
  }

  // Idempotent: one widget per business id per page.
  window.__leadflowWidgets = window.__leadflowWidgets || {};
  if (window.__leadflowWidgets[businessId]) return;
  window.__leadflowWidgets[businessId] = true;

  var state = {
    conversationId: null,
    messages: [], // { sender: 'ai'|'lead'|'employee'|'system', body }
    config: null, // { businessName, primaryColor, position, welcomeMessage, logoUrl, ... }
    open: false,
    busy: false,
    failed: false,
  };

  // ------------------------------------------------------------ helpers ----
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function api(path, opts) {
    opts = opts || {};
    return fetch(origin + path, {
      method: opts.method || "GET",
      headers: { "Content-Type": "application/json" },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || ("Request failed (" + res.status + ")"));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function cssColor(hex) {
    return /^#[0-9a-fA-F]{6}$/.test(hex || "") ? hex : "#4f46e5";
  }

  function escapeHtml(s) {
    // Used only for our own template string (not for message bodies).
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  // ------------------------------------------------------------- styling ----
  function styles(color) {
    var c = cssColor(color);
    return (
      ":host{all:initial}" +
      "*{box-sizing:border-box;margin:0;padding:0}" +
      ".lfw-root{position:fixed;z-index:2147483000;bottom:0;right:0;left:auto;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#1e293b;-webkit-font-smoothing:antialiased}" +
      ".lfw-root[data-position='bottom-left']{right:auto;left:0}" +
      /* -------- launcher -------- */
      ".lfw-launcher{position:fixed;z-index:2147483001;right:20px;bottom:20px;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:" + c + ";color:#fff;box-shadow:0 6px 20px rgba(2,6,23,.28);transition:transform .15s ease,box-shadow .15s ease;-webkit-tap-highlight-color:transparent}" +
      ".lfw-root[data-position='bottom-left'] .lfw-launcher{right:auto;left:20px}" +
      ".lfw-launcher:hover{transform:scale(1.06);box-shadow:0 8px 26px rgba(2,6,23,.34)}" +
      ".lfw-launcher:focus-visible{outline:3px solid rgba(79,70,229,.5);outline-offset:2px}" +
      ".lfw-launcher svg{width:28px;height:28px;display:block}" +
      ".lfw-launcher .lfw-close-icon{display:none}" +
      ".lfw-launcher.lfw-open .lfw-chat-icon{display:none}" +
      ".lfw-launcher.lfw-open .lfw-close-icon{display:block}" +
      /* -------- window -------- */
      ".lfw-window{position:fixed;right:20px;bottom:92px;width:380px;max-width:calc(100vw - 24px);max-height:min(600px,calc(100vh - 120px));display:flex;flex-direction:column;background:#fff;border-radius:18px;box-shadow:0 16px 48px rgba(2,6,23,.22);overflow:hidden;border:1px solid #e2e8f0}" +
      ".lfw-root[data-position='bottom-left'] .lfw-window{right:auto;left:20px}" +
      ".lfw-window[hidden]{display:none}" +
      /* -------- header -------- */
      ".lfw-header{display:flex;align-items:center;gap:12px;padding:14px 16px;color:#fff;background:linear-gradient(135deg," + c + " 0%, " + c + "cc 100%);flex-shrink:0}" +
      ".lfw-logo{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;overflow:hidden;flex-shrink:0}" +
      ".lfw-logo img{width:100%;height:100%;object-fit:cover;display:block}" +
      ".lfw-logo .lfw-logo-fallback{font-size:16px;font-weight:700;color:#fff}" +
      ".lfw-header-text{min-width:0;flex:1}" +
      ".lfw-header-name{font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".lfw-header-status{font-size:12px;opacity:.92;display:flex;align-items:center;gap:5px}" +
      ".lfw-header-status .lfw-dot{width:7px;height:7px;border-radius:50%;background:#34d399;display:inline-block}" +
      /* -------- messages -------- */
      ".lfw-messages{flex:1;overflow-y:auto;padding:16px;background:#f8fafc;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}" +
      ".lfw-msg{max-width:82%;padding:9px 12px;border-radius:14px;font-size:14px;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:break-word}" +
      ".lfw-msg .lfw-msg-time{display:block;font-size:10px;opacity:.6;margin-top:3px;text-align:right}" +
      ".lfw-msg.lfw-ai{align-self:flex-start;background:#fff;border:1px solid #e2e8f0;border-bottom-left-radius:4px;color:#1e293b}" +
      ".lfw-msg.lfw-lead{align-self:flex-end;background:" + c + ";color:#fff;border-bottom-right-radius:4px}" +
      ".lfw-msg.lfw-employee{align-self:flex-start;background:#ede9fe;border:1px solid #ddd6fe;color:#4c1d95}" +
      ".lfw-msg.lfw-system{align-self:center;background:#f1f5f9;color:#64748b;font-size:12px;border-radius:999px;padding:6px 12px;max-width:95%;text-align:center}" +
      ".lfw-typing{align-self:flex-start;display:inline-flex;gap:4px;align-items:center;background:#fff;border:1px solid #e2e8f0;border-radius:14px;border-bottom-left-radius:4px;padding:12px 14px}" +
      ".lfw-typing span{width:7px;height:7px;border-radius:50%;background:#94a3b8;animation:lfw-blink 1.2s infinite both}" +
      ".lfw-typing span:nth-child(2){animation-delay:.18s}" +
      ".lfw-typing span:nth-child(3){animation-delay:.36s}" +
      "@keyframes lfw-blink{0%,80%,100%{opacity:.25}40%{opacity:1}}" +
      ".lfw-error{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c}" +
      /* -------- input -------- */
      ".lfw-form{display:flex;align-items:flex-end;gap:8px;padding:12px;border-top:1px solid #e2e8f0;background:#fff;flex-shrink:0}" +
      ".lfw-input{flex:1;resize:none;border:1px solid #e2e8f0;border-radius:12px;padding:10px 12px;font:inherit;font-size:14px;max-height:110px;min-height:40px;outline:none;color:#1e293b;background:#f8fafc}" +
      ".lfw-input:focus{border-color:" + c + ";background:#fff;box-shadow:0 0 0 3px " + c + "26}" +
      ".lfw-input::placeholder{color:#94a3b8}" +
      ".lfw-send{width:40px;height:40px;border-radius:12px;border:none;background:" + c + ";color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s ease,opacity .15s ease}" +
      ".lfw-send:hover:not(:disabled){filter:brightness(1.08)}" +
      ".lfw-send:disabled{opacity:.5;cursor:default}" +
      ".lfw-send svg{width:18px;height:18px}" +
      /* -------- footer -------- */
      ".lfw-footer{padding:6px;text-align:center;background:#fff;border-top:1px solid #f1f5f9;flex-shrink:0}" +
      ".lfw-footer a{color:#94a3b8;font-size:11px;text-decoration:none}" +
      ".lfw-footer a:hover{color:#64748b}" +
      /* -------- mobile -------- */
      "@media (max-width:480px),(max-height:520px){" +
      ".lfw-launcher{right:14px;bottom:14px;width:54px;height:54px}" +
      ".lfw-root[data-position='bottom-left'] .lfw-launcher{right:auto;left:14px}" +
      ".lfw-window{right:8px;left:8px;bottom:78px;width:auto;max-width:none;max-height:calc(100vh - 96px);height:calc(100vh - 96px)}" +
      ".lfw-root[data-position='bottom-left'] .lfw-window{left:8px;right:8px}" +
      "}"
    );
  }

  // ------------------------------------------------------------- rendering ----
  function renderMessages(container) {
    while (container.firstChild) container.removeChild(container.firstChild);
    var showSystemNote = state.conversationId && state.messages.length > 0 && state.config && state.config.aiActive === false;
    state.messages.forEach(function (m) {
      container.appendChild(buildMessage(m));
    });
    if (showSystemNote) {
      container.appendChild(
        el("div", "lfw-msg lfw-system", "A team member has been notified and will take it from here.")
      );
    }
    container.scrollTop = container.scrollHeight;
  }

  function buildMessage(m) {
    var node = el("div", "lfw-msg " + (m.sender === "lead" ? "lfw-lead" : m.sender === "employee" ? "lfw-employee" : m.sender === "system" ? "lfw-system" : "lfw-ai"));
    node.textContent = m.body || "";
    return node;
  }

  function build() {
    var c = cssColor(state.config.primaryColor);
    var host = el("div");
    host.className = "lfw-root";
    host.setAttribute("data-position", state.config.position === "bottom-left" ? "bottom-left" : "bottom-right");

    var shadow = host.attachShadow({ mode: "open" });
    var style = el("style", null, styles(c));
    shadow.appendChild(style);

    // Launcher
    var launcher = el("button", "lfw-launcher");
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Open chat");
    launcher.innerHTML =
      '<svg class="lfw-chat-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
      '<svg class="lfw-close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    shadow.appendChild(launcher);

    // Window
    var win = el("div", "lfw-window");
    win.hidden = true;

    var header = el("div", "lfw-header");
    var logo = el("div", "lfw-logo");
    if (state.config.logoUrl) {
      var img = document.createElement("img");
      img.src = state.config.logoUrl;
      img.alt = state.config.businessName + " logo";
      img.addEventListener("error", function () {
        if (logo.firstChild) logo.removeChild(logo.firstChild);
        logo.appendChild(el("span", "lfw-logo-fallback", (state.config.businessName || "?").charAt(0).toUpperCase()));
      });
      logo.appendChild(img);
    } else {
      logo.appendChild(el("span", "lfw-logo-fallback", (state.config.businessName || "?").charAt(0).toUpperCase()));
    }
    var headerText = el("div", "lfw-header-text");
    headerText.appendChild(el("div", "lfw-header-name", state.config.businessName || "Chat with us"));
    var status = el("div", "lfw-header-status");
    status.appendChild(el("span", "lfw-dot"));
    status.appendChild(document.createTextNode((state.config.agentName || "AI receptionist") + " · online"));
    headerText.appendChild(status);
    header.appendChild(logo);
    header.appendChild(headerText);
    win.appendChild(header);

    var messages = el("div", "lfw-messages");
    messages.setAttribute("role", "log");
    messages.setAttribute("aria-live", "polite");
    win.appendChild(messages);

    var form = el("form", "lfw-form");
    var input = el("textarea", "lfw-input");
    input.rows = 1;
    input.placeholder = "Type your message…";
    input.setAttribute("aria-label", "Your message");
    var send = el("button", "lfw-send");
    send.type = "submit";
    send.setAttribute("aria-label", "Send message");
    send.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
    form.appendChild(input);
    form.appendChild(send);
    win.appendChild(form);

    var footer = el("div", "lfw-footer");
    var powered = el("a", null, "Powered by LeadFlow AI");
    powered.href = origin;
    powered.target = "_blank";
    powered.rel = "noopener";
    footer.appendChild(powered);
    win.appendChild(footer);

    shadow.appendChild(win);
    document.body.appendChild(host);

    // ------------------------------------------------------------ behavior ----
    function setBusy(b) {
      state.busy = b;
      send.disabled = b;
      input.disabled = b;
      if (b) {
        var t = el("div", "lfw-typing");
        t.appendChild(el("span"));
        t.appendChild(el("span"));
        t.appendChild(el("span"));
        t.dataset.lfwTyping = "1";
        messages.appendChild(t);
        messages.scrollTop = messages.scrollHeight;
      } else {
        var typing = messages.querySelector('[data-lfw-typing="1"]');
        if (typing && typing.parentNode) typing.parentNode.removeChild(typing);
      }
    }

    function autoResize() {
      input.style.height = "auto";
      input.style.height = Math.min(input.scrollHeight, 110) + "px";
    }

    input.addEventListener("input", autoResize);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    launcher.addEventListener("click", function () {
      state.open = !state.open;
      win.hidden = !state.open;
      launcher.classList.toggle("lfw-open", state.open);
      launcher.setAttribute("aria-label", state.open ? "Close chat" : "Open chat");
      if (state.open) {
        renderMessages(messages);
        if (state.messages.length === 0 && state.config.welcomeMessage) {
          var welcomeNode = buildMessage({ sender: "ai", body: state.config.welcomeMessage });
          messages.appendChild(welcomeNode);
          messages.scrollTop = messages.scrollHeight;
        }
        input.focus();
      }
    });

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text || state.busy) return;
      input.value = "";
      input.style.height = "auto";
      sendMessage(text);
    });

    function sendMessage(text) {
      state.messages.push({ sender: "lead", body: text });
      renderMessages(messages);
      setBusy(true);
      api("/api/widget/chat", {
        method: "POST",
        body: { businessId: businessId, conversationId: state.conversationId || undefined, message: text },
      })
        .then(function (data) {
          state.conversationId = data.conversationId;
          state.messages = (data.messages || []).map(function (m) {
            return { sender: m.sender, body: m.body };
          });
          if (data.aiActive !== undefined) state.config.aiActive = data.aiActive;
          renderMessages(messages);
        })
        .catch(function () {
          var errMsg = el("div", "lfw-msg lfw-ai lfw-error", "Sorry — something went wrong. Please try again in a moment.");
          messages.appendChild(errMsg);
          messages.scrollTop = messages.scrollHeight;
        })
        .finally(function () {
          setBusy(false);
          input.focus();
        });
    }
  }

  // ---------------------------------------------------------------- config ----
  api("/api/widget/config?businessId=" + encodeURIComponent(businessId))
    .then(function (cfg) {
      state.config = cfg;
      // data-* overrides (handy for demos/tests) win over server config.
      var scriptAttr = script.getAttribute.bind(script);
      if (scriptAttr("data-position")) state.config.position = scriptAttr("data-position");
      if (scriptAttr("data-primary-color")) state.config.primaryColor = scriptAttr("data-primary-color");
      if (scriptAttr("data-welcome-message")) state.config.welcomeMessage = scriptAttr("data-welcome-message");
      build();
    })
    .catch(function (err) {
      if (err && err.status === 403) return; // widget disabled for this business — stay silent
      if (window.console) console.warn("[LeadFlow widget] Could not load config:", err && err.message ? err.message : err);
      // Degrade gracefully: still offer a launcher with a generic name.
      state.config = {
        businessName: "Chat with us",
        primaryColor: "#4f46e5",
        position: "bottom-right",
        welcomeMessage: "Hi! How can we help you today?",
        logoUrl: "",
        aiActive: true,
      };
      build();
    });
})();
