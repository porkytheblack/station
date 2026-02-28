import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "./components/shell";
import { ThemeProvider } from "./components/theme-provider";
import { StationProvider } from "./hooks/use-station";
import { BreadcrumbProvider } from "./components/breadcrumb-provider";

export const metadata: Metadata = {
  title: "Station",
  description: "Dashboard for simple-signal",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("station-theme");if(t==="dark"||t==="light"){document.documentElement.setAttribute("data-theme",t)}else if(window.matchMedia("(prefers-color-scheme:dark)").matches){document.documentElement.setAttribute("data-theme","dark")}else{document.documentElement.setAttribute("data-theme","light")}}catch(e){document.documentElement.setAttribute("data-theme","light")}})()`,
          }}
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@300;400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <ThemeProvider>
          <StationProvider>
            <BreadcrumbProvider>
              <Shell>{children}</Shell>
            </BreadcrumbProvider>
          </StationProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
