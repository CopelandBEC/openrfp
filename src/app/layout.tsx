import type { Metadata } from "next";
import { Montserrat } from "next/font/google";
import { DevBanner } from "@/components/dev-banner";
import "./globals.css";

const montserrat = Montserrat({
  variable: "--font-montserrat",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "OpenRFP — Intelligent RFP evaluation, free and open source",
  description:
    "Upload your RFP, get an automatically generated evaluation rubric, upload vendor responses, and receive scored evaluations with cited evidence. Free, open source, and transparent.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={montserrat.variable}>
      <body className="font-montserrat antialiased">
        <DevBanner />
        {children}
      </body>
    </html>
  );
}
