import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";

import type { GestureUpdate } from "../ipc/types";
import { uiConfig } from "../uiConfig";
import {
  Arming,
  Attract,
  Countdown,
  Flash,
  PalmHighlight,
  SessionError,
  StripReview,
} from "./BoothViews";

const original = uiConfig.fillMs;
beforeEach(() => {
  uiConfig.fillMs = 10;
});
afterEach(() => {
  uiConfig.fillMs = original;
});

const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

describe("Attract", () => {
  test("shows the original copy, the shot count and starts after the pill fills", async () => {
    let started = 0;
    const { container } = render(<Attract totalShots={4} onStart={() => (started += 1)} />);

    expect(screen.queryByText("KNOCKBOX · PHOTOBOOTH")).toBeNull(); // no brand line
    expect(screen.getByRole("heading").textContent).toBe("Welcome to the booth");
    expect(screen.getByText("4 SHOTS")).toBeTruthy();
    expect(container.querySelectorAll(".pips__pip")).toHaveLength(4);

    fireEvent.click(screen.getByRole("button", { name: "Tap to start photoshoot" }));
    expect(started).toBe(0);
    await sleep(40);
    expect(started).toBe(1);
  });
});

describe("Attract with a palm box", () => {
  const guide = (update: GestureUpdate | null) => ({
    update,
    boxRef: createRef<HTMLDivElement>(),
  });
  const palm = { x: 0.1, y: 0.1, w: 0.2, h: 0.3 };

  test("asks for a palm in the box and keeps a small tap button as the fallback", async () => {
    let started = 0;
    const { container } = render(
      <Attract totalShots={3} onStart={() => (started += 1)} palm={guide(null)} />,
    );

    expect(screen.getByRole("heading").textContent).toBe(
      "Put your palm in the box to start the photobooth",
    );
    expect(screen.getByRole("img", { name: /palm up inside this box/ })).toBeTruthy();
    expect(container.querySelector(".palmbox")?.className).toBe("palmbox");
    expect(screen.queryByText("Tap to start photoshoot")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Tap here to start" }));
    await sleep(40);
    expect(started).toBe(1);
  });

  test("the box turns green when a palm is seen and the ring runs while it is held", () => {
    const { container, rerender } = render(
      <Attract
        totalShots={3}
        onStart={() => {}}
        palm={guide({ palm, holding: false, hold_ms: 1000 })}
      />,
    );
    const box = () => container.querySelector(".palmbox") as HTMLElement;
    expect(box().classList.contains("is-seen")).toBe(true);
    expect(box().classList.contains("is-holding")).toBe(false);
    expect(screen.queryByText("GOT IT")).toBeNull(); // no status text pretending to be a button

    rerender(
      <Attract
        totalShots={3}
        onStart={() => {}}
        palm={guide({ palm, holding: true, hold_ms: 1500 })}
      />,
    );
    expect(box().classList.contains("is-holding")).toBe(true);
    expect(box().style.getPropertyValue("--hold-ms")).toBe("1500ms");

    rerender(
      <Attract
        totalShots={3}
        onStart={() => {}}
        palm={guide({ palm: null, holding: false, hold_ms: 1000 })}
      />,
    );
    expect(box().className).toBe("palmbox");
  });

  test("the highlight is a dot at the centre of the palm, not a ring or a box", () => {
    const { container } = render(<PalmHighlight rect={{ x: 0.2, y: 0.4, w: 0.1, h: 0.2 }} />);
    const el = container.querySelector(".palm-highlight") as HTMLElement;
    expect(el.style.left).toBe("25%");
    expect(el.style.top).toBe("50%");
    expect(el.style.width).toBe(""); // a fixed small size from the stylesheet, whatever the hand's
  });

  test("the box carries no text label", () => {
    const { container } = render(<Attract totalShots={3} onStart={() => {}} palm={guide(null)} />);
    expect(container.querySelector(".palmbox")?.textContent).toBe("");
  });
});

describe("Arming", () => {
  test("tells the guest the camera is being prepared", () => {
    render(<Arming />);
    expect(screen.getByRole("status").textContent).toContain("GETTING THE CAMERA READY");
  });
});

describe("Countdown", () => {
  test("shows the prompt, the numeral and where in the strip we are", () => {
    const { container } = render(<Countdown shot={2} total={3} remaining={2} />);
    expect(screen.getByText("Look at the lens")).toBeTruthy();
    expect(screen.getByLabelText("Photo 2 of 3, 2").textContent).toBe("2");
    const pips = [...container.querySelectorAll(".pips__pip")].map((p) => p.className);
    expect(pips[0]).toContain("done");
    expect(pips[1]).toContain("current");
    expect(pips[2]).toContain("todo");
  });

  test("a zero count shows a dot instead of the number", () => {
    render(<Countdown shot={1} total={3} remaining={0} />);
    expect(screen.getByLabelText("Photo 1 of 3, 0").textContent).toBe("·");
  });

  test("each tick is a new element so the pop animation restarts", () => {
    const { rerender } = render(<Countdown shot={1} total={3} remaining={3} />);
    const first = screen.getByLabelText("Photo 1 of 3, 3");
    rerender(<Countdown shot={1} total={3} remaining={2} />);
    expect(screen.queryByLabelText("Photo 1 of 3, 3")).toBeNull();
    expect(screen.getByLabelText("Photo 1 of 3, 2")).not.toBe(first);
  });
});

describe("Flash", () => {
  test("is solid white while capturing and fades during the flash", () => {
    const { rerender, container } = render(<Flash fading={false} />);
    expect(screen.getByLabelText("Capturing")).toBeTruthy();
    expect(container.querySelector(".is-fading")).toBeNull();
    rerender(<Flash fading />);
    expect(screen.getByLabelText("Flash")).toBeTruthy();
    expect(container.querySelector(".is-fading")).not.toBeNull();
  });
});

describe("StripReview", () => {
  const renderReview = (over: Partial<Parameters<typeof StripReview>[0]> = {}) => {
    let again = 0;
    render(
      <StripReview
        sessionId="s-9"
        photos={[1, 2, 3]}
        autoReturnIn={9}
        autoReturnTotal={12}
        headline="Ada & Bo"
        date="01.02.2027"
        onTakeAnother={() => (again += 1)}
        {...over}
      />,
    );
    return () => again;
  };

  test("shows the saved notice, the strip and the countdown to returning home", () => {
    renderReview();
    expect(
      screen.getByText("VIRTUAL PHOTO STRIP SAVED — COPIES WILL BE AVAILABLE AFTER THE EVENT"),
    ).toBeTruthy();
    expect(screen.getByText("Looking good.")).toBeTruthy();
    expect(screen.getByText("RETURNING TO PHOTOBOOTH")).toBeTruthy();
    expect(screen.getByText("9s")).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(3);
    expect(screen.getByText("ADA & BO")).toBeTruthy();
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("9");
    expect(bar.getAttribute("aria-valuemax")).toBe("12");
    expect((bar.firstElementChild as HTMLElement).style.width).toBe("75%");
  });

  test("the progress bar is clamped to 0–100%", () => {
    renderReview({ autoReturnIn: 99, autoReturnTotal: 12 });
    expect((screen.getByRole("progressbar").firstElementChild as HTMLElement).style.width).toBe(
      "100%",
    );
  });

  test("'Take another strip →' fires after the pill fills", async () => {
    const again = renderReview();
    fireEvent.click(screen.getByRole("button", { name: "Take another strip →" }));
    expect(again()).toBe(0);
    await sleep(40);
    expect(again()).toBe(1);
  });
});

describe("SessionError", () => {
  test("a recoverable error offers to try again as well as to go home", () => {
    let retried = 0;
    let home = 0;
    render(
      <SessionError
        message="capture failed: lens cap on?"
        recoverable
        onRetry={() => (retried += 1)}
        onHome={() => (home += 1)}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("capture failed: lens cap on?");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Back to start" }));
    expect([retried, home]).toEqual([1, 1]);
  });

  test("an unrecoverable error only offers to go home", () => {
    render(
      <SessionError
        message="No camera is selected"
        recoverable={false}
        onRetry={() => undefined}
        onHome={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.getByRole("button", { name: "Back to start" })).toBeTruthy();
  });
});
