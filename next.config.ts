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
  // computed path, so pdf.worker.mjs was never traced. It also requires
  // @napi-rs/canvas through createRequire — equally invisible to the tracer —
  // to polyfill DOMMatrix, and then constructs a DOMMatrix at module scope, so
  // without that package the library fails to load at all ("ReferenceError:
  // DOMMatrix is not defined" in production, while the same code worked
  // locally against a full node_modules). Force all of it in. The @napi-rs
  // glob picks up whichever platform binary npm installed on the build host.
  outputFileTracingIncludes: {
    "/api/upload-rfp": [
      "./node_modules/pdfjs-dist/legacy/build/**",
      "./node_modules/pdf-parse/dist/**",
      "./node_modules/@napi-rs/**",
    ],
    "/api/upload-response": [
      "./node_modules/pdfjs-dist/legacy/build/**",
      "./node_modules/pdf-parse/dist/**",
      "./node_modules/@napi-rs/**",
    ],
  },
};

export default nextConfig;
