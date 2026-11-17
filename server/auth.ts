import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { db } from '../drizzle/db.js';
import { settings } from '../drizzle/schema.js';

export interface AuthPayload {
  userId: number;
  username: string;
  name: string;
  role: 'admin' | 'manager' | 'cashier' | 'sales_rep';
  branchId?: number | null;
  deviceType?: string | null;
  permissions: string[];
  iat: number;
  exp: number;
}

export interface AuthenticatedRequest extends Request {
  authUser?: AuthPayload;
}

let cachedAuthSecret: string | null = null;

export async function getAuthSecret(): Promise<string> {
  if (process.env.AUTH_SECRET && process.env.AUTH_SECRET.length >= 16) {
    return process.env.AUTH_SECRET;
  }
  if (cachedAuthSecret) return cachedAuthSecret;

  try {
    const existing = await db.select().from(settings).where(eq(settings.key, 'authSecret'));
    if (existing.length > 0 && existing[0].value) {
      cachedAuthSecret = existing[0].value;
      return cachedAuthSecret;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    const now = new Date().toISOString();
    await db
      .insert(settings)
      .values({ key: 'authSecret', value: generated, isSynced: 0, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    cachedAuthSecret = generated;
    return generated;
  } catch {
    cachedAuthSecret = crypto.randomBytes(32).toString('hex');
    return cachedAuthSecret;
  }
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(normalized, 'base64').toString('utf8');
}

export async function signToken(
  user: Omit<AuthPayload, 'iat' | 'exp'>,
  ttlSeconds = 60 * 60 * 24 * 30
): Promise<string> {
  const secret = await getAuthSecret();
  const nowSec = Math.floor(Date.now() / 1000);
  const payload: AuthPayload = {
    ...user,
    iat: nowSec,
    exp: nowSec + ttlSeconds,
  };
  const headerB64 = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const sig = base64UrlEncode(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

export async function verifyToken(token: string): Promise<AuthPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const secret = await getAuthSecret();
    const expectedSig = base64UrlEncode(
      crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest()
    );
    const sigBuf = Buffer.from(sigB64);
    const expectedBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as AuthPayload;
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function hashSecret(raw: string): string {
  return bcrypt.hashSync(raw, 10);
}

export function verifySecret(raw: string, stored?: string | null): boolean {
  if (!raw || !stored) return false;
  if (stored.startsWith('$2')) {
    return bcrypt.compareSync(raw, stored);
  }
  return raw === stored;
}

export function parsePermissions(perms: unknown): string[] {
  if (Array.isArray(perms)) return perms.map(String);
  if (typeof perms === 'string') {
    try {
      const parsed = JSON.parse(perms);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function sanitizeEmployee(emp: any) {
  if (!emp) return emp;
  const { password, pinCode, ...rest } = emp;
  return {
    ...rest,
    permissions: parsePermissions(emp.permissions),
    hasPin: Boolean(pinCode),
    mustChangePassword: Boolean(emp.mustChangePassword),
  };
}

// In-memory rate limiter for login attempts
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

export function loginRateLimiter(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 5 * 60 * 1000;
  const maxAttempts = 25;

  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) {
    loginAttempts.set(ip, { count: 1, resetAt: now + windowMs });
    return next();
  }

  if (entry.count >= maxAttempts) {
    return res.status(429).json({
      message: 'تم تجاوز الحد الأقصى لمحاولات تسجيل الدخول. يرجى الانتظار بضع دقائق ثم المحاولة مجدداً.',
      error: 'Too many login attempts. Please wait a few minutes before retrying.',
    });
  }

  entry.count += 1;
  next();
}

export function resetLoginRateLimit(ip: string) {
  loginAttempts.delete(ip);
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  let token = '';
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const payload = await verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }

  req.authUser = payload;
  next();
}

export function requirePermission(permission: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const user = req.authUser;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (user.role === 'admin') {
      return next();
    }
    if (user.permissions.includes(permission)) {
      return next();
    }
    return res.status(403).json({ error: `Forbidden: missing permission '${permission}'` });
  };
}

export function requireAnyPermission(permissions: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const user = req.authUser;
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (user.role === 'admin') {
      return next();
    }
    if (permissions.some((p) => user.permissions.includes(p))) {
      return next();
    }
    return res.status(403).json({ error: `Forbidden: missing any of permissions [${permissions.join(', ')}]` });
  };
}

export function requireAdminOrManager(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const user = req.authUser;
  if (!user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (user.role === 'admin' || user.role === 'manager') {
    return next();
  }
  return res.status(403).json({ error: 'Forbidden: admin or manager role required' });
}
