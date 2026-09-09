/** Restrict authentication redirects to paths on this deployment. */
export function safeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\r\n\t]/.test(value)) return "/";
  return value;
}
