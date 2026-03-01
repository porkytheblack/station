import type { Metadata, Viewport } from "next";
import { Nav } from "./components/Nav";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: {
    default: "Station — Background jobs for TypeScript",
    template: "%s — Station",
  },
  description:
    "Type-safe background jobs, recurring tasks, and DAG workflows for TypeScript. Define signals with Zod schemas, run them in isolated processes with retries and timeouts.",
  metadataBase: new URL("https://station.dterminal.net"),
  openGraph: {
    title: "Station — Background jobs for TypeScript",
    description:
      "Type-safe background jobs, recurring tasks, and DAG workflows for TypeScript.",
    siteName: "Station",
    images: [{ url: "/og-data.png" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Station — Background jobs for TypeScript",
    description:
      "Type-safe background jobs, recurring tasks, and DAG workflows for TypeScript.",
    images: ["/og-data.png"],
  },
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
