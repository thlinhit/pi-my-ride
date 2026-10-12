import type { Rule } from "./config.ts";

export function matchRule(command: string, rules: readonly Rule[], projectTrusted: boolean): Rule | undefined {
  const matches = rules.filter((rule) => !(rule.scope === "project" && rule.level === "allow" && !projectTrusted) && rule.pattern.test(command));
  for (const level of ["deny", "ask", "allow"] as const) {
    const match = matches.find((rule) => rule.level === level && rule.scope === "global");
    if (match) return match;
    const projectMatch = matches.find((rule) => rule.level === level && rule.scope === "project");
    if (projectMatch) return projectMatch;
  }
  return undefined;
}

export function isSuspiciousAllow(command: string): boolean {
  return /[;|&\r\n`]|\$\(|[<>]\(/.test(command);
}
