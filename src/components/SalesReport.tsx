import React, { useState, useEffect } from 'react';
import { getPosRecords } from '../services/posDataAccess';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

const SalesReport: React.FC = () => {
  const [reportData, setReportData] = useState<{ date: string; totalSalesExclTax: number; orderCount: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchReport = async () => {
      try {
        const orders = await getPosRecords<any>('orders');
        const grouped: Record<string, { date: string; totalSalesExclTax: number; orderCount: number }> = {};
        if (Array.isArray(orders)) {
          for (const o of orders) {
            if (o.status === 'void') continue;
            const date = String(o.createdAt || '').slice(0, 10) || 'غير معروف';
            if (!grouped[date]) {
              grouped[date] = { date, totalSalesExclTax: 0, orderCount: 0 };
            }
            grouped[date].totalSalesExclTax += Number(o.netAmount || 0) - Number(o.taxAmount || 0);
            grouped[date].orderCount += 1;
          }
        }
        const sorted = Object.values(grouped)
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((d) => ({ ...d, totalSalesExclTax: Math.round(d.totalSalesExclTax * 100) / 100 }));
        setReportData(sorted);
      } catch (error) {
        console.error('Failed to fetch sales report:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchReport();
  }, []);

  if (loading) return <div className="p-4 text-sm text-slate-500">جاري تحميل تقرير المبيعات...</div>;

  return (
    <div className="p-4 bg-white rounded-2xl border border-slate-200" dir="rtl">
      <h2 className="text-lg font-bold text-slate-900 mb-4">ملخص المبيعات اليومية (صافي بدون ضريبة)</h2>
      <ResponsiveContainer width="100%" height={360}>
        <BarChart data={reportData}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
          <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 12 }} />
          <YAxis tick={{ fill: '#64748b', fontSize: 12 }} />
          <Tooltip />
          <Legend />
          <Bar dataKey="totalSalesExclTax" fill="#4f46e5" name="صافي المبيعات" radius={[6, 6, 0, 0]} />
          <Bar dataKey="orderCount" fill="#10b981" name="عدد الفواتير" radius={[6, 6, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export default SalesReport;
