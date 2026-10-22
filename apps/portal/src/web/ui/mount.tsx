import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";

/** Mounts a SPA's root component into the page's #root element. */
export function mount(App: ComponentType): void {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing #root element");
  createRoot(element).render(<App />);
}
