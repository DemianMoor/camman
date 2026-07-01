"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

// Recharts (+ its d3 sub-deps) is the single heaviest chunk in the app (~360 KB).
// It lives in its own module so the dashboard page can pull it in via next/dynamic
// (ssr:false) — the chart code only downloads when the dashboard actually renders
// charts, instead of riding along in the initial bundle of the landing page.
export function ChartPanel({
  title,
  data,
  color,
  yLabel,
  isCurrency,
}: {
  title: string;
  data: Array<{ date: string; value: number }>;
  color: string;
  yLabel: string;
  isCurrency?: boolean;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <p className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis allowDecimals={isCurrency} tick={{ fontSize: 11 }} />
          <Tooltip
            formatter={(value) => {
              const n = typeof value === "number" ? value : Number(value);
              return [
                isCurrency
                  ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : n.toLocaleString(),
                yLabel,
              ];
            }}
            labelFormatter={(label) => String(label)}
            contentStyle={{ fontSize: 12 }}
          />
          <Bar dataKey="value" fill={color} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
