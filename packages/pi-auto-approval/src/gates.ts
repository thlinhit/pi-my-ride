import type { Rule } from "./config.ts";

/** First rule whose pattern matches the raw command text wins. undefined = no match. May throw only on programmer error; caller must treat a throw as fail-closed. */
export function matchRule(command: string, rules: readonly Rule[]): Rule | undefined {
  return rules.find((r) => r.pattern.test(command));
}

/** true only when rule.level === "guarded", rule.group is defined, and trusted.has(rule.group). Convention is never trusted. */
export function isTrusted(rule: Rule, trusted: ReadonlySet<string>): boolean {
  return rule.level === "guarded" && rule.group !== undefined && trusted.has(rule.group);
}
