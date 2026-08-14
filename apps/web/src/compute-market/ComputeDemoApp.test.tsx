import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputeMarketApp } from "./ComputeDemoApp";

describe("ComputeMarketApp", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/compute");
    vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/app/");
    vi.restoreAllMocks();
  });

  it("renders the complete public market without assigning a visitor balance", () => {
    render(
      <ComputeMarketApp
        session={null}
        balanceCardHours={null}
        initialPath="/compute"
        platform="mobile"
        onRequireLogin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const bottomNav = screen.getByRole("navigation", { name: "算力市场底部导航" });
    for (const label of ["首页", "设备托管", "资讯", "排行榜", "我的资源"]) {
      expect(within(bottomNav).getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText("热门算力卡")).toBeInTheDocument();
    expect(screen.getByText("NVIDIA B300 SXM")).toBeInTheDocument();
    expect(screen.getByText("NVIDIA H200 SXM")).toBeInTheDocument();
    expect(screen.getByText("注册后领取")).toBeInTheDocument();
    expect(screen.queryByText("1,286.5")).not.toBeInTheDocument();
  });

  it("opens a priced product configurator and submits through the signed-in market flow", () => {
    const session = {
      token: "new-user-token",
      account: { userId: "new-user", displayName: "新用户", balanceCents: 0, currency: "CNY" as const, plan: "developer" as const, role: "member" as const, billingExempt: false },
      sources: [],
    };
    render(
      <ComputeMarketApp
        session={session}
        balanceCardHours="1,286.5"
        initialPath="/compute"
        platform="web"
        onRequireLogin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看 B300 SXM 超大显存训练卡" }));
    expect(screen.getByRole("heading", { name: "配置订单" })).toBeInTheDocument();
    expect(screen.getByText("44.0")).toBeInTheDocument();
    expect(screen.getAllByText("1,286.5").length).toBeGreaterThan(0);
    expect(window.location.search).toContain("offer=b300-sxm-288");

    fireEvent.click(screen.getByRole("button", { name: "确认配置并提交" }));
    expect(screen.getByRole("status")).toHaveTextContent("订单已提交");
  });

  it("switches to a substantive hosting page instead of an empty shell", () => {
    render(
      <ComputeMarketApp
        session={null}
        balanceCardHours={null}
        initialPath="/compute"
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

  it("opens the public operations dashboard for a visitor", () => {
    render(
      <ComputeMarketApp
        session={null}
        balanceCardHours={null}
        initialPath="/compute?tab=mine"
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
    expect(screen.getByText("公开数据")).toBeInTheDocument();
    expect(screen.queryByText("演示数据")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "算力市场底部导航" })).not.toBeInTheDocument();
  });
});
