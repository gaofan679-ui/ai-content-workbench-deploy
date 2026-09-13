import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import "./light-theme.css";
import "./workspace-visual.css";

const geist = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "一人内容团队｜AI 内容工作台",
  description: "一个人，也能跑起自己的内容团队。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className={geist.variable}>{children}</body></html>;
}
