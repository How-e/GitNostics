import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export function WorkflowChart({
  data,
}: {
  data: { day: string; success: number; failure: number }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={190}>
      <AreaChart data={data} margin={{ left: -25, right: 14, top: 10, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="3 3" />
        <XAxis
          dataKey="day"
          tick={{ fontSize: 10, fill: 'var(--muted)' }}
          axisLine={false}
          tickLine={false}
          minTickGap={40}
        />
        <YAxis
          allowDecimals={false}
          tick={{ fontSize: 10, fill: 'var(--muted)' }}
          axisLine={false}
          tickLine={false}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--raised)',
            border: '1px solid var(--line)',
            borderRadius: 7,
            fontSize: 12,
          }}
        />
        <Area
          type="linear"
          dataKey="success"
          name="Successful runs"
          stroke="var(--green)"
          fill="var(--green-faint)"
          strokeWidth={1.5}
          isAnimationActive={false}
        />
        <Area
          type="linear"
          dataKey="failure"
          name="Failed runs"
          stroke="var(--accent)"
          fill="var(--accent-faint)"
          strokeWidth={1.5}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function DurationChart({
  data,
}: {
  data: { name: string; duration: number; workflow: string }[];
}) {
  return (
    <ResponsiveContainer width="100%" height={210}>
      <LineChart data={data} margin={{ left: -15, right: 20, top: 20, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="3 3" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 10, fill: 'var(--muted)' }}
          minTickGap={45}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: 'var(--muted)' }}
          tickLine={false}
          axisLine={false}
          unit="m"
        />
        <Tooltip
          contentStyle={{
            background: 'var(--raised)',
            border: '1px solid var(--line)',
            borderRadius: 7,
            fontSize: 12,
          }}
          formatter={(value) => [`${value} minutes`, 'Duration']}
        />
        <Line
          type="linear"
          dataKey="duration"
          stroke="var(--accent)"
          strokeWidth={1.5}
          dot={{ r: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function StorageChart({ data }: { data: { day: string; megabytes: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={data} margin={{ top: 12, left: 0, right: 25, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="3 3" />
        <XAxis
          dataKey="day"
          tick={{ fill: 'var(--muted)', fontSize: 10 }}
          minTickGap={60}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fill: 'var(--muted)', fontSize: 10 }}
          unit=" MB"
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          contentStyle={{
            background: 'var(--raised)',
            border: '1px solid var(--line)',
            borderRadius: 7,
            fontSize: 12,
          }}
          formatter={(value) => [`${value} MB`, 'Retained artifacts']}
        />
        <Area
          dataKey="megabytes"
          stroke="var(--accent)"
          fill="var(--accent-faint)"
          strokeWidth={1.5}
          type="linear"
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
