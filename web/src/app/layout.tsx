import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { NotDeployedBanner } from "@/components/NotDeployedBanner";

export const metadata: Metadata = {
  title: "AfterHours · Weekend gap protection for Stock Tokens",
  description:
    "Fully collateralized, cash-settled downside protection on Robinhood Chain Stock Tokens, priced onchain by a Stylus engine.",
};

export const viewport: Viewport = {
  themeColor: "#0a0b0f",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen flex flex-col">
        <Providers>
          <Nav />
          <NotDeployedBanner />
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
