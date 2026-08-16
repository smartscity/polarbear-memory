const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu, "<redacted-private-key>"],
  [/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/gu, "<redacted-github-token>"],
  [/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/gu, "<redacted-slack-token>"],
  [/\bnpm_[A-Za-z0-9]{24,}\b/gu, "<redacted-npm-token>"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "<redacted-aws-access-key>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "<redacted-jwt>"],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/gu, "<redacted-api-key>"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu, "Bearer <redacted>"],
  [/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["'][^"'\r\n]{1,4096}["']/giu, "$1=<redacted>"],
  [/(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?[^\s,"']{6,}/giu, "$1=<redacted>"],
  [/(https?:\/\/[^:/\s]+:)[^@/\s]+(@)/giu, "$1<redacted>$2"],
];

export function redactText(input: string, homePath?: string): string {
  let output = input.replaceAll("\0", "").normalize("NFKC");
  if (homePath) output = output.replaceAll(homePath, "<home>");
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}
