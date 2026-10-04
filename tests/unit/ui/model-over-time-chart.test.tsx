// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelOverTimeChart } from "@/shared/components/analytics/rechartsUsageCharts";
import {
  MODEL_USAGE_TOP_N_STORAGE_KEY,
  OTHER_SERIES_KEY,
} from "@/shared/components/analytics/modelUsageSeries";

vi.mock("next-intl", () => ({
  useLocale: () => "en",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) => {
      if (values) return `${key}:${JSON.stringify(values)}`;
      return key;
    };
    t.has = () => false;
    return t;
  },
}));

vi.mock("@/shared/components/analytics/rechartsCore", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Empty = () => null;
  const stub = {
    ResponsiveContainer: Passthrough,
    AreaChart: Passthrough,
    Area: ({ dataKey }: { dataKey: string }) => <span data-testid="area" data-key={dataKey} />,
    XAxis: Empty,
    YAxis: Empty,
    Tooltip: Empty,
  };
  return {
    useRecharts: () => stub,
    ChartLoadingCard: () => <div data-testid="chart-loading" />,
    DarkTooltip: Empty,
  };
});

const MODEL_IDS = Array.from(
  { length: 12 },
  (_, index) => `model-${String(index).padStart(2, "0")}`
);

function makeData() {
  const dates = ["2026-10-01", "2026-10-02", "2026-10-03"];
  const dailyByModel = dates.map((date) => {
    const row: Record<string, unknown> = { date };
    MODEL_IDS.forEach((id, index) => {
      row[id] = (12 - index) * 100;
    });
    row["connection-test"] = 999_999;
    row["codestral-embed"] = 999_999;
    return row;
  });
  return { dailyByModel, modelNames: [...MODEL_IDS, "connection-test", "codestral-embed"] };
}

describe("ModelOverTimeChart", () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    localStorage.clear();
  });

  async function render(props: React.ComponentProps<typeof ModelOverTimeChart>) {
    await act(async () => {
      root.render(<ModelOverTimeChart {...props} />);
    });
  }

  const areaKeys = () =>
    Array.from(container.querySelectorAll('[data-testid="area"]')).map((el) =>
      el.getAttribute("data-key")
    );
  const legendItems = () =>
    Array.from(container.querySelectorAll('[data-testid="model-usage-legend-item"]'));
  const topButton = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label);

  it("shows the top 8 plus Other by default and hides non-inference rows", async () => {
    await render(makeData());

    expect(areaKeys()).toEqual([...MODEL_IDS.slice(0, 8), OTHER_SERIES_KEY]);
    const items = legendItems();
    expect(items).toHaveLength(9);
    for (const item of items) {
      const label = item.querySelector(".truncate");
      expect(label?.getAttribute("title")).toBe(label?.textContent);
      expect(label?.getAttribute("title")).toBeTruthy();
    }
    expect(items[8].textContent).toBe("chartOther");
    expect(container.textContent).not.toContain("connection-test");
    expect(container.textContent).not.toContain("codestral-embed");
    expect(container.innerHTML).not.toContain("connection-test");
    expect(container.innerHTML).not.toContain("codestral-embed");
    expect(container.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
      "chartTopNLabel"
    );
  });

  it("switches to Top 5 and persists the choice", async () => {
    await render(makeData());
    const top5 = topButton('chartTopN:{"count":5}');
    expect(top5?.getAttribute("aria-pressed")).toBe("false");
    expect(topButton('chartTopN:{"count":8}')?.getAttribute("aria-pressed")).toBe("true");

    await act(async () => {
      top5?.click();
    });

    expect(areaKeys()).toEqual([...MODEL_IDS.slice(0, 5), OTHER_SERIES_KEY]);
    expect(topButton('chartTopN:{"count":5}')?.getAttribute("aria-pressed")).toBe("true");
    expect(topButton('chartTopN:{"count":8}')?.getAttribute("aria-pressed")).toBe("false");
    expect(localStorage.getItem(MODEL_USAGE_TOP_N_STORAGE_KEY)).toBe("5");
  });

  it("restores a stored 'all' choice with no Other series", async () => {
    localStorage.setItem(MODEL_USAGE_TOP_N_STORAGE_KEY, "all");
    await render(makeData());

    expect(areaKeys()).toEqual(MODEL_IDS);
    expect(legendItems()).toHaveLength(12);
    expect(topButton("chartTopAll")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders the empty state when every model has zero usage", async () => {
    const dailyByModel = ["2026-10-01", "2026-10-02"].map((date) => ({
      date,
      "model-a": 0,
      "model-b": 0,
    }));
    await render({ dailyByModel, modelNames: ["model-a", "model-b"] });

    expect(container.textContent).toContain("chartNoData");
    expect(areaKeys()).toEqual([]);
  });
});
