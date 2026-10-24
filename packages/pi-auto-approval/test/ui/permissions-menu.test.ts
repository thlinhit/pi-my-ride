import assert from "node:assert/strict";
import { test } from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { permissionsMenu } from "../../src/ui/permissions-menu.ts";

test("four rows render width safely and keyboard returns one action with retained index", () => {
  for (const [key, action] of [["\r", "activate"], ["\u0007", "save"], ["\u0012", "reset"], ["\u001b", "close"], ["\u0003", "close"]]) {
    const results: unknown[] = []; let redraws = 0; let prefix = "";
    const screen = permissionsMenu(["Permission: on", "Review mode: auto", `Reviewer model: ${"界".repeat(100)}`, "Debug: off"], 2)(
      { requestRender: () => { redraws++; } } as never,
      { fg: (_: string, text: string) => prefix + text } as never,
      new KeybindingsManager(TUI_KEYBINDINGS) as never, result => results.push(result),
    );
    const rendered = screen.render(100).join("\n");
    for (const hint of ["Ctrl+G", "Save globally", "Ctrl+R", "Reset session changes", "Up/Down", "Enter", "Escape/Ctrl+C"]) assert.ok(rendered.includes(hint));
    assert.equal(screen.render(100).filter(line => /^[> ] /.test(line)).length, 4);
    for (const width of [8, 24, 80]) for (const line of screen.render(width)) assert.ok(visibleWidth(line) <= width);
    prefix = "!"; screen.invalidate(); assert.ok(screen.render(80)[0].startsWith("!"));
    screen.handleInput!("x"); screen.handleInput!("\u001b[B"); screen.handleInput!("\u001b[B"); screen.handleInput!("\u001b[A");
    assert.equal(redraws, 3); screen.handleInput!(key); screen.handleInput!(key);
    assert.deepEqual(results, [{ action, index: 3 }]);
  }
});
