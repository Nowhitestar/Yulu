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
