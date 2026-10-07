import { Suspense } from 'react';
import Link from 'next/link';
import { Brand } from '@/components/Brand';
import { JoinCalendarForm } from '@/components/JoinCalendarForm';

export const metadata = { title: 'Join a family calendar' };

export default function JoinPage() {
  return (
    <main className="shell">
      <div className="shell-inner" style={{ justifyItems: 'center' }}>
        <div style={{ width: 'min(520px, 100%)', display: 'grid', gap: '1.2rem' }}>
          <Brand />
          <Link href="/" className="back">Back</Link>
        </div>
        <Suspense fallback={<p>Loading…</p>}>
          <JoinCalendarForm />
        </Suspense>
      </div>
    </main>
  );
}
