import { z } from "zod";
import { componentRuntimes } from "./component-bridge";

const actionSchema = z
  .object({
    documentId: z.string().uuid(),
    snapshotId: z.string().uuid(),
    target: z.string(),
    action: z.enum(["activate", "focus", "scroll", "setValue"]),
    value: z.string().max(100000).optional(),
    top: z.number().finite().nonnegative().optional(),
  })
  .strict();

let snapshotId = "";
const targets = new Map<
  string,
  (parameters: z.infer<typeof actionSchema>) => Promise<unknown>
>();

export async function inspectInterface() {
  const inspectionId = crypto.randomUUID();
  const inspectedTargets: typeof targets = new Map();
  const controls = [
    ...document.querySelectorAll<HTMLElement>("[data-inknb-control]"),
  ]
    .filter(
      (element) =>
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility === "visible" &&
        !element.closest('[inert],[aria-hidden="true"]'),
    )
    .map((element) => {
      const identity = element.dataset.inknbControl!;
      const label =
        element.getAttribute("aria-label") ??
        element.textContent?.trim() ??
        identity;
      inspectedTargets.set(identity, async (parameters) => {
        if (
          !element.isConnected ||
          element.getClientRects().length === 0 ||
          element.getAttribute("aria-disabled") === "true" ||
          element.matches(":disabled") ||
          Boolean(element.closest('[inert],[aria-hidden="true"]'))
        )
          throw new Error("This control changed. Inspect the interface again.");
        if (parameters.action === "focus")
          (
            element.querySelector<HTMLElement>("[contenteditable=true]") ??
            element
          ).focus();
        else if (
          parameters.action === "scroll" &&
          element.dataset.inknbScroll === "true"
        )
          element.scrollTo({ top: parameters.top ?? 0, behavior: "instant" });
        else if (
          parameters.action === "activate" &&
          element.tagName === "BUTTON"
        )
          element.click();
        else throw new Error("This action is unavailable for this control.");
        return { acted: true };
      });
      return {
        id: identity,
        label,
        role: element.tagName.toLowerCase(),
        disabled: element.matches(":disabled"),
        rectangle: element.getBoundingClientRect().toJSON(),
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
      };
    });
  const components = await Promise.all(
    [...componentRuntimes].map(async ([identity, runtime]) => {
      if (runtime.status !== "ready")
        return { id: identity, status: runtime.status, error: runtime.error };
      try {
        const result = z
          .object({
            snapshotId: z.string(),
            controls: z.array(z.object({ id: z.string() }).passthrough()),
            text: z.string(),
            title: z.string(),
          })
          .parse(await runtime.request("inspect", {}));
        for (const control of result.controls) {
          const componentTarget = control.id;
          const target = `component:${identity}:${componentTarget}`;
          inspectedTargets.set(target, async (parameters) =>
            runtime.request("action", {
              snapshotId: result.snapshotId,
              target: componentTarget,
              action: parameters.action,
              value: parameters.value,
            }),
          );
          control.id = target;
        }
        return { id: identity, status: runtime.status, ...result };
      } catch (error) {
        return { id: identity, status: "error", error: String(error) };
      }
    }),
  );
  targets.clear();
  for (const [identity, action] of inspectedTargets)
    targets.set(identity, action);
  snapshotId = inspectionId;
  return { snapshotId: inspectionId, controls, components };
}

export async function actOnInterface(parameters: unknown) {
  const parsed = actionSchema.parse(parameters);
  if (parsed.action === "setValue" && parsed.value === undefined)
    throw new Error("Supply a value for this component input.");
  if (parsed.snapshotId !== snapshotId)
    throw new Error("Inspect the interface again before acting.");
  const action = targets.get(parsed.target);
  if (!action) throw new Error("This control is unavailable to agents.");
  return action(parsed);
}
