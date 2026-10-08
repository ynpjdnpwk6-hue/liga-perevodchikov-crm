import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Лига переводчиков · Волгоград",
  description: "Подбор переводчиков и лингвистическое сопровождение следственных действий.",
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
