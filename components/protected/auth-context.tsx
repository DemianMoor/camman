"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

import {
  can as canPermission,
  isRole,
  type Permission,
  type Role,
} from "@/lib/permissions";

export type AuthMe = {
  user: { id: string; email: string | null };
  org: { id: string; name: string; role: Role };
};

export type AuthContextValue = {
  auth: AuthMe | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
  can: (permission: Permission) => boolean;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthMe | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/me", { cache: "no-store" });
      if (!r.ok) throw new Error(`/api/me returned ${r.status}`);
      const json = (await r.json()) as AuthMe;
      if (!isRole(json.org.role)) {
        throw new Error(`Invalid role from /api/me: ${json.org.role}`);
      }
      setAuth(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const value: AuthContextValue = {
    auth,
    isLoading,
    error,
    refetch: load,
    can: (permission: Permission) =>
      auth ? canPermission(auth.org.role, permission) : false,
  };

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return ctx;
}
