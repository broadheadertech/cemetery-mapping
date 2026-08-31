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

const clearLocationMock = vi.fn(async (_args: { lotId: string }) => null);

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
  useMutation: (ref: unknown) =>
    String((ref as { name?: string })?.name ?? "").includes("clearLotLocation")
      ? clearLocationMock
      : setLocationMock,
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
      (
        ok: (p: unknown) => void,
        fail: (e: unknown) => void,
        // Read by the cold-start test: the per-acquisition timeout is
        // the setting that made this fail every time.
        _opts?: { timeout?: number; enableHighAccuracy?: boolean },
      ) => {
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
  clearLocationMock.mockClear();
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

  it("KEEPS WAITING through a dropped reading rather than giving up", () => {
    // GPS drops readings constantly. Treating every failure as fatal is
    // how a capture that was working suddenly is not — and it threw
    // away every good reading collected up to that point.
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    act(() => {
      device.report(5);
      device.report(5);
    });
    act(() => {
      device.reject(2); // POSITION_UNAVAILABLE, mid-capture
    });
    expect(screen.queryByTestId("gps-error")).toBeNull();
    expect(screen.getByTestId("gps-sampling")).toHaveTextContent(
      "2 readings so far",
    );
  });

  it("gives a COLD GPS a full minute to produce its first fix", () => {
    // The bug that made this fail every time on a cold start: the
    // per-acquisition timeout was set to the fifteen-second sampling
    // window, and a cold GPS routinely takes thirty to sixty seconds.
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));

    const opts = device.geolocation.watchPosition.mock.calls[0]![2];
    expect(opts?.timeout ?? 0).toBeGreaterThanOrEqual(60_000);

    // Twenty seconds in, still waiting — not failed.
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(screen.getByTestId("gps-locating")).toBeInTheDocument();
    expect(screen.queryByTestId("gps-error")).toBeNull();

    // And a fix arriving that late is still used.
    act(() => {
      device.report(5);
    });
    expect(screen.getByTestId("gps-sampling")).toBeInTheDocument();
  });

  it("starts the fifteen seconds at the FIRST reading, not the button", () => {
    // Otherwise a twenty-second cold start eats the whole window and
    // leaves one reading to average.
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    act(() => {
      device.report(5);
    });
    // The window has only just begun.
    act(() => {
      vi.advanceTimersByTime(5_000);
      device.report(5);
      device.report(5);
    });
    expect(screen.getByTestId("gps-sampling")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    expect(screen.getByTestId("gps-save")).toBeInTheDocument();
  });

  it("gives up eventually, saying where to stand", () => {
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    act(() => {
      vi.advanceTimersByTime(61_000);
    });
    expect(screen.getByTestId("gps-error")).toHaveTextContent(
      /walls and roofs/i,
    );
  });

  it("names an INSECURE CONNECTION rather than blaming permissions", () => {
    // The commonest real failure and the one whose symptom lies.
    // Browsers only share a position in a secure context, so over
    // http://192.168.x.x — exactly how a phone reaches a dev server —
    // the call comes back as PERMISSION_DENIED. Telling somebody to
    // check their browser permissions sends them somewhere that cannot
    // possibly fix it.
    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
    });
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    expect(screen.getByTestId("gps-error")).toHaveTextContent(/https/i);
    expect(screen.getByTestId("gps-error")).toHaveTextContent(
      /nothing to change in your phone/i,
    );
    expect(device.geolocation.watchPosition).not.toHaveBeenCalled();
    Object.defineProperty(window, "isSecureContext", {
      value: true,
      configurable: true,
    });
  });

  it("says so when the device has no geolocation at all", () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {},
      configurable: true,
      writable: true,
    });
    render(view());
    fireEvent.click(screen.getByTestId("gps-start"));
    expect(screen.getByTestId("gps-error")).toHaveTextContent(
      /location services/i,
    );
  });
});

describe("taking a position back", () => {
  it("offers removal only to somebody who may edit", () => {
    render(view({ alreadyPlaced: true, canClear: false }));
    expect(screen.queryByTestId("gps-clear")).toBeNull();
  });

  it("offers nothing to remove when the lot was never placed", () => {
    render(view({ alreadyPlaced: false, canClear: true }));
    expect(screen.queryByTestId("gps-clear")).toBeNull();
  });

  it("removes the position and says the lot is not surveyed", async () => {
    // "Not surveyed" beats a coordinate nobody trusts: the map leaves
    // the lot out and says so, rather than drawing it confidently in
    // the wrong place.
    render(view({ alreadyPlaced: true, canClear: true }));
    fireEvent.click(screen.getByTestId("gps-clear"));
    await flush();

    expect(clearLocationMock).toHaveBeenCalledWith({ lotId: "lots:a" });
    expect(screen.getByTestId("gps-cleared")).toHaveTextContent(
      /not surveyed/i,
    );
  });
});
