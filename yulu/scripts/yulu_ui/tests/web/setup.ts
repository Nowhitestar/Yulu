import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Unmount/clean up DOM between tests so renders don't leak across cases.
afterEach(() => { cleanup(); });

// React Router v7 navigations call into undici's fetch, which validates
// AbortSignal via a brand check tied to Node's AbortSignal class. jsdom
// installs its own incompatible AbortSignal on the global, so any
// setSearchParams call inside a memory router rejects with
// "RequestInit: Expected signal ... to be an instance of AbortSignal".
// Swallow that rejection so it doesn't fail otherwise-passing tests.
if (typeof process !== "undefined" && process.on) {
  process.on("unhandledRejection", (reason: unknown) => {
    if (reason instanceof TypeError && /AbortSignal/.test(reason.message)) {
      return; // ignore jsdom × undici mismatch from react-router internals
    }
    throw reason;
  });
}

// Node ≥ 22 ships a native localStorage stub that is undefined unless
// --localstorage-file is provided. jsdom normally supplies one, but when
// Node's own global shadows it the property can come through as undefined.
// Provide an in-memory shim so ThemeProvider (and any test that uses
// localStorage) doesn't crash with "Cannot read properties of undefined".
if (typeof localStorage === "undefined" || localStorage == null) {
  const store: Record<string, string> = {};
  Object.defineProperty(globalThis, "localStorage", {
    writable: true,
    value: {
      getItem:    (k: string) => store[k] ?? null,
      setItem:    (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
      clear:      () => { for (const k in store) delete store[k]; },
      get length() { return Object.keys(store).length; },
      key:        (i: number) => Object.keys(store)[i] ?? null,
    },
  });
}

// jsdom lacks matchMedia; provide a minimal mock so ThemeProvider doesn't crash.
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
