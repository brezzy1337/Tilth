/** Capitalise the first character of a string, leaving the rest unchanged. */
export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
