import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { photoUrl, resetPhotoPrefetcher, setPhotoPrefetcher } from "../ipc/photo";
import { uiConfig } from "../uiConfig";
import { FillButton } from "./FillButton";
import { PhotoStrip } from "./PhotoStrip";
import { ShotPips } from "./ShotPips";

const original = uiConfig.fillMs;
beforeEach(() => {
  uiConfig.fillMs = 20;
});
afterEach(() => {
  uiConfig.fillMs = original;
});

const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

describe("FillButton", () => {
  test("fires only after the fill completes, and only once", async () => {
    let fired = 0;
    render(<FillButton label="Go" fillMs={30} onFire={() => (fired += 1)} />);
    const button = screen.getByRole("button", { name: "Go" });

    fireEvent.click(button);
    expect(fired).toBe(0);
    expect(button.className).toContain("is-filling");
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(button); // ignored while filling
    await sleep(60);
    expect(fired).toBe(1);
  });

  test("unmounting mid-fill cancels the action", async () => {
    let fired = 0;
    const { unmount } = render(<FillButton label="Go" fillMs={30} onFire={() => (fired += 1)} />);
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    unmount();
    await sleep(60);
    expect(fired).toBe(0);
  });

  test("while disabled it ignores taps and never fires; enabling it makes it usable again", async () => {
    let fired = 0;
    const { rerender } = render(
      <FillButton label="Go" fillMs={10} disabled onFire={() => (fired += 1)} />,
    );
    const button = screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await sleep(40);
    expect(fired).toBe(0);
    expect(button.className).not.toContain("is-filling");

    rerender(<FillButton label="Go" fillMs={10} onFire={() => (fired += 1)} />);
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await sleep(40);
    expect(fired).toBe(1);
  });

  test("exposes the fill duration to CSS", () => {
    render(<FillButton label="Go" fillMs={1234} onFire={() => undefined} />);
    expect(screen.getByRole("button", { name: "Go" }).style.getPropertyValue("--fill-ms")).toBe(
      "1234ms",
    );
  });
});

describe("ShotPips", () => {
  test("marks shots before the current one as done", () => {
    const { container } = render(<ShotPips total={4} current={3} variant="countdown" />);
    const states = [...container.querySelectorAll(".pips__pip")].map((p) =>
      p.className.replace("pips__pip pips__pip--", ""),
    );
    expect(states).toEqual(["done", "done", "current", "todo"]);
  });

  test("attract mode shows every pip as not yet started", () => {
    const { container } = render(<ShotPips total={3} current={0} variant="attract" />);
    expect(container.querySelectorAll(".pips__pip--todo")).toHaveLength(3);
  });
});

describe("PhotoStrip", () => {
  test("renders one image per photo with the headline uppercased", () => {
    render(
      <PhotoStrip sessionId="s-1" photos={[1, 2, 3]} headline="Ada & Bo" date="01.02.2027" />,
    );
    const images = screen.getAllByRole("img");
    expect(images).toHaveLength(3);
    expect(images.map((i) => i.getAttribute("alt"))).toEqual(["Photo 1", "Photo 2", "Photo 3"]);
    expect(images[0]?.getAttribute("src")).toMatch(/photo\/s-1\/1$/);
    expect(screen.getByText("ADA & BO")).toBeTruthy();
    expect(screen.getByText("01.02.2027")).toBeTruthy();
  });

  test("shows the small copy the prefetcher has ready, and swaps to it when it arrives", () => {
    const ready = new Map<string, string>([["s-1/1", "blob:small-1"]]);
    const listeners = new Set<() => void>();
    setPhotoPrefetcher({
      prefetch: () => Promise.resolve(),
      urlFor: (sessionId, shot) => ready.get(`${sessionId}/${shot}`) ?? photoUrl(sessionId, shot),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      clear: () => undefined,
      size: 0,
    });
    try {
      render(<PhotoStrip sessionId="s-1" photos={[1, 2]} headline="h" date="d" />);
      expect(screen.getByAltText("Photo 1").getAttribute("src")).toBe("blob:small-1");
      expect(screen.getByAltText("Photo 2").getAttribute("src")).toMatch(/photo\/s-1\/2$/);

      ready.set("s-1/2", "blob:small-2");
      act(() => listeners.forEach((l) => l()));
      expect(screen.getByAltText("Photo 2").getAttribute("src")).toBe("blob:small-2");
    } finally {
      resetPhotoPrefetcher();
    }
  });

  test("a photo that fails to load is replaced by a labelled placeholder", () => {
    render(<PhotoStrip sessionId="s-1" photos={[1, 2]} headline="h" date="d" />);
    fireEvent.error(screen.getByAltText("Photo 2"));
    expect(screen.getByRole("img", { name: "Photo 2 unavailable" })).toBeTruthy();
    expect(screen.getByAltText("Photo 1")).toBeTruthy();
  });

  test("an explicit scale is passed to CSS; omitted lets the stylesheet decide", () => {
    const { rerender } = render(
      <PhotoStrip sessionId="s" photos={[1]} headline="h" date="d" scale={1.45} />,
    );
    expect(screen.getByTestId("photo-strip").style.getPropertyValue("--scale")).toBe("1.45");
    rerender(<PhotoStrip sessionId="s" photos={[1]} headline="h" date="d" />);
    expect(screen.getByTestId("photo-strip").style.getPropertyValue("--scale")).toBe("");
  });
});
