import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCollapsedSidebar } from "@/hooks/useCollapsedSidebar";

describe("useCollapsedSidebar", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to expanded (collapsed=false)", () => {
    const { result } = renderHook(() => useCollapsedSidebar());
    expect(result.current.collapsed).toBe(false);
  });

  it("rehydrates from localStorage on mount", () => {
    window.localStorage.setItem("cemetery.sidebar.collapsed", "true");
    const { result } = renderHook(() => useCollapsedSidebar());
    // useEffect runs sync in React 18 test mode after first render.
    expect(result.current.collapsed).toBe(true);
  });

  it("persists collapse toggles to localStorage", () => {
    const { result } = renderHook(() => useCollapsedSidebar());
    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem("cemetery.sidebar.collapsed")).toBe(
      "true",
    );
    act(() => result.current.toggleCollapsed());
    expect(result.current.collapsed).toBe(false);
    expect(window.localStorage.getItem("cemetery.sidebar.collapsed")).toBe(
      "false",
    );
  });

  it("survives a disabled localStorage", () => {
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("disabled");
      });
    const { result } = renderHook(() => useCollapsedSidebar());
    expect(() => act(() => result.current.setCollapsed(true))).not.toThrow();
    expect(result.current.collapsed).toBe(true);
    setItem.mockRestore();
  });
});
