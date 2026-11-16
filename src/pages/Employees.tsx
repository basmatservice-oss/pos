import { useState, useMemo } from 'react';
import {
  Search,
  Plus,
  Edit2,
  Trash2,
  Users,
  Briefcase,
  Phone,
  Calendar,
  DollarSign,
  X,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, Employee } from '../db/db';
import { format } from 'date-fns';
import { useSettings } from '../hooks/useSettings';
import { PERMISSIONS } from '../constants';
import { useAuth } from '../context/AuthContext';
import { dispatchOperation } from '../services/operationService';
import ConfirmationModal from '../components/ConfirmationModal';

export default function Employees() {
  const { user } = useAuth();
  const storeSettings = useSettings();
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingEmployee, setEditingEmployee] = useState<Employee | null>(null);
  const [employeeToDelete, setEmployeeToDelete] = useState<Employee | null>(null);

  // Data State using Dexie Live Query
  const allEmployees = useLiveQuery(() => db.employees.toArray()) || [];

  const employees = useMemo(() => {
    if (!searchQuery) return allEmployees;
    const q = searchQuery.toLowerCase();
    return allEmployees.filter(
      (e) =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.phone || '').includes(searchQuery) ||
        (e.role || '').toLowerCase().includes(q)
    );
  }, [allEmployees, searchQuery]);

  // Form State
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'manager' | 'cashier' | 'sales_rep'>('cashier');
  const [phone, setPhone] = useState('');
  const [salary, setSalary] = useState('');
  const [salaryType, setSalaryType] = useState<'monthly' | 'hourly'>('monthly');
  const [joinDate, setJoinDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [status, setStatus] = useState<'active' | 'inactive'>('active');
  const [pinCode, setPinCode] = useState('');
  const [deviceType, setDeviceType] = useState<'desktop' | 'mobile'>('desktop');
  const [permissions, setPermissions] = useState<string[]>([]);

  const openModal = (employee?: Employee) => {
    if (employee) {
      setEditingEmployee(employee);
      setName(employee.name);
      setUsername(employee.username);
      setPassword('');
      setRole(employee.role as 'admin' | 'manager' | 'cashier' | 'sales_rep');
      setPhone(employee.phone);
      setSalary(employee.salary.toString());
      setSalaryType(employee.salaryType === 'hourly' ? 'hourly' : 'monthly');
      setJoinDate(employee.joinDate ? employee.joinDate.split('T')[0] : format(new Date(), 'yyyy-MM-dd'));
      setStatus(employee.status);
      // Never pre-fill PIN hash into the 4-digit input!
      setPinCode('');
      setDeviceType(employee.deviceType || 'desktop');
      setPermissions(employee.permissions || []);
    } else {
      setEditingEmployee(null);
      setName('');
      setUsername('');
      setPassword('');
      setRole('cashier');
      setPhone('');
      setSalary('');
      setSalaryType('monthly');
      setJoinDate(format(new Date(), 'yyyy-MM-dd'));
      setStatus('active');
      setPinCode('');
      setDeviceType('desktop');
      setPermissions([]);
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingEmployee(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (
      !name.trim() ||
      !role ||
      !phone.trim() ||
      salary === '' ||
      !joinDate ||
      (!editingEmployee && (!username.trim() || !password))
    ) {
      toast.error('يرجى إدخال جميع الحقول المطلوبة');
      return;
    }

    const salaryNum = parseFloat(salary);
    if (isNaN(salaryNum) || salaryNum < 0) {
      toast.error('قيمة الراتب غير صحيحة');
      return;
    }

    if (pinCode.trim() && !/^\d{4}$/.test(pinCode.trim())) {
      toast.error('رمز PIN يجب أن يتكون من 4 أرقام');
      return;
    }

    const now = new Date().toISOString();

    try {
      const record: any = {
        id: editingEmployee?.id ?? Date.now() * 1000 + Math.floor(Math.random() * 1000),
        name: name.trim(),
        username: username.trim(),
        role,
        phone: phone.trim(),
        salary: salaryNum,
        salaryType,
        branchId: editingEmployee?.branchId ?? user?.branchId,
        joinDate,
        status,
        deviceType,
        permissions,
        createdAt: editingEmployee?.createdAt || now,
        updatedAt: now,
      };

      if (password.trim()) {
        record.password = password;
      } else if (editingEmployee?.password) {
        record.password = editingEmployee.password;
      }

      if (pinCode.trim()) {
        record.pinCode = pinCode.trim();
      } else if (editingEmployee?.pinCode) {
        record.pinCode = editingEmployee.pinCode;
      }

      await dispatchOperation('entity_upsert', { table: 'employees', record }, user?.branchId);

      toast.success(editingEmployee ? 'تم تحديث بيانات الموظف بنجاح' : 'تمت إضافة الموظف بنجاح');
      closeModal();
    } catch (error: any) {
      console.error('Error saving employee:', error);
      toast.error(error?.message || 'حدث خطأ أثناء حفظ بيانات الموظف');
    }
  };

  const confirmDeleteEmployee = async () => {
    if (!employeeToDelete?.id) return;
    if (user?.id === employeeToDelete.id) {
      toast.error('لا يمكنك حذف حسابك الحالي');
      setEmployeeToDelete(null);
      return;
    }

    try {
      await dispatchOperation(
        'entity_delete',
        { table: 'employees', id: employeeToDelete.id },
        user?.branchId
      );
      toast.success('تم حذف الموظف بنجاح');
      setEmployeeToDelete(null);
    } catch (error: any) {
      console.error('Error deleting employee:', error);
      toast.error(error?.message || 'حدث خطأ أثناء حذف الموظف');
      setEmployeeToDelete(null);
    }
  };

  return (
    <div className="p-6 h-full flex flex-col bg-[var(--app-bg)]" dir="rtl">
      <div className="flex justify-between items-center mb-6 shrink-0 gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">الموظفون</h2>
          <p className="text-slate-500 text-sm mt-1">إدارة فريق العمل والصلاحيات ونظام الرواتب</p>
        </div>
        <button
          onClick={() => openModal()}
          className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2.5 rounded-xl text-sm font-bold flex items-center gap-2 transition-colors whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          إضافة موظف
        </button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="p-4 border-b border-slate-200 flex gap-4 bg-slate-50/60 shrink-0">
          <div className="relative flex-1 max-w-md">
            <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
              <Search className="h-4 w-4 text-slate-400" />
            </div>
            <input
              type="text"
              className="block w-full pl-3 pr-9 py-2 border border-slate-200 rounded-xl bg-white text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="ابحث باسم الموظف، المسمى الوظيفي، أو رقم الهاتف..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto custom-scrollbar">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50 sticky top-0 z-10 text-slate-500 text-xs font-bold">
              <tr>
                <th className="px-6 py-3.5 text-right">اسم الموظف</th>
                <th className="px-6 py-3.5 text-right">المسمى الوظيفي</th>
                <th className="px-6 py-3.5 text-right">رقم الهاتف</th>
                <th className="px-6 py-3.5 text-right">الراتب / النظام</th>
                <th className="px-6 py-3.5 text-right">تاريخ الانضمام</th>
                <th className="px-6 py-3.5 text-right">الحالة</th>
                <th className="px-6 py-3.5 text-center">الإجراءات</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-slate-100 text-sm">
              {employees.map((employee) => (
                <tr key={employee.id} className="hover:bg-slate-50/70 transition-colors">
                  <td className="px-6 py-3.5 whitespace-nowrap">
                    <div className="flex items-center gap-3">
                      <div className="flex-shrink-0 h-9 w-9 bg-indigo-50 border border-indigo-200 rounded-lg flex items-center justify-center">
                        <Users className="h-4 w-4 text-indigo-600" />
                      </div>
                      <div>
                        <div className="font-bold text-slate-900">{employee.name}</div>
                        <div className="text-xs text-slate-400 font-mono">@{employee.username}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap">
                    <div className="flex items-center text-slate-600">
                      <Briefcase className="w-4 h-4 ml-1.5 text-slate-400" />
                      {employee.role === 'admin'
                        ? 'مدير النظام'
                        : employee.role === 'manager'
                        ? 'مدير فرع'
                        : employee.role === 'sales_rep'
                        ? 'مندوب مبيعات'
                        : 'كاشير'}
                    </div>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap">
                    <div className="flex items-center text-slate-600 font-mono tabular-nums">
                      <Phone className="w-4 h-4 ml-1.5 text-slate-400" />
                      {employee.phone}
                    </div>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap tabular-nums">
                    <div className="flex items-center gap-1.5 font-bold text-slate-900">
                      <DollarSign className="w-4 h-4 text-emerald-500" />
                      <span>
                        {employee.salary.toFixed(2)} {storeSettings.currency}
                      </span>
                      <span className="text-[11px] font-bold px-2 py-0.5 rounded-md border bg-slate-50 border-slate-200 text-slate-600">
                        {employee.salaryType === 'hourly' ? 'بالساعة' : 'شهري'}
                      </span>
                    </div>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap text-slate-500 tabular-nums">
                    <div className="flex items-center">
                      <Calendar className="w-4 h-4 ml-1.5 text-slate-400" />
                      {employee.joinDate ? employee.joinDate.split('T')[0] : '-'}
                    </div>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap">
                    <span
                      className={`px-2.5 py-1 inline-flex text-xs font-bold rounded-lg border ${
                        employee.status === 'active'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : 'bg-slate-100 text-slate-600 border-slate-200'
                      }`}
                    >
                      {employee.status === 'active' ? 'نشط' : 'غير نشط'}
                    </span>
                  </td>
                  <td className="px-6 py-3.5 whitespace-nowrap text-center">
                    <div className="flex items-center justify-center gap-1.5">
                      <button
                        onClick={() => openModal(employee)}
                        className="text-indigo-600 hover:bg-indigo-50 p-2 rounded-lg transition-colors"
                        title="تعديل"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() =>
                          user?.id === employee.id
                            ? toast.error('لا يمكنك حذف حسابك الحالي')
                            : setEmployeeToDelete(employee)
                        }
                        className="text-rose-600 hover:bg-rose-50 p-2 rounded-lg transition-colors"
                        title="حذف"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {employees.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-slate-400">
                    <Users className="mx-auto h-10 w-10 text-slate-300 mb-2" />
                    <p className="text-base font-bold text-slate-700">لا يوجد موظفون</p>
                    <p className="text-xs">قم بإضافة موظفين جدد لإدارة فريق العمل</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add/Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
            <div className="flex justify-between items-center p-4 border-b border-slate-200 bg-slate-50 flex-shrink-0">
              <h3 className="text-base font-bold text-slate-900">
                {editingEmployee ? 'تعديل بيانات الموظف' : 'إضافة موظف جديد'}
              </h3>
              <button
                onClick={closeModal}
                className="text-slate-400 hover:text-slate-600 p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form
              onSubmit={handleSubmit}
              className="p-5 flex flex-col gap-4 overflow-y-auto custom-scrollbar flex-1"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">اسم الموظف *</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full px-3.5 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="أدخل اسم الموظف"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">اسم المستخدم *</label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full px-3.5 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none text-left"
                    dir="ltr"
                    placeholder="username"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    كلمة المرور {editingEmployee ? '(اختياري للتحديث)' : '*'}
                  </label>
                  <input
                    type="password"
                    required={!editingEmployee}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3.5 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder={
                      editingEmployee ? 'اتركه فارغاً للإبقاء على الحالي' : 'أدخل كلمة المرور'
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    رمز PIN (4 أرقام) {editingEmployee ? '(اختياري للتحديث)' : ''}
                  </label>
                  <input
                    type="text"
                    maxLength={4}
                    value={pinCode}
                    onChange={(e) => setPinCode(e.target.value.replace(/\D/g, ''))}
                    className="w-full px-3.5 py-2 border border-slate-200 rounded-xl text-sm font-mono focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder={editingEmployee ? 'اتركه فارغاً للإبقاء على الحالي' : '1234'}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">المسمى الوظيفي *</label>
                  <select
                    value={role}
                    onChange={(e) =>
                      setRole(e.target.value as 'admin' | 'manager' | 'cashier' | 'sales_rep')
                    }
                    className="w-full px-3.5 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                  >
                    <option value="cashier">كاشير</option>
                    <option value="admin">مدير النظام</option>
                    <option value="manager">مدير فرع</option>
                    <option value="sales_rep">مندوب مبيعات</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">نوع الواجهة</label>
                  <select
                    value={deviceType}
                    onChange={(e) => setDeviceType(e.target.value as 'desktop' | 'mobile')}
                    className="w-full px-3.5 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                  >
                    <option value="desktop">كمبيوتر (واجهة كاملة)</option>
                    <option value="mobile">هاتف / تابلت (واجهة مبسطة)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">نظام الراتب</label>
                  <select
                    value={salaryType}
                    onChange={(e) => setSalaryType(e.target.value as 'monthly' | 'hourly')}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                  >
                    <option value="monthly">راتب شهري ثابت</option>
                    <option value="hourly">أجر بالساعة</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">
                    {salaryType === 'hourly' ? 'أجر الساعة *' : 'الراتب الشهري *'}
                  </label>
                  <input
                    type="number"
                    required
                    min="0"
                    step="0.01"
                    value={salary}
                    onChange={(e) => setSalary(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm tabular-nums focus:ring-2 focus:ring-indigo-500 outline-none text-left"
                    dir="ltr"
                    placeholder="0.00"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">رقم الهاتف *</label>
                  <input
                    type="tel"
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none text-left"
                    dir="ltr"
                    placeholder="05xxxxxxxx"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">تاريخ الانضمام *</label>
                  <input
                    type="date"
                    required
                    value={joinDate}
                    onChange={(e) => setJoinDate(e.target.value)}
                    className="w-full px-3.5 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1.5">الحالة</label>
                  <select
                    value={status}
                    onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}
                    className="w-full px-3.5 py-2 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                  >
                    <option value="active">نشط</option>
                    <option value="inactive">غير نشط</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-2">الصلاحيات</label>
                <div className="grid grid-cols-2 gap-2 p-3 bg-slate-50 rounded-xl border border-slate-200 max-h-48 overflow-y-auto custom-scrollbar">
                  {PERMISSIONS.map((perm) => (
                    <label
                      key={perm.id}
                      className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={permissions.includes(perm.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setPermissions([...permissions, perm.id]);
                          } else {
                            setPermissions(permissions.filter((p) => p !== perm.id));
                          }
                        }}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      {perm.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="pt-2 flex gap-2.5">
                <button
                  type="button"
                  onClick={closeModal}
                  className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-700 rounded-xl hover:bg-slate-50 text-sm font-bold"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 text-sm font-bold"
                >
                  حفظ
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmationModal
        isOpen={Boolean(employeeToDelete)}
        variant="danger"
        title="حذف الموظف"
        message={
          employeeToDelete
            ? `هل أنت متأكد من حذف الموظف "${employeeToDelete.name}"؟`
            : ''
        }
        confirmLabel="حذف الموظف"
        onConfirm={confirmDeleteEmployee}
        onCancel={() => setEmployeeToDelete(null)}
      />
    </div>
  );
}
