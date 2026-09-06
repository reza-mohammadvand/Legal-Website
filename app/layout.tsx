import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "دادراه | مشاوره حقوقی مطمئن",
  description: "مسیر ساده و امن برای پرسش حقوقی، انتخاب وکیل و رزرو مشاوره",
  applicationName: "دادراه",
  icons: { icon: "/favicon.svg" },
  metadataBase: new URL("http://localhost:3010"),
  openGraph: { title: "دادراه", description: "راه روشن برای مسئله حقوقی شما", images: ["/og.png"] },
  twitter: { card: "summary_large_image", title: "دادراه", description: "راه روشن برای مسئله حقوقی شما", images: ["/og.png"] },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl">
      <body>{children}</body>
    </html>
  );
}
