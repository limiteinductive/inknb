(() => {
  const pending = new Map();
  const updates = new Set();
  let current = null;
  let sequence = 0;
  let inspected = null;
  let inspectedRevision = null;
  const controls = new Map();
  let controlSequence = 0;
  const identities = new WeakMap();
  function send(type, payload = {}) {
    parent.postMessage({ inknb: 1, type, ...payload }, "*");
  }
  function request(type, payload) {
    const requestId = String(++sequence);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("The component host did not respond."));
      }, 5000);
      pending.set(requestId, { resolve, reject, timeout });
      send(type, { requestId, ...payload });
    });
  }
  const ready = new Promise((resolve) => updates.add(resolve));
  Object.defineProperty(window, "inknb", {
    value: Object.freeze({
      version: 1,
      ready,
      get current() {
        return structuredClone(current);
      },
      subscribe(listener) {
        updates.add(listener);
        if (current) listener(structuredClone(current));
        return () => updates.delete(listener);
      },
      emit(name, payload = null) {
        return request("event", { name, payload });
      },
      setState(state) {
        return request("state", { revision: current.revision, state });
      },
    }),
  });
  window.addEventListener("message", async (event) => {
    if (event.source !== parent || event.data?.inknb !== 1) return;
    const message = event.data;
    if (message.type === "context") {
      current = message.context;
      for (const [name, value] of Object.entries(current.theme.tokens))
        document.documentElement.style.setProperty(name, value);
      document.documentElement.dataset.theme = current.theme.appearance;
      document.documentElement.style.colorScheme = current.theme.appearance;
      document.documentElement.dataset.motion = current.theme.reduceMotion
        ? "reduced"
        : "system";
      for (const listener of updates) {
        try {
          listener(structuredClone(current));
        } catch (error) {
          send("error", { error: String(error) });
        }
      }
      return;
    }
    if (message.type === "result") {
      const operation = pending.get(message.requestId);
      if (!operation) return;
      pending.delete(message.requestId);
      clearTimeout(operation.timeout);
      if (message.error) operation.reject(new Error(message.error));
      else {
        if (message.context) current = message.context;
        operation.resolve(message.result);
      }
      return;
    }
    if (message.type !== "inspect" && message.type !== "action") return;
    try {
      let result;
      if (message.type === "inspect") {
        inspected = crypto.randomUUID();
        inspectedRevision = current?.revision;
        controls.clear();
        const elements = [
          ...document.querySelectorAll(
            'button,input,select,textarea,[role="button"],a[href]',
          ),
        ];
        const items = elements.flatMap((element) => {
          if (
            !(element instanceof HTMLElement) ||
            element.getClientRects().length === 0 ||
            getComputedStyle(element).visibility !== "visible" ||
            element.closest('[inert],[aria-hidden="true"]')
          )
            return [];
          let identity = identities.get(element);
          if (!identity) {
            identity = String(++controlSequence);
            identities.set(element, identity);
          }
          controls.set(identity, element);
          return [
            {
              id: identity,
              label:
                element.getAttribute("aria-label") ||
                element.labels?.[0]?.textContent ||
                element.textContent?.trim() ||
                element.getAttribute("placeholder") ||
                element.tagName.toLowerCase(),
              role:
                element.getAttribute("role") || element.tagName.toLowerCase(),
              value: element.value ?? null,
              disabled:
                Boolean(element.disabled) ||
                element.getAttribute("aria-disabled") === "true",
              rectangle: element.getBoundingClientRect().toJSON(),
            },
          ];
        });
        result = {
          snapshotId: inspected,
          controls: items,
          text: document.body.innerText.slice(0, 100000),
          title: document.title,
        };
      } else {
        if (
          message.snapshotId !== inspected ||
          current?.revision !== inspectedRevision
        )
          throw new Error("Inspect this component again before acting.");
        const element = controls.get(message.target);
        if (
          !element?.isConnected ||
          element.disabled ||
          element.getAttribute("aria-disabled") === "true"
        )
          throw new Error("This component control is unavailable.");
        if (message.action === "activate") element.click();
        else if (message.action === "focus") element.focus();
        else if (message.action === "setValue") {
          if (
            !["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ||
            ["file", "password"].includes(element.type)
          )
            throw new Error("This control does not accept agent input.");
          const prototype = Object.getPrototypeOf(element);
          Object.getOwnPropertyDescriptor(prototype, "value").set.call(
            element,
            message.value,
          );
          element.dispatchEvent(new Event("input", { bubbles: true }));
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else throw new Error("Unsupported component action.");
        result = { acted: true };
      }
      send("response", { requestId: message.requestId, result });
    } catch (error) {
      send("response", { requestId: message.requestId, error: String(error) });
    }
  });
  window.addEventListener("error", (event) =>
    send("error", { error: event.message }),
  );
  window.addEventListener("unhandledrejection", (event) =>
    send("error", { error: String(event.reason) }),
  );
  document.addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent = `*{box-sizing:border-box}html,body{margin:0;color:var(--ink);background:transparent;font:13px/1.55 var(--interface-font);-webkit-font-smoothing:antialiased}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}::selection{background:var(--selection)}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}html[data-motion=reduced] *,html[data-motion=reduced] *::before,html[data-motion=reduced] *::after{animation:none!important;transition:none!important}`;
    document.head.prepend(style);
    new ResizeObserver(() =>
      send("height", {
        height: Math.ceil(
          document.documentElement.getBoundingClientRect().height,
        ),
      }),
    ).observe(document.documentElement);
    send("ready");
  });
})();
