import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { toast } from 'react-hot-toast';
import { Lock, User, Grid3X3, Server } from 'lucide-react';
import { useSettings } from '../hooks/useSettings';
import { deletePosSettingsByKey, getFirstPosRecordWhereEquals, putPosSetting } from '../services/posDataAccess';
import { setApiBaseDirect } from '../services/apiService';

export default function Login() {
  const { loginMethod } = useSettings();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pinCode, setPinCode] = useState('');
  const { login } = useAuth();
  
  const [showServerSetup, setShowServerSetup] = useState(false);
  const [serverUrlInput, setServerUrlInput] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);

  useEffect(() => {
    getFirstPosRecordWhereEquals<any>('settings', 'key', 'serverUrl')
      .then((setting) => {
        if (setting?.value) setServerUrlInput(String(setting.value));
      })
      .catch(() => {});
  }, []);

  const handleSaveServerUrl = async () => {
    if (!serverUrlInput.trim()) {
      toast.error('يرجى إدخال رابط السيرفر');
      return;
    }
    if (isConnecting) return;
    setIsConnecting(true);

    let serverUrl = serverUrlInput.trim();
    if (!serverUrl.startsWith('http://') && !serverUrl.startsWith('https://')) {
      serverUrl = `http://${serverUrl}`;
    }
    const apiUrl = serverUrl.endsWith('/') ? `${serverUrl}api` : `${serverUrl}/api`;

    const toastId = toast.loading('جاري اختبار الاتصال بالسيرفر...');

    try {
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

      toast.loading('تم الاتصال بنجاح! جاري جلب إعدادات المتجر...', { id: toastId });

      setApiBaseDirect(serverUrl);

      const publicConfigRes = await fetch(`${apiUrl}/public-config`);
      if (publicConfigRes.ok) {
        const settingsData = await publicConfigRes.json();
        if (Array.isArray(settingsData) && settingsData.length > 0) {
          const filteredSettings = settingsData
            .filter((s: any) => s.key !== 'deviceRole' && s.key !== 'serverUrl')
            .map((s: any) => ({ ...s, syncStatus: 'synced' }));
          if (filteredSettings.length > 0) {
            await Promise.all(filteredSettings.map((setting: any) => putPosSetting(setting.key, setting.value, 'synced')));
          }
        }
      }

      await deletePosSettingsByKey('deviceRole');
      await deletePosSettingsByKey('serverUrl');
      await putPosSetting('deviceRole', 'client', 'synced');
      await putPosSetting('serverUrl', serverUrl, 'synced');

      toast.success('تم ربط الجهاز بالسيرفر! يرجى تسجيل الدخول الآن.', { id: toastId, duration: 3000 });

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
        await login(username.trim(), password);
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
    <div className="lineage-login lineage-login-shell min-h-screen flex items-center justify-center bg-[var(--app-bg)] p-4" dir="rtl">
      <div className="lineage-login-card bg-white theme-card p-8 w-full max-w-md border border-slate-200 rounded-2xl shadow-sm">
        <div className="lineage-login-heading text-center mb-8">
          <div className="w-14 h-14 bg-indigo-50 border border-indigo-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Lock className="w-7 h-7 text-indigo-600" />
          </div>
          <h2 className="text-2xl font-bold text-gray-800">نظام المبيعات والمحاسبة</h2>
          <p className="text-gray-500 text-sm mt-1">يرجى تسجيل الدخول للمتابعة</p>
        </div>

        <form onSubmit={handleSubmit} className="lineage-login-form space-y-6">
          {loginMethod === 'pin' ? (
            <div className="space-y-6">
              <div className="flex justify-center gap-4">
                {[...Array(4)].map((_, i) => (
                  <div 
                    key={i}
                    className={`w-12 h-12 border-2 rounded-xl flex items-center justify-center text-2xl font-bold transition-all tabular-nums ${
                      pinCode.length > i ? 'border-indigo-600 bg-indigo-50 text-indigo-600' : 'border-gray-200 text-gray-300'
                    }`}
                  >
                    {pinCode.length > i ? '●' : ''}
                  </div>
                ))}
              </div>

              <div className="lineage-pin-pad grid grid-cols-3 gap-3">
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map(num => (
                  <button
                    key={num}
                    type="button"
                    onClick={() => handlePinInput(num.toString())}
                    className="h-14 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-xl text-xl font-bold text-gray-700 transition-colors tabular-nums"
                  >
                    {num}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={clearPin}
                  className="h-14 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded-xl text-rose-600 font-bold transition-colors"
                >
                  مسح
                </button>
                <button
                  type="button"
                  onClick={() => handlePinInput('0')}
                  className="h-14 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-xl text-xl font-bold text-gray-700 transition-colors tabular-nums"
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
              <div className="lineage-login-fields space-y-4">
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
                className="w-full bg-indigo-600 text-white py-3 rounded-xl font-bold hover:bg-indigo-700 transition-all shadow-sm"
              >
                دخول للنظام
              </button>
            </>
          )}
        </form>

        <div className="mt-6 pt-4 border-t border-gray-100">
          {!showServerSetup ? (
            <button
              type="button"
              onClick={() => setShowServerSetup(true)}
              className="w-full flex items-center justify-center gap-2 text-indigo-600 hover:text-indigo-800 text-sm font-semibold py-2 rounded-lg hover:bg-indigo-50 transition-colors"
            >
              <Server className="w-4 h-4" />
              ربط بجهاز سيرفر رئيسي (نقطة بيع فرعية LAN)
            </button>
          ) : (
            <div className="bg-gray-50 p-4 rounded-xl space-y-4 border border-gray-200">
              <h3 className="text-sm font-bold text-gray-800 flex items-center gap-2">
                <Server className="w-4 h-4 text-indigo-600" />
                إعداد رابط السيرفر المحلي
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
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none transition-all text-sm font-mono disabled:bg-gray-100"
                  placeholder="192.168.x.x:3000"
                  dir="ltr"
                />
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSaveServerUrl}
                  disabled={isConnecting}
                  className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-sm font-bold hover:bg-indigo-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                >
                  {isConnecting ? 'جاري الاتصال...' : 'حفظ واتصال'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowServerSetup(false)}
                  className="flex-1 bg-white border border-gray-200 text-gray-700 py-2 rounded-lg text-sm font-bold hover:bg-gray-100 transition-all whitespace-nowrap"
                >
                  إلغاء
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
