import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { TITLE_DEFAULT, TITLE_TEMPLATE } from "@/lib/page-title";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// `template` applies to every descendant segment that sets its own title;
// `default` is the fallback for any route that doesn't. Client pages can't
// export metadata, so those segments carry a sibling layout.tsx that does, and
// a segment with titled descendants must re-declare the template via
// sectionTitle() — see docs/07-conventions.md.
export const metadata: Metadata = {
  title: {
    template: TITLE_TEMPLATE,
    default: TITLE_DEFAULT,
  },
  description: "Internal CRM for SMS affiliate marketing campaigns.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        <Toaster richColors position="top-right" />
      </body>
    </html>
  );
}
