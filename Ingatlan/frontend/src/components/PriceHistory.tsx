import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import type { ListingArHistoryPoint } from '../types.js'
import { formatHuf } from '../format.js'

export function PriceHistory({ data }: { data: ListingArHistoryPoint[] }) {
  if (data.length === 0) {
    return <p style={{ color: 'var(--text2)', fontSize: '0.85rem' }}>Nincs árelőzmény.</p>
  }

  const chartData = data.map((p) => ({ datum: p.datum.slice(0, 7), ar: p.ar }))

  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={chartData}>
        <XAxis dataKey="datum" stroke="var(--text2)" fontSize={11} />
        <YAxis
          stroke="var(--text2)"
          fontSize={11}
          tickFormatter={(v: number) => `${Math.round(v / 1_000_000)}M`}
          width={40}
        />
        <Tooltip formatter={(v) => (typeof v === 'number' ? formatHuf(v) : v)} />
        <Line type="monotone" dataKey="ar" stroke="var(--gold)" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}
