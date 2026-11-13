import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { toast } from 'react-hot-toast';
import { Lock, User, Grid3X3, Server } from 'lucide-react';
import { useSettings } from '../hooks/useSettings';
import { db } from '../db/db';
import { setApiBaseDirect } from '../services/apiService';

export default function Login() {
  const { loginMethod } = useSettings();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pinCode, setPinCode] = useState('');
  const { login } = useAuth();
  
  const [showServerSetup, setShowServerSetup] = useState(false);
  const [serverUrlInput, setServerUrlInput] = useState('');
  const [isClientMode, setIsClientMode] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isClient = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
      setIsClientMode(isClient);
    }
  }, []);

  const handleSaveServerUrl = async () => {
    if (!serverUrlInput.trim()) {
      toast.error('يرجى إدخال رابط السيرفر');
      return;
    }
    if (isConnecting) return;
    setIsConnecting(true);

    // Format the URL
    let serverUrl = serverUrlInput.trim();
    if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
      serverUrl = `http://${serverUrl}`;
    }
    const apiUrl = serverUrl.endsWith('/') ? `${serverUrl}api` : `${serverUrl}/api`;

    const toastId = toast.loading('جاري اختبار الاتصال بالسيرفر...');

    try {
      // الخطوة 1: اختبار الاتصال بالسيرفر مباشرة
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      let testResponse;
      try {
        testResponse = await fetch(`${apiUrl}/health`, { signal: controller.signal });
        clearTimeout(timeoutId);
      } catch (fetchErr: any) {
        clearTimeout(timeoutId);
        if (fetchErr.name === 'AbortError') {
          toast.error('انتهت مهلة الاتصال (5 ثوانٍ)! تأكد أن السيرفر يعمل والرابط صحيح.', { id: toastId, duration: 6000 });
        } else {
          toast.error(`فشل الاتصال بالسيرفر! تأكد من الرابط: ${serverUrl}`, { id: toastId, duration: 6000 });
        }
        setIsConnecting(false);
        return;
      }

      if (!testResponse.ok) {
        toast.error('السيرفر يستجيب لكن هناك خطأ. تأكد أن السيرفر يعمل بشكل صحيح.', { id: toastId, duration: 6000 });
        setIsConnecting(false);
        return;
      }

      toast.loading('تم الاتصال بنجاح! جاري جلب البيانات...', { id: toastId });

      // الخطوة 2: تعيين API_BASE مباشرة (بدون قراءة من Dexie)
      setApiBaseDirect(serverUrl);

      // الخطوة 3: جلب الموظفين والإعدادات مباشرة عبر fetch
      const [employeesRes, settingsRes] = await Promise.all([
        fetch(`${apiUrl}/employees`),
        fetch(`${apiUrl}/settings`)
      ]);

      const employeesData = await employeesRes.json();
      const settingsData = await settingsRes.json();

      // الخطوة 4: حفظ الموظفين في Dexie المحلي
      if (Array.isArray(employeesData) && employeesData.length > 0) {
        await db.employees.bulkPut(
          employeesData.map((e: any) => ({ ...e, syncStatus: 'synced' }))
        );
      }

      // الخطوة 5: حفظ الإعدادات مع استثناء deviceRole و serverUrl (لا نريد أن يكتب السيرفر فوقها)
      if (Array.isArray(settingsData) && settingsData.length > 0) {
        const filteredSettings = settingsData
          .filter((s: any) => s.key !== 'deviceRole' && s.key !== 'serverUrl')
          .map((s: any) => ({ ...s, syncStatus: 'synced' }));
        if (filteredSettings.length > 0) {
          await db.settings.bulkPut(filteredSettings);
        }
      }

      // الخطوة 6: حفظ إعدادات الجهاز الطرفي (حذف أي سجلات مكررة أولاً)
      await db.settings.where('key').equals('deviceRole').delete();
      await db.settings.where('key').equals('serverUrl').delete();
      await db.settings.add({ key: 'deviceRole', value: 'client', syncStatus: 'synced', updatedAt: new Date().toISOString() });
      await db.settings.add({ key: 'serverUrl', value: serverUrl, syncStatus: 'synced', updatedAt: new Date().toISOString() });

      toast.success('تم الاتصال وجلب البيانات بنجاح! جاري إعادة التحميل...', { id: toastId, duration: 3000 });

      // الخطوة 7: إعادة تحميل الصفحة لتفعيل الوضع الجديد بالكامل
      setTimeout(() => {
        window.location.reload();
      }, 1500);

    } catch (e: any) {
      console.error('Server setup error:', e);
      toast.error('حدث خطأ غير متوقع أثناء الإعداد: ' + (e.message || ''), { id: toastId, duration: 6000 });
      setIsConnecting(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (loginMethod === 'pin') {
        await login(undefined, undefined, pinCode);
      } else {
        await login(username, password);
      }
      toast.success('تم تسجيل الدخول بنجاح');
    } catch (error: any) {
      toast.error(error.message || 'بيانات الدخول غير صحيحة');
    }
  };

  const handlePinInput = (digit: string) => {
    if (pinCode.length < 4) {
      setPinCode(prev => prev + digit);
    }
  };

  const clearPin = () => setPinCode('');

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--app-bg)] p-4">
      <div className="bg-white theme-card p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-indigo-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Lock className="w-8 h-8 text-indigo-600" />
          </div>
          <h2 className="text-2xl font-bold text-gray-800">نظام المبيعات الذكي</h2>
          <p className="text-gray-500 mt-1">يرجى تسجيل الدخول للمتابعة</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {loginMethod === 'pin' ? (
            <div className="space-y-6">
              <div className="flex justify-center gap-4">
                {[...Array(4)].map((_, i) => (
                  <div 
                    key={i}
                    className={`w-12 h-12 border-2 rounded-xl flex items-center justify-center text-2xl font-bold transition-all ${
                      pinCode.length > i ? 'border-indigo-600 bg-indigo-50 text-indigo-600' : 'border-gray-200 text-gray-300'
                    }`}
                  >
                    {pinCode.length > i ? '●' : ''}
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-3 gap-3">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => handlePinInput(num.toString())}
                    className="h-14 bg-gray-50 hover:bg-gray-100 rounded-xl text-xl font-bold text-gray-700 transition-colors"
                  >
                    {num}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={clearPin}
                  className="h-14 bg-rose-50 hover:bg-rose-100 rounded-xl text-rose-600 font-bold transition-colors"
                >
                  مسح
                </button>
                <button
                  type="button"
                  onClick={() => handlePinInput('0')}
                  className="h-14 bg-gray-50 hover:bg-gray-100 rounded-xl text-xl font-bold text-gray-700 transition-colors"
                >
                  0
                </button>
                <button
                  type="submit"
                  disabled={pinCode.length !== 4}
                  className="h-14 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl text-white font-bold transition-colors"
                >
                  دخول
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">اسم المستخدم</label>
                  <div className="relative">
                    <User className="absolute left-3 top-3 h-5 w-5 text-gray-400" />
                    <input
                      type="text"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      required
                      placeholder="أدخل اسم المستخدم"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">كلمة المرور</label>
                  <div className="relative">
                    <Lock className="absolute left-3 top-3 h-5 w-5 text-gray-400" />
                    <input
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full pl-10 pr-4 py-2.5 border border-gray-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                      required
                      placeholder="أدخل كلمة المرور"
                    />
                  </div>
                </div>
              </div>
              <button 
                type="submit" 
                className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
              >
                دخول للنظام
              </button>
            </>
          )}
        </form>

        {isClientMode && (
          <div className="mt-6">
            {!showServerSetup ? (
              <button
                type="button"
                onClick={() => setShowServerSetup(true)}
                className="w-full text-indigo-600 hover:text-indigo-800 text-sm font-medium transition-colors"
              >
                إعداد السيرفر (للعمل كجهاز طرفي)
              </button>
            ) : (
              <div className="bg-gray-50 p-4 rounded-xl space-y-4 border border-gray-100">
                <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                  <Server className="w-4 h-4 text-indigo-600" />
                  إعداد رابط السيرفر
                </h3>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">رابط السيرفر الأساسي (مثل: 192.168.1.100:3000)</label>
                  <input
                    type="text"
                    value={serverUrlInput}
                    onChange={(e) => setServerUrlInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleSaveServerUrl();
                      }
                    }}
                    disabled={isConnecting}
                    className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm disabled:bg-gray-100"
                    placeholder="192.168.x.x:3000"
                    dir="ltr"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleSaveServerUrl}
                    disabled={isConnecting}
                    className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-bold hover:bg-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isConnecting ? 'جاري الاتصال...' : 'حفظ واتصال'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowServerSetup(false)}
                    className="flex-1 bg-gray-200 text-gray-700 py-2 rounded-lg text-sm font-bold hover:bg-gray-300 transition-all"
                  >
                    إلغاء
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="mt-8 pt-6 border-t border-gray-100 text-center">
          <p className="text-xs text-gray-400">
            © 2026 نظام المبيعات المتكامل. جميع الحقوق محفوظة.
          </p>
        </div>
      </div>
    </div>
  );
}
