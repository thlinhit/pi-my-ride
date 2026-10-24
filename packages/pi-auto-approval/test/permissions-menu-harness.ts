import assert from "node:assert/strict";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

type Screen = { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void };
export function menuDriver() {
  const screens: Screen[] = [];
  let mounted: Screen | undefined;
  const custom: ExtensionUIContext["custom"] = factory => new Promise(resolve => {
    const screen = factory({ requestRender() {} } as never, { fg: (_: string, text: string) => text } as never, new KeybindingsManager(TUI_KEYBINDINGS) as never, result => { mounted = undefined; resolve(result); });
    assert.ok(!(screen instanceof Promise));
    mounted = screen; screens.push(screen);
  });
  return {
    custom, screens,
    async next(index: number) {
      for (let tick = 0; tick < 100 && screens.length <= index; tick++) await Promise.resolve();
      const screen = screens[index]; assert.ok(screen, `screen ${index} opened`); return screen;
    },
    key(data: string) { assert.ok(mounted, "custom screen mounted"); mounted.handleInput!(data); },
    row(index: number) {
      assert.ok(mounted);
      const current = mounted.render(200).findIndex(line => line.startsWith("> ")) - 1;
      for (let i = 0; i < (index - current + 4) % 4; i++) mounted.handleInput!("\u001b[B");
      mounted.handleInput!("\r");
    },
    get mounted() { return mounted; },
  };
}
export async function menuAction(driver: ReturnType<typeof menuDriver>, start: () => Promise<unknown>, action: string | undefined) {
  let count = driver.screens.length;
  const pending = start();
  const screen = await driver.next(count++);
  if (action === "Save settings") driver.key("\u0007");
  else if (action === "Clear session choices / reload") driver.key("\u0012");
  else if (action?.startsWith("Debug:")) driver.row(3);
  else if (action?.startsWith("Protection")) {
    if (!screen.render(200).join("\n").includes(`Permission: ${action.endsWith("on") ? "on" : "off"}`)) driver.row(0);
    else { driver.key("\u001b"); return pending; }
  } else if (action === "Auto review" || action === "Manual review") {
    if (!screen.render(200).join("\n").includes(`Review mode: ${action === "Auto review" ? "auto" : "manual"}`)) driver.row(1);
    else { driver.key("\u001b"); return pending; }
  } else { driver.key("\u001b"); return pending; }
  await driver.next(count); driver.key("\u001b"); return pending;
}
