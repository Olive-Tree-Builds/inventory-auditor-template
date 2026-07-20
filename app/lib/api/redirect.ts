export function safeSameOriginPath(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}
