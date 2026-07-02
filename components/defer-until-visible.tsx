"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Defers mounting `children` until the wrapper scrolls near the viewport, so a
// heavy below-the-fold section (which self-fetches on mount) doesn't compete
// with the initial-paint fetches. Renders a fixed-height placeholder until then
// so the page layout / scroll position stays stable. Once shown, stays shown.
export function DeferUntilVisible({
  children,
  minHeight = 200,
  rootMargin = "400px",
}: {
  children: ReactNode;
  /** Placeholder height (px) reserved before the section mounts. */
  minHeight?: number;
  /** How far before the viewport to start mounting (IntersectionObserver). */
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible) return;
    const el = ref.current;
    if (!el) return;
    // Environments without IntersectionObserver just render immediately.
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { rootMargin },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible, rootMargin]);

  return (
    <div ref={ref} style={visible ? undefined : { minHeight }}>
      {visible ? children : null}
    </div>
  );
}
