import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Rewrite barrel imports from these libs to direct deep imports so each
    // route's client chunk only pulls the icons/functions it actually uses,
    // instead of the whole package. lucide-react (imported in ~100 files),
    // date-fns, recharts, and the unified radix-ui barrel are the ones that
    // benefit here. Next auto-optimizes some of these, but listing them is
    // explicit and harmless.
    optimizePackageImports: ["lucide-react", "date-fns", "recharts", "radix-ui"],
  },
};

export default nextConfig;
