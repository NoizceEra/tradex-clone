import { useState, useCallback } from 'react';

/** Copy-to-clipboard with a transient "copied" confirmation (shared by the referral + wallet panels). */
export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(
    async (text) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), resetMs);
      } catch {
        /* clipboard blocked */
      }
    },
    [resetMs],
  );
  return { copied, copy };
}
