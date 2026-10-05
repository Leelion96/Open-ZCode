import { PRODUCT_DEFAULT_PROJECT_DIRECTORY } from "@zcode/shared/product";
export function getScratchWorkspaceLocationHint(name: string) {
  return `~/${PRODUCT_DEFAULT_PROJECT_DIRECTORY}/${name.trim()}`;
}

export function getScratchWorkspaceNameErrorKind(name: string) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return "required";
  }

  if (/[\\/]/.test(trimmedName)) {
    return "separator";
  }

  return null;
}
