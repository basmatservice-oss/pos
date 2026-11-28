import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Search, ShoppingBag, RotateCcw, Package, ClipboardCheck, ShoppingCart,
  Users, Truck, UserCircle, UserCheck, DollarSign, Tag, Building2,
  Smartphone, Clock, Wallet, FileText, RefreshCw, Settings, ArrowLeft,
  LayoutDashboard, Sparkles, X
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

const groups = [
  {
    title: 'المبيعات وخدمة العملاء',
    description: 'البيع اليومي وإدارة عمليات العملاء',
    items: [
      { to: '/pos', label: 'نقطة البيع', detail: 'إنشاء فاتورة وبدء عملية بيع', icon: ShoppingBag, permission: 'view_pos', featured: true },
      { to: '/returns', label: 'المرتجعات', detail: 'إرجاع الأصناف ومتابعة الاسترداد', icon: RotateCcw, permission: 'view_returns' },
      { to: '/customers', label: 'العملاء', detail: 'ملفات العملاء والأرصدة', icon: Users, permission: 'view_customers' },
      { to: '/mobile-sales', label: 'المبيعات الميدانية', detail: 'عمليات مندوبي المبيعات', icon: Smartphone, permission: 'view_mobile_sales' },
      { to: '/offers', label: 'العروض', detail: 'إدارة الخصومات والعروض', icon: Tag, permission: 'view_offers' },
    ],
  },
  {
    title: 'المخزون والمشتريات',
    description: 'الأصناف والتوريد وحركة المخزون',
    items: [
      { to: '/inventory', label: 'المخزون والأصناف', detail: 'الأصناف والأسعار والكميات', icon: Package, permission: 'view_inventory' },
      { to: '/purchases', label: 'المشتريات', detail: 'فواتير الشراء والموردون', icon: ShoppingCart, permission: 'view_purchases' },
      { to: '/stocktaking', label: 'الجرد المخزني', detail: 'جلسات الجرد ومطابقة الكميات', icon: ClipboardCheck, permission: 'view_stocktaking' },
      { to: '/suppliers', label: 'الموردون', detail: 'بيانات الموردين والحسابات', icon: Truck, permission: 'view_suppliers' },
    ],
  },
  {
    title: 'الموارد البشرية والإدارة',
    description: 'الفريق والفروع والمصروفات',
    items: [
      { to: '/employees', label: 'الموظفون', detail: 'ملفات الموظفين والصلاحيات', icon: UserCircle, permission: 'view_employees' },
      { to: '/attendance', label: 'الحضور والانصراف', detail: 'متابعة دوام الفريق', icon: UserCheck, permission: 'view_attendance' },
      { to: '/payroll', label: 'الرواتب', detail: 'الاستحقاقات وكشوف الرواتب', icon: DollarSign, permission: 'view_payroll' },
      { to: '/shifts', label: 'الورديات', detail: 'إدارة الورديات والصناديق', icon: Clock, permission: 'view_shifts' },
      { to: '/branches', label: 'الفروع', detail: 'إعداد ومتابعة الفروع', icon: Building2, permission: 'view_branches' },
      { to: '/expenses', label: 'المصروفات', detail: 'تسجيل ومراجعة المصروفات', icon: Wallet, permission: 'view_expenses' },
    ],
  },
  {
    title: 'المتابعة والإعدادات',
    description: 'الأداء والتقارير وإدارة النظام',
    items: [
      { to: '/', label: 'لوحة التحكم', detail: 'مؤشرات الأداء والملخص اليومي', icon: LayoutDashboard, permission: 'view_dashboard' },
      { to: '/reports', label: 'التقارير', detail: 'تقارير المبيعات والأرباح', icon: FileText, permission: 'view_reports' },
      { to: '/sync-status', label: 'حالة المزامنة', detail: 'متابعة الاتصال والمزامنة', icon: RefreshCw, permission: 'manage_settings' },
      { to: '/settings', label: 'الإعدادات', detail: 'تهيئة المنشأة والنظام', icon: Settings, permission: 'manage_settings' },
    ],
  },
];

