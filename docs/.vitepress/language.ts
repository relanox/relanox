/** Runs in the page head as well as after client navigation; keep it self-contained. */
export function applyLanguagePreference(base: string): void {
  const { pathname, search, hash } = globalThis.location;
  const key = `relanox-docs-language:${base}`;
  const relative = pathname.startsWith(base) ? pathname.slice(base.length) : undefined;
  if (relative === undefined) {
    return;
  }
  const explicit = relative.split("/")[0];
  if (explicit === "en" || explicit === "zh-CN") {
    try {
      globalThis.localStorage.setItem(key, explicit);
    } catch {
      // Private or restricted storage must not prevent navigation.
    }
    return;
  }
  if (relative !== "" && relative !== "index.html") {
    return;
  }
  let saved: string | null = null;
  try {
    saved = globalThis.localStorage.getItem(key);
  } catch {
    // Language detection works without persistent storage.
  }
  const languages = navigator.languages.length > 0 ? navigator.languages : [navigator.language];

  const detected = languages.some((language) => language.toLowerCase() === "zh-cn")
    ? "zh-CN"
    : "en";

  const locale = saved === "en" || saved === "zh-CN" ? saved : detected;
  globalThis.location.replace(`${base}${locale}/${search}${hash}`);
}
