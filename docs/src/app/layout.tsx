import type { Metadata } from "next";
import { Nav } from "./components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Signal — Background jobs for TypeScript",
  description:
    "Type-safe background job framework. Signals, broadcasts, adapters. Fire and forget.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('theme');if(!t){t=window.matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}document.documentElement.setAttribute('data-theme',t)})()`,
          }}
        />
      </head>
      <body>
        <Nav />
        {children}
      </body>
    </html>
  );
}
