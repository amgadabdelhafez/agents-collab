import { describe, expect, test } from "bun:test";

import {
  APPEARANCE_STORAGE_KEY,
  applyAppearance,
  parseAppearanceMode,
  persistAppearanceMode,
  readAppearanceMode,
  resolveAppearance,
  subscribeToSystemAppearance,
} from "../../src/webui/theme";

describe("Web UI appearance mode", () => {
  test("parses only exact supported modes", () => {
    expect(parseAppearanceMode("system")).toBe("system");
    expect(parseAppearanceMode("light")).toBe("light");
    expect(parseAppearanceMode("dark")).toBe("dark");
    expect(parseAppearanceMode("System")).toBeUndefined();
    expect(parseAppearanceMode(["dark"])).toBeUndefined();
    expect(parseAppearanceMode(null)).toBeUndefined();
  });

  test("defaults invalid, missing, and inaccessible storage to system", () => {
    expect(readAppearanceMode(undefined)).toBe("system");
    expect(
      readAppearanceMode({
        getItem: () => "contrast",
        setItem: () => undefined,
      })
    ).toBe("system");
    expect(
      readAppearanceMode({
        getItem: () => {
          throw new Error("storage unavailable");
        },
        setItem: () => undefined,
      })
    ).toBe("system");
  });

  test("persists only the selected appearance mode and tolerates failure", () => {
    const writes: [string, string][] = [];
    persistAppearanceMode(
      {
        getItem: () => null,
        setItem: (key, value) => writes.push([key, value]),
      },
      "light"
    );
    expect(writes).toEqual([[APPEARANCE_STORAGE_KEY, "light"]]);
    expect(() =>
      persistAppearanceMode(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("storage unavailable");
          },
        },
        "dark"
      )
    ).not.toThrow();
  });

  test("resolves explicit modes and follows the system preference", () => {
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("system", false)).toBe("light");
  });

  test("applies selected and resolved themes to document chrome", () => {
    const dataset: Record<string, string> = {};
    const style = { colorScheme: "" };
    const metaAttributes = new Map<string, string>();
    const theme = applyAppearance(
      {
        documentElement: { dataset, style },
        querySelector: () => ({
          setAttribute: (name, value) => metaAttributes.set(name, value),
        }),
      },
      "system",
      true
    );

    expect(theme).toBe("dark");
    expect(dataset).toEqual({ appearance: "system", theme: "dark" });
    expect(style.colorScheme).toBe("dark");
    expect(metaAttributes.get("content")).toBe("#111410");
  });

  test("subscribes to live system changes and removes the listener", () => {
    let listener: ((event: { readonly matches: boolean }) => void) | undefined;
    let removed: unknown;
    const preferences: boolean[] = [];
    const unsubscribe = subscribeToSystemAppearance(
      {
        addEventListener: (_type, nextListener) => {
          listener = nextListener;
        },
        matches: false,
        removeEventListener: (_type, nextListener) => {
          removed = nextListener;
        },
      },
      (prefersDark) => preferences.push(prefersDark)
    );

    listener?.({ matches: true });
    expect(preferences).toEqual([true]);
    unsubscribe();
    expect(removed).toBe(listener);
  });
});
