import Link from 'next/link';

export function Brand() {
  return (
    <Link href="/" className="brand" style={{ color: 'inherit', textDecoration: 'none' }}>
      <span className="brand-mark" aria-hidden="true">▦</span>
      <span>Family Calendar</span>
    </Link>
  );
}
