import React, { createContext, useContext, useState, useEffect } from 'react';
import bcrypt from 'bcryptjs';
import { getFirstPosRecordWhereEquals, getPosRecords, putPosRecord, putPosSetting } from '../services/posDataAccess';
import { usePosRecordsWhereEquals } from '../hooks/usePosRecordsWhereEquals';
import { API_BASE, setAuthToken, getAuthToken } from '../services/apiService';
import { isNativeAndroid } from '../native/posLocalDatabase';

export type Role = 'admin' | 'manager' | 'cashier' | 'sales_rep';

export interface AuthUser {
  id: number;
  name: string;
  username?: string;
  role: Role;
  deviceType: 'desktop' | 'mobile';
  permissions?: string[];
  branchId?: number;
  mustChangePassword?: boolean;
}

interface OfflineVerifier {
  user: AuthUser;
  passwordHash?: string;
  pinHash?: string;
}

const OFFLINE_VERIFIERS_KEY = 'pos_offline_verifiers';

function loadOfflineVerifiers(): OfflineVerifier[] {
  try {
    const raw = localStorage.getItem(OFFLINE_VERIFIERS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveOfflineVerifier(user: AuthUser, password?: string, pinCode?: string) {
  try {
    const list = loadOfflineVerifiers().filter((v) => v.user.id !== user.id);
    const existing = loadOfflineVerifiers().find((v) => v.user.id === user.id);
    list.push({
      user,
      passwordHash: password ? bcrypt.hashSync(password, 8) : existing?.passwordHash,
      pinHash: pinCode ? bcrypt.hashSync(pinCode, 8) : existing?.pinHash,
    });
    localStorage.setItem(OFFLINE_VERIFIERS_KEY, JSON.stringify(list));
  } catch {
    // Ignore storage errors
  }
}

function matchSecret(plain: string, stored?: string): boolean {
  if (!plain || !stored) return false;
  if (stored.startsWith('$2')) {
    return bcrypt.compareSync(plain, stored);
  }
  return stored === plain;
}

class ServerAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ServerAuthError';
  }
}

interface AuthContextType {
  user: AuthUser | null;
  login: (username?: string, password?: string, pinCode?: string) => Promise<void>;
  logout: () => void;
  updateCurrentUser: (patch: Partial<AuthUser>) => void;
  changeLocalCredentials: (currentPassword: string, newPassword: string, newPinCode?: string) => Promise<void>;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const dbUsers = usePosRecordsWhereEquals<Record<string, any>>('employees', 'id', user?.id ?? -1);
  const dbUser = dbUsers[0];

  useEffect(() => {
    if (dbUser && user) {
      const updatedUser: AuthUser = {
        ...user,
        name: dbUser.name || user.name,
        role: dbUser.role as Role,
        permissions: dbUser.permissions || [],
        deviceType: dbUser.deviceType || 'desktop',
        branchId: dbUser.branchId,
        mustChangePassword:
          typeof dbUser.mustChangePassword === 'boolean'
            ? dbUser.mustChangePassword
            : user.mustChangePassword,
      };

      if (
        user.role !== updatedUser.role ||
        user.name !== updatedUser.name ||
        JSON.stringify(user.permissions) !== JSON.stringify(updatedUser.permissions) ||
        user.deviceType !== updatedUser.deviceType ||
        user.branchId !== updatedUser.branchId ||
        user.mustChangePassword !== updatedUser.mustChangePassword
      ) {
        setUser(updatedUser);
        localStorage.setItem('user', JSON.stringify(updatedUser));
      }
    }
  }, [dbUser, user]);

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    const token = getAuthToken();
    if (storedUser && token) {
      try {
        setUser(JSON.parse(storedUser));
      } catch {
        localStorage.removeItem('user');
      }
    } else if (storedUser && !token) {
      // Only restore without JWT if explicitly created during offline LAN outage;
      // otherwise clear stale legacy session so user obtains a fresh JWT token on login.
      try {
        const parsed = JSON.parse(storedUser);
        if (parsed?.isOfflineSession) {
          setUser(parsed);
        } else {
          localStorage.removeItem('user');
        }
      } catch {
        localStorage.removeItem('user');
      }
    }
    setIsLoading(false);
  }, []);

  const updateCurrentUser = (patch: Partial<AuthUser>) => {
    setUser((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      localStorage.setItem('user', JSON.stringify(next));
      return next;
    });
  };

  const changeLocalCredentials = async (currentPassword: string, newPassword: string, newPinCode?: string) => {
    if (!isNativeAndroid()) throw new Error('تغيير بيانات الدخول محلياً متاح فقط على جهاز Android المستقل');
    const role = await getFirstPosRecordWhereEquals<{ key: string; value: any }>('settings', 'key', 'deviceRole');
    if (role?.value === 'client') throw new Error('جهاز العميل يغيّر بيانات الدخول من الخادم');
    if (!user?.id) throw new Error('لا يوجد مستخدم مسجل لتحديث بيانات دخوله');
    if (!currentPassword || !newPassword || newPassword.length < 6 || newPassword === 'admin') {
      throw new Error('يرجى إدخال كلمة المرور الحالية وكلمة مرور جديدة لا تقل عن 6 أحرف ولا تكون كلمة المرور الافتراضية');
    }
    if (newPinCode && (!/^\d{4,}$/.test(newPinCode) || newPinCode === '1234')) {
      throw new Error('رمز PIN يجب أن يتكون من أربعة أرقام على الأقل وألا يكون الرمز الافتراضي');
    }
    const verifiers = loadOfflineVerifiers();
    const verifier = verifiers.find((entry) => entry.user.id === user.id);
    const employees = await getPosRecords<Record<string, any>>('employees');
    const employee = employees.find((entry) => Number(entry.id) === Number(user.id));
    const currentMatches =
      matchSecret(currentPassword, verifier?.passwordHash) ||
      matchSecret(currentPassword, employee?.password);
    if (!currentMatches) throw new Error('كلمة المرور الحالية غير صحيحة');

    const passwordHash = bcrypt.hashSync(newPassword, 10);
    const pinHash = newPinCode ? bcrypt.hashSync(newPinCode, 10) : verifier?.pinHash;
    if (!employee) throw new Error('سجل الموظف غير موجود في قاعدة SQLite المحلية؛ لم يتم تغيير بيانات الدخول');
    await putPosRecord('employees', {
      ...employee,
      password: passwordHash,
      ...(newPinCode ? { pinCode: bcrypt.hashSync(newPinCode, 10) } : {}),
      mustChangePassword: false,
      syncStatus: 'local',
    }, 'local');

    const nextVerifiers = verifiers.filter((entry) => entry.user.id !== user.id);
    nextVerifiers.push({ user: { ...user, mustChangePassword: false }, passwordHash, pinHash });
    // Store the offline verifier only after the authoritative SQLite row commits.
    localStorage.setItem(OFFLINE_VERIFIERS_KEY, JSON.stringify(nextVerifiers));
    const updatedUser = { ...user, mustChangePassword: false };
    setUser(updatedUser);
    localStorage.setItem('user', JSON.stringify(updatedUser));
  };

  const login = async (username?: string, password?: string, pinCode?: string) => {
    const cleanUsername = username?.trim();
    let baseUrl = API_BASE;
    const [serverUrlSetting, roleSetting] = await Promise.all([
      getFirstPosRecordWhereEquals<{ key: string; value: any }>('settings', 'key', 'serverUrl'),
      getFirstPosRecordWhereEquals<{ key: string; value: any }>('settings', 'key', 'deviceRole'),
    ]);
    if (roleSetting?.value === 'client' && serverUrlSetting?.value) {
      const raw = serverUrlSetting.value.trim();
      const formatted = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `http://${raw}`;
      baseUrl = formatted.endsWith('/') ? `${formatted}api` : `${formatted}/api`;
    }

    const loginUrl = `${baseUrl}/login`;

    // On Android, only an explicitly configured LAN client uses server auth.
    // Legacy/missing roles are normalized to standalone and stay on local SQLite.
    const isStandalone = isNativeAndroid() && roleSetting?.value !== 'client';
    if (isStandalone) {
      setAuthToken(null);
      if (roleSetting?.value !== 'standalone') await putPosSetting('deviceRole', 'standalone', 'local');
    }
    // Server and LAN-client devices retain online authentication and its server-side rate limits.
    let networkFailed = isStandalone;
    if (!networkFailed) {
      try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(loginUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: cleanUsername, password, pinCode }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        const serverUser: AuthUser = data.user || data;
        if (data.token) {
          setAuthToken(data.token);
        }
        saveOfflineVerifier(serverUser, password, pinCode);
        setUser(serverUser);
        localStorage.setItem('user', JSON.stringify(serverUser));

        // Trigger initial pull in background so client gets synced data right after login
        import('../services/syncService')
          .then(({ syncService }) => syncService.syncAll().catch(() => {}))
          .catch(() => {});
        return;
      }

      const errBody = await response.json().catch(() => ({}));
      if (response.status >= 400 && response.status < 500) {
        throw new ServerAuthError(errBody.message || errBody.error || 'بيانات الدخول غير صحيحة');
      }
      throw new Error(errBody.message || errBody.error || 'Server error');
    } catch (err: any) {
      if (err instanceof ServerAuthError) {
        throw err;
      }
        networkFailed = true;
      }
    }

    if (!networkFailed) {
      throw new Error('بيانات الدخول غير صحيحة');
    }

    // 2. Offline LAN fallback: check locally cached bcrypt verifiers first
    const verifiers = loadOfflineVerifiers();
    if (pinCode) {
      const matched = verifiers.find((v) => matchSecret(pinCode, v.pinHash));
      if (matched) {
        const offlineUser = { ...matched.user, isOfflineSession: true };
        setUser(offlineUser);
        localStorage.setItem('user', JSON.stringify(offlineUser));
        return;
      }
    } else if (cleanUsername && password) {
      const matched = verifiers.find(
        (v) =>
          v.user.username?.toLowerCase() === cleanUsername.toLowerCase() &&
          matchSecret(password, v.passwordHash)
      );
      if (matched) {
        const offlineUser = { ...matched.user, isOfflineSession: true };
        setUser(offlineUser);
        localStorage.setItem('user', JSON.stringify(offlineUser));
        return;
      }
    }

    // 3. Fallback to locally stored employees when the network is unavailable.
    const employees = await getPosRecords<Record<string, any>>('employees');
    if (pinCode) {
      const employee = employees.find((e) => e.status === 'active' && matchSecret(pinCode, e.pinCode));
      if (employee) {
        const userData: AuthUser & { isOfflineSession?: boolean } = {
          id: employee.id!,
          name: employee.name,
          username: employee.username,
          role: employee.role,
          deviceType: employee.deviceType,
          permissions: employee.permissions || [],
          branchId: employee.branchId,
          mustChangePassword: Boolean(employee.mustChangePassword),
          isOfflineSession: true,
        };
        setUser(userData);
        localStorage.setItem('user', JSON.stringify(userData));
        return;
      }
    } else if (cleanUsername && password) {
      const employee = employees.find(
        (e) => e.status === 'active' && e.username?.toLowerCase() === cleanUsername.toLowerCase()
      );
      if (employee && matchSecret(password, employee.password)) {
        const userData: AuthUser & { isOfflineSession?: boolean } = {
          id: employee.id!,
          name: employee.name,
          username: employee.username,
          role: employee.role,
          deviceType: employee.deviceType,
          permissions: employee.permissions || [],
          branchId: employee.branchId,
          mustChangePassword: Boolean(employee.mustChangePassword),
          isOfflineSession: true,
        };
        setUser(userData);
        localStorage.setItem('user', JSON.stringify(userData));
        return;
      }
    }

    throw new Error('تعذر الاتصال بالسيرفر، وبيانات الدخول غير متطابقة محلياً');
  };

  const logout = () => {
    setUser(null);
    setAuthToken(null);
    localStorage.removeItem('user');
  };

  return (
    <AuthContext.Provider value={{ user, login, logout, updateCurrentUser, changeLocalCredentials, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
