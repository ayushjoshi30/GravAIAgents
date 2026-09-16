"use client";

import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Recharts wrapped in brand tokens.
 *
 * Colours are CSS variables rather than literals, so a palette change in
 * globals.css reaches every chart. Series colours are the six-step
 * brand-led categorical ramp; semantic green and red are reserved for pass
 * and fail and never used to separate one series from another.
 */

export const SERIES = [
  "var(--gv-series-1)",
  "var(--gv-series-2)",
  "var(--gv-series-3)",
  "var(--gv-series-4)",
  "var(--gv-series-5)",
  "var(--gv-series-6)",
];

interface TooltipPayloadItem {
  name?: string | number;
  value?: string | number;
  color?: string;
  dataKey?: string | number;
}

function BrandTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
  formatter?: (value: number, name: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="gv-card px-2.5 py-2 shadow-sm">
      {label !== undefined ? (
        <p className="mb-1 font-mono text-[11px] text-ink-3">{String(label)}</p>
      ) : null}
      <ul className="space-y-0.5">
        {payload.map((item, index) => (
          <li key={index} className="flex items-center gap-2 text-[12px]">
            <span
              aria-hidden="true"
              className="block h-2 w-2 shrink-0"
              style={{ background: item.color }}
            />
            <span className="text-ink-2">{String(item.name ?? item.dataKey ?? "")}</span>
            <span className="ml-auto font-mono text-ink" data-numeric="">
              {formatter
                ? formatter(Number(item.value ?? 0), String(item.name ?? ""))
                : String(item.value ?? "")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const AXIS_PROPS = {
  stroke: "var(--gv-line-strong)",
  tick: { fill: "var(--gv-ink-3)", fontSize: 10.5 },
  tickLine: false,
} as const;

export function ChartFrame({
  title,
  description,
  height = 240,
  children,
  legend,
}: {
  title: string;
  description?: ReactNode;
  height?: number;
  children: ReactNode;
  legend?: ReactNode;
}) {
  return (
    // min-w-0 matters: Recharts measures its parent, and a grid item with the
    // default min-width:auto lets the chart's own content ratchet the column
    // wider on every resize observation.
    <figure className="min-w-0 overflow-hidden gv-card">
      <figcaption className="border-b border-line px-4 py-2.5">
        <p className="text-[13.5px] font-semibold text-ink">{title}</p>
        {description ? (
          <p className="mt-0.5 text-[12px] leading-snug text-ink-3">{description}</p>
        ) : null}
      </figcaption>
      <div className="min-w-0 overflow-hidden p-3" style={{ height }}>
        {children}
      </div>
      {legend ? <div className="border-t border-line px-4 py-2">{legend}</div> : null}
    </figure>
  );
}

export function StackedBars({
  data,
  xKey,
  series,
  formatter,
  stacked = true,
}: {
  data: Record<string, string | number>[];
  xKey: string;
  series: { key: string; label: string }[];
  formatter?: (value: number) => string;
  stacked?: boolean;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid vertical={false} stroke="var(--gv-line)" />
        <XAxis dataKey={xKey} {...AXIS_PROPS} interval="preserveStartEnd" />
        <YAxis {...AXIS_PROPS} width={56} tickFormatter={(v) => (formatter ? formatter(Number(v)) : String(v))} />
        <Tooltip
          cursor={{ fill: "var(--gv-surface-2)" }}
          content={<BrandTooltip formatter={(value) => (formatter ? formatter(value) : String(value))} />}
        />
        <Legend
          wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
          iconType="square"
          iconSize={8}
        />
        {series.map((item, index) => (
          <Bar
            key={item.key}
            dataKey={item.key}
            name={item.label}
            stackId={stacked ? "a" : undefined}
            fill={SERIES[index % SERIES.length]}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TrendArea({
  data,
  xKey,
  series,
  formatter,
}: {
  data: Record<string, string | number>[];
  xKey: string;
  series: { key: string; label: string }[];
  formatter?: (value: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
        <defs>
          {series.map((item, index) => (
            <linearGradient key={item.key} id={`grad-${item.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={SERIES[index % SERIES.length]}
                stopOpacity={0.28}
              />
              <stop
                offset="100%"
                stopColor={SERIES[index % SERIES.length]}
                stopOpacity={0.02}
              />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid vertical={false} stroke="var(--gv-line)" />
        <XAxis dataKey={xKey} {...AXIS_PROPS} interval="preserveStartEnd" minTickGap={24} />
        <YAxis {...AXIS_PROPS} width={56} tickFormatter={(v) => (formatter ? formatter(Number(v)) : String(v))} />
        <Tooltip
          cursor={{ stroke: "var(--gv-line-strong)" }}
          content={<BrandTooltip formatter={(value) => (formatter ? formatter(value) : String(value))} />}
        />
        {series.length > 1 ? (
          <Legend wrapperStyle={{ fontSize: 11, paddingTop: 4 }} iconType="square" iconSize={8} />
        ) : null}
        {series.map((item, index) => (
          <Area
            key={item.key}
            type="monotone"
            dataKey={item.key}
            name={item.label}
            stroke={SERIES[index % SERIES.length]}
            strokeWidth={1.6}
            fill={`url(#grad-${item.key})`}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function UtilisationLine({
  data,
  xKey,
  valueKey,
  ceiling = 1,
  formatter,
}: {
  data: Record<string, string | number>[];
  xKey: string;
  valueKey: string;
  ceiling?: number;
  formatter?: (value: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
        <CartesianGrid vertical={false} stroke="var(--gv-line)" />
        <XAxis dataKey={xKey} {...AXIS_PROPS} interval="preserveStartEnd" minTickGap={20} />
        <YAxis {...AXIS_PROPS} width={52} tickFormatter={(v) => (formatter ? formatter(Number(v)) : String(v))} />
        <Tooltip
          cursor={{ stroke: "var(--gv-line-strong)" }}
          content={<BrandTooltip formatter={(value) => (formatter ? formatter(value) : String(value))} />}
        />
        <ReferenceLine
          y={ceiling}
          stroke="var(--gv-amber)"
          strokeDasharray="4 3"
          label={{
            value: "ceiling",
            position: "insideTopRight",
            fill: "var(--gv-amber)",
            fontSize: 10,
          }}
        />
        <Line
          type="monotone"
          dataKey={valueKey}
          stroke="var(--gv-series-1)"
          strokeWidth={1.8}
          dot={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function BacklogProjection({
  data,
  formatter,
}: {
  data: { day: number; remaining: number }[];
  formatter?: (value: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="grad-backlog" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--gv-series-3)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--gv-series-3)" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} stroke="var(--gv-line)" />
        <XAxis
          dataKey="day"
          {...AXIS_PROPS}
          tickFormatter={(value) => `d${value}`}
          minTickGap={18}
        />
        <YAxis
          {...AXIS_PROPS}
          width={56}
          tickFormatter={(v) => (formatter ? formatter(Number(v)) : String(v))}
        />
        <Tooltip
          content={
            <BrandTooltip
              formatter={(value) => (formatter ? formatter(value) : String(value))}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="remaining"
          name="Documents remaining"
          stroke="var(--gv-series-3)"
          strokeWidth={1.8}
          fill="url(#grad-backlog)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function SharePie({
  data,
  formatter,
}: {
  data: { name: string; value: number }[];
  formatter?: (value: number) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="52%"
          outerRadius="82%"
          paddingAngle={1}
          stroke="var(--gv-surface)"
          strokeWidth={1}
        >
          {data.map((entry, index) => (
            <Cell key={entry.name} fill={SERIES[index % SERIES.length]} />
          ))}
        </Pie>
        <Tooltip
          content={
            <BrandTooltip
              formatter={(value) => (formatter ? formatter(value) : String(value))}
            />
          }
        />
        <Legend wrapperStyle={{ fontSize: 11 }} iconType="square" iconSize={8} />
      </PieChart>
    </ResponsiveContainer>
  );
}
