import { useEffect, useState } from 'react';

// Light / dark / follow-the-system, remembered per browser (same behaviour as the playground).
export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'sb-theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* storage may be blocked */
  }
  return 'system';
}

const resolve = (p: ThemePref) => (p === 'system' ? (media.matches ? 'dark' : 'light') : p);
const apply = (mode: 'light' | 'dark') => document.documentElement.classList.toggle('dark', mode === 'dark');

apply(resolve(readPref())); // before the first render, so there is no flash

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref);
  const mode = resolve(pref);

  useEffect(() => {
    apply(mode);
    if (pref !== 'system') return;
    const onChange = () => apply(resolve('system'));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [pref, mode]);

  const toggle = () => {
    const next = mode === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
    setPref(next);
  };
  return { mode, toggle };
}
