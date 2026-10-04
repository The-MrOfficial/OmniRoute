"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Card from "../Card";
import { fmtCompact as fmt, fmtCost } from "@/shared/utils/formatting";
import {
  DEFAULT_MODEL_USAGE_TOP_N,
  MODEL_USAGE_TOP_N_OPTIONS,
  MODEL_USAGE_TOP_N_STORAGE_KEY,
  buildModelUsageSeries,
  parseModelUsageTopN,
  type ModelUsageRow,
  type ModelUsageSeries,
  type ModelUsageTopN,
} from "./modelUsageSeries";
import { ChartLoadingCard, DarkTooltip, useRecharts } from "./rechartsCore";

// ── DailyTrendChart (Recharts) ─────────────────────────────────────────────

export function DailyTrendChart({ dailyTrend }) {
  const t = useTranslations("analytics");
  const chartData = useMemo(() => {
    return (dailyTrend || []).map((d) => ({
      date: d.date.slice(5),
      [t("chartInput")]: d.promptTokens,
      [t("chartOutput")]: d.completionTokens,
      [t("chartCost")]: d.cost || 0,
    }));
  }, [dailyTrend, t]);

  const hasCost = useMemo(() => chartData.some((d) => d[t("chartCost")] > 0), [chartData, t]);

  if (!chartData.length) {
    return (
      <Card className="p-4">
        <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3">
          {t("chartModelUsageOverTime")}
        </h3>
        <div className="text-center text-text-muted text-sm py-8">{t("chartNoData")}</div>
      </Card>
    );
  }

  return <DailyTrendChartBody chartData={chartData} hasCost={hasCost} />;
}

