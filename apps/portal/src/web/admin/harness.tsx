// DOM helpers for the view tests (bun test + happy-dom). Not imported by the app.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import type { AdminEnv } from "./env";
import { flush, setUrl } from "./testing";

let root: Root | null = null;

export async function mountApp(env: AdminEnv, path: string): Promise<void> {
  setUrl(path);
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root!.render(<App env={env} />);
    await flush();
  });
}

export async function unmountApp(): Promise<void> {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
}

/** Runs `fn` inside act() and lets pending promises settle. */
export async function settle(fn: () => void | Promise<void> = () => {}): Promise<void> {
  await act(async () => {
    await fn();
    await flush();
  });
}

export function text(): string {
  return document.body.textContent ?? "";
}

export function button(name: string | RegExp, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((b) => (typeof name === "string" ? b.textContent?.trim() === name : name.test(b.textContent ?? "")));
  if (!found) throw new Error(`No button "${name}". Buttons: ${[...within.querySelectorAll("button")].map((b) => b.textContent?.trim()).join(" | ")}`);
  return found as HTMLButtonElement;
}

export function maybeButton(name: string | RegExp, within: ParentNode = document): HTMLButtonElement | null {
  try {
    return button(name, within);
  } catch {
    return null;
  }
}

export const click = (el: Element) => settle(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));

/** Sets a controlled input the way a user typing does, so React sees the change. */
export async function type(el: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await settle(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

export function input(id: string): HTMLInputElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`No #${id}`);
  return el as HTMLInputElement;
}

export const submit = (form: HTMLFormElement) =>
  settle(() => void form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));

export const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
