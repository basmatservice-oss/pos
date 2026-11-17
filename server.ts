import { runMigrations } from './migrate.js';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { eq } from 'drizzle-orm';
import { db, closeDatabaseConnection } from './drizzle/db.js';
import { settings } from './drizzle/schema.js';
import { startSyncEngine, stopSyncEngine } from './syncEngine.js';
import { createPosApp, seedDefaultUsersAndAccounts, createSafeBackup } from './server/app.js';
import { runLegacyDataBackfill } from './server/backfill.js';

let backupIntervalHandle: NodeJS.Timeout | null = null;
let isShuttingDown = false;

function stopAutoBackup() {
  if (backupIntervalHandle) {
    clearInterval(backupIntervalHandle);
    backupIntervalHandle = null;
  }
}

function startAutoBackup() {
  if (backupIntervalHandle) return;

  const checkAndBackup = async () => {
    try {
      const autoBackupSetting = await db.select().from(settings).where(eq(settings.key, 'autoBackup'));
      if (autoBackupSetting.length === 0 || autoBackupSetting[0].value !== 'true') return;

      const intervalValueSetting = await db
        .select()
        .from(settings)
        .where(eq(settings.key, 'autoBackupIntervalValue'));
      const intervalValue = intervalValueSetting.length > 0 ? parseInt(intervalValueSetting[0].value) || 1 : 1;

      const intervalUnitSetting = await db
        .select()
        .from(settings)
        .where(eq(settings.key, 'autoBackupIntervalUnit'));
      const intervalUnit = intervalUnitSetting.length > 0 ? intervalUnitSetting[0].value : 'days';

      let intervalHours = 24;
      if (intervalUnit === 'hours') intervalHours = intervalValue;
      else if (intervalUnit === 'days') intervalHours = intervalValue * 24;
      else if (intervalUnit === 'weeks') intervalHours = intervalValue * 168;

      const lastBackupSetting = await db.select().from(settings).where(eq(settings.key, 'lastAutoBackup'));
      const lastBackupTime = lastBackupSetting.length > 0 ? new Date(lastBackupSetting[0].value).getTime() : 0;
      const hoursSinceLastBackup = (Date.now() - lastBackupTime) / (1000 * 60 * 60);

      if (hoursSinceLastBackup >= intervalHours || lastBackupTime === 0) {
        const { path: backupPath } = await createSafeBackup();
        console.log(`WAL-safe auto backup created at: ${backupPath}`);

        const now = new Date().toISOString();
        await db
          .insert(settings)
          .values({ key: 'lastAutoBackup', value: now, isSynced: 0, createdAt: now, updatedAt: now })
          .onConflictDoUpdate({
            target: settings.key,
            set: { value: now, updatedAt: now },
          });
      }
    } catch (error) {
      console.error('Auto backup failed:', error);
    }
  };

  checkAndBackup();
  backupIntervalHandle = setInterval(checkAndBackup, 1000 * 60 * 60);
}

async function startServer() {
  // 1. Open database, verify integrity, apply migrations & schema upgrades BEFORE listening
  console.log('[Startup 1/5] Running database integrity check and migrations...');
  await runMigrations();

  // 2. Seed chart of accounts, default admins, and backfill legacy data safely
  console.log('[Startup 2/5] Seeding accounts, initial credentials, and legacy backfill...');
  await seedDefaultUsersAndAccounts();
  const backfillRes = runLegacyDataBackfill(db);
  if (!backfillRes.alreadyCompleted) {
    console.log(
      `[Legacy Backfill] Created ${backfillRes.batchesCreated} batches, openingEntryId=${backfillRes.openingEntryId}`
    );
  }

  // 3. Build Express app & Socket.io
  console.log('[Startup 3/5] Configuring Express server and Socket.io...');
  const { app, httpServer, io } = createPosApp();

  // 4. Attach Vite middleware (dev) or static dist (prod)
  console.log('[Startup 4/5] Attaching frontend server...');
  let viteInstance: any = null;
  if (process.env.NODE_ENV !== 'production') {
    const disableHmr = process.env.DISABLE_HMR === 'true';
    viteInstance = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: disableHmr ? false : { server: httpServer, path: '/vite-hmr' },
      },
      appType: 'spa',
    });

    if (disableHmr) {
      app.get('/@vite/client', async (_req, res, next) => {
        try {
          const transformed = await viteInstance.transformRequest('/@vite/client');
          if (transformed?.code) {
            const safeCode = transformed.code.replace(
              'transport.connect(createHMRHandler(handleMessage));',
              '/* HMR disabled in preview environment */'
            );
            res.type('application/javascript').send(safeCode);
            return;
          }
        } catch {
          // Fall through to Vite middleware if transform fails
        }
        next();
      });
    }

    app.use(viteInstance.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // 5. Start background services and ONLY THEN start listening on 0.0.0.0:3000
  startSyncEngine();
  startAutoBackup();

  const PORT = Number(process.env.PORT) || 3000;
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Startup 5/5] POS Central Server ready on http://0.0.0.0:${PORT}`);
  });

  const gracefulShutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Shutdown] Received ${signal}, flushing WAL and closing services...`);

    const forceTimer = setTimeout(() => {
      console.warn('[Shutdown] Forced exit after timeout');
      closeDatabaseConnection();
      process.exit(0);
    }, 5000);

    try {
      stopAutoBackup();
      stopSyncEngine();
      if (viteInstance && typeof viteInstance.close === 'function') {
        await viteInstance.close().catch(() => {});
      }
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      closeDatabaseConnection();
      clearTimeout(forceTimer);
      console.log('[Shutdown] Cleanly closed SQLite & HTTP server.');
      process.exit(0);
    } catch (err) {
      console.error('[Shutdown] Error during shutdown:', err);
      closeDatabaseConnection();
      clearTimeout(forceTimer);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('Fatal server startup failure:', err);
  closeDatabaseConnection();
  process.exit(1);
});
