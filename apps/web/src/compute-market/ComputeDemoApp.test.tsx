import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputeDemoApp } from "./ComputeDemoApp";

describe("ComputeDemoApp V2 demo", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/compute?demo=1");
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/app/");
    vi.restoreAllMocks();
  });

  it("renders the current five-tab mobile information architecture with labeled demo data", () => {
    render(
      <ComputeDemoApp
        session={null}
        initialPath="/compute?demo=1"
        platform="mobile"
        onRequireLogin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    expect(screen.getAllByText("演示数据").length).toBeGreaterThan(0);
    const bottomNav = screen.getByRole("navigation", { name: "算力市场底部导航" });
    for (const label of ["首页", "设备托管", "资讯", "排行榜", "我的资源"]) {
      expect(within(bottomNav).getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText("热门算力卡")).toBeInTheDocument();
    expect(screen.getByText("NVIDIA H200 SXM")).toBeInTheDocument();
    expect(screen.getAllByText("1,286.5").length).toBeGreaterThan(0);
  });

  it("opens a product configurator and never submits a real transaction in demo mode", () => {
    render(
      <ComputeDemoApp
        session={null}
        initialPath="/compute?demo=1"
        platform="web"
        onRequireLogin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看 H200 SXM 高性能训练卡" }));
    expect(screen.getByRole("heading", { name: "配置订单" })).toBeInTheDocument();
    expect(window.location.search).toContain("offer=h200-sxm-141");

    fireEvent.click(screen.getByRole("button", { name: "确认配置并提交" }));
    expect(screen.getByRole("status")).toHaveTextContent("不会提交真实交易");
  });

  it("switches to a substantive hosting page instead of an empty shell", () => {
    render(
      <ComputeDemoApp
        session={null}
        initialPath="/compute?demo=1"
        platform="mobile"
        onRequireLogin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const bottomNav = screen.getByRole("navigation", { name: "算力市场底部导航" });
    fireEvent.click(within(bottomNav).getByRole("button", { name: "设备托管" }));
    expect(screen.getByRole("heading", { name: "闲置设备，接入 COD 算力资源池" })).toBeInTheDocument();
    expect(screen.getByText("托管流程")).toBeInTheDocument();
  });

  it("opens the boss operations dashboard from my resources and keeps it clearly labeled as demo data", () => {
    render(
      <ComputeDemoApp
        session={null}
        initialPath="/compute?demo=1&tab=mine"
        platform="mobile"
        onRequireLogin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开经营看板" }));
    expect(screen.getByRole("heading", { name: "算力供需与经营概览" })).toBeInTheDocument();
    expect(screen.getByText("¥286,400")).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "成都" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "澄海模型实验室" })).toBeInTheDocument();
    expect(window.location.search).toContain("view=operations");
    expect(screen.queryByRole("navigation", { name: "算力市场底部导航" })).not.toBeInTheDocument();
  });
});