function DailyTrendChartBody({ chartData, hasCost }) {
  const t = useTranslations("analytics");
  const recharts = useRecharts();

  if (!recharts) {
    return <ChartLoadingCard />;
  }

  const { ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } = recharts;

  return (
    <Card className="p-4 flex-1">
      <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3">
        {t("chartModelUsageOverTime")}
      </h3>
      <ResponsiveContainer width="100%" height={140}>
        <ComposedChart
          data={chartData}
          margin={{ top: 0, right: hasCost ? 40 : 0, left: 0, bottom: 0 }}
        >
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
            axisLine={false}
            tickLine={false}
            interval={Math.max(Math.floor(chartData.length / 6), 0)}
          />
          {hasCost && (
            <YAxis
              yAxisId="cost"
              orientation="right"
              tick={{ fontSize: 8, fill: "#f59e0b" }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(v) => `$${v.toFixed(2)}`}
              width={36}
            />
          )}
          <Tooltip content={<CostTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
          <Bar
            dataKey={t("chartInput")}
            stackId="a"
            fill="var(--color-primary)"
            opacity={0.7}
            radius={[0, 0, 0, 0]}
            animationDuration={600}
          />
          <Bar
            dataKey={t("chartOutput")}
            stackId="a"
            fill="#10b981"
            opacity={0.7}
            radius={[3, 3, 0, 0]}
            animationDuration={600}
          />
          {hasCost && (
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey={t("chartCost")}
              stroke="#f59e0b"
              strokeWidth={2}
              dot={false}
              animationDuration={600}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-2 text-[10px] text-text-muted">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-primary/70" /> {t("chartInput")}
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-emerald-500/70" /> {t("chartOutput")}
        </span>
        {hasCost && (
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-500/70" /> {t("chartCost")} ($)
          </span>
        )}
      </div>
    </Card>
  );
}

// ── Cost-aware Tooltip ─────────────────────────────────────────────────────

function CostTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: any[];
  label?: any;
}) {
  const t = useTranslations("analytics");
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-white/10 bg-surface px-3 py-2 text-xs shadow-lg">
      {label && <div className="font-semibold text-text-main mb-1">{label}</div>}
      {payload.map((entry, i) => (
        <div key={i} className="flex items-center gap-1.5 text-text-muted">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: entry.color }}
          />
          <span>{entry.name}:</span>
          <span className="font-mono font-medium text-text-main">
            {entry.name === t("chartCost") ? fmtCost(entry.value) : fmt(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ── WeeklyPattern (Recharts) ───────────────────────────────────────────────

function WeeklyPattern({ weeklyPattern }) {
  const t = useTranslations("analytics");
  const chartData = useMemo(() => {
    return (weeklyPattern || []).map((w) => ({
      day: w.day.slice(0, 3),
      Tokens: w.totalTokens,
    }));
  }, [weeklyPattern]);

  return <WeeklyPatternBody chartData={chartData} title={t("chartWeekly")} />;
}

function WeeklyPatternBody({ chartData, title }) {
  const recharts = useRecharts();

  if (!recharts) {
    return (
      <Card className="px-4 py-3">
        <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
          {title}
        </h3>
        <div className="h-12" />
      </Card>
    );
  }

  const { ResponsiveContainer, BarChart, XAxis, Tooltip, Bar } = recharts;

  return (
    <Card className="px-4 py-3">
      <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
        {title}
      </h3>
      <ResponsiveContainer width="100%" height={48}>
        <BarChart data={chartData} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="day"
            tick={{ fontSize: 9, fill: "var(--color-text-muted)" }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            content={<DarkTooltip formatter={fmt} />}
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
          />
          <Bar
            dataKey="Tokens"
            fill="var(--color-text-muted)"
            opacity={0.3}
            radius={[3, 3, 0, 0]}
            animationDuration={400}
          />
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}

// ── MostActiveDay7d ────────────────────────────────────────────────────────

type ModelOverTimeChartProps = {
  dailyByModel?: Array<Record<string, unknown>> | null;
  modelNames?: string[] | null;
};

function readStoredTopN(): ModelUsageTopN {
  if (globalThis.window === undefined) return DEFAULT_MODEL_USAGE_TOP_N;
  try {
    return parseModelUsageTopN(globalThis.localStorage.getItem(MODEL_USAGE_TOP_N_STORAGE_KEY));
  } catch {
    return DEFAULT_MODEL_USAGE_TOP_N;
  }
}

export function ModelOverTimeChart({ dailyByModel, modelNames }: ModelOverTimeChartProps) {
  const t = useTranslations("analytics");
  const [topN, setTopNState] = useState<ModelUsageTopN>(readStoredTopN);

  const setTopN = useCallback((next: ModelUsageTopN) => {
    setTopNState(next);
    try {
      globalThis.localStorage.setItem(MODEL_USAGE_TOP_N_STORAGE_KEY, String(next));
    } catch {
      // Storage can be unavailable (private mode, quota); the choice still applies this session.
    }
  }, []);

  const { rows, series } = useMemo(
    () => buildModelUsageSeries(dailyByModel, modelNames, topN),
    [dailyByModel, modelNames, topN]
  );

  if (!rows.length || !series.length) {
    return (
      <Card className="p-4">
        <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3">
          {t("chartModelUsageOverTime")}
        </h3>
        <div className="text-center text-text-muted text-sm py-8">{t("chartNoData")}</div>
      </Card>
    );
  }

  return <ModelOverTimeChartBody rows={rows} series={series} topN={topN} onTopNChange={setTopN} />;
}

type ModelOverTimeChartBodyProps = {
  rows: ModelUsageRow[];
  series: ModelUsageSeries[];
  topN: ModelUsageTopN;
  onTopNChange: (next: ModelUsageTopN) => void;
};

function ModelOverTimeChartBody({ rows, series, topN, onTopNChange }: ModelOverTimeChartBodyProps) {
  const t = useTranslations("analytics");
  const recharts = useRecharts();

  if (!recharts) {
    return <ChartLoadingCard className="p-4" />;
  }

  const { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } = recharts;
  const seriesLabel = (s: ModelUsageSeries) => (s.isOther ? t("chartOther") : s.name);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider">
          {t("chartModelUsageOverTime")}
        </h3>
        <div
          role="group"
          aria-label={t("chartTopNLabel")}
          className="flex items-center gap-0.5 rounded-md border border-border p-0.5"
        >
          {MODEL_USAGE_TOP_N_OPTIONS.map((option) => {
            const pressed = option === topN;
            return (
              <button
                key={String(option)}
                type="button"
                aria-pressed={pressed}
                onClick={() => onTopNChange(option)}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  pressed
                    ? "bg-primary/15 text-primary"
                    : "text-text-muted hover:text-text-main hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                {option === "all" ? t("chartTopAll") : t("chartTopN", { count: option })}
              </button>
            );
          })}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={rows} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <XAxis
            dataKey="dateLabel"
            tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
            tickFormatter={(v) => fmt(v)}
            axisLine={false}
            tickLine={false}
            width={50}
          />
          <Tooltip content={<DarkTooltip formatter={fmt} />} />
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={seriesLabel(s)}
              stackId="1"
              stroke={s.color}
              fill={s.color}
              fillOpacity={0.4}
              strokeWidth={1.5}
              animationDuration={600}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[10px] text-text-muted">
        {series.map((s) => {
          const label = seriesLabel(s);
          return (
            <span
              key={s.key}
              data-testid="model-usage-legend-item"
              className="flex items-center gap-1 max-w-[12rem] min-w-0"
            >
              <span
                aria-hidden="true"
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: s.color }}
              />
              <span className="truncate" title={label}>
                {label}
              </span>
            </span>
          );
        })}
      </div>
    </Card>
  );
}

// ── ProviderTable ──────────────────────────────────────────────────────────
