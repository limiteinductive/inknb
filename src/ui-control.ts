import { documentScroll } from "./document-scroll";
import { z } from "zod";
import type { PointerEvent } from "react";
import { componentRuntimes } from "./component-bridge";

const actionSchema = z
  .object({
    documentId: z.string().uuid().nullable(),
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

interface PointerObservation {
  clientX: number;
  clientY: number;
  buttons: number;
  pointerType: string;
  defaultPrevented: boolean;
  timestamp: number;
}
interface ControlPointerTrace {
  down?: PointerObservation;
  move?: PointerObservation;
  up?: PointerObservation;
  cancel?: PointerObservation;
}
const pointerTraces = new WeakMap<HTMLElement, ControlPointerTrace>();

export function recordControlPointer(
  event: PointerEvent<HTMLDivElement>,
): void {
  const previous = pointerTraces.get(event.currentTarget);
  if (
    event.type === "pointermove" &&
    event.buttons === 0 &&
    (!previous?.down || previous.up || previous.cancel)
  )
    return;
  const observation: PointerObservation = {
    clientX: event.clientX,
    clientY: event.clientY,
    buttons: event.buttons,
    pointerType: event.pointerType,
    defaultPrevented: event.defaultPrevented,
    timestamp: event.timeStamp,
  };
  const trace = event.type === "pointerdown" ? {} : (previous ?? {});
  if (event.type === "pointerdown") trace.down = observation;
  if (event.type === "pointermove") trace.move = observation;
  if (event.type === "pointerup") trace.up = observation;
  if (event.type === "pointercancel") trace.cancel = observation;
  pointerTraces.set(event.currentTarget, trace);
}

function isVisible(element: Element | null): boolean {
  return (
    element !== null &&
    element.isConnected &&
    element.getClientRects().length > 0 &&
    getComputedStyle(element).visibility === "visible" &&
    !element.closest('[inert],[aria-hidden="true"]')
  );
}

export async function inspectInterface() {
  const inspectionId = crypto.randomUUID();
  const inspectedTargets: typeof targets = new Map();
  const controls = [
    ...document.querySelectorAll<HTMLElement>("[data-inknb-control]"),
  ]
    .filter(isVisible)
    .map((element) => {
      const identity = element.dataset.inknbControl!;
      const style = getComputedStyle(element);
      const label =
        element.getAttribute("aria-label") ??
        element.textContent?.trim() ??
        identity;
      inspectedTargets.set(identity, async (parameters) => {
        if (
          !isVisible(element) ||
          element.getAttribute("aria-disabled") === "true" ||
          element.matches(":disabled")
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
          documentScroll(element).scrollTo({
            top: parameters.top ?? 0,
            behavior: "instant",
          });
        else if (
          parameters.action === "activate" &&
          element.matches('button,[role="menuitem"],input[type="checkbox"]')
        )
          element.click();
        else throw new Error("This action is unavailable for this control.");
        return { acted: true };
      });
      return {
        id: identity,
        label,
        role: element.getAttribute("role") ?? element.tagName.toLowerCase(),
        ariaDisabled: element.getAttribute("aria-disabled"),
        ariaDisabledReflection: element.ariaDisabled,
        ariaDisabledReflectionType: typeof element.ariaDisabled,
        separatorState: element.dataset.separator,
        pointer: pointerTraces.get(element) ?? null,
        focusVisible:
          element.hasAttribute("data-focus-visible") ||
          element.matches(":focus-visible"),
        style: {
          pointerEvents: style.pointerEvents,
          userSelect: style.userSelect,
          outline: style.outline,
          outlineOffset: style.outlineOffset,
        },
        disabled: element.matches(":disabled"),
        rectangle: element.getBoundingClientRect().toJSON(),
        scrollTop:
          element.dataset.inknbScroll === "true"
            ? documentScroll(element).scrollTop
            : element.scrollTop,
        scrollHeight:
          element.dataset.inknbScroll === "true"
            ? documentScroll(element).scrollHeight
            : element.scrollHeight,
      };
    });
  const components = await Promise.all(
    [...componentRuntimes]
      .filter(([identity]) =>
        isVisible(
          document.querySelector(`[data-inknb-component="${identity}"]`),
        ),
      )
      .map(async ([identity, runtime]) => {
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
            inspectedTargets.set(target, async (parameters) => {
              if (
                !isVisible(
                  document.querySelector(
                    `[data-inknb-component="${identity}"]`,
                  ),
                )
              )
                throw new Error(
                  "This component changed. Inspect the interface again.",
                );
              return runtime.request("action", {
                snapshotId: result.snapshotId,
                target: componentTarget,
                action: parameters.action,
                value: parameters.value,
              });
            });
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
