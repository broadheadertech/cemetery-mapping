/**
 * The screen a field worker holds at the graveside.
 *
 * A phone reports 3–10m under open sky. A grave is 2.5m wide. So the
 * job of this screen is not to obtain a coordinate — that part is one
 * browser call — it is to stop a coordinate being saved and believed
 * when the phone was never that sure of it.
 *
 * The failures being guarded are all silent ones. A single tap saved as
 * a position looks identical on the map to a surveyed corner. A watch
 * left running flattens a battery over a shift with nothing on screen
 * to show for it.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

/**
 * Let the save mutation settle.
 *
 * `waitFor` polls on a real timer, and these tests run on a fake one to
 * drive the sampling window — so it would sit there until it timed out
 * while the promise it is waiting for had already resolved.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

const setLocationMock = vi.fn(
  async (_args: {
    lotId: string;
    lat: number;
    lng: number;
    source: string;
    accuracyM: number;
  }) => null,
);

vi.mock("convex/react", () => ({
  useMutation: () => setLocationMock,
}));

vi.mock("convex/server", () => ({
  makeFunctionReference: (name: string) => ({ name }),
}));

import { LotGpsCapture } from "@/components/LotGpsCapture";

const AT = { lat: 16.3959, lng: 120.3556 };

/** A stand-in phone whose readings the test decides. */
function fakeDevice() {
  let nextId = 1;
  const watches = new Map<
    number,
    {
      ok: (p: unknown) => void;
      fail: (e: unknown) => void;
    }
  >();
  const cleared: number[] = [];

  const geolocation = {
    watchPosition: vi.fn(
      (ok: (p: unknown) => void, fail: (e: unknown) => void) => {
        const id = nextId++;
        watches.set(id, { ok, fail });
        return id;
      },
    ),
    clearWatch: vi.fn((id: number) => {
      cleared.push(id);
      watches.delete(id);
    }),
    getCurrentPosition: vi.fn(),
  };

  return {
    geolocation,
    cleared,
    /** Deliver one reading to every live watch. */
    report(accuracyM: number, over: Partial<typeof AT> = {}) {
      for (const w of watches.values()) {
        w.ok({
          coords: {
            latitude: over.lat ?? AT.lat,
            longitude: over.lng ?? AT.lng,
            accuracy: accuracyM,
          },
          timestamp: Date.now(),
        });
      }
    },
    reject(code: number) {
      for (const w of watches.values()) w.fail({ code });
    },
  };
}

let device: ReturnType<typeof fakeDevice>;

