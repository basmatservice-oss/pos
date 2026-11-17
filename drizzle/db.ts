import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import * as schema from './schema';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Determine the best path for the database
export const getDbPath = () => {
  if (process.env.POS_DB_PATH) {
    const dir = path.dirname(process.env.POS_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return process.env.POS_DB_PATH;
  }

  // In AI Studio or Linux, always use the project root for simplicity
  if (process.platform !== 'win32') {
    return path.join(process.cwd(), 'dev.db');
  }

  if (process.env.NODE_ENV === 'production') {
    // In production (.exe) on Windows, use the user's AppData directory to ensure write permissions
    const appDataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Smart POS Studio');
    if (!fs.existsSync(appDataDir)) {
      fs.mkdirSync(appDataDir, { recursive: true });
    }
    return path.join(appDataDir, 'dev.db');
  }
  // In development, use the project root
  return path.join(process.cwd(), 'dev.db');
};

function openSqliteConnection(): Database.Database {
  const instance = new Database(getDbPath());
  instance.pragma('journal_mode = WAL');
  instance.pragma('synchronous = NORMAL');
  instance.pragma('busy_timeout = 5000');
  return instance;
}

export let sqliteInstance = openSqliteConnection();
export let db = drizzle(sqliteInstance, { schema });

export function closeDatabaseConnection() {
  try {
    if (sqliteInstance && sqliteInstance.open) {
      sqliteInstance.pragma('wal_checkpoint(TRUNCATE)');
      sqliteInstance.close();
    }
  } catch (err) {
    console.warn('Failed during SQLite close:', err);
  }
}

export function reopenDatabaseConnection() {
  closeDatabaseConnection();
  sqliteInstance = openSqliteConnection();
  db = drizzle(sqliteInstance, { schema });
  return { sqliteInstance, db };
}
