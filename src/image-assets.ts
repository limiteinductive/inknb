import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

const imageAssetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unchanged") }),
  z.object({
    kind: z.literal("available"),
    version: z.string(),
    source: z.string(),
  }),
  z.object({ kind: z.literal("unavailable") }),
]);

interface ImageSubscription {
  documentPath: () => string | null;
  references: string[];
  receive: (assets: Record<string, string>) => void;
  fail: (error: unknown) => void;
  assets: Record<string, string> | null;
}

interface ImageAsset {
  documentPath: string | null;
  reference: string;
  version: string | null;
  source: string | null;
}

const subscriptions = new Set<ImageSubscription>();
const assets = new Map<string, ImageAsset>();
const emptyAssets: Record<string, string> = {};
let timer: ReturnType<typeof setTimeout> | null = null;
let refreshing = false;
let requested = false;

async function refreshImages(): Promise<void> {
  if (refreshing) {
    requested = true;
    return;
  }
  if (timer) clearTimeout(timer);
  timer = null;
  refreshing = true;
  requested = false;
  const active = new Map<string, ImageAsset>();
  for (const subscription of subscriptions) {
    const documentPath = subscription.documentPath();
    for (const reference of subscription.references) {
      const key = JSON.stringify([documentPath, reference]);
      const asset = assets.get(key) ?? {
        documentPath,
        reference,
        version: null,
        source: null,
      };
      active.set(key, asset);
      assets.set(key, asset);
    }
  }
  for (const key of assets.keys()) if (!active.has(key)) assets.delete(key);
  try {
    const pending = [...active];
    const results = pending.length
      ? z.array(imageAssetSchema).parse(
          await invoke("preview_assets", {
            requests: pending.map(([, asset]) => ({
              documentPath: asset.documentPath,
              reference: asset.reference,
              version: asset.version,
            })),
          }),
        )
      : [];
    for (const [index, [key, asset]] of pending.entries()) {
      if (assets.get(key) !== asset) continue;
      const result = results[index];
      if (result.kind === "unchanged") continue;
      asset.version = result.kind === "available" ? result.version : null;
      asset.source = result.kind === "available" ? result.source : null;
    }
    for (const subscription of subscriptions) {
      const documentPath = subscription.documentPath();
      const next: Record<string, string> = {};
      for (const reference of subscription.references) {
        const source = assets.get(
          JSON.stringify([documentPath, reference]),
        )?.source;
        if (source) next[reference] = source;
      }
      if (
        subscription.assets &&
        Object.keys(next).length === Object.keys(subscription.assets).length &&
        Object.entries(next).every(
          ([reference, source]) => subscription.assets![reference] === source,
        )
      )
        continue;
      subscription.assets = next;
      subscription.receive(next);
    }
  } catch (error) {
    for (const subscription of subscriptions) subscription.fail(error);
  } finally {
    refreshing = false;
    if (subscriptions.size && (active.size || requested))
      timer = setTimeout(refreshImages, requested ? 0 : 1800);
  }
}

export function observeImageAssets(
  documentPath: () => string | null,
  references: string[],
  receive: ImageSubscription["receive"],
  fail: ImageSubscription["fail"],
): () => void {
  const subscription: ImageSubscription = {
    documentPath,
    references: [...new Set(references)].filter(
      (reference) => reference && !/^[a-z][a-z0-9+.-]*:/i.test(reference),
    ),
    receive,
    fail,
    assets: null,
  };
  if (!subscription.references.length) {
    receive(emptyAssets);
    return () => {};
  }
  subscriptions.add(subscription);
  if (refreshing) requested = true;
  else {
    if (timer) clearTimeout(timer);
    timer = setTimeout(refreshImages, 0);
  }
  return () => {
    subscriptions.delete(subscription);
    if (subscriptions.size) return;
    if (timer) clearTimeout(timer);
    timer = null;
    assets.clear();
  };
}

export function useImageAssets(
  documentPath: string | null,
  references: string[],
  fail: ImageSubscription["fail"],
): Record<string, string> {
  const [assets, setAssets] = useState(emptyAssets);
  const failure = useRef(fail);
  failure.current = fail;
  const signature = JSON.stringify(references);
  useEffect(
    () =>
      observeImageAssets(
        () => documentPath,
        JSON.parse(signature),
        setAssets,
        (error) => failure.current(error),
      ),
    [documentPath, signature],
  );
  return assets;
}
