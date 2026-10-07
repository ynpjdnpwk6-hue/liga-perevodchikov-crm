import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Лига переводчиков — CRM",
  description: "Закрытое рабочее пространство Лиги переводчиков.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
