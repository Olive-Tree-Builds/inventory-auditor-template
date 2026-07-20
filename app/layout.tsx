import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Inventory Auditor",
    template: "%s · Inventory Auditor",
  },
  description:
    "Turn historical sales into clear, location-specific production recommendations.",
  icons: {
    icon: "/brand-logo-icon.svg",
    shortcut: "/brand-logo-icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
