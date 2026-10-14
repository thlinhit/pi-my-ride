import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { formatStatusLines, isTerminal } from "./status.ts";
import type { ReviewStatus } from "./status.ts";

export const VERIFIED_PI_VERSIONS: readonly string[] = ["1.2.0"];

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
interface RowStoreInternals {
  generation(): number;
  bind(toolCallId: string, generation: number, invalidator: () => void): void;
  status(toolCallId: string): ReviewStatus | undefined;
}

const internalsByStore = new WeakMap<RowStore, RowStoreInternals>();

export interface RowStore {
  set(status: ReviewStatus): void;
  isReady(toolCallId: string): boolean;
  dropInvalidator(toolCallId: string): void;
  clear(): void;
}

export function createRowStore(): RowStore {
  let generation = 0;
  const statuses = new Map<string, ReviewStatus>();
  const ready = new Set<string>();
  const invalidators = new Map<string, () => void>();
  const resetInvalidators = new Map<string, () => void>();

  const store: RowStore & RowStoreInternals = {
    set(status) {
      statuses.set(status.toolCallId, status);
      const invalidator = invalidators.get(status.toolCallId);
      try { invalidator?.(); } catch {}
    },
    isReady(toolCallId) { return ready.has(toolCallId); },
    status(toolCallId) { return statuses.get(toolCallId); },
    dropInvalidator(toolCallId) {
      const invalidator = invalidators.get(toolCallId);
      if (invalidator) resetInvalidators.set(toolCallId, invalidator);
      invalidators.delete(toolCallId);
    },
    clear() {
      const live = [...invalidators.values(), ...resetInvalidators.values()];
      generation += 1;
      statuses.clear();
      ready.clear();
      invalidators.clear();
      resetInvalidators.clear();
      for (const invalidate of live) {
        try { invalidate(); } catch {}
      }
    },
    generation() { return generation; },
    bind(toolCallId, wrapperGeneration, invalidator) {
      if (wrapperGeneration !== generation) return;
      ready.add(toolCallId);
      const status = statuses.get(toolCallId);
      if (!status || !isTerminal(status.state)) invalidators.set(toolCallId, invalidator);
    },
  };
  internalsByStore.set(store, store);
  return store;
}

export function wrapNativeCall(native: RenderCall, store: RowStore): RenderCall {
  const internals = internalsByStore.get(store);
  if (!internals) throw new Error("unknown row store");
  let wrapperGeneration: number | undefined;
  const previousNative = new Map<string, Component>();

  return (args, theme, context) => {
    const nativeContext = { ...context, lastComponent: previousNative.get(context.toolCallId) };
    const nativeComponent = native(args, theme, nativeContext);
    previousNative.set(context.toolCallId, nativeComponent as Component);
    if (wrapperGeneration === undefined) wrapperGeneration = internals.generation();
    internals.bind(context.toolCallId, wrapperGeneration, context.invalidate);
    const status = wrapperGeneration === internals.generation() ? getStatus(store, context.toolCallId) : undefined;
    if (!status) return nativeComponent;
    const container = new Container();
    container.addChild(nativeComponent as Component);
    container.addChild(new Text(formatStatusLines(status).join("\n")));
    return container;
  };
}

export const wrapNative = wrapNativeCall;

function getStatus(store: RowStore, toolCallId: string): ReviewStatus | undefined {
  return internalsByStore.get(store)?.status(toolCallId);
}
