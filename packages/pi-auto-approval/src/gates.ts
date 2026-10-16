export function isSuspiciousAllow(command: string): boolean {
  return /[;|&\r\n`]|\$\(|[<>]\(/.test(command);
}
