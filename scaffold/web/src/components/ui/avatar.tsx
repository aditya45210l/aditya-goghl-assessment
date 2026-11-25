import * as React from 'react';
import { cn } from '@/lib/utils';

// Stable colour per person: the same name always gets the same hue.
function hueOf(text: string) {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

// Gradient SVG avatar. Phone numbers show their last two digits; names show initials.
function Avatar({ className, label, ...props }: React.ComponentProps<'span'> & { label: string }) {
  const isPhone = /^[\d+\s-]+$/.test(label);
  const text = isPhone
    ? label.replace(/\D/g, '').slice(-2)
    : label.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '#';
  const hue = hueOf(label);
  const id = 'av' + hue + text;
  return (
    <span data-slot="avatar" className={cn('relative inline-flex size-9 shrink-0 select-none', className)} {...props}>
      <svg viewBox="0 0 40 40" className="size-full" aria-hidden="true">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={`hsl(${hue} 80% 62%)`} />
            <stop offset="100%" stopColor={`hsl(${(hue + 40) % 360} 75% 48%)`} />
          </linearGradient>
        </defs>
        <circle cx="20" cy="20" r="20" fill={`url(#${id})`} />
        <circle cx="20" cy="20" r="19.5" fill="none" stroke="white" strokeOpacity="0.25" />
        <text x="20" y="20" dy="0.35em" textAnchor="middle" fontSize="14" fontWeight="600" fill="white" fontFamily="Inter, system-ui, sans-serif">
          {text}
        </text>
      </svg>
    </span>
  );
}

export { Avatar };
