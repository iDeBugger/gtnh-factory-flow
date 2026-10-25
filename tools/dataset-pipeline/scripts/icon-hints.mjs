/**
 * The export leaves `asset:<mod>:textures/...` hints in `iconPath` where it
 * knew the texture's name but drew no pixels. apply-texture-icons.mjs
 * resolves the hints it can find in the mod jars; the rest must not be
 * published: a browser cannot load `asset:` and the app would show a broken
 * picture instead of the kind's fallback art. Every resource object is
 * cleared here, slot copies included (the matching runs once per key, so a
 * clear there reaches one object per key only), and a hint never blocks the
 * icon the key resolved to.
 */
const ASSET_HINT_PREFIX = "asset:";

export function resourceKey(resource) {
  return `${resource.kind}:${resource.id}`;
}

export function clearUnresolvedIconPathTextureHint(resource) {
  if (typeof resource.iconPath === "string" && resource.iconPath.startsWith(ASSET_HINT_PREFIX)) {
    delete resource.iconPath;
  }
}

/** Gives `resource` the icon its key resolved to, unless it already has a real one. */
export function applyIcon(resource, iconsByKey) {
  clearUnresolvedIconPathTextureHint(resource);
  if (resource.iconPath) {
    return;
  }
  const iconPath = iconsByKey.get(resourceKey(resource));
  if (iconPath) {
    resource.iconPath = iconPath;
  }
}
