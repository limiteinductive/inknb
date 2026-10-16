import { useEffect, useRef, useState } from "react";
import { Button } from "react-aria-components";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";
import { componentMessage, componentRuntimes } from "./component-bridge";
import type { ComponentInstance } from "./domain";
import { useDocumentSession, useSession } from "./use-session";

export default function ComponentHost({
  instance,
}: {
  instance: ComponentInstance;
}) {
  const session = useDocumentSession();
  const state = useSession();
  const frame = useRef<HTMLIFrameElement>(null);
  const [entry, setEntry] = useState<string | null>(null);
  const [height, setHeight] = useState(180);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [reload, setReload] = useState(0);
  const sendContext = useRef<() => void>(() => {});
  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setError(null);
    setReady(false);
    void invoke<{ manifest: { entry: string; height: number } }>(
      "component_info",
      { bundleId: instance.bundleId },
    )
      .then((bundle) => {
        if (cancelled) return;
        setHeight(bundle.manifest.height);
        setEntry(bundle.manifest.entry);
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [instance.bundleId, reload]);
  useEffect(() => {
    const epoch = session.getSnapshot().epoch;
    const pending = new Map<
      string,
      {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
      }
    >();
    const runtime = {
      status: "loading" as "loading" | "ready" | "error",
      error: null as string | null,
      request: (type: "inspect" | "action", payload: Record<string, unknown>) =>
        new Promise<unknown>((resolve, reject) => {
          const requestId = crypto.randomUUID();
          const timeout = setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("The component did not respond."));
          }, 3000);
          pending.set(requestId, { resolve, reject, timeout });
          frame.current?.contentWindow?.postMessage(
            { inknb: 1, type, requestId, ...payload },
            "*",
          );
        }),
    };
    componentRuntimes.set(instance.id, runtime);
    const startup = setTimeout(() => {
      if (runtime.status !== "loading") return;
      runtime.status = "error";
      runtime.error = "The component did not finish loading.";
      setError(runtime.error);
    }, 10000);
    function context() {
      const current = session.getSnapshot();
      const component = current.metadata.threads
        .flatMap((thread) => thread.components)
        .find((component) => component.id === instance.id);
      const computed = getComputedStyle(document.documentElement);
      return {
        componentId: instance.id,
        revision: component?.revision,
        data: component?.data,
        state: component?.state,
        theme: {
          appearance: document.documentElement.dataset.theme,
          reduceMotion: current.preferences.reduceMotion,
          tokens: Object.fromEntries(
            [
              "--ink",
              "--paper",
              "--surface",
              "--muted",
              "--faint",
              "--accent",
              "--accent-wash",
              "--accent-line",
              "--on-accent",
              "--line",
              "--line-soft",
              "--hover",
              "--selection",
              "--source",
              "--source-wash",
              "--danger",
              "--mono-font",
              "--feedback",
              "--reveal",
              "--interface-font",
              "--writing-font",
            ].map((name) => [name, computed.getPropertyValue(name)]),
          ),
        },
      };
    }
    sendContext.current = () => {
      if (session.getSnapshot().epoch !== epoch) return;
      frame.current?.contentWindow?.postMessage(
        { inknb: 1, type: "context", context: context() },
        "*",
      );
    };
    const receive = async (event: MessageEvent) => {
      if (
        session.getSnapshot().epoch !== epoch ||
        !frame.current?.contentWindow ||
        event.source !== frame.current.contentWindow
      )
        return;
      const parsed = componentMessage.safeParse(event.data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "ready") {
        if (runtime.status === "error") return;
        clearTimeout(startup);
        runtime.status = "ready";
        runtime.error = null;
        setReady(true);
        setError(null);
        sendContext.current();
        return;
      }
      if (message.type === "height") {
        setHeight(Math.max(100, Math.min(800, message.height)));
        return;
      }
      if (message.type === "error") {
        runtime.status = "error";
        runtime.error = message.error;
        setError(message.error);
        return;
      }
      if (message.type === "response") {
        const operation = pending.get(message.requestId);
        if (!operation) return;
        pending.delete(message.requestId);
        clearTimeout(operation.timeout);
        if (message.error) operation.reject(new Error(message.error));
        else operation.resolve(message.result);
        return;
      }
      try {
        const result = await session.componentMessage(instance.id, message);
        frame.current?.contentWindow?.postMessage(
          {
            inknb: 1,
            type: "result",
            requestId: message.requestId,
            result,
            context: context(),
          },
          "*",
        );
      } catch (error) {
        frame.current?.contentWindow?.postMessage(
          {
            inknb: 1,
            type: "result",
            requestId: message.requestId,
            error: String(error),
          },
          "*",
        );
      }
    };
    window.addEventListener("message", receive);
    const themeObserver = new MutationObserver(() => sendContext.current());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-motion", "data-typeface", "style"],
    });
    return () => {
      clearTimeout(startup);
      themeObserver.disconnect();
      window.removeEventListener("message", receive);
      if (componentRuntimes.get(instance.id) === runtime)
        componentRuntimes.delete(instance.id);
      for (const operation of pending.values()) {
        clearTimeout(operation.timeout);
        operation.reject(new Error("The component closed."));
      }
    };
  }, [instance.id, instance.bundleId, reload]);
  useEffect(() => {
    if (ready) sendContext.current();
  }, [instance, ready, state.preferences]);
  if (instance.hidden) return null;
  return (
    <section className="component-card" aria-label={instance.title}>
      <header className="component-heading">
        <span>{instance.title}</span>
        <Button
          className="icon-button"
          aria-label={`Hide ${instance.title}`}
          data-inknb-control={`component-hide:${instance.id}`}
          onPress={() => session.hideComponent(instance.id)}
        >
          <X size={13} />
        </Button>
      </header>
      {error && (
        <div className="component-error">
          <p>This component needs attention.</p>
          <details className="inspection">
            <summary>Details</summary>
            <p>{error}</p>
          </details>
          <Button
            className="text-button"
            data-inknb-control={`component-reload:${instance.id}`}
            onPress={() => setReload((value) => value + 1)}
          >
            Reload component
          </Button>
        </div>
      )}
      {!entry && !error && <p className="quiet-note">Opening component…</p>}
      {entry && !error && (
        <iframe
          key={`${instance.bundleId}:${reload}`}
          ref={frame}
          title={instance.title}
          data-inknb-component={instance.id}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'"
          src={`inknb-component://localhost/${instance.bundleId}/${entry}`}
          style={{ height }}
        />
      )}
    </section>
  );
}
