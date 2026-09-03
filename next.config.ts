import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse loads pdfjs, which resolves its worker script relative to its
  // own module path at runtime. Bundling it moves the code and leaves that
  // path pointing at a file that was never copied ("Setting up fake worker
  // failed"), so every upload came back as "may need OCR". Loading it through
  // Node's own require keeps the package layout intact.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
