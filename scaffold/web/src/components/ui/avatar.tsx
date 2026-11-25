import * as React from 'react';
import { cn } from '@/lib/utils';

// Initials avatar (shadcn Avatar look, without image loading).
function Avatar({ className, label, ...props }: React.ComponentProps<'span'> & { label: string }) {
  // phone numbers show their last two digits; names show their initials
  const digits = label.replace(/\D/g, '');
  const initials = /^[\d+\s-]+$/.test(label)
    ? digits.slice(-2)
    : label.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '#';
  return (
    <span data-slot="avatar" className={cn('bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-medium', className)} {...props}>
      {initials}
    </span>
  );
}

export { Avatar };
