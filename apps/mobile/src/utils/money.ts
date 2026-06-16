/**
 * Format an integer cent amount as a dollar string.
 * Example: formatCents(350) → "3.50"
 */
export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}
