const unavailable = () => {
  throw new Error('Legacy IndexedDB compatibility storage is disabled in native SQLite builds. Use the native SQLite repository.');
};

const unavailableProxy = new Proxy(unavailable, {
  get() {
    return unavailableProxy;
  },
  apply() {
    return unavailable();
  },
});

export const db: any = new Proxy({}, {
  get() {
    return unavailableProxy;
  },
});

export async function ensureDatabaseReady(): Promise<void> {
  return unavailable();
}
