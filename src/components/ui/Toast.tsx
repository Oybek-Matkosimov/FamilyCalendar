'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface ToastItem { id: number; message: string; error: boolean }
interface ToastApi { show(message: string, opts?: { error?: boolean }): void }

const Ctx = createContext<ToastApi>({ show: () => {} });
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const show = useCallback((message: string, opts?: { error?: boolean }) => {
    const id = nextId.current++;
    setItems((cur) => [...cur.slice(-2), { id, message, error: !!opts?.error }]);
    setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), opts?.error ? 7000 : 3500);
  }, []);
  const api = useMemo(() => ({ show }), [show]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' is-error' : ''}`}>{t.message}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
