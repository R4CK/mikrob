import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import type { PriceBand } from '../price-distribution.js'

export function DistChart({ data }: { data: PriceBand[] }) {
  const chartData = data.map((b) => ({ label: b.label, 'Ház': b.hazCount, 'Lakás': b.lakasCount }))

  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="label" stroke="var(--text2)" fontSize={12} />
        <YAxis stroke="var(--text2)" fontSize={12} allowDecimals={false} />
        <Tooltip />
        <Legend />
        <Bar dataKey="Ház" fill="#9580ff" radius={[4, 4, 0, 0]} />
        <Bar dataKey="Lakás" fill="#36caf5" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