beforeEach(() => {
  setLocationMock.mockClear();
  vi.useFakeTimers();
  device = fakeDevice();
  Object.defineProperty(globalThis, "navigator", {
    value: { geolocation: device.geolocation },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function view(over: Record<string, unknown> = {}) {
  return (
    <LotGpsCapture lotId="lots:a" lotCode="A-01" {...over} />
  );
}

/** Start sampling, deliver readings, then run the window out. */
function capture(readings: Array<[number, Partial<typeof AT>?]>) {
  fireEvent.click(screen.getByTestId("gps-start"));
  act(() => {
    for (const [acc, over] of readings) device.report(acc, over ?? {});
  });
  act(() => {
    vi.advanceTimersByTime(16_000);
  });
}

describe("taking a reading", () => {
  it("samples over time rather than snapping once", () => {
    // One tap is the thing this replaces. A watch, not getCurrentPosition.
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    expect(device.geolocation.watchPosition).toHaveBeenCalled();
    expect(device.geolocation.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("shows the accuracy while it is still running", () => {
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    act(() => {
      device.report(6);
    });
    expect(screen.getByTestId("gps-accuracy")).toHaveTextContent("±6m");
  });

  it("says what the number MEANS, not just the number", () => {
    // "±8m" is not something somebody standing in a cemetery can act
    // on. "Could be a lot or two out either side" is.
    render(view());
    capture([[8], [8], [8]]);
    expect(screen.getByTestId("gps-quality")).toHaveTextContent("Usable");
    expect(screen.getByTestId("gps-reading")).toHaveTextContent(
      /lot or two out/i,
    );
  });

  it("never calls a phone fix better than one grave's width", () => {
    render(view());
    capture([[2], [2], [2]]);
    expect(screen.getByTestId("gps-quality")).toHaveTextContent("Good");
    expect(screen.getByTestId("gps-reading")).toHaveTextContent(/grave/i);
  });

  it("STOPS the watch when the window closes", () => {
    // A watch left running drains a field worker's battery for the rest
    // of their shift, with nothing on screen to explain it.
    render(view());
    capture([[5], [5], [5]]);
    expect(device.geolocation.clearWatch).toHaveBeenCalled();
  });

  it("stops the watch when the panel goes away", () => {
    const { unmount } = render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    unmount();
    expect(device.geolocation.clearWatch).toHaveBeenCalled();
  });
});

describe("what may be saved", () => {
  it("refuses a single reading", () => {
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    act(() => {
      device.report(4);
    });
    act(() => {
      vi.advanceTimersByTime(16_000);
    });
    expect(screen.getByTestId("gps-save")).toBeDisabled();
    expect(screen.getByTestId("gps-blocked")).toHaveTextContent(/keep still/i);
  });

  it("refuses a reading too rough to place a lot", () => {
    render(view());
    capture([[80], [90], [120]]);
    expect(screen.getByTestId("gps-save")).toBeDisabled();
  });

  it("refuses readings scattered across a block", () => {
    // Three confident fixes sixty metres apart are not a position.
    render(view());
    capture([
      [4],
      [4, { lat: AT.lat + 60 / 110_574 }],
      [4, { lat: AT.lat + 120 / 110_574 }],
    ]);
    expect(screen.getByTestId("gps-save")).toBeDisabled();
    expect(screen.getByTestId("gps-blocked")).toHaveTextContent(/spread out/i);
  });

  it("saves a settled reading, with its accuracy attached", async () => {
    // The accuracy travels WITH the coordinate. Saving the point alone
    // would make a ±20m guess indistinguishable from a survey.
    render(view());
    capture([[5], [5], [5]]);
    fireEvent.click(screen.getByTestId("gps-save"));
    await flush();

    expect(setLocationMock).toHaveBeenCalled();
    const args = setLocationMock.mock.calls[0]![0];
    expect(args.lotId).toBe("lots:a");
    expect(args.source).toBe("gps");
    expect(args.accuracyM).toBeGreaterThanOrEqual(5);
    expect(args.lat).toBeCloseTo(AT.lat, 5);
  });

  it("says plainly that what was saved is a phone reading", async () => {
    render(view());
    capture([[5], [5], [5]]);
    fireEvent.click(screen.getByTestId("gps-save"));
    await flush();
    expect(screen.getByTestId("gps-saved")).toHaveTextContent(
      /phone reading rather than a survey/i,
    );
  });

  it("warns before replacing a position that already exists", () => {
    render(view({ alreadyPlaced: true }));
    expect(screen.getByTestId("lot-gps-capture")).toHaveTextContent(
      /already has a position/i,
    );
  });
});

describe("when the phone will not cooperate", () => {
  it("explains a refused permission and what to do", () => {
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    act(() => {
      device.reject(1);
    });
    expect(screen.getByTestId("gps-error")).toHaveTextContent(
      /permission was refused/i,
    );
  });

  it("explains a failed fix in terms of where to stand", () => {
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    act(() => {
      device.reject(2);
    });
    expect(screen.getByTestId("gps-error")).toHaveTextContent(
      /walls and trees/i,
    );
  });

  it("mentions https when the device offers no geolocation at all", () => {
    // The commonest real cause on a phone, and invisible otherwise:
    // browsers refuse to share a position over plain http.
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    expect(screen.getByTestId("gps-error")).toHaveTextContent(/https/i);
  });
});
