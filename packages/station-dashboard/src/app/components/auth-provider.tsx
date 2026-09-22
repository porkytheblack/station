"use client";

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import { checkAuth, logout as apiLogout } from "../hooks/use-api";

interface AuthContextValue {
  authenticated: boolean;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  authenticated: true,
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children, loginPage }: { children: ReactNode; loginPage: ReactNode }) {
  const [state, setState] = useState<"loading" | "authenticated" | "unauthenticated">("loading");

  useEffect(() => {
    checkAuth()
      .then(({ authenticated, authRequired }) => {
        if (!authRequired || authenticated) {
          setState("authenticated");
        } else {
          setState("unauthenticated");
        }
      })
      .catch(() => {
        // If auth check fails (server down), show dashboard anyway
        setState("authenticated");
      });
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setState("unauthenticated");
  }, []);

  const onLoginSuccess = useCallback(() => {
    setState("authenticated");
  }, []);

  if (state === "loading") {
    return null;
  }

  if (state === "unauthenticated") {
    return <LoginPageWrapper onSuccess={onLoginSuccess}>{loginPage}</LoginPageWrapper>;
  }

  return (
    <AuthContext.Provider value={{ authenticated: true, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

// Internal wrapper to pass onSuccess to the login page via context
const LoginCallbackContext = createContext<() => void>(() => {});

export function useLoginCallback() {
  return useContext(LoginCallbackContext);
}

function LoginPageWrapper({ children, onSuccess }: { children: ReactNode; onSuccess: () => void }) {
  return (
    <LoginCallbackContext.Provider value={onSuccess}>
      {children}
    </LoginCallbackContext.Provider>
  );
}
