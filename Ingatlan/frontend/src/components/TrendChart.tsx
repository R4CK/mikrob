import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, Area } from 'recharts'
import type { TrendPoint } from '../types.js'
import { formatMFtPerM2 } from '../format.js'

export function TrendChart({ data }: { data: TrendPoint[] }) {
  const chartData = data.map((p) => ({
    datum: p.datum,
    'Ház': p.haz_nm2 === null ? undefined : p.haz_nm2 / 1_000_000,
    'Lakás': p.lakas_nm2 === null ? undefined : p.lakas_nm2 / 1_000_000,
  }))

  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="datum" stroke="var(--text2)" fontSize={12} />
        <YAxis stroke="var(--text2)" fontSize={12} unit=" M Ft" />
        <Tooltip formatter={(value) => formatMFtPerM2(typeof value === 'number' ? value * 1_000_000 : null)} />
        <Legend />
        <Area type="monotone" dataKey="Ház" stroke="none" fill="#9580ff" fillOpacity={0.15} />
        <Area type="monotone" dataKey="Lakás" stroke="none" fill="#36caf5" fillOpacity={0.15} />
        <Line type="monotone" dataKey="Ház" stroke="#9580ff" strokeWidth={2} dot={{ r: 3 }} />
        <Line type="monotone" dataKey="Lakás" stroke="#36caf5" strokeWidth={2} dot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  )
}
