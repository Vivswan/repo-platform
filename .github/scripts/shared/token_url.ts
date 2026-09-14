/** The one URL a sync row authenticates with: the clone (stripped from the remote afterwards), the branch probe, and the push. */
export function tokenUrl(target: string, pat: string): string {
  return `https://x-access-token:${pat}@github.com/${target}.git`;
}