export default function Apps() {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const visibleGroups = useMemo(() => groups.map(group => ({
    ...group,
    items: group.items.filter(item =>
      (user?.role === 'admin' || user?.permissions?.includes(item.permission)) &&
      (!query.trim() || `${item.label} ${item.detail}`.toLowerCase().includes(query.trim().toLowerCase()))
    ),
  })).filter(group => group.items.length > 0), [user, query]);
  const count = visibleGroups.reduce((sum, group) => sum + group.items.length, 0);
  const canUsePos = user?.role === 'admin' || user?.permissions?.includes('view_pos');

  return (
    <div className="lineage-page lineage-apps-page apps-hub h-full overflow-y-auto bg-[#f4f6fb] px-4 pb-6 pt-4 sm:px-6" dir="rtl">
      <div className="mx-auto w-full max-w-5xl">
        <section className="lineage-app-launcher-hero relative mb-5 overflow-hidden rounded-[26px] bg-gradient-to-l from-[#18264b] via-[#243b70] to-[#3155a4] p-5 text-white shadow-[0_14px_34px_rgba(25,48,98,0.18)] sm:p-7">
          <div className="pointer-events-none absolute -left-8 -top-12 h-44 w-44 rounded-full border-[24px] border-white/5" />
          <div className="relative flex items-start justify-between gap-3">
            <div>
              <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-bold text-blue-100">
                <Sparkles className="h-3.5 w-3.5" /> مساحة العمل
              </div>
              <h1 className="text-2xl font-black tracking-tight sm:text-3xl">التطبيقات</h1>
              <p className="mt-1.5 max-w-md text-xs leading-6 text-blue-100/85 sm:text-sm">كل أدوات إدارة نشاطك في مكان واحد، مرتبة حسب طبيعة العمل.</p>
            </div>
            <div className="hidden h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-white/15 bg-white/10 sm:flex">
              <LayoutDashboard className="h-7 w-7" />
            </div>
          </div>
          <div className="relative mt-5 flex items-center gap-2 rounded-2xl border border-white/15 bg-white/10 px-3.5 py-3 backdrop-blur">
            <Search className="h-4 w-4 shrink-0 text-blue-100" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="ابحث عن تطبيق أو وظيفة..." className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-blue-100/65" aria-label="البحث في التطبيقات" />
            {query && <button onClick={() => setQuery('')} aria-label="مسح البحث" className="rounded-lg p-1 text-white/80"><X className="h-4 w-4" /></button>}
            <span className="hidden rounded-lg bg-white/10 px-2 py-1 text-[10px] font-bold text-blue-100 sm:inline">{count} تطبيق</span>
          </div>
        </section>

        {canUsePos && <Link to="/pos" className="lineage-app-launcher-featured group mb-6 flex min-h-[94px] items-center justify-between gap-4 rounded-[22px] border border-emerald-200 bg-gradient-to-l from-emerald-50 to-white p-4 shadow-[0_6px_20px_rgba(16,185,129,0.07)] transition hover:border-emerald-300 sm:p-5">
          <div className="flex min-w-0 items-center gap-3.5">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-emerald-600 text-white shadow-lg shadow-emerald-600/20"><ShoppingBag className="h-7 w-7" /></span>
            <span className="min-w-0"><span className="block text-base font-black text-slate-900">بدء عملية بيع</span><span className="mt-1 block text-xs text-slate-500">انتقل مباشرة إلى شاشة الكاشير</span></span>
          </div>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 transition group-hover:-translate-x-1"><ArrowLeft className="h-5 w-5" /></span>
        </Link>}

        {visibleGroups.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-5 py-12 text-center">
            <Search className="mx-auto h-8 w-8 text-slate-300" />
            <p className="mt-3 text-sm font-bold text-slate-700">لا توجد تطبيقات مطابقة</p>
            <p className="mt-1 text-xs text-slate-500">جرّب كلمة بحث أخرى</p>
          </div>
        ) : visibleGroups.map((group, groupIndex) => (
          <section key={group.title} className="lineage-app-launcher-group mb-6">
            <div className="mb-3 flex items-end justify-between gap-3">
              <div><h2 className="text-sm font-black text-slate-900 sm:text-base">{group.title}</h2><p className="mt-1 text-[11px] text-slate-500">{group.description}</p></div>
              <span className="rounded-lg bg-white px-2.5 py-1 text-[10px] font-bold text-slate-500 ring-1 ring-slate-200">{group.items.length} تطبيق</span>
            </div>
            <div className="lineage-app-launcher-grid grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              {group.items.map((item, index) => (
                <Link key={item.to} to={item.to} className="lineage-app-launcher-tile group flex min-h-[112px] min-w-0 flex-col justify-between rounded-[18px] border border-slate-200/90 bg-white p-3.5 shadow-[0_2px_8px_rgba(15,23,42,0.025)] transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md active:scale-[0.99] sm:min-h-[126px] sm:p-4">
                  <span className="flex items-start justify-between gap-2">
                    <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${['bg-indigo-50 text-indigo-700','bg-emerald-50 text-emerald-700','bg-amber-50 text-amber-700','bg-sky-50 text-sky-700'][((groupIndex * 3) + index) % 4]}`}><item.icon className="h-5 w-5" /></span>
                    <ArrowLeft className="mt-1 h-4 w-4 text-slate-300 transition group-hover:-translate-x-0.5 group-hover:text-indigo-500" />
                  </span>
                  <span className="mt-3 block min-w-0"><span className="block truncate text-xs font-extrabold text-slate-800 sm:text-sm">{item.label}</span><span className="mt-1 block line-clamp-2 text-[10px] leading-4 text-slate-500">{item.detail}</span></span>
                </Link>
              ))}
            </div>
          </section>
        ))}
        <p className="pb-2 text-center text-[10px] text-slate-400">تظهر هنا التطبيقات المتاحة حسب صلاحيات حسابك</p>
      </div>
    </div>
  );
}
