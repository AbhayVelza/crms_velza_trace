"use client";

// Tiny event bus so header widgets (device bar) refresh after a page changes data.

const EVENT = "velza:data-changed";

export function notifyDataChanged() {
  window.dispatchEvent(new Event(EVENT));
}

export function onDataChanged(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
