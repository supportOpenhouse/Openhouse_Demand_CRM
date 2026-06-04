import { useEffect, useState } from 'react';

export default function Toast() {
  const [t, setT] = useState(null);
  useEffect(() => {
    let timer;
    const on = (e) => { setT(e.detail); clearTimeout(timer); timer = setTimeout(() => setT(null), 2600); };
    window.addEventListener('rx-toast', on);
    return () => { window.removeEventListener('rx-toast', on); clearTimeout(timer); };
  }, []);
  if (!t) return null;
  return <div className={'rx-toast ' + (t.kind || '')}>{t.msg}</div>;
}
