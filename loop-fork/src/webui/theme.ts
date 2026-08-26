import { useEffect, useState } from "react";

export const APPEARANCE_STORAGE_KEY = "loop.webui.appearance";
export const SYSTEM_APPEARANCE_QUERY = "(prefers-color-scheme: dark)";

const THEME_COLORS = {
  dark: "#111410",
  light: "#f4f7ef",
} as const;

export type AppearanceMode = "system" | "light" | "dark";
export type ResolvedAppearance = "light" | "dark";

export interface AppearanceStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export interface AppearanceMediaQuery {
  readonly addEventListener: (
    type: "change",
    listener: (event: { readonly matches: boolean }) => void
  ) => void;
  readonly matches: boolean;
  readonly removeEventListener: (
    type: "change",
    listener: (event: { readonly matches: boolean }) => void
  ) => void;
}

interface AppearanceDocument {
  readonly documentElement: {
    readonly dataset: Record<string, string | undefined>;
    readonly style: { colorScheme: string };
  };
  readonly querySelector: (
    selector: string
  ) => { readonly setAttribute: (name: string, value: string) => void } | null;
}

export const parseAppearanceMode = (
  value: unknown
): AppearanceMode | undefined => {
  if (value === "system" || value === "light" || value === "dark") {
    return value;
  }
  return undefined;
};

export const readAppearanceMode = (
  storage: AppearanceStorage | undefined
): AppearanceMode => {
  try {
    return (
      parseAppearanceMode(storage?.getItem(APPEARANCE_STORAGE_KEY)) ?? "system"
    );
  } catch {
    return "system";
  }
};

export const persistAppearanceMode = (
  storage: AppearanceStorage | undefined,
  mode: AppearanceMode
): void => {
  try {
    storage?.setItem(APPEARANCE_STORAGE_KEY, mode);
  } catch {
    // Appearance remains session-local when browser storage is unavailable.
  }
};

export const resolveAppearance = (
  mode: AppearanceMode,
  prefersDark: boolean
): ResolvedAppearance => {
  if (mode === "system") {
    return prefersDark ? "dark" : "light";
  }
  return mode;
};

export const applyAppearance = (
  target: AppearanceDocument,
  mode: AppearanceMode,
  prefersDark: boolean
): ResolvedAppearance => {
  const resolved = resolveAppearance(mode, prefersDark);
  target.documentElement.dataset.appearance = mode;
  target.documentElement.dataset.theme = resolved;
  target.documentElement.style.colorScheme = resolved;
  target
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[resolved]);
  return resolved;
};

export const subscribeToSystemAppearance = (
  mediaQuery: AppearanceMediaQuery,
  onChange: (prefersDark: boolean) => void
): (() => void) => {
  const listener = (event: { readonly matches: boolean }) => {
    onChange(event.matches);
  };
  mediaQuery.addEventListener("change", listener);
  return () => mediaQuery.removeEventListener("change", listener);
};

const browserStorage = (): AppearanceStorage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

const browserPrefersDark = (): boolean =>
  window.matchMedia(SYSTEM_APPEARANCE_QUERY).matches;

export const initializeBrowserAppearance = (): AppearanceMode => {
  const mode = readAppearanceMode(browserStorage());
  applyAppearance(document, mode, browserPrefersDark());
  return mode;
};

interface AppearanceState {
  readonly mode: AppearanceMode;
  readonly resolved: ResolvedAppearance;
  readonly setMode: (mode: AppearanceMode) => void;
}

export function useAppearanceMode(): AppearanceState {
  const [mode, setMode] = useState<AppearanceMode>(() =>
    readAppearanceMode(browserStorage())
  );
  const [prefersDark, setPrefersDark] = useState(browserPrefersDark);

  useEffect(() => {
    const mediaQuery = window.matchMedia(SYSTEM_APPEARANCE_QUERY);
    setPrefersDark(mediaQuery.matches);
    return subscribeToSystemAppearance(mediaQuery, setPrefersDark);
  }, []);

  useEffect(() => {
    persistAppearanceMode(browserStorage(), mode);
    applyAppearance(document, mode, prefersDark);
  }, [mode, prefersDark]);

  return {
    mode,
    resolved: resolveAppearance(mode, prefersDark),
    setMode,
  };
}
