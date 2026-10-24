import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type MenuResult = { action: "activate" | "save" | "reset" | "close"; index: number };
type Factory = Parameters<ExtensionUIContext["custom"]>[0];
export function permissionsMenu(labels: readonly string[], initialIndex: number, error?: string) {
  return (tui: Parameters<Factory>[0], theme: Parameters<Factory>[1], keybindings: Parameters<Factory>[2], done: (result: MenuResult) => void) => {
    let index = initialIndex;
    let finished = false;
    const finish = (action: MenuResult["action"]) => { if (!finished) { finished = true; done({ action, index }); } };
    return {
      render(width: number): string[] {
        const lines = [theme.fg("accent", "Permissions"), ...labels.map((label, row) => theme.fg(row === index ? "accent" : "text", `${row === index ? ">" : " "} ${label}`))];
        if (error) lines.push(theme.fg("error", error));
        lines.push(...wrapTextWithAnsi(theme.fg("dim", "Up/Down · Enter · Escape/Ctrl+C\nCtrl+G — Save globally\nCtrl+R — Reset session changes"), Math.max(1, width)));
        return lines.map(line => truncateToWidth(line, Math.max(0, width)));
      },
      invalidate() {},
      handleInput(data: string) {
        if (finished) return;
        if (matchesKey(data, Key.ctrl("g"))) finish("save");
        else if (matchesKey(data, Key.ctrl("r"))) finish("reset");
        else if (matchesKey(data, Key.ctrl("c")) || keybindings.matches(data, "tui.select.cancel")) finish("close");
        else if (keybindings.matches(data, "tui.select.confirm")) finish("activate");
        else if (keybindings.matches(data, "tui.select.up")) { index = (index + 3) % 4; tui.requestRender(); }
        else if (keybindings.matches(data, "tui.select.down")) { index = (index + 1) % 4; tui.requestRender(); }
      },
    };
  };
}
