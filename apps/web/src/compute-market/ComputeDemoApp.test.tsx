import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComputeMarketApp } from "./ComputeDemoApp";

describe("ComputeMarketApp", () => {
  const signedInSession = {
    token: "new-user-token",
    account: { userId: "new-user", displayName: "新用户", balanceCents: 0, currency: "CNY" as const, plan: "developer" as const, role: "member" as const, billingExempt: false },
    sources: [],
  };

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
    render(
      <ComputeMarketApp
        session={signedInSession}
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
    expect(screen.getByRole("status")).toHaveTextContent("COD-NEW-001");
    fireEvent.click(screen.getByRole("button", { name: /查看订单/ }));
    expect(screen.getByRole("heading", { name: "待确认订单", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /COD-NEW-001/ })).toHaveTextContent("B300 SXM 1 卡");
    expect(screen.getByText("共 3 单")).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("button", { name: /查看托管方案/ }));
    expect(screen.getByRole("dialog", { name: "设备托管方案" })).toBeInTheDocument();
    expect(screen.getByText("联合运营")).toBeInTheDocument();
  });

  it("submits a hosting application and exposes the resulting progress entry", () => {
    render(
      <ComputeMarketApp
        session={signedInSession}
        balanceCardHours="1,286.5"
        initialPath="/compute?tab=hosting"
        platform="web"
        onRequireLogin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "开始托管申请" }));
    const dialog = screen.getByRole("dialog", { name: "提交托管申请" });
    fireEvent.change(within(dialog).getByPlaceholderText("请输入 11 位手机号"), { target: { value: "13900000000" } });
    fireEvent.change(within(dialog).getByPlaceholderText("例如：成都"), { target: { value: "成都" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "提交申请" }));
    expect(screen.getByRole("dialog", { name: "申请已提交" })).toHaveTextContent("HT-0814-026");
    fireEvent.click(screen.getByRole("button", { name: "查看申请进度" }));
    expect(screen.getByRole("heading", { name: "托管申请", level: 1 })).toBeInTheDocument();
  });

  it("opens notifications and routes each message to an actionable page", () => {
    render(
      <ComputeMarketApp
        session={null}
        balanceCardHours={null}
        initialPath="/compute"
        platform="web"
        onRequireLogin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "通知" }));
    const dialog = screen.getByRole("dialog", { name: "消息通知" });
    expect(dialog).toHaveTextContent("华东 B 区新增资源");
    fireEvent.click(within(dialog).getByRole("button", { name: /3 个实例正在运行/ }));
    expect(screen.getByRole("heading", { name: "运行中订单", level: 1 })).toBeInTheDocument();
  });

  it("opens full news and ranking details and continues to available resources", () => {
    render(
      <ComputeMarketApp
        session={null}
        balanceCardHours={null}
        initialPath="/compute?tab=news"
        platform="web"
        onRequireLogin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /从训练到推理/ }));
    expect(screen.getByRole("dialog", { name: "从训练到推理：企业如何规划弹性 GPU 资源" })).toHaveTextContent("需求判断");
    fireEvent.click(screen.getByRole("button", { name: "返回资讯列表" }));
    const mainNav = screen.getByRole("navigation", { name: "算力市场主导航" });
    fireEvent.click(within(mainNav).getByRole("button", { name: "排行榜" }));
    fireEvent.click(screen.getByRole("button", { name: /华北智算一号/ }));
    expect(screen.getByRole("dialog", { name: "华北智算一号" })).toHaveTextContent("99.98%");
    fireEvent.click(screen.getByRole("button", { name: "查看可用资源" }));
    expect(screen.getByText("热门算力卡")).toBeInTheDocument();
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

  it("opens every order and common-service entry from my resources", () => {
    render(
      <ComputeMarketApp
        session={signedInSession}
        balanceCardHours="1,286.5"
        initialPath="/compute?tab=mine"
        platform="web"
        onRequireLogin={vi.fn()}
        onExit={vi.fn()}
      />,
    );

    const entries: Array<[RegExp, string, string]> = [
      [/^全部订单/, "全部订单", "view=orders"],
      [/^待确认/, "待确认订单", "status=pending"],
      [/^运行中/, "运行中订单", "status=running"],
      [/^待交付/, "待交付订单", "status=delivery"],
      [/^已完成/, "已完成订单", "status=completed"],
      [/^我的设备/, "我的设备", "view=devices"],
      [/^托管申请/, "托管申请", "view=hosting"],
      [/^资产账户/, "资产账户", "view=assets"],
      [/^实名认证/, "实名认证", "view=verification"],
      [/^专属客服/, "专属客服", "view=support"],
      [/^帮助中心/, "帮助中心", "view=help"],
      [/^购买卡时$/, "购买卡时", "view=purchase"],
      [/^卡时明细$/, "卡时明细", "view=ledger"],
    ];

    for (const [buttonName, heading, query] of entries) {
      fireEvent.click(screen.getByRole("button", { name: buttonName }));
      expect(screen.getByRole("heading", { name: heading, level: 1 })).toBeInTheDocument();
      expect(window.location.search).toContain(query);
      fireEvent.click(screen.getByRole("button", { name: "返回我的资源" }));
    }
  });

  it("keeps account balance hidden while allowing visitors to inspect resource pages", () => {
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

    fireEvent.click(screen.getByRole("button", { name: /^资产账户/ }));
    expect(screen.getByRole("heading", { name: "资产账户", level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText("注册后领取").length).toBeGreaterThan(0);
    expect(screen.queryByText("1,286.5")).not.toBeInTheDocument();
  });

  it("connects card-hour purchases and service tickets to their real workspace destinations", () => {
    const onOpenAccount = vi.fn();
    const onOpenSupport = vi.fn();
    render(
      <ComputeMarketApp
        session={signedInSession}
        balanceCardHours="1,286.5"
        initialPath="/compute?tab=mine&view=purchase"
        platform="web"
        onRequireLogin={vi.fn()}
        onOpenAccount={onOpenAccount}
        onOpenSupport={onOpenSupport}
        onExit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /轻量卡时包/ }));
    expect(onOpenAccount).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "返回我的资源" }));
    fireEvent.click(screen.getByRole("button", { name: /^专属客服/ }));
    fireEvent.click(screen.getByRole("button", { name: /H200 镜像环境确认/ }));
    fireEvent.click(screen.getByRole("button", { name: "继续联系客服" }));
    expect(onOpenSupport).toHaveBeenCalledTimes(1);
  });
});
