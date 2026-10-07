import Link from 'next/link';
import { Brand } from '@/components/Brand';
import { CreateCalendarForm } from '@/components/CreateCalendarForm';

export const metadata = { title: 'Create a family calendar' };

export default function CreatePage() {
  return (
    <main className="shell">
      <div className="shell-inner" style={{ justifyItems: 'center' }}>
        <div style={{ width: 'min(520px, 100%)', display: 'grid', gap: '1.2rem' }}>
          <Brand />
          <Link href="/" className="back">Back</Link>
        </div>
        <CreateCalendarForm />
      </div>
    </main>
  );
}
