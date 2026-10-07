'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/client/api';
import { Brand } from '@/components/Brand';

export default function Landing() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/auth/me').then(
      () => { if (!cancelled) router.replace('/calendar'); },
      () => { if (!cancelled) setChecking(false); },
    );
    return () => { cancelled = true; };
  }, [router]);

  return (
    <main className="shell">
      <div className="shell-inner">
        <Brand />
        {checking ? (
          <p aria-live="polite" style={{ color: 'var(--ink-soft)' }}>Opening your calendar…</p>
        ) : (
          <section className="hero">
            <div>
              <h1>Everyone’s week, in one place.</h1>
              <p className="lede">Share one calendar with your family. See who is doing what today, and catch clashes before they happen.</p>
              <div className="hero-actions">
                <Link href="/create" className="btn btn-primary btn-big">Create Family Calendar</Link>
                <Link href="/join" className="btn btn-big">Join Family Calendar</Link>
              </div>
            </div>
            <aside className="sample" aria-label="Example of a shared day">
              <h2>Saturday <span>Example</span></h2>
              <div className="sample-row">
                <span className="member-dot" style={{ background: '#2563eb' }}>D</span>
                <div><b>Work</b><small>Dad · 10:00 AM – 12:00 PM</small></div>
              </div>
              <div className="sample-row">
                <span className="member-dot" style={{ background: '#db2777' }}>M</span>
                <div><b>University</b><small>Mom · 11:30 AM – 1:00 PM</small></div>
              </div>
              <div className="sample-flag"><span aria-hidden="true">⚠</span> Dad and Mom overlap from 11:30 AM to 12:00 PM</div>
            </aside>
          </section>
        )}
      </div>
    </main>
  );
}
