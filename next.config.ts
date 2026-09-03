import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse loads pdfjs, which resolves its worker script relative to its
  // own module path at runtime. Bundling it moves the code and leaves that
  // path pointing at a file that was never copied ("Setting up fake worker
  // failed"), so every upload came back as "may need OCR". Loading it through
  // Node's own require keeps the package layout intact.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],

  // Keeping the package external is not enough on Vercel, where a function
  // ships only the files the build could trace. pdfjs loads its worker by a
  // computed path, so pdf.worker.mjs was never traced and the deployed
  // function failed with "Setting up fake worker failed" while the same code
  // worked locally against a full node_modules. Force the files in.
  outputFileTracingIncludes: {
    "/api/upload-rfp": [
      "./node_modules/pdfjs-dist/legacy/build/**",
      "./node_modules/pdf-parse/dist/**",
    ],
    "/api/upload-response": [
      "./node_modules/pdfjs-dist/legacy/build/**",
      "./node_modules/pdf-parse/dist/**",
    ],
  },
};

export default nextConfig;
