import { describe, expect, it } from "vitest";
import { STORAGE_SCHEMA_VERSION, readStoredJson, writeStoredJson } from "../storage.js";
import { storedTheme, nextTheme, effectiveTheme } from "../theme.js";

function memoryStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => delete store[k],
  };
}

describe("storage versionne", () => {
  it("write ajoute la version, read la restitue", () => {
    const storage = memoryStorage();
    writeStoredJson(storage, "k", { a: 1 });
    expect(readStoredJson(storage, "k")).toEqual({ v: 1, a: 1 });
  });

  it("payload sans version (ancien format) -> null, jamais injecte dans l'UI", () => {
    const storage = memoryStorage({ k: JSON.stringify({ a: 1 }) });
    expect(readStoredJson(storage, "k")).toBeNull();
  });

  it("payload d'une version inconnue -> null", () => {
    const storage = memoryStorage({ k: JSON.stringify({ v: 99, a: 1 }) });
    expect(readStoredJson(storage, "k")).toBeNull();
  });

  it("JSON illisible -> null sans lever", () => {
    const storage = memoryStorage({ k: "{pas du json" });
    expect(readStoredJson(storage, "k")).toBeNull();
  });

  it("cle absente -> null", () => {
    expect(readStoredJson(memoryStorage(), "k")).toBeNull();
  });

  it("la version courante est 1", () => {
    expect(STORAGE_SCHEMA_VERSION).toBe(1);
  });
});

describe("theme", () => {
  it("storedTheme : 'dark'/'light' valides, tout le reste -> null (suit le systeme)", () => {
    expect(storedTheme("dark")).toBe("dark");
    expect(storedTheme("light")).toBe("light");
    expect(storedTheme("blue")).toBeNull();
    expect(storedTheme(null)).toBeNull();
  });

  it("nextTheme bascule l'inverse du courant", () => {
    expect(nextTheme("dark")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
  });

  it("effectiveTheme : data-theme prioritaire, sinon prefers-color-scheme", () => {
    expect(effectiveTheme("dark", false)).toBe("dark");
    expect(effectiveTheme("light", true)).toBe("light");
    expect(effectiveTheme(undefined, true)).toBe("dark");
    expect(effectiveTheme(undefined, false)).toBe("light");
  });
});
