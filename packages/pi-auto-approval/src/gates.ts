import type { Rule } from "./config.ts";

/** First rule whose pattern matches the raw command text wins. undefined = no match. May throw only on programmer error; caller must treat a throw as fail-closed. */
export function matchRule(command: string, rules: readonly Rule[]): Rule | undefined {
  return rules.find((r) => r.pattern.test(command));
}
