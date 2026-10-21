(() => {
  let context = null;
  let pageDocument = null;
  let pageVersion = null;
  let pageAssets = {};
  let pageBindings = [];
  let pageNodes = new Map();
  const pageListeners = new Set();
  Object.defineProperty(window, "inknbPage", {
    value: Object.freeze({
      version: 1,
      get document() { return structuredClone(pageDocument); },
      subscribe(listener) {
        pageListeners.add(listener);
        if (pageDocument) listener(structuredClone(pageDocument));
        return () => pageListeners.delete(listener);
      },
    }),
  });
  function renderPageNode(node) {
    if (node.type === "text") {
      let element = document.createTextNode(node.text || "");
      for (const mark of node.marks || []) {
        const tag = { strong: "strong", em: "em", code: "code", link: "a" }[mark.type];
        if (!tag) continue;
        const wrapper = document.createElement(tag);
        if (mark.type === "link") {
          wrapper.setAttribute("href", String(mark.attributes.href || ""));
          wrapper.setAttribute("data-inknb-reference", "");
        }
        wrapper.append(element);
        element = wrapper;
      }
      return element;
    }
    const tag = { paragraph: "p", heading: `h${Math.min(6, Math.max(1, Number(node.attributes?.level || 1)))}`, bullet_list: "ul", ordered_list: "ol", list_item: "li", blockquote: "blockquote", code_block: "pre", hard_break: "br", image: "img", horizontal_rule: "hr", table: "table", table_row: "tr", table_cell: "td", table_header: "th" }[node.type] || "div";
    const element = document.createElement(tag);
    if (node.identity) {
      element.dataset.inknbNode = node.identity;
      element.id = `page-${node.identity}`;
      element.dataset.inknbRole = ["paragraph", "heading", "code_block"].includes(node.type) ? "text" : ["bullet_list", "ordered_list", "blockquote", "doc", "section"].includes(node.type) ? "container" : "item";
    }
    if (node.type === "image") {
      element.alt = String(node.attributes?.alt || "Image");
      const source = pageAssets[String(node.attributes?.src || "")];
      if (source) element.src = source;
    }
    if (["math", "math_block"].includes(node.type)) element.textContent = String(node.attributes?.value || "");
    if (["source_block", "source_inline"].includes(node.type)) element.textContent = String(node.attributes?.label || "Embedded content");
    for (const child of node.content || []) element.append(renderPageNode(child));
    return element;
  }
  function renderPageDocument(snapshot, bindings, version, assets) {
    if (!snapshot) return;
    pageDocument = snapshot;
    pageVersion = version;
    pageAssets = assets || {};
    pageBindings = bindings || pageBindings;
    pageNodes = new Map();
    const collect = (node) => {
      if (node.identity) pageNodes.set(node.identity, node);
      for (const child of node.content || []) collect(child);
    };
    collect(snapshot);
    for (const listener of pageListeners) listener(structuredClone(snapshot));
    for (const binding of pageBindings) {
      const element = document.getElementById(binding.elementId);
      if (!element) continue;
      element.dataset.inknbNode = binding.identity;
      element.dataset.inknbRole = binding.role;
    }
    const elements = new Map([...document.querySelectorAll("[data-inknb-node][data-inknb-role]")].map((element) => [element.dataset.inknbNode, element]));
    for (const [identity, element] of elements) {
      const node = pageNodes.get(identity);
      if (!node) {
        element.hidden = true;
        continue;
      }
      element.hidden = false;
      if (["paragraph", "heading", "code_block"].includes(node.type)) {
        element.replaceChildren(...(node.content || []).map(renderPageNode));
      }
    }
    for (const [identity, container] of elements) {
      if (container.dataset.inknbRole !== "container") continue;
      const node = pageNodes.get(identity);
      if (!node) continue;
      const template = [...container.children].find((element) => element.dataset.inknbRole === "item");
      for (const child of node.content || []) {
        if (!child.identity) continue;
        let element = elements.get(child.identity);
        if (element && element.dataset.inknbRole !== "item") continue;
        if (!element) {
          element = renderPageNode(child);
          element.dataset.inknbRole = "item";
          if (template) element.className = template.className;
          elements.set(child.identity, element);
        }
        container.append(element);
      }
    }
    for (const element of document.querySelectorAll('[data-inknb-role="text"]')) element.style.visibility = "hidden";
    reportLayout();
  }
  let failure = null;
  let region = null;
  let overlay = null;
  let regionSelecting = false;
  const scrollbarStyle = document.createElement("style");
  document.documentElement.append(scrollbarStyle);
  function applyScrollbars(scrollbars) {
    if (scrollbars.appearance) document.documentElement.dataset.appearance = scrollbars.appearance;
    scrollbarStyle.textContent = scrollbars.stylesheet;
    for (const [name, value] of Object.entries(scrollbars.tokens))
      document.documentElement.style.setProperty(name, value);
  }
  const regionStyle = document.createElement("style");
  regionStyle.textContent = `
    html[data-inknb-region-selecting], html[data-inknb-region-selecting] * {
      -webkit-user-select: none !important;
      user-select: none !important;
      cursor: crosshair !important;
      touch-action: none !important;
    }
  `;
  document.documentElement.append(regionStyle);
  const suggestionStyle = document.createElement("style");
  document.documentElement.append(suggestionStyle);
  let focusedSuggestion = null;
  function renderSuggestions(suggestions, stylesheet, focus) {
    let located = false;
    suggestionStyle.textContent = stylesheet || "";
    for (const element of document.querySelectorAll("[data-inknb-suggestion]"))
      element.remove();
    for (const suggestion of suggestions || []) {
      if (suggestion.target.kind !== "element") continue;
      const target = document.getElementById(suggestion.target.elementId);
      if (!target) continue;
      const card = document.createElement("section");
      card.className = "preview-suggestion";
      card.dataset.inknbSuggestion = suggestion.id;
      const label = document.createElement("span");
      label.className = "suggestion-label";
      label.textContent = "Suggested edit";
      const content = document.createElement("div");
      content.innerHTML = suggestion.html;
      for (const element of content.querySelectorAll("[id]"))
        element.removeAttribute("id");
      card.append(label, content);
      (target.closest("table") || target).before(card);
      if (focus === suggestion.id) located = true;
      if (focus === suggestion.id && focus !== focusedSuggestion)
        send("locate", { top: card.getBoundingClientRect().top + scrollY });
    }
    if (!focus || located) focusedSuggestion = focus || null;
  }
  function setRegionMode(active) {
    regionSelecting = Boolean(active);
    document.documentElement.toggleAttribute(
      "data-inknb-region-selecting",
      regionSelecting,
    );
    if (regionSelecting) getSelection()?.removeAllRanges();
    else {
      overlay?.remove();
      overlay = null;
      region = null;
    }
  }
  const send = (type, payload = {}) =>
    parent.postMessage(
      { inknbPreview: 1, artifactId: context?.artifactId, type, ...payload },
      "*",
    );
  let layoutFrame = null;
  let asideTargets = [];
  let asideRanges = new Map();
  let activeAside = null;
  let hoveredAside = null;
  function emphasizeAside(identity) {
    hoveredAside = identity;
    if (!globalThis.CSS?.highlights) return;
    CSS.highlights.set(
      "inknb-aside-focus",
      new Highlight(...(asideRanges.get(identity ?? activeAside) || [])),
    );
  }
  function renderAsideHighlights(asides, active) {
    asideTargets = asides || [];
    activeAside = active;
    asideRanges = new Map();
    if (!document.getElementById("inknb-aside-styles")) {
      const style = document.createElement("style");
      style.id = "inknb-aside-styles";
      style.textContent = `
        html,body{height:auto!important;min-height:0!important;overflow:visible!important}
        ::highlight(inknb-asides){background:var(--passage-highlight,#d8c77929)}
        ::highlight(inknb-aside-focus){background:var(--passage-focus,#d8c77966)}
        html[data-inknb-aside-pointer],html[data-inknb-aside-pointer] body{cursor:pointer}
      `;
      document.head.append(style);
    }
    for (const aside of asideTargets) {
      if (aside.target.kind !== "html" || !aside.target.elementId) continue;
      const element =
        (aside.suggestionId &&
          document.querySelector(
            `[data-inknb-suggestion="${aside.suggestionId}"], [data-suggestion-id="${aside.suggestionId}"]`,
          )) ||
        document.getElementById(aside.target.elementId);
      if (!element) continue;
      const last =
        !element.hasAttribute("data-inknb-suggestion") &&
        aside.target.endElementId
          ? document.getElementById(aside.target.endElementId)
          : element;
      const scope = document.createRange();
      scope.selectNodeContents(element);
      if (last && last !== element) scope.setEnd(last, last.childNodes.length);
      const walker = document.createTreeWalker(
        scope.commonAncestorContainer,
        NodeFilter.SHOW_TEXT,
      );
      const nodes = [];
      let text = "";
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (
          !scope.intersectsNode(node) ||
          node.parentElement.closest("script,style")
        )
          continue;
        for (let offset = 0; offset < node.textContent.length; offset++) {
          const character = node.textContent[offset];
          if (/\s/.test(character) && /\s$/.test(text)) continue;
          nodes.push({ node, offset });
          text += /\s/.test(character) ? " " : character;
        }
      }
      const quote = (aside.quote || "").replace(/\s+/g, " ").trim();
      const start = quote ? text.indexOf(quote) : -1;
      const ranges = [];
      if (start >= 0 && quote.length) {
        const from = nodes[start];
        const to = nodes[start + quote.length - 1];
        const range = document.createRange();
        range.setStart(from.node, from.offset);
        range.setEnd(to.node, to.offset + 1);
        ranges.push(range);
      } else {
        for (const { node } of nodes) {
          if (ranges.at(-1)?.startContainer === node) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          ranges.push(range);
        }
      }
      asideRanges.set(aside.id, ranges);
    }
    if (globalThis.CSS?.highlights) {
      CSS.highlights.set(
        "inknb-asides",
        new Highlight(
          ...asideTargets
            .filter((aside) => aside.expanded)
            .flatMap((aside) => asideRanges.get(aside.id) || []),
        ),
      );
      emphasizeAside(hoveredAside);
    }
    reportLayout();
  }
  function reportLayout() {
    if (!context || layoutFrame !== null) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      send("layout", {
        pageVersion,
        nodes: pageDocument ? [...document.querySelectorAll("[data-inknb-node][data-inknb-role]")].flatMap((element) => {
          if (!pageNodes.has(element.dataset.inknbNode) || element.hidden || !element.getClientRects().length) return [];
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return [{ identity: element.dataset.inknbNode, role: element.dataset.inknbRole, label: (element.getAttribute("aria-label") || "").slice(0, 200), left: bounds.left + scrollX, top: bounds.top + scrollY, width: bounds.width, height: bounds.height, fontFamily: style.fontFamily, fontSize: parseFloat(style.fontSize) || 17, fontWeight: style.fontWeight, lineHeight: parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 17) * 1.6 }];
        }) : [],
        height: Math.max(
          1,
          document.body.offsetHeight +
            parseFloat(getComputedStyle(document.body).marginTop || 0) +
            parseFloat(getComputedStyle(document.body).marginBottom || 0),
          document.body.scrollHeight,
        ),
        positions: asideTargets.flatMap((aside) => {
          if (aside.target.kind !== "html") return [];
          const target = aside.target;
          const suggestion =
            aside.suggestionId &&
            document.querySelector(
              `[data-inknb-suggestion="${aside.suggestionId}"], [data-suggestion-id="${aside.suggestionId}"]`,
            );
          const element =
            suggestion ||
            (target.elementId
              ? document.getElementById(target.elementId)
              : document.documentElement);
          if (!element) return [];
          const bounds = element.getBoundingClientRect();
          const rectangles =
            aside.quote || suggestion
              ? (asideRanges.get(aside.id) || []).flatMap((range) =>
                  [...range.getClientRects()].filter(
                    (rectangle) => rectangle.width && rectangle.height,
                  ),
                )
              : [];
          const rangeBounds = rectangles.length
            ? {
                top: Math.min(...rectangles.map((rectangle) => rectangle.top)),
                bottom: Math.max(
                  ...rectangles.map((rectangle) => rectangle.bottom),
                ),
              }
            : null;
          return [
            {
              id: aside.id,
              top:
                (rangeBounds?.top ??
                  bounds.top + target.rectangle.top * bounds.height) + scrollY,
              bottom:
                (rangeBounds?.bottom ??
                  bounds.top +
                    (target.rectangle.top + target.rectangle.height) *
                      bounds.height) + scrollY,
            },
          ];
        }),
      });
    });
  }
  function publishSelection(bounds, quote, elementId, endElementId) {
    const element = elementId
      ? document.getElementById(elementId)
      : document.documentElement;
    if (!element || !bounds.width || !bounds.height) return;
    const base = element.getBoundingClientRect();
    const width = elementId
      ? base.width
      : Math.max(base.width, document.documentElement.scrollWidth);
    const height = elementId
      ? base.height
      : Math.max(base.height, document.documentElement.scrollHeight);
    const left = Math.max(0, Math.min(1, (bounds.left - base.left) / width));
    const top = Math.max(0, Math.min(1, (bounds.top - base.top) / height));
    send("selection", {
      quote: quote.slice(0, 100000),
      target: {
        kind: "html",
        elementId,
        endElementId,
        rectangle: {
          left,
          top,
          width: Math.min(1 - left, bounds.width / width),
          height: Math.min(1 - top, bounds.height / height),
        },
      },
      bounds: {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
      },
    });
  }
  function reportSelection() {
    const selection = getSelection();
    if (
      !context ||
      !selection ||
      selection.isCollapsed ||
      !selection.rangeCount
    ) {
      send("selectionCleared");
      return;
    }
    const range = selection.getRangeAt(0);
    let start = null;
    let end = null;
    const rectangles = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent || !range.intersectsNode(node)) continue;
      const from = node === range.startContainer ? range.startOffset : 0;
      const to =
        node === range.endContainer ? range.endOffset : node.textContent.length;
      if (!node.textContent.slice(from, to).trim()) continue;
      const fragment = document.createRange();
      fragment.setStart(node, from);
      fragment.setEnd(node, to);
      const visible = [...fragment.getClientRects()].filter(
        (rectangle) => rectangle.width > 0 && rectangle.height > 0,
      );
      if (!visible.length) continue;
      start ??= node.parentElement;
      end = node.parentElement;
      rectangles.push(...visible);
    }
    if (!rectangles.length) {
      send("selectionCleared");
      return;
    }
    const left = Math.min(...rectangles.map((rectangle) => rectangle.left));
    const top = Math.min(...rectangles.map((rectangle) => rectangle.top));
    const right = Math.max(...rectangles.map((rectangle) => rectangle.right));
    const bottom = Math.max(...rectangles.map((rectangle) => rectangle.bottom));
    while (start && !context.elementIds.includes(start.id))
      start = start.parentElement;
    while (end && !context.elementIds.includes(end.id)) end = end.parentElement;
    publishSelection(
      { left, top, right, bottom, width: right - left, height: bottom - top },
      selection.toString(),
      start?.id ?? null,
      end?.id ?? null,
    );
  }
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.inknbPreview !== 1) return;
    const message = event.data;
    if (message.type === "emphasize") emphasizeAside(message.id);
    if (message.type === "scrollbars") applyScrollbars(message.scrollbars);
    if (message.type === "asides")
      renderAsideHighlights(message.asides, message.activeAside);
    if (message.type === "suggestions") {
      renderSuggestions(
        message.suggestions,
        message.suggestionStyles,
        message.suggestionFocus,
      );
      renderAsideHighlights(asideTargets, activeAside);
    }
    if (message.type === "regionMode") {
      setRegionMode(message.active);
    }
    if (message.type === "context") {
      context = message;
      renderPageDocument(message.pageDocument, message.pageBindings, message.pageVersion, message.pageAssets);
      applyScrollbars(message.scrollbars);
      renderSuggestions(
        message.suggestions,
        message.suggestionStyles,
        message.suggestionFocus,
      );
      renderAsideHighlights(message.asides, message.activeAside);
      setRegionMode(message.regionSelecting);
      const identities = [...document.querySelectorAll("[id]")].map(
        (element) => element.id,
      );
      const missing = context.elementIds.filter(
        (identity) =>
          identities.filter((value) => value === identity).length !== 1,
      );
      if (failure) send("error", { error: failure });
      else if (missing.length)
        send("error", {
          error: `Source map elements must exist once: ${missing.join(", ")}`,
        });
      else send("ready", { text: document.body.innerText.slice(0, 100000) });
      reportLayout();
    }
    if (message.type === "pageDocument") renderPageDocument(message.document, message.bindings, message.version, message.assets);
    if (message.type === "locate") {
      const target = message.target;
      const element = target.elementId
        ? document.getElementById(target.elementId)
        : document.documentElement;
      if (!element) return;
      const bounds = element.getBoundingClientRect();
      const height = target.elementId
        ? bounds.height
        : document.documentElement.scrollHeight;
      let left = bounds.left + target.rectangle.left * bounds.width;
      let right = left + target.rectangle.width * bounds.width;
      let ancestor = element.parentElement;
      while (ancestor && ancestor !== document.body) {
        const overflow = getComputedStyle(ancestor).overflowX;
        if (
          ancestor.scrollWidth > ancestor.clientWidth &&
          ["auto", "scroll", "hidden"].includes(overflow)
        ) {
          const viewport = ancestor.getBoundingClientRect();
          const start = viewport.left + ancestor.clientLeft;
          const end = start + ancestor.clientWidth;
          const offset = left < start ? left - start : Math.max(0, right - end);
          const previous = ancestor.scrollLeft;
          ancestor.scrollLeft += offset;
          const moved = ancestor.scrollLeft - previous;
          left -= moved;
          right -= moved;
        }
        ancestor = ancestor.parentElement;
      }
      send("locate", {
        top: scrollY + bounds.top + target.rectangle.top * height,
      });
    }
  });
  for (const type of ["pointermove", "click"])
    document.addEventListener(type, (event) => {
      if (type === "pointermove")
        send("pointerPosition", {
          top:
            event.pointerType === "mouse" && event.buttons === 0
              ? event.clientY
              : null,
        });
      if (regionSelecting || !getSelection()?.isCollapsed || event.buttons) {
        if (type === "pointermove")
          document.documentElement.removeAttribute("data-inknb-aside-pointer");
        return;
      }
      let identity = null;
      for (const [candidate, ranges] of asideRanges) {
        if (
          ranges.some((range) =>
            [...range.getClientRects()].some(
              (bounds) =>
                event.clientX >= bounds.left &&
                event.clientX <= bounds.right &&
                event.clientY >= bounds.top &&
                event.clientY <= bounds.bottom,
            ),
          )
        ) {
          identity = candidate;
          break;
        }
      }
      if (type === "pointermove") {
        document.documentElement.toggleAttribute(
          "data-inknb-aside-pointer",
          Boolean(identity && identity !== "new"),
        );
        if (identity !== hoveredAside) {
          emphasizeAside(identity);
          send("asideHovered", { id: identity });
        }
      }
      if (
        type === "click" &&
        event.button === 0 &&
        event.detail === 1 &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.ctrlKey &&
        identity &&
        identity !== "new" &&
        !event.target.closest("a,button,input,textarea,summary")
      )
        send("asideActivated", { id: identity });
    });
  document.addEventListener("pointerleave", () => {
    send("pointerPosition", { top: null });
    document.documentElement.removeAttribute("data-inknb-aside-pointer");
    emphasizeAside(null);
    send("asideHovered", { id: null });
  });
  document.addEventListener(
    "contextmenu",
    (event) => {
      event.preventDefault();
      reportSelection();
      send("contextmenu", { left: event.clientX, top: event.clientY });
    },
    true,
  );
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") {
      setRegionMode(false);
      send("escape");
      return;
    }
    if (event.shiftKey || event.key === "Shift") reportSelection();
  });
  document.addEventListener(
    "mousedown",
    (event) => {
      if (regionSelecting || region || event.altKey) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );
  document.addEventListener(
    "selectstart",
    (event) => {
      if (regionSelecting || region) event.preventDefault();
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    (event) => {
      if ((!event.altKey && !regionSelecting) || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      document.documentElement.setAttribute("data-inknb-region-selecting", "");
      getSelection()?.removeAllRanges();
      document.documentElement.setPointerCapture(event.pointerId);
      region = { left: event.clientX, top: event.clientY };
      overlay = document.createElement("div");
      Object.assign(overlay.style, {
        position: "fixed",
        pointerEvents: "none",
        zIndex: "2147483647",
        border: "1px solid #6e7584",
        background: "#eee1ab44",
      });
      document.body.append(overlay);
    },
    true,
  );
  document.addEventListener("pointermove", (event) => {
    if (!region) return;
    Object.assign(overlay.style, {
      left: `${Math.min(region.left, event.clientX)}px`,
      top: `${Math.min(region.top, event.clientY)}px`,
      width: `${Math.abs(region.left - event.clientX)}px`,
      height: `${Math.abs(region.top - event.clientY)}px`,
    });
  });
  document.addEventListener("pointerup", (event) => {
    if (!region) {
      if (!regionSelecting) setTimeout(reportSelection, 0);
      return;
    }
    const bounds = {
      left: Math.min(region.left, event.clientX),
      top: Math.min(region.top, event.clientY),
      right: Math.max(region.left, event.clientX),
      bottom: Math.max(region.top, event.clientY),
      width: Math.abs(region.left - event.clientX),
      height: Math.abs(region.top - event.clientY),
    };
    overlay?.remove();
    overlay = null;
    region = null;
    document.documentElement.toggleAttribute(
      "data-inknb-region-selecting",
      regionSelecting,
    );
    if (bounds.width > 3 && bounds.height > 3)
      publishSelection(bounds, "", null, null);
  });
  document.addEventListener("pointercancel", () => {
    overlay?.remove();
    overlay = null;
    region = null;
    document.documentElement.toggleAttribute(
      "data-inknb-region-selecting",
      regionSelecting,
    );
    send("selectionCleared");
  });
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link) return;
    const reference = link.getAttribute("href");
    if (
      link.hasAttribute("data-inknb-reference") &&
      reference &&
      !reference.startsWith("#")
    )
      send("reference", { reference });
    if (!reference?.startsWith("#")) event.preventDefault();
  });
  window.addEventListener("error", (event) => {
    failure = String(event.message).slice(0, 2000);
    if (context) send("error", { error: failure });
  });
  window.addEventListener("unhandledrejection", (event) => {
    failure = String(event.reason).slice(0, 2000);
    if (context) send("error", { error: failure });
  });
  window.addEventListener(
    "scroll",
    () => {
      send("selectionCleared");
    },
    { passive: true, capture: true },
  );
  window.addEventListener("resize", reportLayout);
  window.addEventListener("DOMContentLoaded", () => {
    new ResizeObserver(reportLayout).observe(document.body);
    document.fonts.ready.then(reportLayout);
    new MutationObserver(reportLayout).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class"],
    });
    send("loaded");
  });
})();
