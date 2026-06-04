import { useEffect, useState } from 'react';

// Mirrors the legacy detectMobile() (<=900px) → render mobile card layouts.
export default function useIsMobile(bp = 900) {
  const [m, setM] = useState(typeof window !== 'undefined' && window.innerWidth <= bp);
  useEffect(() => {
    const on = () => setM(window.innerWidth <= bp);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [bp]);
  return m;
}
